-- R-2536: a Zoho FY sale keeps the buyer facts AS FILED in Zoho's GSTR-1 — its own GSTIN (also
-- when EMPTY = B2C), place of supply, GST treatment and billing address — and the party-snapshot
-- trigger (tg_invoice_snapshot_parties) no longer fills them from the matched app customer.
--   1. B2C Zoho invoice (no GSTIN) on a customer WITH a GSTIN → invoice customer_gstin stays NULL,
--      place of supply = Zoho's (06), IGST head kept, treatment = Zoho's (not the customer's), and
--      seller_state_code still filled → frozenParty() gives no GSTIN → GSTR-1 puts it in B2C.
--   2. Same-PAN Haryana invoice on the Delhi customer (R-2530 'pan') with Zoho's own billing
--      address → that address and country are kept, not the Delhi customer's.
--   3. Same-PAN Haryana invoice with NO address in the scan → no address (never the Delhi one).
--   4. An invoice made in the app still gets the full snapshot (GSTIN, POS, address, treatment).
--   5. party_from_source is the trigger's own stamp: a plain insert cannot set it to skip the snapshot.
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b2536000-0000-0000-0000-0000000000a1', 'r2536-owner@example.test');

insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2536000-0000-0000-0000-0000000000f0', 'R2536 T', 'r2536@example.test', '07', '07AAACR2536A1Z5', 'R2536');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2536000-0000-0000-0000-0000000000a1', 'b2536000-0000-0000-0000-0000000000f0', 'r2536-owner@example.test', 'Owner', 'owner', true);

update public.tenants set books_start_date = '2025-04-01' where id = 'b2536000-0000-0000-0000-0000000000f0';

-- The Delhi customer (GSTIN, registered) the Zoho invoices were matched to.
insert into public.customers (id, tenant_id, name, gstin, state_code, state, country, address, city, pin_code) values
  ('b2536000-0000-0000-0000-0000000000c1', 'b2536000-0000-0000-0000-0000000000f0', 'R2536 Vizira Media', '07AAFCV5915P1ZP',
   '07', 'Delhi', 'India', 'Shop 1, Karol Bagh', 'New Delhi', '110005');

