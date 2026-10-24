-- R-1834 (24 Oct 2026): every company gets ONE empty "Petty Cash" account by default.
-- Migration: 20261024101339_r1834_default_petty_cash.sql
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/default_petty_cash.test.sql
--
-- What it proves:
--   1. A NEW company gets exactly one Petty Cash: cash, ₹0, active, opening date = 1 April of
--      the current IST FY, marked is_default_petty_cash — in the same transaction as the company.
--   2. Backfill: an existing company with no cash account gets one; a company that already has a
--      cash account of its own gets NONE; a bank-only company gets one.
--   3. Running the backfill twice adds nothing (returns 0, counts unchanged).
--   4. A second AUTO Petty Cash for the same company is refused (unique index), but a company
--      may still add more cash accounts by hand.
--   5. Only a trusted session may run the backfill — a signed-in user is refused (42501).
--   6. Petty Cash can be deleted while empty; with a bank line it is refused.
--   7. No money: every auto account is ₹0 and no other row changed.

begin;

-- ── 1. New company ──────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code) values
  ('a1834000-0000-4000-8000-0000000000a1', 'R1834 New Co', 'r1834-new@example.in', '07');

do $$
declare
  n int; r record;
  v_today date := public.ist_today();
  v_fy date := make_date(extract(year from v_today)::int - case when extract(month from v_today) < 4 then 1 else 0 end, 4, 1);
begin
  select count(*) into n from public.bank_accounts
   where tenant_id = 'a1834000-0000-4000-8000-0000000000a1' and account_type = 'cash';
  if n <> 1 then raise exception 'FAIL 1a: a new company should get exactly one cash account, got %', n; end if;

  select * into r from public.bank_accounts where tenant_id = 'a1834000-0000-4000-8000-0000000000a1';
  if r.name <> 'Petty Cash' or r.opening_balance <> 0 or not r.is_active or not r.is_default_petty_cash
     or r.bank_name <> 'Cash in hand' then
    raise exception 'FAIL 1b: Petty Cash row is wrong: %', row_to_json(r);
  end if;
  if r.opening_balance_date <> v_fy then
    raise exception 'FAIL 1c: opening date should be FY start %, got %', v_fy, r.opening_balance_date;
  end if;
end $$;

-- ── 2. Existing companies (made with the trigger off = "before the migration") ──
alter table public.tenants disable trigger trg_tenants_default_petty_cash;
insert into public.tenants (id, name, email, state_code) values
  ('a1834000-0000-4000-8000-0000000000b1', 'R1834 No cash',   'r1834-p@example.in', '07'),
  ('a1834000-0000-4000-8000-0000000000b2', 'R1834 Own cash',  'r1834-q@example.in', '07'),
  ('a1834000-0000-4000-8000-0000000000b3', 'R1834 Bank only', 'r1834-r@example.in', '07');
alter table public.tenants enable trigger trg_tenants_default_petty_cash;

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date, created_at) values
  ('a1834000-0000-4000-8000-00000000c0b2', 'a1834000-0000-4000-8000-0000000000b2', 'Office cash box', 'Cash in hand', 'cash', 2500, '2026-04-01', now() - interval '30 days'),
  ('a1834000-0000-4000-8000-00000000c0b3', 'a1834000-0000-4000-8000-0000000000b3', 'HDFC Current',    'HDFC Bank',    'current', 50000, '2026-04-01', now() - interval '30 days');

create temp table t_before as
  select id, tenant_id, name, opening_balance, opening_balance_date, account_type, is_active, notes
    from public.bank_accounts;

do $$
declare n int; v_added int;
begin
  select public.backfill_default_petty_cash() into v_added;
  if v_added < 2 then raise exception 'FAIL 2a: backfill should add at least the 2 test companies, added %', v_added; end if;

  select count(*) into n from public.bank_accounts
   where tenant_id = 'a1834000-0000-4000-8000-0000000000b1' and account_type = 'cash' and is_default_petty_cash;
  if n <> 1 then raise exception 'FAIL 2b: company with no cash account should get one Petty Cash, got %', n; end if;

  select count(*) into n from public.bank_accounts
   where tenant_id = 'a1834000-0000-4000-8000-0000000000b2' and account_type = 'cash';
  if n <> 1 then raise exception 'FAIL 2c: company with its own cash account must get NO duplicate, has % cash accounts', n; end if;

  select count(*) into n from public.bank_accounts
   where tenant_id = 'a1834000-0000-4000-8000-0000000000b3' and account_type = 'cash' and is_default_petty_cash;
  if n <> 1 then raise exception 'FAIL 2d: bank-only company should get one Petty Cash, got %', n; end if;

  -- sorts BELOW the company's existing accounts (pickers default to the newest account)
  if (select created_at from public.bank_accounts where tenant_id = 'a1834000-0000-4000-8000-0000000000b3' and is_default_petty_cash)
     >= (select created_at from public.bank_accounts where id = 'a1834000-0000-4000-8000-00000000c0b3') then
    raise exception 'FAIL 2e: backfilled Petty Cash must be older than the company''s bank account (it would become the default source)';
  end if;

  -- the new company from step 1 already had one — still exactly one
  select count(*) into n from public.bank_accounts
   where tenant_id = 'a1834000-0000-4000-8000-0000000000a1' and account_type = 'cash';
  if n <> 1 then raise exception 'FAIL 2f: backfill duplicated the new company''s Petty Cash (% cash accounts)', n; end if;
