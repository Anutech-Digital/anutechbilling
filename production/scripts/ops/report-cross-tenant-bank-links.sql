-- R-2479 — READ-ONLY report: bank lines already linked to ANOTHER company's record (4 Nov 2026).
--
-- WHY: R-2472 proved that, from R-718 until R-2472 (migration 20261104090200), a login could link
-- its own bank line to another company's payment / expense / project receipt / salary / bank line
-- (reconcile_bank_txn, or a plain UPDATE of its own line — RLS allows that), and the salary trigger
-- (sync_salary_paid_status, which found a 'salary' line's salary by id alone) then marked the other
-- company's salary paid. R-2472 closed it for new writes; this report says whether existing data on
-- staging / live already holds such a link. Repairing a row is Pardeep's decision.
--
-- WHAT IT IS: three SELECTs. It changes NOTHING — the whole file runs inside
-- `begin; set transaction read only; … rollback;`, so even a mistake cannot write. Output = ids,
-- tenant ids, dates, amounts and the match type only (no names, no descriptions, no contacts).
--
-- WHO RUNS IT: Pardeep (DB step). Claude does not run it on staging or live.
-- HOW: docs/playbooks/cross-tenant-bank-links.md (exact commands for staging, live and local).
--
-- Works WITHOUT R-2472's helpers (bank_match_target_tenant / bank_match_uuid) — e.g. on live before
-- the deploy that carries R-2472: the match-type → table map is inlined below (same as R-2472's
-- bank_match_target_tenant). Each table's check is built from the catalog and run through
-- query_to_xml (read-only; table / column names come from the catalog or the fixed lists below and
-- are quoted with %I / %L), so a table the DB does not have is skipped — section 0b lists every
-- skipped check and every table where row security could hide rows from this login.
-- Only tables whose primary key is a single `id` column (uuid or text) with a `tenant_id` are read,
-- so an id names exactly one record.
--
-- SECTIONS of part 1 (column `section`; 0 rows in total = clean):
--   A forward   bank_transactions.matched_to_type / matched_to_id point at a record of ANOTHER company
--               — R-2472's types: payment, expense, vendor_bill, project, salary, transfer (= other
--               bank line), other_income, loan_given, business_loan, loan_drawdown, loan_repayment.
--   B reverse   a record that points at a bank line of ANOTHER company: every foreign key to
--               bank_transactions (payments.bank_txn_id — split receipts —, project_payments,
--               prepaid, tax, statutory, owner equity, EMI, loans, reversal_of, quotes, …) plus the
--               links that have no foreign key (expenses / salary_payments.reconciled_txn_id).
--   C salary    a salary of another company whose paid status came from this line: the line is
--               matched to it as 'salary' (the trigger found it by id alone before R-2472), or the
--               salary's reconciled_txn_id is this line. (The trigger's 'expense' path was already
--               scoped to the line's company — baseline — so it is not listed.)
--   D other     a line of any OTHER match type (statutory, prepaid, owner_equity, vendor_payment, emi,
--               referral_commission, customer_refund, or anything newer) whose matched_to_id is the
--               id of another company's record in any table (R-2472's trigger leaves these types to
--               their own flows, so a plain UPDATE could still have set them before).
-- Columns: section, match_type (the line's matched_to_type; '·' = none), bank_txn_id,
--   line_tenant_id, txn_date, credit, debit, linked_table, linked_id, linked_tenant_id,
--   rows_in_section.

begin;
set transaction read only;

\pset footer on
\pset null '·'

-- ═══ 0. Who is reading ═══════════════════════════════════════════════════════════════════════
\echo
\echo '=== 0. Login check: tenants_visible should equal the number of companies ==='
select current_user                                                         as login,
       (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants)                                 as tenants_visible,
       (select count(*) from public.bank_transactions)                       as bank_lines_visible,
       now() at time zone 'Asia/Kolkata'                                     as run_at_ist;

-- ═══ 0b. What was checked ════════════════════════════════════════════════════════════════════
\echo
\echo '=== 0b. Checks skipped (table not on this DB) or tables where row security may hide rows — 0 rows = every check ran on every row ==='
with
-- MAPS BEGIN (same block in 0b and 1 — tests/ops/report-cross-tenant-bank-links.test.ts checks)
/* R-2472 bank_match_target_tenant, inlined: match type → the table its matched_to_id points at. */
forward_map(match_type, target_table) as (values
  ('payment', 'payments'),
  ('expense', 'expenses'),
  ('vendor_bill', 'vendor_bills'),
  ('project', 'project_payments'),
  ('salary', 'salary_payments'),
  ('transfer', 'bank_transactions'),
  ('other_income', 'other_incomes'),
  ('loan_given', 'loan_repayments'),
  ('loan_given', 'loans_given'),
  ('business_loan', 'business_loans'),
  ('loan_drawdown', 'business_loan_drawdowns'),
  ('loan_repayment', 'business_loan_payments')
),
/* Links back to a bank line; the foreign keys are also found from the catalog (fk_cols). */
reverse_list(source_table, link_column) as (values
  ('payments', 'bank_txn_id'),
  ('project_payments', 'bank_txn_id'),
  ('expenses', 'reconciled_txn_id'),
  ('salary_payments', 'reconciled_txn_id'),
  ('prepaid_advances', 'bank_txn_id'),
  ('tax_payments', 'bank_txn_id'),
  ('statutory_dues_payments', 'bank_txn_id'),
  ('balance_sheet_items', 'bank_txn_id'),
  ('bank_vendor_payment_lines', 'bank_txn_id'),
  ('bank_customer_refunds', 'bank_txn_id'),
  ('bank_receipt_round_offs', 'bank_txn_id'),
  ('owner_equity_movements', 'bank_txn_id'),
  ('emi_payments', 'bank_txn_id'),
  ('other_incomes', 'bank_txn_id'),
  ('loans_given', 'bank_txn_id'),
  ('loan_repayments', 'bank_txn_id'),
  ('business_loan_drawdowns', 'bank_txn_id'),
  ('business_loan_payments', 'bank_txn_id'),
  ('employee_loans', 'bank_txn_id'),
  ('employee_advance_bank_links', 'bank_txn_id'),
  ('razorpay_settlement_recons', 'bank_txn_id')
),
me as (
  select r.rolsuper or r.rolbypassrls as bypass from pg_catalog.pg_roles r where r.rolname = current_user
),
/* Public tables keyed by a single `id` (uuid or text) that carry a uuid tenant_id. */
tbl as (
  select c.oid as relid, c.relname::text as tbl, ida.atttypid = 'uuid'::regtype as id_is_uuid,
         c.relrowsecurity
           and not (select bypass from me)
           and (c.relforcerowsecurity or not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')) as may_hide_rows
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_catalog.pg_attribute ida on ida.attrelid = c.oid and ida.attname = 'id' and not ida.attisdropped
                                    and ida.atttypid in ('uuid'::regtype, 'text'::regtype)
    join pg_catalog.pg_attribute tna on tna.attrelid = c.oid and tna.attname = 'tenant_id' and not tna.attisdropped
                                    and tna.atttypid = 'uuid'::regtype
    join pg_catalog.pg_index pk on pk.indrelid = c.oid and pk.indisprimary and pk.indnatts = 1 and pk.indkey[0] = ida.attnum
   where c.relkind in ('r', 'p')
),
/* Every single-column foreign key to bank_transactions(id) from a public table. */
fk_cols as (
  select cl.relname::text as source_table, a.attname::text as link_column
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class cl on cl.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
    join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
   where k.contype = 'f' and k.confrelid = to_regclass('public.bank_transactions')
     and cardinality(k.conkey) = 1
),
reverse_map as (
  select source_table, link_column from reverse_list
  union
  select source_table, link_column from fk_cols
),
/* The link column, if it exists as uuid. */
link_ok as (
  select r.source_table, r.link_column
    from reverse_map r
    join tbl s on s.tbl = r.source_table
    join pg_catalog.pg_attribute a on a.attrelid = s.relid and a.attname = r.link_column
                                  and not a.attisdropped and a.atttypid = 'uuid'::regtype
)
-- MAPS END
select check_kind, table_name, detail, ran, may_hide_rows from (
  select 'A forward'::text as check_kind, f.target_table as table_name, f.match_type as detail,
         (t.tbl is not null) as ran, coalesce(t.may_hide_rows, false) as may_hide_rows
    from forward_map f left join tbl t on t.tbl = f.target_table
  union all
  select 'B reverse', r.source_table, r.link_column,
         (l.source_table is not null), coalesce(t.may_hide_rows, false)
    from reverse_map r
    left join link_ok l on l.source_table = r.source_table and l.link_column = r.link_column
    left join tbl t on t.tbl = r.source_table
  union all
  select 'D any table', t.tbl, 'row security', true, t.may_hide_rows
    from tbl t
) k
 where not ran or may_hide_rows
 order by 1, 2, 3;

-- ═══ 1. Cross-company links ═══════════════════════════════════════════════════════════════════
\echo
\echo '=== 1. R-2479: bank lines linked to another company''s record (0 rows = clean) ==='
with
-- MAPS BEGIN (same block in 0b and 1 — tests/ops/report-cross-tenant-bank-links.test.ts checks)
/* R-2472 bank_match_target_tenant, inlined: match type → the table its matched_to_id points at. */
forward_map(match_type, target_table) as (values
  ('payment', 'payments'),
  ('expense', 'expenses'),
  ('vendor_bill', 'vendor_bills'),
  ('project', 'project_payments'),
  ('salary', 'salary_payments'),
  ('transfer', 'bank_transactions'),
  ('other_income', 'other_incomes'),
  ('loan_given', 'loan_repayments'),
  ('loan_given', 'loans_given'),
  ('business_loan', 'business_loans'),
  ('loan_drawdown', 'business_loan_drawdowns'),
  ('loan_repayment', 'business_loan_payments')
),
/* Links back to a bank line; the foreign keys are also found from the catalog (fk_cols). */
reverse_list(source_table, link_column) as (values
  ('payments', 'bank_txn_id'),
  ('project_payments', 'bank_txn_id'),
  ('expenses', 'reconciled_txn_id'),
  ('salary_payments', 'reconciled_txn_id'),
  ('prepaid_advances', 'bank_txn_id'),
  ('tax_payments', 'bank_txn_id'),
  ('statutory_dues_payments', 'bank_txn_id'),
  ('balance_sheet_items', 'bank_txn_id'),
  ('bank_vendor_payment_lines', 'bank_txn_id'),
  ('bank_customer_refunds', 'bank_txn_id'),
  ('bank_receipt_round_offs', 'bank_txn_id'),
  ('owner_equity_movements', 'bank_txn_id'),
  ('emi_payments', 'bank_txn_id'),
  ('other_incomes', 'bank_txn_id'),
  ('loans_given', 'bank_txn_id'),
  ('loan_repayments', 'bank_txn_id'),
  ('business_loan_drawdowns', 'bank_txn_id'),
  ('business_loan_payments', 'bank_txn_id'),
  ('employee_loans', 'bank_txn_id'),
  ('employee_advance_bank_links', 'bank_txn_id'),
  ('razorpay_settlement_recons', 'bank_txn_id')
),
me as (
  select r.rolsuper or r.rolbypassrls as bypass from pg_catalog.pg_roles r where r.rolname = current_user
),
/* Public tables keyed by a single `id` (uuid or text) that carry a uuid tenant_id. */
tbl as (
  select c.oid as relid, c.relname::text as tbl, ida.atttypid = 'uuid'::regtype as id_is_uuid,
         c.relrowsecurity
           and not (select bypass from me)
           and (c.relforcerowsecurity or not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')) as may_hide_rows
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_catalog.pg_attribute ida on ida.attrelid = c.oid and ida.attname = 'id' and not ida.attisdropped
                                    and ida.atttypid in ('uuid'::regtype, 'text'::regtype)
    join pg_catalog.pg_attribute tna on tna.attrelid = c.oid and tna.attname = 'tenant_id' and not tna.attisdropped
                                    and tna.atttypid = 'uuid'::regtype
    join pg_catalog.pg_index pk on pk.indrelid = c.oid and pk.indisprimary and pk.indnatts = 1 and pk.indkey[0] = ida.attnum
   where c.relkind in ('r', 'p')
),
/* Every single-column foreign key to bank_transactions(id) from a public table. */
fk_cols as (
  select cl.relname::text as source_table, a.attname::text as link_column
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class cl on cl.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
    join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
   where k.contype = 'f' and k.confrelid = to_regclass('public.bank_transactions')
     and cardinality(k.conkey) = 1
),
reverse_map as (
  select source_table, link_column from reverse_list
  union
  select source_table, link_column from fk_cols
),
/* The link column, if it exists as uuid. */
link_ok as (
  select r.source_table, r.link_column
    from reverse_map r
    join tbl s on s.tbl = r.source_table
    join pg_catalog.pg_attribute a on a.attrelid = s.relid and a.attname = r.link_column
                                  and not a.attisdropped and a.atttypid = 'uuid'::regtype
)
-- MAPS END
,
/* matched_to_id → the record's id: a uuid id through a regex-guarded cast (uses the primary key
   index; a non-uuid text finds nothing instead of failing), a text id exactly. */
id_expr as (
  select t.tbl, t.id_is_uuid,
         case when t.id_is_uuid
              then $e$case when t.matched_to_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then t.matched_to_id::uuid end$e$
              else 't.matched_to_id' end as expr
    from tbl t
),
checks as materialized (   -- materialized: each check runs once (inlined, the whole statement took 107 s locally)
  -- A: R-2472's types → their table.
  select 'A forward: line matched to another company''s record'::text as section, f.target_table as linked_table,
         format($q$
           select t.id as bank_txn_id, t.tenant_id as line_tenant_id, t.txn_date, t.credit, t.debit,
                  t.matched_to_type as match_type, x.id::text as linked_id, x.tenant_id as linked_tenant_id
             from public.bank_transactions t
             join public.%I x on x.id = %s
            where t.matched_to_type = %L
              and t.matched_to_id is not null
              and x.tenant_id is distinct from t.tenant_id
         $q$, f.target_table, e.expr, f.match_type) as q
    from forward_map f
    join id_expr e on e.tbl = f.target_table
  union all
  -- B: a record (any table) pointing at another company's bank line.
  select 'B reverse: another company''s record points at this line', l.source_table || '.' || l.link_column,
         format($q$
           select t.id as bank_txn_id, t.tenant_id as line_tenant_id, t.txn_date, t.credit, t.debit,
                  t.matched_to_type as match_type, x.id::text as linked_id, x.tenant_id as linked_tenant_id
             from public.%I x
             join public.bank_transactions t on t.id = x.%I
            where x.tenant_id is distinct from t.tenant_id
         $q$, l.source_table, l.link_column)
    from link_ok l
  union all
  -- D: any other match type with an id → another company's record in any table.
  select 'D other type: line matched to another company''s record', e.tbl,
         format($q$
           select t.id as bank_txn_id, t.tenant_id as line_tenant_id, t.txn_date, t.credit, t.debit,
                  t.matched_to_type as match_type, x.id::text as linked_id, x.tenant_id as linked_tenant_id
             from public.bank_transactions t
             join public.%I x on x.id = %s
            where t.matched_to_type is not null
              and t.matched_to_type <> all (%L::text[])
              and t.matched_to_id is not null
              and x.tenant_id is distinct from t.tenant_id
         $q$, e.tbl, e.expr,
              (select array_agg(distinct m) from (select match_type as m from forward_map
                                                  union select 'manual' union select 'split') k))
    from id_expr e
),
dynamic_rows as materialized (
  select c.section, x.match_type, x.bank_txn_id, x.line_tenant_id, x.txn_date, x.credit, x.debit,
         c.linked_table, x.linked_id, x.linked_tenant_id
    from checks c
    cross join lateral xmltable('/table/row' passing query_to_xml(c.q, false, false, '')
      columns bank_txn_id uuid, line_tenant_id uuid, txn_date date, credit bigint, debit bigint,
              match_type text, linked_id text, linked_tenant_id uuid) x
),
/* C: sync_salary_paid_status before R-2472 found a 'salary' line's salary by id alone (any
   company) and added the line's debit to it; reconciled_txn_id is the other trace it leaves. */
salary_rows as (
  select 'C salary: paid status from another company''s line'::text as section,
         t.matched_to_type as match_type, t.id as bank_txn_id, t.tenant_id as line_tenant_id,
         t.txn_date, t.credit::bigint as credit, t.debit::bigint as debit,
         'salary_payments'::text as linked_table, s.id::text as linked_id, s.tenant_id as linked_tenant_id
    from public.bank_transactions t
    join public.salary_payments s
      on s.id = case when t.matched_to_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then t.matched_to_id::uuid end
   where t.matched_to_type = 'salary'
     and t.tenant_id is distinct from s.tenant_id
  union
  select 'C salary: paid status from another company''s line', t.matched_to_type, t.id, t.tenant_id,
         t.txn_date, t.credit, t.debit, 'salary_payments', s.id::text, s.tenant_id
    from public.salary_payments s
    join public.bank_transactions t on t.id = s.reconciled_txn_id
   where t.tenant_id is distinct from s.tenant_id
),
found as (
  select * from dynamic_rows
  union all select * from salary_rows
)
select section, match_type, bank_txn_id, line_tenant_id, txn_date, credit, debit,
       linked_table, linked_id, linked_tenant_id,
       count(*) over (partition by section) as rows_in_section
  from found
 order by section, line_tenant_id, txn_date, bank_txn_id, linked_table, linked_id;

rollback;
