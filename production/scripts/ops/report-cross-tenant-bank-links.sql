-- R-2479 — READ-ONLY report: bank lines already linked to ANOTHER company's record (4 Nov 2026).
--
-- WHY: R-2472 proved that, from R-718 until R-2472 (migration 20261104090200), a login could link
-- its own bank line to another company's payment / expense / project receipt / salary / bank line
-- (reconcile_bank_txn, or a plain UPDATE of its own line), and the salary trigger then marked the
-- other company's salary paid. R-2472 closed it for new writes; this report says whether existing
-- data on staging / live already holds such a link. Repairing a row is Pardeep's decision.
--
-- WHAT IT IS: one SELECT (plus a login check). It changes NOTHING — the whole file runs inside
-- `begin; set transaction read only; … rollback;`, so even a mistake cannot write. Output = ids,
-- tenant ids, dates, amounts and the match type only (no names, no descriptions, no contacts).
--
-- WHO RUNS IT: Pardeep (DB step). Claude does not run it on staging or live.
-- HOW: docs/playbooks/cross-tenant-bank-links.md (exact commands for staging, live and local).
--
-- Works WITHOUT R-2472's helpers (bank_match_target_tenant / bank_match_uuid) — e.g. on live before
-- the deploy that carries R-2472: the match-type → table map is inlined below (same as R-2472's
-- bank_match_target_tenant). A table that does not exist on the DB is simply skipped (no table → no
-- record → no link); that is why each table's check is built from the lists below and run through
-- query_to_xml (read-only; the lists are fixed literals, quoted with %I / %L).
--
-- SECTIONS (column `section`; 0 rows in total = data is clean):
--   A forward   bank_transactions.matched_to_type / matched_to_id point at a record of ANOTHER company
--               (payment, expense, vendor_bill, project, salary, transfer = other bank line,
--               other_income, loan_given, business_loan, loan_drawdown, loan_repayment).
--   B reverse   a record that points at a bank line (payments.bank_txn_id — split lines too —,
--               expenses / salary_payments.reconciled_txn_id, project_payments.bank_txn_id, prepaid,
--               tax, statutory, owner equity, EMI, vendor payment lines, …) where that line belongs
--               to ANOTHER company.
--   C salary    a salary whose paid status came from another company's bank line: the line is
--               matched to it as 'salary', or as 'expense' to its expense (sync_salary_paid_status
--               before R-2472 looked the salary up by id alone), or the salary's reconciled_txn_id
--               is that line.
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
       (select r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants)                                 as tenants_visible,
       (select count(*) from public.bank_transactions)                       as bank_lines_visible,
       now() at time zone 'Asia/Kolkata'                                     as run_at_ist;

