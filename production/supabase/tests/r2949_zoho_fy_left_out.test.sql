-- R-2949: "Left out by you" — the database refuses to add an FY sale from Zoho that the company's
-- owner left out, even on a DIRECT call to import_zoho_fy_sales (the API route never sends one).
--   L1. Company A leaves out one invoice (its Zoho id) and every number starting with LS. A direct
--       import of all three: only the third comes in; the two are in "skipped" with the reason; no
--       invoice row is written for them. A dry run says the same.
--   L2. The rest of the part is untouched: the imported sale carries the scan's own figures.
--   L3. Company B has the same Zoho ids and numbers and NO rule: all three come in.
--   L4. A signed-in user cannot read or write the list directly (server only).
--   L5. Taken back → the two invoices import, with the scan's own figures.
--   L6. The table refuses a prefix that is not upper case / trimmed / 2–20 characters.
-- Self-asserting; the whole file rolls back. Red without 20261120080830_r2949_zoho_fy_left_out.sql.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b2949000-0000-0000-0000-0000000000a1', 'r2949-owner-a@example.test'),
  ('b2949000-0000-0000-0000-0000000000b1', 'r2949-owner-b@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2949000-0000-0000-0000-0000000000fa', 'R2949 A', 'r2949a@example.test', '07', '07AAACR2949A1Z5', 'R2949A'),
  ('b2949000-0000-0000-0000-0000000000fb', 'R2949 B', 'r2949b@example.test', '07', '07AAACR2949B1Z5', 'R2949B');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2949000-0000-0000-0000-0000000000a1', 'b2949000-0000-0000-0000-0000000000fa', 'r2949-owner-a@example.test', 'Owner A', 'owner', true),
  ('b2949000-0000-0000-0000-0000000000b1', 'b2949000-0000-0000-0000-0000000000fb', 'r2949-owner-b@example.test', 'Owner B', 'owner', true);
update public.tenants set books_start_date = '2025-04-01'
 where id in ('b2949000-0000-0000-0000-0000000000fa', 'b2949000-0000-0000-0000-0000000000fb');
insert into public.customers (id, tenant_id, name, gstin, state_code, state, country, address, city, pin_code) values
  ('b2949000-0000-0000-0000-0000000000ca', 'b2949000-0000-0000-0000-0000000000fa', 'R2949 Buyer', '07AAFCV5915P1ZP', '07', 'Delhi', 'India', 'Shop 1', 'New Delhi', '110005'),
  ('b2949000-0000-0000-0000-0000000000cb', 'b2949000-0000-0000-0000-0000000000fb', 'R2949 Buyer', '07AAFCV5915P1ZP', '07', 'Delhi', 'India', 'Shop 1', 'New Delhi', '110005');

-- The scan as normalise.ts stores it: the SAME Zoho ids in both companies (the scan is per company).
create function pg_temp.sale(num text, taxable int, tax int) returns jsonb language sql as $f$
  select jsonb_build_object('number', num, 'date', '2025-08-12', 'dueDate', '2025-08-27', 'status', 'paid',
    'customerName', 'R2949 Buyer', 'gstin', '07AAFCV5915P1ZP', 'posStateCode', '07', 'head', 'cgst_sgst', 'currency', 'INR',
    'taxable', taxable, 'tax', tax, 'amount', taxable + tax, 'roundOff', 0, 'adjustment', 0, 'tds', 0, 'taxRate', 18,
    'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', taxable, 'taxable', taxable, 'taxPercent', 18)));
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select t.id, 'invoices', '2025-26', x.zid, t.tag || x.num, date '2025-08-12', 'paid', pg_temp.sale(t.tag || x.num, x.taxable, x.tax), now()
  from (values ('b2949000-0000-0000-0000-0000000000fa'::uuid, ''), ('b2949000-0000-0000-0000-0000000000fb'::uuid, '')) as t(id, tag)
 cross join (values
    ('k1', 'INV/25-26/R2949-01',   1000,  180),
    ('k2', 'INV/25-26/R2949-02',  20000, 3600),
    ('k3', 'LSINV/25-26/R2949-03', 1346,  242)
  ) as x(zid, num, taxable, tax);
