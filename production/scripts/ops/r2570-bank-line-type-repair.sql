-- R-2570 — DATA REPAIR (old rows): give each bank line still stored as matched_to_type 'manual' that
-- has exactly one real booking its own type + id — the same values the writers store since migration
-- 20261107165630. 7 Nov 2026.
--
-- !! Run ONLY with Pardeep's yes for that database (data repair on staging / live). Claude runs it
-- !! only on the local Docker DB (tests). Read the report first: r2570-bank-line-type-report.sql.
--
-- SAFE BY DEFAULT: without -v apply=1 it does everything inside one transaction, prints what it
-- would change, and ROLLS BACK. With -v apply=1 it COMMITS.
--
-- WHAT IT CHANGES (nothing about money — no amount, date, account or booking row changes):
--   * bank_transactions.matched_to_type / matched_to_id of the planned lines (see the plan's rules);
--   * emi_payments.bank_txn_id for an old "EMI: <purchase>" line matched by its words (as
--     record_emi_payment now stores it, so Undo EMI removes the line).
-- WHAT IT LEAVES 'manual': a real "Mark reconciled manually", old staff-loan lines known only by
--   their words, owed-back / reimbursement lines (changing their type would fire the staff-advance
--   unmatch trigger), a line with two possible bookings, a note or a reversal pair, a receipt or a
--   settlement on it. bank_line_bookings() keeps reading all of those as before.
-- AFTER IT: a Give loan / Add loan line it retypes can no longer be un-reconciled on the bank page
--   (the loan's own page deletes it, with its line) — the same as a line booked after R-2570.
--
-- HOW (after the report, with Pardeep's yes):
--   cd C:/Users/mso50/new-reselleros/production
--   STAGING: gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   dry run:  \i scripts/ops/r2570-bank-line-type-repair.sql
--   apply:    \set apply 1
--             \i scripts/ops/r2570-bank-line-type-repair.sql
--   Local Docker:
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 [-v apply=1] < scripts/ops/r2570-bank-line-type-repair.sql

\set ON_ERROR_STOP on
begin;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'bank_transactions_matched_to_type_check'
                    and pg_get_constraintdef(oid) like '%employee_loan%') then
    raise exception 'Migration 20261107165630 (R-2570) is not on this database — run the deploy-db step first. Nothing changed.';
  end if;
end $$;

create temp table r2570_plan on commit drop as
  -- R2570-PLAN-BEGIN (same text in r2570-bank-line-type-report.sql and -repair.sql; a test keeps them equal)
  with m as (
    select t.id, t.tenant_id, t.bank_account_id, t.txn_date, t.description, t.debit, t.credit
      from public.bank_transactions t
     where t.matched_to_type = 'manual' and t.matched_to_id is null
  ), cand as (
    select m.id, m.tenant_id, 'bs_item'::text as typ, b.id::text as tid, 'Balance sheet (Loan / advance, capital, director loan)'::text as rule, m.debit, m.credit
      from m join public.balance_sheet_items b on b.bank_txn_id = m.id and b.tenant_id = m.tenant_id
    union all
    select m.id, m.tenant_id, 'employee_loan', e.id::text, 'Staff loan / advance payout', m.debit, m.credit
      from m join public.employee_loans e on e.bank_txn_id = m.id and e.tenant_id = m.tenant_id
    union all
    select m.id, m.tenant_id, 'loan_given', g.id::text, 'Loan given payout', m.debit, m.credit
      from m join public.loans_given g on g.bank_txn_id = m.id and g.tenant_id = m.tenant_id
    union all
    select m.id, m.tenant_id, 'loan_given', r.id::text, 'Loan given receipt', m.debit, m.credit
      from m join public.loan_repayments r on r.bank_txn_id = m.id and r.tenant_id = m.tenant_id
    union all
    select m.id, m.tenant_id, 'business_loan', bl.id::text, 'Business loan money in', m.debit, m.credit
      from m join public.business_loans bl on bl.disbursal_bank_txn_id = m.id and bl.tenant_id = m.tenant_id
    union all
    select m.id, m.tenant_id, 'loan_repayment', p.id::text, 'Business loan EMI', m.debit, m.credit
      from m join public.business_loan_payments p on p.bank_txn_id = m.id and p.tenant_id = m.tenant_id
    union all
    /* record_loan_emi's own line ("Loan EMI: <lender>") — the payment never pointed back at it. */
    select m.id, m.tenant_id, 'loan_repayment', p.id::text, 'Business loan EMI (by its line words)', m.debit, m.credit
      from m join public.business_loan_payments p
        on p.bank_txn_id is null and p.tenant_id = m.tenant_id and p.bank_account_id = m.bank_account_id
       and p.paid_on = m.txn_date and p.amount = m.debit and m.credit = 0
      join public.business_loans bl on bl.id = p.loan_id and m.description = 'Loan EMI: ' || bl.lender
    union all
    select m.id, m.tenant_id, 'loan_drawdown', d.id::text, 'Credit line drawdown', m.debit, m.credit
      from m join public.business_loan_drawdowns d on d.bank_txn_id = m.id and d.tenant_id = m.tenant_id
    union all
    select m.id, m.tenant_id, 'emi', ep.id::text, 'Asset EMI', m.debit, m.credit
      from m join public.emi_payments ep on ep.bank_txn_id = m.id and ep.tenant_id = m.tenant_id
    union all
    /* record_emi_payment's own line ("EMI: <purchase>") — the payment never pointed back at it. */
    select m.id, m.tenant_id, 'emi', ep.id::text, 'Asset EMI (by its line words)', m.debit, m.credit
      from m join public.emi_payments ep
        on ep.bank_txn_id is null and ep.tenant_id = m.tenant_id and ep.bank_account_id = m.bank_account_id
       and ep.paid_on = m.txn_date and ep.amount = m.debit and m.credit = 0
      join public.emi_purchases pu on pu.id = ep.purchase_id and m.description = 'EMI: ' || pu.name
    union all
    select m.id, m.tenant_id, 'statutory', s.id::text, 'Statutory challan', m.debit, m.credit
      from m join public.statutory_dues_payments s on s.bank_txn_id = m.id and s.tenant_id = m.tenant_id
    union all
    /* pay_statutory_dues' own line — matched by its exact words, date, amount and account. */
    select m.id, m.tenant_id, 'statutory', s.id::text, 'Statutory challan (by its line words)', m.debit, m.credit
      from m join public.statutory_dues_payments s
        on s.bank_txn_id is null and s.tenant_id = m.tenant_id and s.bank_account_id = m.bank_account_id
       and s.paid_on = m.txn_date and s.amount = m.debit and m.credit = 0
       and m.description = 'Statutory dues paid (' || s.kind || ')'
                           || case when s.challan_no is not null then ' · challan ' || s.challan_no else '' end
  ), plan as (
    /* Only a line with exactly ONE candidate, whose record no other line claims, and that nothing
       else hangs on: a note / reversal pair (changing the type clears them — R-2361), a receipt,
       a Razorpay settlement or a staff-advance link (their unmatch triggers would act). */
    select c.* from cand c
     where (select count(*) from cand c2 where c2.id = c.id) = 1
       and (select count(*) from cand c3 where c3.typ = c.typ and c3.tid = c.tid) = 1
       and not exists (select 1 from public.bank_transactions t where t.id = c.id and (t.reconcile_note is not null or t.reversal_of is not null))
       and not exists (select 1 from public.bank_transactions t where t.reversal_of = c.id)
       and not exists (select 1 from public.payments p where p.bank_txn_id = c.id)
       and not exists (select 1 from public.razorpay_settlement_recons z where z.bank_txn_id = c.id)
       and not exists (select 1 from public.employee_advance_bank_links k where k.bank_txn_id = c.id)
  )
  -- R2570-PLAN-END
select * from plan;

\echo 'R-2570 repair — lines per type and rule:'
select typ, rule, count(*) as lines from r2570_plan group by typ, rule order by typ, rule;

update public.emi_payments ep
   set bank_txn_id = p.id
  from r2570_plan p
 where p.rule = 'Asset EMI (by its line words)' and ep.id::text = p.tid and ep.bank_txn_id is null;

with done as (
  update public.bank_transactions t
     set matched_to_type = p.typ, matched_to_id = p.tid, updated_at = now()
    from r2570_plan p
   where t.id = p.id and t.matched_to_type = 'manual' and t.matched_to_id is null
  returning t.id
)
select count(*) as lines_retyped from done;

\if :{?apply}
  \echo 'apply=1 → COMMIT'
  commit;
\else
  \echo 'Dry run (no -v apply=1) → ROLLBACK, nothing changed'
  rollback;
\endif
