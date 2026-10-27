-- deploy-peek: to_regclass('public.emi_schedule') is not null and to_regprocedure('public.record_emi_asset_purchase(jsonb)') is not null and to_regprocedure('public.reconcile_bank_debit_to_emi(uuid,uuid,integer,integer,integer,integer,jsonb)') is not null and to_regprocedure('public.pay_next_emi(uuid,uuid,date)') is not null and to_regprocedure('public.prepay_emi_loan(uuid,integer,integer,integer,date,uuid,uuid,boolean,jsonb)') is not null and to_regprocedure('public.undo_emi_payment(uuid)') is not null and to_regprocedure('public.emi_matches_for_bank_txn(uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.auto_reconcile_bank_account(uuid,uuid,integer)') and prosrc like '%R-1864%')
-- deploy-key: r1864emiassetloan
-- 20261024200500_r1864_emi_asset_loan.sql
--
-- R-1864 (Pardeep, 24 Oct 2026): "EMI ki nikasi for asset ko kharidne ke liye jati statement se
-- reconcile karte waqt isko kaise handle karenge — best system banao".
--
-- ══ WHAT WAS THERE ══════════════════════════════════════════════════════════════════════
--   record_emi_purchase (archive 0092 + R-885) stored total / down / EMI count + amount only — no
--   rate, tenure, first EMI date, processing fee or schedule — and did not put the item in the
--   fixed-asset register (a second manual step). record_emi_payment asked the user to type the
--   interest and ALWAYS inserted a new manual bank line, so the real EMI debit in an imported
--   statement could not be reconciled to the loan: it stayed unmatched, or was booked again
--   (the same EMI out of the bank twice).
--
-- ══ THE ACCOUNTING (India) ══════════════════════════════════════════════════════════════
--   Purchase:  Dr Fixed asset (cost, ex-GST when ITC is claimed)   — fixed_assets (register;
--                                                                      depreciation R-1578/R-1808)
--              Cr Bank  (down payment + processing fee)            — the down-payment bank line
--              Cr EMI loan (cost − down)                           — emi_purchases.financed
--              Dr Bank Charges (processing fee, its GST as ITC)    — an expense, P&L
--   Each EMI:  Dr EMI loan (principal) + Dr Interest (P&L) [+ Dr late fee / bounce charge (P&L)]
--              Cr Bank (the statement line).  The whole EMI is NEVER an expense.
--   The split follows the stored amortisation schedule (reducing balance; computed in
--   lib/accounting/emi-schedule.ts, or the lender's EMI) — every schedule sent is RE-CHECKED here.
--   Prepayment / foreclosure: Dr EMI loan (principal) [+ Dr charge (P&L)] Cr Bank; the remaining
--   schedule is replaced by a recomputed one (keep EMI or keep tenure, chosen in the app).
--   No-cost EMI: interest 0 on every row (the discount is in the price).
--
-- ══ NO DOUBLE CASH ══════════════════════════════════════════════════════════════════════
--   Every cash movement has exactly ONE bank line (emi_purchases.down_bank_txn_id,
--   emi_payments.bank_txn_id), matched_to_type 'emi':
--     • recorded by hand (no statement yet) → a 'manual' line on the chosen account;
--     • reconciled from the bank page → the imported line itself. If the same instalment / down
--       payment was already recorded by hand, its manual line is DELETED and the record moves
--       onto the imported line (the book_bank_txn_as_vendor_bill / R-1839 pattern).
--   Un-reconciling an imported EMI line undoes that payment (the latest one only); un-reconciling
--   an imported down-payment line puts a manual line back (the money did leave the bank).
--
-- Existing rows are not changed: new columns have defaults, the new emi_payments check is
-- NOT VALID (checks new rows only). §17c guard + money roles (owner, manager, accountant) on
-- every function. Proof: supabase/tests/r1864_emi_asset_loan.test.sql (one rollback).


begin;

-- ── 1. Columns ───────────────────────────────────────────────────────────────────────────
alter table public.emi_purchases
  add column if not exists interest_rate      numeric(6,3) check (interest_rate is null or (interest_rate >= 0 and interest_rate <= 60)),
  add column if not exists no_cost            boolean not null default false,
  add column if not exists first_emi_on       date,
  add column if not exists processing_fee     integer not null default 0 check (processing_fee >= 0),
  add column if not exists processing_fee_gst integer not null default 0 check (processing_fee_gst >= 0),
  add column if not exists fee_expense_id     text references public.expenses(id) on delete restrict,
  add column if not exists lender_ref         text check (lender_ref is null or char_length(lender_ref) <= 60),
  add column if not exists down_bank_txn_id   uuid references public.bank_transactions(id) on delete set null;

alter table public.emi_payments
  add column if not exists bank_txn_id        uuid references public.bank_transactions(id) on delete set null,
  add column if not exists schedule_seq       integer check (schedule_seq is null or schedule_seq >= 1),
  add column if not exists kind               text not null default 'emi' check (kind in ('emi', 'prepayment', 'foreclosure')),
  add column if not exists charges            integer not null default 0 check (charges >= 0),
  add column if not exists charges_expense_id text references public.expenses(id) on delete restrict,
  -- The unpaid schedule rows as they were before this payment — undo puts them back.
  add column if not exists schedule_before    jsonb;

alter table public.emi_payments drop constraint if exists emi_payments_split_r1864;
alter table public.emi_payments add constraint emi_payments_split_r1864
  check (amount = principal_part + interest_part + charges) not valid;

create index if not exists emi_payments_bank_txn_idx on public.emi_payments (bank_txn_id) where bank_txn_id is not null;

-- ── 2. The schedule ──────────────────────────────────────────────────────────────────────
create table if not exists public.emi_schedule (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  purchase_id     uuid not null references public.emi_purchases(id) on delete cascade,
  seq             integer not null check (seq >= 1),
  due_on          date not null,
  emi             integer not null check (emi >= 0),
  principal       integer not null check (principal >= 0),
  interest        integer not null check (interest >= 0),
  balance_after   integer not null check (balance_after >= 0),
  emi_payment_id  uuid references public.emi_payments(id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint emi_schedule_split check (emi = principal + interest),
  constraint emi_schedule_seq_unique unique (purchase_id, seq)
);

comment on table public.emi_schedule is
  'R-1864: EMI amortisation schedule (reducing balance, whole rupees). Written only by the EMI functions.';

create index if not exists emi_schedule_tenant_idx on public.emi_schedule (tenant_id, due_on);

alter table public.emi_schedule enable row level security;
drop policy if exists "tenant isolation read" on public.emi_schedule;
drop policy if exists zzz_service_role_all on public.emi_schedule;
create policy "tenant isolation read" on public.emi_schedule for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));
create policy zzz_service_role_all on public.emi_schedule as permissive for all to service_role
  using (true) with check (true);
