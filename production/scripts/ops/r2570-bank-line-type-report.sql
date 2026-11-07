-- R-2570 — READ-ONLY report: bank lines still stored as matched_to_type 'manual' that have a real
-- booking, and the type + id the repair (r2570-bank-line-type-repair.sql) would give each. 7 Nov 2026.
--
-- WHY: until R-2570 the loan / advance / EMI / challan flows wrote their bank line as 'manual' with
-- no matched_to_id (R-2378 found the booking only when the bank page READS it). Lines booked after
-- migration 20261107165630 carry their own type; this report counts the OLD ones, per company.
--
-- WHAT IT IS: it changes NOTHING — one SELECT inside `begin; set transaction read only; … rollback;`.
-- Only company names, types, counts and rupee totals are printed (no email / phone / narration).
-- Whether to run the repair is Pardeep's decision.
--
-- SECTIONS (one table, column "section"):
--   0 · companies visible (login check — must equal the number of companies)
--   1 · will get its own type     — per company × type × rule: lines, money out, money in
--   2 · stays 'manual'            — per company × reason (old staff-loan words, owed back, a real
--                                   manual reconcile, a booking the repair leaves alone …)
--
-- WHO RUNS IT: the manager or Pardeep. Claude does not run it on staging or live.
-- HOW (same instances as production/supabase/cloudsql/{staging,live}/deploy-db-*.sh):
--   cd C:/Users/mso50/new-reselleros/production
--   STAGING: gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   then:  \o r2570-staging.txt
--          \i scripts/ops/r2570-bank-line-type-report.sql
--          \o
--   Local Docker (proves it runs):
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < scripts/ops/r2570-bank-line-type-report.sql

begin;
set transaction read only;

\pset footer on
\pset null '·'

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
  , left_manual as (
    select t.id, t.tenant_id, t.debit, t.credit,
           case
             when t.matched_to_id is not null then 'Owed back / reimbursement link (manual + id — the repair leaves it)'
             when exists (select 1 from cand c where c.id = t.id) then 'Has a booking, left alone (two candidates, a note, a reversal pair or a link)'
             when t.reconcile_note is not null then 'Mark reconciled manually, with a reason'
             when t.source = 'manual' and (t.description like 'Loan/advance to %' or t.description like 'Expense advance to %'
                                           or t.description like 'Correction: reversed loan/advance to %'
                                           or t.description like 'Loan repayment — %' or t.description like 'Advance returned — %')
               then 'Old staff-loan line (words only; the bank page still reads it)'
             else 'No booking found (a real manual reconcile)'
           end as reason
      from public.bank_transactions t
     where t.matched_to_type = 'manual'
       and not exists (select 1 from plan p where p.id = t.id)
  )
select '0 · companies visible' as section, null::text as company, null::text as kind,
       (select count(*) from public.tenants)::bigint as lines, null::numeric as money_out, null::numeric as money_in
union all
select '1 · will get its own type', tn.name, p.typ || ' — ' || p.rule, count(*), sum(p.debit), sum(p.credit)
  from plan p join public.tenants tn on tn.id = p.tenant_id
 group by tn.name, p.typ, p.rule
union all
select '2 · stays manual', tn.name, l.reason, count(*), sum(l.debit), sum(l.credit)
  from left_manual l join public.tenants tn on tn.id = l.tenant_id
 group by tn.name, l.reason
order by 1, 2 nulls first, 3;

rollback;
