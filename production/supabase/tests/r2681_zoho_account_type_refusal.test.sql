-- R-2681 (17 Nov 2026, paisa, G-RECON N6 / G-FY2526): the Zoho FY purchase import refuses a document
-- whose Zoho account is not an expense by ZOHO'S OWN account type (zoho_account_types, read from Zoho's
-- chart of accounts) — even when the owner mapped it — and, by the owner's decision of 17 Nov, leaves out
-- every document on an unmapped account (no more "Unmapped — review" landing).
--   1. Fixed deposit (other_current_asset) / Output GST (other_current_liability), mapped → refused
--      "Not an expense — needs another path", bill or expense, vendor or not.
--   2. expense / cost_of_goods_sold types import as before (expense row, COGS bill).
--   3. Fail closed: no types read for the company → refused "not read yet" (another company's types do
--      not count); 3b an account missing from the read types → refused with its name; 3c a rerun of an
--      imported document stays "already" even with no types.
--   5. An unmapped account → left out ("not mapped — left out for now"); 6 a salary account → "Payroll".
--   7. One expense line + one loan line → the whole document refused (no part imported).
--   11. Members can read their own company's types only and cannot write them.
-- Self-asserting; the whole file rolls back. Red without the migration (1: FD imports / table missing).
begin;

insert into auth.users (id, email) values
  ('b2681000-0000-0000-0000-0000000000a1', 'r2681-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2681000-0000-0000-0000-0000000000f0', 'R2681 T', 'r2681@example.test', '07', '07AAACR2681A1Z5', 'R2681'),
  ('b2681000-0000-0000-0000-0000000000f9', 'R2681 U', 'r2681u@example.test', '07', '07AAACR2681B1Z5', 'R2681U');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2681000-0000-0000-0000-0000000000a1', 'b2681000-0000-0000-0000-0000000000f0', 'r2681-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-05-01' where id = 'b2681000-0000-0000-0000-0000000000f0';
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type) values
  ('b2681000-0000-0000-0000-0000000000e1', 'b2681000-0000-0000-0000-0000000000f0', 'HDFC 4523', 'HDFC', 'current');

-- Another company has read ITS types — A-FD is an expense THERE. Must never count for R2681 T.
insert into public.zoho_account_types (tenant_id, zoho_account_id, zoho_account_name, account_type) values
  ('b2681000-0000-0000-0000-0000000000f9', 'A-FD', 'FD there', 'expense'),
  ('b2681000-0000-0000-0000-0000000000f9', 'A-RENT', 'Rent there', 'expense');

create function pg_temp.ln(acct text, nm text, taxable int) returns jsonb language sql as $f$
  select jsonb_build_object('accountId', acct, 'accountName', nm, 'description', 'line ' || acct, 'hsn', '', 'qty', 1,
    'taxable', taxable, 'tax', 0, 'itcEligible', true);
$f$;
create function pg_temp.doc(kind text, zid text, d text, taxable int, lines jsonb, vendor text) returns jsonb language sql as $f$
  select jsonb_build_object('kind', kind, 'zohoId', zid, 'number', case when kind = 'bills' then 'B-' || zid else '' end, 'date', d, 'dueDate', d,
    'status', case when kind = 'bills' then 'open' else 'nonbillable' end,
    'vendorZohoId', case when vendor = '' then '' else 'VZ-' || vendor end, 'vendorName', vendor, 'gstin', '', 'gstTreatment', '', 'currency', 'INR',
    'taxable', taxable, 'igst', 0, 'cgst', 0, 'sgst', 0, 'tax', 0, 'total', taxable,
    'rcm', false, 'rcmTax', 0, 'tdsAmount', 0, 'tdsSection', null, 'lines', lines, 'paidThrough', 'HDFC 4523', 'problems', '[]'::jsonb);
$f$;

insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2681000-0000-0000-0000-0000000000f0', x.kind, '2025-26', x.zid, coalesce(x.p->>'number', ''), (x.p->>'date')::date, x.p->>'status', x.p, now()
from (values
  ('expenses', 'e1', pg_temp.doc('expenses', 'e1', '2025-05-20', 500,    jsonb_build_array(pg_temp.ln('A-RENT', 'Rent', 500)), '')),
  ('expenses', 'e2', pg_temp.doc('expenses', 'e2', '2025-05-21', 100000, jsonb_build_array(pg_temp.ln('A-FD', 'Fixed Deposit HDFC', 100000)), '')),
  ('bills',    'b1', pg_temp.doc('bills',    'b1', '2025-05-22', 1000,   jsonb_build_array(pg_temp.ln('A-OGST', 'Output CGST', 1000)), 'R2681 Tax Co')),
  ('bills',    'b2', pg_temp.doc('bills',    'b2', '2025-05-23', 2000,   jsonb_build_array(pg_temp.ln('A-COGS', 'Workspace cost', 2000)), 'R2681 Google')),
  ('expenses', 'e3', pg_temp.doc('expenses', 'e3', '2025-05-24', 1000,   jsonb_build_array(pg_temp.ln('A-RENT', 'Rent', 300), pg_temp.ln('A-LOAN', 'Loan from director', 700)), 'R2681 Mixed')),
  ('expenses', 'e4', pg_temp.doc('expenses', 'e4', '2025-05-25', 400,    jsonb_build_array(pg_temp.ln('A-NEW', 'Made after the read', 400)), 'R2681 New')),
  ('expenses', 'e5', pg_temp.doc('expenses', 'e5', '2025-05-26', 600,    jsonb_build_array(pg_temp.ln('A-UNMAP', 'Misc charges', 600)), 'R2681 Misc')),
  ('expenses', 'e6', pg_temp.doc('expenses', 'e6', '2025-05-27', 15000,  jsonb_build_array(pg_temp.ln('A-SAL', 'Salaries and wages', 15000)), 'Prashant')),
  ('expenses', 'e7', pg_temp.doc('expenses', 'e7', '2025-05-28', 200,    jsonb_build_array(pg_temp.ln('', '', 200)), 'R2681 Blank'))
) as x(kind, zid, p);

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.pick(zid text) returns jsonb language sql as $f$
  select jsonb_build_object('zoho_id', zid, 'vendor_id', null, 'account_id', 'b2681000-0000-0000-0000-0000000000e1');
$f$;
create function pg_temp.reason(r jsonb, zid text) returns text language sql as $f$
  select s->>'reason' from jsonb_array_elements(r->'skipped') s where s->>'zoho_id' = zid or s->>'number' = zid or s->>'number' = 'B-' || zid limit 1;
$f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.pick(text), pg_temp.reason(jsonb, text) to authenticated;
set local role authenticated;