grant select on public.emi_schedule to authenticated;
grant select, insert, update, delete on public.emi_schedule to service_role;

-- ── 3. A bank line can be matched to an EMI ──────────────────────────────────────────────
-- Added to whatever the check holds now (other cards add their own types — the R-1866 pattern).
do $$
declare v_def text; v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.bank_transactions'::regclass and c.conname = 'bank_transactions_matched_to_type_check';
  if v_def is null then raise exception 'bank_transactions_matched_to_type_check is missing'; end if;
  -- Two shapes: ARRAY['payment'::text, …] (as created) or '{payment,…}'::text[] (after R-1866
  -- re-added it through format(%L)). Read both.
  if v_def ~ '\{[a-z_,]+\}' then
    v_vals := string_to_array(substring(v_def from '\{([a-z_,]+)\}'), ',');
  else
    select array_agg(m[1] order by ord) into v_vals
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;
  if v_vals is null or cardinality(v_vals) = 0 then raise exception 'Could not read bank_transactions_matched_to_type_check: %', v_def; end if;
  if 'emi' = any (v_vals) then return; end if;
  v_vals := array_append(v_vals, 'emi'::text);
  execute 'alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check';
  execute format('alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check check (matched_to_type = any (%L::text[]))', v_vals);
end $$;

-- ── 4. Internal helpers (not callable by app users) ──────────────────────────────────────
-- Checks a schedule (rows seq p_from.. in order) for a loan balance of p_balance and replaces
-- every UNPAID row from p_from on with it. Raises with a plain message when anything is off.
create or replace function public.emi_replace_unpaid_schedule(
  p_tenant uuid, p_purchase uuid, p_from integer, p_balance integer, p_rows jsonb,
  p_zero_interest boolean, p_not_before date
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n      integer := coalesce(jsonb_array_length(p_rows), 0);
  v_i      integer;
  v_r      jsonb;
  v_bal    integer := p_balance;
  v_prev   date := p_not_before;
  v_seq    integer; v_due date; v_emi integer; v_pr integer; v_in integer; v_after integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'The EMI schedule is missing';
  end if;
  if p_balance > 0 and v_n = 0 then
    raise exception 'The EMI schedule is empty but ₹% is still owed', p_balance;
  end if;
  for v_i in 0 .. v_n - 1 loop
    v_r := p_rows -> v_i;
    v_seq := (v_r ->> 'seq')::integer;
    v_due := (v_r ->> 'due_on')::date;
    v_emi := (v_r ->> 'emi')::integer;
    v_pr  := (v_r ->> 'principal')::integer;
    v_in  := (v_r ->> 'interest')::integer;
    v_after := (v_r ->> 'balance_after')::integer;
    if v_seq is distinct from p_from + v_i then
      raise exception 'EMI schedule row % is out of order (expected instalment %)', v_seq, p_from + v_i;
    end if;
    if v_due is null or v_due < v_prev then
      raise exception 'EMI % falls before the previous date', v_seq;
    end if;
    if v_pr is null or v_in is null or v_pr < 0 or v_in < 0 then
      raise exception 'EMI % has a negative principal or interest', v_seq;
    end if;
    if v_emi is distinct from v_pr + v_in then
      raise exception 'EMI % is ₹% but principal + interest is ₹%', v_seq, v_emi, v_pr + v_in;
    end if;
    if p_zero_interest and v_in <> 0 then
      raise exception 'A no-cost EMI has no interest (EMI %)', v_seq;
    end if;
    v_bal := v_bal - v_pr;
    if v_after is distinct from v_bal or v_bal < 0 then
      raise exception 'EMI %: balance after should be ₹%', v_seq, greatest(v_bal, 0);
    end if;
    v_prev := v_due;
  end loop;
  if v_bal <> 0 then
    raise exception 'The schedule repays ₹% but ₹% is owed', p_balance - v_bal, p_balance;
  end if;

  delete from public.emi_schedule
   where purchase_id = p_purchase and seq >= p_from and emi_payment_id is null;
  if exists (select 1 from public.emi_schedule where purchase_id = p_purchase and seq >= p_from) then
    raise exception 'A paid EMI sits after instalment % — undo it first', p_from;
  end if;
  insert into public.emi_schedule (tenant_id, purchase_id, seq, due_on, emi, principal, interest, balance_after)
  select p_tenant, p_purchase, (r ->> 'seq')::integer, (r ->> 'due_on')::date, (r ->> 'emi')::integer,
         (r ->> 'principal')::integer, (r ->> 'interest')::integer, (r ->> 'balance_after')::integer
    from jsonb_array_elements(p_rows) r;
end;
$$;
revoke all on function public.emi_replace_unpaid_schedule(uuid, uuid, integer, integer, jsonb, boolean, date) from public, anon, authenticated;

-- The unpaid rows from p_from on, as jsonb (for schedule_before).
create or replace function public.emi_unpaid_rows(p_purchase uuid, p_from integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('seq', s.seq, 'due_on', s.due_on, 'emi', s.emi, 'principal', s.principal,
                                               'interest', s.interest, 'balance_after', s.balance_after) order by s.seq), '[]'::jsonb)
    from public.emi_schedule s
   where s.purchase_id = p_purchase and s.seq >= p_from and s.emi_payment_id is null;