-- Company B's numbers differ only by a suffix (invoice ids are app-wide); its LS number still starts with LS.
update public.zoho_fy_scan set number = number || '-B', payload = jsonb_set(payload, '{number}', to_jsonb(number || '-B'))
 where tenant_id = 'b2949000-0000-0000-0000-0000000000fb' and kind = 'invoices';

-- L6: the table's own shape rules.
do $$
begin
  begin
    insert into public.zoho_fy_left_out (tenant_id, kind, rule, value) values ('b2949000-0000-0000-0000-0000000000fa', 'invoices', 'prefix', 'ls');
    raise exception 'R-2949 L6: a lower-case prefix was stored';
  exception when check_violation then null; end;
  begin
    insert into public.zoho_fy_left_out (tenant_id, kind, rule, value) values ('b2949000-0000-0000-0000-0000000000fa', 'invoices', 'prefix', 'L');
    raise exception 'R-2949 L6: a one-character prefix was stored';
  exception when check_violation then null; end;
  begin
    insert into public.zoho_fy_left_out (tenant_id, kind, rule, value) values ('b2949000-0000-0000-0000-0000000000fa', 'invoices', 'prefix', ' LS');
    raise exception 'R-2949 L6: an untrimmed prefix was stored';
  exception when check_violation then null; end;
  begin
    insert into public.zoho_fy_left_out (tenant_id, kind, rule, value) values ('b2949000-0000-0000-0000-0000000000fa', 'invoices', 'other', 'LS');
    raise exception 'R-2949 L6: an unknown rule was stored';
  exception when check_violation then null; end;
end $$;

-- Company A's rules, as the route saves them (admin client).
insert into public.zoho_fy_left_out (tenant_id, kind, rule, value, number, created_by) values
  ('b2949000-0000-0000-0000-0000000000fa', 'invoices', 'doc',    'k2', 'INV/25-26/R2949-02', 'b2949000-0000-0000-0000-0000000000a1'),
  ('b2949000-0000-0000-0000-0000000000fa', 'invoices', 'prefix', 'LS', null,                 'b2949000-0000-0000-0000-0000000000a1');

create function pg_temp.picks(c uuid) returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('zoho_invoice_id', z, 'customer_id', c) order by z) from unnest(array['k1', 'k2', 'k3']) z;
$f$;
grant execute on function pg_temp.picks(uuid) to authenticated;

-- ── Company A's owner, calling the import directly ───────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'b2949000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  t constant uuid := 'b2949000-0000-0000-0000-0000000000fa';
  r jsonb;
  n int;
  inv record;
