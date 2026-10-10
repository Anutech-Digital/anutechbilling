-- deploy-key: loansgiven
-- deploy-peek: to_regclass('public.loan_repayments') is not null and exists(select 1 from pg_proc where proname = 'record_loan_repayment')
--
-- R-544 (10 Oct 2026, Abhishek's request, Pardeep said haan): "Loans given" — money this
-- business LENDS to outside parties (a person or a company). Not employees: staff loans and
-- salary advances already live in employee_loans (/accounting/loans) and expense advances
-- in /accounting/advances. Not loans TAKEN: those are business_loans (/accounting/business-loans).
--
-- MONEY RULES (whole rupees, CLAUDE.md §13)
--   • Giving a loan: cash LEAVES the chosen bank/cash account (a manual bank line, the same
--     way employee loans and business loans move cash) and the principal becomes an ASSET
--     (money owed back). It is never an expense.
--   • Interest (optional, % per year, 0 = interest-free) is SIMPLE interest on the principal
--     still outstanding, counted per day / 365. It is worked out in the app
--     (lib/accounting/loans-given.ts, unit-tested); this RPC checks the split it is handed.
--   • A repayment pays accrued interest FIRST, then principal. The interest part is income;
--     the principal part shrinks the asset. Cash comes IN to the chosen account.
--   • Outstanding never goes negative: a repayment whose principal part is more than the
--     principal still owed is refused with the maximum that can be taken.
--   • The loan closes when no principal is left.
--
-- WHO: owner and accountant only (card R-544). Reads are limited the same way in RLS so a
-- sales user cannot list who the company lent money to.

create table if not exists public.loans_given (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  borrower_name    text        not null check (length(trim(borrower_name)) between 1 and 200),
  borrower_type    text        not null default 'person' check (borrower_type in ('person', 'company')),
  customer_id      uuid        references public.customers(id) on delete set null,
  vendor_id        uuid        references public.vendors(id) on delete set null,
  principal        integer     not null check (principal > 0),
  given_on         date        not null,
  -- % per year, simple interest. 0 = interest-free.
  interest_rate    numeric(6,2) not null default 0 check (interest_rate >= 0 and interest_rate <= 100),
  -- one_shot: everything due on due_on (may be null = no fixed date).
  -- instalments: `instalments` equal monthly principal parts, the first on due_on.
  repayment_plan   text        not null default 'one_shot' check (repayment_plan in ('one_shot', 'instalments')),
  due_on           date,
  instalments      integer     check (instalments is null or (instalments between 1 and 360)),
  paid_from_account_id uuid    references public.bank_accounts(id) on delete set null,
  bank_txn_id      uuid        references public.bank_transactions(id) on delete set null,
  notes            text        check (notes is null or length(notes) <= 1000),
  status           text        not null default 'open' check (status in ('open', 'closed')),
  closed_on        date,
  created_by       uuid        references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint loans_given_plan_shape check (
    (repayment_plan = 'one_shot' and instalments is null)
    or (repayment_plan = 'instalments' and instalments is not null and due_on is not null)
  ),
  constraint loans_given_due_after_given check (due_on is null or due_on >= given_on)
);

comment on table public.loans_given is
  'R-544: money lent to outside parties (not employees — see employee_loans). Asset = principal − principal repaid.';

create table if not exists public.loan_repayments (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  loan_id          uuid        not null references public.loans_given(id) on delete cascade,
  repaid_on        date        not null,
  amount           integer     not null check (amount > 0),
  principal_part   integer     not null check (principal_part >= 0),
  interest_part    integer     not null default 0 check (interest_part >= 0),
  mode             text        not null default 'bank' check (mode in ('bank', 'upi', 'cash', 'cheque')),
  reference        text        check (reference is null or length(reference) <= 200),
  bank_account_id  uuid        references public.bank_accounts(id) on delete set null,
  bank_txn_id      uuid        references public.bank_transactions(id) on delete set null,
  notes            text        check (notes is null or length(notes) <= 1000),
  created_by       uuid        references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint loan_repayments_split check (principal_part + interest_part = amount)
);

create index if not exists loans_given_tenant_idx     on public.loans_given (tenant_id, status, given_on);
create index if not exists loan_repayments_loan_idx   on public.loan_repayments (loan_id, repaid_on);
create index if not exists loan_repayments_tenant_idx on public.loan_repayments (tenant_id);

alter table public.loans_given     enable row level security;
alter table public.loan_repayments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['loans_given', 'loan_repayments'] loop
    execute format('drop policy if exists "tenant isolation read"   on public.%I', t);
    execute format('drop policy if exists "tenant isolation write"  on public.%I', t);
    execute format('drop policy if exists "tenant isolation update" on public.%I', t);
    execute format('drop policy if exists "tenant isolation delete" on public.%I', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    -- Reads: same tenant AND owner / accountant. Writes go through the RPCs below only
    -- (no insert/update/delete policy for authenticated = direct writes are refused).
    execute format($p$create policy "tenant isolation read" on public.%I for select to authenticated
                     using (tenant_id = public.current_tenant_id()
                            and public.current_user_has_role('owner', 'accountant'))$p$, t);
    -- Cloud SQL has no BYPASSRLS: the service role needs its own policy on every table.
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

grant select on public.loans_given     to authenticated;
grant select on public.loan_repayments to authenticated;
grant select, insert, update, delete on public.loans_given     to service_role;
grant select, insert, update, delete on public.loan_repayments to service_role;


-- ── Give a loan: asset + cash OUT (atomic) ──────────────────────────────────
create or replace function public.give_loan(
  p_borrower_name   text,
  p_borrower_type   text,
  p_principal       integer,
  p_given_on        date,
  p_paid_from       uuid,
  p_interest_rate   numeric default 0,
  p_repayment_plan  text    default 'one_shot',
  p_due_on          date    default null,
  p_instalments     integer default null,
  p_customer_id     uuid    default null,
  p_vendor_id       uuid    default null,
  p_notes           text    default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_name   text := trim(coalesce(p_borrower_name, ''));
  v_id     uuid;
  v_txn    uuid;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can record loans given — ask your owner to do it.';
  end if;
  if v_name = '' then raise exception 'Add the borrower''s name.'; end if;
  if p_principal is null or p_principal <= 0 then raise exception 'Loan amount must be more than ₹0.'; end if;
  if p_given_on is null then raise exception 'Pick the date the loan was given.'; end if;
  if coalesce(p_interest_rate, 0) < 0 or coalesce(p_interest_rate, 0) > 100 then
    raise exception 'Interest must be between 0%% and 100%% a year (0 = interest-free).';
  end if;
  if coalesce(p_borrower_type, 'person') not in ('person', 'company') then
    raise exception 'Borrower type must be person or company.';
  end if;
  if coalesce(p_repayment_plan, 'one_shot') not in ('one_shot', 'instalments') then
    raise exception 'Pick how it will be repaid: one date, or monthly instalments.';
  end if;
  if p_repayment_plan = 'instalments' and (p_instalments is null or p_instalments < 1 or p_due_on is null) then
    raise exception 'For monthly instalments, add the number of months and the first due date.';
  end if;
  if p_due_on is not null and p_due_on < p_given_on then
    raise exception 'The due date is before the date the loan was given — check the dates.';
  end if;
  if p_paid_from is null then raise exception 'Pick the account the money was paid from.'; end if;
  perform 1 from public.bank_accounts where id = p_paid_from and tenant_id = v_tenant;
  if not found then raise exception 'That account is not in your company — pick another, or add it in Banking.'; end if;
  if p_customer_id is not null then
    perform 1 from public.customers where id = p_customer_id and tenant_id = v_tenant;
    if not found then raise exception 'That customer is not in your company.'; end if;
  end if;
  if p_vendor_id is not null then
    perform 1 from public.vendors where id = p_vendor_id and tenant_id = v_tenant;
    if not found then raise exception 'That vendor is not in your company.'; end if;
  end if;

  -- Cash out (money leaves the account → debit).
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_paid_from, p_given_on, 'Loan given: ' || v_name, p_principal, 0, 'manual', 'manual', 'manual')
  returning id into v_txn;

  insert into public.loans_given
    (tenant_id, borrower_name, borrower_type, customer_id, vendor_id, principal, given_on, interest_rate,
     repayment_plan, due_on, instalments, paid_from_account_id, bank_txn_id, notes, status, created_by)
  values
    (v_tenant, v_name, coalesce(p_borrower_type, 'person'), p_customer_id, p_vendor_id, p_principal, p_given_on,
     coalesce(p_interest_rate, 0), coalesce(p_repayment_plan, 'one_shot'), p_due_on,
     case when p_repayment_plan = 'instalments' then p_instalments else null end,
     p_paid_from, v_txn, nullif(trim(coalesce(p_notes, '')), ''), 'open', auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.give_loan(text, text, integer, date, uuid, numeric, text, date, integer, uuid, uuid, text) from public;
grant execute on function public.give_loan(text, text, integer, date, uuid, numeric, text, date, integer, uuid, uuid, text) to authenticated;


-- ── Record a repayment: cash IN; interest first, then principal (atomic) ────
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
  v_id        uuid;
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

  -- Cash in (money comes into the account → credit).
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_repaid_on,
     'Loan repayment: ' || v_l.borrower_name || case when v_int > 0 then ' (incl. ₹' || v_int || ' interest)' else '' end,
     0, p_amount, 'manual', 'manual', 'manual')
  returning id into v_txn;

  insert into public.loan_repayments
    (tenant_id, loan_id, repaid_on, amount, principal_part, interest_part, mode, reference,
     bank_account_id, bank_txn_id, notes, created_by)
  values
    (v_tenant, p_loan_id, p_repaid_on, p_amount, v_prin, v_int, coalesce(p_mode, 'bank'),
     nullif(trim(coalesce(p_reference, '')), ''), p_bank_account_id, v_txn,
     nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;

  update public.loans_given
     set status = case when v_left - v_prin <= 0 then 'closed' else 'open' end,
         closed_on = case when v_left - v_prin <= 0 then p_repaid_on else null end,
         updated_at = now()
   where id = p_loan_id;

  return v_id;
end;
$$;

revoke all on function public.record_loan_repayment(uuid, date, integer, integer, uuid, text, text, text) from public;
grant execute on function public.record_loan_repayment(uuid, date, integer, integer, uuid, text, text, text) to authenticated;


-- ── Delete a loan (only before any repayment): reverse the cash-out line ────
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
  end if;
  delete from public.loans_given where id = p_loan_id and tenant_id = v_tenant;
end;
$$;

revoke all on function public.delete_loan_given(uuid) from public;
grant execute on function public.delete_loan_given(uuid) to authenticated;


-- ── Balance Sheet figure: principal still owed to us (one number, no names) ──
-- The Balance Sheet is open to the manager too (SALARY_ROLES); the loan list is not. This
-- returns only the total, so the manager's sheet balances without showing who borrowed.
create or replace function public.loans_given_asset()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_tenant_id() is null
      or not public.current_user_has_role('owner', 'manager', 'accountant') then 0::bigint
    else greatest(0,
        (select coalesce(sum(l.principal), 0) from public.loans_given l where l.tenant_id = public.current_tenant_id())
      - (select coalesce(sum(r.principal_part), 0) from public.loan_repayments r where r.tenant_id = public.current_tenant_id())
    )::bigint
  end;
$$;

revoke all on function public.loans_given_asset() from public;
grant execute on function public.loans_given_asset() to authenticated;
