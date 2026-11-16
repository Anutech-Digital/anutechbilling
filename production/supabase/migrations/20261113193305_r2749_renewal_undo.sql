-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.unroll_unpaid_renewal_terms(uuid,text)') and prosrc like '%R-2749%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.roll_paid_renewal_terms(uuid)') and prosrc like '%R-2749%') and to_regclass('public.subscription_renewal_moves') is not null and exists(select 1 from pg_trigger where tgname = 'subscriptions_r2749_wont_renew_open_part' and tgrelid = to_regclass('public.subscriptions')) and exists(select 1 from pg_trigger where tgname = 'subscriptions_r2749_reactivated_renews' and tgrelid = to_regclass('public.subscriptions')) and exists(select 1 from pg_trigger where tgname = 'invoices_r2749_unpaid_part_unrenews' and tgrelid = to_regclass('public.invoices')) and exists(select 1 from pg_trigger where tgname = 'subscription_billings_r2749_part_released_unrenews' and tgrelid = to_regclass('public.subscription_billings'))
-- deploy-key: r2749renewalundo
-- 20261113193305_r2749_renewal_undo.sql
--
-- R-2749 (14 Nov 2026, p1 money) — follow-ups of R-2735 ("a subscription billed in parts renews only by
-- payment"), found by its independent review.
--
-- ─── BEFORE ───────────────────────────────────────────────────────────────────────────────────────
-- 1. A renewal part that was PAID (so roll_paid_renewal_terms moved renewal_date renews_from → renews_to)
--    and was then undone — full credit note (R-2095 frees the part: invoice_id → null), bank un-reconcile /
--    take-back (invoice paid → pending / void) — left renewal_date on the new term and renewal_state
--    'renewed': renewed with no money.
-- 2. Won't renew pressed after "Bill next part": the renewals cron lapsed the subscription to expired, a
--    later payment of that proforma never renewed it, and making it active again did not run the roll.
--
-- ─── AFTER ────────────────────────────────────────────────────────────────────────────────────────
-- * public.subscription_renewal_moves — one row per automatic move of renewal_date by a renewal part:
--   'forward' (roll_paid_renewal_terms, the part was paid) or 'back' (unroll_unpaid_renewal_terms, the
--   payment was undone), with the part, its invoice and why. The R-2735 report lists them.
-- * public.unroll_unpaid_renewal_terms(sub, why) — owner decision (delegated, 13 Nov): when the paid part
--   loses its payment and renewal_date STILL equals renews_to (the last logged move ending at that date is
--   this term's 'forward'), move renewal_date back to renews_from and renewal_state to 'pending' (not
--   renewed; due/overdue again) — exactly once (guarded on renewal_date, and the 'back' row ends the chain).
--   Oldest term first, like the roll: if an older term of a cascade is undone, the newer terms rolled on top
--   go back too (they wait behind it again) and roll forward with it when it is paid. A date changed by hand
--   after the roll has no logged move → never touched. Paying again → roll_paid_renewal_terms moves it
--   forward once (its renews_from guard).
--   Called by: invoices_r2749_unpaid_part_unrenews (a marked part's invoice leaves 'paid') and
--   subscription_billings_r2749_part_released_unrenews (a marked part's invoice link is cleared / replaced —
--   the full credit note path). delete_payment already refuses once a part invoice exists.
--   HELD instead of moved (one 'held' row, listed in the report for the owner): the subscription is not active /
--   paused (a cancelled / expired sub keeps its recorded end), a quote is linked on renewal_quote_id (it prices
--   the term after the current date — moving under it would bill the wrong term), or a seat cut is scheduled
--   for the end of the current term (moving the date would move / cancel the cut, R-2613).
-- * Won't renew (auto_renew → false on an active / paused sub, every path: drawer, Cancel → At end of term,
--   portal) is REFUSED while the renewal part of the current renewal_date is billed and unpaid (live proforma, or
--   a draft / pending / overdue part invoice): "Cancel … first". Cancel subscription → Now is not held. Chosen over letting it lapse: a lapsed sub with a paid proforma is money for a term
--   that never starts.
-- * subscriptions_r2749_reactivated_renews: status back to active / paused → roll_paid_renewal_terms (a paid
--   part that waited on an expired sub — old data, or expired by hand — renews then).
-- * roll_paid_renewal_terms (R-2735 body) now logs each 'forward' move. Rows rolled before this migration
--   have no log → never moved back (R-2735 and this card go in the same train; local DB only before it).
--
-- Not changed: non-split renewals (record_payment), R-2710 multi-year, delete_payment / refund_payment.
-- Tenant guard (CLAUDE.md §17c) as R-2735 (trusted = service_role / a non-request login).
-- Test: supabase/tests/r2749_renewal_undo.test.sql (one transaction, rolled back).

begin;

-- ── 1. The move log ──────────────────────────────────────────────────────────────────────────────────
create table if not exists public.subscription_renewal_moves (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  billing_id      uuid references public.subscription_billings(id) on delete set null,
  direction       text not null,
  from_date       date not null,
  to_date         date not null,
  invoice_id      text,
  why             text,
  created_at      timestamptz not null default now()
);
alter table public.subscription_renewal_moves drop constraint if exists subscription_renewal_moves_direction_check;
alter table public.subscription_renewal_moves add constraint subscription_renewal_moves_direction_check
  check (direction in ('forward', 'back', 'held'));
comment on table public.subscription_renewal_moves is
  'R-2749: every automatic move of subscriptions.renewal_date by a renewal part — forward when the part was paid (R-2735), back when that payment was undone, held when it was undone but the date was left (not active / quote linked / seat cut scheduled). Written only by security-definer functions.';
create index if not exists subscription_renewal_moves_sub_idx
  on public.subscription_renewal_moves (subscription_id, to_date, id);
create index if not exists subscription_renewal_moves_tenant_idx
  on public.subscription_renewal_moves (tenant_id, created_at);

alter table public.subscription_renewal_moves enable row level security;
drop policy if exists subscription_renewal_moves_select on public.subscription_renewal_moves;
create policy subscription_renewal_moves_select on public.subscription_renewal_moves
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
drop policy if exists gp09_personal_wall on public.subscription_renewal_moves;
create policy gp09_personal_wall on public.subscription_renewal_moves as restrictive for select to authenticated
  using (not (select public.is_personal_session()));
drop policy if exists zzz_service_role_all on public.subscription_renewal_moves;
create policy zzz_service_role_all on public.subscription_renewal_moves as permissive for all to service_role
  using (true) with check (true);
revoke all on table public.subscription_renewal_moves from public, anon, authenticated;
grant select on table public.subscription_renewal_moves to authenticated;
grant all on table public.subscription_renewal_moves to service_role;

-- ── 2. The roll (R-2735 body) now logs each forward move ─────────────────────────────────────────────
create or replace function public.roll_paid_renewal_terms(p_subscription_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
/* R-2735: a subscription billed in parts renews only by payment. Moves renewal_date over every term whose
   marked first part (renews_from = the CURRENT renewal_date) has a PAID tax invoice, oldest first. Guarded
   on renewal_date = renews_from, so a retry / second payment moves nothing. Returns the number of terms rolled.
   R-2749: each move is logged in subscription_renewal_moves ('forward') so an undone payment can move it back. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_sub     record;
  v_b       record;
  v_rolls   integer := 0;
  v_n       integer;
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can renew it' using errcode = '28000';
  end if;
  for i in 1..24 loop
    select s.id, s.tenant_id, s.renewal_date, s.status::text as status, s.renewal_quote_id into v_sub
      from public.subscriptions s where s.id = p_subscription_id for update;
    if not found or v_sub.renewal_date is null or v_sub.status not in ('active', 'paused')
       or v_sub.renewal_quote_id is not null then
      exit;
    end if;
    if v_caller is not null and v_sub.tenant_id is distinct from v_caller then
      raise exception 'Subscription % is not in the caller''s company', p_subscription_id using errcode = '42501';
    end if;
    select b.id, b.renews_to, b.invoice_id into v_b
      from public.subscription_billings b
      join public.invoices i on i.id = b.invoice_id and i.tenant_id = b.tenant_id
     where b.subscription_id = v_sub.id
       and b.tenant_id = v_sub.tenant_id
       and b.renews_from = v_sub.renewal_date
       and i.status = 'paid'
     order by b.term_start, b.period_index
     limit 1;
    if not found then
      exit;
    end if;
    update public.subscriptions
       set renewal_date = v_b.renews_to,
           renewal_state = 'renewed',
           reminder_count = 0,
           last_reminder_sent_at_v2 = null
     where id = v_sub.id and tenant_id = v_sub.tenant_id and renewal_date = v_sub.renewal_date
       and renewal_quote_id is null;
    get diagnostics v_n = row_count;
    exit when v_n = 0;
    insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why)
    values (v_sub.tenant_id, v_sub.id, v_b.id, 'forward', v_sub.renewal_date, v_b.renews_to, v_b.invoice_id,
            'renewal part paid (invoice ' || v_b.invoice_id || ')');
    v_rolls := v_rolls + 1;
  end loop;
  return v_rolls;
end;
$$;
revoke all on function public.roll_paid_renewal_terms(uuid) from public, anon, authenticated;
grant execute on function public.roll_paid_renewal_terms(uuid) to service_role;

-- ── 3. The undo ──────────────────────────────────────────────────────────────────────────────────────
create or replace function public.unroll_unpaid_renewal_terms(p_subscription_id uuid, p_why text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
/* R-2749: a renewal part's payment was undone → move renewal_date back to the term's renews_from, once.
   Walks back the chain of ACTIVE 'forward' moves (not yet reversed by a later 'back' of the same term) that
   ends at the CURRENT renewal_date — no such row (a hand-changed date) ends it, so a hand-changed date is never
   touched. The oldest term in that chain whose part is no longer paid decides: renewal_date goes back to its
   renews_from (newer terms rolled on top wait behind it again), renewal_state 'pending', reminders reset.
   HELD (date left, one 'held' row for the report — the owner decides): the subscription is not active / paused
   (cancelled / expired — its recorded end stays), a renewal / extension / plan-change quote is linked on
   renewal_quote_id (it prices the term after the current date), or a seat cut is scheduled for the end of the
   current term (moving the date would move or cancel it, R-2613).
   Returns the number of terms moved back. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_sub     record;
  v_m       record;
  v_date    date;
  v_chain   bigint[] := '{}';
  v_upto    integer := 0;
  v_target  date;
  v_oldest  record;
  v_hold    text;
  v_n       integer;
  v_paid    boolean;
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can change it' using errcode = '28000';
  end if;
  select s.id, s.tenant_id, s.renewal_date, s.status::text as status, s.renewal_quote_id into v_sub
    from public.subscriptions s where s.id = p_subscription_id for update;
  if not found or v_sub.renewal_date is null then
    return 0;
  end if;
  if v_caller is not null and v_sub.tenant_id is distinct from v_caller then
    raise exception 'Subscription % is not in the caller''s company', p_subscription_id using errcode = '42501';
  end if;

  v_date := v_sub.renewal_date;
  for i in 1..24 loop
    select m.id, m.billing_id, m.from_date, m.to_date into v_m
      from public.subscription_renewal_moves m
     where m.subscription_id = v_sub.id and m.tenant_id = v_sub.tenant_id
       and m.direction = 'forward' and m.to_date = v_date
       and not exists (select 1 from public.subscription_renewal_moves r
                        where r.subscription_id = m.subscription_id and r.tenant_id = m.tenant_id
                          and r.direction = 'back' and r.id > m.id
                          and r.from_date = m.to_date and r.to_date = m.from_date)
     order by m.id desc
     limit 1;
    exit when not found;
    v_chain := v_chain || v_m.id;
    select exists (
      select 1 from public.subscription_billings b
        join public.invoices i on i.id = b.invoice_id and i.tenant_id = b.tenant_id
       where b.subscription_id = v_sub.id and b.tenant_id = v_sub.tenant_id
         and b.renews_from = v_m.from_date and b.renews_to = v_m.to_date
         and i.status = 'paid') into v_paid;
    if not v_paid then
      v_upto := i;            -- walking back = older; the last hit is the OLDEST unpaid term
      v_target := v_m.from_date;
      v_oldest := v_m;
    end if;
    v_date := v_m.from_date;
  end loop;
  if v_upto = 0 then
    return 0;
  end if;

  v_hold := case
    when v_sub.status not in ('active', 'paused') then 'subscription is ' || v_sub.status || ' — its end date is kept'
    when v_sub.renewal_quote_id is not null then 'quote ' || v_sub.renewal_quote_id || ' is linked for the next term'
    when exists (select 1 from public.subscription_seat_reductions r
                  where r.tenant_id = v_sub.tenant_id and r.subscription_id = v_sub.id
                    and r.status = 'scheduled' and r.timing = 'end_of_term' and r.effective_date = v_sub.renewal_date)
      then 'a seat cut is scheduled for ' || to_char(v_sub.renewal_date, 'DD Mon YYYY')
  end;
  if v_hold is not null then
    if not exists (select 1 from public.subscription_renewal_moves h
                    where h.subscription_id = v_sub.id and h.tenant_id = v_sub.tenant_id and h.direction = 'held'
                      and h.id > v_oldest.id and h.from_date = v_sub.renewal_date and h.to_date = v_target) then
      insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why)
      values (v_sub.tenant_id, v_sub.id, v_oldest.billing_id, 'held', v_sub.renewal_date, v_target, null,
              coalesce(nullif(btrim(p_why), ''), 'renewal part payment undone') || ' — NOT moved back: ' || v_hold);
    end if;
    return 0;
  end if;

  update public.subscriptions
     set renewal_date = v_target,
         renewal_state = 'pending',
         reminder_count = 0,
         last_reminder_sent_at_v2 = null
   where id = v_sub.id and tenant_id = v_sub.tenant_id and renewal_date = v_sub.renewal_date
     and renewal_quote_id is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return 0;
  end if;
  insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why)
  select m.tenant_id, m.subscription_id, m.billing_id, 'back', m.to_date, m.from_date, m.invoice_id,
         coalesce(nullif(btrim(p_why), ''), 'renewal part payment undone')
    from unnest(v_chain[1:v_upto]) with ordinality as c(mid, ord)
    join public.subscription_renewal_moves m on m.id = c.mid
   order by c.ord;
  return v_upto;
end;
$$;
revoke all on function public.unroll_unpaid_renewal_terms(uuid, text) from public, anon, authenticated;
grant execute on function public.unroll_unpaid_renewal_terms(uuid, text) to service_role;

-- A marked part's invoice left 'paid' (bank un-reconcile, take-back, void).
create or replace function public.tg_r2749_invoice_unpaid_unrenews()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2749: an invoice is no longer paid → move back every subscription whose marked renewal part it is. */
declare
  v_sid uuid;
begin
  for v_sid in
    select distinct b.subscription_id from public.subscription_billings b
     where b.invoice_id = new.id and b.tenant_id = new.tenant_id and b.renews_to is not null
  loop
    perform public.unroll_unpaid_renewal_terms(v_sid,
      'invoice ' || new.id || ' no longer paid (' || old.status::text || ' → ' || new.status::text || ')');
  end loop;
  return new;
end;
$$;
revoke all on function public.tg_r2749_invoice_unpaid_unrenews() from public, anon, authenticated;

drop trigger if exists invoices_r2749_unpaid_part_unrenews on public.invoices;
create trigger invoices_r2749_unpaid_part_unrenews
  after update of status on public.invoices
  for each row
  when (old.status = 'paid' and new.status is distinct from 'paid')
  execute function public.tg_r2749_invoice_unpaid_unrenews();

-- A marked part lost its invoice (full credit note frees it, R-2095) or got another one.
create or replace function public.tg_r2749_part_released_unrenews()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2749: a marked renewal part's invoice link was cleared / replaced → move back if no longer paid. */
begin
  perform public.unroll_unpaid_renewal_terms(new.subscription_id,
    'part invoice ' || old.invoice_id || ' cancelled' || case when new.invoice_id is null then ' (credit note)' else '' end);
  return new;
end;
$$;
revoke all on function public.tg_r2749_part_released_unrenews() from public, anon, authenticated;

drop trigger if exists subscription_billings_r2749_part_released_unrenews on public.subscription_billings;
create trigger subscription_billings_r2749_part_released_unrenews
  after update of invoice_id on public.subscription_billings
  for each row
  when (old.renews_to is not null and old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id)
  execute function public.tg_r2749_part_released_unrenews();

-- ── 4. Won't renew while the renewal part is billed and unpaid → refused ─────────────────────────────
create or replace function public.tg_r2749_wont_renew_open_part()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2749: Won't renew (auto_renew → false on a running subscription) is refused while the part that renews the
   CURRENT renewal_date is billed and unpaid — a live proforma, or an unpaid (draft / pending / overdue) part
   invoice; its payment would bill a term that never starts. Cancel that document first. Cancel subscription
   (status → cancelled in the same update) is not held here. A void invoice is not open. */
declare
  v_doc text;
  v_from date;
  v_to date;
begin
  select coalesce(q.id, b.invoice_id), b.period_start, (b.period_end - 1) into v_doc, v_from, v_to
    from public.subscription_billings b
    left join public.invoices i on i.id = b.invoice_id and i.tenant_id = b.tenant_id
    left join lateral (
      select q2.id from public.quotes q2
       where q2.subscription_billing_id = b.id and q2.tenant_id = b.tenant_id and q2.cancelled_at is null
         and q2.status not in ('rejected', 'expired')
       order by q2.created_at desc limit 1) q on true
   where b.subscription_id = new.id and b.tenant_id = new.tenant_id
     and b.renews_from = new.renewal_date and b.renews_to is not null
     and ((b.invoice_id is not null and i.status::text in ('draft', 'pending', 'overdue'))
          or (b.invoice_id is null and q.id is not null))
   order by b.term_start, b.period_index
   limit 1;
  if found then
    raise exception 'Cancel % first — it bills the next term (% to %) and is not paid. Won''t renew can be set once it is cancelled; if the customer pays it, the subscription renews instead.',
      v_doc, to_char(v_from, 'DD Mon YYYY'), to_char(v_to, 'DD Mon YYYY')
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_r2749_wont_renew_open_part() from public, anon, authenticated;

drop trigger if exists subscriptions_r2749_wont_renew_open_part on public.subscriptions;
create trigger subscriptions_r2749_wont_renew_open_part
  before update of auto_renew on public.subscriptions
  for each row
  when (new.auto_renew is false and old.auto_renew is distinct from false and new.status in ('active', 'paused'))
  execute function public.tg_r2749_wont_renew_open_part();

-- ── 5. Made active again → a paid part that waited renews ────────────────────────────────────────────
create or replace function public.tg_r2749_reactivated_renews()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2749: status back to active / paused → run the waiting R-2735 roll (no-op without a paid marked part). */
begin
  perform public.roll_paid_renewal_terms(new.id);
  return new;
end;
$$;
revoke all on function public.tg_r2749_reactivated_renews() from public, anon, authenticated;

drop trigger if exists subscriptions_r2749_reactivated_renews on public.subscriptions;
create trigger subscriptions_r2749_reactivated_renews
  after update of status on public.subscriptions
  for each row
  when (new.status in ('active', 'paused') and old.status not in ('active', 'paused'))
  execute function public.tg_r2749_reactivated_renews();

commit;
