-- R-2676 (11 Nov 2026, p0 paisa, G-RECON N6 / G-FY2526): the Zoho FY purchase import brings in a Zoho
-- EXPENSE that has no vendor as a vendor-less expense paid from the mapped account
-- (import_zoho_fy_purchases, migration 20261111204524_r2676_zoho_no_vendor_expenses).
--   1. A Zoho BILL with no vendor still stays out.
--   2. A no-vendor expense comes in only when EVERY line's Zoho account is mapped to an expense category:
--      an unmapped account (fixed deposit, loan, GST, asset), a salary account (Salaries can never be mapped), or one unmapped line
--      among mapped ones → left out with the reason (never "Unmapped — review").
--   3. Claims input GST, reverse charge, TDS, a COGS account → left out with the reason.
--   4. A vendor-less expense NOT from Zoho of the same amount (±₹1), ±3 days, same paid-from account (or
--      none) → "already in the books" (the no-vendor sheet / hand entry); a Salaries row never blocks;
--      the same amount from ANOTHER account does not block.
--   5. Dry run counts them (no_vendor) and writes nothing; the real import writes vendor-less paid rows
--      (bank: account set, no line; two categories = two rows, ineligible GST in the cost; petty cash =
--      its cash line); no vendor made, no vendor change logged.
--   6. Rerun = already.
--   7. Remove this import takes them back.
-- Self-asserting; the whole file rolls back. Red without the migration (1 passes, 5 fails: "It has no vendor").

begin;

insert into auth.users (id, email) values
  ('b2676000-0000-0000-0000-0000000000a1', 'r2676-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2676000-0000-0000-0000-0000000000f0', 'R2676 T', 'r2676@example.test', '07', '07AAACR2676A1Z5', 'R2676');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2676000-0000-0000-0000-0000000000a1', 'b2676000-0000-0000-0000-0000000000f0', 'r2676-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-05-01' where id = 'b2676000-0000-0000-0000-0000000000f0';
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type) values
  ('b2676000-0000-0000-0000-0000000000e1', 'b2676000-0000-0000-0000-0000000000f0', 'HDFC 4523', 'HDFC', 'current'),
  ('b2676000-0000-0000-0000-0000000000e2', 'b2676000-0000-0000-0000-0000000000f0', 'R2676 Petty Cash', 'Cash', 'cash'),
  ('b2676000-0000-0000-0000-0000000000e3', 'b2676000-0000-0000-0000-0000000000f0', 'R2676 Card', 'HDFC', 'credit_card');

-- Not from Zoho, no vendor: booked from the bank line (no-vendor sheet) 777 on 10 Jun from HDFC; 555 on
-- 10 Jun from the CARD; and a salary of 888 on 10 Jun.
insert into public.expenses (id, tenant_id, category, expense_date, amount, paid, paid_date, payment_method, bank_account_id) values
  ('EXP-R2676-SHEET', 'b2676000-0000-0000-0000-0000000000f0', 'Office Supplies', '2025-06-10', 777, true, '2025-06-10', 'bank', 'b2676000-0000-0000-0000-0000000000e1'),
  ('EXP-R2676-CARD',  'b2676000-0000-0000-0000-0000000000f0', 'Office Supplies', '2025-06-10', 555, true, '2025-06-10', 'card', 'b2676000-0000-0000-0000-0000000000e3'),
  ('EXP-R2676-SAL',   'b2676000-0000-0000-0000-0000000000f0', 'Salaries',        '2025-06-10', 888, true, '2025-06-10', 'bank', 'b2676000-0000-0000-0000-0000000000e1');

create function pg_temp.ln(acct text, taxable int, tax int, elig boolean default true) returns jsonb language sql as $f$
  select jsonb_build_object('accountId', acct, 'accountName', acct || ' name', 'description', 'line ' || acct, 'hsn', '', 'qty', 1,
    'taxable', taxable, 'tax', tax, 'itcEligible', elig);
$f$;
-- A Zoho document with NO vendor (vendorZohoId, vendorName, gstin empty).
create function pg_temp.doc(kind text, zid text, d text, taxable int, igst int, lines jsonb,
  tds int default 0, tsec text default null, rcm boolean default false, rcm_tax int default 0) returns jsonb language sql as $f$
  select jsonb_build_object('kind', kind, 'zohoId', zid, 'number', case when kind = 'bills' then 'B-' || zid else '' end, 'date', d, 'dueDate', d,
    'status', case when kind = 'bills' then 'open' else 'nonbillable' end,
    'vendorZohoId', '', 'vendorName', '', 'gstin', '', 'gstTreatment', '', 'currency', 'INR',
    'taxable', taxable, 'igst', igst, 'cgst', 0, 'sgst', 0, 'tax', igst, 'total', taxable + igst,
    'rcm', rcm, 'rcmTax', rcm_tax, 'tdsAmount', tds, 'tdsSection', tsec, 'lines', lines, 'paidThrough', 'HDFC 4523', 'problems', '[]'::jsonb);
