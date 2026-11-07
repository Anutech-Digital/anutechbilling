-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_line_bookings(uuid)') and prosrc like '%R-2378%')
-- deploy-key: r2378banklinebookings
--
-- R-2378 (7 Nov 2026, G-RECON; found in the 2 Nov OD/loan audit) — a bank line booked through
-- Reconcile → Loan / EMI → "Loan / advance with a person" (book_bank_advance) or "Owner's capital /
-- Director's loan" (book_bank_credit) is stored as matched_to_type = 'manual' with no matched_to_id;
-- the real booking is a balance_sheet_items row pointing back at the line (bank_txn_id). The bank
-- page and its data read such a line as "reconciled manually, no entry", so the audit took 8
-- Bajaj / Tata loan lines for unbooked ones. The same holds for every app flow that writes its own
-- cash line as 'manual' and keeps the link on its own table (staff loans, loans given and their
-- repayments, business loans + EMIs + drawdowns, asset EMIs + down payments, staff advance
-- returns / reimbursements, statutory challans).
--
-- ─── WHAT THIS ADDS ─────────────────────────────────────────────────────────────────────────────
--   bank_line_bookings(p_bank_account_id) — read only, SECURITY INVOKER (RLS of every table applies,
--   so it shows only the caller's tenant). One row per 'manual' line of that account that HAS a real
--   booking: (txn_id, source, sub, party, amount). The app turns it into "Loan received · Bajaj
--   Finance" + a link (src/lib/banking/line-booking.ts). A 'manual' line with no booking (a real
--   "Mark reconciled manually" with its reason) returns nothing and keeps reading "Reconciled".
--   No write, no data change — existing lines (the 8 audit lines too) read right at once.
-- Test: supabase/tests/r2378_bank_line_bookings.test.sql (begin … rollback; red without this file).

begin;

create or replace function public.bank_line_bookings(p_bank_account_id uuid)
returns table (txn_id uuid, source text, sub text, party text, amount numeric)
language sql
stable
security invoker
set search_path to 'public'
as $function$
  /* R-2378: what a matched_to_type = 'manual' line really booked. First match per line wins. */
  with lines as (
    select t.id
      from public.bank_transactions t
     where t.bank_account_id = p_bank_account_id
       and t.matched_to_type = 'manual'
  ), found as (
    select b.bank_txn_id as txn_id, 1 as pri, 'bs_item'::text as source, b.section as sub, b.label as party, b.amount::numeric as amount
      from public.balance_sheet_items b join lines l on l.id = b.bank_txn_id
    union all
    select e.bank_txn_id, 2, 'employee_loan', e.kind, e.employee_name, e.principal::numeric
      from public.employee_loans e join lines l on l.id = e.bank_txn_id
    union all
    select g.bank_txn_id, 3, 'loan_given', g.borrower_type, g.borrower_name, g.principal::numeric
      from public.loans_given g join lines l on l.id = g.bank_txn_id
    union all
    select r.bank_txn_id, 4, 'loan_given_repayment', r.mode, g.borrower_name, r.amount::numeric
      from public.loan_repayments r join lines l on l.id = r.bank_txn_id
      join public.loans_given g on g.id = r.loan_id
    union all
    select bl.disbursal_bank_txn_id, 5, 'business_loan', bl.kind, bl.lender, bl.principal::numeric
      from public.business_loans bl join lines l on l.id = bl.disbursal_bank_txn_id
    union all
    select p.bank_txn_id, 6, 'business_loan_payment', bl.kind, bl.lender, p.amount::numeric
      from public.business_loan_payments p join lines l on l.id = p.bank_txn_id
      join public.business_loans bl on bl.id = p.loan_id
    union all
    select d.bank_txn_id, 7, 'business_loan_drawdown', bl.kind, bl.lender, d.amount::numeric
      from public.business_loan_drawdowns d join lines l on l.id = d.bank_txn_id
      join public.business_loans bl on bl.id = d.loan_id
    union all
    select ep.bank_txn_id, 8, 'emi_payment', ep.kind, coalesce(nullif(trim(pu.lender), ''), pu.name), ep.amount::numeric
      from public.emi_payments ep join lines l on l.id = ep.bank_txn_id
      join public.emi_purchases pu on pu.id = ep.purchase_id
    union all
    select pu.down_bank_txn_id, 9, 'emi_down_payment', pu.kind, pu.name, pu.down_payment::numeric
      from public.emi_purchases pu join lines l on l.id = pu.down_bank_txn_id
    union all
    select pu.received_bank_txn_id, 10, 'emi_loan_received', pu.kind, coalesce(nullif(trim(pu.lender), ''), pu.name), pu.financed::numeric
      from public.emi_purchases pu join lines l on l.id = pu.received_bank_txn_id
    union all
    select k.bank_txn_id, 11, 'staff_advance', k.kind, coalesce(rb.person_name, pa.vendor_name), k.amount::numeric
      from public.employee_advance_bank_links k join lines l on l.id = k.bank_txn_id
      left join public.reimbursements rb on rb.id = k.reimbursement_id
      left join public.prepaid_advances pa on pa.id = k.advance_id
    union all
    select s.bank_txn_id, 12, 'statutory', s.kind, s.challan_no, s.amount::numeric
      from public.statutory_dues_payments s join lines l on l.id = s.bank_txn_id
  )
  select distinct on (f.txn_id) f.txn_id, f.source, f.sub, f.party, f.amount
    from found f
   order by f.txn_id, f.pri;
$function$;

revoke all on function public.bank_line_bookings(uuid) from public;
revoke all on function public.bank_line_bookings(uuid) from anon;
grant execute on function public.bank_line_bookings(uuid) to authenticated;
grant execute on function public.bank_line_bookings(uuid) to service_role;

commit;
