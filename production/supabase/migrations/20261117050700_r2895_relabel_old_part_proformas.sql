-- deploy-peek: to_regclass('public.r2895_repair_log') is not null and to_regprocedure('public.r2895_repair(boolean,integer,boolean)') is not null and to_regprocedure('public.r2895_undo(uuid)') is not null and to_regprocedure('public.r2895_plan(boolean)') is not null
-- deploy-key: r2895relabeloldpartproformas
-- 20261117050700_r2895_relabel_old_part_proformas.sql
--
-- R-2895 (17 Nov 2026) — the TOOLS for one owner-delegated data repair (Pardeep 17 Nov: "jo tumhe thik
-- lage wo karo" + coordinator recommendation). THIS MIGRATION CHANGES NO DATA. The repair is run by
-- scripts/ops/r2895-relabel-repair.sql (dry run by default; apply needs -v apply=1 AND -v expect=<count the
-- owner saw in the report>) — on staging / live by the manager or Pardeep only (repo rule R-2539 / R-2570).
-- The read-only report: scripts/ops/r2895-relabel-report.sql.
--
-- WHY. R-2865 made NEW part proformas say "Payment for month 1 · 1 Nov–30 Nov 2026". Proformas issued
-- before it keep the stored "Advance payment for month 1 · …" (a renewal part is payment for a service
-- period, not an advance). An OPEN request still goes to the customer with the wrong word.
--
-- WHAT IT CHANGES (only these, only on a part proforma still waiting for money):
--   * quotes.line_items[*].name and .description that read "Advance payment for <label> …", where <label>
--     is the label's own shape — month N / part N / Qn / Hn (the shape R-2865's PART_SHORT_LABEL reads;
--     "Advance payment for services" or a product named so is NOT a label and is left) → "Payment for <label> …".
--     (The oldest requests carry the label in the line NAME, newer ones in the description — R-2423.)
--   * quotes.notes when it STARTS with that same label (the system sentence "<label>. Due on …").
--     Pass p_notes => false in r2895_repair to leave notes alone (run-sheet variable `notes`).
--   NOTHING else on the row: no amount / subtotal / tax / seats / dates / periods / ids / links / numbers /
--   status; every other key of every line is kept exactly (jsonb_set on the two text keys). updated_at is kept.
--
-- WHICH ROWS ("will change" = verdict 'change' in r2895_plan()): a part request (subscription_billing_id set)
--   that is NOT cancelled (cancelled_at, cancelled_part_billing_id empty), NOT invoiced (no invoice_id,
--   payment_status not 'invoiced', its billing part has no invoice), NOT paid or part-paid (payment_status
--   none / awaiting only, no received payment row), NOT closed (status sent / viewed / accepted — draft,
--   rejected, expired are left). Every other verdict is reported and never touched: cancelled, invoiced,
--   paid, closed, label_shape_unrecognised, not_a_part_request.
--
-- SAFETY (same pattern as R-2768): idempotent (a second run finds nothing); every UPDATE keyed on id +
--   tenant_id and guarded on the EXACT old value AND on still unpaid / not invoiced / not cancelled at that
--   moment; every change logged in public.r2895_repair_log (before / after lines + notes, run_id, who, when);
--   public.r2895_undo(run_id) puts the old text back (only where the row still holds exactly what the repair
--   wrote); r2895_repair(p_apply, p_expect): when p_expect is given and the number of rows that would change
--   differs (a row became paid / invoiced since the report) it raises and changes nothing — re-read the report.
--   No function here has a grant: owner / migration login only (like R-2768).
--   updated_at: a BEFORE UPDATE trigger gated on the transaction-local setting app.r2895_repair = 'on' (set only
--   around the repair's own UPDATE) keeps the old updated_at. To drop with R-2769's hooks once live is repaired.
-- Test: supabase/tests/r2895_relabel.test.sql (one transaction, rolled back).

begin;

-- ── 0. the log (undo source) ─────────────────────────────────────────────────
create table if not exists public.r2895_repair_log (
  id           bigint generated always as identity primary key,
  run_id       uuid not null,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  quote_id     text not null,
  before_lines jsonb,
  after_lines  jsonb,
  before_notes text,
  after_notes  text,
  applied_by   text not null default (session_user::text || ' / ' || current_user::text),
  applied_at   timestamptz not null default now(),
  undone_at    timestamptz
);
create index if not exists r2895_repair_log_quote_idx on public.r2895_repair_log (quote_id);
create index if not exists r2895_repair_log_run_idx on public.r2895_repair_log (run_id);
alter table public.r2895_repair_log enable row level security;
drop policy if exists r2895_repair_log_read on public.r2895_repair_log;
create policy r2895_repair_log_read on public.r2895_repair_log for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'accountant'));
drop policy if exists zzz_service_role_all on public.r2895_repair_log;
create policy zzz_service_role_all on public.r2895_repair_log as permissive for all to service_role using (true) with check (true);
revoke all on public.r2895_repair_log from anon;
revoke insert, update, delete on public.r2895_repair_log from authenticated;
grant select on public.r2895_repair_log to authenticated;
comment on table public.r2895_repair_log is
  'R-2895: before/after of every part proforma whose "Advance payment for …" line text (and notes lead) the owner-approved repair relabelled to "Payment for …". r2895_undo(run_id) restores.';