$f$;

insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2676000-0000-0000-0000-0000000000f0', x.kind, '2025-26', x.zid, coalesce(x.p->>'number', ''), (x.p->>'date')::date, x.p->>'status', x.p, now()
from (values
  ('bills',    'bn1', pg_temp.doc('bills',    'bn1', '2025-05-10', 400, 0, jsonb_build_array(pg_temp.ln('A-RENT', 400, 0)))),
  ('expenses', 'n1',  pg_temp.doc('expenses', 'n1',  '2025-05-20', 500, 0, jsonb_build_array(pg_temp.ln('A-RENT', 500, 0)))),
  ('expenses', 'n2',  pg_temp.doc('expenses', 'n2',  '2025-05-21', 500, 36, jsonb_build_array(pg_temp.ln('A-RENT', 300, 0), pg_temp.ln('A-WEL', 200, 36, false)))),
  ('expenses', 'n3',  pg_temp.doc('expenses', 'n3',  '2025-05-22', 100000, 0, jsonb_build_array(pg_temp.ln('A-FD', 100000, 0)))),
  ('expenses', 'n4',  pg_temp.doc('expenses', 'n4',  '2025-05-23', 30000, 0, jsonb_build_array(pg_temp.ln('A-SAL', 30000, 0)))),
  ('expenses', 'n5',  pg_temp.doc('expenses', 'n5',  '2025-05-24', 500, 90, jsonb_build_array(pg_temp.ln('A-RENT', 500, 90)))),
  ('expenses', 'n6',  pg_temp.doc('expenses', 'n6',  '2025-05-25', 500, 0, jsonb_build_array(pg_temp.ln('A-RENT', 500, 90)), 0, null, true, 90)),
  ('expenses', 'n7',  pg_temp.doc('expenses', 'n7',  '2025-05-26', 500, 0, jsonb_build_array(pg_temp.ln('A-RENT', 500, 0)), 50, '194J')),
  ('expenses', 'n8',  pg_temp.doc('expenses', 'n8',  '2025-05-27', 500, 0, jsonb_build_array(pg_temp.ln('A-COGS', 500, 0)))),
  ('expenses', 'n9',  pg_temp.doc('expenses', 'n9',  '2025-06-11', 777, 0, jsonb_build_array(pg_temp.ln('A-RENT', 777, 0)))),
  ('expenses', 'n10', pg_temp.doc('expenses', 'n10', '2025-06-11', 888, 0, jsonb_build_array(pg_temp.ln('A-RENT', 888, 0)))),
  ('expenses', 'n11', pg_temp.doc('expenses', 'n11', '2025-06-12', 150, 0, jsonb_build_array(pg_temp.ln('A-WEL', 150, 0)))),
  ('expenses', 'n12', pg_temp.doc('expenses', 'n12', '2025-06-13', 900, 0, jsonb_build_array(pg_temp.ln('A-RENT', 400, 0), pg_temp.ln('A-LOAN', 500, 0)))),
  ('expenses', 'n13', pg_temp.doc('expenses', 'n13', '2025-06-11', 555, 0, jsonb_build_array(pg_temp.ln('A-RENT', 555, 0))))
) as x(kind, zid, p);

-- A-SAL (salaries) can never be mapped: the map table itself refuses the category Salaries (check
-- constraint), so a salary paid in Zoho is always on an unmapped account here.
do $x$
begin
  begin
    insert into public.zoho_account_category_map (tenant_id, zoho_account_id, zoho_account_name, category)
    values ('b2676000-0000-0000-0000-0000000000f0', 'A-SAL', 'Salaries and wages', 'Salaries');
    raise exception 'FAIL 0: the map accepted Salaries';
  exception when check_violation then null;
  end;
end $x$;

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.pick(zid text, acct text default 'b2676000-0000-0000-0000-0000000000e1') returns jsonb language sql as $f$
  select jsonb_build_object('zoho_id', zid, 'vendor_id', null, 'account_id', acct);
$f$;
create function pg_temp.all_picks() returns jsonb language sql as $f$
  select jsonb_build_array(pg_temp.pick('n1'), pg_temp.pick('n2'), pg_temp.pick('n3'), pg_temp.pick('n4'), pg_temp.pick('n5'),
    pg_temp.pick('n6'), pg_temp.pick('n7'), pg_temp.pick('n8'), pg_temp.pick('n9'), pg_temp.pick('n10'),
    pg_temp.pick('n11', 'b2676000-0000-0000-0000-0000000000e2'), pg_temp.pick('n12'), pg_temp.pick('n13'));
