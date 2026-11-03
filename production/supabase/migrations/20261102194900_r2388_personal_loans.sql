-- deploy-peek: (to_regclass('public.personal_loans') is not null and to_regclass('public.personal_loan_payments') is not null and to_regprocedure('public.personal_loan_record_payment(uuid,text,date,bigint,bigint,uuid,text)') is not null and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'personal_loan_payments' and policyname = 'personal_loan_payments_service_role'))
-- deploy-key: r2388personalloans
-- R-2388 (goal G-PERSONAL, 2 Nov 2026): Private Vault → Loans (taken and given).
--
-- Pardeep (2 Nov): "personal loan management system hona chahiye". The personal ledger had
-- no loans: a home / car / personal loan with EMIs, or money lent to family, could not be
-- tracked, and Net worth ignored both.
--
-- What this adds
--   * personal_loans — one row per loan:
--       direction  'taken' (I borrowed: home, car, personal, education, gold, overdraft, from
--                  a person, other) or 'given' (I lent: to a person, other)
--       party, principal (whole rupees), start_date, annual_rate (optional, % a year),
--       repay_type 'emi' (reducing balance, needs tenure + EMI) / 'interest_only' (needs a
--       rate) / 'no_interest', tenure_months, emi_amount, first_due_on (optional; else one
--       month after start), account_id (owner-safe composite FK like GP-12a), note,
--       status open/closed + closed_on.
--   * personal_loan_payments — one row per instalment / prepayment / interest / repayment,
--       principal_part + interest_part (whole rupees), and the personal_transactions it made.
--   * personal_loan_balances (view, security_invoker) — principal paid, interest paid,
--       outstanding = principal − principal paid, count of EMIs paid.
--   * personal_loan_record_payment(...) — ONE atomic call (§17b) that writes the payment row
--       AND its ledger entries, and closes the loan when nothing is left:
--         taken: interest → kind 'expense', category 'Loan EMI' (a cost);
--                principal → kind 'transfer_out', category 'Loan repayment' (NOT spend — it
--                lowers what you owe, the money is not gone).
--         given: principal back → kind 'transfer_in', category 'Loan repayment received' (NOT
--                income — it was your money); interest → kind 'interest', income_source
--                'interest' (R-2387, ITR head Other sources).
--       For an EMI with no split given, the split is the reducing-balance one:
--         interest = round(outstanding × rate / 12 / 100), principal = EMI − interest
--         (capped at the outstanding). Interest-only: interest = the month's interest.
--   * personal_loan_undo_payment(id) — removes a payment and its ledger entries (re-opens a
--       loan the payment had closed).
--
-- Net worth (Overview, lib/vault/personal/net-worth.ts): + outstanding of loans GIVEN
-- (money owed to you, an asset) − outstanding of loans TAKEN (joins card dues and R-2386
-- owe/hold in owedTotal). A closed loan no longer counts.
--
-- The privacy rule is the one from 20260819170000_owner_personal_vault.sql, unchanged:
--     owner_user_id = auth.uid()  AND  tenant_id = current_tenant_id()
-- plus the R-450 service_role policy (Cloud SQL has no BYPASSRLS). Both functions are
-- SECURITY INVOKER: the caller's RLS decides which loan exists.
-- Date defaults are the IST day (public.ist_today(), R-2391), never current_date.

begin;

-- ─── 1. loans ──────────────────────────────────────────────────────────────
create table if not exists public.personal_loans (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  direction     text not null check (direction in ('taken', 'given')),
  loan_kind     text not null check (loan_kind in
                  ('home', 'car', 'personal', 'education', 'gold', 'overdraft', 'person', 'other')),
  party         text not null check (length(btrim(party)) between 1 and 120),
  principal     bigint not null check (principal > 0 and principal <= 1000000000000),
  start_date    date not null default public.ist_today(),
  annual_rate   numeric(6,3) check (annual_rate is null or (annual_rate >= 0 and annual_rate <= 100)),
  repay_type    text not null default 'emi' check (repay_type in ('emi', 'interest_only', 'no_interest')),
  tenure_months integer check (tenure_months is null or tenure_months between 1 and 600),
  emi_amount    bigint check (emi_amount is null or (emi_amount > 0 and emi_amount <= 1000000000000)),
  first_due_on  date,
  account_id    uuid,
  note          text check (note is null or length(note) <= 500),
  status        text not null default 'open' check (status in ('open', 'closed')),
  closed_on     date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- An EMI loan needs its tenure and EMI; interest-only needs a rate.
  constraint personal_loans_emi_check check (
    repay_type <> 'emi' or (tenure_months is not null and emi_amount is not null)),
  constraint personal_loans_interest_only_check check (
    repay_type <> 'interest_only' or (annual_rate is not null and annual_rate > 0)),
  -- Money lent is to a person (or other) — a bank never borrows from you.
  constraint personal_loans_given_kind_check check (
    direction = 'taken' or loan_kind in ('person', 'other')),
  constraint personal_loans_closed_check check (
    (status = 'open' and closed_on is null) or (status = 'closed' and closed_on is not null)),
  constraint personal_loans_id_owner_key unique (id, owner_user_id),
  constraint personal_loans_account_owner_fkey
    foreign key (account_id, owner_user_id)
    references public.personal_accounts (id, owner_user_id)
    on delete set null (account_id)
);

