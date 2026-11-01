-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_loan_repayment(uuid,date,integer,integer,uuid,text,text,text)') and prosrc like '%R-2346%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_loan_given_line_unmatched()') and prosrc like '%R-2346%')
-- deploy-key: r2346loanrepaymentinterest
-- R-2346 (1 Nov 2026): the Loans given page's own "Record repayment" books its interest part as
-- income, like a bank-line receipt does.
--
-- R-2340's worker found it: reconcile_bank_credit_to_loan_given (a money-in statement line → a loan
-- receipt) posts the interest to other_incomes head 'interest' = P&L "Interest received" (R-2095),
-- but record_loan_repayment (R-544, the page's button) wrote only loan_repayments.interest_part —
-- a column no report reads — so that interest reached no P&L line and the books did not balance
-- (cash up by the whole amount, asset down by the principal part only).
--
--   1. record_loan_repayment — R-544 body (20261010140000, its only definition) +:
--        • the cash-in line it adds is matched 'loan_given' → the repayment (was 'manual'), the same
--          shape as an R-2340 receipt: Banking reads it "Loan given" and Un-reconcile undoes it;
--        • interest part > 0 → other_incomes (head 'interest', that line), one transaction.
--   2. tg_loan_given_line_unmatched — R-2340 body (20261101100517) + the line record_loan_repayment
--      added (source 'manual', reference 'LOAN-REPAYMENT', no import) is removed with its repayment —
--      it was never on a statement, so leaving it would count money no one received (R-2095's
--      OWN-TRANSFER rule). A statement line (R-2340 receipt) is only freed, as before.
--   MONEY: repayment = Dr Bank (new line) / Cr Loans given (principal part) + Cr Interest received.
--   Old repayments are NOT changed (no backfill — a data repair is the owner's call).
--
-- Proof: supabase/tests/r2346_loan_repayment_interest_income.sql (one rollback).

begin;

-- ── 1. record_loan_repayment ─────────────────────────────────────────────────────────────
create or replace function public.record_loan_repayment(
  p_loan_id         uuid,
  p_repaid_on       date,
  p_amount          integer,
  p_interest_part   integer,
  p_bank_account_id uuid,
  p_mode            text default 'bank',
  p_reference       text default null,
  p_notes           text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_l         public.loans_given;
  v_paid_prin integer;
  v_left      integer;
  v_int       integer := greatest(coalesce(p_interest_part, 0), 0);
  v_prin      integer;
  v_txn       uuid;
  v_id        uuid := gen_random_uuid();   -- R-2346: known before the line, so the line points at it
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can record repayments — ask your owner to do it.';
  end if;

  select * into v_l from public.loans_given where id = p_loan_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Loan not found in your company.'; end if;
  if v_l.status = 'closed' then raise exception 'This loan is already fully repaid and closed.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Repayment must be more than ₹0.'; end if;
  if p_repaid_on is null or p_repaid_on < v_l.given_on then
    raise exception 'The repayment date is before the loan was given (%) — check the date.', to_char(v_l.given_on, 'DD Mon YYYY');
  end if;
  if coalesce(p_mode, 'bank') not in ('bank', 'upi', 'cash', 'cheque') then
    raise exception 'Pick how it was received: bank, UPI, cash or cheque.';
  end if;
  -- Interest-free loan: nothing can be booked as interest.
  if v_l.interest_rate = 0 then v_int := 0; end if;
  if v_int > p_amount then raise exception 'Interest part cannot be more than the amount received.'; end if;
  v_prin := p_amount - v_int;

  select coalesce(sum(principal_part), 0) into v_paid_prin from public.loan_repayments where loan_id = p_loan_id;
  v_left := v_l.principal - v_paid_prin;
  if v_prin > v_left then
    raise exception 'That is more than is owed: only ₹% of the loan is left (plus any interest). Enter ₹% or less as the loan part.', v_left, v_left;
  end if;

  if p_bank_account_id is null then raise exception 'Pick the account the money came into.'; end if;
  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'That account is not in your company — pick another, or add it in Banking.'; end if;

  -- Cash in (money comes into the account → credit). R-2346: matched 'loan_given' → this repayment
  -- (R-2340's shape); reference LOAN-REPAYMENT = "added by this button" (undo removes the line).
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source,
     matched_to_type, matched_to_id, matched_at, matched_by, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_repaid_on,
     'Loan repayment: ' || v_l.borrower_name || case when v_int > 0 then ' (incl. ₹' || v_int || ' interest)' else '' end,
     0, p_amount, 'LOAN-REPAYMENT', 'manual', 'loan_given', v_id::text, now(), auth.uid(), 'manual')
  returning id into v_txn;

  insert into public.loan_repayments
    (id, tenant_id, loan_id, repaid_on, amount, principal_part, interest_part, mode, reference,
     bank_account_id, bank_txn_id, notes, created_by)
  values
    (v_id, v_tenant, p_loan_id, p_repaid_on, p_amount, v_prin, v_int, coalesce(p_mode, 'bank'),
     nullif(trim(coalesce(p_reference, '')), ''), p_bank_account_id, v_txn,
     nullif(trim(coalesce(p_notes, '')), ''), auth.uid());

  -- R-2346: the interest part is income — P&L "Interest received" (R-2095 / R-2340).
  if v_int > 0 then
    insert into public.other_incomes (tenant_id, bank_txn_id, income_date, amount, head, description, created_by)
    values (v_tenant, v_txn, p_repaid_on, v_int, 'interest',
            'Interest on loan given · ' || v_l.borrower_name, auth.uid());
  end if;

  update public.loans_given
     set status = case when v_left - v_prin <= 0 then 'closed' else 'open' end,
         closed_on = case when v_left - v_prin <= 0 then p_repaid_on else null end,
         updated_at = now()
   where id = p_loan_id;

  return v_id;
end;
$$;

revoke all on function public.record_loan_repayment(uuid, date, integer, integer, uuid, text, text, text) from public, anon;
grant execute on function public.record_loan_repayment(uuid, date, integer, integer, uuid, text, text, text) to authenticated;

-- ── 2. Un-reconciling a 'loan_given' line — R-2340 body + the page's own line goes too ─────
create or replace function public.tg_loan_given_line_unmatched() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_rep public.loan_repayments;
  v_l   public.loans_given;
  v_n   integer;
begin
  -- R-2340
  if old.matched_to_type = 'loan_given'
     and (new.matched_to_type is distinct from 'loan_given' or new.matched_to_id is distinct from old.matched_to_id) then
    select * into v_rep from public.loan_repayments where bank_txn_id = old.id for update;
    if found then
      select count(*) into v_n from public.loan_repayments r
       where r.loan_id = v_rep.loan_id and r.id <> v_rep.id
         and (r.repaid_on > v_rep.repaid_on or (r.repaid_on = v_rep.repaid_on and r.created_at > v_rep.created_at));
      if v_n > 0 then
        raise exception '% later receipt(s) of this loan are on the books — undo the latest receipt first, then this one', v_n;
      end if;
      delete from public.other_incomes where bank_txn_id = old.id;
      delete from public.loan_repayments where id = v_rep.id;
      update public.loans_given set status = 'open', closed_on = null, updated_at = now() where id = v_rep.loan_id;
      -- R-2346: a line Record repayment added (never on a statement) goes with its repayment.
      if old.source = 'manual' and old.import_batch_id is null and old.reference = 'LOAN-REPAYMENT' then
        delete from public.bank_transactions where id = old.id;
      end if;
      return null;
    end if;
    select * into v_l from public.loans_given where bank_txn_id = old.id for update;
    if found then
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
$$;
revoke all on function public.tg_loan_given_line_unmatched() from public, anon, authenticated;

commit;