$$;
revoke all on function public.emi_unpaid_rows(uuid, integer) from public, anon, authenticated;

create or replace function public.emi_new_expense_id() returns text
language sql volatile security definer set search_path = public as $$
  select 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
$$;
revoke all on function public.emi_new_expense_id() from public, anon, authenticated;

-- §17c guard + money role, shared by every entry point below.
create or replace function public.emi_guard(p_what text) returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
begin
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can %', p_what using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function public.emi_guard(text) from public, anon;
grant execute on function public.emi_guard(text) to authenticated, service_role;

-- Posts one payment (EMI / prepayment / foreclosure) of a purchase against a bank line that is
-- already there (imported or a manual line just made). Interest and charges become expenses.
create or replace function public.emi_post_payment(
  p_tenant uuid, p_purchase public.emi_purchases, p_txn public.bank_transactions, p_seq integer,
  p_principal integer, p_interest integer, p_charges integer, p_kind text, p_before jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay    uuid := gen_random_uuid();
  v_int_id text;
  v_chg_id text;
  v_who    text := coalesce(p_purchase.lender, p_purchase.name);
begin
  if p_interest > 0 then
    v_int_id := public.emi_new_expense_id();
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, bill_type)
    values (v_int_id, p_tenant, 'Interest', v_who, p_txn.txn_date, p_interest, 0, 'emi',
            'Interest on loan — ' || p_purchase.name || coalesce(' · EMI ' || p_seq, ''), 'none');
  end if;
  if p_charges > 0 then
    v_chg_id := public.emi_new_expense_id();
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, bill_type)
    values (v_chg_id, p_tenant, 'Bank Charges', v_who, p_txn.txn_date, p_charges, 0, 'emi',
            case p_kind when 'emi' then 'EMI late fee / bounce charge — ' else 'Loan foreclosure / prepayment charge — ' end || p_purchase.name, 'none');
  end if;
  insert into public.emi_payments
    (id, tenant_id, purchase_id, amount, principal_part, interest_part, charges, paid_on, bank_account_id, bank_txn_id,
     expense_id, charges_expense_id, schedule_seq, kind, schedule_before, created_at)
  values
    (v_pay, p_tenant, p_purchase.id, p_principal + p_interest + p_charges, p_principal, p_interest, p_charges, p_txn.txn_date,
     p_txn.bank_account_id, p_txn.id, v_int_id, v_chg_id, p_seq, p_kind, p_before, clock_timestamp());
  return v_pay;
end;
$$;
revoke all on function public.emi_post_payment(uuid, public.emi_purchases, public.bank_transactions, integer, integer, integer, integer, text, jsonb) from public, anon, authenticated;

-- Money still owed on a purchase.
create or replace function public.emi_outstanding(p_purchase uuid) returns integer
language sql stable security definer set search_path = public as $$
  select (select financed from public.emi_purchases where id = p_purchase)
       - coalesce((select sum(principal_part) from public.emi_payments where purchase_id = p_purchase), 0)::integer;
$$;
revoke all on function public.emi_outstanding(uuid) from public, anon, authenticated;

create or replace function public.emi_mark_line(p_txn uuid, p_target uuid) returns void
language sql security definer set search_path = public as $$
  update public.bank_transactions
     set matched_to_type = 'emi', matched_to_id = p_target::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn;
$$;
revoke all on function public.emi_mark_line(uuid, uuid) from public, anon, authenticated;

-- A new manual line on an account (when there is no statement line yet).
create or replace function public.emi_manual_line(p_tenant uuid, p_account uuid, p_date date, p_amount integer, p_text text)
returns public.bank_transactions
language plpgsql security definer set search_path = public as $$
declare v public.bank_transactions;
begin
  if p_account is null then raise exception 'Pick the account the money was paid from'; end if;
  perform 1 from public.bank_accounts where id = p_account and tenant_id = p_tenant;
  if not found then raise exception 'That bank / cash account is not in your company'; end if;
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source)
  values (p_tenant, p_account, p_date, p_text, p_amount, 0, 'manual')
  returning * into v;
  return v;
end;
$$;
revoke all on function public.emi_manual_line(uuid, uuid, date, integer, text) from public, anon, authenticated;

-- An unmatched money-out line of the caller's company, locked.
create or replace function public.emi_lock_debit_line(p_tenant uuid, p_txn uuid) returns public.bank_transactions
language plpgsql security definer set search_path = public as $$
declare v public.bank_transactions;
begin
  select * into v from public.bank_transactions where id = p_txn for update;
  if not found or v.tenant_id is distinct from p_tenant then raise exception 'Bank line not found in your company'; end if;
  if v.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v.debit, 0) <= 0 then raise exception 'Only a money-out line can pay an EMI'; end if;
  return v;
end;
$$;
revoke all on function public.emi_lock_debit_line(uuid, uuid) from public, anon, authenticated;

