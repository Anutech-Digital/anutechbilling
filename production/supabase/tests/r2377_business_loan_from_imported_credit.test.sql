-- R-2377 (2 Nov 2026): Business Loans → "Add loan" links the money-in line the bank statement
-- ALREADY has, instead of always adding a second (manual) one.
-- Migration 20261102144114_r2377_business_loan_from_imported_credit (on top of R-885's
-- record_business_loan / delete_business_loan and R-1853's record_director_loan_taken).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example (OD audit 2 Nov): ₹40,00,000 from Bajaj Finance, imported as
-- "FT 0606 BAJAJ FINANCE LTD LOAN DISB" on 6 Jun 2026; Add loan typed with "Taken on" 4 Jun.
--
-- Proves:
--   A. Linking the imported line: NO second bank line; cash unchanged; Business loans ₹40,00,000;
--      the line is matched once (business_loan → the loan); the loan's date = the line's date;
--      the same line cannot be used again.
--   B. Refused, nothing written: a line on another account, a money-out line, a line already
--      reconciled, an amount ₹2 off, another company's line.
--   C. No line given → a new manual money-in line as before (cash and loan both up), stored on the loan.
--   D. Delete the loan → the imported line stays and is free again (cash unchanged); a manual
--      line is removed (cash back).
--   E. Un-reconcile the imported line on the bank page → the loan is gone; refused while an EMI
--      of the loan is recorded.
--   F. A loan from a director with the imported line: same link, director kept; the 7-arg form
--      (no line) and the 8-arg record_business_loan still work.

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
  ('dddddddd-0000-0000-0000-000000237701','R2377 Co','r2377@example.in','07','R2377'),
  ('dddddddd-0000-0000-0000-000000237702','R2377 Other','r2377b@example.in','07','R2377B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000237701','owner2377@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000237701','dddddddd-0000-0000-0000-000000237701','owner2377@example.in','Owner 2377','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000237701','dddddddd-0000-0000-0000-000000237701','HDFC Current','HDFC', 500000),
  ('bbbbbbbb-0000-0000-0000-000000237703','dddddddd-0000-0000-0000-000000237701','Kotak Savings','Kotak', 0),
  ('bbbbbbbb-0000-0000-0000-000000237702','dddddddd-0000-0000-0000-000000237702','Other bank','SBI', 0);
insert into public.company_directors (id, tenant_id, name, din, appointed_on) values
  ('cccccccc-0000-0000-0000-000000237701','dddddddd-0000-0000-0000-000000237701','Asha Director','01234567','2020-01-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  -- the Bajaj disbursal, already imported from the statement
  ('22222222-0000-0000-0000-000000237701','dddddddd-0000-0000-0000-000000237701','bbbbbbbb-0000-0000-0000-000000237701','2026-06-06','FT 0606 BAJAJ FINANCE LTD LOAN DISB',0,4000000,'B1','csv_upload'),
  -- ₹40,00,000 on the OTHER account (Kotak)
  ('22222222-0000-0000-0000-000000237702','dddddddd-0000-0000-0000-000000237701','bbbbbbbb-0000-0000-0000-000000237703','2026-06-06','NEFT CR LOAN',0,4000000,'K1','csv_upload'),
  -- a money-out line of ₹40,00,000
  ('22222222-0000-0000-0000-000000237703','dddddddd-0000-0000-0000-000000237701','bbbbbbbb-0000-0000-0000-000000237701','2026-06-06','RTGS DR VENDOR',4000000,0,'O1','csv_upload'),
  -- ₹40,00,002 — ₹2 off
  ('22222222-0000-0000-0000-000000237704','dddddddd-0000-0000-0000-000000237701','bbbbbbbb-0000-0000-0000-000000237701','2026-06-05','NEFT CR SOMEONE',0,4000002,'X1','csv_upload'),
  -- another company's ₹40,00,000 credit
  ('22222222-0000-0000-0000-000000237705','dddddddd-0000-0000-0000-000000237702','bbbbbbbb-0000-0000-0000-000000237702','2026-06-06','NEFT CR LOAN',0,4000000,'Z1','csv_upload'),
  -- a ₹40,00,000 credit already reconciled (to something else)
  ('22222222-0000-0000-0000-000000237706','dddddddd-0000-0000-0000-000000237701','bbbbbbbb-0000-0000-0000-000000237701','2026-06-07','NEFT CR TRANSFER',0,4000000,'M1','csv_upload'),
  -- ₹5,00,001 from a director (₹1 rounding)
  ('22222222-0000-0000-0000-000000237707','dddddddd-0000-0000-0000-000000237701','bbbbbbbb-0000-0000-0000-000000237701','2026-07-01','IMPS CR ASHA DIRECTOR',0,500001,'D1','csv_upload');
update public.bank_transactions set matched_to_type = 'manual', matched_to_id = 'r2377-other'
 where id = '22222222-0000-0000-0000-000000237706';

create temp table r2377_ids (k text primary key, v uuid);
grant all on r2377_ids to public;
create temp table r2377_vals (k text primary key, v bigint);
grant all on r2377_vals to public;

create function pg_temp.r2377_add(p_principal integer, p_account uuid, p_line uuid, p_lender text default 'Bajaj Finance')
returns uuid language sql as $f$
  select public.record_business_loan(p_lender, 'Working capital', p_principal, 14.5, 36, null, '2026-06-04'::date, p_account, p_line);
$f$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237701","role":"authenticated"}', true);

insert into r2377_vals values
  ('cash0', (select cash_and_bank from public.report_balance_sheet('2026-12-31'))),
  ('lines0', (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000237701'));

-- ── B. Refusals, nothing written ─────────────────────────────────────────────────────────
do $$
declare
  v_case record;
begin
  for v_case in
    select * from (values
      ('another account', '22222222-0000-0000-0000-000000237702'::uuid, 'That bank line is not on the account%'),
      ('money-out',       '22222222-0000-0000-0000-000000237703'::uuid, 'Only a money-in line%'),
      ('already matched', '22222222-0000-0000-0000-000000237706'::uuid, 'This line is already reconciled%'),
      ('₹2 off',          '22222222-0000-0000-0000-000000237704'::uuid, 'This line is ₹4000002 but the loan is ₹4000000%'),
      ('other company',   '22222222-0000-0000-0000-000000237705'::uuid, 'Bank line not found in your company%'),
      ('no such line',    '22222222-0000-0000-0000-0000002377ff'::uuid, 'Bank line not found in your company%')
    ) as c(name, line, msg)
  loop
    begin
      perform pg_temp.r2377_add(4000000, 'bbbbbbbb-0000-0000-0000-000000237701', v_case.line);
      raise exception 'FAIL B (%): accepted', v_case.name;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like v_case.msg then raise exception 'FAIL B (%): wrong refusal: %', v_case.name, sqlerrm; end if;
    end;
  end loop;
  if exists (select 1 from public.business_loans where tenant_id = 'dddddddd-0000-0000-0000-000000237701') then
    raise exception 'FAIL B: a refused Add loan left a loan behind';
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000237701'
                and matched_to_type is not null and id <> '22222222-0000-0000-0000-000000237706') then
    raise exception 'FAIL B: a refused Add loan matched a line';
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000237701') <> (select v from r2377_vals where k = 'lines0') then
    raise exception 'FAIL B: a refused Add loan added a line';
  end if;
end $$;

-- ── A. Link the imported Bajaj line: no second bank line; cash unchanged ─────────────────
do $$
declare v_id uuid; v_l public.business_loans; v_line public.bank_transactions; v_bs record;
begin
  v_id := pg_temp.r2377_add(4000000, 'bbbbbbbb-0000-0000-0000-000000237701', '22222222-0000-0000-0000-000000237701');
  insert into r2377_ids values ('bajaj', v_id);
  select * into v_l from public.business_loans where id = v_id;
  if v_l.principal <> 4000000 or v_l.disbursal_bank_txn_id is distinct from '22222222-0000-0000-0000-000000237701'
     or v_l.disbursed_on <> '2026-06-06' or v_l.lender <> 'Bajaj Finance' then
    raise exception 'FAIL A: loan row %', row_to_json(v_l);
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = v_l.tenant_id) <> (select v from r2377_vals where k = 'lines0') then
    raise exception 'FAIL A: a new bank line was added — cash counted twice';
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id = v_l.tenant_id and source = 'manual') then
    raise exception 'FAIL A: a manual money-in line was made';
  end if;
  select * into v_line from public.bank_transactions where id = '22222222-0000-0000-0000-000000237701';
  if v_line.matched_to_type is distinct from 'business_loan' or v_line.matched_to_id is distinct from v_id::text then
    raise exception 'FAIL A: the imported line is not matched to the loan (% %)', v_line.matched_to_type, v_line.matched_to_id;
  end if;
  select * into v_bs from public.report_balance_sheet('2026-12-31');
  if v_bs.cash_and_bank <> (select v from r2377_vals where k = 'cash0') then
    raise exception 'FAIL A: cash changed (% → %) — counted twice', (select v from r2377_vals where k = 'cash0'), v_bs.cash_and_bank;
  end if;
  if v_bs.business_loans_payable <> 4000000 then raise exception 'FAIL A: loan on the Balance Sheet %', v_bs.business_loans_payable; end if;
  -- the same line cannot be used for a second loan
  begin
    perform pg_temp.r2377_add(4000000, 'bbbbbbbb-0000-0000-0000-000000237701', '22222222-0000-0000-0000-000000237701', 'Again');
    raise exception 'FAIL A: the same line was used for a second loan';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This line is already reconciled%' then raise exception 'FAIL A: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- ── D1. Delete the loan → the imported line stays, free again; cash unchanged ────────────
do $$
declare v_id uuid := (select v from r2377_ids where k = 'bajaj');
begin
  perform public.delete_business_loan(v_id);
  if exists (select 1 from public.business_loans where id = v_id) then raise exception 'FAIL D1: loan still there'; end if;
  if not exists (select 1 from public.bank_transactions where id = '22222222-0000-0000-0000-000000237701' and matched_to_type is null) then
    raise exception 'FAIL D1: the imported line was deleted or is still matched';
  end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) <> (select v from r2377_vals where k = 'cash0') then
    raise exception 'FAIL D1: cash changed';
  end if;
  if (select business_loans_payable from public.report_balance_sheet('2026-12-31')) <> 0 then raise exception 'FAIL D1: loan still on the Balance Sheet'; end if;
