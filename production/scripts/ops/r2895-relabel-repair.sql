-- R-2895 — DATA REPAIR (owner-delegated, Pardeep 17 Nov 2026: "jo tumhe thik lage wo karo" + coordinator
-- recommendation; the owner sees the READ-ONLY report r2895-relabel-report.sql FIRST).
--   Old part proformas that are still UNPAID, not invoiced, not cancelled and open say "Advance payment for month 1 · …".
--   R-2865 made new ones say "Payment for month 1 · …". This relabels the old open ones — the line TEXT (name /
--   description) and the same words at the start of the notes. Nothing else: amounts, GST, seats, periods, dates,
--   ids, links, numbers, status and updated_at stay exactly as they are. Paid / part-paid / invoiced / cancelled /
--   closed documents are never touched.
--
-- !! On staging / live this is run by the manager or Pardeep (repo rule R-2539 / R-2570: Claude runs data repairs
-- !! only on the local Docker DB). The deploy-db step must have applied migration
-- !! 20261117050700_r2895_relabel_old_part_proformas.sql first — it only installs the tools (no data change).
--
-- !! If it stops with an error, type  rollback;  before anything else (the transaction is still open in an
-- !! interactive psql session; nothing is kept until a commit).
--
-- SAFE BY DEFAULT: without -v apply=1 it runs the repair inside one transaction, prints the counts, the list and the
-- checks, then ROLLS BACK (a dry run). With -v apply=1 it COMMITS — and ONLY with  -v expect=<N>  where N is the
-- "WILL CHANGE" count of the report you saw. If the number is different now (one became paid / invoiced / cancelled
-- since), it stops and keeps nothing: read the report again.
--   -v notes=0   leave the notes alone (relabel the lines only). Default 1: lines + the notes lead.
--
-- CHECKS (same transaction, before commit; any failure raises and nothing is kept):
--   * every column of every quote except line_items / notes is identical (amount, GST, seats, dates, status, links,
--     updated_at ...); per company the quote count, Σ amount, Σ subtotal unchanged
--   * on a changed quote every line differs ONLY in name / description, same number of lines
--   * no paid / part-paid / invoiced / cancelled / closed quote changed
--   * a second run changes 0 rows
-- Every change is logged in public.r2895_repair_log (before / after, who, when, run_id).
-- UNDO (puts the old text back, only where the row still holds exactly what the repair wrote):
--     select public.r2895_undo('<run_id printed below>');
--
-- HOW (Run button): C:/Users/mso50/Anutech-HQ/drafts/r2895/apply-r2895-repair.ps1  (tunnel + password typed by you)
--   Local Docker:
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 [-v apply=1 -v expect=11] < scripts/ops/r2895-relabel-repair.sql

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif
\if :{?expect}
\else
  \set expect ''
\endif
\if :{?notes}
\else
  \set notes 1
\endif
\pset footer on
\pset null '·'

begin;

-- psql variables are not expanded inside $$ blocks: carry them in a temp table
create temp table r2895_cfg on commit drop as
  select :'apply'::text as apply, nullif(:'expect', '')::text as expect, :'notes'::text as notes;

\echo
\echo '=== 0. Login check: tenants_visible should equal the number of companies; bypasses_row_security should be t ==='
select current_user as login,
       (select r.rolbypassrls from pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants) as tenants_visible,
       :'apply' as apply, nullif(:'expect', '') as expect, :'notes' as notes,
       now() at time zone 'Asia/Kolkata' as run_at_ist;

do $$
begin
  -- Row security would hide other companies' rows and the run would "pass" having changed nothing.
  if not exists (select 1 from pg_roles r
                  where r.rolname = current_user
                    and (r.rolsuper or r.rolbypassrls
                         or pg_has_role(current_user, (select c.relowner from pg_class c where c.oid = 'public.quotes'::regclass), 'MEMBER'))) then
    raise exception 'This login (%) is subject to row security on quotes — connect as the migration login (resellersos_migration). Nothing changed.', current_user;
  end if;
  if to_regprocedure('public.r2895_repair(boolean,integer,boolean)') is null
     or to_regprocedure('public.r2895_undo(uuid)') is null
     or to_regclass('public.r2895_repair_log') is null then
    raise exception 'Migration 20261117050700 (R-2895) is not on this database — run the deploy-db step first. Nothing changed.';
  end if;
  if (select apply from r2895_cfg) = '1' and (select expect from r2895_cfg) is null then
    raise exception 'apply=1 needs  -v expect=<N>  — the "WILL CHANGE" number of the report you saw. Nothing changed.';
  end if;
end $$;

-- ── before ─────────────────────────────────────────────────────────────
create temp table r2895_before on commit drop as
  select q.id, q.tenant_id, to_jsonb(q) - 'line_items' - 'notes' as rowx, q.line_items, q.notes,
         q.status::text as status, q.payment_status::text as pay
    from public.quotes q;