end $$;

-- ── 3. Idempotent ───────────────────────────────────────────────────────────
do $$
declare n_before int; n_after int; v_added int;
begin
  select count(*) into n_before from public.bank_accounts;
  select public.backfill_default_petty_cash() into v_added;
  select count(*) into n_after from public.bank_accounts;
  if v_added <> 0 or n_after <> n_before then
    raise exception 'FAIL 3: second backfill added % (rows % -> %)', v_added, n_before, n_after;
  end if;
end $$;

-- ── 4. One AUTO account per company; more cash accounts by hand are fine ──────
do $$
declare v_err boolean := false;
begin
  begin
    insert into public.bank_accounts (tenant_id, name, bank_name, account_type, is_default_petty_cash)
      values ('a1834000-0000-4000-8000-0000000000a1', 'Second auto', 'Cash in hand', 'cash', true);
  exception when unique_violation then v_err := true; end;
  if not v_err then raise exception 'FAIL 4a: a second auto Petty Cash was allowed'; end if;

  insert into public.bank_accounts (tenant_id, name, bank_name, account_type)
    values ('a1834000-0000-4000-8000-0000000000a1', 'Branch cash', 'Cash in hand', 'cash');
end $$;

-- ── 5. Only a trusted session may run the backfill ──────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('a1834000-0000-4000-8000-00000000e0a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1834-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('a1834000-0000-4000-8000-00000000e0a1', 'a1834000-0000-4000-8000-0000000000a1', 'r1834-owner@example.in', 'owner');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'a1834000-0000-4000-8000-00000000e0a1', 'role', 'authenticated')::text, true);
do $$
declare v_state text := 'ok';
begin
  begin
    perform public.backfill_default_petty_cash();
  exception when others then v_state := sqlstate; end;
  if v_state <> '42501' then raise exception 'FAIL 5: a signed-in owner ran the backfill (sqlstate %)', v_state; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ── 6. Delete: allowed while empty, refused with a bank line ────────────────
do $$
declare v_err boolean := false; v_id uuid;
begin
  select id into v_id from public.bank_accounts
   where tenant_id = 'a1834000-0000-4000-8000-0000000000b3' and is_default_petty_cash;
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit)
    values ('a1834000-0000-4000-8000-0000000000b3', v_id, '2026-10-01', 'Tea and snacks', 300, 0);
  begin
    delete from public.bank_accounts where id = v_id;
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 6a: Petty Cash with a bank line was deleted'; end if;

  select id into v_id from public.bank_accounts
   where tenant_id = 'a1834000-0000-4000-8000-0000000000b1' and is_default_petty_cash;
  delete from public.bank_accounts where id = v_id;
  if exists (select 1 from public.bank_accounts where id = v_id) then
    raise exception 'FAIL 6b: an empty Petty Cash could not be deleted';
  end if;
end $$;

-- ── 7. No money changed ─────────────────────────────────────────────────────
do $$
declare n int;
begin
  if exists (select 1 from public.bank_accounts where is_default_petty_cash and opening_balance <> 0) then
    raise exception 'FAIL 7a: an auto Petty Cash carries an opening balance';
  end if;
  select count(*) into n
    from t_before b join public.bank_accounts a on a.id = b.id
   where (a.name, a.opening_balance, a.opening_balance_date, a.account_type, a.is_active, a.notes)
         is distinct from (b.name, b.opening_balance, b.opening_balance_date, b.account_type, b.is_active, b.notes);
  if n <> 0 then raise exception 'FAIL 7b: the backfill changed % existing account(s)', n; end if;
end $$;

select 'PASS default_petty_cash' as result;

rollback;