comment on table public.personal_loans is
  'R-2388: loans the person took (home, car, personal, …) or gave (to a person). Outstanding = principal − principal repaid (personal_loan_balances). Given = asset, taken = liability in Private Vault net worth. Private to owner_user_id.';
comment on column public.personal_loans.annual_rate is 'Interest rate, % a year (reducing balance). Null = not known / no interest.';
comment on column public.personal_loans.first_due_on is 'Date of the first EMI / interest payment. Null = one month after start_date.';
comment on column public.personal_loans.account_id is 'The personal account EMIs are paid from (taken) or repayments come into (given). Default for each payment.';

create index if not exists personal_loans_owner_idx
  on public.personal_loans (owner_user_id, status, direction);
create index if not exists personal_loans_account_idx
  on public.personal_loans (account_id, owner_user_id) where account_id is not null;

-- ─── 2. payments ───────────────────────────────────────────────────────────
create table if not exists public.personal_loan_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  owner_user_id   uuid not null references public.users(id) on delete cascade,
  loan_id         uuid not null,
  kind            text not null check (kind in ('emi', 'prepayment', 'interest', 'repayment')),
  paid_on         date not null default public.ist_today(),
  principal_part  bigint not null default 0 check (principal_part >= 0 and principal_part <= 1000000000000),
  interest_part   bigint not null default 0 check (interest_part >= 0 and interest_part <= 1000000000000),
  account_id      uuid,
  principal_tx_id uuid references public.personal_transactions(id) on delete set null,
  interest_tx_id  uuid references public.personal_transactions(id) on delete set null,
  note            text check (note is null or length(note) <= 500),
  created_at      timestamptz not null default now(),
  constraint personal_loan_payments_nonzero_check check (principal_part + interest_part > 0),
  -- An interest payment carries no principal.
  constraint personal_loan_payments_interest_kind_check check (kind <> 'interest' or principal_part = 0),
  -- Owner-safe: the payment's loan and account belong to the same person.
  constraint personal_loan_payments_loan_owner_fkey
    foreign key (loan_id, owner_user_id)
    references public.personal_loans (id, owner_user_id)
    on delete cascade,
  constraint personal_loan_payments_account_owner_fkey
    foreign key (account_id, owner_user_id)
    references public.personal_accounts (id, owner_user_id)
    on delete set null (account_id)
);

comment on table public.personal_loan_payments is
  'R-2388: one EMI / prepayment / interest / repayment on a personal loan, split into principal and interest, with the personal_transactions it created. Written by personal_loan_record_payment. Private to owner_user_id.';

create index if not exists personal_loan_payments_loan_idx
  on public.personal_loan_payments (loan_id, paid_on);
create index if not exists personal_loan_payments_owner_idx
  on public.personal_loan_payments (owner_user_id, paid_on desc);

-- ─── 3. RLS (owner only) + R-450 service_role ──────────────────────────────
alter table public.personal_loans         enable row level security;
alter table public.personal_loan_payments enable row level security;

drop policy if exists personal_loans_all on public.personal_loans;
create policy personal_loans_all on public.personal_loans
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

drop policy if exists personal_loans_service_role on public.personal_loans;
create policy personal_loans_service_role on public.personal_loans
  for all to service_role using (true) with check (true);

drop policy if exists personal_loan_payments_all on public.personal_loan_payments;
create policy personal_loan_payments_all on public.personal_loan_payments
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

drop policy if exists personal_loan_payments_service_role on public.personal_loan_payments;
create policy personal_loan_payments_service_role on public.personal_loan_payments
  for all to service_role using (true) with check (true);

revoke all on public.personal_loans, public.personal_loan_payments from anon, public;
grant select, insert, update, delete on public.personal_loans, public.personal_loan_payments to authenticated;
grant all on public.personal_loans, public.personal_loan_payments to service_role;