-- ── 1. text helpers ───────────────────────────────────────────────────────────
-- "Advance payment for month 1 · 1 Nov–30 Nov 2026" → "Payment for month 1 · 1 Nov–30 Nov 2026".
-- Only the label's own shape (month N / part N / Qn / Hn) — anything else comes back unchanged.
create or replace function public.r2895_relabel(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_text ~ '^Advance payment for ((month|part) [0-9]+|[QH][0-9]+)( · |$)'
              then 'Payment for ' || substr(p_text, length('Advance payment for ') + 1)
              else p_text end
$$;


-- Every line object with name and description relabelled; every other key and every other line kept exactly.
create or replace function public.r2895_lines_relabel(p_lines jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p_lines) is distinct from 'array' then p_lines
    else coalesce((
      select jsonb_agg(b.l2 order by e.i)
        from jsonb_array_elements(p_lines) with ordinality as e(l, i)
        cross join lateral (select case when jsonb_typeof(e.l -> 'name') = 'string'
                                        then jsonb_set(e.l, '{name}', to_jsonb(public.r2895_relabel(e.l ->> 'name')))
                                        else e.l end as l1) a
        cross join lateral (select case when jsonb_typeof(a.l1 -> 'description') = 'string'
                                        then jsonb_set(a.l1, '{description}', to_jsonb(public.r2895_relabel(a.l1 ->> 'description')))
                                        else a.l1 end as l2) b
    ), '[]'::jsonb) end
$$;

-- ── 2. updated_at stays as it was on a repaired row ─────────────────────────────
create or replace function public.tg_r2895_keep_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := old.updated_at;
  return new;
end;
$$;
revoke all on function public.tg_r2895_keep_updated_at() from public, anon, authenticated;
drop trigger if exists trg_quotes_zz_r2895_keep_updated_at on public.quotes;
create trigger trg_quotes_zz_r2895_keep_updated_at before update on public.quotes
  for each row when (current_setting('app.r2895_repair', true) = 'on')
  execute function public.tg_r2895_keep_updated_at();

-- ── 3. the plan: every part proforma that carries the old wording, with its verdict ──────────────
--   verdict (first that applies):
--     not_a_part_request        — carries "Advance payment for" but is no part request (never touched)
--     cancelled                 — cancelled proforma
--     invoiced                  — has its tax invoice (quote, status, or its billing part)
--     paid                      — part-paid / paid (payment_status partial / received, or a received payment row)
--     closed                    — draft / rejected / expired
--     label_shape_unrecognised  — says "Advance payment for …" but not in the label's own shape (left; read it)
--     change                    — unpaid, not invoiced, not cancelled, open: line text (and notes lead) will change
create or replace function public.r2895_plan(p_notes boolean default true)
returns table (
  tenant_id uuid, tenant_name text, quote_id text, customer_name text, status text, payment_status text,
  invoiced boolean, cancelled boolean, verdict text,
  old_text text, new_text text, before_lines jsonb, after_lines jsonb, before_notes text, after_notes text
)
language sql
stable
set search_path = ''
as $$
  with c as (
    select q.id, q.tenant_id, q.customer_name, q.status::text as status, q.payment_status::text as payment_status,
           q.line_items as before_lines, public.r2895_lines_relabel(q.line_items) as after_lines,
           q.notes as before_notes,
           case when p_notes then public.r2895_relabel(q.notes) else q.notes end as after_notes,
           (q.subscription_billing_id is not null or q.cancelled_part_billing_id is not null) as is_part,
           (q.cancelled_at is not null or q.cancelled_part_billing_id is not null) as cancelled,
           (q.invoice_id is not null or q.payment_status::text = 'invoiced'
            or exists (select 1 from public.subscription_billings b where b.id = q.subscription_billing_id and b.invoice_id is not null)) as invoiced,
           (q.payment_status::text in ('partial', 'received')
            or exists (select 1 from public.payments p where p.quote_id = q.id and p.status::text = 'received' and p.amount > 0)) as paid
      from public.quotes q
     where q.line_items::text like '%Advance payment for%' or q.notes like 'Advance payment for%'
  )
  select c.tenant_id, t.name, c.id, c.customer_name, c.status, c.payment_status, c.invoiced, c.cancelled,
         case
           when not c.is_part then 'not_a_part_request'
           when c.cancelled then 'cancelled'
           when c.invoiced then 'invoiced'
           when c.paid then 'paid'
           when c.status not in ('sent', 'viewed', 'accepted') or c.payment_status not in ('none', 'awaiting') then 'closed'
           when c.after_lines is not distinct from c.before_lines and c.after_notes is not distinct from c.before_notes then 'label_shape_unrecognised'
           else 'change'
         end,
         coalesce((select case when (l ->> 'name') like 'Advance payment for%' then l ->> 'name' else l ->> 'description' end
                     from jsonb_array_elements(case when jsonb_typeof(c.before_lines) = 'array' then c.before_lines else '[]'::jsonb end) with ordinality e(l, i)
                    where (l ->> 'name') like 'Advance payment for%' or (l ->> 'description') like 'Advance payment for%'
                    order by i limit 1), left(c.before_notes, 80)),
         coalesce((select case when (l ->> 'name') like 'Payment for%' then l ->> 'name' else l ->> 'description' end
                     from jsonb_array_elements(case when jsonb_typeof(c.after_lines) = 'array' then c.after_lines else '[]'::jsonb end) with ordinality e(l, i)
                    where (l ->> 'name') like 'Payment for%' or (l ->> 'description') like 'Payment for%'
                    order by i limit 1), left(c.after_notes, 80)),
         c.before_lines, c.after_lines, c.before_notes, c.after_notes
    from c join public.tenants t on t.id = c.tenant_id
$$;

-- ── 4. apply / dry run ───────────────────────────────────────────────────────
create or replace function public.r2895_repair(p_apply boolean default false, p_expect integer default null, p_notes boolean default true)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_run    uuid := gen_random_uuid();
  v_counts jsonb;
  v_sample jsonb;
  v_n_plan int;
  v_done   int := 0;
  v_n      int;
  r        record;
begin
  create temp table if not exists r2895_plan_t on commit drop as select * from public.r2895_plan(true) limit 0;
  truncate r2895_plan_t;
  insert into r2895_plan_t select * from public.r2895_plan(p_notes);

  select coalesce(jsonb_object_agg(verdict, n), '{}'::jsonb) into v_counts
    from (select verdict, count(*) as n from r2895_plan_t group by verdict) c;
  select count(*) into v_n_plan from r2895_plan_t where verdict = 'change';
  select coalesce(jsonb_agg(jsonb_build_object('quote', p.quote_id, 'old', p.old_text, 'new', p.new_text) order by p.quote_id), '[]'::jsonb) into v_sample
    from (select * from r2895_plan_t where verdict = 'change' order by quote_id limit 5) p;

  if p_apply then
    if p_expect is not null and p_expect <> v_n_plan then
      raise exception 'R-2895: the report said % proforma(s) would change, now % would (one became paid / invoiced / cancelled since). Nothing changed — read the report again.', p_expect, v_n_plan;
    end if;
    for r in select * from r2895_plan_t where verdict = 'change' order by tenant_id, quote_id loop
      perform set_config('app.r2895_repair', 'on', true);
      update public.quotes q set line_items = r.after_lines, notes = r.after_notes
       where q.id = r.quote_id and q.tenant_id = r.tenant_id
         and q.line_items is not distinct from r.before_lines and q.notes is not distinct from r.before_notes
         and q.cancelled_at is null and q.cancelled_part_billing_id is null and q.invoice_id is null
         and q.payment_status::text in ('none', 'awaiting')
         and q.status::text in ('sent', 'viewed', 'accepted')
         and not exists (select 1 from public.payments p where p.quote_id = q.id and p.status::text = 'received' and p.amount > 0)
         and not exists (select 1 from public.subscription_billings b where b.id = q.subscription_billing_id and b.invoice_id is not null);
      get diagnostics v_n = row_count;
      perform set_config('app.r2895_repair', '', true);
      if v_n = 1 then
        insert into public.r2895_repair_log (run_id, tenant_id, quote_id, before_lines, after_lines, before_notes, after_notes)
          values (v_run, r.tenant_id, r.quote_id, r.before_lines, r.after_lines, r.before_notes, r.after_notes);
        v_done := v_done + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('repair', 'R-2895 relabel old part proformas', 'run_id', case when p_apply then v_run end,
                            'applied', p_apply, 'changed', v_done, 'would_change', v_n_plan, 'plan', v_counts, 'sample', v_sample);
end;
$$;

-- ── 5. undo one run ──────────────────────────────────────────────────────────
create or replace function public.r2895_undo(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r      record;
  v_n    int;
  v_done int := 0;
  v_left int := 0;
begin
  for r in select * from public.r2895_repair_log g where g.run_id = p_run_id and g.undone_at is null order by g.id desc loop
    perform set_config('app.r2895_repair', 'on', true);
    update public.quotes q set line_items = r.before_lines, notes = r.before_notes
     where q.id = r.quote_id and q.tenant_id = r.tenant_id
       and q.line_items is not distinct from r.after_lines and q.notes is not distinct from r.after_notes;
    get diagnostics v_n = row_count;
    perform set_config('app.r2895_repair', '', true);
    if v_n = 1 then
      update public.r2895_repair_log set undone_at = now() where id = r.id;
      v_done := v_done + 1;
    else
      v_left := v_left + 1;   -- changed again since the repair: left as it is
    end if;
  end loop;
  return jsonb_build_object('run_id', p_run_id, 'undone', v_done, 'changed_since_left', v_left);
end;
$$;

-- owner / migration login only — nothing here is for the app or any request login
revoke all on function public.r2895_relabel(text) from public, anon, authenticated;
revoke all on function public.r2895_lines_relabel(jsonb) from public, anon, authenticated;
revoke all on function public.r2895_plan(boolean) from public, anon, authenticated;
revoke all on function public.r2895_repair(boolean, integer, boolean) from public, anon, authenticated;
revoke all on function public.r2895_undo(uuid) from public, anon, authenticated;

commit;
