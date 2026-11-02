-- R-2374 (2 Nov 2026): a credit line (OD / flexi) from a lender + the finance cost on it.
-- Migration 20261102151425_r2374_credit_line (on top of R-885 / R-2377 business loans).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example (OD audit 2 Nov): Bajaj Finance flexi / OD, limit ₹50,00,000 —
--   6 Jun  +₹40,00,000  drawdown (imported "BAJAJ FINANCE FLEXI DISB")
--   5 Jul  −₹46,000     interest-only ACH
--   5 Aug  −₹1,66,000   ₹1,20,000 principal + ₹46,000 interest in one debit
--   5 Sep  −₹41,400     ₹46,000 interest less ₹4,600 TDS u/s 194A
-- and a Tata Capital term loan ₹2,00,000 repaid in one debit.
--
-- Proves:
--   A. A credit line starts at ₹0 drawn; the Balance Sheet borrowings do not move.
--   B. Drawdown: outstanding ₹40,00,000, the imported line matched once (no new bank line, cash
--      unchanged); BS business_loans_payable +₹40,00,000.
--   C. Interest-only debit: outstanding unchanged; ₹46,000 'Interest on loans / OD' in the P&L;
--      not payable, not paid-unbanked.
--   D. Split debit: outstanding ₹38,80,000; BS −₹1,20,000; P&L interest ₹92,000.
--   E. TDS 194A: the expense is the gross ₹46,000; ₹4,600 shows in dues_vendor_tds.
--   F. Refused, nothing written: parts not adding to the line, principal over outstanding, a
--      drawdown on a term loan / a money-out line, a line already reconciled, another company's
--      line or loan, TDS over the interest, a role outside the record group.
--   G. Un-reconcile: a repayment goes with its interest expense; a drawdown is refused while
--      more principal is repaid than would be left drawn, then goes; delete refused while a
--      bank drawdown is on the books.
--   H. Tenant isolation: another company's user reads no drawdowns (RLS).
--   I. A term loan (Tata Capital) repaid through the same split closes.

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
  ('dddddddd-0000-0000-0000-000000237401','R2374 Co','r2374@example.in','07','R2374'),
  ('dddddddd-0000-0000-0000-000000237402','R2374 Other','r2374b@example.in','07','R2374B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000237401','owner2374@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000237402','owner2374b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000237403','sales2374@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000237401','dddddddd-0000-0000-0000-000000237401','owner2374@example.in','Owner 2374','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000237402','dddddddd-0000-0000-0000-000000237402','owner2374b@example.in','Other owner','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000237403','dddddddd-0000-0000-0000-000000237401','sales2374@example.in','Sales 2374','sales', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000237401','dddddddd-0000-0000-0000-000000237401','HDFC Current','HDFC', 500000),
  ('bbbbbbbb-0000-0000-0000-000000237402','dddddddd-0000-0000-0000-000000237402','Other bank','SBI', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000237401','dddddddd-0000-0000-0000-000000237401','bbbbbbbb-0000-0000-0000-000000237401','2026-06-06','BAJAJ FINANCE FLEXI DISB',0,4000000,'B1','csv_upload'),
  ('22222222-0000-0000-0000-000000237402','dddddddd-0000-0000-0000-000000237401','bbbbbbbb-0000-0000-0000-000000237401','2026-07-05','ACH DR BAJAJ FINANCE',46000,0,'B2','csv_upload'),
  ('22222222-0000-0000-0000-000000237403','dddddddd-0000-0000-0000-000000237401','bbbbbbbb-0000-0000-0000-000000237401','2026-08-05','ACH DR BAJAJ FINANCE',166000,0,'B3','csv_upload'),
  ('22222222-0000-0000-0000-000000237404','dddddddd-0000-0000-0000-000000237401','bbbbbbbb-0000-0000-0000-000000237401','2026-09-05','ACH DR BAJAJ FINANCE',41400,0,'B4','csv_upload'),
  -- a line already reconciled to something else
  ('22222222-0000-0000-0000-000000237405','dddddddd-0000-0000-0000-000000237401','bbbbbbbb-0000-0000-0000-000000237401','2026-09-06','NEFT CR OTHER',0,10000,'M1','csv_upload'),
  -- another company's credit
  ('22222222-0000-0000-0000-000000237406','dddddddd-0000-0000-0000-000000237402','bbbbbbbb-0000-0000-0000-000000237402','2026-06-06','NEFT CR LOAN',0,100000,'Z1','csv_upload'),
  -- Tata Capital term loan repaid in one debit
  ('22222222-0000-0000-0000-000000237407','dddddddd-0000-0000-0000-000000237401','bbbbbbbb-0000-0000-0000-000000237401','2026-09-10','TATA CAPITAL LOAN CLOSURE',203000,0,'T1','csv_upload');
update public.bank_transactions set matched_to_type = 'manual', matched_to_id = 'r2374-other'
 where id = '22222222-0000-0000-0000-000000237405';

create temp table r2374_ids (k text primary key, v uuid);
grant all on r2374_ids to public;
create temp table r2374_vals (k text primary key, v bigint);
grant all on r2374_vals to public;

create function pg_temp.r2374_out(p_loan uuid) returns integer language sql as $f$
  select (select principal from public.business_loans where id = p_loan)
       - coalesce((select sum(principal_part) from public.business_loan_payments where loan_id = p_loan), 0)::integer;
$f$;
create function pg_temp.r2374_bs(p_col text) returns bigint language plpgsql as $f$
declare v bigint;
begin
  execute format('select %I from public.report_balance_sheet(%L::date)', p_col, '2026-12-31') into v;
  return v;
end $f$;
create function pg_temp.r2374_interest() returns bigint language sql as $f$
  select coalesce(sum((g ->> 'amount')::bigint), 0)
    from public.report_pnl('2026-04-01', '2027-03-31') r, jsonb_array_elements(r.expense_groups) g
   where g ->> 'category' = 'Interest on loans / OD';
$f$;

-- ── F (role). A sales user cannot set up a credit line ───────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237403","role":"authenticated"}', true);
do $$
begin
  perform public.record_credit_line('Bajaj Finance', 'Working capital', 5000000, 15, '2026-06-01', 0);
  raise exception 'FAIL F: sales set up a credit line';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Only an owner, manager, accountant or billing user%' then raise exception 'FAIL F: wrong refusal: %', sqlerrm; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237401","role":"authenticated"}', true);
insert into r2374_vals values
  ('cash0', pg_temp.r2374_bs('cash_and_bank')),
  ('loans0', pg_temp.r2374_bs('business_loans_payable')),
  ('tds0', pg_temp.r2374_bs('dues_vendor_tds')),
  ('pay0', pg_temp.r2374_bs('expenses_payable')),
  ('unb0', pg_temp.r2374_bs('expenses_paid_unbanked')),
  ('lines0', (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000237401'));

-- ── A. Set up the credit line ────────────────────────────────────────────────────────────
do $$
declare v_id uuid; v_l public.business_loans;
begin
  v_id := public.record_credit_line('Bajaj Finance', 'Working capital', 5000000, 15, '2026-06-01', 0);
  insert into r2374_ids values ('od', v_id);
  select * into v_l from public.business_loans where id = v_id;
  if v_l.kind <> 'credit_line' or v_l.principal <> 0 or v_l.credit_limit <> 5000000 or v_l.status <> 'active' then
    raise exception 'FAIL A: row %', row_to_json(v_l);
  end if;
  if pg_temp.r2374_bs('business_loans_payable') <> (select v from r2374_vals where k = 'loans0') then
    raise exception 'FAIL A: BS borrowings moved on set-up';
  end if;
  -- a term loan for I
  insert into r2374_ids values ('tata',
    public.record_business_loan('Tata Capital', 'Term loan', 200000, 12, 12, null, '2026-04-01'::date, 'bbbbbbbb-0000-0000-0000-000000237401'::uuid, null::uuid));
end $$;

-- ── F. Refusals, nothing written ─────────────────────────────────────────────────────────
do $$
declare v_case record; v_od uuid := (select v from r2374_ids where k = 'od'); v_tata uuid := (select v from r2374_ids where k = 'tata');
begin
  for v_case in
    select * from (values
      ('drawdown on a term loan', 'in',  '22222222-0000-0000-0000-000000237401'::uuid, v_tata, 0, 0, 0, 'Money in on a loan is a drawdown only%'),
      ('drawdown on money out',   'in',  '22222222-0000-0000-0000-000000237402'::uuid, v_od, 0, 0, 0, 'Only a money-in line%'),
      ('already reconciled',      'in',  '22222222-0000-0000-0000-000000237405'::uuid, v_od, 0, 0, 0, 'This line is already reconciled%'),
      ('other company line',      'in',  '22222222-0000-0000-0000-000000237406'::uuid, v_od, 0, 0, 0, 'Bank line not found in your company%'),
      ('principal over owed',     'out', '22222222-0000-0000-0000-000000237402'::uuid, v_od, 46000, 0, 0, 'Principal ₹46000 is more than what is owed%'),
      ('parts not the line',      'out', '22222222-0000-0000-0000-000000237402'::uuid, v_od, 0, 45000, 0, 'Principal ₹0 + interest ₹45000%'),
      ('tds over interest',       'out', '22222222-0000-0000-0000-000000237402'::uuid, v_od, 0, 100, 200, 'TDS (₹200) cannot be more%'),
      ('repay on money in',       'out', '22222222-0000-0000-0000-000000237401'::uuid, v_od, 0, 4000000, 0, 'Only a money-out line%')
    ) as c(name, dir, line, loan, prin, intr, tds, msg)
  loop
    begin
      if v_case.dir = 'in' then
        perform public.reconcile_bank_credit_to_credit_line(v_case.line, v_case.loan);
      else
        perform public.reconcile_bank_debit_to_business_loan(v_case.line, v_case.loan, v_case.prin, v_case.intr, v_case.tds);
      end if;
      raise exception 'FAIL F (%): accepted', v_case.name;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like v_case.msg then raise exception 'FAIL F (%): wrong refusal: %', v_case.name, sqlerrm; end if;
    end;
  end loop;
  if exists (select 1 from public.business_loan_drawdowns where loan_id = v_od)
     or exists (select 1 from public.business_loan_payments where loan_id in (v_od, v_tata))
     or exists (select 1 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000237401') then
    raise exception 'FAIL F: a refused call left rows behind';
  end if;
end $$;

-- the other company's owner cannot use our credit line
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237402","role":"authenticated"}', true);
do $$
begin
  perform public.reconcile_bank_credit_to_credit_line('22222222-0000-0000-0000-000000237406', (select v from r2374_ids where k = 'od'));
  raise exception 'FAIL F: another company used our credit line';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Credit line not found in your company%' then raise exception 'FAIL F (other co): wrong refusal: %', sqlerrm; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237401","role":"authenticated"}', true);

-- ── B. Drawdown ₹40,00,000 ───────────────────────────────────────────────────────────────
do $$
declare v_od uuid := (select v from r2374_ids where k = 'od'); v_d uuid; v_line public.bank_transactions;
begin
  v_d := public.reconcile_bank_credit_to_credit_line('22222222-0000-0000-0000-000000237401', v_od);
  insert into r2374_ids values ('draw', v_d);
  if pg_temp.r2374_out(v_od) <> 4000000 then raise exception 'FAIL B: outstanding %', pg_temp.r2374_out(v_od); end if;
  select * into v_line from public.bank_transactions where id = '22222222-0000-0000-0000-000000237401';
  if v_line.matched_to_type is distinct from 'loan_drawdown' or v_line.matched_to_id is distinct from v_d::text then
    raise exception 'FAIL B: line match % %', v_line.matched_to_type, v_line.matched_to_id;
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000237401') - 1   -- the Tata manual line
     <> (select v from r2374_vals where k = 'lines0') then
    raise exception 'FAIL B: a new bank line was added for the drawdown';
  end if;
  if pg_temp.r2374_bs('business_loans_payable') - (select v from r2374_vals where k = 'loans0') <> 4000000 + 200000 then
    raise exception 'FAIL B: BS borrowings moved by % (want 40,00,000 + Tata 2,00,000)', pg_temp.r2374_bs('business_loans_payable') - (select v from r2374_vals where k = 'loans0');
  end if;
  -- the same line again
  begin
    perform public.reconcile_bank_credit_to_credit_line('22222222-0000-0000-0000-000000237401', v_od);
    raise exception 'FAIL B: the same line drew twice';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;

-- ── C. Interest-only ₹46,000 ─────────────────────────────────────────────────────────────
do $$
declare v_od uuid := (select v from r2374_ids where k = 'od'); v_p public.business_loan_payments; v_e public.expenses;
begin
  insert into r2374_ids values ('p1', public.reconcile_bank_debit_to_business_loan('22222222-0000-0000-0000-000000237402', v_od, 0, 46000, 0));
  select * into v_p from public.business_loan_payments where id = (select v from r2374_ids where k = 'p1');
  if v_p.principal_part <> 0 or v_p.interest_part <> 46000 or v_p.bank_txn_id <> '22222222-0000-0000-0000-000000237402' then
    raise exception 'FAIL C: payment %', row_to_json(v_p);
  end if;
  select * into v_e from public.expenses where id = v_p.expense_id;
  if v_e.category <> 'Interest on loans / OD' or v_e.amount <> 46000 or v_e.expense_date <> '2026-07-05' or v_e.tds_amount <> 0 then
    raise exception 'FAIL C: expense %', row_to_json(v_e);
  end if;
  if pg_temp.r2374_out(v_od) <> 4000000 then raise exception 'FAIL C: outstanding moved to %', pg_temp.r2374_out(v_od); end if;
  if pg_temp.r2374_interest() <> 46000 then raise exception 'FAIL C: P&L interest %', pg_temp.r2374_interest(); end if;
  if pg_temp.r2374_bs('expenses_payable') <> (select v from r2374_vals where k = 'pay0')
     or pg_temp.r2374_bs('expenses_paid_unbanked') <> (select v from r2374_vals where k = 'unb0') then
    raise exception 'FAIL C: the interest counted as payable / paid-unbanked';
  end if;
  if (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000237402') is distinct from 'loan_repayment' then
    raise exception 'FAIL C: line not matched loan_repayment';
  end if;
end $$;

-- ── D. Split ₹1,66,000 = ₹1,20,000 principal + ₹46,000 interest ──────────────────────────
do $$
declare v_od uuid := (select v from r2374_ids where k = 'od');
begin
  insert into r2374_ids values ('p2', public.reconcile_bank_debit_to_business_loan('22222222-0000-0000-0000-000000237403', v_od, 120000, 46000, 0));
  if pg_temp.r2374_out(v_od) <> 3880000 then raise exception 'FAIL D: outstanding %', pg_temp.r2374_out(v_od); end if;
  if pg_temp.r2374_bs('business_loans_payable') - (select v from r2374_vals where k = 'loans0') <> 3880000 + 200000 then
    raise exception 'FAIL D: BS borrowings';
  end if;
  if pg_temp.r2374_interest() <> 92000 then raise exception 'FAIL D: P&L interest %', pg_temp.r2374_interest(); end if;
  if (select status from public.business_loans where id = v_od) <> 'active' then raise exception 'FAIL D: credit line not active'; end if;
end $$;

-- ── E. TDS 194A: ₹41,400 = ₹46,000 interest − ₹4,600 TDS ─────────────────────────────────
do $$
declare v_od uuid := (select v from r2374_ids where k = 'od'); v_e public.expenses;
begin
  insert into r2374_ids values ('p3', public.reconcile_bank_debit_to_business_loan('22222222-0000-0000-0000-000000237404', v_od, 0, 46000, 4600));
  select e.* into v_e from public.expenses e join public.business_loan_payments p on p.expense_id = e.id where p.id = (select v from r2374_ids where k = 'p3');
  if v_e.amount <> 46000 or v_e.tds_amount <> 4600 or v_e.tds_section <> '194A' then raise exception 'FAIL E: expense %', row_to_json(v_e); end if;
  if pg_temp.r2374_bs('dues_vendor_tds') - (select v from r2374_vals where k = 'tds0') <> 4600 then
    raise exception 'FAIL E: TDS dues moved by %', pg_temp.r2374_bs('dues_vendor_tds') - (select v from r2374_vals where k = 'tds0');
  end if;
  if pg_temp.r2374_interest() <> 138000 then raise exception 'FAIL E: P&L interest %', pg_temp.r2374_interest(); end if;
  if pg_temp.r2374_out(v_od) <> 3880000 then raise exception 'FAIL E: outstanding'; end if;
end $$;

-- ── H. Tenant isolation (RLS) ────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237402","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.business_loan_drawdowns) <> 0 then raise exception 'FAIL H: another company reads our drawdowns'; end if;
  if (select count(*) from public.business_loan_payments where tenant_id = 'dddddddd-0000-0000-0000-000000237401') <> 0 then raise exception 'FAIL H: payments leak'; end if;
  begin
    insert into public.business_loan_drawdowns (tenant_id, loan_id, amount, drawn_on)
    values ('dddddddd-0000-0000-0000-000000237402', (select v from r2374_ids where k = 'od'), 1, '2026-01-01');
    raise exception 'FAIL H: a browser wrote a drawdown directly';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237401","role":"authenticated"}', true);

-- ── G. Un-reconcile reverses cleanly ─────────────────────────────────────────────────────
do $$
declare v_od uuid := (select v from r2374_ids where k = 'od'); v_exp text;
begin
  -- delete refused while a bank drawdown is on the books (payments first in delete's order)
  begin
    perform public.delete_business_loan(v_od);
    raise exception 'FAIL G: deleted a credit line with payments / drawdowns';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  select expense_id into v_exp from public.business_loan_payments where id = (select v from r2374_ids where k = 'p2');
  perform public.reconcile_bank_txn('22222222-0000-0000-0000-000000237403', null, null, 'manual');
  if exists (select 1 from public.business_loan_payments where id = (select v from r2374_ids where k = 'p2'))
     or exists (select 1 from public.expenses where id = v_exp) then
    raise exception 'FAIL G: repayment / its interest expense left after un-reconcile';
  end if;
  if pg_temp.r2374_out(v_od) <> 4000000 then raise exception 'FAIL G: outstanding % after un-reconcile', pg_temp.r2374_out(v_od); end if;
  if pg_temp.r2374_interest() <> 92000 then raise exception 'FAIL G: P&L interest % after un-reconcile', pg_temp.r2374_interest(); end if;

  -- re-book D, then try to un-reconcile the drawdown: refused (₹1,20,000 principal repaid)
  perform public.reconcile_bank_debit_to_business_loan('22222222-0000-0000-0000-000000237403', v_od, 120000, 46000, 0);
  begin
    perform public.reconcile_bank_txn('22222222-0000-0000-0000-000000237401', null, null, 'manual');
    raise exception 'FAIL G: drawdown un-reconciled under repaid principal';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Without this drawdown Bajaj Finance would have ₹0 drawn but ₹120000%' then raise exception 'FAIL G: wrong refusal: %', sqlerrm; end if;
  end;

  perform public.reconcile_bank_txn(id, null, null, 'manual') from public.bank_transactions
   where id in ('22222222-0000-0000-0000-000000237402','22222222-0000-0000-0000-000000237403','22222222-0000-0000-0000-000000237404');
  perform public.reconcile_bank_txn('22222222-0000-0000-0000-000000237401', null, null, 'manual');
  if exists (select 1 from public.business_loan_drawdowns where loan_id = v_od) or (select principal from public.business_loans where id = v_od) <> 0 then
    raise exception 'FAIL G: drawdown left after un-reconcile';
  end if;
  if exists (select 1 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000237401') then
    raise exception 'FAIL G: interest expenses left';
  end if;
  if pg_temp.r2374_bs('business_loans_payable') - (select v from r2374_vals where k = 'loans0') <> 200000
     or pg_temp.r2374_bs('dues_vendor_tds') <> (select v from r2374_vals where k = 'tds0') then
    raise exception 'FAIL G: BS not back to before';
  end if;
  if exists (select 1 from public.bank_transactions where id in ('22222222-0000-0000-0000-000000237401','22222222-0000-0000-0000-000000237402',
               '22222222-0000-0000-0000-000000237403','22222222-0000-0000-0000-000000237404') and matched_to_type is not null) then
    raise exception 'FAIL G: lines still matched';
  end if;
  perform public.delete_business_loan(v_od);
  if exists (select 1 from public.business_loans where id = v_od) then raise exception 'FAIL G: delete left the credit line'; end if;
end $$;

-- ── A2. Opening outstanding: owed before these books, no bank line ───────────────────────
do $$
declare v_id uuid;
begin
  v_id := public.record_credit_line('HDFC OD', null, null, null, '2026-04-01', 250000);
  if pg_temp.r2374_out(v_id) <> 250000 or (select count(*) from public.business_loan_drawdowns where loan_id = v_id and bank_txn_id is null) <> 1 then
    raise exception 'FAIL A2: opening outstanding';
  end if;
  perform public.delete_business_loan(v_id);   -- no bank drawdown → allowed
end $$;

-- ── I. Tata Capital term loan: ₹2,03,000 = ₹2,00,000 + ₹3,000 interest → closed ─────────
do $$
declare v_t uuid := (select v from r2374_ids where k = 'tata');
begin
  perform public.reconcile_bank_debit_to_business_loan('22222222-0000-0000-0000-000000237407', v_t, 200000, 3000, 0);
  if pg_temp.r2374_out(v_t) <> 0 or (select status from public.business_loans where id = v_t) <> 'closed' then
    raise exception 'FAIL I: term loan not closed';
  end if;
  perform public.reconcile_bank_txn('22222222-0000-0000-0000-000000237407', null, null, 'manual');
  if pg_temp.r2374_out(v_t) <> 200000 or (select status from public.business_loans where id = v_t) <> 'active' then
    raise exception 'FAIL I: term loan not reopened on un-reconcile';
  end if;
end $$;

select 'R-2374 credit line: all checks passed' as result;

rollback;
