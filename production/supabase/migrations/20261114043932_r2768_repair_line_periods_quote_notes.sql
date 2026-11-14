-- deploy-peek: to_regclass('public.r2768_repair_log') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_invoices_freeze_issued()') and prosrc like '%R-2768%') and to_regprocedure('public.r2768_repair_invoice_line_periods(boolean)') is not null and to_regprocedure('public.r2768_repair_quote_notes(boolean)') is not null and to_regprocedure('public.r2768_undo(uuid)') is not null
-- deploy-key: r2768repairlineperiodsquotenotes
-- 20261114043932_r2768_repair_line_periods_quote_notes.sql
--
-- R-2768 (14 Nov 2026) — the TOOLS for two owner-approved data repairs (Pardeep 14 Nov 09:54 IST,
-- ownerDecision on R-2744 and R-2754). THIS MIGRATION CHANGES NO DATA. The repair itself is run by
-- scripts/ops/r2768-repair.sql (dry run by default, `-v apply=1` commits) — on staging / live by the
-- manager or Pardeep after this migration is in (repo rule R-2539 / R-2570: a staging/live data repair
-- is the owner's step, never folded into Claude's deploy-db step).
--
-- REPAIR A (R-2744 backfill) — r2768_repair_invoice_line_periods(p_apply)
--   Invoices issued before migration 20261113210500 store no line period; their PDF / screen work it
--   out from today's quote + subscription. For each issued invoice (pending / paid / overdue) made
--   from a quote whose lines carry no service_period, it stores on EVERY line what the stamp trigger
--   would store today: public.invoice_lines_with_periods (same function, same quote / subscription /
--   app_rule_dates / created_at inputs as tg_invoice_stamp_line_periods) — a line with no period gets
--   an explicit JSON null. Only when the stamp cannot change what is printed:
--     * the invoice's lines ARE its quote's lines (equal after dropping the internal cost /
--       cost_source keys — a stamped invoice prints its OWN lines, an unstamped one the quote's);
--     * the PDF prints from the quote today (build-props useQuote: no persisted taxable/tax, or the
--       quote's taxable / GST / total still equal the invoice's) — else the PDF prints the invoice's
--       own lines with NO period while the screen prints the quote's lines with one; a stamp would
--       change one of the two, so that invoice is left as it is (counted 'skip_pdf_own_lines').
--   Skipped and counted: no lines stored (NULL line_items — filling lines is more than adding a key),
--   lines differ from the quote, some lines already stamped, PDF prints its own lines.
--   Nothing else on the row changes: no amount / tax / number / date / status; updated_at is kept.
--
-- THE FREEZE STAYS ON. tg_invoices_freeze_issued gets ONE narrow allowance: while the transaction-local
-- setting app.r2768_repair = 'on' (set_config(..., true) by the repair function right before its
-- UPDATE and cleared right after), a change whose ONLY changed column is line_items passes when
--   add:  no old line has service_period, every new line has it, and new minus that key = old exactly;
--   undo: the reverse, and only back to the value r2768_repair_log recorded for that invoice.
-- Any other change — another column, a line's name / rate / qty, an edit of a stored period — is
-- refused exactly as before, flag or not. app.invoice_amend_reason (the broad override) is not used.
--
-- REPAIR B (R-2754 notes) — r2768_repair_quote_notes(p_apply)
--   Non-draft quotes whose CUSTOMER part of notes (before "Staff only (not shown to the customer):")
--   carries an internal subscription id get the shape the quote editor now saves on an edit
--   (lib/quotes/editor-notes.ts splitNotesForEditor + joinEditorNotes, ctx = quote plan +
--   extension_months as quote-builder passes it):
--       <customerQuoteNotes(...) — what the customer reads>\n\nStaff only (not shown to the customer):\n<held back>
--   held back = the system lead sentence VERBATIM (it carries "subscription <uuid>"), every later
--   sentence with an id / staff phrase verbatim, then the old staff part. SQL port of
--   lib/quotes/customer-notes.ts; parity with the TypeScript on one shared case list
--   (supabase/tests/r2768_repair.test.sql R2768-NOTES-CASES, read by
--   src/lib/quotes/quote-notes-repair-r2768.test.ts). A row is skipped when the first
--   "subscription <uuid>" in the field would change (Renewals open-renewal-quotes.ts, seat-quotes-
--   pending.ts and tg_quotes_add_seats_take_back read it) or the new customer part still has an id.
--   updated_at is kept.
--
-- BOTH: idempotent (a second run finds nothing), tenant-safe (every UPDATE keyed on id + tenant_id
-- and guarded on the exact old value), logged in public.r2768_repair_log (before / after per row,
-- run_id) — public.r2768_undo(run_id) puts the before values back. Dry run: p_apply = false returns
-- the counts + a sample and writes nothing. Repair functions: no grants (owner / migration login only).
-- Proof: supabase/tests/r2768_repair.test.sql (rolled back) + scripts/ops/r2768-repair-proof.mjs.

begin;

-- ── 0. the log (undo source) ─────────────────────────────────────────────────
create table if not exists public.r2768_repair_log (
  id         bigint generated always as identity primary key,
  run_id     uuid not null,
  repair     text not null check (repair in ('A', 'B')),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  row_id     text not null,
  before     jsonb,
  after      jsonb,
  applied_at timestamptz not null default now(),
  undone_at  timestamptz
);
create index if not exists r2768_repair_log_row_idx on public.r2768_repair_log (repair, row_id);
create index if not exists r2768_repair_log_run_idx on public.r2768_repair_log (run_id);
alter table public.r2768_repair_log enable row level security;
drop policy if exists r2768_repair_log_read on public.r2768_repair_log;
create policy r2768_repair_log_read on public.r2768_repair_log for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'accountant'));
drop policy if exists zzz_service_role_all on public.r2768_repair_log;
create policy zzz_service_role_all on public.r2768_repair_log as permissive for all to service_role using (true) with check (true);
revoke all on public.r2768_repair_log from anon;
revoke insert, update, delete on public.r2768_repair_log from authenticated;
grant select on public.r2768_repair_log to authenticated;
comment on table public.r2768_repair_log is
  'R-2768: before/after of every row the owner-approved repairs changed (A = invoices.line_items service_period backfill, B = quotes.notes id moved under Staff only). r2768_undo(run_id) restores.';

