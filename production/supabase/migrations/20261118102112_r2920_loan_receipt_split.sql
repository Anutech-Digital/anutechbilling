-- deploy-peek: to_regprocedure('public.reconcile_bank_credit_to_loans_given(uuid,jsonb)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_loan_given_line_unmatched()') and prosrc like '%R-2920%')
-- deploy-key: r2920loanreceiptsplit
--
-- R-2920 (18 Nov 2026): Banking → Reconcile a money-IN line → Loan / EMI → "A receipt on a loan you
-- gave?" — ONE bank line can pay off TWO OR MORE loans given.
--
-- Real lines: +₹3,50,000 from a borrower clears the ₹3,49,000 left on his big loan AND his separate
-- ₹1,000 loan; +₹97,000 from another clears his ₹90,000 and ₹7,000 loans.
-- reconcile_bank_credit_to_loan_given (R-2340) puts a line on ONE loan only and refuses anything over
-- what that loan owes, so such lines could not be booked at all.
--
--   1. reconcile_bank_credit_to_loans_given(line, parts) — parts = [{loan_id, amount, interest_part}].
--      ONE transaction: one loan_repayments row per loan, all on THIS line (no new bank line), each
--      split by R-2340's own rule (plan 'emi': the month's interest on what is still owed, worked out
--      here; other plans: the interest part the page works out, never more than the part; 0% → 0),
--      the line matched ONCE ('loan_given' → the first receipt). Same who-may as R-2340: owner or
--      accountant, own company's line and loans.
--      Refused, nothing written: the parts do not add up to the line; any part is more than that loan
--      owes; a part of ₹0 or less; the same loan twice; a closed / other-company loan; a line dated
--      before a loan was given; a line already reconciled (repeat click).
--      MONEY: Dr Bank (the existing line) / Cr Loans given (each loan's principal part) + Cr Interest
--      received. other_incomes holds ONE row per bank line (bank_txn_id is unique), so the interest
--      of all the parts is one 'interest' row that names the borrowers.
--      reconcile_bank_credit_to_loan_given (one loan) is NOT changed.
--   2. tg_loan_given_line_unmatched — its latest body (R-2570, 20261107165630) + UNDO of a split
--      line: Un-reconcile removes EVERY receipt on the line and the interest income, and re-opens every
--      one of those loans — all or nothing. Refused (as before, same words) while a later receipt of
--      any of those loans is on the books. A line with one receipt behaves exactly as before.
--
-- Proof: supabase/tests/r2920_loan_receipt_split.test.sql (one rollback).

begin;

-- ── 1. A money-in line → receipts on several loans given ─────────────────────────────────
create or replace function public.reconcile_bank_credit_to_loans_given(p_txn_id uuid, p_parts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_line   public.bank_transactions;
  v_l      public.loans_given;
  v_amount integer;
  v_n      integer;
  v_sum    bigint;
  v_part   jsonb;
  v_part_amt integer;
  v_left   integer;
  v_seq    integer;
  v_due    integer;
  v_int    integer;
  v_prin   integer;
  v_id     uuid;
  v_first  uuid;
  v_int_total integer := 0;
  v_prin_total integer := 0;
  v_names  text[] := '{}';
  v_out    jsonb := '[]'::jsonb;
  c_uuid   constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  c_rupees constant text := '^[0-9]{1,9}$';
begin
  -- R-2920
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can record loan receipts — ask your owner to do it.';
  end if;

  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0 then
    raise exception 'Tick at least one loan for this line.';
  end if;
  v_n := jsonb_array_length(p_parts);
  if v_n > 20 then raise exception 'One line can be split across at most 20 loans.'; end if;

  select * into v_line from public.bank_transactions where id = p_txn_id for update;
  if not found or v_line.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company'; end if;
  if coalesce(v_line.credit, 0) <= 0 or coalesce(v_line.debit, 0) <> 0 then
    raise exception 'Only a money-in line can be a receipt on a loan given';
  end if;
  if v_line.matched_to_type is not null then
    raise exception 'This line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_line.matched_to_type;
  end if;
  v_amount := round(v_line.credit)::integer;

  -- Every part well-formed BEFORE anything is read or written.
  if exists (
    select 1 from jsonb_array_elements(p_parts) x
     where jsonb_typeof(x) <> 'object'
        or coalesce(x ->> 'loan_id', '') !~ c_uuid
        or (case when coalesce(x ->> 'amount', '') ~ c_rupees then (x ->> 'amount')::integer <= 0 else true end)
        or ((x ->> 'interest_part') is not null and (x ->> 'interest_part') !~ c_rupees)
  ) then
    raise exception 'Enter a whole-rupee amount, more than ₹0, for each ticked loan. Nothing was saved.';
  end if;
  if (select count(distinct lower(x ->> 'loan_id')) from jsonb_array_elements(p_parts) x) <> v_n then
    raise exception 'The same loan is ticked twice — one amount per loan. Nothing was saved.';
  end if;
  select sum((x ->> 'amount')::integer) into v_sum from jsonb_array_elements(p_parts) x;
  if v_sum <> v_amount then
    raise exception 'The parts add up to ₹% but this line is ₹% — they must be equal. Nothing was saved.', v_sum, v_amount;
  end if;

  -- Lock the loans in one fixed order (two saves on overlapping loans cannot deadlock).
  perform 1 from public.loans_given g
    where g.tenant_id = v_tenant
      and g.id in (select (x ->> 'loan_id')::uuid from jsonb_array_elements(p_parts) x)
    order by g.id
      for update;

  for v_part in select x from jsonb_array_elements(p_parts) with ordinality as t(x, ord) order by ord loop
    v_part_amt := (v_part ->> 'amount')::integer;

    select * into v_l from public.loans_given where id = (v_part ->> 'loan_id')::uuid and tenant_id = v_tenant;
    if not found then raise exception 'Loan not found in your company. Nothing was saved.'; end if;
    if v_l.status = 'closed' then
      raise exception 'The loan to % is already fully repaid and closed. Nothing was saved.', v_l.borrower_name;
    end if;
    if v_line.txn_date < v_l.given_on then
      raise exception 'This line (%) is before the loan to % was given (%) — check the loan. Nothing was saved.',
        to_char(v_line.txn_date, 'DD Mon YYYY'), v_l.borrower_name, to_char(v_l.given_on, 'DD Mon YYYY');
    end if;

    select v_l.principal - coalesce(sum(principal_part), 0), count(*) + 1 into v_left, v_seq
      from public.loan_repayments where loan_id = v_l.id;

    -- The split of this part: R-2340's rule, on the part's amount.
    if v_l.repayment_plan = 'emi' then
      v_due := round(v_left::numeric * v_l.interest_rate / 1200)::integer;
      v_int := least(v_part_amt, v_due);
    else
      v_due := greatest(coalesce((v_part ->> 'interest_part')::integer, 0), 0);
      if v_l.interest_rate = 0 then v_due := 0; end if;
      if v_due > v_part_amt then
        raise exception 'For %, the interest part cannot be more than the amount. Nothing was saved.', v_l.borrower_name;
      end if;
      v_int := v_due;
    end if;
    v_prin := v_part_amt - v_int;
    if v_prin > v_left then
      raise exception 'For %, ₹% is more than is owed: ₹% of the loan is left plus ₹% interest, so at most ₹%. Nothing was saved.',
        v_l.borrower_name, v_part_amt, v_left, v_due, v_left + v_due;
    end if;

    insert into public.loan_repayments
      (tenant_id, loan_id, repaid_on, amount, principal_part, interest_part, mode, reference,
       bank_account_id, bank_txn_id, notes, created_by)
    values
      (v_tenant, v_l.id, v_line.txn_date, v_part_amt, v_prin, v_int, 'bank',
       left(nullif(trim(coalesce(v_line.reference, '')), ''), 200), v_line.bank_account_id, v_line.id,
       'Receipt ' || v_seq || ' — reconciled from the bank line'
         || case when v_n > 1 then ' (₹' || v_amount || ' line split across ' || v_n || ' loans)' else '' end,
       auth.uid())
    returning id into v_id;
    v_first := coalesce(v_first, v_id);

    update public.loans_given
       set status = case when v_left - v_prin <= 0 then 'closed' else 'open' end,
           closed_on = case when v_left - v_prin <= 0 then v_line.txn_date else null end,
           updated_at = now()
     where id = v_l.id;

    v_int_total := v_int_total + v_int;
    v_prin_total := v_prin_total + v_prin;
    if v_int > 0 and not (v_l.borrower_name = any (v_names)) then v_names := array_append(v_names, v_l.borrower_name); end if;
    v_out := v_out || jsonb_build_object('loan_id', v_l.id, 'borrower', v_l.borrower_name, 'repayment_id', v_id, 'seq', v_seq,
                                         'amount', v_part_amt, 'principal', v_prin, 'interest', v_int,
                                         'left', v_left - v_prin, 'closes', v_left - v_prin <= 0);
  end loop;

  -- other_incomes: one row per bank line → the interest of every part together.
  if v_int_total > 0 then
    insert into public.other_incomes (tenant_id, bank_txn_id, income_date, amount, head, description, created_by)
    values (v_tenant, v_line.id, v_line.txn_date, v_int_total, 'interest',
            left('Interest on loans given · ' || array_to_string(v_names, ', '), 500), auth.uid());
  end if;

  perform public.reconcile_bank_txn(v_line.id, 'loan_given', v_first::text, 'manual');

  return jsonb_build_object('receipts', v_out, 'loans', v_n, 'principal', v_prin_total, 'interest', v_int_total);
end;
$$;
revoke all on function public.reconcile_bank_credit_to_loans_given(uuid, jsonb) from public, anon;
grant execute on function public.reconcile_bank_credit_to_loans_given(uuid, jsonb) to authenticated, service_role;

-- ── 2. Un-reconciling a 'loan_given' line — R-2570 body + every receipt on the line goes ───
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
begin
  -- R-2340
  if old.matched_to_type = 'loan_given'
     and (new.matched_to_type is distinct from 'loan_given' or new.matched_to_id is distinct from old.matched_to_id) then
    -- R-2920: one line can hold a receipt on several loans — they are undone together, or not at all.
    for v_rep in select * from public.loan_repayments where bank_txn_id = old.id order by id for update loop
      v_any := true;
      select count(*) into v_n from public.loan_repayments r
       where r.loan_id = v_rep.loan_id and r.id <> v_rep.id
         and (r.repaid_on > v_rep.repaid_on or (r.repaid_on = v_rep.repaid_on and r.created_at > v_rep.created_at));
      if v_n > 0 then
        raise exception '% later receipt(s) of this loan are on the books — undo the latest receipt first, then this one', v_n;
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