-- ── 5. Buy an asset on EMI / loan — ONE step ─────────────────────────────────────────────
create or replace function public.record_emi_asset_purchase(p jsonb) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.emi_guard('record an asset bought on EMI');
  v_name     text := nullif(trim(coalesce(p ->> 'name', '')), '');
  v_block    text := coalesce(nullif(p ->> 'block', ''), 'computers');
  v_cost     integer := (p ->> 'cost')::integer;
  v_down     integer := greatest(coalesce((p ->> 'down_payment')::integer, 0), 0);
  v_fee      integer := greatest(coalesce((p ->> 'processing_fee')::integer, 0), 0);
  v_fee_gst  integer := greatest(coalesce((p ->> 'processing_fee_gst')::integer, 0), 0);
  v_date     date := (p ->> 'purchased_on')::date;
  v_lender   text := nullif(trim(coalesce(p ->> 'lender', '')), '');
  v_ref      text := nullif(trim(coalesce(p ->> 'lender_ref', '')), '');
  v_rate     numeric := nullif(p ->> 'interest_rate', '')::numeric;
  v_nocost   boolean := coalesce((p ->> 'no_cost')::boolean, false);
  v_account  uuid := nullif(p ->> 'account_id', '')::uuid;
  v_txn_id   uuid := nullif(p ->> 'down_bank_txn_id', '')::uuid;
  v_rows     jsonb := p -> 'schedule';
  v_fin      integer;
  v_cash     integer;
  v_id       uuid := gen_random_uuid();
  v_fee_id   text;
  v_cat      text;
  v_txn      public.bank_transactions;
begin
  if v_name is null then raise exception 'Enter what was bought'; end if;
  if char_length(v_name) > 120 then raise exception 'Keep the item name under 120 characters'; end if;
  if v_block not in ('computers', 'plant', 'furniture', 'vehicles', 'building', 'intangible') then
    raise exception 'Pick the asset type';
  end if;
  if v_cost is null or v_cost <= 0 then raise exception 'Enter the cost of the item'; end if;
  if v_date is null then raise exception 'Enter the purchase date'; end if;
  if v_down > v_cost then raise exception 'The down payment (₹%) is more than the cost (₹%)', v_down, v_cost; end if;
  v_fin := v_cost - v_down;
  if v_fin <= 0 then raise exception 'Nothing is financed — add the item in the Fixed asset register instead'; end if;
  if v_lender is null then raise exception 'Enter the lender (bank / NBFC)'; end if;
  if v_nocost then v_rate := 0; end if;
  if v_rate is null then raise exception 'Enter the interest rate, or tick No-cost EMI'; end if;

  v_cat := case v_block when 'vehicles' then 'vehicle' when 'furniture' then 'furniture' when 'building' then 'property'
                        when 'intangible' then 'other' else 'equipment' end;
  v_cash := v_down + v_fee + v_fee_gst;

  if v_txn_id is not null then
    v_txn := public.emi_lock_debit_line(v_tenant, v_txn_id);
    if v_txn.debit <> v_cash then
      raise exception 'This bank line is ₹% but down payment + processing fee is ₹%', v_txn.debit, v_cash;
    end if;
  elsif v_cash > 0 and v_account is null then
    raise exception 'Pick the account the down payment was paid from';
  end if;

  insert into public.emi_purchases
    (id, tenant_id, name, category, total_cost, down_payment, financed, emi_count, emi_amount, purchased_on,
     down_account_id, lender, notes, status, created_by, interest_rate, no_cost, first_emi_on,
     processing_fee, processing_fee_gst, lender_ref)
  values
    (v_id, v_tenant, v_name, v_cat, v_cost, v_down, v_fin, coalesce(jsonb_array_length(v_rows), 0),
     coalesce((v_rows -> 0 ->> 'emi')::integer, 0), v_date,
     coalesce(v_txn.bank_account_id, v_account), v_lender, nullif(trim(coalesce(p ->> 'notes', '')), ''), 'active',
     public.current_user_id(), v_rate, v_nocost, (v_rows -> 0 ->> 'due_on')::date, v_fee, v_fee_gst, v_ref);

  perform public.emi_replace_unpaid_schedule(v_tenant, v_id, 1, v_fin, v_rows, v_nocost, v_date);

  -- The asset in the register: cost, put to use on the purchase date (depreciation from there).
  insert into public.fixed_assets (tenant_id, name, block, cost, put_to_use, emi_purchase_id, notes)
  values (v_tenant, v_name, v_block, v_cost, v_date, v_id, 'Bought on EMI — ' || v_lender);

  if v_fee + v_fee_gst > 0 then
    v_fee_id := public.emi_new_expense_id();
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, bill_type)
    values (v_fee_id, v_tenant, 'Bank Charges', v_lender, v_date, v_fee + v_fee_gst, v_fee_gst, 'emi',
            'Loan processing fee — ' || v_name, case when v_fee_gst > 0 then 'gst' else 'none' end);
    update public.emi_purchases set fee_expense_id = v_fee_id where id = v_id;
  end if;

  if v_cash > 0 then
    if v_txn_id is null then
      v_txn := public.emi_manual_line(v_tenant, v_account, v_date, v_cash,
                 'Down payment: ' || v_name || ' (' || v_lender || ')');
    end if;
    perform public.emi_mark_line(v_txn.id, v_id);
    update public.emi_purchases set down_bank_txn_id = v_txn.id where id = v_id;
  end if;

  return v_id;
end;
$$;
revoke all on function public.record_emi_asset_purchase(jsonb) from public, anon;
grant execute on function public.record_emi_asset_purchase(jsonb) to authenticated, service_role;

