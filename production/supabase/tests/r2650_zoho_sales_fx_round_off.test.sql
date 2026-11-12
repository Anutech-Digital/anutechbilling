-- R-2650: the Zoho FY sales import keeps a foreign-currency invoice's round-off as Zoho filed it.
-- 22 of Zoho's own invoices were refused "Taxable, GST and total do not add up": Zoho allows a
-- round-off up to one unit of the invoice's currency ($1 ≈ ₹85), the import allowed only ₹1.
--   A. USD export with IGST, scan saved BEFORE R-2650 (no roundOff): gap ₹29 → imported; taxable,
--      GST and total stored exactly as the scan has them (never re-computed).
--   A2. The same shape from a new scan (roundOff = the gap) → imported.
--   A3. ₹ invoice with a ₹1.00 adjustment on a total with paise: gap ₹2 → imported.
--   B. ₹ invoice off by ₹5 → refused, with the figures in the reason.
--   B2. USD invoice off by ₹200 at 85.12 (more than $1) → refused.
--   B3. roundOff on the scan that does not match total − taxable − GST → refused.
--   C. Negative GST → refused (unchanged).
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b2650000-0000-0000-0000-0000000000a1', 'r2650-owner@example.test');

insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2650000-0000-0000-0000-0000000000f0', 'R2650 T', 'r2650@example.test', '07', '07AAACR2650A1Z5', 'R2650');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2650000-0000-0000-0000-0000000000a1', 'b2650000-0000-0000-0000-0000000000f0', 'r2650-owner@example.test', 'Owner', 'owner', true);

update public.tenants set books_start_date = '2025-04-01' where id = 'b2650000-0000-0000-0000-0000000000f0';

insert into public.customers (id, tenant_id, name, gstin, state_code, state, country, address, city, pin_code) values
  ('b2650000-0000-0000-0000-0000000000c1', 'b2650000-0000-0000-0000-0000000000f0', 'R2650 US Buyer', null,
   null, null, 'United States', '1 Main St', 'Austin', '78701'),
  ('b2650000-0000-0000-0000-0000000000c2', 'b2650000-0000-0000-0000-0000000000f0', 'R2650 Delhi Buyer', '07AAFCV5915P1ZP',
   '07', 'Delhi', 'India', 'Shop 1', 'New Delhi', '110005');

create function pg_temp.p(num text, cur text, fx numeric, taxable int, tax int, amount int, head text, pos text, trt text, round_off int)
returns jsonb language sql as $f$
  select jsonb_strip_nulls(jsonb_build_object('number', num, 'date', '2025-07-14', 'dueDate', '2025-07-14', 'status', 'paid',
    'customerName', 'R2650 Buyer', 'gstin', '', 'posStateCode', pos, 'head', head, 'currency', cur, 'fxRate', fx,
    'taxable', taxable, 'tax', tax, 'amount', amount, 'roundOff', round_off, 'taxRate', 18, 'appGstTreatment', trt,
    'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', taxable, 'taxable', taxable)))) ;
$f$;

insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  -- $1,457 total, $222.20 IGST, $0.35 round-off at 85.12 (normalise.ts fixture 'USD round-off').
  ('b2650000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2650-a', 'INV/25-26/R2650-A', '2025-07-14', 'paid',
     pg_temp.p('INV/25-26/R2650-A', 'USD', 85.12, 105077, 18914, 124020, 'igst', '96', 'overseas', null), now()),
  ('b2650000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2650-a2', 'INV/25-26/R2650-A2', '2025-07-14', 'paid',
     pg_temp.p('INV/25-26/R2650-A2', 'USD', 85.12, 105076, 18914, 124020, 'igst', '96', 'overseas', 30), now()),
  ('b2650000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2650-a3', 'INV/25-26/R2650-A3', '2025-07-14', 'paid',
     pg_temp.p('INV/25-26/R2650-A3', 'INR', null, 847, 152, 1001, 'cgst_sgst', '07', 'registered_regular', 2), now()),
  ('b2650000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2650-b', 'INV/25-26/R2650-B', '2025-07-14', 'paid',
     pg_temp.p('INV/25-26/R2650-B', 'INR', null, 1000, 180, 1185, 'cgst_sgst', '07', 'registered_regular', null), now()),
  ('b2650000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2650-b2', 'INV/25-26/R2650-B2', '2025-07-14', 'paid',
     pg_temp.p('INV/25-26/R2650-B2', 'USD', 85.12, 104906, 18914, 124020, 'igst', '96', 'overseas', null), now()),
  ('b2650000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2650-b3', 'INV/25-26/R2650-B3', '2025-07-14', 'paid',
     pg_temp.p('INV/25-26/R2650-B3', 'USD', 85.12, 105076, 18914, 124020, 'igst', '96', 'overseas', 0), now()),
  ('b2650000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2650-c', 'INV/25-26/R2650-C', '2025-07-14', 'paid',
     pg_temp.p('INV/25-26/R2650-C', 'INR', null, 1200, -20, 1180, 'cgst_sgst', '07', 'registered_regular', null), now());

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

