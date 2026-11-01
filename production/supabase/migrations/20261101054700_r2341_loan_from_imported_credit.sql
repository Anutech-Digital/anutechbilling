-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_emi_loan_taken(jsonb)') and prosrc like '%R-2341%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_emi_line_unmatched()') and prosrc like '%R-2341%')
-- deploy-key: r2341loanimportedcredit
-- R-2341 (1 Nov 2026): Set up this loan — the loan money can be the money-in line the bank
-- statement ALREADY has, instead of a new manual line.
--
-- R-2323 (20261101025326) made "Loan money came into <account>" add ONE manual money-in line.
-- When the statement with that disbursal credit is imported too, the same money is in the bank
-- twice (cash counted twice). Owner decision (1 Nov): the default stays "Taken before these
-- books — no bank entry"; this only changes what "came into an account" can point at.
--
-- record_emi_loan_taken(p jsonb) — R-2323 body + optional p.received_txn_id:
--   the imported money-in line for the loan amount. Guards (refused, nothing written): the line is
--   in the caller's company, on p.account_id, money in (credit > 0, no debit), not reconciled,
--   and its amount is the loan amount within ₹1. The line's date is the date the money came in.
--   It is locked (for update), matched once to the loan (matched_to_type 'emi', the R-1864 mark)
--   and stored as emi_purchases.received_bank_txn_id — no new line. Without it: R-2323 as is.
--   Same money rule as R-2323: Dr Bank (the existing line) / Cr loan.
--
-- tg_emi_line_unmatched — R-1864 body + one branch: un-reconciling an IMPORTED line that is a
--   'loan''s received line (bank page → Un-reconcile) removes that loan (schedule cascades) and
--   frees the line, so the books are as before the set-up. Refused while any EMI of the loan is
--   on the books (undo those first — R-1864's latest-first rule). A manual received line stays
--   refused as in R-1864 ("made by an EMI entry").
--
-- Proof: supabase/tests/r2341_loan_from_imported_credit.test.sql (one rollback); R-1864 / R-2323
-- tests unchanged.

begin;

-- ── 1. record_emi_loan_taken — R-2323 body + received_txn_id ─────────────────────────────
create or replace function public.record_emi_loan_taken(p jsonb) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.emi_guard('set up a loan');
  v_lender   text := nullif(trim(coalesce(p ->> 'lender', '')), '');
  v_ref      text := nullif(trim(coalesce(p ->> 'lender_ref', '')), '');
  v_prin     integer := (p ->> 'principal')::integer;
  v_rate     numeric := nullif(p ->> 'interest_rate', '')::numeric;
  v_account  uuid := nullif(p ->> 'account_id', '')::uuid;
  v_recv_on  date := nullif(p ->> 'received_on', '')::date;
  v_recv_txn uuid := nullif(p ->> 'received_txn_id', '')::uuid;
  v_txn_id   uuid := nullif(p ->> 'reconcile_txn_id', '')::uuid;
  v_rows     jsonb := p -> 'schedule';
  v_first    date := (v_rows -> 0 ->> 'due_on')::date;
  v_id       uuid := gen_random_uuid();
  v_line     public.bank_transactions;
  v_rec      jsonb;
begin
  -- R-2323, R-2341
  if v_lender is null then raise exception 'Enter the lender (bank / NBFC)'; end if;
  if char_length(v_lender) > 100 then raise exception 'Keep the lender name under 100 characters'; end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'Keep the loan number under 60 characters'; end if;
  if v_prin is null or v_prin <= 0 then raise exception 'Enter the amount still owed'; end if;
  if v_rate is null or v_rate < 0 or v_rate > 60 then raise exception 'Enter the interest rate (0 to 60%% a year)'; end if;
  if v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 or v_first is null then
    raise exception 'The EMI schedule is missing';
  end if;

  -- R-2341: the loan money is a line already on the statement.
  if v_recv_txn is not null then
    if v_account is null then raise exception 'Pick the account the loan money came into'; end if;
    select * into v_line from public.bank_transactions where id = v_recv_txn for update;
    if not found or v_line.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company'; end if;
    if v_line.bank_account_id is distinct from v_account then
      raise exception 'That bank line is not on the account the loan money came into';
    end if;
    if coalesce(v_line.credit, 0) <= 0 or coalesce(v_line.debit, 0) <> 0 then
      raise exception 'Only a money-in line can be the loan money';
    end if;
    if v_line.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
    if abs(v_line.credit - v_prin) > 1 then
      raise exception 'This line is ₹% but the loan is ₹% — pick the line for the loan amount', v_line.credit, v_prin;
    end if;
    v_recv_on := v_line.txn_date;
  end if;

  if v_account is not null then
    if v_recv_on is null then raise exception 'Enter the date the loan money came in'; end if;
    if v_recv_on > v_first then raise exception 'The loan money must come in on or before the first EMI'; end if;
    perform 1 from public.bank_accounts where id = v_account and tenant_id = v_tenant;
    if not found then raise exception 'That bank / cash account is not in your company'; end if;
  end if;

  insert into public.emi_purchases
    (id, tenant_id, name, category, total_cost, down_payment, financed, emi_count, emi_amount, purchased_on,
     lender, status, created_by, interest_rate, no_cost, first_emi_on, lender_ref, kind)
  values
    (v_id, v_tenant, 'Loan — ' || v_lender, 'other', v_prin, 0, v_prin, jsonb_array_length(v_rows),
     (v_rows -> 0 ->> 'emi')::integer, coalesce(v_recv_on, v_first),
     v_lender, 'active', public.current_user_id(), v_rate, v_rate = 0, v_first, v_ref, 'loan');

  perform public.emi_replace_unpaid_schedule(v_tenant, v_id, 1, v_prin, v_rows, v_rate = 0, coalesce(v_recv_on, v_first));

  if v_account is not null then
    if v_recv_txn is null then
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source)
      values (v_tenant, v_account, v_recv_on, 'Loan received: ' || v_lender, 0, v_prin, 'manual')
      returning * into v_line;
    end if;
    perform public.emi_mark_line(v_line.id, v_id);
    update public.emi_purchases set received_bank_txn_id = v_line.id where id = v_id;
  end if;

  if v_txn_id is not null then
    v_rec := public.reconcile_bank_debit_to_emi(v_txn_id, v_id, 1);
  end if;

  return jsonb_build_object('purchase_id', v_id, 'reconciled', v_rec);
