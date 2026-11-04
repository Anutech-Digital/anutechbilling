-- R-2384 (2 Nov 2026): close / archive a bank account (a broken FD at ₹0) — migration
-- 20261102134054_r2384_close_bank_account.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example: an FD of ₹1,00,000 broken on 10 Apr 2026 (one money-out line of ₹1,00,000) is at
-- ₹0 and can be closed; an FD still holding ₹50,000 cannot.
--
-- Proves (as the signed-in browser role, RLS on):
--   A. Close with a balance is refused (₹50,000 named), the account stays active.
--   B. A direct PostgREST-style update is_active = false on that account is refused too (trigger).
--   C. The company's default Petty Cash cannot be closed.
--   D. Closed date in the future / before the last line is refused.
--   E. A sales user cannot close (42501); another company's owner cannot see the account.
--   F. Close at ₹0: inactive, closed_on + note saved, lines kept, balance still readable (history).
--   G. Closing again is refused; Reopen makes it active and clears closed_on / closed_note;
--      reopening an active account is refused.

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
  ('dddddddd-0000-0000-0000-000000238401','R2384 Co','r2384@example.in','07','R2384'),
  ('dddddddd-0000-0000-0000-000000238402','R2384 Other','r2384b@example.in','07','R2384B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000238401','owner2384@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000238402','sales2384@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000238403','other2384@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000238401','dddddddd-0000-0000-0000-000000238401','owner2384@example.in','Owner 2384','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000238402','dddddddd-0000-0000-0000-000000238401','sales2384@example.in','Sales 2384','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000238403','dddddddd-0000-0000-0000-000000238402','other2384@example.in','Owner Other','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000238401','dddddddd-0000-0000-0000-000000238401','FD 1234 (broken)','HDFC Bank','fixed_deposit', 100000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000238402','dddddddd-0000-0000-0000-000000238401','FD 5678','HDFC Bank','fixed_deposit', 50000, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000238401','dddddddd-0000-0000-0000-000000238401','bbbbbbbb-0000-0000-0000-000000238401','2026-04-10','FD PREMAT CLOSURE 1234',100000,0,'P1','csv_upload');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000238401","role":"authenticated"}', true);

-- A. close with a balance → refused, still active
do $$
begin
  perform public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238402', '2026-10-01', null);
  raise exception 'FAIL A: closed an account holding ₹50,000';
exception when others then
  if sqlerrm not like '%balance of ₹50000%closed only at ₹0%' then raise exception 'FAIL A: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  if not (select is_active from public.bank_accounts where id = 'bbbbbbbb-0000-0000-0000-000000238402') then
    raise exception 'FAIL A: account went inactive';
  end if;
end $$;

-- B. direct update is refused by the trigger
do $$
begin
  update public.bank_accounts set is_active = false where id = 'bbbbbbbb-0000-0000-0000-000000238402';
  raise exception 'FAIL B: direct update closed an account holding ₹50,000';
exception when others then
  if sqlerrm not like '%balance of ₹50000%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;

-- C. the default Petty Cash (made with the company, R-1834) cannot be closed
do $$
declare v_pc uuid;
begin
  select id into v_pc from public.bank_accounts
   where tenant_id = 'dddddddd-0000-0000-0000-000000238401' and is_default_petty_cash;
  if v_pc is null then raise exception 'FAIL C: no default Petty Cash to test with'; end if;
  begin
    perform public.close_bank_account(v_pc, null, null);
    raise exception 'FAIL C: closed the default Petty Cash';
  exception when others then
    if sqlerrm not like '%Petty Cash cannot be closed%' then raise exception 'FAIL C: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- D. closed date in the future / before the last line
do $$
begin
  begin
    perform public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238401', public.ist_today() + 1, null);
    raise exception 'FAIL D: future date accepted';
  exception when others then
    if sqlerrm not like '%cannot be in the future%' then raise exception 'FAIL D (future): wrong refusal: %', sqlerrm; end if;
  end;
  begin
    perform public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238401', '2026-04-09', null);
    raise exception 'FAIL D: date before the last line accepted';
  exception when others then
    if sqlerrm not like '%before the last line on this account (10 Apr 2026)%' then raise exception 'FAIL D (before): wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- E. sales user: refused; another company's owner: not found
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000238402","role":"authenticated"}', true);
do $$
begin
  perform public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238401', '2026-04-10', null);
  raise exception 'FAIL E: sales user closed an account';
exception when others then
  if sqlstate <> '42501' or sqlerrm not like 'Only an owner, manager or accountant%' then raise exception 'FAIL E (sales): wrong refusal: % %', sqlstate, sqlerrm; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000238403","role":"authenticated"}', true);
do $$
begin
  perform public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238401', '2026-04-10', null);
  raise exception 'FAIL E: another company closed the account';
exception when others then
  if sqlerrm <> 'Bank account not found' then raise exception 'FAIL E (tenant): wrong refusal: %', sqlerrm; end if;
end $$;
do $$
begin
  update public.bank_accounts set is_active = false where id = 'bbbbbbbb-0000-0000-0000-000000238401';
  if found then raise exception 'FAIL E: another company updated the account directly'; end if;
end $$;

-- F. close at ₹0
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000238401","role":"authenticated"}', true);
select public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238401', '2026-04-10', '  FD broken, money to HDFC Current  ');
do $$
declare v public.bank_accounts;
begin
  select * into v from public.bank_accounts where id = 'bbbbbbbb-0000-0000-0000-000000238401';
  if v.is_active or v.closed_on is distinct from '2026-04-10'::date or v.closed_note is distinct from 'FD broken, money to HDFC Current' then
    raise exception 'FAIL F: row %', row_to_json(v);
  end if;
  if (select count(*) from public.bank_transactions where bank_account_id = v.id) <> 1 then
    raise exception 'FAIL F: lines were not kept';
  end if;
  if public.bank_account_current_balance(v.id) <> 0 then
    raise exception 'FAIL F: closed account balance not readable as ₹0';
  end if;
end $$;

-- G. close again refused; reopen clears; reopen active refused
do $$
begin
  perform public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238401', null, null);
  raise exception 'FAIL G: closed twice';
exception when others then
  if sqlerrm <> 'This account is already closed' then raise exception 'FAIL G (twice): wrong refusal: %', sqlerrm; end if;
end $$;
select public.reopen_bank_account('bbbbbbbb-0000-0000-0000-000000238401');
do $$
declare v public.bank_accounts;
begin
  select * into v from public.bank_accounts where id = 'bbbbbbbb-0000-0000-0000-000000238401';
  if not v.is_active or v.closed_on is not null or v.closed_note is not null then
    raise exception 'FAIL G: reopen row %', row_to_json(v);
  end if;
  begin
    perform public.reopen_bank_account(v.id);
    raise exception 'FAIL G: reopened an active account';
  exception when others then
    if sqlerrm <> 'This account is not closed' then raise exception 'FAIL G (reopen): wrong refusal: %', sqlerrm; end if;
  end;
end $$;

reset role;
select 'R-2384 close bank account: ALL PASS' as result;

rollback;