set local role authenticated;

do $$
declare
  us constant uuid := 'b2650000-0000-0000-0000-0000000000c1';
  dl constant uuid := 'b2650000-0000-0000-0000-0000000000c2';
  r jsonb;
  inv record;
  why text;
begin
  perform pg_temp.as_user('b2650000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_sales('2025-26', jsonb_build_array(
    jsonb_build_object('zoho_invoice_id', 'r2650-a',  'customer_id', us),
    jsonb_build_object('zoho_invoice_id', 'r2650-a2', 'customer_id', us),
    jsonb_build_object('zoho_invoice_id', 'r2650-a3', 'customer_id', dl),
    jsonb_build_object('zoho_invoice_id', 'r2650-b',  'customer_id', dl),
    jsonb_build_object('zoho_invoice_id', 'r2650-b2', 'customer_id', us),
    jsonb_build_object('zoho_invoice_id', 'r2650-b3', 'customer_id', us),
    jsonb_build_object('zoho_invoice_id', 'r2650-c',  'customer_id', dl)), false);

  if (r->>'imported')::int <> 3 then
    raise exception 'R-2650: expected A, A2, A3 imported, got % (skipped %)', r->>'imported', r->'skipped';
  end if;

  -- A: stored exactly as the scan (Zoho) has it — never re-computed.
  select amount, taxable_value, tax_amount, tax_rate, currency, fx_rate, inter_state into inv
    from public.invoices where zoho_invoice_id = 'r2650-a';
  if inv.amount <> 124020 or inv.taxable_value <> 105077 or inv.tax_amount <> 18914 or inv.tax_rate <> 18
     or inv.currency is distinct from 'USD' or inv.fx_rate <> 85.12 or inv.inter_state is not true then
    raise exception 'R-2650 A: stored % / % / % rate % % @% inter %', inv.amount, inv.taxable_value, inv.tax_amount, inv.tax_rate, inv.currency, inv.fx_rate, inv.inter_state;
  end if;
  select amount, taxable_value, tax_amount into inv from public.invoices where zoho_invoice_id = 'r2650-a2';
  if inv.amount <> 124020 or inv.taxable_value <> 105076 or inv.tax_amount <> 18914 then
    raise exception 'R-2650 A2: stored % / % / %', inv.amount, inv.taxable_value, inv.tax_amount;
  end if;
  select amount, taxable_value, tax_amount into inv from public.invoices where zoho_invoice_id = 'r2650-a3';
  if inv.amount <> 1001 or inv.taxable_value <> 847 or inv.tax_amount <> 152 then
    raise exception 'R-2650 A3: stored % / % / %', inv.amount, inv.taxable_value, inv.tax_amount;
  end if;

  -- B: refused with the figures.
  select s->>'reason' into why from jsonb_array_elements(r->'skipped') s where s->>'zoho_invoice_id' = 'r2650-b';
  if why is null or why not like 'Taxable, GST and total do not add up: taxable ₹1000 + GST ₹180 is ₹5 away from the total ₹1185%' then
    raise exception 'R-2650 B: reason %', why;
  end if;
  select s->>'reason' into why from jsonb_array_elements(r->'skipped') s where s->>'zoho_invoice_id' = 'r2650-b2';
  if why is null or why not like '%is ₹200 away%up to ₹87%' then
    raise exception 'R-2650 B2: reason %', why;
  end if;
  select s->>'reason' into why from jsonb_array_elements(r->'skipped') s where s->>'zoho_invoice_id' = 'r2650-b3';
  if why is null or why not like '%round-off on the Zoho read (₹0) is not total − taxable − GST (₹30)%' then
    raise exception 'R-2650 B3: reason %', why;
  end if;
  select s->>'reason' into why from jsonb_array_elements(r->'skipped') s where s->>'zoho_invoice_id' = 'r2650-c';
  if why is distinct from 'Taxable, GST and total do not add up.' then
    raise exception 'R-2650 C: reason %', why;
  end if;
  if exists (select 1 from public.invoices where zoho_invoice_id in ('r2650-b', 'r2650-b2', 'r2650-b3', 'r2650-c')) then
    raise exception 'R-2650: a refused invoice was written';
  end if;

  raise notice 'R-2650 zoho sales fx round-off: all assertions passed';
end $$;

rollback;