-- 3. No types read for this company yet (only the other company's) → every new document refused.
do $$
declare r jsonb;
begin
  perform pg_temp.as_user('b2681000-0000-0000-0000-0000000000a1');
  r := public.save_zoho_account_categories('[{"zoho_account_id":"A-RENT","zoho_account_name":"Rent","category":"Office Rent"},
    {"zoho_account_id":"A-FD","category":"Rates & Taxes"},{"zoho_account_id":"A-OGST","category":"Rates & Taxes"},
    {"zoho_account_id":"A-COGS","category":"COGS-Workspace"},{"zoho_account_id":"A-LOAN","category":"Other"},
    {"zoho_account_id":"A-NEW","category":"Office Rent"}]');
  if (r->>'saved')::int <> 6 then raise exception 'FAIL 0: map save %', r; end if;
  r := public.import_zoho_fy_purchases('expenses', '2025-26', jsonb_build_array(pg_temp.pick('e1')), true);
  if (r->>'imported')::int <> 0 or jsonb_array_length(r->'skipped') <> 1
     or r->'skipped'->0->>'reason' <> 'Zoho account types are not read yet — press Read from Zoho again, then preview again.' then
    raise exception 'FAIL 3: no types read must refuse: %', r; end if;
  -- 11. members read only their own company's types and cannot write them
  if exists (select 1 from public.zoho_account_types) then raise exception 'FAIL 11: another company''s types are visible'; end if;
  begin
    insert into public.zoho_account_types (tenant_id, zoho_account_id, account_type) values ('b2681000-0000-0000-0000-0000000000f0', 'A-X', 'expense');
    raise exception 'FAIL 11: a member wrote a type';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_zoho_account_types('b2681000-0000-0000-0000-0000000000f0', '[{"zoho_account_id":"A-FD","account_type":"expense"}]');
    raise exception 'FAIL 11: a member ran save_zoho_account_types';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The read: Zoho's chart of accounts for this company (A-NEW is not in it — made in Zoho afterwards).
reset role;
-- (the server's one-statement write; a repeated id is kept once, an empty id / type is skipped, types lower-cased)
do $s$
declare n int;
begin
  n := public.save_zoho_account_types('b2681000-0000-0000-0000-0000000000f0', '[
    {"zoho_account_id":"A-RENT","zoho_account_name":"Rent","account_type":"expense"},
    {"zoho_account_id":"A-FD","zoho_account_name":"Fixed Deposit HDFC","account_type":"other_current_asset"},
    {"zoho_account_id":"A-OGST","zoho_account_name":"Output CGST","account_type":"OTHER_CURRENT_LIABILITY"},
    {"zoho_account_id":"A-COGS","zoho_account_name":"Workspace cost","account_type":"cost_of_goods_sold"},
    {"zoho_account_id":"A-LOAN","zoho_account_name":"Loan from director","account_type":"long_term_liability"},
    {"zoho_account_id":"A-UNMAP","zoho_account_name":"Misc charges","account_type":"other_expense"},
    {"zoho_account_id":"A-SAL","zoho_account_name":"Salaries and wages","account_type":"expense"},
    {"zoho_account_id":"","account_type":"expense"},{"zoho_account_id":"A-X","account_type":""}]');
  if n <> 7 then raise exception 'FAIL 10: saved % types, want 7', n; end if;
  if (select account_type from public.zoho_account_types where tenant_id = 'b2681000-0000-0000-0000-0000000000f0' and zoho_account_id = 'A-OGST') <> 'other_current_liability' then
    raise exception 'FAIL 10: type not lower-cased'; end if;
end $s$;
set local role authenticated;

do $$
declare r jsonb; n int;
begin
  perform pg_temp.as_user('b2681000-0000-0000-0000-0000000000a1');
  if (select count(*) from public.zoho_account_types) <> 7 then raise exception 'FAIL 11: own types not readable'; end if;

  -- 1 + 3b + 5 + 6 + 7 (expenses), real import.
  r := public.import_zoho_fy_purchases('expenses', '2025-26',
    jsonb_build_array(pg_temp.pick('e1'), pg_temp.pick('e2'), pg_temp.pick('e3'), pg_temp.pick('e4'), pg_temp.pick('e5'), pg_temp.pick('e6'), pg_temp.pick('e7')), false);
  if (r->>'imported')::int <> 1 then raise exception 'FAIL 2: only e1 should import: %', r; end if;
  if not exists (select 1 from public.expenses where zoho_doc_id = 'expenses:e1' and category = 'Office Rent' and amount = 500) then
    raise exception 'FAIL 2: e1 row'; end if;
  if pg_temp.reason(r, 'e2') is distinct from 'Not an expense — needs another path: Zoho account "Fixed Deposit HDFC" is a other current asset account in Zoho. Fixed deposits, loans, GST, assets and advances are never booked as an expense.' then
    raise exception 'FAIL 1: FD (mapped) must be refused: %', r; end if;
  if pg_temp.reason(r, 'e3') is distinct from 'Not an expense — needs another path: Zoho account "Loan from director" is a long term liability account in Zoho. Fixed deposits, loans, GST, assets and advances are never booked as an expense.' then
    raise exception 'FAIL 7: mixed rent + loan must be refused whole: %', r; end if;
  if exists (select 1 from public.expenses where zoho_doc_id like 'expenses:e3%') then raise exception 'FAIL 7: part of e3 imported'; end if;
  if pg_temp.reason(r, 'e4') is distinct from 'Zoho''s account type for "Made after the read" is not read yet — press Read from Zoho again, then preview again.' then
    raise exception 'FAIL 3b: account missing from the types: %', r; end if;
  if pg_temp.reason(r, 'e5') is distinct from 'Zoho account "Misc charges" is not mapped — left out for now (owner, 17 Nov). Map it only if it is an expense.' then
    raise exception 'FAIL 5: unmapped must be left out: %', r; end if;
  if pg_temp.reason(r, 'e6') is distinct from 'Zoho account "Salaries and wages" is a salary — Payroll books salaries, so it is not imported from Zoho (owner, 17 Nov).' then
    raise exception 'FAIL 6: salary must be left out: %', r; end if;
  if pg_temp.reason(r, 'e7') is distinct from 'A line has no account in Zoho — add it by hand.' then
    raise exception 'FAIL 3d: a line with no account: %', r; end if;
  if exists (select 1 from public.expenses where category = 'Unmapped — review' and tenant_id = 'b2681000-0000-0000-0000-0000000000f0') then
    raise exception 'FAIL 5: an Unmapped — review row was written'; end if;

  -- 1 + 2 (bills): Output GST refused even though mapped; COGS bill imports.
  r := public.import_zoho_fy_purchases('bills', '2025-26', '[{"zoho_id":"b1","vendor_id":null},{"zoho_id":"b2","vendor_id":null}]', false);
  if (r->>'imported')::int <> 1 or not exists (select 1 from public.vendor_bills where zoho_doc_id = 'bills:b2') then
    raise exception 'FAIL 2: COGS bill b2 should import: %', r; end if;
  if pg_temp.reason(r, 'b1') is distinct from 'Not an expense — needs another path: Zoho account "Output CGST" is a other current liability account in Zoho. Fixed deposits, loans, GST, assets and advances are never booked as an expense.' then
    raise exception 'FAIL 1: Output GST bill must be refused: %', r; end if;
  if exists (select 1 from public.expenses where zoho_doc_id = 'bills:b1') or exists (select 1 from public.vendor_bills where zoho_doc_id = 'bills:b1') then
    raise exception 'FAIL 1: b1 written'; end if;
end $$;

-- 3c. The types are gone again: a rerun of e1 stays "already" (checked before the type rule).
reset role;
delete from public.zoho_account_types where tenant_id = 'b2681000-0000-0000-0000-0000000000f0';
set local role authenticated;
do $$
declare r jsonb;
begin
  perform pg_temp.as_user('b2681000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_purchases('expenses', '2025-26', jsonb_build_array(pg_temp.pick('e1')), true);
  if (r->>'already')::int <> 1 or (r->>'imported')::int <> 0 then raise exception 'FAIL 3c: rerun must be already: %', r; end if;
end $$;

rollback;