-- ── 1. line helpers (Repair A) ───────────────────────────────────────────────
-- Every line object without the given keys (arrays only; anything else comes back as is).
create or replace function public.r2768_lines_without(p_lines jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p_lines) is distinct from 'array' then p_lines
    else coalesce((select jsonb_agg(case when jsonb_typeof(l) = 'object' then l - p_keys else l end order by i)
                     from jsonb_array_elements(p_lines) with ordinality as e(l, i)), '[]'::jsonb) end
$$;

-- The freeze allowance: true only for adding service_period to every line of an unstamped invoice
-- (or, for r2768_undo, taking back exactly what r2768_repair_log recorded). Read by the freeze trigger.
create or replace function public.r2768_freeze_allows(p_invoice_id text, p_old jsonb, p_new jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_n int;
begin
  if coalesce(current_setting('app.r2768_repair', true), '') <> 'on' then return false; end if;
  if jsonb_typeof(p_old) is distinct from 'array' or jsonb_typeof(p_new) is distinct from 'array' then return false; end if;
  v_n := jsonb_array_length(p_old);
  if v_n = 0 or jsonb_array_length(p_new) <> v_n then return false; end if;
  if exists (select 1 from jsonb_array_elements(p_old) l where jsonb_typeof(l) <> 'object')
     or exists (select 1 from jsonb_array_elements(p_new) l where jsonb_typeof(l) <> 'object') then
    return false;
  end if;
  -- add: old unstamped, new stamped on every line, nothing else different
  if not exists (select 1 from jsonb_array_elements(p_old) l where l ? 'service_period')
     and not exists (select 1 from jsonb_array_elements(p_new) l where not (l ? 'service_period'))
     and public.r2768_lines_without(p_new, array['service_period']) = p_old then
    return true;
  end if;
  -- undo: back to exactly what the log holds for this invoice
  if not exists (select 1 from jsonb_array_elements(p_new) l where l ? 'service_period')
     and not exists (select 1 from jsonb_array_elements(p_old) l where not (l ? 'service_period'))
     and public.r2768_lines_without(p_old, array['service_period']) = p_new
     and exists (select 1 from public.r2768_repair_log g
                  where g.repair = 'A' and g.row_id = p_invoice_id and g.undone_at is null
                    and g.after = p_old and g.before = p_new) then
    return true;
  end if;
  return false;
end;
$$;
revoke all on function public.r2768_lines_without(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.r2768_freeze_allows(text, jsonb, jsonb) from public, anon, authenticated;

-- ── 2. the freeze, with the R-2768 allowance (body otherwise = 20261022014346 R-1736) ──
CREATE OR REPLACE FUNCTION public.tg_invoices_freeze_issued()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  /* An escape hatch that has to be spelled out. A guard with no legitimate override is
     a guard somebody eventually drops; one that needs a stated REASON cannot be set by
     reflex, is transaction-scoped (`set local`), and leaves the reason in the log beside
     the change. No application code path sets this — it is for a reviewed maintenance
     script, the same shape as the files under supabase/maintenance.

     (Do not write that path with a glob. Postgres block comments NEST, so a stray
     slash-star inside one opens a second comment and the entire function body becomes
     unterminated. This file failed to parse for exactly that reason on the first
     attempt, and the error points at the comment rather than at the glob.) */
  v_reason  text := nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '');
  v_changed text[] := '{}';

  /* Two tiers, because "changed" is not one question.

     STRICT — the identity of the document. There is no story in which these move on an
     issued invoice, including from null.

     ONCE-SET — a particular that may legitimately be FILLED IN later. taxable_value,
     tax_amount, tax_rate and inter_state arrived in a later migration, so invoices
     issued before it hold nulls, and a backfill completes the record rather than
     amending it. Null -> value is allowed; value -> a different value is not. */
begin
  -- ── STRICT ──────────────────────────────────────────────────────────────
  if new.id            is distinct from old.id            then v_changed := v_changed || 'id (the invoice number)'::text; end if;
  if new.tenant_id     is distinct from old.tenant_id     then v_changed := v_changed || 'tenant_id (the supplier)'::text; end if;
  if new.invoice_date  is distinct from old.invoice_date  then v_changed := v_changed || 'invoice_date'::text; end if;
  if new.amount        is distinct from old.amount        then v_changed := v_changed || 'amount'::text; end if;
  if new.customer_name is distinct from old.customer_name then v_changed := v_changed || 'customer_name'::text; end if;

  -- ── ONCE-SET: null may be filled, a value may not be replaced ───────────
  if old.customer_id   is not null and new.customer_id   is distinct from old.customer_id   then v_changed := v_changed || 'customer_id'::text; end if;
  if old.taxable_value is not null and new.taxable_value is distinct from old.taxable_value then v_changed := v_changed || 'taxable_value'::text; end if;
  if old.tax_amount    is not null and new.tax_amount    is distinct from old.tax_amount    then v_changed := v_changed || 'tax_amount'::text; end if;
  if old.tax_rate      is not null and new.tax_rate      is distinct from old.tax_rate      then v_changed := v_changed || 'tax_rate'::text; end if;
  if old.inter_state   is not null and new.inter_state   is distinct from old.inter_state   then v_changed := v_changed || 'inter_state (this is the CGST+SGST vs IGST switch)'::text; end if;
  if old.line_items    is not null and new.line_items    is distinct from old.line_items    then v_changed := v_changed || 'line_items'::text; end if;
  if old.quote_id      is not null and new.quote_id      is distinct from old.quote_id      then v_changed := v_changed || 'quote_id'::text; end if;
  if old.due_date      is not null and new.due_date      is distinct from old.due_date      then v_changed := v_changed || 'due_date'::text; end if;
  -- R-043: the parties as they stood on the day of issue (CGST Rule 46).
  if old.customer_gstin    is not null and new.customer_gstin    is distinct from old.customer_gstin    then v_changed := v_changed || 'customer_gstin'::text; end if;
  if old.billing_address   is not null and new.billing_address   is distinct from old.billing_address   then v_changed := v_changed || 'billing_address'::text; end if;
  if old.customer_country  is not null and new.customer_country  is distinct from old.customer_country  then v_changed := v_changed || 'customer_country'::text; end if;
  if old.pos_state_code    is not null and new.pos_state_code    is distinct from old.pos_state_code    then v_changed := v_changed || 'pos_state_code (place of supply)'::text; end if;
  if old.seller_gstin      is not null and new.seller_gstin      is distinct from old.seller_gstin      then v_changed := v_changed || 'seller_gstin'::text; end if;
  if old.seller_state_code is not null and new.seller_state_code is distinct from old.seller_state_code then v_changed := v_changed || 'seller_state_code'::text; end if;
  -- R-1736: the GST treatment the invoice was taxed under.
  if old.gst_treatment     is not null and new.gst_treatment     is distinct from old.gst_treatment     then v_changed := v_changed || 'gst_treatment'::text; end if;

  /* Everything not listed above is deliberately mutable, because it is the invoice's
     LIFECYCLE rather than the document: status, paid_date, paid_amount, overdue_days,
     razorpay_id, pdf_url, updated_at — and gst_irn, which by definition arrives from the
     IRP only AFTER the invoice is issued, so freezing it would break e-invoicing.

     adjusted_advances / net_payable / first_advance_at are mutable too, and that is a
     considered carve-out rather than an omission: adjusting a customer advance against
     an invoice is a real post-issue settlement under CGST Section 31(3)(d), and the
     feature that does it (migration 0209) would break if this froze them. */

  /* R-2768 (14 Nov 2026): the ONE narrow allowance for the owner-approved line-period backfill.
     Only while the repair function has set app.r2768_repair = 'on' for its own UPDATE (set_config
     local, cleared right after), and only when line_items is the ONLY changed column and the change
     is exactly 'service_period added to every line of an unstamped invoice' (or r2768_undo taking
     back what r2768_repair_log recorded) — public.r2768_freeze_allows. Anything else is refused below. */
  if v_changed = array['line_items']::text[]
     and public.r2768_freeze_allows(old.id::text, old.line_items, new.line_items) then
    return new;
  end if;

  if array_length(v_changed, 1) is null then
    return new;
  end if;

  if v_reason is not null then
    raise notice '[invoices] % amended under app.invoice_amend_reason=%: %',
      old.id, v_reason, array_to_string(v_changed, ', ');
    return new;
  end if;

  /* Reason, then the next step, then where to do it — CLAUDE.md §24. A bare "not
     allowed" on a money guard sends the operator to the database. */
  raise exception
    'Invoice % has been issued, so its % cannot be changed. Under CGST Section 34 a mistake on an issued invoice is corrected with a CREDIT NOTE plus a fresh invoice, not an edit — the buyer has already claimed input credit against the copy they hold. Open the invoice and use "Issue credit note".',
    old.id, array_to_string(v_changed, ', ');
end;
$function$;
comment on function public.tg_invoices_freeze_issued() is
  'Refuses UPDATEs to the CGST Rule 46 particulars of an issued invoice (number, supplier, '
  'customer, date, amount, tax split, line items, due date). Lifecycle columns — status, '
  'payment, gst_irn, pdf_url, advance adjustments — stay mutable. Override for a reviewed '
  'maintenance script only: set local app.invoice_amend_reason = ''<why>''. R-2768: one narrow '
  'allowance — adding service_period to every line of an unstamped invoice while app.r2768_repair '
  'is on (r2768_freeze_allows).';

-- ── 3. updated_at stays as it was on a repaired row ─────────────────────────────
-- Runs after trg_invoices_updated_at / trg_quotes_updated_at (BEFORE UPDATE triggers fire in name order).
create or replace function public.tg_r2768_keep_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.r2768_repair', true), '') = 'on' then
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_r2768_keep_updated_at() from public, anon, authenticated;
drop trigger if exists trg_invoices_zz_r2768_keep_updated_at on public.invoices;
create trigger trg_invoices_zz_r2768_keep_updated_at before update on public.invoices
  for each row execute function public.tg_r2768_keep_updated_at();
drop trigger if exists trg_quotes_zz_r2768_keep_updated_at on public.quotes;
create trigger trg_quotes_zz_r2768_keep_updated_at before update on public.quotes
  for each row execute function public.tg_r2768_keep_updated_at();

-- ── 4. Repair A: the plan ─────────────────────────────────────────────────────
-- One row per issued invoice made from a quote whose lines carry no service_period.
--   verdict 'stamp'                 -> after = the lines with every period stored
--           'skip_no_lines'         -> NULL / non-array / empty line_items
--           'skip_partly_stamped'   -> some lines already have the key
--           'skip_lines_differ'     -> the invoice's lines are not the quote's (cost keys ignored)
--           'skip_pdf_own_lines'    -> the PDF prints the invoice's own lines today (R-375 useQuote false)
create or replace function public.r2768_invoice_line_period_plan()
returns table (tenant_id uuid, invoice_id text, quote_id text, verdict text, before jsonb, after jsonb)
language sql
stable
set search_path = ''
as $$
  with rule as (
    select (select r.from_at from public.app_rule_dates r where r.key = 'r2727_invoice_period_rule') as from_at
  ), inv as (
    select i.id, i.tenant_id, i.quote_id, i.line_items, i.created_at, i.amount, i.taxable_value, i.tax_amount,
           q.line_items as q_lines, to_jsonb(q) as q,
           -- build-props quoteAmounts (R-804 quoteDisplayTax, tolerance 1) in float8 like the JS
           -- (Math.round(x) = floor(x + 0.5))
           coalesce(q.subtotal, 0)::float8 as q_sub, coalesce(q.discount_pct, 0)::float8 as q_disc_pct,
           coalesce(q.tax_rate, 18)::float8 as q_rate, q.amount::float8 as q_amount,
           (select jsonb_build_object('start_date', s.start_date, 'term_months', s.term_months)
              from public.subscriptions s
             where s.tenant_id = i.tenant_id
               and (q.is_renewal or q.is_extension)
               and case when q.renewal_subscription_id is not null then s.id = q.renewal_subscription_id
                        else s.renewal_quote_id = q.id end
             limit 1) as sub
      from public.invoices i
      join public.quotes q on q.id = i.quote_id and q.tenant_id = i.tenant_id
     where i.status::text in ('pending', 'paid', 'overdue')
       and not (jsonb_typeof(i.line_items) = 'array'
                and exists (select 1 from jsonb_array_elements(i.line_items) l
                             where jsonb_typeof(l) = 'object' and l ? 'service_period')
                and not exists (select 1 from jsonb_array_elements(i.line_items) l
                                 where jsonb_typeof(l) <> 'object' or not (l ? 'service_period')))
  ), amt as (
    select inv.*, floor(q_sub * (q_disc_pct / 100) + 0.5) as q_discount from inv
  ), amt2 as (
    select amt.*, (q_sub - q_discount) as q_taxable from amt
  ), amt3 as (
    select amt2.*,
           case when q_amount is null then floor(q_taxable * (q_rate / 100) + 0.5)
                when abs((q_amount - q_taxable) - floor(q_taxable * (q_rate / 100) + 0.5)) <= 1 then q_amount - q_taxable
                else floor(q_taxable * (q_rate / 100) + 0.5) end as q_tax
      from amt2
  ), judged as (
    select a.*,
           case
             when jsonb_typeof(a.line_items) is distinct from 'array' or jsonb_array_length(a.line_items) = 0
               or exists (select 1 from jsonb_array_elements(a.line_items) l where jsonb_typeof(l) <> 'object')
               then 'skip_no_lines'
             when exists (select 1 from jsonb_array_elements(a.line_items) l where l ? 'service_period')
               then 'skip_partly_stamped'
             when public.r2768_lines_without(a.line_items, array['cost', 'cost_source'])
                  is distinct from public.r2768_lines_without(a.q_lines, array['cost', 'cost_source'])
               then 'skip_lines_differ'
             when a.taxable_value is not null and a.tax_amount is not null
                  and not (a.q_taxable = a.taxable_value::float8 and a.q_tax = a.tax_amount::float8
                           and coalesce(a.q_amount, a.q_taxable + a.q_tax) = a.amount::float8)
               then 'skip_pdf_own_lines'
             else 'stamp'
           end as verdict
      from amt3 a
  )
  select j.tenant_id, j.id, j.quote_id, j.verdict, j.line_items,
         case when j.verdict = 'stamp'
              then public.invoice_lines_with_periods(j.line_items, j.q, j.sub, rule.from_at, j.created_at) end
    from judged j cross join rule
$$;

-- ── 5. Repair A: dry run / apply ──────────────────────────────────────────────
create or replace function public.r2768_repair_invoice_line_periods(p_apply boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_run    uuid := gen_random_uuid();
  v_counts jsonb;
  v_sample jsonb;
  v_done   int := 0;
  v_n      int;
  r        record;
begin
  create temp table if not exists r2768_a_plan on commit drop as
    select * from public.r2768_invoice_line_period_plan() limit 0;
  truncate r2768_a_plan;
  insert into r2768_a_plan select * from public.r2768_invoice_line_period_plan();

  select coalesce(jsonb_object_agg(verdict, n), '{}'::jsonb) into v_counts
    from (select verdict, count(*) as n from r2768_a_plan group by verdict) c;
  select coalesce(jsonb_agg(jsonb_build_object('invoice', p.invoice_id,
           'periods', (select jsonb_agg(l->'service_period' order by i) from jsonb_array_elements(p.after) with ordinality e(l, i)))
           order by p.invoice_id), '[]'::jsonb) into v_sample
    from (select * from r2768_a_plan where verdict = 'stamp' order by invoice_id limit 5) p;

  if p_apply then
    for r in select * from r2768_a_plan where verdict = 'stamp' order by tenant_id, invoice_id loop
      if r.after is null or r.after = r.before then continue; end if;
      perform set_config('app.r2768_repair', 'on', true);
      update public.invoices i set line_items = r.after
       where i.id = r.invoice_id and i.tenant_id = r.tenant_id and i.line_items = r.before;
      get diagnostics v_n = row_count;
      perform set_config('app.r2768_repair', '', true);
      if v_n = 1 then
        insert into public.r2768_repair_log (run_id, repair, tenant_id, row_id, before, after)
          values (v_run, 'A', r.tenant_id, r.invoice_id, r.before, r.after);
        v_done := v_done + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('repair', 'A invoice line service_period', 'run_id', case when p_apply then v_run end,
                            'applied', p_apply, 'changed', v_done, 'plan', v_counts, 'sample', v_sample);
end;
$$;
revoke all on function public.r2768_invoice_line_period_plan() from public, anon, authenticated;
revoke all on function public.r2768_repair_invoice_line_periods(boolean) from public, anon, authenticated;

-- ── 6. Repair B: SQL port of lib/quotes/customer-notes.ts + editor-notes.ts ──────
-- Parity with the TypeScript on one case list (R2768-NOTES-CASES in supabase/tests/r2768_repair.test.sql,
-- read by src/lib/quotes/quote-notes-repair-r2768.test.ts). JS \b = \y here; JS "." = [^\n\r  ];
-- a JS lazy part is matched in its own non-greedy regexp (Postgres takes greediness from the first
-- quantifier of the whole pattern). String.trim() / the sentence split use JS's whitespace set.

-- String.prototype.trim
create or replace function public.r2768_js_trim(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(coalesce(p, ''),
    '^[\s   -     　﻿]+|[\s   -     　﻿]+$',
    '', 'g')
$$;

-- customer-notes.ts stripIds (one line)
create or replace function public.r2768_strip_ids(p_line text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(p_line, ''),
            '\s*\(\s*subscription(?:\s+id)?[\s:]+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*\)', '', 'gi'),
          '\s*\yfor\s+subscription(?:\s+id)?[\s:]+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'gi'),
        '\s*\ysubscription(?:\s+id)?[\s:]+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'gi'),
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'gi'),
    '[ \t]+([.,;:])', '\1', 'g')
$$;

-- customer-notes.ts scrubCustomerText
create or replace function public.r2768_scrub_customer_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select public.r2768_js_trim(regexp_replace(coalesce(string_agg(x.ln, E'\n' order by x.i), ''), E'\n{3,}', E'\n\n', 'g'))
    from (
      select l.i,
             (select regexp_replace(coalesce(string_agg(t.s, ' ' order by t.j), ''),
                       '[\s   -     　﻿]+$', '')
                from regexp_split_to_table(public.r2768_strip_ids(l.line),
                       '(?<=[.!?])[\s   -     　﻿]+') with ordinality as t(s, j)
               where not (t.s ~* 'backdated by|\yfactor\s+[\d.]+%?|\ysubscription id\y')) as ln
        from regexp_split_to_table(coalesce(p_text, ''), E'\n') with ordinality as l(line, i)
    ) x
$$;

-- The system lead at the start of the customer part: {kind, m0 (the match, untrimmed), …}; null for none.
-- kind: legacy (pre-R-813 add-seats audit — all of it), extension, domain, renewal.
create or replace function public.r2768_note_lead(p_visible text, p_with_legacy boolean)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v  text := coalesce(p_visible, '');
  m  text[];
  t  text[];
  m0 text;
  r  text;
begin
  if p_with_legacy and v ~* '^\s*Add-seats pro-rata for subscription\y' then
    return jsonb_build_object('kind', 'legacy', 'm0', v);
  end if;
  m := regexp_match(v, '^(\s*(\d{1,3})-(year|month) extension for subscription [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.?)', 'i');
  if m is not null then
    r := substr(v, length(m[1]) + 1);
    t := regexp_match(r, '^(\s*On payment the renewal date advances by [^.(]*?(?:\s*\(to ([^)]+)\))?\.)', 'i');
    return jsonb_build_object('kind', 'extension', 'm0', m[1] || coalesce(t[1], ''),
                              'n', m[2]::int, 'unit', lower(m[3]), 'new_end', t[2]);
  end if;
  m := regexp_match(v, '^(\s*Domain renewal for (\S+?) \(subscription [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\))', 'i');
  if m is not null then
    m0 := m[1];
    t := regexp_match(substr(v, length(m0) + 1), '^(,\s*?at [^\n\r  ]*?\+\s*GST)', 'i');
    m0 := m0 || coalesce(t[1], '');
    if substr(v, length(m0) + 1, 1) = '.' then m0 := m0 || '.'; end if;
    return jsonb_build_object('kind', 'domain', 'm0', m0, 'domain', m[2]);
  end if;
  m := regexp_match(v, '^(\s*(?:Auto-generated renewal quote|Renewal quote(?: \(operator-generated\))?) for subscription [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.?)', 'i');
  if m is not null then
    return jsonb_build_object('kind', 'renewal', 'm0', m[1]);
  end if;
  return null;
end;
$$;

-- service-period.ts monthsWords
create or replace function public.r2768_months_words(p int)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p = 1 then '1 month'
              when p > 12 and p % 12 = 0 then (p / 12)::text || ' years'
              else p::text || ' months' end
$$;

-- quoteServicePeriod({lines: name/commitment only}) when it is {kind: months}; else null (customer-notes renewalPeriodWords).
create or replace function public.r2768_lines_period_months(p_lines jsonb)
returns int
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_any_range boolean := false;
  v_undated   boolean := false;
  v_lens      int[] := '{}';
  v_comm      text[] := '{}';
  v_n_term    int := 0;
  l           jsonb;
  v_name      text;
  v_rng       text[];
  v_ok        boolean;
  v_ext       text[];
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then return null; end if;
  for l in select e from jsonb_array_elements(p_lines) e loop
    v_name := case when jsonb_typeof(l) = 'object' then l->>'name' end;
    v_rng := regexp_match(coalesce(v_name, ''), '(?:pro-rata from|current term)\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})', 'i');
    v_ok := false;
    if v_rng is not null then
      begin
        v_ok := to_char(v_rng[1]::date, 'YYYY-MM-DD') = v_rng[1] and to_char(v_rng[2]::date, 'YYYY-MM-DD') = v_rng[2]
                and v_rng[2] collate "C" >= v_rng[1] collate "C";
      exception when others then v_ok := false;
      end;
    end if;
    if jsonb_typeof(l) = 'object' and jsonb_typeof(l->'commitment') is not null and jsonb_typeof(l->'commitment') <> 'null' or v_ok then
      v_n_term := v_n_term + 1;
      if v_ok then v_any_range := true; else v_undated := true; end if;
      v_ext := regexp_match(coalesce(v_name, ''), '\y(\d{1,2})-(year|month) extension\y', 'i');
      v_lens := v_lens || case when v_ext is null then null
                               else v_ext[1]::int * case when lower(v_ext[2]) = 'year' then 12 else 1 end end;
      if not v_ok then v_comm := v_comm || (l->>'commitment'); end if;
    end if;
  end loop;
  if v_any_range then return null; end if;   -- a dated window (or dated + undated): not a months period
  if v_n_term > 0 and not exists (select 1 from unnest(v_lens) x where x is null or x = 0)
     and (select count(distinct x) from unnest(v_lens) x) = 1 then
    return v_lens[1];
  end if;
  if (select count(distinct c) from unnest(v_comm) c) = 1 and v_comm[1] = 'monthly' then return 1; end if;
  if cardinality(v_comm) > 0 and not exists (select 1 from unnest(v_comm) c where c is null or c not like 'annual\_%') then
    return 12;   -- domainLineYears of a {name, commitment} line is always 1
  end if;
  return null;
end;
$$;

-- customer-notes.ts customerQuoteNotes(notes, lineItems, {plan, extensionMonths}) — null for none.
create or replace function public.r2768_customer_quote_notes(p_notes text, p_lines jsonb, p_plan text, p_ext_months int)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_marker constant text := 'Staff only (not shown to the customer):';
  v_lines  jsonb := case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end;
  v_at     int;
  v_vis    text;
  v_lead   jsonb;
  v_rest   text;
  v_line   text;
  v_scrub  text;
  v_months int;
  v_period text;
  v_plan   text;
  v_what   text;
  v_title  text;
  v_end    text;
  v_from   text;
  v_to     text;
  v_mon    text[] := array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
begin
  if p_notes is null or p_notes = '' then return null; end if;
  v_at := strpos(p_notes, c_marker);
  v_vis := public.r2768_js_trim(case when v_at > 0 then left(p_notes, v_at - 1) else p_notes end);
  if v_vis = '' then return null; end if;

  if not (v_vis ~* '^\s*Add-seats pro-rata for subscription\y') then
    v_lead := public.r2768_note_lead(v_vis, false);
    if v_lead is null then return nullif(public.r2768_scrub_customer_text(v_vis), ''); end if;
    v_rest := substr(v_vis, length(v_lead->>'m0') + 1);
    if v_lead->>'kind' = 'extension' then
      v_months := (v_lead->>'n')::int * case when v_lead->>'unit' = 'year' then 12 else 1 end;
      v_title := case when v_months > 0 then
                   case when v_months % 12 = 0 then (v_months / 12)::text || '-year extension' else v_months::text || '-month extension' end
                 else 'extension' end;
      v_title := upper(left(v_title, 1)) || substr(v_title, 2);
      v_end := public.r2768_js_trim(v_lead->>'new_end');
      v_line := case when v_end <> '' then v_title || '. Your renewal date moves to ' || v_end || '.'
                     else v_title || ' of your subscription.' end;
    else
      v_months := case when p_ext_months > 0 then p_ext_months else public.r2768_lines_period_months(v_lines) end;
      v_period := case when v_months is not null then public.r2768_months_words(v_months) end;
      v_plan := case when v_lead->>'kind' = 'domain' then v_lead->>'domain'
                     else coalesce(p_plan, case when jsonb_array_length(v_lines) = 1 then v_lines->0->>'name' end) end;
      v_what := case when v_plan is not null and public.r2768_js_trim(v_plan) <> ''
                          and v_plan !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                     then public.r2768_js_trim(v_plan) end;
      v_line := case when v_what is not null then 'Renewal of ' || v_what || ' for ' || coalesce(v_period, 'the next term') || '.'
                     else 'Renewal for ' || coalesce(v_period, 'the next term') || '.' end;
    end if;
    v_scrub := public.r2768_scrub_customer_text(v_rest);
    if v_scrub = '' then return v_line; end if;
    return v_line || case when v_rest ~ E'^[ \t]*\n' then E'\n' else ' ' end || v_scrub;
  end if;

  -- An old add-seats note is ALL audit text (addSeatsCustomerNote).
  v_from := (regexp_match(v_vis, 'Effective date (\d{4}-\d{2}-\d{2})'))[1];
  if v_from is null then
    v_from := (regexp_match((select coalesce(string_agg(coalesce(case when jsonb_typeof(l) = 'object' then l->>'name' end, ''), ' ' order by i), '')
                               from jsonb_array_elements(v_lines) with ordinality e(l, i)),
                            'pro-rata from (\d{4}-\d{2}-\d{2})'))[1];
  end if;
  select max(x collate "C") into v_to
    from (select (regexp_match(coalesce(case when jsonb_typeof(l) = 'object' then l->>'name' end, ''), '\yto (\d{4}-\d{2}-\d{2})\)'))[1] as x
            from jsonb_array_elements(v_lines) l) s;
  v_from := case when v_from is not null then
              (substr(v_from, 9, 2))::int::text || ' ' || coalesce(v_mon[(substr(v_from, 6, 2))::int], 'undefined') || ' ' || substr(v_from, 1, 4) end;
  v_to := case when v_to is not null then
            (substr(v_to, 9, 2))::int::text || ' ' || coalesce(v_mon[(substr(v_to, 6, 2))::int], 'undefined') || ' ' || substr(v_to, 1, 4) end;
  if v_from is not null and v_to is not null then return 'Additional seats from ' || v_from || ' to ' || v_to || ' (pro-rata).'; end if;
  if v_from is not null then return 'Additional seats from ' || v_from || ' (pro-rata).'; end if;
  return 'Additional seats, charged pro-rata for the rest of the term.';
end;
$$;

-- editor-notes.ts splitNotesForEditor + joinEditorNotes on an edited box: the stored field the editor
-- saves when the box holds what the customer reads. Null = nothing to hold back (left as it is).
create or replace function public.r2768_repaired_notes(p_notes text, p_lines jsonb, p_plan text, p_ext_months int)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_marker constant text := 'Staff only (not shown to the customer):';
  v_orig   text := coalesce(p_notes, '');
  v_at     int;
  v_vis    text;
  v_staff  text;
  v_lead   text;
  v_rest   text;
  v_held   text[];
  v_hidden text;
  v_cust   text;
begin
  if public.r2768_js_trim(v_orig) = '' then return null; end if;
  v_at := strpos(v_orig, c_marker);
  v_vis := public.r2768_js_trim(case when v_at > 0 then left(v_orig, v_at - 1) else v_orig end);
  v_staff := case when v_at > 0 then public.r2768_js_trim(substr(v_orig, v_at + length(c_marker))) else '' end;
  v_lead := public.r2768_js_trim(public.r2768_note_lead(v_vis, true)->>'m0');
  v_lead := nullif(v_lead, '');
  v_rest := case when v_lead is not null then substr(v_vis, strpos(v_vis, v_lead) + length(v_lead)) else v_vis end;
  select coalesce(array_agg(s order by i, j), '{}') into v_held
    from (select l.i, t.j, public.r2768_js_trim(t.s) as s
            from regexp_split_to_table(v_rest, E'\n') with ordinality as l(line, i),
                 regexp_split_to_table(l.line, '(?<=[.!?])[\s   -     　﻿]+') with ordinality as t(s, j)) x
   where s <> '' and (s ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                      or s ~* 'backdated by|\yfactor\s+[\d.]+%?|\ysubscription id\y');
  v_hidden := array_to_string(array_remove(array_remove(array[v_lead] || v_held || array[v_staff], null), ''), E'\n');
  if v_hidden = '' then return null; end if;
  v_cust := public.r2768_js_trim(coalesce(public.r2768_customer_quote_notes(v_orig, p_lines, p_plan, p_ext_months), ''));
  return case when v_cust <> '' then v_cust || E'\n\n' || c_marker || E'\n' || v_hidden
              else c_marker || E'\n' || v_hidden end;
end;
$$;

-- ── 7. Repair B: the plan ─────────────────────────────────────────────────────
--   verdict 'rewrite' | 'skip_nothing_held' | 'skip_still_has_id' | 'skip_link_changes'
create or replace function public.r2768_quote_notes_plan()
returns table (tenant_id uuid, quote_id text, status text, verdict text, before text, after text)
language sql
stable
set search_path = ''
as $$
  with c as (
    select q.tenant_id, q.id, q.status::text as status, q.notes,
           public.r2768_repaired_notes(q.notes, q.line_items, q.plan, q.extension_months) as after
      from public.quotes q
     where q.status::text <> 'draft'
       and q.notes is not null
       and split_part(q.notes, 'Staff only (not shown to the customer):', 1)
           ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  )
  select c.tenant_id, c.id, c.status,
         case
           when c.after is null or c.after = c.notes then 'skip_nothing_held'
           when split_part(c.after, 'Staff only (not shown to the customer):', 1)
                ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' then 'skip_still_has_id'
           -- open-renewal-quotes.ts SUB_ID (/i, lower-cased) and seat-quotes-pending.ts /
           -- tg_quotes_add_seats_take_back ('subscription ([0-9a-fA-F-]{36})'): the first id must not move
           when lower((regexp_match(c.notes, 'subscription ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'i'))[1])
                is distinct from lower((regexp_match(c.after, 'subscription ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'i'))[1])
             or substring(c.notes from 'subscription ([0-9a-fA-F-]{36})') is distinct from substring(c.after from 'subscription ([0-9a-fA-F-]{36})')
             then 'skip_link_changes'
           else 'rewrite'
         end,
         c.notes, c.after
    from c
$$;

-- ── 8. Repair B: dry run / apply ──────────────────────────────────────────────
create or replace function public.r2768_repair_quote_notes(p_apply boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_run    uuid := gen_random_uuid();
  v_counts jsonb;
  v_sample jsonb;
  v_done   int := 0;
  v_n      int;
  r        record;
begin
  create temp table if not exists r2768_b_plan on commit drop as
    select * from public.r2768_quote_notes_plan() limit 0;
  truncate r2768_b_plan;
  insert into r2768_b_plan select * from public.r2768_quote_notes_plan();

  select coalesce(jsonb_object_agg(verdict, n), '{}'::jsonb) into v_counts
    from (select verdict, count(*) as n from r2768_b_plan group by verdict) c;
  -- sample: the customer part only (no staff text, no id)
  select coalesce(jsonb_agg(jsonb_build_object('quote', p.quote_id, 'status', p.status,
           'customer_part_after', public.r2768_js_trim(split_part(p.after, 'Staff only (not shown to the customer):', 1)))
           order by p.quote_id), '[]'::jsonb) into v_sample
    from (select * from r2768_b_plan where verdict = 'rewrite' order by quote_id limit 5) p;

  if p_apply then
    for r in select * from r2768_b_plan where verdict = 'rewrite' order by tenant_id, quote_id loop
      perform set_config('app.r2768_repair', 'on', true);
      update public.quotes q set notes = r.after
       where q.id = r.quote_id and q.tenant_id = r.tenant_id and q.notes = r.before;
      get diagnostics v_n = row_count;
      perform set_config('app.r2768_repair', '', true);
      if v_n = 1 then
        insert into public.r2768_repair_log (run_id, repair, tenant_id, row_id, before, after)
          values (v_run, 'B', r.tenant_id, r.quote_id, to_jsonb(r.before), to_jsonb(r.after));
        v_done := v_done + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('repair', 'B quote notes id under Staff only', 'run_id', case when p_apply then v_run end,
                            'applied', p_apply, 'changed', v_done, 'plan', v_counts, 'sample', v_sample);
end;
$$;

-- ── 9. Undo one run ───────────────────────────────────────────────────────────
create or replace function public.r2768_undo(p_run_id uuid)
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
  for r in select * from public.r2768_repair_log g where g.run_id = p_run_id and g.undone_at is null order by g.id desc loop
    perform set_config('app.r2768_repair', 'on', true);
    if r.repair = 'A' then
      update public.invoices i set line_items = r.before
       where i.id = r.row_id and i.tenant_id = r.tenant_id and i.line_items = r.after;
    else
      update public.quotes q set notes = r.before #>> '{}'
       where q.id = r.row_id and q.tenant_id = r.tenant_id and q.notes = r.after #>> '{}';
    end if;
    get diagnostics v_n = row_count;
    perform set_config('app.r2768_repair', '', true);
    if v_n = 1 then
      update public.r2768_repair_log set undone_at = now() where id = r.id;
      v_done := v_done + 1;
    else
      v_left := v_left + 1;   -- changed again since the repair: left as it is
    end if;
  end loop;
  return jsonb_build_object('run_id', p_run_id, 'undone', v_done, 'changed_since_left', v_left);
end;
$$;

revoke all on function public.r2768_js_trim(text) from public, anon, authenticated;
revoke all on function public.r2768_strip_ids(text) from public, anon, authenticated;
revoke all on function public.r2768_scrub_customer_text(text) from public, anon, authenticated;
revoke all on function public.r2768_note_lead(text, boolean) from public, anon, authenticated;
revoke all on function public.r2768_months_words(int) from public, anon, authenticated;
revoke all on function public.r2768_lines_period_months(jsonb) from public, anon, authenticated;
revoke all on function public.r2768_customer_quote_notes(text, jsonb, text, int) from public, anon, authenticated;
revoke all on function public.r2768_repaired_notes(text, jsonb, text, int) from public, anon, authenticated;
revoke all on function public.r2768_quote_notes_plan() from public, anon, authenticated;
revoke all on function public.r2768_repair_quote_notes(boolean) from public, anon, authenticated;
revoke all on function public.r2768_undo(uuid) from public, anon, authenticated;

commit;