-- ── 6. Reconcile an imported money-out line to an EMI ────────────────────────────────────
--   p_seq = 0  → the purchase's down payment (its manual line is replaced by this line).
--   p_seq = n  → instalment n. Already paid by hand → its manual line is replaced (amount must
--                match). Unpaid → it must be the NEXT unpaid one; the line is split into
--                p_principal + p_interest + p_charges (= the line). Interest is the schedule's
--                (or the whole line when the line is smaller). A principal other than the
--                schedule's (part prepayment / short payment) needs p_new_schedule for the rest.
create or replace function public.reconcile_bank_debit_to_emi(
  p_txn_id uuid, p_purchase_id uuid, p_seq integer,
  p_principal integer default null, p_interest integer default null, p_charges integer default 0,
  p_new_schedule jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.emi_guard('reconcile an EMI');
  v_txn     public.bank_transactions;
  v_p       public.emi_purchases;
  v_row     public.emi_schedule;
  v_pay     public.emi_payments;
  v_old     public.bank_transactions;
  v_next    integer;
  v_out     integer;
  v_prin    integer;
  v_int     integer;
  v_chg     integer := greatest(coalesce(p_charges, 0), 0);
  v_before  jsonb;
  v_pay_id  uuid;
begin
  v_txn := public.emi_lock_debit_line(v_tenant, p_txn_id);
  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That EMI purchase is not in your company'; end if;

  -- Down payment.
  if coalesce(p_seq, 0) = 0 then
    select * into v_old from public.bank_transactions where id = v_p.down_bank_txn_id;
    if not found then raise exception 'This purchase has no down payment to match'; end if;
    if v_old.source <> 'manual' then raise exception 'The down payment is already matched to a bank line'; end if;
    if v_old.debit <> v_txn.debit then
      raise exception 'The down payment (with the processing fee) is ₹% but this line is ₹%', v_old.debit, v_txn.debit;
    end if;
    update public.emi_purchases set down_bank_txn_id = v_txn.id, down_account_id = v_txn.bank_account_id, updated_at = now()
     where id = v_p.id;
    delete from public.bank_transactions where id = v_old.id;
    perform public.emi_mark_line(v_txn.id, v_p.id);
    return jsonb_build_object('kind', 'down_payment', 'purchase_id', v_p.id, 'amount', v_txn.debit, 'replaced_line', v_old.id);
  end if;

  select * into v_row from public.emi_schedule where purchase_id = v_p.id and seq = p_seq for update;
  if not found then raise exception 'EMI % is not in this loan''s schedule', p_seq; end if;

  -- Paid by hand earlier → this statement line replaces its manual line.
  if v_row.emi_payment_id is not null then
    select * into v_pay from public.emi_payments where id = v_row.emi_payment_id for update;
    select * into v_old from public.bank_transactions where id = v_pay.bank_txn_id;
    if not found or v_old.source <> 'manual' then raise exception 'EMI % is already paid and matched to a bank line', p_seq; end if;
    if v_pay.amount <> v_txn.debit then
      raise exception 'EMI % was paid as ₹% but this line is ₹%', p_seq, v_pay.amount, v_txn.debit;
    end if;
    update public.emi_payments set bank_txn_id = v_txn.id, bank_account_id = v_txn.bank_account_id, paid_on = v_txn.txn_date
     where id = v_pay.id;
    delete from public.bank_transactions where id = v_old.id;
    perform public.emi_mark_line(v_txn.id, v_pay.id);
    return jsonb_build_object('kind', 'emi', 'payment_id', v_pay.id, 'seq', p_seq, 'amount', v_txn.debit,
                              'principal', v_pay.principal_part, 'interest', v_pay.interest_part, 'charges', v_pay.charges,
                              'replaced_line', v_old.id);
  end if;

  if v_p.status <> 'active' then raise exception 'This loan is already closed'; end if;
  select min(seq) into v_next from public.emi_schedule where purchase_id = v_p.id and emi_payment_id is null;
  if v_next is distinct from p_seq then
    raise exception 'Pay EMI % first — instalments are paid in order', v_next;
  end if;

  v_int  := coalesce(p_interest, least(v_row.interest, v_txn.debit - v_chg));
  v_prin := coalesce(p_principal, v_txn.debit - v_chg - v_int);
  if v_int < 0 or v_prin < 0 then raise exception 'The split cannot be negative'; end if;
  if v_prin + v_int + v_chg <> v_txn.debit then
    raise exception 'Principal ₹% + interest ₹% + charges ₹% is not the line''s ₹%', v_prin, v_int, v_chg, v_txn.debit;
  end if;
  if v_int <> least(v_row.interest, v_txn.debit - v_chg) then
    raise exception 'Interest for EMI % is ₹% per the schedule', p_seq, v_row.interest;
  end if;
  v_out := public.emi_outstanding(v_p.id);
  if v_prin > v_out then raise exception 'Principal ₹% is more than the ₹% still owed', v_prin, v_out; end if;

  v_before := public.emi_unpaid_rows(v_p.id, p_seq);
  if v_prin <> v_row.principal then
    if p_new_schedule is null then
      raise exception 'This line is not the scheduled EMI — send the recomputed schedule for the rest';
    end if;
    -- The rest keeps its due dates (an overdue one stays overdue): only "not before this EMI".
    perform public.emi_replace_unpaid_schedule(v_tenant, v_p.id, p_seq + 1, v_out - v_prin, p_new_schedule,
                                               v_p.no_cost, v_row.due_on);
  end if;

  v_pay_id := public.emi_post_payment(v_tenant, v_p, v_txn, p_seq, v_prin, v_int, v_chg, 'emi', v_before);
  update public.emi_schedule
     set emi_payment_id = v_pay_id, principal = v_prin, interest = v_int, emi = v_prin + v_int,
         balance_after = v_out - v_prin
   where id = v_row.id;
  perform public.emi_mark_line(v_txn.id, v_pay_id);

  if v_out - v_prin = 0 then
    delete from public.emi_schedule where purchase_id = v_p.id and emi_payment_id is null;
    update public.emi_purchases set status = 'closed', updated_at = now() where id = v_p.id;
  end if;

  return jsonb_build_object('kind', 'emi', 'payment_id', v_pay_id, 'seq', p_seq, 'amount', v_txn.debit,
                            'principal', v_prin, 'interest', v_int, 'charges', v_chg, 'outstanding', v_out - v_prin);
end;
$$;
revoke all on function public.reconcile_bank_debit_to_emi(uuid, uuid, integer, integer, integer, integer, jsonb) from public, anon;
grant execute on function public.reconcile_bank_debit_to_emi(uuid, uuid, integer, integer, integer, integer, jsonb) to authenticated, service_role;

-- ── 7. Pay the next EMI by hand (no statement yet) — exactly per the schedule ────────────
create or replace function public.pay_next_emi(p_purchase_id uuid, p_account_id uuid, p_paid_on date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.emi_guard('pay an EMI');
  v_p      public.emi_purchases;
  v_row    public.emi_schedule;
  v_txn    public.bank_transactions;
  v_pay    uuid;
  v_out    integer;
begin
  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That EMI purchase is not in your company'; end if;
  if v_p.status <> 'active' then raise exception 'This loan is already closed'; end if;
  select * into v_row from public.emi_schedule
   where purchase_id = v_p.id and emi_payment_id is null order by seq limit 1 for update;
  if not found then raise exception 'This loan has no EMI schedule — use Pay EMI'; end if;
  v_out := public.emi_outstanding(v_p.id);
  v_txn := public.emi_manual_line(v_tenant, p_account_id, coalesce(p_paid_on, v_row.due_on), v_row.emi,
             'EMI ' || v_row.seq || ': ' || v_p.name || ' (' || coalesce(v_p.lender, '') || ')');
  v_pay := public.emi_post_payment(v_tenant, v_p, v_txn, v_row.seq, v_row.principal, v_row.interest, 0, 'emi',
                                   public.emi_unpaid_rows(v_p.id, v_row.seq));
  update public.emi_schedule set emi_payment_id = v_pay where id = v_row.id;
  perform public.emi_mark_line(v_txn.id, v_pay);
  if v_out - v_row.principal = 0 then
    update public.emi_purchases set status = 'closed', updated_at = now() where id = v_p.id;
  end if;
  return jsonb_build_object('payment_id', v_pay, 'seq', v_row.seq, 'amount', v_row.emi,
                            'principal', v_row.principal, 'interest', v_row.interest);
end;
$$;
revoke all on function public.pay_next_emi(uuid, uuid, date) from public, anon;
grant execute on function public.pay_next_emi(uuid, uuid, date) to authenticated, service_role;

-- ── 8. Prepayment / foreclosure ──────────────────────────────────────────────────────────
--   Cash = principal + interest (broken-period interest, if the lender charged it) + charges.
--   From an imported line (p_txn_id) or a manual line on p_account_id. Foreclose = the whole
--   outstanding; otherwise p_new_schedule replaces every unpaid row (owed − principal).
create or replace function public.prepay_emi_loan(
  p_purchase_id uuid, p_principal integer, p_interest integer, p_charges integer, p_paid_on date,
  p_account_id uuid, p_txn_id uuid, p_foreclose boolean, p_new_schedule jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.emi_guard('prepay a loan');
  v_p      public.emi_purchases;
  v_txn    public.bank_transactions;
  v_out    integer;
  v_prin   integer := coalesce(p_principal, 0);
  v_int    integer := greatest(coalesce(p_interest, 0), 0);
  v_chg    integer := greatest(coalesce(p_charges, 0), 0);
  v_next   integer;
  v_before jsonb;
  v_pay    uuid;
  v_kind   text := case when coalesce(p_foreclose, false) then 'foreclosure' else 'prepayment' end;
begin
  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That EMI purchase is not in your company'; end if;
  if v_p.status <> 'active' then raise exception 'This loan is already closed'; end if;
  v_out := public.emi_outstanding(v_p.id);
  if coalesce(p_foreclose, false) then v_prin := v_out; end if;
  if v_prin <= 0 then raise exception 'Enter the principal being prepaid'; end if;
  if v_prin > v_out then raise exception 'Prepayment ₹% is more than the ₹% still owed', v_prin, v_out; end if;

  if p_txn_id is not null then
    v_txn := public.emi_lock_debit_line(v_tenant, p_txn_id);
    if v_txn.debit <> v_prin + v_int + v_chg then
      raise exception 'This line is ₹% but principal + interest + charges is ₹%', v_txn.debit, v_prin + v_int + v_chg;
    end if;
  else
    v_txn := public.emi_manual_line(v_tenant, p_account_id, coalesce(p_paid_on, (now() at time zone 'Asia/Kolkata')::date), v_prin + v_int + v_chg,
               initcap(v_kind) || ': ' || v_p.name || ' (' || coalesce(v_p.lender, '') || ')');
  end if;

  select min(seq) into v_next from public.emi_schedule where purchase_id = v_p.id and emi_payment_id is null;
  v_before := public.emi_unpaid_rows(v_p.id, coalesce(v_next, 1));
  if v_prin = v_out then
    delete from public.emi_schedule where purchase_id = v_p.id and emi_payment_id is null;
  elsif v_next is not null then
    if p_new_schedule is null then raise exception 'Send the recomputed schedule for the rest of the loan'; end if;
    -- An overdue EMI keeps its date: the rest only has to come after the last PAID one.
    perform public.emi_replace_unpaid_schedule(v_tenant, v_p.id, v_next, v_out - v_prin, p_new_schedule, v_p.no_cost,
      coalesce((select max(s.due_on) from public.emi_schedule s where s.purchase_id = v_p.id and s.emi_payment_id is not null),
               v_p.purchased_on));
  end if;

  v_pay := public.emi_post_payment(v_tenant, v_p, v_txn, null, v_prin, v_int, v_chg, v_kind, v_before);
  perform public.emi_mark_line(v_txn.id, v_pay);
  if v_prin = v_out then
    update public.emi_purchases set status = 'closed', updated_at = now() where id = v_p.id;
  end if;
  return jsonb_build_object('payment_id', v_pay, 'kind', v_kind, 'principal', v_prin, 'interest', v_int,
                            'charges', v_chg, 'outstanding', v_out - v_prin);
end;
$$;
revoke all on function public.prepay_emi_loan(uuid, integer, integer, integer, date, uuid, uuid, boolean, jsonb) from public, anon;
grant execute on function public.prepay_emi_loan(uuid, integer, integer, integer, date, uuid, uuid, boolean, jsonb) to authenticated, service_role;

-- ── 9. Undo the LATEST payment of a loan ─────────────────────────────────────────────────
--   Removes the payment, its interest / charge expenses, puts the schedule back as it was, and
--   deletes its manual line — or frees the imported line (back to Unmatched).
create or replace function public.emi_undo_payment_core(p_pay public.emi_payments) returns void
language plpgsql security definer set search_path = public as $$
declare v_from integer;
begin
  if exists (select 1 from public.emi_payments
              where purchase_id = p_pay.purchase_id and (created_at, id) > (p_pay.created_at, p_pay.id)) then
    raise exception 'Undo the later EMI payments of this loan first';
  end if;
  update public.emi_schedule set emi_payment_id = null where emi_payment_id = p_pay.id;
  delete from public.emi_payments where id = p_pay.id;
  if p_pay.expense_id is not null then delete from public.expenses where id = p_pay.expense_id; end if;
  if p_pay.charges_expense_id is not null then delete from public.expenses where id = p_pay.charges_expense_id; end if;
  if p_pay.schedule_before is not null and jsonb_array_length(p_pay.schedule_before) > 0 then
    v_from := (p_pay.schedule_before -> 0 ->> 'seq')::integer;
    delete from public.emi_schedule where purchase_id = p_pay.purchase_id and seq >= v_from;
    insert into public.emi_schedule (tenant_id, purchase_id, seq, due_on, emi, principal, interest, balance_after)
    select p_pay.tenant_id, p_pay.purchase_id, (r ->> 'seq')::integer, (r ->> 'due_on')::date, (r ->> 'emi')::integer,
           (r ->> 'principal')::integer, (r ->> 'interest')::integer, (r ->> 'balance_after')::integer
      from jsonb_array_elements(p_pay.schedule_before) r;
  end if;
  update public.emi_purchases set status = 'active', updated_at = now() where id = p_pay.purchase_id;
end;
$$;
revoke all on function public.emi_undo_payment_core(public.emi_payments) from public, anon, authenticated;

create or replace function public.undo_emi_payment(p_payment_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.emi_guard('undo an EMI payment');
  v_pay    public.emi_payments;
  v_line   public.bank_transactions;
begin
  select * into v_pay from public.emi_payments where id = p_payment_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That EMI payment is not in your company'; end if;
  select * into v_line from public.bank_transactions where id = v_pay.bank_txn_id;
  if v_line.id is not null and v_line.source <> 'manual' then
    -- A statement line: free it; the trigger below undoes the payment.
    update public.bank_transactions
       set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null,
           match_confidence = null, updated_at = now()
     where id = v_line.id;
  else
    perform public.emi_undo_payment_core(v_pay);
    if v_line.id is not null then delete from public.bank_transactions where id = v_line.id; end if;
  end if;
end;
$$;
revoke all on function public.undo_emi_payment(uuid) from public, anon;
grant execute on function public.undo_emi_payment(uuid) to authenticated, service_role;

-- ── 10. Un-reconciling an EMI line ───────────────────────────────────────────────────────
create or replace function public.tg_emi_line_unmatched() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pay public.emi_payments;
  v_p   public.emi_purchases;
  v_new public.bank_transactions;
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
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.tg_emi_line_unmatched() from public, anon, authenticated;

drop trigger if exists trg_emi_line_unmatched on public.bank_transactions;
create trigger trg_emi_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_emi_line_unmatched();

-- ── 11. Which EMI could this money-out line be? ──────────────────────────────────────────
--   For the bank page (Reconcile → "EMI / loan repayment") and auto-reconcile. Candidates:
--   each active loan's NEXT unpaid instalment, instalments paid by hand (manual line), and
--   down payments still on a manual line. Confidence:
--     exact — same amount, within 10 days of the due date, narration names the lender / ref / EMI
--     high  — same amount and (within 10 days or the narration says so)
--     low   — anything else that is close (amount up to ₹2,000 / 10% more: a late fee)
create or replace function public.emi_matches_for_bank_txn(p_txn_id uuid)
returns table (purchase_id uuid, purchase_name text, lender text, seq integer, due_on date, kind text,
               expected integer, principal integer, interest integer, difference integer, confidence text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.emi_guard('reconcile an EMI');
  v_txn    public.bank_transactions;
  v_text   text;
begin
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found or coalesce(v_txn.debit, 0) <= 0 then return; end if;
  v_text := upper(coalesce(v_txn.description, '') || ' ' || coalesce(v_txn.reference, ''));

  return query
  with cand as (
    -- next unpaid instalment of each active loan
    select p.id as pid, p.name, p.lender as lname, p.lender_ref, s.seq, s.due_on, 'instalment'::text as kind,
           s.emi as expected, s.principal, s.interest
      from public.emi_purchases p
      join lateral (select * from public.emi_schedule s2
                     where s2.purchase_id = p.id and s2.emi_payment_id is null order by s2.seq limit 1) s on true
     where p.tenant_id = v_tenant and p.status = 'active'
    union all
    -- instalments paid by hand (their manual line can be replaced)
    select p.id, p.name, p.lender, p.lender_ref, s.seq, s.due_on, 'paid_by_hand', ep.amount, ep.principal_part, ep.interest_part
      from public.emi_purchases p
      join public.emi_schedule s on s.purchase_id = p.id
      join public.emi_payments ep on ep.id = s.emi_payment_id
      join public.bank_transactions bt on bt.id = ep.bank_txn_id and bt.source = 'manual'
     where p.tenant_id = v_tenant
    union all
    -- down payments still on a manual line
    select p.id, p.name, p.lender, p.lender_ref, 0, p.purchased_on, 'down_payment', bt.debit, 0, 0
      from public.emi_purchases p
      join public.bank_transactions bt on bt.id = p.down_bank_txn_id and bt.source = 'manual'
     where p.tenant_id = v_tenant
  ), scored as (
    select c.*,
           v_txn.debit - c.expected as diff,
           abs(v_txn.txn_date - c.due_on) <= 10 as near,
           ( (c.lname is not null and length(split_part(trim(c.lname), ' ', 1)) >= 3
                and position(upper(split_part(trim(c.lname), ' ', 1)) in v_text) > 0)
             or (c.lender_ref is not null and position(upper(c.lender_ref) in v_text) > 0)
             or v_text ~ '(^|[^A-Z])(EMI|LOAN|NACH|ECS)([^A-Z]|$)' ) as named
      from cand c
  )
  select s.pid, s.name, s.lname, s.seq, s.due_on, s.kind, s.expected, s.principal, s.interest, s.diff,
         case when s.diff = 0 and s.near and s.named then 'exact'
              when s.diff = 0 and (s.near or s.named) then 'high'
              else 'low' end
    from scored s
   where s.diff = 0
      or (s.kind = 'instalment' and s.diff > 0 and s.diff <= greatest(2000, s.expected / 10) and (s.near or s.named))
      or (s.kind = 'instalment' and s.diff < 0 and -s.diff < s.expected / 2 and s.named)
   order by case when s.diff = 0 and s.near and s.named then 0 when s.diff = 0 and (s.near or s.named) then 1 else 2 end,
            abs(s.diff), abs(v_txn.txn_date - s.due_on);
end;
$$;
revoke all on function public.emi_matches_for_bank_txn(uuid) from public, anon;
grant execute on function public.emi_matches_for_bank_txn(uuid) to authenticated, service_role;

-- ── 12. Auto-reconcile: an EMI line with ONE sure EMI match is reconciled to it ──────────
--   R-1864: same as 20261024001702 (R-1657) plus the EMI step before the general suggestion:
--   exactly one candidate with confidence exact/high and the same amount → reconcile_bank_debit_to_emi.
CREATE OR REPLACE FUNCTION public.auto_reconcile_bank_account(p_account_id uuid, p_after uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_trusted   boolean;
  v_tenant    uuid := public.current_tenant_id();
  v_limit     integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_txn       record;
  v_top       record;
  v_second    record;
  v_emi       record;
  v_emi_n     integer;
  v_n         integer;
  v_checked   integer := 0;
  v_reconciled integer := 0;
  v_no_match  integer := 0;
  v_low       integer := 0;
  v_ambiguous integer := 0;
  v_failed    integer := 0;
  v_last      uuid := p_after;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted then
    if v_tenant is null then
      raise exception 'No company on this login' using errcode = '42501';
    end if;
    if not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
      raise exception 'Only an owner, manager, accountant or billing user can match bank lines' using errcode = '42501';
    end if;
    if not exists (select 1 from public.bank_accounts ba where ba.id = p_account_id and ba.tenant_id = v_tenant) then
      raise exception 'Bank account not found' using errcode = 'no_data_found';
    end if;
  end if;

  for v_txn in
    select bt.id, bt.debit
      from public.bank_transactions bt
     where bt.bank_account_id = p_account_id
       and bt.matched_to_id is null
       and (p_after is null or bt.id > p_after)
     order by bt.id
     limit v_limit
  loop
    v_checked := v_checked + 1;
    v_last := v_txn.id;

    -- R-1864: an EMI debit with exactly one sure, same-amount EMI candidate.
    if coalesce(v_txn.debit, 0) > 0 and v_tenant is not null
       and public.current_user_has_role('owner', 'manager', 'accountant') then
      v_emi_n := 0;
      for v_second in
        select m.purchase_id, m.seq, m.confidence
          from public.emi_matches_for_bank_txn(v_txn.id) m
         where m.difference = 0 and m.confidence in ('exact', 'high')
      loop
        v_emi_n := v_emi_n + 1;
        if v_emi_n = 1 then v_emi := v_second; end if;
      end loop;
      if v_emi_n = 1 then
        begin
          perform public.reconcile_bank_debit_to_emi(v_txn.id, v_emi.purchase_id, v_emi.seq);
          v_reconciled := v_reconciled + 1;
        exception when others then
          v_failed := v_failed + 1;
        end;
        continue;
      elsif v_emi_n > 1 then
        v_ambiguous := v_ambiguous + 1;
        continue;
      elsif exists (select 1 from public.emi_matches_for_bank_txn(v_txn.id)) then
        -- An EMI that is not exact (a late fee, a changed amount): the owner picks the split.
        v_low := v_low + 1;
        continue;
      end if;
    end if;

    v_n := 0;
    for v_second in
      select s.match_type, s.match_id, s.match_confidence
        from public.suggest_bank_transaction_matches(v_txn.id) with ordinality as s(match_type, match_id, match_label, match_amount, match_date, match_confidence, ord)
       order by s.ord
       limit 2
    loop
      v_n := v_n + 1;
      if v_n = 1 then v_top := v_second; end if;
    end loop;

    if v_n = 0 then
      v_no_match := v_no_match + 1;
    elsif v_top.match_confidence not in ('exact', 'high') then
      v_low := v_low + 1;
    elsif v_n = 2 and v_second.match_confidence = v_top.match_confidence then
      v_ambiguous := v_ambiguous + 1;
    else
      begin
        perform public.reconcile_bank_txn(v_txn.id, v_top.match_type, v_top.match_id, 'high');
        v_reconciled := v_reconciled + 1;
      exception when others then
        v_failed := v_failed + 1;
      end;
    end if;
  end loop;

  return jsonb_build_object(
    'checked',        v_checked,
    'reconciled',     v_reconciled,
    'review',         v_no_match + v_low + v_ambiguous + v_failed,
    'no_match',       v_no_match,
    'low_confidence', v_low,
    'ambiguous',      v_ambiguous,
    'failed',         v_failed,
    'last_id',        v_last,
    'done',           v_checked < v_limit
  );
end;
$function$;

commit;