end;
$$;
revoke all on function public.record_emi_loan_taken(jsonb) from public, anon;
grant execute on function public.record_emi_loan_taken(jsonb) to authenticated, service_role;

-- ── 2. Un-reconciling an EMI line — R-1864 body + a loan's imported money-in line ────────
create or replace function public.tg_emi_line_unmatched() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pay public.emi_payments;
  v_p   public.emi_purchases;
  v_new public.bank_transactions;
  v_n   integer;
begin
  if old.matched_to_type = 'emi'
     and (new.matched_to_type is distinct from 'emi' or new.matched_to_id is distinct from old.matched_to_id) then
    if old.source = 'manual' then
      raise exception 'This line was made by an EMI entry — undo it on Assets & EMIs instead';
    end if;
    select * into v_pay from public.emi_payments where bank_txn_id = old.id;
    if found then
      perform public.emi_undo_payment_core(v_pay);
      return null;
    end if;
    select * into v_p from public.emi_purchases where down_bank_txn_id = old.id;
    if found then
      -- The down payment did leave the bank: back to a manual line, so cash stays right.
      v_new := public.emi_manual_line(v_p.tenant_id, old.bank_account_id, old.txn_date, old.debit,
                 'Down payment: ' || v_p.name || ' (' || coalesce(v_p.lender, '') || ')');
      perform public.emi_mark_line(v_new.id, v_p.id);
      update public.emi_purchases set down_bank_txn_id = v_new.id where id = v_p.id;
      return null;
    end if;
    -- R-2341: the statement's money-in line of a loan set up from an EMI line → remove that loan.
    select * into v_p from public.emi_purchases where received_bank_txn_id = old.id and kind = 'loan' for update;
    if found then
      select count(*) into v_n from public.emi_payments where purchase_id = v_p.id;
      if v_n > 0 then
        raise exception 'This line is the money of the loan from % and % EMI(s) of it are reconciled — undo those EMIs first, then un-reconcile this line',
          coalesce(v_p.lender, 'the lender'), v_n;
      end if;
      delete from public.emi_purchases where id = v_p.id;  -- its schedule goes with it (on delete cascade)
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.tg_emi_line_unmatched() from public, anon, authenticated;

commit;
