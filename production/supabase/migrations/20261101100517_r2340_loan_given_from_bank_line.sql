-- deploy-peek: to_regprocedure('public.record_loan_given_from_bank(jsonb)') is not null and to_regprocedure('public.reconcile_bank_credit_to_loan_given(uuid,uuid,integer)') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'loans_given' and column_name = 'emi_amount') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_loan_given(uuid)') and prosrc like '%R-2340%')
-- deploy-key: r2340loangivenbank
-- R-2340 (1 Nov 2026): Loan GIVEN — set it up from a money-in EMI line on the bank statement, and
-- reconcile each money-in receipt as principal back + interest income.
--
-- R-2323 / R-2341 built only the loan TAKEN side (money-out EMIs → emi_purchases kind 'loan'). A loan
-- the company GAVE (e.g. ₹3,50,000 lent to a person, repaid ₹16,476 a month) had no way in from Banking.
--
-- ══ DESIGN: the existing R-544 loans-given model, not a second one ══════════════════════════
--   loans_given / loan_repayments (migration 20261010140000) already are the asset (Balance Sheet
--   "Loans given" = principal − principal repaid, loans_given_asset()), the /accounting/loans-given
--   page and the books lock. This adds:
--     • repayment_plan 'emi' + loans_given.emi_amount: a reducing-balance receipt schedule — the
--       R-1864 / R-2323 rule (lib/accounting/emi-schedule.ts): receipt k's interest = round(principal
--       still owed × rate / 1200), principal = EMI − interest, the LAST receipt clears what is left.
--       The schedule is not stored: it follows from the loan's terms and the receipts on the books, so
--       the server works out each split itself (nothing the browser sends can change it).
--     • record_loan_given_from_bank(p jsonb): the loan (+ optionally this money-in line as receipt 1),
--       one transaction. The money lent: default "given before these books" — no bank entry (the
--       principal is an opening balance, books-lite, like R-2323's "taken before these books"), or an
--       imported UNMATCHED money-OUT line of that amount (±₹1) — matched once (matched_to_type
--       'loan_given' → the loan), never a new line (R-2341's rule, other direction).
--     • reconcile_bank_credit_to_loan_given(line, loan, interest): a money-in line → the loan's next
--       receipt: loan_repayments row on THIS line (no new line), interest → other_incomes 'interest'
--       (P&L "Interest received", R-2095), line matched once ('loan_given' → the repayment). For an
--       R-544 one-shot / instalment loan the interest part is the one the page works out (R-544 rule).
--   MONEY: receipt = Dr Bank (the existing line) / Cr Loans given (principal) + Cr Interest received.
--   UNDO: Un-reconcile (unreconcile_bank_receipt → reconcile_bank_txn(null) → tg_loan_given_line_unmatched):
--     a receipt line → its repayment + interest income go, the loan re-opens; latest receipt first.
--     a disbursal line → the loan goes (refused while a receipt is on the books).
--   delete_loan_given: R-544 body + an imported disbursal line is freed instead of deleted.
--
-- Proof: supabase/tests/r2340_loan_given_from_bank_line.test.sql (one rollback).

begin;

-- ── 1. loans_given: the 'emi' plan ───────────────────────────────────────────────────────
alter table public.loans_given add column if not exists emi_amount integer;
alter table public.loans_given drop constraint if exists loans_given_emi_amount_check;
alter table public.loans_given add constraint loans_given_emi_amount_check check (emi_amount is null or emi_amount > 0);
alter table public.loans_given drop constraint if exists loans_given_repayment_plan_check;
alter table public.loans_given add constraint loans_given_repayment_plan_check
  check (repayment_plan in ('one_shot', 'instalments', 'emi'));
alter table public.loans_given drop constraint if exists loans_given_plan_shape;
alter table public.loans_given add constraint loans_given_plan_shape check (
  (repayment_plan = 'one_shot' and instalments is null)
  or (repayment_plan = 'instalments' and instalments is not null and due_on is not null)
  or (repayment_plan = 'emi' and instalments is not null and due_on is not null and emi_amount is not null)
);
comment on column public.loans_given.emi_amount is
  'R-2340: plan ''emi'' — the monthly receipt; reducing balance (interest on what is still owed, the last receipt clears the rest). due_on = first receipt, instalments = number of receipts.';

-- matched_to_type gains 'loan_given' (R-2095's pattern: read the live list, add one).
do $$
declare v_def text; v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.bank_transactions'::regclass and c.conname = 'bank_transactions_matched_to_type_check';
  if v_def is null then raise exception 'bank_transactions_matched_to_type_check is missing'; end if;
  if v_def ~ '\{[a-z_,]+\}' then
    v_vals := string_to_array(substring(v_def from '\{([a-z_,]+)\}'), ',');
  else
    select array_agg(m[1] order by ord) into v_vals
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;
  if v_vals is null or cardinality(v_vals) = 0 then raise exception 'Could not read bank_transactions_matched_to_type_check: %', v_def; end if;
  if 'loan_given' = any (v_vals) then return; end if;
  v_vals := array_append(v_vals, 'loan_given'::text);
  execute 'alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check';
  execute format('alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check check (matched_to_type = any (%L::text[]))', v_vals);
end $$;

-- ── 2. A money-in line → the loan's next receipt ─────────────────────────────────────────
create or replace function public.reconcile_bank_credit_to_loan_given(
  p_txn_id uuid, p_loan_id uuid, p_interest_part integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_line   public.bank_transactions;
  v_l      public.loans_given;
  v_amount integer;
  v_left   integer;
  v_seq    integer;
  v_due    integer;   -- R-2340: interest due on this receipt (emi plan)
  v_int    integer;
  v_prin   integer;
  v_id     uuid;
begin
  -- R-2340
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can record loan receipts — ask your owner to do it.';
  end if;

  select * into v_line from public.bank_transactions where id = p_txn_id for update;
  if not found or v_line.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company'; end if;
  if coalesce(v_line.credit, 0) <= 0 or coalesce(v_line.debit, 0) <> 0 then
    raise exception 'Only a money-in line can be a receipt on a loan given';
  end if;
  if v_line.matched_to_type is not null then
    raise exception 'This line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_line.matched_to_type;
  end if;
  v_amount := round(v_line.credit)::integer;

  select * into v_l from public.loans_given where id = p_loan_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Loan not found in your company.'; end if;
  if v_l.status = 'closed' then raise exception 'This loan is already fully repaid and closed.'; end if;
  if v_line.txn_date < v_l.given_on then
    raise exception 'This line (%) is before the loan was given (%) — check the loan.',
      to_char(v_line.txn_date, 'DD Mon YYYY'), to_char(v_l.given_on, 'DD Mon YYYY');
  end if;

  select v_l.principal - coalesce(sum(principal_part), 0), count(*) + 1 into v_left, v_seq
    from public.loan_repayments where loan_id = v_l.id;

  if v_l.repayment_plan = 'emi' then
    -- Reducing balance (R-1864 / R-2323 rule): this month's interest on what is still owed.
    v_due := round(v_left::numeric * v_l.interest_rate / 1200)::integer;
    v_int := least(v_amount, v_due);
  else
    -- R-544 plans: the page works out the accrued interest (lib/accounting/loans-given.ts).
    v_due := greatest(coalesce(p_interest_part, 0), 0);
    if v_l.interest_rate = 0 then v_due := 0; end if;
    if v_due > v_amount then raise exception 'Interest part cannot be more than the amount received.'; end if;
    v_int := v_due;
  end if;
  v_prin := v_amount - v_int;
  if v_prin > v_left then
    raise exception 'This line is ₹% — more than is owed: ₹% of the loan is left plus ₹% interest, so at most ₹%.',
      v_amount, v_left, v_due, v_left + v_due;
  end if;

  insert into public.loan_repayments
    (tenant_id, loan_id, repaid_on, amount, principal_part, interest_part, mode, reference,
     bank_account_id, bank_txn_id, notes, created_by)
  values
    (v_tenant, v_l.id, v_line.txn_date, v_amount, v_prin, v_int, 'bank',
     left(nullif(trim(coalesce(v_line.reference, '')), ''), 200), v_line.bank_account_id, v_line.id,
     'Receipt ' || v_seq || ' — reconciled from the bank line', auth.uid())
  returning id into v_id;

  if v_int > 0 then
    insert into public.other_incomes (tenant_id, bank_txn_id, income_date, amount, head, description, created_by)
    values (v_tenant, v_line.id, v_line.txn_date, v_int, 'interest',
            'Interest on loan given · ' || v_l.borrower_name || ' (receipt ' || v_seq || ')', auth.uid());
  end if;

  perform public.reconcile_bank_txn(v_line.id, 'loan_given', v_id::text, 'manual');

  update public.loans_given
     set status = case when v_left - v_prin <= 0 then 'closed' else 'open' end,
         closed_on = case when v_left - v_prin <= 0 then v_line.txn_date else null end,
         updated_at = now()
   where id = v_l.id;

  return jsonb_build_object('repayment_id', v_id, 'seq', v_seq, 'principal', v_prin, 'interest', v_int,
                            'left', v_left - v_prin, 'closes', v_left - v_prin <= 0);
end;
$$;
revoke all on function public.reconcile_bank_credit_to_loan_given(uuid, uuid, integer) from public, anon;
grant execute on function public.reconcile_bank_credit_to_loan_given(uuid, uuid, integer) to authenticated, service_role;

-- ── 3. Set up a loan given from a bank line ──────────────────────────────────────────────
create or replace function public.record_loan_given_from_bank(p jsonb) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_name     text := nullif(trim(coalesce(p ->> 'borrower', '')), '');
  v_type     text := coalesce(nullif(p ->> 'borrower_type', ''), 'person');
  v_prin     integer := nullif(p ->> 'principal', '')::integer;
  v_rate     numeric := nullif(p ->> 'interest_rate', '')::numeric;
  v_emi      integer := nullif(p ->> 'emi', '')::integer;
  v_n        integer := nullif(p ->> 'instalments', '')::integer;
  v_first    date := nullif(p ->> 'first_due_on', '')::date;
  v_given    date := nullif(p ->> 'given_on', '')::date;
  v_account  uuid := nullif(p ->> 'account_id', '')::uuid;
  v_out_txn  uuid := nullif(p ->> 'disbursal_txn_id', '')::uuid;
  v_in_txn   uuid := nullif(p ->> 'reconcile_txn_id', '')::uuid;
  v_notes    text := nullif(trim(coalesce(p ->> 'notes', '')), '');
  v_int1     integer;
  v_line     public.bank_transactions;
  v_id       uuid;
  v_rec      jsonb;
begin
  -- R-2340
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can record loans given — ask your owner to do it.';
  end if;
  if v_name is null then raise exception 'Enter the borrower''s name'; end if;
  if char_length(v_name) > 200 then raise exception 'Keep the borrower''s name under 200 characters'; end if;
  if v_type not in ('person', 'company') then raise exception 'Borrower type must be person or company.'; end if;
  if v_prin is null or v_prin <= 0 then raise exception 'Enter the amount lent (more than ₹0)'; end if;
  if v_rate is null or v_rate < 0 or v_rate > 60 then raise exception 'Enter the interest rate (0 to 60%% a year)'; end if;
  if v_n is null or v_n < 1 or v_n > 360 then raise exception 'Enter how many monthly receipts (1 to 360)'; end if;
  if v_emi is null or v_emi <= 0 then raise exception 'Enter the monthly receipt (EMI)'; end if;
  if v_first is null then raise exception 'Enter the date of the first receipt'; end if;
  v_int1 := round(v_prin::numeric * v_rate / 1200)::integer;
  if v_n > 1 and v_emi <= v_int1 then
    raise exception 'The EMI ₹% does not cover the first month''s interest ₹% — check the rate or the EMI', v_emi, v_int1;
  end if;

  -- The money lent is a line already on the statement (money out, unmatched, the loan amount ±₹1).
  if v_out_txn is not null then
    select * into v_line from public.bank_transactions where id = v_out_txn for update;
    if not found or v_line.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company'; end if;
    if v_account is not null and v_line.bank_account_id is distinct from v_account then
      raise exception 'That bank line is not on the account the money was lent from';
    end if;
    if coalesce(v_line.debit, 0) <= 0 or coalesce(v_line.credit, 0) <> 0 then
      raise exception 'Only a money-out line can be the money lent';
    end if;
    if v_line.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
    if abs(v_line.debit - v_prin) > 1 then
      raise exception 'This line is ₹% but the loan is ₹% — pick the line for the loan amount', v_line.debit, v_prin;
    end if;
    v_given := v_line.txn_date;
  end if;
  -- Lent before these books (no bank entry): default one month before the first receipt.
  v_given := coalesce(v_given, (v_first - interval '1 month')::date);
  if v_given > v_first then raise exception 'The money must be lent on or before the first receipt'; end if;

  insert into public.loans_given
    (tenant_id, borrower_name, borrower_type, principal, given_on, interest_rate, repayment_plan, due_on,
     instalments, emi_amount, paid_from_account_id, bank_txn_id, notes, status, created_by)
  values
    (v_tenant, v_name, v_type, v_prin, v_given, v_rate, 'emi', v_first, v_n, v_emi,
     case when v_out_txn is not null then v_line.bank_account_id end, v_out_txn, v_notes, 'open', auth.uid())
  returning id into v_id;

  if v_out_txn is not null then
    perform public.reconcile_bank_txn(v_out_txn, 'loan_given', v_id::text, 'manual');
  end if;

  if v_in_txn is not null then
    v_rec := public.reconcile_bank_credit_to_loan_given(v_in_txn, v_id, null);
  end if;

  return jsonb_build_object('loan_id', v_id, 'receipt', v_rec);
end;
$$;
revoke all on function public.record_loan_given_from_bank(jsonb) from public, anon;
grant execute on function public.record_loan_given_from_bank(jsonb) to authenticated, service_role;

-- ── 4. Un-reconciling a 'loan_given' line ────────────────────────────────────────────────
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

drop trigger if exists trg_loan_given_line_unmatched on public.bank_transactions;
create trigger trg_loan_given_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_loan_given_line_unmatched();

-- ── 5. delete_loan_given — R-544 body (20261010140000) + an imported disbursal line is freed ──
create or replace function public.delete_loan_given(p_loan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_l      public.loans_given;
  v_n      integer;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can delete loans given.';
  end if;
  select * into v_l from public.loans_given where id = p_loan_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Loan not found in your company.'; end if;
  select count(*) into v_n from public.loan_repayments where loan_id = p_loan_id;
  if v_n > 0 then
    raise exception 'This loan has % repayment(s) recorded, so it cannot be deleted — it stays as history.', v_n;
  end if;
  if v_l.bank_txn_id is not null then
    delete from public.bank_transactions
     where id = v_l.bank_txn_id and tenant_id = v_tenant and source = 'manual';
    -- R-2340: an imported statement line (the money lent) stays — it is only freed.
    update public.bank_transactions
       set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
     where id = v_l.bank_txn_id and tenant_id = v_tenant and matched_to_type = 'loan_given';
  end if;
  delete from public.loans_given where id = p_loan_id and tenant_id = v_tenant;
end;
$$;
revoke all on function public.delete_loan_given(uuid) from public;
grant execute on function public.delete_loan_given(uuid) to authenticated;

commit;
