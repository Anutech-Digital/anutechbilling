-- deploy-peek: to_regclass('public.business_loan_drawdowns') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_debit_to_business_loan(uuid,uuid,integer,integer,integer)') and prosrc like '%R-2374%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_business_loan(uuid)') and prosrc like '%R-2374%')
-- deploy-key: r2374creditline
-- R-2374 (2 Nov 2026): a credit line (OD / flexi) from a lender, and the finance cost on it.
--
-- OD / loan audit (2 Nov): a Bajaj Finance flexi / OD (₹40L drawn, interest-only ACH every month,
-- a ₹1.2L principal repay) and a Tata Capital loan could not be booked right — the EMI loan
-- (R-2323) needs a fixed schedule, "Loan / advance with a person" makes loose lines with no
-- lender or outstanding, a money-out line could not be split into principal + interest, and there
-- was no "Interest on loans / OD" expense head.
--
-- ══ WHAT THIS ADDS ══════════════════════════════════════════════════════════════════════
--   business_loans.kind  'term' (every loan so far, default) | 'credit_line' (OD / flexi);
--   business_loans.credit_limit (credit line only, for reference — a drawdown over it is NOT
--   refused: an OD can go over its limit for a day, the screen shows it).
--   For a credit line business_loans.principal = everything drawn so far (the sum of its
--   drawdowns), so every reader of the loan — fetchBusinessLoans' outstanding, record_loan_emi's
--   guard and report_balance_sheet.business_loans_payable (sum(principal) − principal repaid) —
--   counts it with NO change to those readers. principal may be 0 for a credit line only.
--   business_loan_drawdowns  one row per drawdown: the money-in line it came on, or none
--   (opening outstanding — owed before these books; like a bank account's opening balance).
--   business_loan_payments gains bank_txn_id (the money-out line it was reconciled from) and
--   tds_part (TDS u/s 194A the company kept back from the interest; default 0).
--
--   record_credit_line(lender, purpose, limit, rate, start, opening)        → the loan id
--   reconcile_bank_credit_to_credit_line(txn, loan)                          → the drawdown id
--     MONEY: Dr Bank (the imported line) / Cr Credit line — outstanding up.
--   reconcile_bank_debit_to_business_loan(txn, loan, principal, interest, tds) → the payment id
--     Any business loan (term or credit line). principal + interest − tds = the line (±₹1).
--     MONEY: Dr Loan (principal) + Dr Interest on loans / OD (interest, P&L Finance cost)
--            / Cr Bank (the line) + Cr TDS payable u/s 194A (tds — on the interest expense row,
--            so dues_vendor_tds picks it up as for every expense with TDS).
--     Interest goes to expenses with category 'Interest on loans / OD', payment_method 'emi'
--     (cash is the bank line itself, so it never counts as payable / paid-unbanked — the
--     record_loan_emi / R-1864 rule).
--   tg_business_loan_bank_line_unmatched — Un-reconcile on the bank page reverses it:
--     a drawdown → the row goes, principal down (refused when more principal is already repaid
--     than would be left drawn); a repayment → the payment and its interest expense go.
--   delete_business_loan — R-2377 body + refused while a credit line has drawdowns on the books.
--
-- Matched types: 'loan_drawdown' (→ business_loan_drawdowns.id), 'loan_repayment'
-- (→ business_loan_payments.id). Role gate as record_business_loan (R-885 record group:
-- owner, manager, accountant, billing). Every write in one transaction, rows locked.
--
-- Proof: supabase/tests/r2374_credit_line.test.sql (one rollback).

begin;

-- ── 1. Columns + the drawdowns table ─────────────────────────────────────────────────────
alter table public.business_loans
  add column if not exists kind text not null default 'term',
  add column if not exists credit_limit integer;
alter table public.business_loans drop constraint if exists business_loans_kind_r2374;
alter table public.business_loans add constraint business_loans_kind_r2374 check (kind in ('term', 'credit_line'));
alter table public.business_loans drop constraint if exists business_loans_credit_limit_r2374;
alter table public.business_loans add constraint business_loans_credit_limit_r2374
  check (credit_limit is null or (credit_limit > 0 and kind = 'credit_line'));
-- principal > 0 for a term loan; a credit line starts at 0 drawn.
alter table public.business_loans drop constraint if exists business_loans_principal_check;
alter table public.business_loans add constraint business_loans_principal_check
  check (principal > 0 or (kind = 'credit_line' and principal >= 0));
comment on column public.business_loans.kind is
  'R-2374: term = a loan taken once (principal = the amount taken); credit_line = an OD / flexi line (principal = everything drawn, the sum of business_loan_drawdowns).';

create table if not exists public.business_loan_drawdowns (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  loan_id     uuid not null references public.business_loans(id) on delete cascade,
  amount      integer not null check (amount > 0),
  drawn_on    date not null,
  bank_txn_id uuid references public.bank_transactions(id) on delete set null,
  notes       text,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.users(id) on delete set null
);
create index if not exists business_loan_drawdowns_loan_idx on public.business_loan_drawdowns (loan_id);
create unique index if not exists business_loan_drawdowns_txn_uq on public.business_loan_drawdowns (bank_txn_id) where bank_txn_id is not null;
alter table public.business_loan_drawdowns enable row level security;
drop policy if exists "tenant isolation read" on public.business_loan_drawdowns;
create policy "tenant isolation read" on public.business_loan_drawdowns for select using (tenant_id = public.current_tenant_id());
-- writes only through the RPCs below (security definer)
revoke insert, update, delete on public.business_loan_drawdowns from anon, authenticated;
grant select on public.business_loan_drawdowns to authenticated;
grant all on public.business_loan_drawdowns to service_role;

alter table public.business_loan_payments
  add column if not exists bank_txn_id uuid references public.bank_transactions(id) on delete set null,
  add column if not exists tds_part integer not null default 0;
alter table public.business_loan_payments drop constraint if exists business_loan_payments_tds_r2374;
alter table public.business_loan_payments add constraint business_loan_payments_tds_r2374
  check (tds_part >= 0 and tds_part <= interest_part);
create unique index if not exists business_loan_payments_txn_uq on public.business_loan_payments (bank_txn_id) where bank_txn_id is not null;

-- ── 2. matched_to_type gains 'loan_drawdown', 'loan_repayment' (R-2340's pattern) ────────
do $$
declare v_def text; v_vals text[]; v_add text;
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
  if 'loan_drawdown' = any (v_vals) and 'loan_repayment' = any (v_vals) then return; end if;
  foreach v_add in array array['loan_drawdown', 'loan_repayment'] loop
    if not (v_add = any (v_vals)) then v_vals := array_append(v_vals, v_add); end if;
  end loop;
  execute 'alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check';
  execute format('alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check check (matched_to_type = any (%L::text[]))', v_vals);
end $$;

-- ── 3. The role gate (R-885 record group), one place ─────────────────────────────────────
create or replace function public.business_loan_guard(p_what text) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  -- R-2374: R-885's record group — owner, manager, accountant, billing; trusted = service_role
  -- or a direct DB session with no request role (R-454 / R-714 / R-717 / R-718).
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can %', p_what using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company on this login — sign in again' using errcode = '28000'; end if;
  return v_tenant;
end;
$$;
revoke all on function public.business_loan_guard(text) from public, anon, authenticated;

-- ── 4. Set up a credit line ──────────────────────────────────────────────────────────────
create or replace function public.record_credit_line(
  p_lender text, p_purpose text, p_limit integer, p_interest_rate numeric, p_start date, p_opening integer default 0
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.business_loan_guard('set up a credit line');
  v_open   integer := coalesce(p_opening, 0);
  v_id     uuid;
begin
  -- R-2374
  if trim(coalesce(p_lender, '')) = '' then raise exception 'Lender is required'; end if;
  if p_start is null then raise exception 'Enter the date the credit line started'; end if;
  if p_limit is not null and p_limit <= 0 then raise exception 'The limit must be more than ₹0 (or leave it empty)'; end if;
  if v_open < 0 then raise exception 'Opening outstanding cannot be negative'; end if;
  if p_interest_rate is not null and (p_interest_rate < 0 or p_interest_rate > 100) then
    raise exception 'Interest rate must be between 0 and 100 %% a year';
  end if;

  insert into public.business_loans
    (tenant_id, lender, purpose, principal, interest_rate, disbursed_on, status, created_by, kind, credit_limit)
  values
    (v_tenant, trim(p_lender), nullif(trim(coalesce(p_purpose, '')), ''), v_open, p_interest_rate, p_start,
     'active', auth.uid(), 'credit_line', p_limit)
  returning id into v_id;

  if v_open > 0 then
    -- owed before these books: no bank line (an opening balance, like a bank account's)
    insert into public.business_loan_drawdowns (tenant_id, loan_id, amount, drawn_on, notes, created_by)
    values (v_tenant, v_id, v_open, p_start, 'Opening outstanding', auth.uid());
  end if;
  return v_id;
end;
$$;
revoke all on function public.record_credit_line(text, text, integer, numeric, date, integer) from public, anon;
grant execute on function public.record_credit_line(text, text, integer, numeric, date, integer) to authenticated, service_role;

-- ── 5. Money in on a credit line = a drawdown ────────────────────────────────────────────
create or replace function public.reconcile_bank_credit_to_credit_line(p_bank_txn_id uuid, p_loan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.business_loan_guard('reconcile a credit line');
  v_l      public.business_loans;
  v_line   public.bank_transactions;
  v_amt    integer;
  v_id     uuid;
begin
  -- R-2374
  select * into v_l from public.business_loans where id = p_loan_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Credit line not found in your company'; end if;
  if v_l.kind <> 'credit_line' then raise exception 'Money in on a loan is a drawdown only on a credit line (OD / flexi)'; end if;

  select * into v_line from public.bank_transactions where id = p_bank_txn_id for update;
  if not found or v_line.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company'; end if;
  if coalesce(v_line.credit, 0) <= 0 or coalesce(v_line.debit, 0) <> 0 then raise exception 'Only a money-in line can be a drawdown'; end if;
  if v_line.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  v_amt := round(v_line.credit)::integer;
  if v_amt <= 0 then raise exception 'Only a money-in line can be a drawdown'; end if;

  insert into public.business_loan_drawdowns (tenant_id, loan_id, amount, drawn_on, bank_txn_id, created_by)
  values (v_tenant, v_l.id, v_amt, v_line.txn_date, v_line.id, auth.uid())
  returning id into v_id;
  update public.business_loans set principal = principal + v_amt, status = 'active', updated_at = now() where id = v_l.id;

  perform public.reconcile_bank_txn(p_bank_txn_id, 'loan_drawdown', v_id::text, 'manual');
  return v_id;
end;
$$;
revoke all on function public.reconcile_bank_credit_to_credit_line(uuid, uuid) from public, anon;
grant execute on function public.reconcile_bank_credit_to_credit_line(uuid, uuid) to authenticated, service_role;

-- ── 6. Money out to a lender = principal + interest (− TDS) ──────────────────────────────
create or replace function public.reconcile_bank_debit_to_business_loan(
  p_bank_txn_id uuid, p_loan_id uuid, p_principal integer, p_interest integer, p_tds integer default 0
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.business_loan_guard('reconcile a loan repayment');
  v_l      public.business_loans;
  v_line   public.bank_transactions;
  v_prin   integer := coalesce(p_principal, 0);
  v_int    integer := coalesce(p_interest, 0);
  v_tds    integer := coalesce(p_tds, 0);
  v_paid   integer;
  v_outstd integer;
  v_exp_id text;
  v_id     uuid;
begin
  -- R-2374
  if v_prin < 0 or v_int < 0 or v_tds < 0 then raise exception 'Principal, interest and TDS cannot be negative'; end if;
  if v_prin + v_int <= 0 then raise exception 'Enter the principal or the interest of this payment'; end if;
  if v_tds > v_int then raise exception 'TDS (₹%) cannot be more than the interest (₹%)', v_tds, v_int; end if;

  select * into v_l from public.business_loans where id = p_loan_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Loan not found in your company'; end if;

  select * into v_line from public.bank_transactions where id = p_bank_txn_id for update;
  if not found or v_line.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company'; end if;
  if coalesce(v_line.debit, 0) <= 0 or coalesce(v_line.credit, 0) <> 0 then raise exception 'Only a money-out line can be a loan repayment'; end if;
  if v_line.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if abs(v_line.debit - (v_prin + v_int - v_tds)) > 1 then
    raise exception 'Principal ₹% + interest ₹% − TDS ₹% = ₹%, but the line is ₹%', v_prin, v_int, v_tds, v_prin + v_int - v_tds, v_line.debit;
  end if;

  select coalesce(sum(principal_part), 0) into v_paid from public.business_loan_payments where loan_id = v_l.id;
  v_outstd := v_l.principal - v_paid;
  if v_prin > v_outstd then
    raise exception 'Principal ₹% is more than what is owed to % (₹%)', v_prin, v_l.lender, v_outstd;
  end if;

  if v_int > 0 then
    v_exp_id := public.emi_new_expense_id();
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, bill_type,
       paid, paid_date, bank_account_id, tds_section, tds_amount)
    values
      (v_exp_id, v_tenant, 'Interest on loans / OD', v_l.lender, v_line.txn_date, v_int, 0, 'emi',
       'Interest — ' || v_l.lender, 'none', true, v_line.txn_date, v_line.bank_account_id,
       case when v_tds > 0 then '194A' end, v_tds);
  end if;

  insert into public.business_loan_payments
    (tenant_id, loan_id, amount, principal_part, interest_part, tds_part, paid_on, bank_account_id, expense_id, bank_txn_id)
  values
    (v_tenant, v_l.id, v_prin + v_int, v_prin, v_int, v_tds, v_line.txn_date, v_line.bank_account_id, v_exp_id, v_line.id)
  returning id into v_id;

  update public.business_loans
     set status = case when v_l.kind = 'term' and v_outstd - v_prin <= 0 then 'closed' else 'active' end, updated_at = now()
   where id = v_l.id;

  perform public.reconcile_bank_txn(p_bank_txn_id, 'loan_repayment', v_id::text, 'manual');
  return v_id;
end;
$$;
revoke all on function public.reconcile_bank_debit_to_business_loan(uuid, uuid, integer, integer, integer) from public, anon;
grant execute on function public.reconcile_bank_debit_to_business_loan(uuid, uuid, integer, integer, integer) to authenticated, service_role;

-- ── 7. Un-reconcile on the bank page reverses it ─────────────────────────────────────────
create or replace function public.tg_business_loan_bank_line_unmatched() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_d    public.business_loan_drawdowns;
  v_p    public.business_loan_payments;
  v_l    public.business_loans;
  v_paid integer;
begin
  -- R-2374
  if old.matched_to_type = 'loan_drawdown'
     and (new.matched_to_type is distinct from old.matched_to_type or new.matched_to_id is distinct from old.matched_to_id) then
    select * into v_d from public.business_loan_drawdowns where bank_txn_id = old.id for update;
    if found then
      select * into v_l from public.business_loans where id = v_d.loan_id for update;
      select coalesce(sum(principal_part), 0) into v_paid from public.business_loan_payments where loan_id = v_l.id;
      if v_l.principal - v_d.amount < v_paid then
        raise exception 'Without this drawdown % would have ₹% drawn but ₹% principal is already repaid — un-reconcile those repayments first',
          v_l.lender, v_l.principal - v_d.amount, v_paid;
      end if;
      delete from public.business_loan_drawdowns where id = v_d.id;
      update public.business_loans set principal = principal - v_d.amount, updated_at = now() where id = v_l.id;
    end if;
  elsif old.matched_to_type = 'loan_repayment'
     and (new.matched_to_type is distinct from old.matched_to_type or new.matched_to_id is distinct from old.matched_to_id) then
    select * into v_p from public.business_loan_payments where bank_txn_id = old.id for update;
    if found then
      delete from public.business_loan_payments where id = v_p.id;
      if v_p.expense_id is not null then
        delete from public.expenses where id = v_p.expense_id and tenant_id = v_p.tenant_id;
      end if;
      update public.business_loans set status = 'active', updated_at = now() where id = v_p.loan_id;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.tg_business_loan_bank_line_unmatched() from public, anon, authenticated;

drop trigger if exists trg_business_loan_bank_line_unmatched on public.bank_transactions;
create trigger trg_business_loan_bank_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_business_loan_bank_line_unmatched();

-- ── 8. delete_business_loan — R-2377 body + a credit line with drawdowns is refused ─────
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
  v_draws  integer;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — delete group: owner, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. R-2377: an imported line is freed, not deleted.
     R-2374: a credit line goes only once its bank drawdowns are un-reconciled. */
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
  select count(*) into v_draws from public.business_loan_drawdowns where loan_id = p_loan_id and bank_txn_id is not null;
  if v_draws > 0 then
    raise exception 'This credit line has % drawdown(s) from the bank — un-reconcile those lines first', v_draws;
  end if;

  if v_l.disbursal_bank_txn_id is not null then
    -- the manual line Add loan made goes; an imported statement line stays and is only freed
    delete from public.bank_transactions
     where id = v_l.disbursal_bank_txn_id and tenant_id = v_tenant and source = 'manual';
    update public.bank_transactions
       set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
     where id = v_l.disbursal_bank_txn_id and tenant_id = v_tenant and matched_to_type = 'business_loan';
  elsif v_l.deposit_account_id is not null and v_l.kind = 'term' then
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
