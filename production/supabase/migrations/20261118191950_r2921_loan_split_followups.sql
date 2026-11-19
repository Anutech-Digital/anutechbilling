-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_line_bookings(uuid)') and prosrc like '%R-2921%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_loan_given_line_unmatched()') and prosrc like '%R-2921%')
-- deploy-key: r2921loansplitfollowups
--
-- R-2921 (18 Nov 2026): three small things from the review of R-2920 (one bank line → receipts on
-- two or more loans given, reconcile_bank_credit_to_loans_given).
--
--   1. bank_line_bookings — its latest body (R-2570, 20261107165630) with the 'loan_given_repayment'
--      branch added up PER BANK LINE: sum of the receipts on the line + the borrower name(s). Before,
--      a split line gave one row per receipt and `distinct on (txn_id)` kept any one of them, so the
--      Banking list could show ₹1,000 for a ₹3,50,000 line. A line with one receipt reads as before.
--   2. tg_loan_given_line_unmatched — its latest body (R-2920, 20261118102112): the refusal while a
--      later receipt is on the books now NAMES the loan that blocks the undo — borrower, amount lent,
--      day given (a split line can sit on several loans, two of them of one borrower). The words
--      "later receipt(s) of this loan are on the books" stay.
--   3. Same trigger: the loans of the line's receipts are locked (in id order, as
--      reconcile_bank_credit_to_loans_given locks them) BEFORE the later-receipt check, so a receipt
--      saved on one of those loans at the same moment cannot slip in between the check and the undo.
--
-- No money rule changes; no table changes. Proof: supabase/tests/r2921_loan_split_followups.test.sql
-- (one rollback); r2920 / r2340 / r2346 / r2570 tests stay green.

begin;