end $$;

-- ── E. Un-reconcile on the bank page removes the loan; refused while an EMI is recorded ───
do $$
declare v_id uuid;
begin
  v_id := pg_temp.r2377_add(4000000, 'bbbbbbbb-0000-0000-0000-000000237701', '22222222-0000-0000-0000-000000237701');
  perform public.record_loan_emi(v_id, 140000, 48000, '2026-07-06', 'bbbbbbbb-0000-0000-0000-000000237701', null);
  begin
    perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000237701', false);
    raise exception 'FAIL E: un-reconciled the loan money while an EMI is recorded';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%EMI payment(s) of it are recorded%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
  end;
  if not exists (select 1 from public.business_loans where id = v_id) then raise exception 'FAIL E: loan gone after a refusal'; end if;
  delete from public.business_loan_payments where loan_id = v_id;
  delete from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000237701' and source = 'manual' and debit = 140000;
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000237701', false);
  if exists (select 1 from public.business_loans where id = v_id) then raise exception 'FAIL E: loan left after un-reconcile'; end if;
  if (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000237701') is not null then
    raise exception 'FAIL E: line still matched';
  end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) <> (select v from r2377_vals where k = 'cash0') then
    raise exception 'FAIL E: cash changed';
  end if;
end $$;

-- ── C. No line (money not imported yet) → a new manual line, as before ───────────────────
do $$
declare v_id uuid; v_l public.business_loans; v_line public.bank_transactions; v_bs record;
begin
  v_id := pg_temp.r2377_add(1000000, 'bbbbbbbb-0000-0000-0000-000000237701', null, 'HDFC Bank');
  select * into v_l from public.business_loans where id = v_id;
  select * into v_line from public.bank_transactions where id = v_l.disbursal_bank_txn_id;
  if v_line.id is null or v_line.source <> 'manual' or v_line.credit <> 1000000 or v_line.txn_date <> '2026-06-04'
     or v_line.description <> 'Loan received: HDFC Bank' then
    raise exception 'FAIL C: manual line %', row_to_json(v_line);
  end if;
  select * into v_bs from public.report_balance_sheet('2026-12-31');
  if v_bs.cash_and_bank <> (select v from r2377_vals where k = 'cash0') + 1000000 then raise exception 'FAIL C: cash %', v_bs.cash_and_bank; end if;
  if v_bs.business_loans_payable <> 1000000 then raise exception 'FAIL C: loan %', v_bs.business_loans_payable; end if;
  -- D2: delete removes the manual line again
  perform public.delete_business_loan(v_id);
  if exists (select 1 from public.bank_transactions where id = v_line.id) then raise exception 'FAIL D2: manual line left'; end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) <> (select v from r2377_vals where k = 'cash0') then
    raise exception 'FAIL D2: cash not back';
  end if;
