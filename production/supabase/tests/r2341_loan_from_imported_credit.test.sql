-- R-2341 (1 Nov 2026): "Set up this loan" → "Loan money came into <account>" can pick the money-in
-- line the bank statement ALREADY has for the disbursal, instead of adding a second (manual) one.
-- Migration 20261101054700_r2341_loan_from_imported_credit (on top of R-2323's record_emi_loan_taken).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example: the bike loan (R-2323's — ₹2,50,000 at 11%, 14 EMIs of ₹19,054 from 5 Oct 2026);
-- the HDFC statement already has "NEFT CR HDFC BANK LOAN DISB" ₹2,50,000 on 4 Sep 2026.
--
-- Proves:
--   A. Picking the imported line: NO second bank line; cash unchanged; the loan is a liability of
--      ₹2,50,000; that line is matched once (emi → the loan) and is the loan's received line.
--   B. Refused, nothing written: a line on another account, a money-out line, a line already
--      reconciled, an amount ₹2 off, another company's line, a line without the account.
--   C. ₹1 rounding is allowed (₹1,00,001 line for a ₹1,00,000 loan).
--   D. Undo = un-reconcile that line on the bank page: the line is free again, the loan and its
--      schedule are gone, cash still unchanged.
--   E. Un-reconcile is refused while an EMI of the loan is reconciled; after that EMI is undone
--      it works.

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
  ('dddddddd-0000-0000-0000-000000234101','R2341 Co','r2341@example.in','07','R2341'),
  ('dddddddd-0000-0000-0000-000000234102','R2341 Other','r2341b@example.in','07','R2341B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000234101','owner2341@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000234101','dddddddd-0000-0000-0000-000000234101','owner2341@example.in','Owner 2341','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000234101','dddddddd-0000-0000-0000-000000234101','HDFC Current','HDFC', 500000),
  ('bbbbbbbb-0000-0000-0000-000000234103','dddddddd-0000-0000-0000-000000234101','Kotak Savings','Kotak', 0),
  ('bbbbbbbb-0000-0000-0000-000000234102','dddddddd-0000-0000-0000-000000234102','Other bank','SBI', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  -- the disbursal credit, already imported from the statement
  ('22222222-0000-0000-0000-000000234101','dddddddd-0000-0000-0000-000000234101','bbbbbbbb-0000-0000-0000-000000234101','2026-09-04','NEFT CR HDFC BANK LOAN DISB',0,250000,'D1','csv_upload'),
  -- EMI 1 of the bike loan
  ('22222222-0000-0000-0000-000000234102','dddddddd-0000-0000-0000-000000234101','bbbbbbbb-0000-0000-0000-000000234101','2026-10-05','NACH DR HDFC BANK BIKE EMI',19054,0,'N1','csv_upload'),
  -- ₹2,50,000 on the OTHER account (Kotak)
  ('22222222-0000-0000-0000-000000234103','dddddddd-0000-0000-0000-000000234101','bbbbbbbb-0000-0000-0000-000000234103','2026-09-04','NEFT CR LOAN',0,250000,'K1','csv_upload'),
  -- a money-out line of ₹2,50,000
  ('22222222-0000-0000-0000-000000234104','dddddddd-0000-0000-0000-000000234101','bbbbbbbb-0000-0000-0000-000000234101','2026-09-04','RTGS DR VENDOR',250000,0,'O1','csv_upload'),
  -- ₹2,50,002 — ₹2 off
  ('22222222-0000-0000-0000-000000234105','dddddddd-0000-0000-0000-000000234101','bbbbbbbb-0000-0000-0000-000000234101','2026-09-03','NEFT CR SOMEONE',0,250002,'X1','csv_upload'),
  -- ₹1,00,001 for the ₹1,00,000 Tata Capital loan (₹1 rounding)
  ('22222222-0000-0000-0000-000000234106','dddddddd-0000-0000-0000-000000234101','bbbbbbbb-0000-0000-0000-000000234101','2026-09-02','NEFT CR TATA CAPITAL',0,100001,'T1','csv_upload'),
  -- another company's ₹2,50,000 credit
  ('22222222-0000-0000-0000-000000234107','dddddddd-0000-0000-0000-000000234102','bbbbbbbb-0000-0000-0000-000000234102','2026-09-04','NEFT CR LOAN',0,250000,'Z1','csv_upload'),
  -- a ₹2,50,000 credit already reconciled (to something else)
  ('22222222-0000-0000-0000-000000234108','dddddddd-0000-0000-0000-000000234101','bbbbbbbb-0000-0000-0000-000000234101','2026-09-05','NEFT CR TRANSFER',0,250000,'M1','csv_upload');
update public.bank_transactions set matched_to_type = 'manual', matched_to_id = 'r2341-other'
 where id = '22222222-0000-0000-0000-000000234108';

create temp table r2341_sched as select '[{"seq":1,"due_on":"2026-10-05","emi":19054,"principal":16762,"interest":2292,"balance_after":233238},{"seq":2,"due_on":"2026-11-05","emi":19054,"principal":16916,"interest":2138,"balance_after":216322},{"seq":3,"due_on":"2026-12-05","emi":19054,"principal":17071,"interest":1983,"balance_after":199251},{"seq":4,"due_on":"2027-01-05","emi":19054,"principal":17228,"interest":1826,"balance_after":182023},{"seq":5,"due_on":"2027-02-05","emi":19054,"principal":17385,"interest":1669,"balance_after":164638},{"seq":6,"due_on":"2027-03-05","emi":19054,"principal":17545,"interest":1509,"balance_after":147093},{"seq":7,"due_on":"2027-04-05","emi":19054,"principal":17706,"interest":1348,"balance_after":129387},{"seq":8,"due_on":"2027-05-05","emi":19054,"principal":17868,"interest":1186,"balance_after":111519},{"seq":9,"due_on":"2027-06-05","emi":19054,"principal":18032,"interest":1022,"balance_after":93487},{"seq":10,"due_on":"2027-07-05","emi":19054,"principal":18197,"interest":857,"balance_after":75290},{"seq":11,"due_on":"2027-08-05","emi":19054,"principal":18364,"interest":690,"balance_after":56926},{"seq":12,"due_on":"2027-09-05","emi":19054,"principal":18532,"interest":522,"balance_after":38394},{"seq":13,"due_on":"2027-10-05","emi":19054,"principal":18702,"interest":352,"balance_after":19692},{"seq":14,"due_on":"2027-11-05","emi":19873,"principal":19692,"interest":181,"balance_after":0}]'::jsonb as s,
  '[{"seq":1,"due_on":"2026-10-01","emi":10558,"principal":9558,"interest":1000,"balance_after":90442},{"seq":2,"due_on":"2026-11-01","emi":10558,"principal":9654,"interest":904,"balance_after":80788},{"seq":3,"due_on":"2026-12-01","emi":10558,"principal":9750,"interest":808,"balance_after":71038},{"seq":4,"due_on":"2027-01-01","emi":10558,"principal":9848,"interest":710,"balance_after":61190},{"seq":5,"due_on":"2027-02-01","emi":10558,"principal":9946,"interest":612,"balance_after":51244},{"seq":6,"due_on":"2027-03-01","emi":10558,"principal":10046,"interest":512,"balance_after":41198},{"seq":7,"due_on":"2027-04-01","emi":10558,"principal":10146,"interest":412,"balance_after":31052},{"seq":8,"due_on":"2027-05-01","emi":10558,"principal":10247,"interest":311,"balance_after":20805},{"seq":9,"due_on":"2027-06-01","emi":10558,"principal":10350,"interest":208,"balance_after":10455},{"seq":10,"due_on":"2027-07-01","emi":10560,"principal":10455,"interest":105,"balance_after":0}]'::jsonb as t;
grant select on r2341_sched to public;
create temp table r2341_ids (k text primary key, v uuid);
grant all on r2341_ids to public;
create temp table r2341_vals (k text primary key, v bigint);
grant all on r2341_vals to public;

-- The bike loan, money came into HDFC as the imported ₹2,50,000 line (received_on is taken from the line).
create function pg_temp.r2341_bike(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('lender','HDFC Bank','lender_ref','BIKE','principal',250000,'interest_rate',11,
    'account_id','bbbbbbbb-0000-0000-0000-000000234101','received_on',null,
    'received_txn_id','22222222-0000-0000-0000-000000234101','reconcile_txn_id',null,
    'schedule',(select s from r2341_sched)) || p_extra;
$f$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000234101","role":"authenticated"}', true);

insert into r2341_vals values
  ('cash0', (select cash_and_bank from public.report_balance_sheet('2026-12-31'))),
  ('lines0', (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000234101'));

-- ── B. Refusals, nothing written ─────────────────────────────────────────────────────────
do $$
declare
  v_case record;
begin
  for v_case in
    select * from (values
      ('another account', '{"received_txn_id":"22222222-0000-0000-0000-000000234103"}'::jsonb, 'That bank line is not on the account%'),
      ('money-out',       '{"received_txn_id":"22222222-0000-0000-0000-000000234104"}'::jsonb, 'Only a money-in line%'),
      ('already matched', '{"received_txn_id":"22222222-0000-0000-0000-000000234108"}'::jsonb, 'This line is already reconciled%'),
      ('₹2 off',          '{"received_txn_id":"22222222-0000-0000-0000-000000234105"}'::jsonb, 'This line is ₹250002 but the loan is ₹250000%'),
      ('other company',   '{"received_txn_id":"22222222-0000-0000-0000-000000234107"}'::jsonb, 'Bank line not found in your company%'),
      ('no account',      '{"account_id":null}'::jsonb,                                        'Pick the account the loan money came into%')
    ) as c(name, extra, msg)
  loop
    begin
      perform public.record_emi_loan_taken(pg_temp.r2341_bike(v_case.extra));
      raise exception 'FAIL B (%): accepted', v_case.name;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like v_case.msg then raise exception 'FAIL B (%): wrong refusal: %', v_case.name, sqlerrm; end if;
    end;
  end loop;
  if exists (select 1 from public.emi_purchases where tenant_id = 'dddddddd-0000-0000-0000-000000234101') then
    raise exception 'FAIL B: a refused set-up left a loan behind';
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000234101'
                and matched_to_type is not null and id <> '22222222-0000-0000-0000-000000234108') then
    raise exception 'FAIL B: a refused set-up matched a line';
  end if;
end $$;

-- ── A. Pick the imported line: no second bank line; cash unchanged ───────────────────────
do $$
declare v_r jsonb; v_p public.emi_purchases; v_line public.bank_transactions; v_bs record;
begin
  v_r := public.record_emi_loan_taken(pg_temp.r2341_bike());
  insert into r2341_ids values ('bike', (v_r ->> 'purchase_id')::uuid);
  select * into v_p from public.emi_purchases where id = (v_r ->> 'purchase_id')::uuid;
  if v_p.kind <> 'loan' or v_p.financed <> 250000 or v_p.received_bank_txn_id is distinct from '22222222-0000-0000-0000-000000234101'
     or v_p.purchased_on <> '2026-09-04' then
    raise exception 'FAIL A: loan row %', row_to_json(v_p);
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = v_p.tenant_id) <> (select v from r2341_vals where k = 'lines0') then
    raise exception 'FAIL A: no second bank line — a new line was added';
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id = v_p.tenant_id and source = 'manual') then
    raise exception 'FAIL A: a manual money-in line was made';
  end if;
  select * into v_line from public.bank_transactions where id = '22222222-0000-0000-0000-000000234101';
  if v_line.matched_to_type is distinct from 'emi' or v_line.matched_to_id is distinct from v_p.id::text then
    raise exception 'FAIL A: the imported line is not matched to the loan (% %)', v_line.matched_to_type, v_line.matched_to_id;
  end if;
  select * into v_bs from public.report_balance_sheet('2026-12-31');
  if v_bs.cash_and_bank <> (select v from r2341_vals where k = 'cash0') then
    raise exception 'FAIL A: cash changed (% → %) — counted twice', (select v from r2341_vals where k = 'cash0'), v_bs.cash_and_bank;
  end if;
  if v_bs.emi_loans_payable <> 250000 then raise exception 'FAIL A: loan on the Balance Sheet %', v_bs.emi_loans_payable; end if;
  if v_bs.emi_unregistered_cost <> 0 then raise exception 'FAIL A: counted as an asset'; end if;
  -- the same line cannot be picked for a second loan
  begin
    perform public.record_emi_loan_taken(pg_temp.r2341_bike('{"lender":"Again"}'));
    raise exception 'FAIL A: the same line was used for a second loan';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This line is already reconciled%' then raise exception 'FAIL A: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- ── D. Undo: un-reconcile the line on the bank page frees it and removes the loan ────────
do $$
declare v_id uuid := (select v from r2341_ids where k = 'bike');
begin
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234101', false);
  if (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000234101') is not null then
    raise exception 'FAIL D: line still matched';
  end if;
  if exists (select 1 from public.emi_purchases where id = v_id) then raise exception 'FAIL D: the loan is still there'; end if;
  if exists (select 1 from public.emi_schedule where purchase_id = v_id) then raise exception 'FAIL D: schedule left'; end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) <> (select v from r2341_vals where k = 'cash0') then
    raise exception 'FAIL D: cash changed';
  end if;
  if (select emi_loans_payable from public.report_balance_sheet('2026-12-31')) <> 0 then raise exception 'FAIL D: loan still on the Balance Sheet'; end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000234101') <> (select v from r2341_vals where k = 'lines0') then
    raise exception 'FAIL D: bank lines changed';
  end if;
end $$;

-- ── C. ₹1 rounding: a ₹1,00,001 line for a ₹1,00,000 loan ────────────────────────────────
do $$
declare v_r jsonb; v_p public.emi_purchases;
begin
  v_r := public.record_emi_loan_taken(jsonb_build_object('lender','Tata Capital','principal',100000,'interest_rate',12,
    'account_id','bbbbbbbb-0000-0000-0000-000000234101','received_txn_id','22222222-0000-0000-0000-000000234106',
    'reconcile_txn_id',null,'schedule',(select t from r2341_sched)));
  select * into v_p from public.emi_purchases where id = (v_r ->> 'purchase_id')::uuid;
  if v_p.received_bank_txn_id is distinct from '22222222-0000-0000-0000-000000234106' or v_p.purchased_on <> '2026-09-02' then
    raise exception 'FAIL C: %', row_to_json(v_p);
  end if;
  if (select matched_to_id from public.bank_transactions where id = '22222222-0000-0000-0000-000000234106') is distinct from v_p.id::text then
    raise exception 'FAIL C: line not matched';
  end if;
end $$;

-- ── E. EMI 1 reconciled → un-reconciling the loan money is refused; undo EMI 1, then it works ─
do $$
declare v_r jsonb; v_id uuid;
begin
  v_r := public.record_emi_loan_taken(pg_temp.r2341_bike('{"reconcile_txn_id":"22222222-0000-0000-0000-000000234102"}'));
  v_id := (v_r ->> 'purchase_id')::uuid;
  if (v_r -> 'reconciled' ->> 'seq')::integer is distinct from 1 then raise exception 'FAIL E: EMI 1 not reconciled %', v_r; end if;
  begin
    perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234101', false);
    raise exception 'FAIL E: un-reconciled the loan money while EMI 1 is paid';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%EMI%undo%first%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
  end;
  if not exists (select 1 from public.emi_purchases where id = v_id) then raise exception 'FAIL E: loan gone after a refusal'; end if;
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234102', false);
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000234101', false);
  if exists (select 1 from public.emi_purchases where id = v_id) then raise exception 'FAIL E: loan left after undo'; end if;
  if (select matched_to_type from public.bank_transactions where id in ('22222222-0000-0000-0000-000000234101','22222222-0000-0000-0000-000000234102') and matched_to_type is not null limit 1) is not null then
    raise exception 'FAIL E: a line is still matched';
  end if;
end $$;

select 'R-2341 loan from imported credit: ALL PASS' as result;

rollback;