begin
  -- L1 (dry run): nothing saved, the same two refused.
  r := public.import_zoho_fy_sales('2025-26', pg_temp.picks('b2949000-0000-0000-0000-0000000000ca'), true);
  if (r->>'imported')::int <> 1 or jsonb_array_length(r->'skipped') <> 2 then
    raise exception 'R-2949 L1 dry run: expected 1 imported + 2 refused, got % (skipped %)', r->>'imported', r->'skipped';
  end if;
  select count(*) into n from public.invoices where tenant_id = t and zoho_invoice_id is not null;
  if n <> 0 then raise exception 'R-2949 L1: the dry run saved % invoices', n; end if;

  -- L1 (for real): only k1 comes in.
  r := public.import_zoho_fy_sales('2025-26', pg_temp.picks('b2949000-0000-0000-0000-0000000000ca'), false);
  if (r->>'imported')::int <> 1 then
    raise exception 'R-2949 L1: expected only k1 imported, got % (skipped %)', r->>'imported', r->'skipped';
  end if;
  select count(*) into n from jsonb_array_elements(r->'skipped') s
   where s->>'zoho_invoice_id' in ('k2', 'k3') and s->>'reason' like 'Left out by you%';
  if n <> 2 then raise exception 'R-2949 L1: k2 and k3 must be refused as left out by you, got %', r->'skipped'; end if;
  select count(*) into n from public.invoices where tenant_id = t and zoho_invoice_id in ('k2', 'k3');
  if n <> 0 then raise exception 'R-2949 L1: % left-out invoices were written', n; end if;

  -- L2: the one that came in is exactly the scan's.
  select amount, taxable_value, tax_amount, external_number into inv from public.invoices where tenant_id = t and zoho_invoice_id = 'k1';
  if inv.amount is distinct from 1180 or inv.taxable_value is distinct from 1000 or inv.tax_amount is distinct from 180
     or inv.external_number is distinct from 'INV/25-26/R2949-01' then
    raise exception 'R-2949 L2: k1 came in as % / % / % (%)', inv.amount, inv.taxable_value, inv.tax_amount, inv.external_number;
  end if;

  -- L4: the list is server only.
  begin
    perform 1 from public.zoho_fy_left_out limit 1;
    raise exception 'R-2949 L4: a signed-in user could read the list';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.zoho_fy_left_out where tenant_id = t;
    raise exception 'R-2949 L4: a signed-in user could change the list';
  exception when insufficient_privilege then null; end;
end $$;

-- ── L3: company B — same Zoho ids, an LS number, no rule ─────────────────────────────────────
reset role;
select set_config('request.jwt.claims', json_build_object('sub', 'b2949000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  r jsonb;
  n int;
begin
  r := public.import_zoho_fy_sales('2025-26', pg_temp.picks('b2949000-0000-0000-0000-0000000000cb'), false);
  if (r->>'imported')::int <> 3 then
    raise exception 'R-2949 L3: company B must import all 3, got % (skipped %)', r->>'imported', r->'skipped';
  end if;
  select count(*) into n from public.invoices
   where tenant_id = 'b2949000-0000-0000-0000-0000000000fb' and zoho_invoice_id in ('k1', 'k2', 'k3');
  if n <> 3 then raise exception 'R-2949 L3: company B has % of its 3 sales', n; end if;
end $$;

-- ── L5: company A takes both back (the route's delete) → they import ─────────────────────────
reset role;
delete from public.zoho_fy_left_out where tenant_id = 'b2949000-0000-0000-0000-0000000000fa';
select set_config('request.jwt.claims', json_build_object('sub', 'b2949000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  t constant uuid := 'b2949000-0000-0000-0000-0000000000fa';
  r jsonb;
  inv record;
begin
  r := public.import_zoho_fy_sales('2025-26', pg_temp.picks('b2949000-0000-0000-0000-0000000000ca'), false);
  if (r->>'imported')::int <> 2 or (r->>'already')::int <> 1 then
    raise exception 'R-2949 L5: expected k2 + k3 imported and k1 already, got % / % (skipped %)', r->>'imported', r->>'already', r->'skipped';
  end if;
  select amount, taxable_value, tax_amount into inv from public.invoices where tenant_id = t and zoho_invoice_id = 'k3';
  if inv.amount is distinct from 1588 or inv.taxable_value is distinct from 1346 or inv.tax_amount is distinct from 242 then
    raise exception 'R-2949 L5: k3 came in as % / % / %', inv.amount, inv.taxable_value, inv.tax_amount;
  end if;
  select amount, taxable_value, tax_amount into inv from public.invoices where tenant_id = t and zoho_invoice_id = 'k2';
  if inv.amount is distinct from 23600 or inv.taxable_value is distinct from 20000 or inv.tax_amount is distinct from 3600 then
    raise exception 'R-2949 L5: k2 came in as % / % / %', inv.amount, inv.taxable_value, inv.tax_amount;
  end if;

  raise notice 'R-2949 zoho FY left out by you: all assertions passed';
end $$;

rollback;
