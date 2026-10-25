-- R-1871 (Pardeep, 24 Oct 2026): employee office-expense advance from the bank page.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1871_employee_advance_bank.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1871 migration> <this test> rollback;
-- Expect "PASS r1871".
--
-- Proves (the owner's case: ₹10,000 by bank, ₹6,500 bills incl. GST, ₹3,500 back by bank):
--   1. a ₹10,000 bank debit booked as "Advance to employee" → an Employee advance of ₹10,000
--      (asset), linked to the line, NO extra bank / cash line, P&L unchanged, Balance Sheet
--      prepaid +₹10,000.
--   2. ₹6,500 of bills (₹4,130 incl. ₹630 GST from a registered same-state vendor + ₹2,370
--      travel) → two expenses in their categories against the advance; GST split CGST/SGST;
--      balance ₹3,500; P&L expenses +₹6,500.
--   3. ₹3,500 bank credit "Advance returned" → advance settled (balance ₹0, closed); un-reconcile
--      reopens it with ₹3,500; booking again settles it.
--   4. top-up ₹2,000 from the bank; bills of ₹3,200 refused without "reimburse extra"; with it →
--      ₹2,000 from the advance + a ₹1,200 reimbursement (payable); a ₹1,200 bank debit pays it;
--      un-reconcile makes it pending again; un-reconciling the top-up is refused (bills use it).
--   5. part return ₹500 of ₹1,000 → advance stays open with ₹500.
--   6. refusals: sales (42501), billing on the bank (42501), no company (28000), another company's
--      line / advance, Petty Cash line, return more than the balance, wrong-direction line,
--      reimbursement amount mismatch, an already reconciled line. Nothing saved by a refusal.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1871000-0000-4000-8000-0000000000' || k)::uuid, 'r1871-' || k || '@example.test'
  from unnest(array['01','02','03','05','06','07']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration) values
  ('e1871000-0000-0000-0000-0000000000f1', 'R1871 Co',  'r1871a@example.in', '07', 'Delhi', 'R street, Delhi', 'R71A', '07AAACR1871R1Z1', 'registered'),
  ('e1871000-0000-0000-0000-0000000000f2', 'R1871 Other','r1871b@example.in', '07', 'Delhi', 'R street, Delhi', 'R71B', '07AAACR1871R1Z2', 'registered');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1871000-0000-4000-8000-000000000001', 'e1871000-0000-0000-0000-0000000000f1', 'r1871-01@example.in', 'Owner',      'owner', true),
  ('e1871000-0000-4000-8000-000000000002', 'e1871000-0000-0000-0000-0000000000f1', 'r1871-02@example.in', 'Sales',      'sales', true),
  ('e1871000-0000-4000-8000-000000000003', 'e1871000-0000-0000-0000-0000000000f2', 'r1871-03@example.in', 'Other own',  'owner', true),
  ('e1871000-0000-4000-8000-000000000005', 'e1871000-0000-0000-0000-0000000000f1', 'r1871-05@example.in', 'Accountant', 'accountant', true),
  ('e1871000-0000-4000-8000-000000000007', 'e1871000-0000-0000-0000-0000000000f1', 'r1871-07@example.in', 'Billing',    'billing', true);

insert into public.employees (id, tenant_id, name) values
  ('e1871000-0000-4000-8000-0000000000e1', 'e1871000-0000-0000-0000-0000000000f1', 'Ramesh Kumar'),
  ('e1871000-0000-4000-8000-0000000000e2', 'e1871000-0000-0000-0000-0000000000f1', 'Suresh Pal');

insert into public.vendors (id, tenant_id, name, gstin) values
  ('e1871000-0000-4000-8000-0000000000c1', 'e1871000-0000-0000-0000-0000000000f1', 'Kapoor Stationers', '07AABCK1234L1Z5');

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('e1871000-0000-4000-8000-0000000000a1', 'e1871000-0000-0000-0000-0000000000f1', 'HDFC Current', 'HDFC', 'current', 100000, '2026-04-01'),
  ('e1871000-0000-4000-8000-0000000000a2', 'e1871000-0000-0000-0000-0000000000f1', 'Petty Cash',   'Cash', 'cash',     5000,   '2026-04-01'),
  ('e1871000-0000-4000-8000-0000000000b1', 'e1871000-0000-0000-0000-0000000000f2', 'Other Bank',   'SBI',  'current', 100000, '2026-04-01');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('e1871000-0000-4000-8000-0000000000d1', 'e1871000-0000-0000-0000-0000000000f1', 'e1871000-0000-4000-8000-0000000000a1', '2026-10-01', 'UPI/RAMESH KUMAR/office exp', 10000, 0, 'csv_upload'),
  ('e1871000-0000-4000-8000-0000000000d2', 'e1871000-0000-0000-0000-0000000000f1', 'e1871000-0000-4000-8000-0000000000a1', '2026-10-09', 'UPI/RAMESH KUMAR/return',     0, 3500, 'csv_upload'),
  ('e1871000-0000-4000-8000-0000000000d3', 'e1871000-0000-0000-0000-0000000000f1', 'e1871000-0000-4000-8000-0000000000a1', '2026-10-12', 'UPI/RAMESH KUMAR/topup',      2000, 0, 'csv_upload'),
  ('e1871000-0000-4000-8000-0000000000d4', 'e1871000-0000-0000-0000-0000000000f1', 'e1871000-0000-4000-8000-0000000000a1', '2026-10-20', 'UPI/RAMESH KUMAR/reimb',      1200, 0, 'csv_upload'),
  ('e1871000-0000-4000-8000-0000000000d5', 'e1871000-0000-0000-0000-0000000000f1', 'e1871000-0000-4000-8000-0000000000a1', '2026-10-21', 'NEFT SURESH PAL',             1000, 0, 'csv_upload'),
  ('e1871000-0000-4000-8000-0000000000d6', 'e1871000-0000-0000-0000-0000000000f1', 'e1871000-0000-4000-8000-0000000000a1', '2026-10-22', 'UPI/SURESH PAL/back',         0, 500, 'csv_upload'),
  ('e1871000-0000-4000-8000-0000000000d7', 'e1871000-0000-0000-0000-0000000000f1', 'e1871000-0000-4000-8000-0000000000a2', '2026-10-22', 'Cash to Suresh',              300, 0, 'manual'),
  ('e1871000-0000-4000-8000-0000000000d8', 'e1871000-0000-0000-0000-0000000000f1', 'e1871000-0000-4000-8000-0000000000a1', '2026-10-23', 'UPI/SURESH PAL/back2',        0, 900, 'csv_upload'),
  ('e1871000-0000-4000-8000-0000000000d9', 'e1871000-0000-0000-0000-0000000000f2', 'e1871000-0000-4000-8000-0000000000b1', '2026-10-01', 'OTHER CO',                    5000, 0, 'csv_upload');

create temp table r1871_res (k text primary key, v text);
grant all on r1871_res to authenticated, service_role;

create function pg_temp.r1871_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1871000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1871_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
-- P&L expenses (gross, before ITC) for the year, from report_pnl's own groups.
create function pg_temp.r1871_pnl_exp() returns bigint language sql as $$
  select coalesce(sum((g->>'amount')::bigint), 0)
    from public.report_pnl('2026-04-01', '2027-03-31') r, jsonb_array_elements(r.expense_groups) g;
$$;
create function pg_temp.r1871_adv(p_name text) returns public.prepaid_advances language sql as $$
  select * from public.prepaid_advances
   where tenant_id = 'e1871000-0000-0000-0000-0000000000f1' and category = 'Employee advance' and vendor_name = p_name
   order by created_at desc limit 1;
$$;

select pg_temp.r1871_as('01');
insert into r1871_res select 'pnl0', pg_temp.r1871_pnl_exp()::text;
insert into r1871_res select 'bs0', (select prepaid_advances::text from public.report_balance_sheet('2027-03-31'));
insert into r1871_res select 'lines0', (select count(*)::text from public.bank_transactions where tenant_id = 'e1871000-0000-0000-0000-0000000000f1');

-- 1. ₹10,000 bank debit → advance to Ramesh
insert into r1871_res select 'give', public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d1', 'give', 'Ramesh Kumar')::text;
do $$
declare v_a public.prepaid_advances := pg_temp.r1871_adv('Ramesh Kumar'); v_t public.bank_transactions;
begin
  select * into v_t from public.bank_transactions where id = 'e1871000-0000-4000-8000-0000000000d1';
  if v_a.id is null or v_a.total_amount <> 10000 or v_a.consumed_amount <> 0 or v_a.closed_at is not null
     or v_a.bank_txn_id <> v_t.id or v_a.paid_date <> '2026-10-01' then raise exception 'FAIL 1a advance %', row_to_json(v_a); end if;
  if v_t.matched_to_type <> 'prepaid' or v_t.matched_to_id <> v_a.id::text then raise exception 'FAIL 1b line %', row_to_json(v_t); end if;
  if (select count(*) from public.bank_transactions where tenant_id = v_a.tenant_id)::text <> (select v from r1871_res where k = 'lines0') then
    raise exception 'FAIL 1c an extra bank/cash line was written'; end if;
  if pg_temp.r1871_pnl_exp()::text <> (select v from r1871_res where k = 'pnl0') then raise exception 'FAIL 1d advance hit the P&L'; end if;
  if (select prepaid_advances from public.report_balance_sheet('2027-03-31')) <> (select v::bigint from r1871_res where k = 'bs0') + 10000 then
    raise exception 'FAIL 1e balance sheet prepaid'; end if;
  if not exists (select 1 from public.employee_advance_bank_links where bank_txn_id = v_t.id and kind = 'give' and amount = 10000) then
    raise exception 'FAIL 1f link'; end if;
end $$;

-- 2. ₹6,500 of bills (billing user may add bills)
select pg_temp.r1871_as('07');
insert into r1871_res select 'bills1', public.add_employee_advance_bills((pg_temp.r1871_adv('Ramesh Kumar')).id, jsonb_build_array(
  jsonb_build_object('date', '2026-10-03', 'vendor_id', 'e1871000-0000-4000-8000-0000000000c1', 'category', 'Office Supplies', 'amount', 4130, 'gst', 630, 'bill_no', 'KS-77', 'note', 'Paper, toner'),
  jsonb_build_object('date', '2026-10-04', 'vendor_name', 'Ola', 'category', 'Travel', 'amount', 2370)))::text;
do $$
declare v_a public.prepaid_advances := pg_temp.r1871_adv('Ramesh Kumar'); v_e public.expenses;
begin
  if v_a.consumed_amount <> 6500 or v_a.total_amount - v_a.consumed_amount <> 3500 then raise exception 'FAIL 2a advance %', row_to_json(v_a); end if;
  select * into v_e from public.expenses where prepaid_advance_id = v_a.id and category = 'Office Supplies';
  if v_e.amount <> 4130 or v_e.gst_paid <> 630 or v_e.cgst <> 315 or v_e.sgst <> 315 or v_e.igst is not null or v_e.bill_type <> 'gst'
     or v_e.vendor_name <> 'Kapoor Stationers' or v_e.payment_method <> 'employee_advance' or v_e.bill_no <> 'KS-77' then
    raise exception 'FAIL 2b expense %', row_to_json(v_e); end if;
  if (select count(*) from public.expenses where prepaid_advance_id = v_a.id) <> 2 then raise exception 'FAIL 2c count'; end if;
  if ((select v from r1871_res where k = 'bills1')::jsonb->>'left')::int <> 3500 then raise exception 'FAIL 2d left'; end if;
end $$;
select pg_temp.r1871_as('01');
do $$ begin
  if pg_temp.r1871_pnl_exp() <> (select v::bigint from r1871_res where k = 'pnl0') + 6500 then raise exception 'FAIL 2e P&L %', pg_temp.r1871_pnl_exp(); end if;
  if (select prepaid_advances from public.report_balance_sheet('2027-03-31')) <> (select v::bigint from r1871_res where k = 'bs0') + 3500 then
    raise exception 'FAIL 2f balance sheet'; end if;
end $$;

-- 3. ₹3,500 back by bank credit → settled; un-reconcile reopens; book again
insert into r1871_res select 'ret', public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d2', 'return', null, (pg_temp.r1871_adv('Ramesh Kumar')).id)::text;
do $$
declare v_a public.prepaid_advances := pg_temp.r1871_adv('Ramesh Kumar');
begin
  if v_a.closed_at is null or v_a.total_amount <> 6500 or v_a.consumed_amount <> 6500 then raise exception 'FAIL 3a settle %', row_to_json(v_a); end if;
  if (select matched_to_type from public.bank_transactions where id = 'e1871000-0000-4000-8000-0000000000d2') <> 'prepaid' then raise exception 'FAIL 3b'; end if;
  if (select prepaid_advances from public.report_balance_sheet('2027-03-31')) <> (select v::bigint from r1871_res where k = 'bs0') then
    raise exception 'FAIL 3c balance sheet not back to zero'; end if;
  if pg_temp.r1871_pnl_exp() <> (select v::bigint from r1871_res where k = 'pnl0') + 6500 then raise exception 'FAIL 3d P&L moved on return'; end if;
end $$;
select public.reconcile_bank_txn('e1871000-0000-4000-8000-0000000000d2', null, null, null);
do $$
declare v_a public.prepaid_advances := pg_temp.r1871_adv('Ramesh Kumar');
begin
  if v_a.closed_at is not null or v_a.total_amount - v_a.consumed_amount <> 3500 then raise exception 'FAIL 3e un-reconcile %', row_to_json(v_a); end if;
  if exists (select 1 from public.employee_advance_bank_links where bank_txn_id = 'e1871000-0000-4000-8000-0000000000d2') then raise exception 'FAIL 3f link left'; end if;
end $$;
select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d2', 'return', null, (pg_temp.r1871_adv('Ramesh Kumar')).id);
do $$ begin
  if (pg_temp.r1871_adv('Ramesh Kumar')).closed_at is null then raise exception 'FAIL 3g settle again'; end if;
end $$;

-- 4. top-up ₹2,000 → bills ₹3,200 → ₹1,200 reimbursement → paid by bank
select pg_temp.r1871_as('05');
select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d3', 'top_up', null, (pg_temp.r1871_adv('Ramesh Kumar')).id);
do $$
declare v_a public.prepaid_advances := pg_temp.r1871_adv('Ramesh Kumar');
begin
  if v_a.closed_at is not null or v_a.total_amount - v_a.consumed_amount <> 2000 then raise exception 'FAIL 4a top-up %', row_to_json(v_a); end if;
end $$;
insert into r1871_res select 'over_no', pg_temp.r1871_err(format($q$select public.add_employee_advance_bills(%L, '[{"date":"2026-10-15","vendor_name":"Cafe","category":"Office Supplies","amount":3200,"gst":0}]'::jsonb)$q$, (pg_temp.r1871_adv('Ramesh Kumar')).id));
insert into r1871_res select 'over', public.add_employee_advance_bills((pg_temp.r1871_adv('Ramesh Kumar')).id,
  '[{"date":"2026-10-15","vendor_id":"e1871000-0000-4000-8000-0000000000c1","category":"Office Supplies","amount":3200,"gst":480}]'::jsonb, true)::text;
do $$
declare v_a public.prepaid_advances := pg_temp.r1871_adv('Ramesh Kumar'); v_r public.reimbursements; v_o jsonb := (select v::jsonb from r1871_res where k = 'over');
begin
  if (select v from r1871_res where k = 'over_no') not like '23514:%Reimburse ₹1200%' then raise exception 'FAIL 4b refusal: %', (select v from r1871_res where k = 'over_no'); end if;
  if v_a.total_amount - v_a.consumed_amount <> 0 then raise exception 'FAIL 4c advance %', row_to_json(v_a); end if;
  if (v_o->>'from_advance')::int <> 2000 or (v_o->>'reimbursed')::int <> 1200 then raise exception 'FAIL 4d %', v_o; end if;
  select * into v_r from public.reimbursements where id = (v_o->'reimbursement_ids'->>0)::uuid;
  if v_r.amount <> 1200 or v_r.status <> 'pending' or v_r.gst_paid <> 180 or v_r.employee_id <> 'e1871000-0000-4000-8000-0000000000e1'
     or v_r.person_name <> 'Ramesh Kumar' then raise exception 'FAIL 4e reimbursement %', row_to_json(v_r); end if;
  if (select vendor_id from public.expenses where id = v_r.expense_id) <> 'e1871000-0000-4000-8000-0000000000c1' then raise exception 'FAIL 4f vendor on reimb expense'; end if;
  if (select gst_paid from public.expenses where prepaid_advance_id = v_a.id and expense_date = '2026-10-15') <> 300 then raise exception 'FAIL 4g GST split'; end if;
  insert into r1871_res values ('reimb', v_r.id::text);
end $$;
select pg_temp.r1871_as('01');
do $$ begin
  if pg_temp.r1871_pnl_exp() <> (select v::bigint from r1871_res where k = 'pnl0') + 6500 + 3200 then raise exception 'FAIL 4h P&L %', pg_temp.r1871_pnl_exp(); end if;
  if (select reimbursements_payable from public.report_balance_sheet('2027-03-31')) < 1200 then raise exception 'FAIL 4i payable'; end if;
end $$;
insert into r1871_res select 'reimb_bad', pg_temp.r1871_err(format($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d5', 'reimburse', null, null, %L)$q$, (select v from r1871_res where k = 'reimb')));
select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d4', 'reimburse', null, null, (select v::uuid from r1871_res where k = 'reimb'));
do $$ begin
  if (select v from r1871_res where k = 'reimb_bad') not like '%is ₹1200 but this line is ₹1000%' then raise exception 'FAIL 4j mismatch: %', (select v from r1871_res where k = 'reimb_bad'); end if;
  if (select status from public.reimbursements where id = (select v::uuid from r1871_res where k = 'reimb')) <> 'settled' then raise exception 'FAIL 4k settle'; end if;
  if (select matched_to_type from public.bank_transactions where id = 'e1871000-0000-4000-8000-0000000000d4') <> 'expense' then raise exception 'FAIL 4l line'; end if;
end $$;
select public.reconcile_bank_txn('e1871000-0000-4000-8000-0000000000d4', null, null, null);
do $$ begin
  if (select status from public.reimbursements where id = (select v::uuid from r1871_res where k = 'reimb')) <> 'pending' then raise exception 'FAIL 4m un-reconcile reimb'; end if;
end $$;
insert into r1871_res select 'undo_topup', pg_temp.r1871_err($q$select public.reconcile_bank_txn('e1871000-0000-4000-8000-0000000000d3', null, null, null)$q$);
do $$ begin
  if (select v from r1871_res where k = 'undo_topup') not like '%Remove those bills first%' then raise exception 'FAIL 4n top-up undo: %', (select v from r1871_res where k = 'undo_topup'); end if;
  if (select matched_to_type from public.bank_transactions where id = 'e1871000-0000-4000-8000-0000000000d3') <> 'prepaid' then raise exception 'FAIL 4o top-up line freed'; end if;
end $$;

-- 5. part return: ₹1,000 to Suresh, ₹500 back → ₹500 still with him
select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d5', 'give', 'Suresh Pal');
select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d6', 'return', null, (pg_temp.r1871_adv('Suresh Pal')).id);
do $$
declare v_a public.prepaid_advances := pg_temp.r1871_adv('Suresh Pal');
begin
  if v_a.closed_at is not null or v_a.total_amount <> 500 or v_a.consumed_amount <> 0 then raise exception 'FAIL 5a part return %', row_to_json(v_a); end if;
end $$;

-- 6. refusals
insert into r1871_res select 'ret_more', pg_temp.r1871_err(format($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d8', 'return', null, %L)$q$, (pg_temp.r1871_adv('Suresh Pal')).id));
insert into r1871_res select 'petty', pg_temp.r1871_err($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d7', 'give', 'Suresh Pal')$q$);
insert into r1871_res select 'dir', pg_temp.r1871_err($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d8', 'give', 'Suresh Pal')$q$);
insert into r1871_res select 'other_line', pg_temp.r1871_err($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d9', 'give', 'Suresh Pal')$q$);
insert into r1871_res select 'again', pg_temp.r1871_err($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d1', 'give', 'Suresh Pal')$q$);
insert into r1871_res select 'noname', pg_temp.r1871_err($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d4', 'give', '  ')$q$);
select pg_temp.r1871_as('02');
insert into r1871_res select 'sales', pg_temp.r1871_err($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d4', 'give', 'Suresh Pal')$q$);
-- settle_reimbursement has no role check of its own: only this function's guard stops it.
insert into r1871_res select 'sales_reimb', pg_temp.r1871_err(format($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d4', 'reimburse', null, null, %L)$q$, (select v from r1871_res where k = 'reimb')));
insert into r1871_res select 'sales_bills', pg_temp.r1871_err(format($q$select public.add_employee_advance_bills(%L, '[{"date":"2026-10-22","category":"Travel","amount":100}]'::jsonb)$q$, (pg_temp.r1871_adv('Suresh Pal')).id));
select pg_temp.r1871_as('07');
insert into r1871_res select 'billing_bank', pg_temp.r1871_err($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d4', 'give', 'Suresh Pal')$q$);
select pg_temp.r1871_as('06');
insert into r1871_res select 'nocompany', pg_temp.r1871_err($q$select public.book_bank_txn_as_employee_advance('e1871000-0000-4000-8000-0000000000d4', 'give', 'Suresh Pal')$q$);
select pg_temp.r1871_as('03');
insert into r1871_res select 'other_adv', pg_temp.r1871_err(format($q$select public.add_employee_advance_bills(%L, '[{"date":"2026-10-22","category":"Travel","amount":100}]'::jsonb)$q$, (select id from public.prepaid_advances where vendor_name = 'Suresh Pal' and tenant_id = 'e1871000-0000-0000-0000-0000000000f1')));
select set_config('request.jwt.claims', '', true);
do $$
declare r record;
begin
  for r in select * from (values
      ('ret_more',     '%Only ₹500 is still with Suresh Pal%'),
      ('petty',        '%Petty Cash line%'),
      ('dir',          '%must be a money-out line%'),
      ('other_line',   '%not found in your company%'),
      ('again',        '%already reconciled%'),
      ('noname',       '%Pick the employee%'),
      ('sales',        '42501:%'),
      ('sales_bills',  '42501:%'),
      ('sales_reimb',  '42501:%'),
      ('billing_bank', '42501:%'),
      ('nocompany',    '28000:%'),
      ('other_adv',    '%Advance not found in your company%')) t(k, pat)
  loop
    if (select v from r1871_res where k = r.k) not like r.pat then
      raise exception 'FAIL 6 %: %', r.k, (select v from r1871_res where k = r.k);
    end if;
  end loop;
  if (select count(*) from public.prepaid_advances where tenant_id = 'e1871000-0000-0000-0000-0000000000f1' and category = 'Employee advance') <> 2 then
    raise exception 'FAIL 6x a refused call saved an advance'; end if;
  if (select total_amount from public.prepaid_advances where vendor_name = 'Suresh Pal' and tenant_id = 'e1871000-0000-0000-0000-0000000000f1') <> 500 then
    raise exception 'FAIL 6y a refused return moved the advance'; end if;
end $$;

select 'PASS r1871' as result;

rollback;
