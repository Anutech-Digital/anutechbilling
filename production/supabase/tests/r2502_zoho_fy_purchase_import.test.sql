-- R-2502: FY 2025-26 Zoho bills / expenses / vendor payments → the app's expenses, COGS bills and
-- payments (import_zoho_fy_purchases / import_zoho_fy_vendor_payments / remove_zoho_fy_purchase_import /
-- save_zoho_account_categories). Owner / accountant only; no company → refused; dry run writes nothing;
-- void / draft / before books start / books lock / mixed COGS / entered by hand refused; GST heads,
-- ineligible ITC in the cost, RCM, TDS by section; unmapped account → "Unmapped — review"; vendor
-- created from Zoho once; rerun = already; one batch + one activity row per part; payments: an expense
-- bill marked paid once covered, a part payment recorded, a COGS bill paid through pay_vendor_bill with
-- its Zoho TDS reported for Reconcile (no manual bank line, R-2502b); Reconcile afterwards counts the cash once; undo while untouched, refused after.
-- The money comes from the server's scan (zoho_fy_scan) — the picks carry none.
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b2502000-0000-0000-0000-0000000000a1', 'r2502-owner@example.test'),
  ('b2502000-0000-0000-0000-0000000000a2', 'r2502-acct@example.test'),
  ('b2502000-0000-0000-0000-0000000000a3', 'r2502-mgr@example.test'),
  ('b2502000-0000-0000-0000-0000000000a4', 'r2502-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2502000-0000-0000-0000-0000000000f0', 'R2502 T', 'r2502@example.test', '07', '07AAACR2502A1Z5', 'R2502'),
  ('b2502000-0000-0000-0000-0000000000f1', 'R2502 O', 'r2502o@example.test', '07', null, 'R2502O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2502000-0000-0000-0000-0000000000a1', 'b2502000-0000-0000-0000-0000000000f0', 'r2502-owner@example.test', 'Owner', 'owner', true),
  ('b2502000-0000-0000-0000-0000000000a2', 'b2502000-0000-0000-0000-0000000000f0', 'r2502-acct@example.test', 'Acct', 'accountant', true),
  ('b2502000-0000-0000-0000-0000000000a3', 'b2502000-0000-0000-0000-0000000000f0', 'r2502-mgr@example.test', 'Mgr', 'manager', true);

update public.tenants set books_start_date = '2025-05-01' where id = 'b2502000-0000-0000-0000-0000000000f0';

insert into public.vendors (id, tenant_id, name, gstin) values
  ('b2502000-0000-0000-0000-0000000000d1', 'b2502000-0000-0000-0000-0000000000f0', 'R2502 Mehta', '07AAACM2502A1Z5'),
  ('b2502000-0000-0000-0000-0000000000d9', 'b2502000-0000-0000-0000-0000000000f1', 'R2502 Other Co Vendor', null),
  ('b2502000-0000-0000-0000-0000000000d2', 'b2502000-0000-0000-0000-0000000000f0', 'R2502 NoGst', null);
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type) values
  ('b2502000-0000-0000-0000-0000000000e1', 'b2502000-0000-0000-0000-0000000000f0', 'HDFC 4523', 'HDFC', 'current'),
  ('b2502000-0000-0000-0000-0000000000e2', 'b2502000-0000-0000-0000-0000000000f0', 'R2502 Petty Cash', 'Cash', 'cash');
-- Booked by hand from a bank debit, with no bill number: Mehta 590 on 2 Jul 2025 (R-2502c duplicate check).
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, paid)
values ('EXP-R2502-HAND2', 'b2502000-0000-0000-0000-0000000000f0', 'Office Rent', 'R2502 Mehta', 'b2502000-0000-0000-0000-0000000000d1', '2025-07-02', 590, true);
-- Entered by hand earlier: Mehta's HAND-1.
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, bill_no, paid)
values ('EXP-R2502-HAND', 'b2502000-0000-0000-0000-0000000000f0', 'Software', 'R2502 Mehta', 'b2502000-0000-0000-0000-0000000000d1', '2025-06-01', 1180, 'HAND-1', false);

-- What the server read from Zoho (whole rupees — normalise.ts did paise → rupees).
create function pg_temp.ln(acct text, taxable int, tax int, elig boolean default true) returns jsonb language sql as $f$
  select jsonb_build_object('accountId', acct, 'accountName', acct || ' name', 'description', 'line ' || acct, 'hsn', '998431', 'qty', 1,
    'taxable', taxable, 'tax', tax, 'itcEligible', elig);
$f$;
create function pg_temp.doc(kind text, zid text, num text, d text, status text, vz text, vname text, gstin text,
  taxable int, igst int, cgst int, sgst int, lines jsonb, tds int default 0, tsec text default null, rcm boolean default false,
  rcm_tax int default 0, problems jsonb default '[]') returns jsonb language sql as $f$
  select jsonb_build_object('kind', kind, 'zohoId', zid, 'number', num, 'date', d, 'dueDate', d, 'status', status,
    'vendorZohoId', vz, 'vendorName', vname, 'gstin', gstin, 'gstTreatment', '', 'currency', 'INR',
    'taxable', taxable, 'igst', igst, 'cgst', cgst, 'sgst', sgst, 'tax', igst + cgst + sgst, 'total', taxable + igst + cgst + sgst,
    'rcm', rcm, 'rcmTax', rcm_tax, 'tdsAmount', tds, 'tdsSection', tsec, 'lines', lines, 'paidThrough', 'HDFC 4523', 'problems', problems);
$f$;

insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2502000-0000-0000-0000-0000000000f0', x.kind, '2025-26', x.zid, coalesce(x.p->>'number', ''), (x.p->>'date')::date, x.p->>'status', x.p, now()
from (values
  ('bills', 'b1',  pg_temp.doc('bills', 'b1', 'VB-1', '2025-05-10', 'paid', 'VZ1', 'R2502 Mehta', '07AAACM2502A1Z5', 1000, 0, 90, 90, jsonb_build_array(pg_temp.ln('A-SW', 1000, 180)), 100, '194J')),
  ('bills', 'b2',  pg_temp.doc('bills', 'b2', 'NC-1', '2025-05-11', 'open', 'VZ9', 'R2502 NewCo', '', 1000, 180, 0, 0,
                     jsonb_build_array(pg_temp.ln('A-SW', 500, 90), pg_temp.ln('A-WEL', 500, 90, false)))),
  ('bills', 'b3',  pg_temp.doc('bills', 'b3', 'C-1', '2025-05-12', 'paid', 'VZ1', 'R2502 Mehta', '07AAACM2502A1Z5', 2000, 360, 0, 0, jsonb_build_array(pg_temp.ln('A-COGS', 2000, 360)), 200, '194C')),
  ('bills', 'b4',  pg_temp.doc('bills', 'b4', 'V-4', '2025-05-13', 'void', 'VZ1', 'R2502 Mehta', '', 100, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-SW', 100, 0)))),
  ('bills', 'b5',  pg_temp.doc('bills', 'b5', 'V-5', '2025-05-14', 'draft', 'VZ1', 'R2502 Mehta', '', 100, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-SW', 100, 0)))),
  ('bills', 'b6',  pg_temp.doc('bills', 'b6', 'V-6', '2025-04-20', 'open', 'VZ1', 'R2502 Mehta', '', 100, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-SW', 100, 0)))),
  ('bills', 'b7',  pg_temp.doc('bills', 'b7', 'V-7', '2025-05-15', 'open', 'VZ1', 'R2502 Mehta', '', 200, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-COGS', 100, 0), pg_temp.ln('A-SW', 100, 0)))),
  ('bills', 'b8',  pg_temp.doc('bills', 'b8', 'HAND-1', '2025-06-01', 'open', 'VZ1', 'R2502 Mehta', '', 1000, 0, 90, 90, jsonb_build_array(pg_temp.ln('A-SW', 1000, 180)))),
  ('bills', 'b9',  pg_temp.doc('bills', 'b9', 'V-9', '2025-06-02', 'open', 'VZ1', 'R2502 Mehta', '', 300, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-NOMAP', 300, 0)))),
  ('bills', 'b10', pg_temp.doc('bills', 'b10', 'RC-1', '2025-06-03', 'open', 'VZ1', 'R2502 Mehta', '', 1000, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-SW', 1000, 180)), 0, null, true, 180)),
  ('bills', 'b11', pg_temp.doc('bills', 'b11', 'P-1', '2025-06-04', 'open', 'VZ1', 'R2502 Mehta', '', 100, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-SW', 100, 0)), 0, null, false, 0,
                     '["In USD — only rupee (INR) documents are imported; add it by hand with its exchange rate."]')),
  ('expenses', 'e1', pg_temp.doc('expenses', 'e1', '', '2025-05-20', 'nonbillable', 'VZ1', 'R2502 Mehta', '07AAACM2502A1Z5', 500, 90, 0, 0, jsonb_build_array(pg_temp.ln('A-RENT', 500, 90)))),
  ('vendorpayments', 'p1', jsonb_build_object('kind', 'vendorpayments', 'zohoId', 'p1', 'number', '1', 'date', '2025-06-10', 'status', '', 'amount', 1080, 'unapplied', 0, 'mode', 'Bank Transfer',
     'paidThrough', 'HDFC 4523', 'vendorName', 'R2502 Mehta', 'applied', jsonb_build_array(jsonb_build_object('billZohoId', 'b1', 'billNumber', 'VB-1', 'amount', 1080)), 'problems', '[]'::jsonb)),
  ('vendorpayments', 'p2', jsonb_build_object('kind', 'vendorpayments', 'zohoId', 'p2', 'number', '2', 'date', '2025-06-11', 'status', '', 'amount', 1000, 'unapplied', 0, 'mode', 'NEFT',
     'paidThrough', 'HDFC 4523', 'vendorName', 'R2502 Mehta', 'applied', jsonb_build_array(jsonb_build_object('billZohoId', 'b3', 'billNumber', 'C-1', 'amount', 1000)), 'problems', '[]'::jsonb)),
  ('vendorpayments', 'p5', jsonb_build_object('kind', 'vendorpayments', 'zohoId', 'p5', 'number', '5', 'date', '2025-06-14', 'status', '', 'amount', 1160, 'unapplied', 0, 'mode', 'NEFT',
     'paidThrough', 'HDFC 4523', 'vendorName', 'R2502 Mehta', 'applied', jsonb_build_array(jsonb_build_object('billZohoId', 'b3', 'billNumber', 'C-1', 'amount', 1160)), 'problems', '[]'::jsonb)),
  ('bills', 'b12', pg_temp.doc('bills', 'b12', 'NG-1', '2025-06-05', 'open', 'VZ12', 'R2502 NoGst', '07AAACN2502A1Z5', 1000, 0, 90, 90, jsonb_build_array(pg_temp.ln('A-SW', 1000, 180)))),
  ('vendorpayments', 'p3', jsonb_build_object('kind', 'vendorpayments', 'zohoId', 'p3', 'number', '3', 'date', '2025-06-12', 'status', '', 'amount', 800, 'unapplied', 500, 'mode', 'UPI',
     'paidThrough', 'HDFC 4523', 'vendorName', 'R2502 NewCo', 'applied', jsonb_build_array(jsonb_build_object('billZohoId', 'b2', 'billNumber', 'NC-1', 'amount', 300)), 'problems', '[]'::jsonb)),
  ('bills', 'b14', pg_temp.doc('bills', 'b14', 'TP-1', '2025-07-05', 'paid', 'VZ1', 'R2502 Mehta', '07AAACM2502A1Z5', 1000, 0, 90, 90, jsonb_build_array(pg_temp.ln('A-SW', 1000, 180)), 100, '194JB')),
  ('bills', 'b15', pg_temp.doc('bills', 'b15', 'KA-1', '2025-07-06', 'open', 'VZ15', 'R2502 Mehta', '29AAACM2502A1Z5', 1000, 180, 0, 0, jsonb_build_array(pg_temp.ln('A-SW', 1000, 180)))),
  ('bills', 'b16', pg_temp.doc('bills', 'b16', 'MC-1', '2025-07-07', 'open', 'VZ1', 'R2502 Mehta', '07AAACM2502A1Z5', 1000, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-SW', 600, 0), pg_temp.ln('A-INT', 400, 0)), 100, '194JB')),
  ('expenses', 'e2', pg_temp.doc('expenses', 'e2', '', '2025-07-08', 'nonbillable', 'VZ1', 'R2502 Mehta', '', 300, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-RENT', 300, 0)))),
  ('expenses', 'e3', pg_temp.doc('expenses', 'e3', '', '2025-07-01', 'nonbillable', 'VZ1', 'R2502 Mehta', '07AAACM2502A1Z5', 500, 90, 0, 0, jsonb_build_array(pg_temp.ln('A-RENT', 500, 90)))),
  ('vendorpayments', 'p6', jsonb_build_object('kind', 'vendorpayments', 'zohoId', 'p6', 'number', '6', 'date', '2025-07-10', 'status', '', 'amount', 500, 'unapplied', 0, 'mode', 'NEFT',
     'paidThrough', 'HDFC 4523', 'vendorName', 'R2502 Mehta', 'applied', jsonb_build_array(jsonb_build_object('billZohoId', 'b14', 'billNumber', 'TP-1', 'amount', 500)), 'problems', '[]'::jsonb)),
  ('vendorpayments', 'p7', jsonb_build_object('kind', 'vendorpayments', 'zohoId', 'p7', 'number', '7', 'date', '2025-07-20', 'status', '', 'amount', 580, 'unapplied', 0, 'mode', 'NEFT',
     'paidThrough', 'HDFC 4523', 'vendorName', 'R2502 Mehta', 'applied', jsonb_build_array(jsonb_build_object('billZohoId', 'b14', 'billNumber', 'TP-1', 'amount', 580)), 'problems', '[]'::jsonb)),
  ('vendorpayments', 'p4', jsonb_build_object('kind', 'vendorpayments', 'zohoId', 'p4', 'number', '4', 'date', '2025-06-13', 'status', '', 'amount', 50, 'unapplied', 50, 'mode', 'UPI',
     'paidThrough', 'HDFC 4523', 'vendorName', 'R2502 Mehta', 'applied', '[]'::jsonb, 'problems', '[]'::jsonb))
) as x(kind, zid, p);
-- The other company's scan row: never readable from T.
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2502000-0000-0000-0000-0000000000f1', 'bills', '2025-26', 'bo', 'O-1', '2025-05-10', 'open',
   pg_temp.doc('bills', 'bo', 'O-1', '2025-05-10', 'open', 'VZO', 'X', '', 100, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-SW', 100, 0))), now());

do $$
begin
  if to_regprocedure('public.import_zoho_fy_purchases(text,text,jsonb,boolean)') is null
     or to_regprocedure('public.import_zoho_fy_vendor_payments(text,jsonb,boolean)') is null
     or to_regprocedure('public.remove_zoho_fy_purchase_import(uuid,text)') is null
     or to_regprocedure('public.save_zoho_account_categories(jsonb)') is null then
    raise exception 'FAIL 0: the R-2502 functions do not exist';
  end if;
  if has_function_privilege('anon', 'public.import_zoho_fy_purchases(text,text,jsonb,boolean)', 'execute')
     or has_function_privilege('anon', 'public.import_zoho_fy_vendor_payments(text,jsonb,boolean)', 'execute')
     or has_function_privilege('anon', 'public.remove_zoho_fy_purchase_import(uuid,text)', 'execute')
     or has_function_privilege('anon', 'public.save_zoho_account_categories(jsonb)', 'execute') then
    raise exception 'FAIL 0: anon can execute an R-2502 function';
  end if;
  if has_table_privilege('authenticated', 'public.zoho_account_category_map', 'insert')
     or has_table_privilege('authenticated', 'public.zoho_vendor_payment_links', 'insert') then
    raise exception 'FAIL 0: a login can write the map / links directly';
  end if;
end $$;

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.bill_picks() returns jsonb language sql as $f$
  select jsonb_build_array(
    jsonb_build_object('zoho_id', 'b1', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b2', 'vendor_id', null),
    jsonb_build_object('zoho_id', 'b3', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b4', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b5', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b6', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b7', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b8', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b9', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b10', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b11', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'b12', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d2'),
    jsonb_build_object('zoho_id', 'b13', 'vendor_id', 'not-a-uuid'),
    jsonb_build_object('zoho_id', 'bo', 'vendor_id', null),
    jsonb_build_object('zoho_id', 'b1x', 'vendor_id', 'b2502000-0000-0000-0000-0000000000d9'));
$f$;

create function pg_temp.refused(p_who uuid, p_code text, p_msg text) returns boolean language plpgsql as $f$
begin
  perform pg_temp.as_user(p_who);
  perform public.import_zoho_fy_purchases('bills', '2025-26', pg_temp.bill_picks(), true);
  return false;
exception when others then
  if sqlstate = p_code and sqlerrm like p_msg then return true; end if;
  raise exception 'wrong refusal: % %', sqlstate, sqlerrm;
end $f$;

grant execute on function pg_temp.as_user(uuid), pg_temp.bill_picks(), pg_temp.refused(uuid, text, text) to authenticated;
set local role authenticated;

do $$
declare
  r jsonb; reasons text; n int; v_batch uuid; v_pay uuid; e public.expenses; b public.vendor_bills; v public.vendors;
begin
  -- 1. Roles.
  if not pg_temp.refused('b2502000-0000-0000-0000-0000000000a3', '42501', '%owner or an accountant%') then raise exception 'FAIL 1: manager imported'; end if;
  if not pg_temp.refused('b2502000-0000-0000-0000-0000000000a4', '28000', '%sign-in%') then raise exception 'FAIL 1b: no-company login imported'; end if;

  -- 1c. The map: accountant saves it; Salaries refused; a manager cannot.
  perform pg_temp.as_user('b2502000-0000-0000-0000-0000000000a3');
  begin
    perform public.save_zoho_account_categories('[{"zoho_account_id":"A-SW","category":"Software"}]');
    raise exception 'FAIL 1c: manager saved the map';
  exception when sqlstate '42501' then null;
  end;
  perform pg_temp.as_user('b2502000-0000-0000-0000-0000000000a2');
  begin
    perform public.save_zoho_account_categories('[{"zoho_account_id":"A-SW","category":"Salaries"}]');
    raise exception 'FAIL 1d: Salaries accepted';
  exception when sqlstate '22023' then null;
  end;
  r := public.save_zoho_account_categories('[{"zoho_account_id":"A-SW","zoho_account_name":"Software","category":"Software"},
    {"zoho_account_id":"A-WEL","category":"Staff Welfare"},{"zoho_account_id":"A-COGS","category":"COGS-Workspace"},
    {"zoho_account_id":"A-RENT","category":"Office Rent"}]');
  if (r->>'saved')::int <> 4 then raise exception 'FAIL 1e: map save %', r; end if;

  -- 2. Dry run (accountant): nothing written, refusals said.
  r := public.import_zoho_fy_purchases('bills', '2025-26', pg_temp.bill_picks(), true);
  select string_agg((s->>'zoho_id') || '=' || (s->>'reason'), ' | ') into reasons from jsonb_array_elements(r->'skipped') s;
  if (r->>'dry_run')::boolean is not true or (r->>'imported')::int <> 6 then raise exception 'FAIL 2: dry run %', r; end if;
  if reasons not like '%b4=Void in Zoho%' then raise exception 'FAIL 2a: void %', reasons; end if;
  if reasons not like '%b5=Draft in Zoho%' then raise exception 'FAIL 2b: draft %', reasons; end if;
  if reasons not like '%b6=Dated 20 Apr 2025, before the books start (01 May 2025)%' then raise exception 'FAIL 2c: books start %', reasons; end if;
  if reasons not like '%b7=It has COGS and expense lines%' then raise exception 'FAIL 2d: mixed %', reasons; end if;
  if reasons not like '%b8=Bill HAND-1 of R2502 Mehta is already in the books (entered by hand)%' then raise exception 'FAIL 2e: by hand %', reasons; end if;
  if reasons not like '%b11=In USD%' then raise exception 'FAIL 2f: problem %', reasons; end if;
  if reasons not like '%bo=Not read from Zoho yet%' then raise exception 'FAIL 2g: other company scan read %', reasons; end if;
  if reasons not like '%b13=Not read from Zoho yet%' then raise exception 'FAIL 2h2: %', reasons; end if;
  if reasons not like '%b1x=Not read from Zoho yet%' then raise exception 'FAIL 2h: unknown id %', reasons; end if;
  if exists (select 1 from public.expenses where tenant_id = 'b2502000-0000-0000-0000-0000000000f0' and zoho_doc_id is not null)
     or exists (select 1 from public.vendor_bills where tenant_id = 'b2502000-0000-0000-0000-0000000000f0')
     or exists (select 1 from public.vendors where name = 'R2502 NewCo')
     or exists (select 1 from public.zoho_fy_import_batches where tenant_id = 'b2502000-0000-0000-0000-0000000000f0') then
    raise exception 'FAIL 2i: the dry run wrote something';
  end if;

  -- 2j. Books lock refuses.
  reset role;
  update public.tenants set books_locked_until = '2025-05-31' where id = 'b2502000-0000-0000-0000-0000000000f0';
  set local role authenticated;
  r := public.import_zoho_fy_purchases('bills', '2025-26', '[{"zoho_id":"b1"}]', true);
  if r->'skipped'->0->>'reason' not like '%inside the books lock (till 31 May 2025)%' then raise exception 'FAIL 2j: lock %', r; end if;
  reset role;
  update public.tenants set books_locked_until = null where id = 'b2502000-0000-0000-0000-0000000000f0';
  set local role authenticated;

  -- 3. Import for real (owner).
  perform pg_temp.as_user('b2502000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_purchases('bills', '2025-26', pg_temp.bill_picks(), false);
  v_batch := (r->>'batch_id')::uuid;
  if (r->>'imported')::int <> 6 or v_batch is null or (r->>'new_vendors')::int <> 1 then raise exception 'FAIL 3: import %', r; end if;

  -- 3a. b1: one Software row, heads kept, TDS 194J, unpaid bill.
  select * into e from public.expenses where zoho_doc_id = 'bills:b1';
  if e.category <> 'Software' or e.amount <> 1180 or e.gst_paid <> 180 or e.cgst <> 90 or e.sgst <> 90 or e.igst <> 0
     or e.tds_section <> '194J' or e.tds_amount <> 100 or e.paid or e.bill_no <> 'VB-1' or e.bill_type <> 'gst'
     or e.vendor_id <> 'b2502000-0000-0000-0000-0000000000d1' or e.zoho_leg <> 1 or e.purchase_import_batch_id <> v_batch then
    raise exception 'FAIL 3a: b1 stored wrong %', to_jsonb(e);
  end if;
  -- 3b. b2: two legs; the ineligible GST stays in Staff Welfare's cost; no heads; new vendor from Zoho.
  select * into e from public.expenses where zoho_doc_id = 'bills:b2' and zoho_leg = 2;
  if e.category <> 'Staff Welfare' or e.amount <> 590 or e.gst_paid <> 0 or e.igst <> 0 or e.notes not like '%not claimable%' or e.bill_type <> 'none' then
    raise exception 'FAIL 3b: b2 leg 2 %', to_jsonb(e);
  end if;
  select * into e from public.expenses where zoho_doc_id = 'bills:b2' and zoho_leg = 1;
  if e.category <> 'Software' or e.amount <> 590 or e.gst_paid <> 90 or e.igst <> 90 or e.cgst <> 0 then raise exception 'FAIL 3c: b2 leg 1 %', to_jsonb(e); end if;
  select * into v from public.vendors where tenant_id = 'b2502000-0000-0000-0000-0000000000f0' and name = 'R2502 NewCo';
  if v.zoho_contact_id <> 'VZ9' or e.vendor_id <> v.id then raise exception 'FAIL 3d: vendor not created from Zoho %', to_jsonb(v); end if;
  -- 3d2. A hand vendor without GSTIN gets Zoho's (the ITC rule reads the vendor master).
  if (select gstin from public.vendors where id = 'b2502000-0000-0000-0000-0000000000d2') is distinct from '07AAACN2502A1Z5' then raise exception 'FAIL 3d2: GSTIN not copied'; end if;
  -- 3e. b3: a COGS bill, unpaid; its Zoho TDS in real fields (R-2502c), not in notes.
  select * into b from public.vendor_bills where zoho_doc_id = 'bills:b3';
  if b.category <> 'COGS-Workspace' or b.subtotal <> 2000 or b.igst <> 360 or b.total <> 2360 or b.status <> 'unpaid'
     or b.document_type <> 'tax_invoice' or b.bill_no <> 'C-1' or b.zoho_tds_amount <> 200 or b.zoho_tds_section <> '194C' or b.notes like '%TDS%' then
    raise exception 'FAIL 3e: b3 %', to_jsonb(b);
  end if;
  -- 3f. b9: unmapped → Unmapped — review. b10: RCM.
  if (select category from public.expenses where zoho_doc_id = 'bills:b9') <> 'Unmapped — review' then raise exception 'FAIL 3f: unmapped'; end if;
  select * into e from public.expenses where zoho_doc_id = 'bills:b10';
  if not e.rcm or e.rcm_tax <> 180 or e.amount <> 1000 or e.gst_paid <> 0 then raise exception 'FAIL 3g: rcm %', to_jsonb(e); end if;
  -- 3h. Batch row + one activity row.
  if (select count(*) from public.zoho_fy_import_batches where id = v_batch and kind = 'bills' and imported_count = 6) <> 1 then raise exception 'FAIL 3h: batch row'; end if;
  select count(*) into n from public.activity_log where action = 'zoho_fy_purchases.imported' and entity_id = v_batch::text;
  if n <> 1 then raise exception 'FAIL 3i: % activity rows', n; end if;

  -- 3j. Expenses kind: paid from the mapped app account (bank: no line yet — Reconcile banks it), Office Rent, IGST head.
  --     R-2502c: with no account it is not imported (never a blank method).
  r := public.import_zoho_fy_purchases('expenses', '2025-26', '[{"zoho_id":"e1","vendor_id":"b2502000-0000-0000-0000-0000000000d1"}]', true);
  if coalesce(r->'skipped'->0->>'reason', '') not like 'Choose the app account for Zoho''s "HDFC 4523"%' then raise exception 'FAIL 3j0: no account accepted %', r; end if;
  r := public.import_zoho_fy_purchases('expenses', '2025-26', '[{"zoho_id":"e1","vendor_id":"b2502000-0000-0000-0000-0000000000d1","account_id":"b2502000-0000-0000-0000-0000000000e1"}]', false);
  select * into e from public.expenses where zoho_doc_id = 'expenses:e1';
  if (r->>'imported')::int <> 1 or e.category <> 'Office Rent' or not e.paid or e.paid_date <> '2025-05-20' or e.amount <> 590 or e.igst <> 90 or e.due_date is not null
     or e.payment_method <> 'bank' or e.bank_account_id <> 'b2502000-0000-0000-0000-0000000000e1' or e.reconciled_txn_id is not null then
    raise exception 'FAIL 3j: expense % %', r, to_jsonb(e);
  end if;

  -- 3k. Only the import writes the Zoho id / batch (tg_purchases_zoho_doc_guard) — as the table owner, so RLS hides nothing.
  reset role;
  begin
    update public.expenses set zoho_doc_id = 'bills:b1', zoho_leg = 9, purchase_import_batch_id = v_batch where id = 'EXP-R2502-HAND';
    raise exception 'FAIL 3k: a hand entry was tagged into a batch';
  exception when sqlstate '23514' then null;
  end;
  begin
    update public.vendor_bills set zoho_doc_id = null, purchase_import_batch_id = null where zoho_doc_id = 'bills:b3';
    raise exception 'FAIL 3l: an imported bill was untagged';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.expenses (id, tenant_id, category, expense_date, amount, zoho_doc_id, zoho_leg, purchase_import_batch_id)
    values ('EXP-R2502-FAKE', 'b2502000-0000-0000-0000-0000000000f0', 'Software', '2025-06-01', 1, 'bills:fake', 1, v_batch);
    raise exception 'FAIL 3m: a Zoho-tagged expense inserted outside the import';
  exception when sqlstate '23514' then null;
  end;
  set local role authenticated;

  -- 4. Rerun = already; no second row.
  r := public.import_zoho_fy_purchases('bills', '2025-26', pg_temp.bill_picks(), false);
  if (r->>'imported')::int <> 0 or (r->>'already')::int <> 6 then raise exception 'FAIL 4: rerun %', r; end if;
  if (select count(*) from public.vendors where tenant_id = 'b2502000-0000-0000-0000-0000000000f0' and name = 'R2502 NewCo') <> 1 then raise exception 'FAIL 4b: vendor made twice'; end if;

  -- 5. Vendor payments (R-2502b): NO manual bank line. A COGS bill's payment is reported for
  --    Reconcile, never booked; an expense bill is marked paid (no bank line).
  r := public.import_zoho_fy_vendor_payments('2025-26',
    '[{"zoho_id":"p1","account_id":"b2502000-0000-0000-0000-0000000000e1"},{"zoho_id":"p2","account_id":"b2502000-0000-0000-0000-0000000000e1"},{"zoho_id":"p3","account_id":"b2502000-0000-0000-0000-0000000000e1"},{"zoho_id":"p4"},{"zoho_id":"p5","account_id":"b2502000-0000-0000-0000-0000000000e1"}]', false);
  v_pay := (r->>'batch_id')::uuid;
  if (r->>'imported')::int <> 1 or (r->'advances'->0->>'amount')::int <> 500
     or r->'skipped'->0->>'reason' not like '%advance%' then
    raise exception 'FAIL 5a: payments %', r;
  end if;
  -- 5a2. Listed for Reconcile: both COGS payments (the bill's Zoho TDS once, with the first) and b2's part payment.
  if jsonb_array_length(r->'to_reconcile') <> 3
     or r->'to_reconcile'->0->>'why' <> 'cogs' or (r->'to_reconcile'->0->>'amount')::int <> 1000 or (r->'to_reconcile'->0->>'tds')::int <> 200 or r->'to_reconcile'->0->>'tds_section' <> '194C'
     or (r->'to_reconcile'->1->>'why') <> 'parts' or (r->'to_reconcile'->1->>'amount')::int <> 300
     or (r->'to_reconcile'->2->>'amount')::int <> 1160 or (r->'to_reconcile'->2->>'tds')::int <> 0 then
    raise exception 'FAIL 5a2: to_reconcile %', r->'to_reconcile';
  end if;
  -- 5a3. Reconcile's open COGS-bill item pre-fills the bill's Zoho TDS (R-2502c).
  if not exists (select 1 from public.bank_debit_vendor_open_items('b2502000-0000-0000-0000-0000000000d1') o
                  where o.source = 'vendor_bill' and o.bill_no = 'C-1' and o.tds_amount = 200 and o.tds_section = '194C') then
    raise exception 'FAIL 5a3: open item has no TDS';
  end if;
  -- 5b. b1 paid: 1080 + TDS 100 = 1180 — and no bank line made for it.
  select * into e from public.expenses where zoho_doc_id = 'bills:b1';
  if not e.paid or e.paid_date <> '2025-06-10' or e.reconciled_txn_id is not null or e.payment_method <> 'bank' then raise exception 'FAIL 5b: b1 not paid %', to_jsonb(e); end if;
  -- 5c. b2 part paid → still unpaid.
  if exists (select 1 from public.expenses where zoho_doc_id = 'bills:b2' and paid) then raise exception 'FAIL 5c: part payment marked paid'; end if;
  -- 5d. b3 (COGS) untouched: unpaid, and NO bank line anywhere for this company.
  select * into b from public.vendor_bills where zoho_doc_id = 'bills:b3';
  if b.paid_amount <> 0 or b.status <> 'unpaid' then raise exception 'FAIL 5d: b3 booked %', to_jsonb(b); end if;
  if exists (select 1 from public.bank_transactions t where t.tenant_id = 'b2502000-0000-0000-0000-0000000000f0' and t.bank_account_id = 'b2502000-0000-0000-0000-0000000000e1') then
    raise exception 'FAIL 5e: the import made a bank line';
  end if;
  -- 5f. Rerun payments = already.
  r := public.import_zoho_fy_vendor_payments('2025-26', '[{"zoho_id":"p1"}]', false);
  if (r->>'already')::int <> 1 then raise exception 'FAIL 5f: payment rerun %', r; end if;

  -- 6. Bills batch cannot be removed while its bills are paid; payments batch can; then bills batch can.
  begin
    perform public.remove_zoho_fy_purchase_import(v_batch, 'test undo');
    raise exception 'FAIL 6: removed a paid batch';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%already has a payment%' then raise; end if;
  end;
  r := public.remove_zoho_fy_purchase_import(v_pay, 'test undo payments');
  if (r->>'removed')::int <> 1 then raise exception 'FAIL 6a: payments undo %', r; end if;
  if exists (select 1 from public.expenses where zoho_doc_id = 'bills:b1' and paid) then raise exception 'FAIL 6b: b1 still paid'; end if;
  r := public.remove_zoho_fy_purchase_import(v_batch, 'test undo bills');
  if (r->>'removed')::int <> 7 then raise exception 'FAIL 6d: bills undo %', r; end if;
  if exists (select 1 from public.expenses where purchase_import_batch_id = v_batch) then raise exception 'FAIL 6e: rows left'; end if;
  if (select removed_at from public.zoho_fy_import_batches where id = v_batch) is null then raise exception 'FAIL 6f: batch not marked'; end if;
  if (select count(*) from public.activity_log where action = 'zoho_fy_purchases.import_removed') <> 2 then raise exception 'FAIL 6g: undo not logged'; end if;
  -- 6h. R-2502c: the vendor fields the import set are put back — the vendor it made is gone, the GSTIN / Zoho id it filled are empty again.
  if exists (select 1 from public.vendors where tenant_id = 'b2502000-0000-0000-0000-0000000000f0' and name = 'R2502 NewCo') then raise exception 'FAIL 6h: made vendor left'; end if;
  if (select gstin from public.vendors where id = 'b2502000-0000-0000-0000-0000000000d2') is not null then raise exception 'FAIL 6i: filled GSTIN left'; end if;
  if (select zoho_contact_id from public.vendors where id = 'b2502000-0000-0000-0000-0000000000d1') is not null then raise exception 'FAIL 6j: filled Zoho id left'; end if;

  -- 7. Import again, then the FY 4523 statement arrives: Reconcile banks the imported payment on the
  --    real debit (expense bill: recorded payment; COGS bill: paid on the debit with its Zoho TDS) —
  --    the cash is counted ONCE (one bank line each, nothing left "paid outside the bank").
  r := public.import_zoho_fy_purchases('bills', '2025-26', pg_temp.bill_picks(), false);
  r := public.import_zoho_fy_vendor_payments('2025-26', '[{"zoho_id":"p1","account_id":"b2502000-0000-0000-0000-0000000000e1"},{"zoho_id":"p2"}]', false);
  v_pay := (r->>'batch_id')::uuid;
  reset role;
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source)
  values ('b2502000-0000-0000-0000-00000000aa01', 'b2502000-0000-0000-0000-0000000000f0', 'b2502000-0000-0000-0000-0000000000e1', '2025-06-10', 'NEFT R2502 MEHTA VB-1', 1080, 0, 'csv_upload'),
         ('b2502000-0000-0000-0000-00000000aa02', 'b2502000-0000-0000-0000-0000000000f0', 'b2502000-0000-0000-0000-0000000000e1', '2025-06-11', 'NEFT R2502 MEHTA C-1', 1000, 0, 'csv_upload');
  set local role authenticated;
  select * into e from public.expenses where zoho_doc_id = 'bills:b1';
  perform public.reconcile_bank_debit_to_vendor('b2502000-0000-0000-0000-00000000aa01'::uuid, 'b2502000-0000-0000-0000-0000000000d1'::uuid, null,
    jsonb_build_array(jsonb_build_object('source', 'recorded_payment', 'doc_id', e.id, 'amount', 1080)));
  select * into b from public.vendor_bills where zoho_doc_id = 'bills:b3';
  perform public.reconcile_bank_debit_to_vendor('b2502000-0000-0000-0000-00000000aa02'::uuid, 'b2502000-0000-0000-0000-0000000000d1'::uuid, null,
    jsonb_build_array(jsonb_build_object('source', 'vendor_bill', 'doc_id', b.id, 'amount', 1200, 'tds_amount', 200, 'tds_section', '194C')));
  select * into e from public.expenses where zoho_doc_id = 'bills:b1';
  if e.reconciled_txn_id <> 'b2502000-0000-0000-0000-00000000aa01' or not e.paid then raise exception 'FAIL 7a: b1 not banked %', to_jsonb(e); end if;
  select * into b from public.vendor_bills where zoho_doc_id = 'bills:b3';
  if b.paid_amount <> 1200 or b.status <> 'partial' then raise exception 'FAIL 7b: b3 %', to_jsonb(b); end if;
  reset role;
  -- Cash once: only the two statement lines, no manual line; the TDS on the statement line.
  if (select count(*) from public.bank_transactions where tenant_id = 'b2502000-0000-0000-0000-0000000000f0') <> 2
     or (select sum(debit) from public.bank_transactions where tenant_id = 'b2502000-0000-0000-0000-0000000000f0') <> 2080
     or exists (select 1 from public.bank_transactions where tenant_id = 'b2502000-0000-0000-0000-0000000000f0' and source = 'manual') then
    raise exception 'FAIL 7c: cash counted twice / manual line';
  end if;
  if (select count(*) from public.bank_vendor_payment_lines l where l.bank_txn_id = 'b2502000-0000-0000-0000-00000000aa02'
        and l.vendor_bill_id = b.id and l.cash = 1000 and l.tds_amount = 200) <> 1 then
    raise exception 'FAIL 7d: COGS payment line wrong';
  end if;
  -- b1 is no longer "paid outside the bank" (the balance sheet's unbanked bucket reads exactly this).
  if exists (select 1 from public.expenses x where x.zoho_doc_id = 'bills:b1' and x.paid and x.reconciled_txn_id is null) then
    raise exception 'FAIL 7e: b1 still unbanked';
  end if;
  set local role authenticated;
  -- 7f. Now banked, the payments import cannot be taken back without un-reconciling first.
  begin
    perform public.remove_zoho_fy_purchase_import(v_pay, 'test undo after reconcile');
    raise exception 'FAIL 7f: undo after reconcile';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%matched to a bank line%' then raise; end if;
  end;

  -- 8. Independent-review fixes (R-2502c).
  -- 8a. The map takes only the whitelist (no special category, no free COGS-*, not "salaries").
  perform pg_temp.as_user('b2502000-0000-0000-0000-0000000000a1');
  begin
    perform public.save_zoho_account_categories('[{"zoho_account_id":"A-X","category":"Employee advance"}]');
    raise exception 'FAIL 8a: special category accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_zoho_account_categories('[{"zoho_account_id":"A-X","category":"COGS-Anything"}]');
    raise exception 'FAIL 8a2: free COGS-* accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_zoho_account_categories('[{"zoho_account_id":"A-X","category":"salaries"}]');
    raise exception 'FAIL 8a3: salaries accepted';
  exception when sqlstate '22023' then null;
  end;
  perform public.save_zoho_account_categories('[{"zoho_account_id":"A-INT","category":"Internet & Phone"}]');

  -- 8b. A bill from "R2502 Mehta" with ANOTHER GSTIN (KA): a picked Mehta is refused; unpicked → its own new vendor;
  --     Mehta's Zoho id is never overwritten.
  r := public.import_zoho_fy_purchases('bills', '2025-26', '[{"zoho_id":"b15","vendor_id":"b2502000-0000-0000-0000-0000000000d1"}]', true);
  if coalesce(r->'skipped'->0->>'reason', '') not like '%has GSTIN 07AAACM2502A1Z5 in the app%' then raise exception 'FAIL 8b: other-GSTIN pick accepted %', r; end if;
  r := public.import_zoho_fy_purchases('bills', '2025-26',
    '[{"zoho_id":"b14","vendor_id":"b2502000-0000-0000-0000-0000000000d1"},{"zoho_id":"b15"},{"zoho_id":"b16","vendor_id":"b2502000-0000-0000-0000-0000000000d1"}]', false);
  v_batch := (r->>'batch_id')::uuid;
  if (r->>'imported')::int <> 3 then raise exception 'FAIL 8b2: %', r; end if;
  select * into v from public.vendors where id = (select vendor_id from public.expenses where zoho_doc_id = 'bills:b15');
  if v.id = 'b2502000-0000-0000-0000-0000000000d1' or v.gstin <> '29AAACM2502A1Z5' or v.zoho_contact_id <> 'VZ15' then raise exception 'FAIL 8b3: KA bill on % ', to_jsonb(v); end if;
  if (select zoho_contact_id from public.vendors where id = 'b2502000-0000-0000-0000-0000000000d1') <> 'VZ1' then raise exception 'FAIL 8b4: Mehta''s Zoho id overwritten'; end if;

  -- 8c. 26Q: TDS of a two-category bill spread by taxable (600 / 400 → 60 / 40), not all on the first row.
  if (select string_agg(x.category || '=' || x.tds_amount || ':' || coalesce(x.tds_section, '-'), ',' order by x.zoho_leg) from public.expenses x where x.zoho_doc_id = 'bills:b16')
     <> 'Software=60:194JB,Internet & Phone=40:194JB' then
    raise exception 'FAIL 8c: TDS rows %', (select jsonb_agg(to_jsonb(x)) from public.expenses x where x.zoho_doc_id = 'bills:b16');
  end if;

  -- 8d. Duplicate check with no number: e3 (Mehta, 1 Jul, ₹590) ≈ the hand entry of 2 Jul ₹590 → refused.
  r := public.import_zoho_fy_purchases('expenses', '2025-26',
    '[{"zoho_id":"e3","vendor_id":"b2502000-0000-0000-0000-0000000000d1","account_id":"b2502000-0000-0000-0000-0000000000e1"},
      {"zoho_id":"e2","vendor_id":"b2502000-0000-0000-0000-0000000000d1","account_id":"b2502000-0000-0000-0000-0000000000e2"}]', false);
  if coalesce(r->'skipped'->0->>'reason', '') not like 'Looks already in the books (not from Zoho)%' or (r->>'imported')::int <> 1 then raise exception 'FAIL 8d: dup %', r; end if;
  -- 8e. Paid from petty cash: payment method cash + its petty-cash line (the line IS the reconciliation).
  select * into e from public.expenses where zoho_doc_id = 'expenses:e2';
  if e.payment_method <> 'cash' or e.reconciled_txn_id is null
     or not exists (select 1 from public.bank_transactions t where t.id = e.reconciled_txn_id and t.bank_account_id = 'b2502000-0000-0000-0000-0000000000e2' and t.debit = 300) then
    raise exception 'FAIL 8e: petty cash %', to_jsonb(e);
  end if;

  -- 8f. An expense bill Zoho paid in TWO payments: never marked paid; both listed (TDS with the first);
  --     then each 4523 debit pays its part in Reconcile (R-1915) — the cash counted once.
  r := public.import_zoho_fy_vendor_payments('2025-26', '[{"zoho_id":"p6","account_id":"b2502000-0000-0000-0000-0000000000e1"},{"zoho_id":"p7","account_id":"b2502000-0000-0000-0000-0000000000e1"}]', false);
  if (r->>'imported')::int <> 0 or jsonb_array_length(r->'to_reconcile') <> 2
     or (r->'to_reconcile'->0->>'tds')::int <> 100 or (r->'to_reconcile'->1->>'tds')::int <> 0 then
    raise exception 'FAIL 8f: %', r;
  end if;
  if exists (select 1 from public.expenses where zoho_doc_id = 'bills:b14' and paid) then raise exception 'FAIL 8f2: marked paid'; end if;
  reset role;
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source)
  values ('b2502000-0000-0000-0000-00000000aa03', 'b2502000-0000-0000-0000-0000000000f0', 'b2502000-0000-0000-0000-0000000000e1', '2025-07-10', 'NEFT R2502 MEHTA TP-1 a', 500, 0, 'csv_upload'),
         ('b2502000-0000-0000-0000-00000000aa04', 'b2502000-0000-0000-0000-0000000000f0', 'b2502000-0000-0000-0000-0000000000e1', '2025-07-20', 'NEFT R2502 MEHTA TP-1 b', 580, 0, 'csv_upload');
  set local role authenticated;
  select * into e from public.expenses where zoho_doc_id = 'bills:b14';
  perform public.reconcile_bank_debit_to_vendor('b2502000-0000-0000-0000-00000000aa03'::uuid, 'b2502000-0000-0000-0000-0000000000d1'::uuid, null,
    jsonb_build_array(jsonb_build_object('source', 'expense', 'doc_id', e.id, 'amount', 600, 'tds_amount', 100, 'tds_section', '194JB')));
  perform public.reconcile_bank_debit_to_vendor('b2502000-0000-0000-0000-00000000aa04'::uuid, 'b2502000-0000-0000-0000-0000000000d1'::uuid, null,
    jsonb_build_array(jsonb_build_object('source', 'expense', 'doc_id', e.id, 'amount', 580)));
  select * into e from public.expenses where zoho_doc_id = 'bills:b14';
  reset role;
  if not e.paid or (select count(*) from public.bank_vendor_payment_lines l where l.expense_id = e.id) <> 2
     or (select sum(l.cash) from public.bank_vendor_payment_lines l where l.expense_id = e.id) <> 1080
     or (select sum(l.tds_amount) from public.bank_vendor_payment_lines l where l.expense_id = e.id) <> 100 then
    raise exception 'FAIL 8f3: two parts %', to_jsonb(e);
  end if;
  set local role authenticated;

  -- 8h. Bills Zoho paid in parts and since paid in Reconcile are not listed again (rerun / later preview).
  r := public.import_zoho_fy_vendor_payments('2025-26', '[{"zoho_id":"p6","account_id":"b2502000-0000-0000-0000-0000000000e1"},{"zoho_id":"p7","account_id":"b2502000-0000-0000-0000-0000000000e1"}]', true);
  if jsonb_array_length(r->'to_reconcile') <> 0 then raise exception 'FAIL 8h: paid bill listed again %', r->'to_reconcile'; end if;
  -- 8i. A map row saved before the whitelist (free "COGS-Foo") is treated as unmapped by the import.
  reset role;
  insert into public.zoho_account_category_map (tenant_id, zoho_account_id, category) values ('b2502000-0000-0000-0000-0000000000f0', 'A-OLD', 'COGS-Foo');
  insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
    ('b2502000-0000-0000-0000-0000000000f0', 'bills', '2025-26', 'b17', 'OLD-1', '2025-07-09', 'open',
     pg_temp.doc('bills', 'b17', 'OLD-1', '2025-07-09', 'open', 'VZ1', 'R2502 Mehta', '07AAACM2502A1Z5', 100, 0, 0, 0, jsonb_build_array(pg_temp.ln('A-OLD', 100, 0))), now());
  set local role authenticated;
  r := public.import_zoho_fy_purchases('bills', '2025-26', '[{"zoho_id":"b17","vendor_id":"b2502000-0000-0000-0000-0000000000d1"}]', false);
  if (select category from public.expenses where zoho_doc_id = 'bills:b17') is distinct from 'Unmapped — review'
     or exists (select 1 from public.vendor_bills where zoho_doc_id = 'bills:b17') then
    raise exception 'FAIL 8i: old free category used %', r;
  end if;

  -- 8g. Undo refuses a row edited after the import.
  reset role;
  update public.expenses set category = 'Travel' where zoho_doc_id = 'bills:b15';
  set local role authenticated;
  begin
    perform public.remove_zoho_fy_purchase_import(v_batch, 'test undo edited');
    raise exception 'FAIL 8g: edited row removed';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%was edited after the import%' then raise; end if;
  end;

  raise notice 'R-2502 SQL test: all passed';
end $$;

rollback;
