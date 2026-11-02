-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_business_loan(text,text,integer,numeric,integer,integer,date,uuid,uuid)') and prosrc like '%R-2377%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_business_loan(uuid)') and prosrc like '%R-2377%') and to_regprocedure('public.record_director_loan_taken(uuid,integer,date,uuid,numeric,boolean,text,uuid)') is not null and to_regprocedure('public.tg_business_loan_line_unmatched()') is not null
-- deploy-key: r2377bizloanimported
-- R-2377 (2 Nov 2026): Business Loans → "Add loan" can link the money-in line the bank statement
-- ALREADY has, instead of always adding a new one.
--
-- OD / loan audit (2 Nov): record_business_loan (R-885 body, 20261012025800) always inserted a
-- manual money-in line. For a lender credit already in the imported statement (₹40,00,000 from
-- Bajaj Finance on 6 Jun) that counts the same cash twice. Same idea as R-2341 (loan from an
-- imported credit, EMI loans) and R-2340 (loan given, the other direction).
--
--   record_business_loan(…, p_bank_txn_id uuid) — the R-885 body + the optional imported line.
--     Guards (refused, nothing written): the line is in the caller's company, on the deposit
--     account, money in (credit > 0, no debit), not reconciled, its amount is the loan amount
--     within ₹1. The line's date is the date the money came in (disbursed_on). It is locked,
--     matched once ('business_loan' → the loan) and stored as business_loans.disbursal_bank_txn_id
--     — no new line. Without it: a new manual line as before (now also stored on the loan).
--     MONEY: Dr Bank (the existing line) / Cr Business loan — cash counted once.
--   record_business_loan(8 args) — unchanged signature, now calls the 9-arg one with no line
--     (R-885's role gate lives there), so older callers keep working.
--   record_director_loan_taken(…, p_bank_txn_id uuid) — the R-1853 body passing the line on; the
--     7-arg one calls it with none.
--   delete_business_loan — R-885 body + an imported disbursal line is freed, never deleted.
--   tg_business_loan_line_unmatched — un-reconciling that line on the bank page removes the loan
--     (refused while an EMI of it is on the books), so the books are as before Add loan.
--
-- Proof: supabase/tests/r2377_business_loan_from_imported_credit.test.sql (one rollback).

begin;

-- ── 1. matched_to_type gains 'business_loan' (R-2340's pattern: read the live list, add one) ──
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
  if 'business_loan' = any (v_vals) then return; end if;
  v_vals := array_append(v_vals, 'business_loan'::text);
  execute 'alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check';
  execute format('alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check check (matched_to_type = any (%L::text[]))', v_vals);
end $$;

-- ── 2. The loan's money-in line ────────────────────────────────────────────────────────────
alter table public.business_loans
  add column if not exists disbursal_bank_txn_id uuid references public.bank_transactions(id) on delete set null;
create index if not exists business_loans_disbursal_bank_txn_idx
  on public.business_loans (disbursal_bank_txn_id) where disbursal_bank_txn_id is not null;
comment on column public.business_loans.disbursal_bank_txn_id is
  'R-2377: the bank line the loan money came in on — an imported statement line (matched_to_type business_loan) or the manual line Add loan made.';

-- ── 3. record_business_loan — R-885 body + the optional imported line ─────────────────────
create or replace function public.record_business_loan(
  p_lender text, p_purpose text, p_principal integer, p_interest_rate numeric, p_tenure_months integer,
  p_emi_amount integer, p_disbursed_on date, p_deposit_account uuid, p_bank_txn_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
  v_on     date := p_disbursed_on;
  v_line   public.bank_transactions;
  v_txn    uuid;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. R-2377: + the imported money-in line. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a business loan' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_principal is null or p_principal <= 0 then raise exception 'Loan amount must be positive'; end if;
  if trim(coalesce(p_lender, '')) = '' then raise exception 'Lender is required'; end if;
  if p_deposit_account is null then raise exception 'Pick the account the money was received into'; end if;
  perform 1 from public.bank_accounts where id = p_deposit_account and tenant_id = v_tenant;
  if not found then raise exception 'Deposit account not found'; end if;

  -- R-2377: the loan money is a line already on the statement.
  if p_bank_txn_id is not null then
    select * into v_line from public.bank_transactions where id = p_bank_txn_id for update;
    if not found or v_line.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company'; end if;
    if v_line.bank_account_id is distinct from p_deposit_account then
      raise exception 'That bank line is not on the account the loan money came into';
    end if;
    if coalesce(v_line.credit, 0) <= 0 or coalesce(v_line.debit, 0) <> 0 then
      raise exception 'Only a money-in line can be the loan money';
    end if;
    if v_line.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
    if abs(v_line.credit - p_principal) > 1 then
      raise exception 'This line is ₹% but the loan is ₹% — pick the line for the loan amount', v_line.credit, p_principal;
    end if;
    v_on := v_line.txn_date;
  end if;
  if v_on is null then raise exception 'Enter the date the loan money came in'; end if;

  insert into public.business_loans
    (tenant_id, lender, purpose, principal, interest_rate, tenure_months, emi_amount, disbursed_on, deposit_account_id, status, created_by)
  values
    (v_tenant, trim(p_lender), nullif(trim(coalesce(p_purpose,'')),''), p_principal,
     p_interest_rate, nullif(greatest(coalesce(p_tenure_months,0),0),0), nullif(greatest(coalesce(p_emi_amount,0),0),0),
     v_on, p_deposit_account, 'active', auth.uid())
  returning id into v_id;

  if p_bank_txn_id is not null then
    perform public.reconcile_bank_txn(p_bank_txn_id, 'business_loan', v_id::text, 'manual');
    v_txn := p_bank_txn_id;
  else
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_deposit_account, v_on, 'Loan received: ' || trim(p_lender), 0, p_principal, 'manual', 'manual', 'manual')
    returning id into v_txn;
  end if;
  update public.business_loans set disbursal_bank_txn_id = v_txn where id = v_id;

  return v_id;
end;
$$;
revoke all on function public.record_business_loan(text, text, integer, numeric, integer, integer, date, uuid, uuid) from public, anon;
grant execute on function public.record_business_loan(text, text, integer, numeric, integer, integer, date, uuid, uuid) to authenticated, service_role;

-- The 8-arg one (R-885 callers, record_director_loan_taken's 7-arg form): no imported line.
create or replace function public.record_business_loan(
  p_lender text, p_purpose text, p_principal integer, p_interest_rate numeric, p_tenure_months integer,
  p_emi_amount integer, p_disbursed_on date, p_deposit_account uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-885 role gate + body: in the 9-arg record_business_loan (R-2377), called with no imported line. */
  return public.record_business_loan(p_lender, p_purpose, p_principal, p_interest_rate, p_tenure_months,
                                     p_emi_amount, p_disbursed_on, p_deposit_account, null::uuid);
end;
$$;

-- ── 4. A loan FROM a director — R-1853 body + the imported line ──────────────────────────
create or replace function public.record_director_loan_taken(
  p_director_id     uuid,
  p_principal       integer,
  p_disbursed_on    date,
  p_deposit_account uuid,
  p_interest_rate   numeric,
  p_declaration     boolean,
  p_purpose         text,
  p_bank_txn_id     uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  /* R-1853, R-2377 */
  v_trusted boolean;
  v_tenant  uuid := public.current_tenant_id();
  v_type    text;
  v_dir     public.company_directors;
  v_id      uuid;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can record a loan from a director' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is not null and v_type <> 'pvt_ltd' then
    raise exception 'Loans from directors are for a Pvt Ltd company — record this as a business loan instead.';
  end if;

  if p_director_id is null then raise exception 'Pick the director from the directors register.'; end if;
  select * into v_dir from public.company_directors where id = p_director_id and tenant_id = v_tenant;
  if not found then raise exception 'That director is not in your directors register.'; end if;
  if p_disbursed_on is not null and v_dir.ceased_on is not null and p_disbursed_on > v_dir.ceased_on then
    raise exception '% was not a director on % (ceased %).', v_dir.name, to_char(p_disbursed_on, 'DD Mon YYYY'), to_char(v_dir.ceased_on, 'DD Mon YYYY');
  end if;
  if p_declaration is null then
    raise exception 'Say whether you have the director''s written declaration that this money is not borrowed from others.';
  end if;
  if p_disbursed_on is null then raise exception 'Pick the date the money came in.'; end if;

  v_id := public.record_business_loan(v_dir.name, p_purpose, p_principal, p_interest_rate, null, null, p_disbursed_on, p_deposit_account, p_bank_txn_id);
  update public.business_loans set director_id = v_dir.id, director_declaration = p_declaration where id = v_id;
  return v_id;
end;
$$;
revoke all on function public.record_director_loan_taken(uuid, integer, date, uuid, numeric, boolean, text, uuid) from public, anon;
grant execute on function public.record_director_loan_taken(uuid, integer, date, uuid, numeric, boolean, text, uuid) to authenticated, service_role;

create or replace function public.record_director_loan_taken(
  p_director_id     uuid,
  p_principal       integer,
  p_disbursed_on    date,
  p_deposit_account uuid,
  p_interest_rate   numeric,
  p_declaration     boolean,
  p_purpose         text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-1853 body: in the 8-arg record_director_loan_taken (R-2377), called with no imported line. */
  return public.record_director_loan_taken(p_director_id, p_principal, p_disbursed_on, p_deposit_account,
                                           p_interest_rate, p_declaration, p_purpose, null::uuid);
end;
$$;

-- ── 5. Un-reconciling a 'business_loan' line on the bank page removes that loan ───────────
create or replace function public.tg_business_loan_line_unmatched() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_l public.business_loans;
  v_n integer;
begin
  -- R-2377
  if old.matched_to_type = 'business_loan'
     and (new.matched_to_type is distinct from 'business_loan' or new.matched_to_id is distinct from old.matched_to_id) then
    select * into v_l from public.business_loans where disbursal_bank_txn_id = old.id for update;
    if found then
      select count(*) into v_n from public.business_loan_payments where loan_id = v_l.id;
      if v_n > 0 then
        raise exception 'This line is the money of the loan from % and % EMI payment(s) of it are recorded — delete those first, then un-reconcile this line',
          v_l.lender, v_n;
      end if;
      delete from public.business_loans where id = v_l.id;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.tg_business_loan_line_unmatched() from public, anon, authenticated;

drop trigger if exists trg_business_loan_line_unmatched on public.bank_transactions;
create trigger trg_business_loan_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_business_loan_line_unmatched();

-- ── 6. delete_business_loan — R-885 body + an imported disbursal line is freed ────────────
create or replace function public.delete_business_loan(p_loan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_l      public.business_loans;
  v_pays   integer;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — delete group: owner, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. R-2377: an imported line is freed, not deleted. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a business loan' using errcode = '42501';
  end if;
  select * into v_l from public.business_loans where id = p_loan_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Loan not found'; end if;

  select count(*) into v_pays from public.business_loan_payments where loan_id = p_loan_id;
  if v_pays > 0 then
    raise exception 'This loan has % EMI payment(s) recorded — delete those first', v_pays;
  end if;

  if v_l.disbursal_bank_txn_id is not null then
    -- the manual line Add loan made goes; an imported statement line stays and is only freed
    delete from public.bank_transactions
     where id = v_l.disbursal_bank_txn_id and tenant_id = v_tenant and source = 'manual';
    update public.bank_transactions
       set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
     where id = v_l.disbursal_bank_txn_id and tenant_id = v_tenant and matched_to_type = 'business_loan';
  elsif v_l.deposit_account_id is not null then
    -- loans recorded before R-2377: the manual line by its description (R-885 rule)
    delete from public.bank_transactions
     where tenant_id = v_tenant
       and bank_account_id = v_l.deposit_account_id
       and txn_date = v_l.disbursed_on
       and credit = v_l.principal
       and description = 'Loan received: ' || v_l.lender;
  end if;

  delete from public.business_loans where id = p_loan_id;
end;
$$;

commit;