-- ─── 4. balances view ──────────────────────────────────────────────────────
create or replace view public.personal_loan_balances
with (security_invoker = true) as
select l.id                                          as loan_id,
       l.tenant_id,
       l.owner_user_id,
       l.direction,
       l.status,
       l.principal,
       coalesce(p.principal_paid, 0)::bigint          as principal_paid,
       coalesce(p.interest_paid, 0)::bigint           as interest_paid,
       greatest(l.principal - coalesce(p.principal_paid, 0), 0)::bigint as outstanding,
       coalesce(p.emi_count, 0)::integer              as emi_paid_count,
       coalesce(p.payment_count, 0)::integer          as payment_count,
       p.last_paid_on
  from public.personal_loans l
  left join (
    select loan_id,
           sum(principal_part)                       as principal_paid,
           sum(interest_part)                        as interest_paid,
           count(*) filter (where kind in ('emi', 'interest')) as emi_count,
           count(*)                                  as payment_count,
           max(paid_on)                              as last_paid_on
      from public.personal_loan_payments
     group by loan_id
  ) p on p.loan_id = l.id;

comment on view public.personal_loan_balances is
  'R-2388: per loan — principal paid, interest paid, outstanding (principal − principal paid, never below 0), EMIs paid. security_invoker: the caller''s owner policy decides which rows exist.';

revoke all on public.personal_loan_balances from anon, public;
grant select on public.personal_loan_balances to authenticated, service_role;