$f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.pick(text, text), pg_temp.all_picks() to authenticated;
set local role authenticated;

do $$
declare
  r jsonb; reasons text; n int; v_batch uuid; e public.expenses; v_vendors0 int; v_lines0 int;
begin
  perform pg_temp.as_user('b2676000-0000-0000-0000-0000000000a1');
  r := public.save_zoho_account_categories('[{"zoho_account_id":"A-RENT","zoho_account_name":"Rent","category":"Office Rent"},
    {"zoho_account_id":"A-WEL","category":"Staff Welfare"},{"zoho_account_id":"A-COGS","category":"COGS-Workspace"}]');
  if (r->>'saved')::int <> 3 then raise exception 'FAIL 0: map save %', r; end if;
  select count(*) into v_vendors0 from public.vendors where tenant_id = 'b2676000-0000-0000-0000-0000000000f0';
  select count(*) into v_lines0 from public.bank_transactions where tenant_id = 'b2676000-0000-0000-0000-0000000000f0';

  -- 1. A bill with no vendor stays out.
  r := public.import_zoho_fy_purchases('bills', '2025-26', '[{"zoho_id":"bn1","vendor_id":null}]', true);
  if (r->>'imported')::int <> 0 or r->'skipped'->0->>'reason' <> 'It has no vendor in Zoho.' then raise exception 'FAIL 1: bill %', r; end if;

  -- 5a. Dry run: counted, the refusals said, nothing written.
  r := public.import_zoho_fy_purchases('expenses', '2025-26', pg_temp.all_picks(), true);
  select string_agg((s->>'zoho_id') || '=' || (s->>'reason'), ' | ') into reasons from jsonb_array_elements(r->'skipped') s;
  if (r->>'dry_run')::boolean is not true or (r->>'imported')::int <> 5 or (r->>'no_vendor')::int <> 5 or (r->>'new_vendors')::int <> 0 then
    raise exception 'FAIL 5a: dry run % — %', r - 'done', reasons; end if;
  -- 2. every line must be on a mapped expense account
  if reasons not like '%n3=Zoho account "A-FD name" is not mapped to an expense category — map it only if it is an expense. A fixed deposit, loan, GST, asset or salary payment is not an expense and stays out.%' then
    raise exception 'FAIL 2a: unmapped %', reasons; end if;
  if reasons not like '%n4=Zoho account "A-SAL name" is not mapped to an expense category%' then raise exception 'FAIL 2b: salary account %', reasons; end if;
  if reasons not like '%n12=Zoho account "A-LOAN name" is not mapped to an expense category%' then raise exception 'FAIL 2c: one unmapped line %', reasons; end if;
  -- 3. GST claim / RCM / TDS / COGS
  if reasons not like '%n5=It claims input GST (or reverse charge) but has no vendor in Zoho — add the vendor in Zoho, or add it by hand with the supplier.%' then
    raise exception 'FAIL 3a: GST claim %', reasons; end if;
  if reasons not like '%n6=It claims input GST (or reverse charge) but has no vendor in Zoho%' then raise exception 'FAIL 3b: RCM %', reasons; end if;
  if reasons not like '%n7=It has TDS but no vendor in Zoho — add the vendor in Zoho, or add it by hand.%' then raise exception 'FAIL 3c: TDS %', reasons; end if;
  if reasons not like '%n8=A Zoho expense on a COGS account%' then raise exception 'FAIL 3d: COGS %', reasons; end if;
  -- 4. already in the books (no-vendor sheet); a salary and another account's expense do not block
  if reasons not like '%n9=Looks already in the books (not from Zoho): EXP-R2676-SHEET (10 Jun 2025, ₹777) — no vendor, same paid-from account, ±3 days, same amount%' then
    raise exception 'FAIL 4a: duplicate %', reasons; end if;
  if reasons like '%n10=%' then raise exception 'FAIL 4b: a Salaries row blocked an expense: %', reasons; end if;
  if reasons like '%n13=%' then raise exception 'FAIL 4c: an expense paid from another account blocked it: %', reasons; end if;
  if jsonb_array_length(r->'skipped') <> 8 then raise exception 'FAIL 5a: % skipped, want 8: %', jsonb_array_length(r->'skipped'), reasons; end if;
  if exists (select 1 from public.expenses where tenant_id = 'b2676000-0000-0000-0000-0000000000f0' and zoho_doc_id is not null)
     or exists (select 1 from public.zoho_fy_import_batches where tenant_id = 'b2676000-0000-0000-0000-0000000000f0')
     or (select count(*) from public.bank_transactions where tenant_id = 'b2676000-0000-0000-0000-0000000000f0') <> v_lines0 then
    raise exception 'FAIL 5a: the dry run wrote something'; end if;

  -- 5b. For real.
  r := public.import_zoho_fy_purchases('expenses', '2025-26', pg_temp.all_picks(), false);
  v_batch := (r->>'batch_id')::uuid;
  if v_batch is null or (r->>'imported')::int <> 5 or (r->>'no_vendor')::int <> 5 then raise exception 'FAIL 5b: import %', r - 'done'; end if;
  select * into e from public.expenses where zoho_doc_id = 'expenses:n1';
  if e.vendor_id is not null or e.vendor_name is not null or e.category <> 'Office Rent' or e.amount <> 500 or e.gst_paid <> 0
     or e.bill_type <> 'none' or e.tds_amount <> 0 or not e.paid or e.paid_date <> '2025-05-20' or e.payment_method <> 'bank'
     or e.bank_account_id <> 'b2676000-0000-0000-0000-0000000000e1' or e.reconciled_txn_id is not null
     or e.purchase_import_batch_id <> v_batch or e.notes not like 'Imported from Zoho Books (expense%Paid from HDFC 4523 in Zoho.%' then
    raise exception 'FAIL 5b: n1 stored wrong %', to_jsonb(e); end if;
  -- two categories = two rows; the ineligible GST stays in the cost
  select count(*) into n from public.expenses where zoho_doc_id = 'expenses:n2';
  if n <> 2 then raise exception 'FAIL 5c: n2 has % rows', n; end if;
  select * into e from public.expenses where zoho_doc_id = 'expenses:n2' and zoho_leg = 2;
  if e.category <> 'Staff Welfare' or e.amount <> 236 or e.gst_paid <> 0 or e.vendor_id is not null or e.notes not like '%not claimable%' then
    raise exception 'FAIL 5c: n2 leg 2 %', to_jsonb(e); end if;
  -- petty cash: its own cash line
  select * into e from public.expenses where zoho_doc_id = 'expenses:n11';
  if e.payment_method <> 'cash' or e.reconciled_txn_id is null
     or (select t.debit from public.bank_transactions t where t.id = e.reconciled_txn_id and t.bank_account_id = 'b2676000-0000-0000-0000-0000000000e2') is distinct from 150 then
    raise exception 'FAIL 5d: petty cash %', to_jsonb(e); end if;
  -- nothing refused came in; no vendor made or changed
  if exists (select 1 from public.expenses where zoho_doc_id in ('expenses:n3','expenses:n4','expenses:n5','expenses:n6','expenses:n7','expenses:n8','expenses:n9','expenses:n12')) then
    raise exception 'FAIL 5e: a refused document was imported'; end if;
  if exists (select 1 from public.expenses where tenant_id = 'b2676000-0000-0000-0000-0000000000f0' and category in ('Unmapped — review', 'Salaries') and zoho_doc_id is not null) then
    raise exception 'FAIL 5e: an unmapped / salary row was written'; end if;
  if (select count(*) from public.vendors where tenant_id = 'b2676000-0000-0000-0000-0000000000f0') <> v_vendors0
     or exists (select 1 from public.zoho_purchase_vendor_changes where batch_id = v_batch) then
    raise exception 'FAIL 5f: a vendor was made or changed'; end if;
  if (select count(*) from public.expenses where purchase_import_batch_id = v_batch) <> 6 then raise exception 'FAIL 5g: batch rows'; end if;

  -- 6. Rerun = already.
  r := public.import_zoho_fy_purchases('expenses', '2025-26', jsonb_build_array(pg_temp.pick('n1'), pg_temp.pick('n2')), false);
  if (r->>'imported')::int <> 0 or (r->>'already')::int <> 2 then raise exception 'FAIL 6: rerun %', r - 'done'; end if;
  if (select count(*) from public.expenses where zoho_doc_id in ('expenses:n1', 'expenses:n2')) <> 3 then raise exception 'FAIL 6: a second row'; end if;

  -- 7. Remove this import takes them back (and the petty-cash line).
  r := public.remove_zoho_fy_purchase_import(v_batch, 'R-2676 test: imported by mistake');
  if exists (select 1 from public.expenses where purchase_import_batch_id = v_batch)
     or (select count(*) from public.bank_transactions where tenant_id = 'b2676000-0000-0000-0000-0000000000f0') <> v_lines0 then
    raise exception 'FAIL 7: remove left rows %', r; end if;
  if (select count(*) from public.expenses where tenant_id = 'b2676000-0000-0000-0000-0000000000f0') <> 3 then raise exception 'FAIL 7: remove touched a hand row'; end if;
  raise notice 'R-2676 PASS: no-vendor Zoho expenses import as vendor-less expenses; balance-sheet / salary / GST-claim / TDS / duplicates stay out';
end $$;

rollback;
