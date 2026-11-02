-- R-2373 (2 Nov 2026): a negative Overdraft (OD / cash-credit) balance is a borrowing — the
-- Balance Sheet shows it as "Bank overdraft" under Borrowings, not netted into Cash & bank.
-- Migration 20261102145600_r2373_bank_overdraft_bs (on top of R-2323's report_balance_sheet).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example (OD audit, 2 Nov): HDFC current account + an HDFC OD account that is overdrawn.
--
-- Proves:
--   A. OD at -50,000 → bank_overdraft 50,000; cash_and_bank is only the current account
--      (2,00,000), not 1,50,000. A credit card at -5,000 stays credit_card_payable.
--   B. It still balances: cash_and_bank − bank_overdraft − credit_card_payable = the sum of
--      every account's balance (net worth unchanged by the move).
--   C. OD back in credit at +10,000 → in cash_and_bank (2,10,000), bank_overdraft 0.
--   D. Tenant isolation: the other company's OD at -70,000 shows only in its own Balance Sheet.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000237301','R2373 Co','r2373@example.in','07','R2373'),
  ('dddddddd-0000-0000-0000-000000237302','R2373 Other','r2373b@example.in','07','R2373B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000237301','owner2373@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000237302','owner2373b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000237301','dddddddd-0000-0000-0000-000000237301','owner2373@example.in','Owner 2373','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000237302','dddddddd-0000-0000-0000-000000237302','owner2373b@example.in','Owner 2373B','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000237301','dddddddd-0000-0000-0000-000000237301','HDFC Current','HDFC','current', 200000),
  ('bbbbbbbb-0000-0000-0000-000000237302','dddddddd-0000-0000-0000-000000237301','HDFC OD','HDFC','overdraft', 0),
  ('bbbbbbbb-0000-0000-0000-000000237303','dddddddd-0000-0000-0000-000000237301','Company card','HDFC','credit_card', -5000),
  ('bbbbbbbb-0000-0000-0000-000000237304','dddddddd-0000-0000-0000-000000237302','Other OD','SBI','overdraft', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  -- the OD is drawn: ₹50,000 out of the OD account
  ('22222222-0000-0000-0000-000000237301','dddddddd-0000-0000-0000-000000237301','bbbbbbbb-0000-0000-0000-000000237302','2026-10-10','OD DRAWN VENDOR',50000,0,'OD1','csv_upload'),
  -- the other company's OD at -70,000
  ('22222222-0000-0000-0000-000000237302','dddddddd-0000-0000-0000-000000237302','bbbbbbbb-0000-0000-0000-000000237304','2026-10-10','OD DRAWN',70000,0,'OD2','csv_upload');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237301","role":"authenticated"}', true);

-- ── A + B. OD at -50,000 ───────────────────────────────────────────────────────────────
do $$
declare
  r record;
  v_raw bigint;
begin
  select * into r from public.report_balance_sheet('2026-12-31');
  if r.bank_overdraft <> 50000 then
    raise exception 'FAIL A1: bank_overdraft % (expected 50000 — the OD at -50,000 is a borrowing)', r.bank_overdraft;
  end if;
  if r.cash_and_bank <> 200000 then
    raise exception 'FAIL A2: cash_and_bank % (expected 200000 — the OD must not be netted into cash)', r.cash_and_bank;
  end if;
  if r.credit_card_payable <> 5000 then
    raise exception 'FAIL A3: credit_card_payable % (expected 5000)', r.credit_card_payable;
  end if;

  select sum(a.opening_balance + coalesce((select sum(t.credit - t.debit) from public.bank_transactions t
                                            where t.bank_account_id = a.id), 0))::bigint
    into v_raw from public.bank_accounts a where a.tenant_id = 'dddddddd-0000-0000-0000-000000237301';
  if r.cash_and_bank - r.bank_overdraft - r.credit_card_payable <> v_raw then
    raise exception 'FAIL B: cash % − OD % − card % <> account balances %',
      r.cash_and_bank, r.bank_overdraft, r.credit_card_payable, v_raw;
  end if;
end $$;

-- ── C. OD back in credit at +10,000 ────────────────────────────────────────────────────
select set_config('request.jwt.claims', '', true);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000237303','dddddddd-0000-0000-0000-000000237301','bbbbbbbb-0000-0000-0000-000000237302','2026-10-20','OD REPAID',0,60000,'OD3','csv_upload');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237301","role":"authenticated"}', true);

do $$
declare r record;
begin
  select * into r from public.report_balance_sheet('2026-12-31');
  if r.bank_overdraft <> 0 then
    raise exception 'FAIL C1: bank_overdraft % (expected 0 — the OD is in credit)', r.bank_overdraft;
  end if;
  if r.cash_and_bank <> 210000 then
    raise exception 'FAIL C2: cash_and_bank % (expected 210000 — a positive OD balance is cash)', r.cash_and_bank;
  end if;
end $$;

-- ── D. Tenant isolation ─────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237302","role":"authenticated"}', true);

do $$
declare r record;
begin
  select * into r from public.report_balance_sheet('2026-12-31');
  if r.bank_overdraft <> 70000 or r.cash_and_bank <> 0 then
    raise exception 'FAIL D: other company sees OD % / cash % (expected 70000 / 0)', r.bank_overdraft, r.cash_and_bank;
  end if;
end $$;

select 'R-2373 bank overdraft on the Balance Sheet: ALL PASS' as result;

rollback;
