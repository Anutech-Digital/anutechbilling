-- R-2603 (8 Nov 2026): Banking → Reconcile a money-OUT line → "I am GIVING a loan/advance" makes a
-- real Loans given row (record_loan_given_from_bank_out), not a Balance Sheet "Advance/loan given" line.
-- Migration 20261108080000_r2603_reconcile_loan_given (on R-544 loans_given, R-2340 loan_given match +
-- undo trigger, R-2570).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. Refusals write nothing: sales user, money-in line, another company's line, no name.
--   B. ₹1,00,000 money-out line → ONE loans_given row (one_shot, 0%, given_on = line date, principal =
--      line, bank_txn_id = line, account = line's); line matched loan_given + loan id; NO
--      balance_sheet_items row; no new bank line; Loans given asset ₹1,00,000.
--   C. The same line again (repeat click) → refused, still one loan; a line already booked by another
--      option (book_bank_advance) → refused, no loan.
--   D. Same borrower typed " julie   RAWAT " → second loan keeps the first spelling "Julie Rawat".
--   E. Partial repayment (money-in ₹40,000 via R-2340's receipt) → asset ₹1,60,000 − ₹40,000, loan open;
--      un-reconciling the money lent is refused while that receipt is on the books.
--   F. Undo: receipt un-reconciled, then the money-out line → loan gone, line free, asset back down.

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
  ('dddddddd-0000-0000-0000-000000260301','R2603 Co','r2603@example.in','07','R2603'),
  ('dddddddd-0000-0000-0000-000000260302','R2603 Other','r2603b@example.in','07','R2603B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000260301','owner2603@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000260302','sales2603@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000260301','dddddddd-0000-0000-0000-000000260301','owner2603@example.in','Owner 2603','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000260302','dddddddd-0000-0000-0000-000000260301','sales2603@example.in','Sales 2603','sales', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000260301','dddddddd-0000-0000-0000-000000260301','HDFC Current','HDFC', 500000),
  ('bbbbbbbb-0000-0000-0000-000000260302','dddddddd-0000-0000-0000-000000260302','Other bank','SBI', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000260301','dddddddd-0000-0000-0000-000000260301','bbbbbbbb-0000-0000-0000-000000260301','2026-10-05','IMPS DR JULIE RAWAT',100000,0,'L1','csv_upload'),
  ('22222222-0000-0000-0000-000000260302','dddddddd-0000-0000-0000-000000260301','bbbbbbbb-0000-0000-0000-000000260301','2026-10-20','IMPS DR JULIE',60000,0,'L2','csv_upload'),
  ('22222222-0000-0000-0000-000000260303','dddddddd-0000-0000-0000-000000260301','bbbbbbbb-0000-0000-0000-000000260301','2026-10-25','NEFT CR JULIE',0,40000,'R1','csv_upload'),
  ('22222222-0000-0000-0000-000000260304','dddddddd-0000-0000-0000-000000260301','bbbbbbbb-0000-0000-0000-000000260301','2026-10-06','IMPS DR SOMEONE',1000,0,'P1','csv_upload'),
  ('22222222-0000-0000-0000-000000260305','dddddddd-0000-0000-0000-000000260302','bbbbbbbb-0000-0000-0000-000000260302','2026-10-05','IMPS DR OTHER',100000,0,'Z1','csv_upload');

create temp table r2603_ids (k text primary key, v uuid);
grant all on r2603_ids to public;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000260301","role":"authenticated"}', true);

-- ── A. Refusals, nothing written ─────────────────────────────────────────────────────────
do $$
declare v_case record;
begin
  for v_case in
    select * from (values
      ('money-in',      '22222222-0000-0000-0000-000000260303'::uuid, 'Julie Rawat', 'Only a money-out line%'),
      ('other company', '22222222-0000-0000-0000-000000260305'::uuid, 'Julie Rawat', 'Bank line not found in your company%'),
      ('no name',       '22222222-0000-0000-0000-000000260301'::uuid, '   ',         'Enter the borrower%')
    ) as c(name, txn, who, msg)
  loop
    begin
      perform public.record_loan_given_from_bank_out(v_case.txn, v_case.who, null);
      raise exception 'FAIL A (%): accepted', v_case.name;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like v_case.msg then raise exception 'FAIL A (%): wrong refusal: %', v_case.name, sqlerrm; end if;
    end;
  end loop;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000260302","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.record_loan_given_from_bank_out('22222222-0000-0000-0000-000000260301', 'Julie Rawat', null);
    raise exception 'FAIL A (sales): accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Only the owner or the accountant%' then raise exception 'FAIL A (sales): wrong refusal: %', sqlerrm; end if;
  end;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000260301","role":"authenticated"}', true);

do $$
begin
  if exists (select 1 from public.loans_given where tenant_id in ('dddddddd-0000-0000-0000-000000260301','dddddddd-0000-0000-0000-000000260302')) then
    raise exception 'FAIL A: a refused call left a loan behind';
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id in ('dddddddd-0000-0000-0000-000000260301','dddddddd-0000-0000-0000-000000260302') and matched_to_type is not null) then
    raise exception 'FAIL A: a refused call matched a line';
  end if;
end $$;

-- ── B. The money-out line → one Loans given row ──────────────────────────────────────────
insert into r2603_ids values ('loan1',
  public.record_loan_given_from_bank_out('22222222-0000-0000-0000-000000260301', 'Julie Rawat', 'IMPS DR JULIE RAWAT'));

do $$
declare v_l public.loans_given; v_t public.bank_transactions; v_id uuid := (select v from r2603_ids where k = 'loan1');
begin
  select * into v_l from public.loans_given where id = v_id;
  if not found then raise exception 'FAIL B: no loans_given row'; end if;
  if v_l.tenant_id <> 'dddddddd-0000-0000-0000-000000260301' or v_l.borrower_name <> 'Julie Rawat' or v_l.principal <> 100000
     or v_l.given_on <> '2026-10-05' or v_l.repayment_plan <> 'one_shot' or v_l.interest_rate <> 0 or v_l.status <> 'open'
     or v_l.bank_txn_id <> '22222222-0000-0000-0000-000000260301'
     or v_l.paid_from_account_id <> 'bbbbbbbb-0000-0000-0000-000000260301' then
    raise exception 'FAIL B: wrong loan row: %', row_to_json(v_l);
  end if;
  select * into v_t from public.bank_transactions where id = '22222222-0000-0000-0000-000000260301';
  if v_t.matched_to_type is distinct from 'loan_given' or v_t.matched_to_id is distinct from v_id::text then
    raise exception 'FAIL B: line not matched to the loan: % %', v_t.matched_to_type, v_t.matched_to_id;
  end if;
  if exists (select 1 from public.balance_sheet_items where tenant_id = 'dddddddd-0000-0000-0000-000000260301' and bank_txn_id = '22222222-0000-0000-0000-000000260301') then
    raise exception 'FAIL B: a Balance Sheet line was also written (two stores)';
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000260301') <> 4 then
    raise exception 'FAIL B: a new bank line was added';
  end if;
  if public.loans_given_asset() <> 100000 then
    raise exception 'FAIL B: Loans given asset is % not 100000', public.loans_given_asset();
  end if;
end $$;

-- ── C. Repeat click on the same line ─────────────────────────────────────────────────────
do $$
begin
  begin
    perform public.record_loan_given_from_bank_out('22222222-0000-0000-0000-000000260301', 'Julie Rawat', null);
    raise exception 'FAIL C: accepted twice';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This line is already reconciled%' then raise exception 'FAIL C: wrong refusal: %', sqlerrm; end if;
  end;
  if (select count(*) from public.loans_given where tenant_id = 'dddddddd-0000-0000-0000-000000260301') <> 1 then
    raise exception 'FAIL C: more than one loan';
  end if;
  perform public.book_bank_advance('22222222-0000-0000-0000-000000260304', 'Someone', 'received', null);
  begin
    perform public.record_loan_given_from_bank_out('22222222-0000-0000-0000-000000260304', 'Someone', null);
    raise exception 'FAIL C: a line booked by another option accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This line is already reconciled (bs item)%' then raise exception 'FAIL C: wrong refusal: %', sqlerrm; end if;
  end;
  if (select count(*) from public.loans_given where tenant_id = 'dddddddd-0000-0000-0000-000000260301') <> 1 then
    raise exception 'FAIL C: a loan written for a line booked elsewhere';
  end if;
end $$;

-- ── D. Same borrower, other case / spaces → one spelling ──────────────────────────────────
insert into r2603_ids values ('loan2',
  public.record_loan_given_from_bank_out('22222222-0000-0000-0000-000000260302', '  julie   RAWAT ', null));
do $$
begin
  if (select borrower_name from public.loans_given where id = (select v from r2603_ids where k = 'loan2')) <> 'Julie Rawat' then
    raise exception 'FAIL D: borrower spelt %', (select borrower_name from public.loans_given where id = (select v from r2603_ids where k = 'loan2'));
  end if;
  if public.loans_given_asset() <> 160000 then raise exception 'FAIL D: asset % not 160000', public.loans_given_asset(); end if;
end $$;

-- ── E. Partial repayment (R-2340 receipt) ────────────────────────────────────────────────
do $$
begin
  perform public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000260303', (select v from r2603_ids where k = 'loan2'), 0);
  if public.loans_given_asset() <> 120000 then raise exception 'FAIL E: asset % not 120000', public.loans_given_asset(); end if;
  if (select status from public.loans_given where id = (select v from r2603_ids where k = 'loan2')) <> 'open' then
    raise exception 'FAIL E: part-repaid loan closed';
  end if;
  begin
    perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000260302', false);
    raise exception 'FAIL E: money lent un-reconciled while a receipt is on the books';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%receipt(s) of it are reconciled%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- ── F. Undo ──────────────────────────────────────────────────────────────────────────────
do $$
begin
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000260303', false);
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000260302', false);
  if exists (select 1 from public.loans_given where id = (select v from r2603_ids where k = 'loan2')) then
    raise exception 'FAIL F: loan still there after un-reconcile';
  end if;
  if (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000260302') is not null then
    raise exception 'FAIL F: line not freed';
  end if;
  if public.loans_given_asset() <> 100000 then raise exception 'FAIL F: asset % not 100000', public.loans_given_asset(); end if;
end $$;

select 'R-2603 reconcile loan given: ALL PASS' as result;

rollback;