-- ─── 5. record a payment (atomic) ──────────────────────────────────────────
-- p_principal / p_interest null = "the scheduled split" (EMI: reducing balance; interest-only:
-- the month's interest). Returns {payment_id, principal_part, interest_part, outstanding, closed}.
create or replace function public.personal_loan_record_payment(
  p_loan_id    uuid,
  p_kind       text,
  p_paid_on    date   default null,
  p_principal  bigint default null,
  p_interest   bigint default null,
  p_account_id uuid   default null,
  p_note       text   default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_loan        public.personal_loans%rowtype;
  v_paid        bigint;
  v_outstanding bigint;
  v_month_int   bigint;
  v_principal   bigint;
  v_interest    bigint;
  v_on          date := coalesce(p_paid_on, public.ist_today());
  v_account     uuid;
  v_ptx         uuid;
  v_itx         uuid;
  v_pay         uuid;
  v_label       text;
  v_closed      boolean := false;
begin
  -- RLS: only the owner's loan is visible. Lock it so two clicks cannot both pay the last EMI.
  select * into v_loan from public.personal_loans where id = p_loan_id for update;
  if not found then
    raise exception 'Loan not found.' using errcode = 'P0002';
  end if;
  if v_loan.status <> 'open' then
    raise exception 'This loan is closed. Re-open it before recording a payment.' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('emi', 'prepayment', 'interest', 'repayment') then
    raise exception 'Unknown payment type %.', coalesce(p_kind, 'null') using errcode = '22023';
  end if;
  if v_loan.direction = 'taken' and p_kind = 'repayment' then
    raise exception 'A loan you took is paid by EMI, prepayment or interest.' using errcode = '22023';
  end if;
  if v_loan.direction = 'given' and p_kind not in ('repayment', 'interest') then
    raise exception 'A loan you gave is repaid to you (repayment or interest).' using errcode = '22023';
  end if;
  if (p_principal is not null and p_principal < 0) or (p_interest is not null and p_interest < 0) then
    raise exception 'Amounts cannot be negative.' using errcode = '22023';
  end if;

  select coalesce(sum(principal_part), 0) into v_paid
    from public.personal_loan_payments where loan_id = v_loan.id;
  v_outstanding := greatest(v_loan.principal - v_paid, 0);
  v_month_int := round(v_outstanding * coalesce(v_loan.annual_rate, 0) / 1200.0)::bigint;

  if p_kind = 'emi' and p_principal is null and p_interest is null then
    if v_loan.emi_amount is null then
      raise exception 'This loan has no EMI amount — enter the principal and interest.' using errcode = '22023';
    end if;
    v_interest  := least(v_month_int, v_loan.emi_amount);
    v_principal := least(v_loan.emi_amount - v_interest, v_outstanding);
  elsif p_kind = 'interest' and p_principal is null and p_interest is null then
    v_interest  := v_month_int;
    v_principal := 0;
  else
    v_principal := coalesce(p_principal, 0);
    v_interest  := coalesce(p_interest, 0);
  end if;

  if p_kind = 'interest' and v_principal <> 0 then
    raise exception 'An interest payment has no principal part.' using errcode = '22023';
  end if;
  if v_principal + v_interest <= 0 then
    raise exception 'Enter an amount.' using errcode = '22023';
  end if;
  if v_principal > v_outstanding then
    raise exception 'Principal ₹% is more than the ₹% still outstanding.', v_principal, v_outstanding
      using errcode = '22023';
  end if;

  v_account := coalesce(p_account_id, v_loan.account_id);
  v_label := v_loan.party || ' loan — ' || case p_kind
    when 'emi' then 'EMI' when 'prepayment' then 'prepayment'
    when 'interest' then 'interest' else 'repayment' end;

  if v_principal > 0 then
    insert into public.personal_transactions
      (tenant_id, owner_user_id, kind, category, amount, occurred_on, account_id, note, party)
    values (v_loan.tenant_id, v_loan.owner_user_id,
            case when v_loan.direction = 'taken' then 'transfer_out' else 'transfer_in' end,
            case when v_loan.direction = 'taken' then 'Loan repayment' else 'Loan repayment received' end,
            v_principal, v_on, v_account,
            left(v_label || ' (principal)' || coalesce(' · ' || nullif(btrim(p_note), ''), ''), 500),
            left(v_loan.party, 120))
    returning id into v_ptx;
  end if;

  if v_interest > 0 then
    insert into public.personal_transactions
      (tenant_id, owner_user_id, kind, category, income_source, amount, occurred_on, account_id, note, party)
    values (v_loan.tenant_id, v_loan.owner_user_id,
            case when v_loan.direction = 'taken' then 'expense' else 'interest' end,
            case when v_loan.direction = 'taken' then 'Loan EMI' else 'Interest' end,
            case when v_loan.direction = 'taken' then null else 'interest' end,
            v_interest, v_on, v_account,
            left(v_label || ' (interest)' || coalesce(' · ' || nullif(btrim(p_note), ''), ''), 500),
            left(v_loan.party, 120))
    returning id into v_itx;
  end if;

  insert into public.personal_loan_payments
    (tenant_id, owner_user_id, loan_id, kind, paid_on, principal_part, interest_part,
     account_id, principal_tx_id, interest_tx_id, note)
  values (v_loan.tenant_id, v_loan.owner_user_id, v_loan.id, p_kind, v_on, v_principal, v_interest,
          v_account, v_ptx, v_itx, nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning id into v_pay;

  v_outstanding := v_outstanding - v_principal;
  -- Nothing left of a loan that had principal to repay → closed on the payment's day.
  if v_outstanding = 0 and v_principal > 0 then
    update public.personal_loans
       set status = 'closed', closed_on = v_on, updated_at = now()
     where id = v_loan.id;
    v_closed := true;
  end if;

  return jsonb_build_object(
    'payment_id', v_pay, 'principal_part', v_principal, 'interest_part', v_interest,
    'outstanding', v_outstanding, 'closed', v_closed);
end;
$$;

comment on function public.personal_loan_record_payment(uuid, text, date, bigint, bigint, uuid, text) is
  'R-2388: record an EMI / prepayment / interest / repayment on a personal loan in one transaction — the payment row and its personal_transactions (taken: interest = expense "Loan EMI", principal = transfer_out; given: principal = transfer_in, interest = interest income). Null split = scheduled reducing-balance split. Closes the loan at 0 outstanding. SECURITY INVOKER (owner RLS).';

revoke all on function public.personal_loan_record_payment(uuid, text, date, bigint, bigint, uuid, text) from public, anon;
grant execute on function public.personal_loan_record_payment(uuid, text, date, bigint, bigint, uuid, text) to authenticated, service_role;

-- ─── 6. undo a payment ─────────────────────────────────────────────────────
create or replace function public.personal_loan_undo_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pay public.personal_loan_payments%rowtype;
  v_reopened boolean := false;
begin
  select * into v_pay from public.personal_loan_payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment not found.' using errcode = 'P0002';
  end if;

  delete from public.personal_loan_payments where id = v_pay.id;
  delete from public.personal_transactions
   where id in (v_pay.principal_tx_id, v_pay.interest_tx_id)
     and owner_user_id = v_pay.owner_user_id;

  -- A loan this payment closed (principal back above 0) is open again.
  if v_pay.principal_part > 0 then
    update public.personal_loans l
       set status = 'open', closed_on = null, updated_at = now()
     where l.id = v_pay.loan_id
       and l.status = 'closed'
       and l.principal > (select coalesce(sum(principal_part), 0)
                            from public.personal_loan_payments where loan_id = l.id);
    v_reopened := found;
  end if;

  return jsonb_build_object('payment_id', v_pay.id, 'reopened', v_reopened);
end;
$$;

comment on function public.personal_loan_undo_payment(uuid) is
  'R-2388: remove a personal loan payment and the ledger entries it made; re-opens a loan it had closed. SECURITY INVOKER (owner RLS).';

revoke all on function public.personal_loan_undo_payment(uuid) from public, anon;
grant execute on function public.personal_loan_undo_payment(uuid) to authenticated, service_role;

commit;