-- ── 1. bank_line_bookings: a split loan-given line shows the whole line ─────────────────
create or replace function public.bank_line_bookings(p_bank_account_id uuid)
returns table (txn_id uuid, source text, sub text, party text, amount numeric)
language sql
stable
security invoker
set search_path to 'public'
as $function$
  /* R-2378: what a matched_to_type = 'manual' line really booked. First match per line wins.
     R-2570: the writers now store their own type + id (bs_item, employee_loan, reimbursement,
     loan_given, business_loan, loan_repayment, emi, statutory) — those lines are read here too, so
     the line keeps its party ("Loan received · Bajaj Finance"); 'manual' rows from before R-2570
     are still found the R-2378 way.
     R-2921: a money-in line split across two or more loans given (R-2920) has one loan_repayments
     row per loan — they are added up here, so the line reads its full amount and every borrower. */
  with lines as (
    select t.id, t.source, t.description, t.txn_date, t.debit, t.credit, t.matched_to_type,
           /* the record id as uuid (a non-uuid id → null), so the joins below use the primary keys */
           case when t.matched_to_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then t.matched_to_id::uuid end as mid
      from public.bank_transactions t
     where t.bank_account_id = p_bank_account_id
       and t.matched_to_type in ('manual', 'bs_item', 'employee_loan', 'reimbursement', 'loan_given', 'business_loan',
                                 'loan_drawdown', 'loan_repayment', 'emi', 'statutory')
  ), found as (
    select b.bank_txn_id as txn_id, 1 as pri, 'bs_item'::text as source, b.section as sub, b.label as party, b.amount::numeric as amount
      from public.balance_sheet_items b join lines l on l.id = b.bank_txn_id
    union all
    select e.bank_txn_id, 2, 'employee_loan', e.kind, e.employee_name, e.principal::numeric
      from public.employee_loans e join lines l on l.id = e.bank_txn_id
    union all
    /* R-2570: a staff loan's repayment / an advance's returned cash — matched to the loan by id. */
    select l.id, 2, case when e.kind = 'expense_advance' then 'employee_advance_returned' else 'employee_loan_repayment' end,
           null, e.employee_name, l.credit::numeric
      from lines l join public.employee_loans e on e.id = l.mid
     where l.matched_to_type = 'employee_loan' and l.credit > 0
    union all
    select g.bank_txn_id, 3, 'loan_given', g.borrower_type, g.borrower_name, g.principal::numeric
      from public.loans_given g join lines l on l.id = g.bank_txn_id
    union all
    /* R-2921: ONE row per bank line — the sum of its receipts and the distinct borrower name(s), A–Z;
       more than three borrowers → the first two + "+N more" (the row badge stays short). */
    select r.bank_txn_id, 4, 'loan_given_repayment', min(r.mode),
           case when count(distinct g.borrower_name) > 3
                then array_to_string((array_agg(distinct g.borrower_name order by g.borrower_name))[1:2], ', ')
                     || ' +' || (count(distinct g.borrower_name) - 2) || ' more'
                else string_agg(distinct g.borrower_name, ', ' order by g.borrower_name) end,
           sum(r.amount)::numeric
      from public.loan_repayments r join lines l on l.id = r.bank_txn_id
      join public.loans_given g on g.id = r.loan_id
     group by r.bank_txn_id
    union all
    select bl.disbursal_bank_txn_id, 5, 'business_loan', bl.kind, bl.lender, bl.principal::numeric
      from public.business_loans bl join lines l on l.id = bl.disbursal_bank_txn_id
    union all
    select p.bank_txn_id, 6, 'business_loan_payment', bl.kind, bl.lender, p.amount::numeric
      from public.business_loan_payments p join lines l on l.id = p.bank_txn_id
      join public.business_loans bl on bl.id = p.loan_id
    union all
    /* R-2570: record_loan_emi's own line — matched to the repayment by id (the payment has no bank_txn_id). */
    select l.id, 6, 'business_loan_payment', bl.kind, bl.lender, p.amount::numeric
      from lines l join public.business_loan_payments p on p.id = l.mid
      join public.business_loans bl on bl.id = p.loan_id
     where l.matched_to_type = 'loan_repayment' and p.bank_txn_id is null
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
    union all
    /* R-2570: pay_statutory_dues' own line — matched to the payment by id. */
    select l.id, 12, 'statutory', s.kind, s.challan_no, s.amount::numeric
      from lines l join public.statutory_dues_payments s on s.id = l.mid
     where l.matched_to_type = 'statutory'
    union all
    /* A staff loan from before R-1873 (no bank_txn_id): its own hand-entered line, found the way
       employee_loan_legacy_line() finds it. */
    select l.id, 13, 'employee_loan', e.kind, e.employee_name, e.principal::numeric
      from lines l join public.employee_loans e
        on e.bank_txn_id is null and e.bank_account_id = p_bank_account_id
       and l.source = 'manual' and l.txn_date = e.disbursed_on and l.debit = e.principal
       and l.description in ('Loan/advance to ' || e.employee_name, 'Expense advance to ' || e.employee_name)
     where l.matched_to_type = 'manual'
    union all
    /* The lines the staff-loan RPCs wrote with no link at all (before R-2570) — their words name the booking. */
    select l.id, 14, 'employee_loan_reversal', null, substr(l.description, length('Correction: reversed loan/advance to ') + 1), null::numeric
      from lines l where l.matched_to_type = 'manual' and l.source = 'manual' and l.description like 'Correction: reversed loan/advance to %'
    union all
    select l.id, 15, 'employee_loan_repayment', null, substr(l.description, length('Loan repayment — ') + 1), null::numeric
      from lines l where l.matched_to_type = 'manual' and l.source = 'manual' and l.description like 'Loan repayment — %'
    union all
    select l.id, 16, 'employee_advance_returned', null, substr(l.description, length('Advance returned — ') + 1), null::numeric
      from lines l where l.matched_to_type = 'manual' and l.source = 'manual' and l.description like 'Advance returned — %'
  )
  select distinct on (f.txn_id) f.txn_id, f.source, f.sub, f.party, f.amount
    from found f
   order by f.txn_id, f.pri;
$function$;

