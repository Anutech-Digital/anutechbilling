-- R-2768 — DATA REPAIR (owner-approved, Pardeep 14 Nov 2026 09:54 IST; ownerDecision on R-2744 + R-2754).
--   A: store each line's service period on old invoices made from a quote (R-2744 backfill) — what the
--      PDF / invoice page print TODAY, frozen; nothing else on the invoice changes.
--   B: old quotes whose customer part of notes shows an internal subscription id → the shape the quote
--      editor saves now (customer line, then "Staff only (not shown to the customer):" + the system text).
--
-- !! On staging / live this is run by the manager or Pardeep (repo rule R-2539 / R-2570: Claude runs
-- !! data repairs only on the local Docker DB). The deploy-db step must have applied migration
-- !! 20261114043932_r2768_repair_line_periods_quote_notes.sql first — it only installs the tools.
--
-- SAFE BY DEFAULT: without -v apply=1 it runs BOTH repairs inside one transaction, prints the counts,
-- a sample and the checks, then ROLLS BACK (a dry run). With -v apply=1 it COMMITS — only when every
-- check passed (a failed check raises and nothing is kept).
--
-- CHECKS (in the same transaction, before commit):
--   * invoices: count, Σ amount, Σ taxable_value, Σ tax_amount per company unchanged; every changed
--     invoice differs ONLY by service_period on its lines; updated_at unchanged
--   * quotes: only notes changed; the first "subscription <id>" in notes unchanged on EVERY quote (Renewals
--     open-renewal-quotes, add-seats link); no id left in the customer part of a rewritten quote
--   * a second run changes 0 rows (idempotent)
-- The issued-invoice freeze stays on; the repair passes it only through the narrow R-2768 allowance
-- (app.r2768_repair, set for its own UPDATE and cleared after). Every change is logged in
-- public.r2768_repair_log with before / after. UNDO: select public.r2768_undo('<run_id printed below>');
--
-- The TypeScript proof (PDF + invoice page before vs after for every invoice, Renewals map) runs on local:
--   node scripts/ops/r2768-repair-proof.mjs
--
-- HOW:
--   cd C:/Users/mso50/new-reselleros/production
--   STAGING: gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   dry run:  \i scripts/ops/r2768-repair.sql
--   apply:    \set apply 1
--             \i scripts/ops/r2768-repair.sql
--   Local Docker:
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 [-v apply=1] < scripts/ops/r2768-repair.sql

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif
\pset footer on
\pset null '·'

begin;

\echo
\echo '=== 0. Login check: tenants_visible should equal the number of companies; bypasses_row_security should be t ==='
select current_user                                                     as login,
       (select r.rolbypassrls from pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants)                             as tenants_visible,
       now() at time zone 'Asia/Kolkata'                                 as run_at_ist;

do $$
begin
  if to_regprocedure('public.r2768_repair_invoice_line_periods(boolean)') is null
     or to_regprocedure('public.r2768_repair_quote_notes(boolean)') is null
     or to_regclass('public.r2768_repair_log') is null then
    raise exception 'Migration 20261114043932 (R-2768) is not on this database — run the deploy-db step first. Nothing changed.';
  end if;
end $$;

-- ── before ──────────────────────────────────────────────────────────────────────
create temp table r2768_inv_before on commit drop as
  select id, tenant_id, to_jsonb(i) - 'line_items' as row, line_items from public.invoices i;
