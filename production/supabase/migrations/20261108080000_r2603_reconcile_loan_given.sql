-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_loan_given_from_bank_out(uuid,text,text)') and prosrc like '%R-2603%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_advance(uuid,text,text,text)') and prosrc like '%R-2603%')
-- deploy-key: r2603loangivenout
--
-- R-2603 (8 Nov 2026): Banking → Reconcile a money-OUT line → "Loan / advance with a person?" →
-- "I am GIVING a loan/advance" booked book_bank_advance: a balance_sheet_items asset
-- "Advance/loan given · <name>". Accounting → Loans given reads only loans_given / loan_repayments,
-- so every loan given from the bank statement was missing there (two stores for one thing).
--
-- record_loan_given_from_bank_out(line, borrower, notes): the line becomes ONE loans_given row —
--   one_shot, 0% (terms can be set on Loans given later), given_on = the line's date, principal =
--   the line's amount, paid_from_account_id = the line's account, bank_txn_id = the line — and the
--   line is matched 'loan_given' + the loan id (R-2340 / R-2570's type). No new bank line, no
--   balance_sheet_items row. Balance Sheet "Loans given" (loans_given_asset()) picks it up.
--   MONEY: Dr Loans given (asset) / Cr Bank (the existing line). Not P&L.
--   Same borrower typed in another case / with extra spaces → the existing loans_given spelling is
--   reused, so one person stays one name on the page.
--   Refused (nothing written): not owner/accountant (loans_given's own rule), another company's
--   line, a money-in line, an already reconciled line (repeat click / another option such as
--   book_bank_advance, a staff advance or a vendor advance), no name. (bank_transactions.debit and
--   loans_given.principal are both whole rupees, so the loan always ties to the line.)
--   UNDO: Un-reconcile → reconcile_bank_txn(null) → tg_loan_given_line_unmatched (R-2340/R-2570)
--   deletes the loan and frees the line; refused while a receipt is on the books.
--   Receipts (money-in) keep going through reconcile_bank_credit_to_loan_given (R-2340).
-- book_bank_advance (from its latest body, R-2570) still books "I am REPAYING a loan someone gave me",
-- "Someone GAVE me a loan" and money back on an OLD Balance Sheet advance — but money back from a
-- borrower who has an OPEN loan on Loans given is refused there (it is a receipt on that loan).
-- Old "Advance/loan given" lines stay where they are (moving them = R-2604).
-- A hand-typed bank line (source 'manual', no import) is refused: delete_loan_given deletes such a
-- line with its loan, so a loan on it goes through Loans given → Give a loan (which adds its own line).
--
-- Proof: supabase/tests/r2603_reconcile_loan_given.test.sql (one rollback).

begin;

create or replace function public.record_loan_given_from_bank_out(
  p_txn_id uuid, p_borrower text, p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_name   text := regexp_replace(trim(coalesce(p_borrower, '')), '\s+', ' ', 'g');
  v_known  text;
  v_line   public.bank_transactions;
  v_id     uuid;
begin
  -- R-2603
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can record loans given — ask your owner to do it.'
      using errcode = '42501';
  end if;
  if v_name = '' then raise exception 'Enter the borrower''s name.'; end if;
  if char_length(v_name) > 200 then raise exception 'Keep the borrower''s name under 200 characters.'; end if;

  select * into v_line from public.bank_transactions where id = p_txn_id for update;
  if not found or v_line.tenant_id is distinct from v_tenant then
    raise exception 'Bank line not found in your company.';
  end if;
  if coalesce(v_line.debit, 0) <= 0 or coalesce(v_line.credit, 0) <> 0 then
    raise exception 'Only a money-out line can be a loan you gave.';
  end if;
  if v_line.matched_to_type is not null then
    raise exception 'This line is already reconciled (%). Un-reconcile it first if it was matched wrongly.',
      replace(v_line.matched_to_type, '_', ' ');
  end if;
  if v_line.source = 'manual' and v_line.import_batch_id is null then
    raise exception 'This line was typed in by hand, not imported — record the loan on Accounting → Loans given → Give a loan instead (it adds its own line); delete this one.';
  end if;

  -- One person, one name: reuse the spelling already on Loans given (case / spaces ignored).
  select l.borrower_name into v_known
    from public.loans_given l
   where l.tenant_id = v_tenant
     and lower(regexp_replace(trim(l.borrower_name), '\s+', ' ', 'g')) = lower(v_name)
   order by l.created_at
   limit 1;
  v_name := coalesce(v_known, v_name);

  insert into public.loans_given
    (tenant_id, borrower_name, borrower_type, principal, given_on, interest_rate, repayment_plan,
     paid_from_account_id, bank_txn_id, notes, status, created_by)
  values
    (v_tenant, v_name, 'person', v_line.debit, v_line.txn_date, 0, 'one_shot',
     v_line.bank_account_id, v_line.id, nullif(trim(coalesce(p_notes, '')), ''), 'open', auth.uid())
  returning id into v_id;

  perform public.reconcile_bank_txn(v_line.id, 'loan_given', v_id::text, 'manual');
  return v_id;
end;
$$;
revoke all on function public.record_loan_given_from_bank_out(uuid, text, text) from public, anon;
grant execute on function public.record_loan_given_from_bank_out(uuid, text, text) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.book_bank_advance(p_txn_id uuid, p_counterparty text, p_kind text DEFAULT 'given'::text, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-2570: the line is matched to its own balance-sheet row (bs_item + its id), not 'manual'.
   R-2603: money back from a borrower with an open loan on Loans given is refused here — it is a
   receipt on that loan (reconcile_bank_credit_to_loan_given), never a second store. */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_amount  int;
  v_section text;
  v_label   text;
  v_party   text;
  v_item    uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  v_party := nullif(trim(coalesce(p_counterparty, '')), '');

  -- R-2603
  if p_kind = 'given' and coalesce(v_txn.credit, 0) > 0 and v_party is not null and exists (
       select 1 from public.loans_given l
        where l.tenant_id = v_tenant and l.status = 'open'
          and lower(regexp_replace(trim(l.borrower_name), '\s+', ' ', 'g')) = lower(regexp_replace(v_party, '\s+', ' ', 'g'))) then
    raise exception '% has an open loan on Accounting → Loans given — book this money there: Loan / EMI → "A receipt on a loan you gave?". Nothing was changed.', v_party
      using errcode = '23514';
  end if;

  if p_kind = 'given' then
    v_section := 'asset';
    if coalesce(v_txn.debit, 0) > 0 then
      v_amount := v_txn.debit;
      v_label  := 'Advance/loan given' || coalesce(' · ' || v_party, '');
    elsif coalesce(v_txn.credit, 0) > 0 then
      v_amount := -v_txn.credit;
      v_label  := 'Advance/loan returned' || coalesce(' · ' || v_party, '');
    else
      raise exception 'Transaction has no amount';
    end if;
  elsif p_kind = 'received' then
    v_section := 'liability';
    if coalesce(v_txn.credit, 0) > 0 then
      v_amount := v_txn.credit;
      v_label  := 'Loan received' || coalesce(' · ' || v_party, '');
    elsif coalesce(v_txn.debit, 0) > 0 then
      v_amount := -v_txn.debit;
      v_label  := 'Loan repaid' || coalesce(' · ' || v_party, '');
    else
      raise exception 'Transaction has no amount';
    end if;
  else
    raise exception 'Unknown kind: %', p_kind;
  end if;

  insert into public.balance_sheet_items (tenant_id, section, label, amount, notes, bank_txn_id)
  values (v_tenant, v_section, v_label, v_amount, nullif(trim(coalesce(p_notes, '')), ''), p_txn_id)
  returning id into v_item;

  update public.bank_transactions
     set matched_to_type = 'bs_item', matched_to_id = v_item::text,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual',
         updated_at = now()
   where id = p_txn_id;
end;
$function$;

commit;
