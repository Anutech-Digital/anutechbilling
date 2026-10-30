-- R-2095 (30 Oct 2026, September reconcile on staging), P1:
--   interest credited by the bank could only be "marked reconciled" (no income anywhere), and an FD
--   sweep-in / sweep-out never moved the FD account.
-- Migration 20261030140000_r2095_other_income_fd_transfer. Self-asserting, ONE transaction, rolled back.
--
--   A. ₹1,234 interest line → book_bank_credit_as_other_income('interest') → other_incomes row,
--      line matched 'other_income', report_pnl_other_income shows interest ₹1,234.
--   B. Un-reconciling that line removes the income row.
--   C. A money-out line can not be income (22023); a second booking of the same line is refused.
--   D. Sweep-in ₹50,000 into the current account, FD account has no statement → transfer adds the
--      FD's opposite line (debit ₹50,000, OWN-TRANSFER), both matched 'transfer' to each other;
--      the FD balance moves by −₹50,000.
--   E. Un-reconciling the current-account line removes the added FD line.
--   F. Sweep-out ₹20,000 when the FD account HAS its own statement line (credit ₹20,000, a day
--      later) → that line is matched, nothing is added.
--   G. Same account → refused.

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
  ('dddddddd-0000-0000-0000-000000209571','R2095 FD Co','r2095fd@example.in','07','R95F');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000209571','owner2095fd@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000209571','dddddddd-0000-0000-0000-000000209571','owner2095fd@example.in','Owner FD','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000209571','dddddddd-0000-0000-0000-000000209571','HDFC Current','HDFC','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000209572','dddddddd-0000-0000-0000-000000209571','HDFC FD 1','HDFC','fixed_deposit', 100000);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000209571','dddddddd-0000-0000-0000-000000209571','bbbbbbbb-0000-0000-0000-000000209571','2026-09-30','INT.PD 01-07-26 TO 30-09-26',0,1234,null,'manual'),
  ('11111111-0000-0000-0000-000000209572','dddddddd-0000-0000-0000-000000209571','bbbbbbbb-0000-0000-0000-000000209571','2026-09-30','NEFT OUT',500,0,'UTRX1','manual'),
  ('11111111-0000-0000-0000-000000209573','dddddddd-0000-0000-0000-000000209571','bbbbbbbb-0000-0000-0000-000000209571','2026-09-12','SWEEP IN FROM FD',0,50000,null,'manual'),
  ('11111111-0000-0000-0000-000000209574','dddddddd-0000-0000-0000-000000209571','bbbbbbbb-0000-0000-0000-000000209571','2026-09-20','SWEEP OUT TO FD',20000,0,null,'manual'),
  ('11111111-0000-0000-0000-000000209575','dddddddd-0000-0000-0000-000000209571','bbbbbbbb-0000-0000-0000-000000209572','2026-09-21','DEPOSIT FROM CA',0,20000,null,'manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000209571","role":"authenticated"}', true);

do $$
declare v uuid; r jsonb; ok boolean; v_n int; v_pair uuid; v_fd_before bigint; v_fd_after bigint;
begin
  -- A
  v := public.book_bank_credit_as_other_income('11111111-0000-0000-0000-000000209571', 'interest', null);
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000209571') <> 'other_income' then
    raise exception 'FAIL A: line not matched other_income'; end if;
  if (select amount from public.report_pnl_other_income('2026-09-01', '2026-09-30') where head = 'interest') is distinct from 1234 then
    raise exception 'FAIL A: P&L other income is not ₹1,234 interest'; end if;
  raise notice 'A PASS: interest ₹1,234 booked and in P&L other income';

  -- B
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000209571', null, null, null);
  if exists (select 1 from public.other_incomes where bank_txn_id = '11111111-0000-0000-0000-000000209571') then
    raise exception 'FAIL B: income row kept after un-reconcile'; end if;
  raise notice 'B PASS: un-reconcile removes the income';

  -- C
  ok := false;
  begin perform public.book_bank_credit_as_other_income('11111111-0000-0000-0000-000000209572', 'interest', null);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL C: a money-out line was booked as income'; end if;
  perform public.book_bank_credit_as_other_income('11111111-0000-0000-0000-000000209571', 'other', 'misc');
  ok := false;
  begin perform public.book_bank_credit_as_other_income('11111111-0000-0000-0000-000000209571', 'interest', null);
  exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FAIL C: a reconciled line was booked twice'; end if;
  raise notice 'C PASS: refusals';

  -- D
  select coalesce(sum(credit - debit), 0) into v_fd_before from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000209572';
  r := public.reconcile_bank_txn_as_transfer('11111111-0000-0000-0000-000000209573', 'bbbbbbbb-0000-0000-0000-000000209572');
  v_pair := (r->>'pair_id')::uuid;
  if not coalesce((r->>'added')::boolean, false) then raise exception 'FAIL D: no FD line added (%)', r; end if;
  if (select debit from public.bank_transactions where id = v_pair) <> 50000
     or (select matched_to_id from public.bank_transactions where id = v_pair) <> '11111111-0000-0000-0000-000000209573'
     or (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000209573') <> v_pair::text then
    raise exception 'FAIL D: pair not linked both ways'; end if;
  select coalesce(sum(credit - debit), 0) into v_fd_after from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000209572';
  if v_fd_after - v_fd_before <> -50000 then raise exception 'FAIL D: FD moved by %', v_fd_after - v_fd_before; end if;
  raise notice 'D PASS: sweep-in posted against the FD (−₹50,000)';

  -- E
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000209573', null, null, null);
  if exists (select 1 from public.bank_transactions where id = v_pair) then raise exception 'FAIL E: added FD line kept'; end if;
  raise notice 'E PASS: un-reconcile removes the added FD line';

  -- F
  r := public.reconcile_bank_txn_as_transfer('11111111-0000-0000-0000-000000209574', 'bbbbbbbb-0000-0000-0000-000000209572');
  if coalesce((r->>'added')::boolean, true) or (r->>'pair_id')::uuid <> '11111111-0000-0000-0000-000000209575' then
    raise exception 'FAIL F: the FD''s own line was not used (%)', r; end if;
  raise notice 'F PASS: FD statement line matched, nothing added';

  -- G
  ok := false;
  begin perform public.reconcile_bank_txn_as_transfer('11111111-0000-0000-0000-000000209573', 'bbbbbbbb-0000-0000-0000-000000209571');
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL G: same account taken'; end if;
  raise notice 'G PASS';
end $$;

select 'R-2095 other income + FD transfer: ALL PASS' as result;

rollback;