create temp table r2768_q_before on commit drop as
  select id, tenant_id, to_jsonb(q) - 'notes' as row, notes,
         lower((regexp_match(q.notes, 'subscription ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'i'))[1]) as link_ts,
         substring(q.notes from 'subscription ([0-9a-fA-F-]{36})') as link_sql
    from public.quotes q;
create temp table r2768_totals_before on commit drop as
  select tenant_id, count(*) as n, sum(amount) as amount, sum(taxable_value) as taxable, sum(tax_amount) as tax
    from public.invoices group by tenant_id;

\echo
\echo '=== 1. Plan (what would change) ==='
select public.r2768_repair_invoice_line_periods(false) as repair_a_plan;
select public.r2768_repair_quote_notes(false)          as repair_b_plan;

\echo
\echo '=== 2. Run both repairs (inside this transaction) ==='
create temp table r2768_runs on commit drop as
  select 'A'::text as repair, public.r2768_repair_invoice_line_periods(true) as result
  union all
  select 'B', public.r2768_repair_quote_notes(true);
select repair, result->>'run_id' as run_id, result->>'changed' as changed, result->'plan' as plan from r2768_runs order by repair;

\echo
\echo '=== 3. Per company: invoices stamped, quotes rewritten ==='
select t.name as company,
       count(*) filter (where g.repair = 'A') as invoices_stamped,
       count(*) filter (where g.repair = 'B') as quotes_rewritten
  from public.r2768_repair_log g
  join r2768_runs u on (u.result->>'run_id')::uuid = g.run_id
  join public.tenants t on t.id = g.tenant_id
 group by t.name order by t.name;

\echo
\echo '=== 4. Sample: 20 stamped invoices (periods stored per line) ==='
select g.row_id as invoice,
       (select string_agg(coalesce((l->'service_period'->>'from') || ' to ' || (l->'service_period'->>'to'), 'no period'), ' | ' order by i)
          from jsonb_array_elements(g.after) with ordinality e(l, i)) as periods
  from public.r2768_repair_log g join r2768_runs u on (u.result->>'run_id')::uuid = g.run_id
 where g.repair = 'A' order by g.row_id limit 20;

\echo
\echo '=== 5. Sample: 20 rewritten quotes (customer part only) ==='
select g.row_id as quote,
       public.r2768_js_trim(split_part(g.before #>> '{}', 'Staff only (not shown to the customer):', 1)) ~* '[0-9a-f]{8}-' as before_had_id,
       public.r2768_js_trim(split_part(g.after  #>> '{}', 'Staff only (not shown to the customer):', 1)) as customer_part_now
  from public.r2768_repair_log g join r2768_runs u on (u.result->>'run_id')::uuid = g.run_id
 where g.repair = 'B' order by g.row_id limit 20;

\echo
\echo '=== 6. Checks (any failure raises: nothing is kept) ==='
do $$
declare v_bad int; a jsonb; b jsonb;
begin
  -- invoice totals per company unchanged
  select count(*) into v_bad from (
    select tenant_id, count(*) as n, sum(amount) as amount, sum(taxable_value) as taxable, sum(tax_amount) as tax
      from public.invoices group by tenant_id
    except select * from r2768_totals_before) x;
  if v_bad > 0 then raise exception 'CHECK FAILED: invoice totals changed for % companies', v_bad; end if;
  -- invoices: only service_period added on the lines; every other column (updated_at too) unchanged
  select count(*) into v_bad from r2768_inv_before b join public.invoices i on i.id = b.id
   where (to_jsonb(i) - 'line_items') is distinct from b.row
      or public.r2768_lines_without(i.line_items, array['service_period']) is distinct from
         case when i.line_items is distinct from b.line_items then b.line_items else public.r2768_lines_without(b.line_items, array['service_period']) end;
  if v_bad > 0 then raise exception 'CHECK FAILED: % invoices changed beyond the stored period', v_bad; end if;
  -- quotes: only notes; link unchanged on every quote; no id for the customer on rewritten ones
  select count(*) into v_bad from r2768_q_before b join public.quotes q on q.id = b.id
   where (to_jsonb(q) - 'notes') is distinct from b.row
      or lower((regexp_match(q.notes, 'subscription ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'i'))[1]) is distinct from b.link_ts
      or substring(q.notes from 'subscription ([0-9a-fA-F-]{36})') is distinct from b.link_sql;
  if v_bad > 0 then raise exception 'CHECK FAILED: % quotes changed beyond notes or their subscription link moved', v_bad; end if;
  select count(*) into v_bad from public.r2768_repair_log g join r2768_runs u on (u.result->>'run_id')::uuid = g.run_id
   where g.repair = 'B' and split_part(g.after #>> '{}', 'Staff only (not shown to the customer):', 1)
                            ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if v_bad > 0 then raise exception 'CHECK FAILED: % rewritten quotes still show an id to the customer', v_bad; end if;
  -- idempotent
  a := public.r2768_repair_invoice_line_periods(true);
  b := public.r2768_repair_quote_notes(true);
  if (a->>'changed')::int <> 0 or (b->>'changed')::int <> 0 then
    raise exception 'CHECK FAILED: a second run changed % invoices / % quotes', a->>'changed', b->>'changed';
  end if;
  if coalesce(current_setting('app.r2768_repair', true), '') <> '' then raise exception 'CHECK FAILED: repair flag left on'; end if;
  raise notice 'ALL CHECKS PASSED';
end $$;

\if :apply
  commit;
  \echo '=== APPLIED (committed). Undo with: select public.r2768_undo(''<run_id from section 2>''); ==='
\else
  rollback;
  \echo '=== DRY RUN — rolled back, nothing changed. To apply: run it again with -v apply=1 (in psql: set the variable apply to 1 first). ==='
\endif