revoke all on function public.bank_line_bookings(uuid) from public;
revoke all on function public.bank_line_bookings(uuid) from anon;
grant execute on function public.bank_line_bookings(uuid) to authenticated;
grant execute on function public.bank_line_bookings(uuid) to service_role;

-- ── 2 + 3. Un-reconciling a 'loan_given' line — R-2920 body + borrower named + loans locked first ──
CREATE OR REPLACE FUNCTION public.tg_loan_given_line_unmatched()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rep public.loan_repayments;
  v_l   public.loans_given;
  v_n   integer;
  v_any boolean := false;
  v_who text;
begin
  -- R-2340
  if old.matched_to_type = 'loan_given'
     and (new.matched_to_type is distinct from 'loan_given' or new.matched_to_id is distinct from old.matched_to_id) then
    -- R-2920: one line can hold a receipt on several loans — they are undone together, or not at all.
    -- R-2921: lock the loans of this line's receipts first, in id order (the order
    -- reconcile_bank_credit_to_loans_given locks them) — a receipt being saved on one of them at the
    -- same moment waits, so it cannot land between the later-receipt check and the undo.
    perform 1 from public.loans_given g
      where g.id in (select r.loan_id from public.loan_repayments r where r.bank_txn_id = old.id)
      order by g.id
        for update;
    for v_rep in select * from public.loan_repayments where bank_txn_id = old.id order by id for update loop
      v_any := true;
      select count(*) into v_n from public.loan_repayments r
       where r.loan_id = v_rep.loan_id and r.id <> v_rep.id
         and (r.repaid_on > v_rep.repaid_on or (r.repaid_on = v_rep.repaid_on and r.created_at > v_rep.created_at));
      if v_n > 0 then
        -- R-2921: say WHICH loan blocks the undo (a split line sits on several loans, and one
        -- borrower can have two) — borrower, amount lent and the day it was given.
        select g.borrower_name || ' (₹' || g.principal || ', given ' || to_char(g.given_on, 'DD Mon YYYY') || ')'
          into v_who from public.loans_given g where g.id = v_rep.loan_id;
        raise exception 'Loan to %: % later receipt(s) of this loan are on the books — undo the latest receipt first, then this one',
          coalesce(v_who, 'this borrower'), v_n;
      end if;
    end loop;
    if v_any then
      delete from public.other_incomes where bank_txn_id = old.id;
      update public.loans_given set status = 'open', closed_on = null, updated_at = now()
       where id in (select r.loan_id from public.loan_repayments r where r.bank_txn_id = old.id);
      delete from public.loan_repayments where bank_txn_id = old.id;
      -- R-2346: a line Record repayment added (never on a statement) goes with its repayment.
      if old.source = 'manual' and old.import_batch_id is null and old.reference = 'LOAN-REPAYMENT' then
        delete from public.bank_transactions where id = old.id;
      end if;
      return null;
    end if;
    select * into v_l from public.loans_given where bank_txn_id = old.id for update;
    if found then
      -- R-2570: the payout line Give loan made itself (no statement behind it) — un-reconciling would
      -- drop the loan and leave the line. Delete the loan on Loans given instead (its line goes with it).
      if old.source = 'manual' and old.import_batch_id is null and old.description = 'Loan given: ' || v_l.borrower_name then
        raise exception 'This line was made by Loans given (loan to %) — delete that loan on Accounting → Loans given instead; its line goes with it', v_l.borrower_name
          using errcode = '23514';
      end if;
      select count(*) into v_n from public.loan_repayments where loan_id = v_l.id;
      if v_n > 0 then
        raise exception 'This line is the money lent to % and % receipt(s) of it are reconciled — undo those first, then un-reconcile this line',
          v_l.borrower_name, v_n;
      end if;
      delete from public.loans_given where id = v_l.id;
    end if;
  end if;
  return null;
end;
$function$;
revoke all on function public.tg_loan_given_line_unmatched() from public, anon, authenticated;

commit;