-- ═══ 1. Cross-company links ═══════════════════════════════════════════════════════════════════
\echo
\echo '=== 1. R-2479: bank lines linked to another company''s record (0 rows = clean) ==='
with
/* R-2472 bank_match_target_tenant, inlined: match type → the table its matched_to_id points at.
   uuid ids are compared as lower-case text (a uuid prints lower-case), text ids exactly. */
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
/* Every table that points back at a bank line (local schema, 4 Nov 2026). */
reverse_map(source_table, link_column) as (values
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
/* Columns that exist on THIS database (public tables only). */
cols as (
  select c.relname::text as tbl, a.attname::text as col, a.atttypid = 'uuid'::regtype as is_uuid
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where c.relkind in ('r', 'p')
),
forward_q as (
  select f.match_type, f.target_table,
         format($q$
           select t.id as bank_txn_id, t.tenant_id as line_tenant_id, t.txn_date, t.credit, t.debit,
                  x.id::text as linked_id, x.tenant_id as linked_tenant_id
             from public.bank_transactions t
             join public.%I x on x.id::text = %s
            where t.matched_to_type = %L
              and t.matched_to_id is not null
              and x.tenant_id is distinct from t.tenant_id
         $q$, f.target_table,
              case when idc.is_uuid then 'lower(t.matched_to_id)' else 't.matched_to_id' end,
              f.match_type) as q
    from forward_map f
    join cols idc on idc.tbl = f.target_table and idc.col = 'id'
    join cols tnc on tnc.tbl = f.target_table and tnc.col = 'tenant_id'
),
reverse_q as (
  select r.source_table, r.link_column,
         format($q$
           select t.id as bank_txn_id, t.tenant_id as line_tenant_id, t.txn_date, t.credit, t.debit,
                  t.matched_to_type as match_type, x.id::text as linked_id, x.tenant_id as linked_tenant_id
             from public.%I x
             join public.bank_transactions t on t.id = x.%I
            where x.tenant_id is distinct from t.tenant_id
         $q$, r.source_table, r.link_column) as q
    from reverse_map r
    join cols lnk on lnk.tbl = r.source_table and lnk.col = r.link_column and lnk.is_uuid
    join cols idc on idc.tbl = r.source_table and idc.col = 'id'
    join cols tnc on tnc.tbl = r.source_table and tnc.col = 'tenant_id'
),
forward_rows as (
  select 'A forward: line matched to another company''s record'::text as section,
         f.match_type, x.bank_txn_id, x.line_tenant_id, x.txn_date, x.credit, x.debit,
         f.target_table as linked_table, x.linked_id, x.linked_tenant_id
    from forward_q f
    cross join lateral xmltable('/table/row' passing query_to_xml(f.q, false, false, '')
      columns bank_txn_id uuid, line_tenant_id uuid, txn_date date, credit bigint, debit bigint,
              linked_id text, linked_tenant_id uuid) x
),
reverse_rows as (
  select 'B reverse: another company''s record points at this line'::text as section,
         x.match_type, x.bank_txn_id, x.line_tenant_id, x.txn_date, x.credit, x.debit,
         r.source_table || '.' || r.link_column as linked_table, x.linked_id, x.linked_tenant_id
    from reverse_q r
    cross join lateral xmltable('/table/row' passing query_to_xml(r.q, false, false, '')
      columns bank_txn_id uuid, line_tenant_id uuid, txn_date date, credit bigint, debit bigint,
              match_type text, linked_id text, linked_tenant_id uuid) x
),
/* sync_salary_paid_status before R-2472: a 'salary' line found the salary by id alone, an
   'expense' line by salary_payments.expense_id alone — in any company. */
salary_rows as (
  select 'C salary: paid status from another company''s line'::text as section,
         t.matched_to_type as match_type, t.id as bank_txn_id, t.tenant_id as line_tenant_id,
         t.txn_date, t.credit::bigint as credit, t.debit::bigint as debit,
         'salary_payments'::text as linked_table, s.id::text as linked_id, s.tenant_id as linked_tenant_id
    from public.salary_payments s
    join public.bank_transactions t
      on t.matched_to_type = 'salary' and lower(t.matched_to_id) = s.id::text
   where t.tenant_id is distinct from s.tenant_id
  union
  select 'C salary: paid status from another company''s line', t.matched_to_type, t.id, t.tenant_id,
         t.txn_date, t.credit, t.debit, 'salary_payments', s.id::text, s.tenant_id
    from public.salary_payments s
    join public.bank_transactions t
      on t.matched_to_type = 'expense' and t.matched_to_id = s.expense_id
   where t.tenant_id is distinct from s.tenant_id
  union
  select 'C salary: paid status from another company''s line', t.matched_to_type, t.id, t.tenant_id,
         t.txn_date, t.credit, t.debit, 'salary_payments', s.id::text, s.tenant_id
    from public.salary_payments s
    join public.bank_transactions t on t.id = s.reconciled_txn_id
   where t.tenant_id is distinct from s.tenant_id
),
found as (
  select * from forward_rows
  union all select * from reverse_rows
  union all select * from salary_rows
)
select section, match_type, bank_txn_id, line_tenant_id, txn_date, credit, debit,
       linked_table, linked_id, linked_tenant_id,
       count(*) over (partition by section) as rows_in_section
  from found
 order by section, line_tenant_id, txn_date, bank_txn_id, linked_table, linked_id;

rollback;
