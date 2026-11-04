-- R-2366 (2 Nov 2026, Pardeep: "app me interest income ka option banao"):
--   interest credits (FD / savings) and FD premature closures (principal + interest in one line,
--   TDS deducted) could not be booked. Migration 20261102100702_r2366_interest_income_fd_closure.
--   Self-asserting, ONE transaction, rolled back.
--
--   A. ₹88 savings interest → other_incomes 'interest' (source savings), P&L interest ₹88.
--   B. FD closure ₹1,05,400 = principal ₹1,00,000 + interest ₹5,400, TDS ₹600:
--      FD line added (debit ₹1,00,000, OWN-TRANSFER) → FD balance 0; P&L interest gross ₹6,000;
--      tds_receivable ₹600 (194A); money balanced: Δbank + ΔFD + ΔTDS = Δincome.
--   C. Un-reconcile the bank line → income row, TDS row and added FD line gone; FD back to ₹1,00,000.
--   D. FD with its own statement line: that line is matched; un-reconciling the FD line
--      un-reconciles the bank line too (and keeps the statement line, freed).
--   E. Refusals: principal > FD balance; parts not adding up; principal without FD; non-FD account.
--   F. Tenant isolation: another company's owner cannot book this line, and sees none of its rows.

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
  ('dddddddd-0000-0000-0000-000000236601','R2366 Int Co','r2366int@example.in','07','R66I'),
  ('dddddddd-0000-0000-0000-000000236602','R2366 Other Co','r2366oth@example.in','07','R66O');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000236601','owner2366@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000236602','owner2366b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000236601','dddddddd-0000-0000-0000-000000236601','owner2366@example.in','Owner Int','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000236602','dddddddd-0000-0000-0000-000000236602','owner2366b@example.in','Owner Other','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000236601','dddddddd-0000-0000-0000-000000236601','HDFC Current','HDFC','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000236602','dddddddd-0000-0000-0000-000000236601','HDFC FD 1','HDFC','fixed_deposit', 100000),
  ('bbbbbbbb-0000-0000-0000-000000236603','dddddddd-0000-0000-0000-000000236601','HDFC FD 2','HDFC','fixed_deposit', 50000),
  ('bbbbbbbb-0000-0000-0000-000000236604','dddddddd-0000-0000-0000-000000236601','ICICI Savings','ICICI','savings', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000236601','dddddddd-0000-0000-0000-000000236601','bbbbbbbb-0000-0000-0000-000000236601','2026-06-30','SB INT CREDIT',0,88,null,'manual'),
  ('11111111-0000-0000-0000-000000236602','dddddddd-0000-0000-0000-000000236601','bbbbbbbb-0000-0000-0000-000000236601','2026-06-12','FD PREMAT CLOSURE 5012',0,105400,null,'manual'),
  ('11111111-0000-0000-0000-000000236603','dddddddd-0000-0000-0000-000000236601','bbbbbbbb-0000-0000-0000-000000236601','2026-04-10','FD CLOSURE 5013',0,52000,null,'manual'),
  -- FD 2's own statement: principal paid out a day later
  ('11111111-0000-0000-0000-000000236604','dddddddd-0000-0000-0000-000000236601','bbbbbbbb-0000-0000-0000-000000236603','2026-04-11','PAID TO CA',50000,0,'FDST1','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236601","role":"authenticated"}', true);

create function pg_temp.bal(acc uuid) returns bigint language sql as $f$
  select (select opening_balance from public.bank_accounts where id = acc)
       + coalesce((select sum(credit - debit) from public.bank_transactions where bank_account_id = acc), 0)
$f$;
create function pg_temp.tds() returns bigint language sql as $f$
  select coalesce(sum(tds_amount), 0) from public.tds_receivable
   where tenant_id = 'dddddddd-0000-0000-0000-000000236601' and status in ('pending_cert','cert_received','verified_26as')
$f$;
create function pg_temp.inc() returns bigint language sql as $f$
  select coalesce(sum(amount), 0) from public.other_incomes where tenant_id = 'dddddddd-0000-0000-0000-000000236601'
$f$;

do $$
declare
  r jsonb; ok boolean; v_fd_line uuid; v_tds_id text;
  b_fd bigint; b_tds bigint; b_inc bigint;
begin
  -- A
  r := public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000236601', 'savings', null, 0, 88, 0, null);
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000236601') <> 'other_income' then
    raise exception 'FAIL A: line not reconciled as other_income'; end if;
  if (select source from public.other_incomes where bank_txn_id = '11111111-0000-0000-0000-000000236601') <> 'savings' then
    raise exception 'FAIL A: source not kept'; end if;
  if (select amount from public.report_pnl_other_income('2026-06-30', '2026-06-30') where head = 'interest') is distinct from 88 then
    raise exception 'FAIL A: P&L interest is not ₹88'; end if;
  raise notice 'A PASS: savings interest ₹88 booked, P&L other income';

  -- B
  b_fd := pg_temp.bal('bbbbbbbb-0000-0000-0000-000000236602');
  b_tds := pg_temp.tds(); b_inc := pg_temp.inc();
  r := public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000236602', 'fd',
         'bbbbbbbb-0000-0000-0000-000000236602', 100000, 5400, 600, null);
  v_fd_line := (r->>'fd_txn_id')::uuid;
  if not coalesce((r->>'fd_added')::boolean, false) then raise exception 'FAIL B: FD line not added (%)', r; end if;
  if (select debit from public.bank_transactions where id = v_fd_line) <> 100000
     or (select matched_to_id from public.bank_transactions where id = v_fd_line) <> '11111111-0000-0000-0000-000000236602' then
    raise exception 'FAIL B: FD line wrong'; end if;
  if pg_temp.bal('bbbbbbbb-0000-0000-0000-000000236602') <> 0 then
    raise exception 'FAIL B: FD balance is % not 0', pg_temp.bal('bbbbbbbb-0000-0000-0000-000000236602'); end if;
  if (select amount from public.report_pnl_other_income('2026-06-12', '2026-06-12') where head = 'interest') is distinct from 6000 then
    raise exception 'FAIL B: P&L interest is not gross ₹6,000'; end if;
  select tds_receivable_id into v_tds_id from public.other_incomes where bank_txn_id = '11111111-0000-0000-0000-000000236602';
  if (select tds_amount from public.tds_receivable where id = v_tds_id) <> 600
     or (select section from public.tds_receivable where id = v_tds_id) <> '194A'
     or (select net_paid from public.tds_receivable where id = v_tds_id) <> 5400 then
    raise exception 'FAIL B: TDS receivable row wrong'; end if;
  -- Dr bank 1,05,400 + Dr TDS 600 = Cr FD 1,00,000 + Cr interest 6,000
  if 105400 + (pg_temp.tds() - b_tds) <> (b_fd - pg_temp.bal('bbbbbbbb-0000-0000-0000-000000236602')) + (pg_temp.inc() - b_inc) then
    raise exception 'FAIL B: not balanced'; end if;
  raise notice 'B PASS: FD closure split — FD 0, interest ₹6,000 gross, TDS ₹600, balanced';

  -- C
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000236602', null, null, null);
  if exists (select 1 from public.other_incomes where bank_txn_id = '11111111-0000-0000-0000-000000236602') then
    raise exception 'FAIL C: income row kept'; end if;
  if exists (select 1 from public.tds_receivable where id = v_tds_id) then raise exception 'FAIL C: TDS row kept'; end if;
  if exists (select 1 from public.bank_transactions where id = v_fd_line) then raise exception 'FAIL C: added FD line kept'; end if;
  if pg_temp.bal('bbbbbbbb-0000-0000-0000-000000236602') <> 100000 then raise exception 'FAIL C: FD not back to ₹1,00,000'; end if;
  if pg_temp.inc() <> b_inc or pg_temp.tds() <> b_tds then raise exception 'FAIL C: totals not back'; end if;
  raise notice 'C PASS: un-reconcile reverses income, TDS and FD line';

  -- D
  r := public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000236603', 'fd',
         'bbbbbbbb-0000-0000-0000-000000236603', 50000, 2000, 0, null);
  if coalesce((r->>'fd_added')::boolean, true) or (r->>'fd_txn_id')::uuid <> '11111111-0000-0000-0000-000000236604' then
    raise exception 'FAIL D: FD statement line not used (%)', r; end if;
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000236604', null, null, null);
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000236603') is not null then
    raise exception 'FAIL D: bank line still reconciled after FD side undone'; end if;
  if exists (select 1 from public.other_incomes where bank_txn_id = '11111111-0000-0000-0000-000000236603') then
    raise exception 'FAIL D: income row kept'; end if;
  if not exists (select 1 from public.bank_transactions where id = '11111111-0000-0000-0000-000000236604' and matched_to_type is null) then
    raise exception 'FAIL D: FD statement line not kept / freed'; end if;
  raise notice 'D PASS: FD statement line matched; undoing it undoes the closure';

  -- E
  ok := false;
  begin perform public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000236602', 'fd',
          'bbbbbbbb-0000-0000-0000-000000236603', 103400, 2000, 0, null);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL E: principal above FD balance taken'; end if;
  ok := false;
  begin perform public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000236602', 'fd',
          'bbbbbbbb-0000-0000-0000-000000236602', 100000, 5000, 0, null);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL E: parts not adding up taken'; end if;
  ok := false;
  begin perform public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000236602', 'savings', null, 100000, 5400, 0, null);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL E: principal without FD taken'; end if;
  ok := false;
  begin perform public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000236602', 'fd',
          'bbbbbbbb-0000-0000-0000-000000236604', 100000, 5400, 0, null);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL E: savings account taken as FD'; end if;
  raise notice 'E PASS: refusals';
end $$;

-- F: another company
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236602","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000236602', 'savings', null, 0, 105400, 0, null);
  exception when sqlstate '42501' then ok := true; end;
  if not ok then raise exception 'FAIL F: another company booked this line'; end if;
end $$;
set local role authenticated;
do $$
begin
  if exists (select 1 from public.other_incomes) then raise exception 'FAIL F: other company sees income rows'; end if;
  raise notice 'F PASS: tenant isolation';
end $$;
reset role;

select 'R-2366 interest income + FD closure: ALL PASS' as result;

rollback;