create function pg_temp.p(num text, gstin text, pos text, head text, trt text, addr text, country text)
returns jsonb language sql as $f$
  select jsonb_strip_nulls(jsonb_build_object('number', num, 'date', '2025-06-10', 'dueDate', '2025-06-10', 'status', 'paid',
    'customerName', 'R2536 Vizira Media', 'gstin', gstin, 'posStateCode', pos, 'head', head, 'currency', 'INR',
    'taxable', 1000, 'tax', 180, 'amount', 1180, 'taxRate', 18, 'appGstTreatment', trt, 'problems', '[]'::jsonb,
    'billingAddress', addr, 'billingCountry', country,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', 1000, 'taxable', 1000)))) ;
$f$;

insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2536000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2536-z1', 'INV/25-26/R2536-01', '2025-06-10', 'paid',
     pg_temp.p('INV/25-26/R2536-01', '', '06', 'igst', 'consumer', null, null), now()),
  ('b2536000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2536-z2', 'INV/25-26/R2536-02', '2025-06-10', 'paid',
     pg_temp.p('INV/25-26/R2536-02', '06AAFCV5915P1ZR', '06', 'igst', 'registered_regular', 'Plot 7, Sector 18, Gurugram, Haryana 122015', 'India'), now()),
  ('b2536000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2536-z3', 'INV/25-26/R2536-03', '2025-06-10', 'paid',
     pg_temp.p('INV/25-26/R2536-03', '06AAFCV5915P1ZR', '06', 'igst', 'registered_regular', null, null), now()),
  -- B2C with no treatment code from Zoho: the customer's 'registered_regular' must not be put on it.
  ('b2536000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2536-z4', 'INV/25-26/R2536-04', '2025-06-10', 'paid',
     pg_temp.p('INV/25-26/R2536-04', '', '07', 'cgst_sgst', null, null, null), now());

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

set local role authenticated;

do $$
declare
  c constant uuid := 'b2536000-0000-0000-0000-0000000000c1';
  r jsonb;
  inv record;
  v_cust_addr constant text := 'Shop 1, Karol Bagh, New Delhi, Delhi 110005';
begin
  perform pg_temp.as_user('b2536000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_sales('2025-26', jsonb_build_array(
    jsonb_build_object('zoho_invoice_id', 'r2536-z1', 'customer_id', c),
    jsonb_build_object('zoho_invoice_id', 'r2536-z2', 'customer_id', c),
    jsonb_build_object('zoho_invoice_id', 'r2536-z3', 'customer_id', c),
    jsonb_build_object('zoho_invoice_id', 'r2536-z4', 'customer_id', c)), false);
  if (r->>'imported')::int <> 4 then raise exception 'FAIL 0: import result %', r; end if;

  -- 1. B2C stays B2C: no GSTIN, Zoho's place of supply, IGST, Zoho's treatment.
  select * into inv from public.invoices where zoho_invoice_id = 'r2536-z1';
  if inv.customer_gstin is not null then
    raise exception 'FAIL 1: B2C Zoho invoice got GSTIN % from the customer (GSTR-1 would show B2B)', inv.customer_gstin;
  end if;
  if inv.pos_state_code is distinct from '06' or inv.inter_state is not true then
    raise exception 'FAIL 1b: place of supply / head not as filed: pos % inter_state %', inv.pos_state_code, inv.inter_state;
  end if;
  if inv.gst_treatment is distinct from 'consumer' then
    raise exception 'FAIL 1c: treatment % (Zoho said consumer)', inv.gst_treatment;
  end if;
  if inv.seller_state_code is distinct from '07' or inv.seller_gstin is distinct from '07AAACR2536A1Z5' then
    raise exception 'FAIL 1d: seller facts not filled (% / %) — frozenParty needs them to read the invoice snapshot', inv.seller_state_code, inv.seller_gstin;
  end if;
  if inv.party_from_source is not true then raise exception 'FAIL 1e: imported row not marked party_from_source'; end if;
  -- No address in Zoho, no GSTIN on the invoice → the customer's address is still the best fact.
  if inv.billing_address is distinct from v_cust_addr then
    raise exception 'FAIL 1f: B2C address % (expected the customer''s, Zoho had none)', inv.billing_address;
  end if;

  -- 2. Same-PAN Haryana invoice keeps Zoho's own address.
  select * into inv from public.invoices where zoho_invoice_id = 'r2536-z2';
  if inv.customer_gstin is distinct from '06AAFCV5915P1ZR' or inv.pos_state_code is distinct from '06' then
    raise exception 'FAIL 2: GSTIN/POS % / %', inv.customer_gstin, inv.pos_state_code;
  end if;
  if inv.billing_address is distinct from 'Plot 7, Sector 18, Gurugram, Haryana 122015' or inv.customer_country is distinct from 'India' then
    raise exception 'FAIL 2b: Haryana invoice address % / % (the Delhi customer''s was used)', inv.billing_address, inv.customer_country;
  end if;

  -- 3. Same-PAN Haryana invoice with no address in the scan → never the Delhi branch's address.
  select * into inv from public.invoices where zoho_invoice_id = 'r2536-z3';
  if inv.billing_address is not null then
    raise exception 'FAIL 3: Haryana GSTIN printed with another branch''s address: %', inv.billing_address;
  end if;

  -- 3b. B2C, no treatment from Zoho → not the customer's registered_regular.
  select * into inv from public.invoices where zoho_invoice_id = 'r2536-z4';
  if inv.customer_gstin is not null or inv.gst_treatment is not null or inv.pos_state_code is distinct from '07' then
    raise exception 'FAIL 3b: B2C intra-state got % / % / %', inv.customer_gstin, inv.gst_treatment, inv.pos_state_code;
  end if;
end $$;

reset role;

-- 4 + 5. Invoices made in the app (and one trying to set the flag itself) still get the snapshot.
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status,
  invoice_date, due_date, taxable_value, tax_amount, tax_rate, inter_state, line_items)
values ('R2536-APP-1', 'b2536000-0000-0000-0000-0000000000f0', 'b2536000-0000-0000-0000-0000000000c1', 'R2536 Vizira Media',
  1180, 1180, 0, 'pending', current_date, current_date, 1000, 180, 18, false, '[]');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status,
  invoice_date, due_date, taxable_value, tax_amount, tax_rate, inter_state, line_items, party_from_source)
values ('R2536-APP-2', 'b2536000-0000-0000-0000-0000000000f0', 'b2536000-0000-0000-0000-0000000000c1', 'R2536 Vizira Media',
  1180, 1180, 0, 'pending', current_date, current_date, 1000, 180, 18, false, '[]', true);

do $$
declare inv record;
begin
  for inv in select * from public.invoices where id in ('R2536-APP-1', 'R2536-APP-2') loop
    if inv.customer_gstin is distinct from '07AAFCV5915P1ZP' or inv.pos_state_code is distinct from '07'
       or inv.billing_address is distinct from 'Shop 1, Karol Bagh, New Delhi, Delhi 110005'
       or inv.customer_country is distinct from 'India' or inv.gst_treatment is distinct from 'registered_regular' then
      raise exception 'FAIL 4: app invoice % lost the snapshot: % / % / % / % / %', inv.id,
        inv.customer_gstin, inv.pos_state_code, inv.billing_address, inv.customer_country, inv.gst_treatment;
    end if;
    if inv.party_from_source then raise exception 'FAIL 5: % marked party_from_source without the Zoho import', inv.id; end if;
  end loop;
end $$;

select 'R-2536 zoho import party as filed: all assertions passed' as result;

rollback;