end $$;

-- ── F. Director loan with the imported line; old signatures still work ───────────────────
do $$
declare v_id uuid; v_l public.business_loans; v_old uuid;
begin
  v_id := public.record_director_loan_taken('cccccccc-0000-0000-0000-000000237701', 500000, '2026-06-28', 'bbbbbbbb-0000-0000-0000-000000237701',
                                            0, true, null, '22222222-0000-0000-0000-000000237707');
  select * into v_l from public.business_loans where id = v_id;
  if v_l.director_id is distinct from 'cccccccc-0000-0000-0000-000000237701' or v_l.director_declaration is not true
     or v_l.disbursal_bank_txn_id is distinct from '22222222-0000-0000-0000-000000237707' or v_l.disbursed_on <> '2026-07-01' then
    raise exception 'FAIL F: director loan %', row_to_json(v_l);
  end if;
  if (select matched_to_id from public.bank_transactions where id = '22222222-0000-0000-0000-000000237707') is distinct from v_id::text then
    raise exception 'FAIL F: director line not matched';
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id = v_l.tenant_id and source = 'manual') then
    raise exception 'FAIL F: a manual line was made for the director loan';
  end if;
  -- 7-arg director form and 8-arg record_business_loan: a manual line, as before
  v_old := public.record_director_loan_taken('cccccccc-0000-0000-0000-000000237701', 20000, '2026-08-01', 'bbbbbbbb-0000-0000-0000-000000237701', 0, true);
  if (select source from public.bank_transactions t join public.business_loans b on b.disbursal_bank_txn_id = t.id where b.id = v_old) <> 'manual' then
    raise exception 'FAIL F: 7-arg director form';
  end if;
  v_old := public.record_business_loan('ICICI', null, 30000, null, null, null, '2026-08-02', 'bbbbbbbb-0000-0000-0000-000000237701');
  if (select credit from public.bank_transactions t join public.business_loans b on b.disbursal_bank_txn_id = t.id where b.id = v_old) <> 30000 then
    raise exception 'FAIL F: 8-arg record_business_loan';
  end if;
end $$;

select 'R-2377 business loan from imported credit: ALL PASS' as result;

rollback;