create temp table r2895_totals_before on commit drop as
  select tenant_id, count(*) as n, sum(amount) as amount, sum(subtotal) as subtotal from public.quotes group by tenant_id;

\echo
\echo '=== 1. Plan (what would change, per bucket) ==='
select public.r2895_repair(false, null, :'notes' = '1') as plan;

\echo
\echo '=== 2. Run the repair (inside this transaction) ==='
create temp table r2895_run on commit drop as
  select public.r2895_repair(true, nullif(:'expect', '')::int, :'notes' = '1') as result;
select result->>'run_id' as run_id, result->>'changed' as changed, result->'plan' as plan from r2895_run;

\echo
\echo '=== 3. Per company: proformas relabelled ==='
select t.name as company, count(*) as relabelled
  from public.r2895_repair_log g join r2895_run u on (u.result->>'run_id')::uuid = g.run_id
  join public.tenants t on t.id = g.tenant_id
 group by t.name order by t.name;

\echo
\echo '=== 4. Every relabelled proforma: old -> new text ==='
select g.quote_id as quote_no,
       (select coalesce(case when (l ->> 'name') like 'Advance payment for%' then l ->> 'name' end, l ->> 'description')
          from jsonb_array_elements(g.before_lines) with ordinality e(l, i)
         where (l ->> 'name') like 'Advance payment for%' or (l ->> 'description') like 'Advance payment for%' order by i limit 1) as old_text,
       (select case when (l ->> 'name') like 'Payment for%' then l ->> 'name' else l ->> 'description' end
          from jsonb_array_elements(g.after_lines) with ordinality e(l, i)
         where (l ->> 'name') like 'Payment for%' or (l ->> 'description') like 'Payment for%' order by i limit 1) as new_text,
       g.before_notes is distinct from g.after_notes as notes_changed
  from public.r2895_repair_log g join r2895_run u on (u.result->>'run_id')::uuid = g.run_id
 order by g.quote_id;

\echo
\echo '=== 5. Checks (any failure raises: nothing is kept) ==='
do $$
declare v_bad int; v_second jsonb;
begin
  -- every column but line_items / notes identical on every quote (updated_at too)
  select count(*) into v_bad from r2895_before b join public.quotes q on q.id = b.id
   where (to_jsonb(q) - 'line_items' - 'notes') is distinct from b.rowx;
  if v_bad > 0 then raise exception 'CHECK FAILED: % quotes changed in a column other than line_items / notes', v_bad; end if;
  select count(*) into v_bad from (
    select tenant_id, count(*) as n, sum(amount) as amount, sum(subtotal) as subtotal from public.quotes group by tenant_id
    except select * from r2895_totals_before) x;
  if v_bad > 0 then raise exception 'CHECK FAILED: quote totals changed for % companies', v_bad; end if;
  -- changed quotes: same line count, every line differs only in name / description
  select count(*) into v_bad from r2895_before b join public.quotes q on q.id = b.id
   where (q.line_items is distinct from b.line_items)
     and (jsonb_array_length(q.line_items) <> jsonb_array_length(b.line_items)
          or exists (select 1 from jsonb_array_elements(b.line_items) with ordinality o(x, i)
                       join jsonb_array_elements(q.line_items) with ordinality n(x, i) using (i)
                      where (o.x - 'name' - 'description') is distinct from (n.x - 'name' - 'description')));
  if v_bad > 0 then raise exception 'CHECK FAILED: % quotes changed beyond the line name / description', v_bad; end if;
  -- only unpaid / open ones changed
  select count(*) into v_bad from r2895_before b join public.quotes q on q.id = b.id
   where (q.line_items is distinct from b.line_items or q.notes is distinct from b.notes)
     and (b.pay not in ('none', 'awaiting') or b.status not in ('sent', 'viewed', 'accepted')
          or exists (select 1 from public.quotes x where x.id = b.id and (x.invoice_id is not null or x.cancelled_at is not null or x.cancelled_part_billing_id is not null)));
  if v_bad > 0 then raise exception 'CHECK FAILED: % paid / invoiced / cancelled / closed quotes changed', v_bad; end if;
  -- idempotent
  v_second := public.r2895_repair(true, null, (select notes from r2895_cfg) = '1');
  if (v_second->>'changed')::int <> 0 then raise exception 'CHECK FAILED: a second run changed % rows', v_second->>'changed'; end if;
  raise notice 'All checks passed.';
end $$;

\if :apply
  \echo
  \echo '=== COMMIT — kept. To undo this run:  select public.r2895_undo(''<run_id from section 2>''); ==='
  commit;
\else
  \echo
  \echo '=== DRY RUN — nothing was kept (rolled back). To apply: -v apply=1 -v expect=<WILL CHANGE count from the report> ==='
  rollback;
\endif
