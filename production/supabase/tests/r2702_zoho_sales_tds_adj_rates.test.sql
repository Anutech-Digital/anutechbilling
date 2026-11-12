-- R-2702: the FY 2025-26 Zoho sales import books the invoices it used to leave out, as Zoho filed them.
--   S1. TDS on the invoice (Zoho's total net of it): the sale is the FULL value (₹1,18,000), never ₹1,08,000.
--   S2. A Zoho adjustment −₹250: its own line {kind "adjustment"} with no GST and no rate; taxable and GST
--       Zoho's; total = Zoho's ₹1,17,750.
--   S3. Lines at 0% + 18%: one invoice, each line keeps its tax_rate; the invoice carries 18.
--   S4. refused: an adjustment with no adjustment line; TDS not below the sale; a line rate the app does not
--       store; TDS on a foreign-currency invoice.
--   R1. Receipts: Zoho's payment of the NET ₹1,08,000 (no TDS withheld on the payment) on the TDS invoice →
--       receipt ₹1,08,000 + TDS ₹10,000 (194JB, Zoho's) in TDS receivable; the invoice is Paid.
--   R2. Part payments: ₹50,000 stays money only (TDS not guessed); the ₹58,000 that closes it carries the TDS.
--   R3. A Zoho payment that itself withholds the TDS (settle ₹1,18,000, TDS ₹10,000): booked once, as before.
-- Self-asserting; the whole file rolls back. Red without 20261112112400_r2702_zoho_sales_tds_adj_rates.sql.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values ('b2702000-0000-0000-0000-0000000000a1', 'r2702-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2702000-0000-0000-0000-0000000000f0', 'R2702 T', 'r2702@example.test', '07', '07AAACR2702A1Z5', 'R2702');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2702000-0000-0000-0000-0000000000a1', 'b2702000-0000-0000-0000-0000000000f0', 'r2702-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'b2702000-0000-0000-0000-0000000000f0';
insert into public.customers (id, tenant_id, name, gstin, state_code, state, country, address, city, pin_code) values
  ('b2702000-0000-0000-0000-0000000000c1', 'b2702000-0000-0000-0000-0000000000f0', 'R2702 Delhi Buyer', '07AAFCV5915P1ZP',
   '07', 'Delhi', 'India', 'Shop 1', 'New Delhi', '110005');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2702000-0000-0000-0000-0000000000d1', 'b2702000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-04-01');

-- The scan as normalise.ts (R-2702) stores it.
create function pg_temp.sale(num text, extra jsonb default '{}') returns jsonb language sql as $f$
  select jsonb_build_object('number', num, 'date', '2025-08-12', 'dueDate', '2025-08-27', 'status', 'paid',
    'customerName', 'R2702 Delhi Buyer', 'gstin', '07AAFCV5915P1ZP', 'posStateCode', '07', 'head', 'cgst_sgst', 'currency', 'INR',
    'taxable', 100000, 'tax', 18000, 'amount', 118000, 'roundOff', 0, 'adjustment', 0, 'tds', 0, 'taxRate', 18,
    'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 100, 'rate', 1000, 'taxable', 100000, 'taxPercent', 18))) || extra;
$f$;

insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2702000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', x.zid, x.num, date '2025-08-12', 'paid', pg_temp.sale(x.num, x.extra), now()
  from (values
    -- S1 / R1..R3: TDS ₹10,000 (194JB) on the invoice; Zoho's net total ₹1,08,000
    ('s1',  'INV/25-26/R2702-01', '{"tds": 10000, "tdsSection": "194JB"}'::jsonb),
    ('s1b', 'INV/25-26/R2702-02', '{"tds": 10000, "tdsSection": "194JB"}'::jsonb),
    ('s1c', 'INV/25-26/R2702-03', '{"tds": 10000}'::jsonb),
    -- S2: adjustment −₹250
    ('s2',  'INV/25-26/R2702-04', '{"amount": 117750, "roundOff": -250, "adjustment": -250, "lines": [
       {"name": "Seat", "hsn": "998315", "qty": 100, "rate": 1000, "taxable": 100000, "taxPercent": 18},
       {"name": "Discount on renewal", "hsn": "", "qty": 1, "rate": -250, "taxable": -250, "taxPercent": null, "kind": "adjustment"}]}'::jsonb),
    -- S3: ₹90,000 @ 18% + ₹10,000 @ 0% → GST ₹16,200
    ('s3',  'INV/25-26/R2702-05', '{"tax": 16200, "amount": 116200, "lines": [
       {"name": "Seats", "hsn": "998315", "qty": 1, "rate": 90000, "taxable": 90000, "taxPercent": 18},
       {"name": "Govt fee", "hsn": "998599", "qty": 1, "rate": 10000, "taxable": 10000, "taxPercent": 0}]}'::jsonb),
    -- S4: refusals
    ('s4a', 'INV/25-26/R2702-06', '{"amount": 117750, "roundOff": -250, "adjustment": -250}'::jsonb),
    ('s4b', 'INV/25-26/R2702-07', '{"tds": 118000}'::jsonb),
    ('s4c', 'INV/25-26/R2702-08', '{"tax": 16225, "amount": 116225, "lines": [
       {"name": "Seats", "hsn": "998315", "qty": 1, "rate": 90000, "taxable": 90000, "taxPercent": 18},
       {"name": "Odd", "hsn": "998599", "qty": 1, "rate": 10000, "taxable": 10000, "taxPercent": 0.25}]}'::jsonb),
    ('s4d', 'INV/25-26/R2702-09', '{"tds": 10000, "currency": "USD", "fxRate": 85}'::jsonb)
  ) as x(zid, num, extra);

-- Zoho ₹ payments (receipts normaliser shape)
create function pg_temp.pay(zid text, dt date, inv text, num text, settle int, tds int) returns jsonb language sql as $f$
  select jsonb_build_object('zohoId', zid, 'number', 'R2702-' || zid, 'date', dt, 'status', '', 'zohoCustomerId', 'zc',
    'customerName', 'R2702 Delhi Buyer', 'method', 'bank_transfer', 'zohoMode', 'Bank Transfer', 'reference', 'R2702REF' || zid,
    'depositAccountId', 'zhdfc', 'depositAccountName', 'HDFC 4523', 'amount', settle - tds, 'receivedPaise', (settle - tds) * 100,
    'lines', jsonb_build_array(jsonb_build_object('zohoInvoiceId', inv, 'invoiceNumber', num, 'settle', settle, 'tds', tds)),
    'excess', 0, 'tds', tds, 'fee', 0, 'feeGst', 0, 'viaSettlement', false, 'problems', '[]'::jsonb, 'currency', 'INR');
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2702000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', x.zid, 'R2702-' || x.zid, x.dt, '', x.payload, now()
  from (values
    ('p1',  date '2025-08-20', pg_temp.pay('p1',  '2025-08-20', 's1',  'INV/25-26/R2702-01', 108000, 0)),
    ('p2a', date '2025-08-20', pg_temp.pay('p2a', '2025-08-20', 's1b', 'INV/25-26/R2702-02', 50000, 0)),
    ('p2b', date '2025-09-05', pg_temp.pay('p2b', '2025-09-05', 's1b', 'INV/25-26/R2702-02', 58000, 0)),
    ('p3',  date '2025-08-20', pg_temp.pay('p3',  '2025-08-20', 's1c', 'INV/25-26/R2702-03', 118000, 10000))
  ) as x(zid, dt, payload);

create function pg_temp.picks(ids text[]) returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('zoho_payment_id', x, 'bank_account_id', 'b2702000-0000-0000-0000-0000000000d1') order by x)
    from unnest(ids) x;
$f$;
grant execute on function pg_temp.picks(text[]) to authenticated;

select set_config('request.jwt.claims', json_build_object('sub', 'b2702000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  t   constant uuid := 'b2702000-0000-0000-0000-0000000000f0';
  c   constant uuid := 'b2702000-0000-0000-0000-0000000000c1';
  r jsonb;
  why text;
  inv record;
  x record;
  n int;
begin
  r := public.import_zoho_fy_sales('2025-26', (select jsonb_agg(jsonb_build_object('zoho_invoice_id', z, 'customer_id', c))
         from unnest(array['s1', 's1b', 's1c', 's2', 's3', 's4a', 's4b', 's4c', 's4d']) z), false);
  if (r->>'imported')::int <> 5 then
    raise exception 'R-2702 S: expected s1, s1b, s1c, s2, s3 imported, got % (skipped %)', r->>'imported', r->'skipped';
  end if;

  -- S1: the full sale, never net of TDS.
  select amount, net_payable, taxable_value, tax_amount, tax_rate into inv from public.invoices where tenant_id = t and zoho_invoice_id = 's1';
  if inv.amount <> 118000 or coalesce(inv.net_payable, inv.amount) <> 118000 or inv.taxable_value <> 100000 or inv.tax_amount <> 18000 or inv.tax_rate <> 18 then
    raise exception 'R-2702 S1: stored % / % / % / % rate %', inv.amount, inv.net_payable, inv.taxable_value, inv.tax_amount, inv.tax_rate;
  end if;

  -- S2: Zoho's adjustment is its own no-GST line; the total is Zoho's.
  select amount, taxable_value, tax_amount, tax_rate, line_items into inv from public.invoices where tenant_id = t and zoho_invoice_id = 's2';
  if inv.amount <> 117750 or inv.taxable_value <> 100000 or inv.tax_amount <> 18000 or inv.tax_rate <> 18 then
    raise exception 'R-2702 S2: stored % / % / % rate %', inv.amount, inv.taxable_value, inv.tax_amount, inv.tax_rate;
  end if;
  if jsonb_array_length(inv.line_items) <> 2
     or inv.line_items->1->>'kind' is distinct from 'adjustment' or (inv.line_items->1->>'amount')::int <> -250
     or inv.line_items->1 ? 'tax_rate' or inv.line_items->1 ? 'hsn' or inv.line_items->1 ? 'item_id'
     or inv.line_items->0 ? 'kind' or (inv.line_items->0->>'tax_rate')::numeric <> 18 then
    raise exception 'R-2702 S2: line_items %', inv.line_items;
  end if;

  -- S3: each line keeps its rate; the invoice shows the highest.
  select amount, taxable_value, tax_amount, tax_rate, line_items into inv from public.invoices where tenant_id = t and zoho_invoice_id = 's3';
  if inv.amount <> 116200 or inv.taxable_value <> 100000 or inv.tax_amount <> 16200 or inv.tax_rate <> 18
     or (inv.line_items->0->>'tax_rate')::numeric <> 18 or (inv.line_items->1->>'tax_rate')::numeric <> 0 then
    raise exception 'R-2702 S3: stored % / % / % rate % lines %', inv.amount, inv.taxable_value, inv.tax_amount, inv.tax_rate, inv.line_items;
  end if;

  -- S4: refusals, with reasons.
  select string_agg(s->>'zoho_invoice_id' || ': ' || (s->>'reason'), ' | ' order by s->>'zoho_invoice_id') into why from jsonb_array_elements(r->'skipped') s;
  if why not like 's4a: Zoho''s adjustment ₹-250 is not its adjustment line ₹0%'
     or why not like '%s4b: Zoho''s TDS ₹118000 on it is not below the sale ₹118000%'
     or why not like '%s4c: GST rate 0.25% on a line is not one this app stores%'
     or why not like '%s4d: Zoho has TDS on a foreign-currency invoice%' then
    raise exception 'R-2702 S4: reasons %', why;
  end if;
  if exists (select 1 from public.invoices where tenant_id = t and zoho_invoice_id like 's4%') then
    raise exception 'R-2702 S4: a refused invoice was written';
  end if;

  -- R1 + R2 + R3: receipts.
  r := public.import_zoho_fy_receipts('2025-26', (select jsonb_agg(jsonb_build_object('zoho_payment_id', z,
         'bank_account_id', 'b2702000-0000-0000-0000-0000000000d1')) from unnest(array['p1', 'p2a', 'p3']) z), false);
  if (r->>'imported')::int <> 3 then raise exception 'R-2702 R: expected p1, p2a, p3 imported, got %', r; end if;

  -- R1: ₹1,08,000 received + Zoho's TDS ₹10,000 (194JB) → Paid.
  select i.status::text st, i.paid_amount into inv from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 's1';
  if inv.st <> 'paid' then raise exception 'R-2702 R1: invoice % paid %', inv.st, inv.paid_amount; end if;
  -- (a receipt's amount is what it settles on the invoice — money + TDS, the app's convention; the
  --  TDS row's net_paid is the money: exactly as for a TDS Zoho withholds on the payment, R3)
  select count(*) into n from public.payments p join public.invoices i on i.id = p.invoice_id
   where i.tenant_id = t and i.zoho_invoice_id = 's1' and p.amount = 118000;
  if n <> 1 then raise exception 'R-2702 R1: expected one receipt settling ₹1,18,000, got %', n; end if;
  select x2.tds_amount, x2.section, x2.gross_amount, x2.net_paid into x from public.tds_receivable x2 join public.invoices i on i.id = x2.invoice_id
   where i.tenant_id = t and i.zoho_invoice_id = 's1';
  if x.tds_amount is distinct from 10000 or x.section is distinct from '194JB' or x.gross_amount is distinct from 100000
     or x.net_paid is distinct from 108000 then
    raise exception 'R-2702 R1: TDS receivable % % gross % net %', x.tds_amount, x.section, x.gross_amount, x.net_paid;
  end if;
  if (select z.cash from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1') is distinct from 108000
     or (select z.tds from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1') is distinct from 10000 then
    raise exception 'R-2702 R1: zoho_fy_receipts cash/tds %', (select to_jsonb(z) from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1');
  end if;

  -- R2 (part 1): money only, no TDS guessed; ₹68,000 still due.
  if exists (select 1 from public.tds_receivable x2 join public.invoices i on i.id = x2.invoice_id where i.tenant_id = t and i.zoho_invoice_id = 's1b') then
    raise exception 'R-2702 R2: TDS booked on a part payment';
  end if;
  -- R3: Zoho's own withheld TDS, once.
  select count(*), sum(x2.tds_amount) into x from public.tds_receivable x2 join public.invoices i on i.id = x2.invoice_id
   where i.tenant_id = t and i.zoho_invoice_id = 's1c';
  if x.count <> 1 or x.sum <> 10000 then raise exception 'R-2702 R3: TDS rows % sum %', x.count, x.sum; end if;
  select i.status::text st into inv from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 's1c';
  if inv.st <> 'paid' then raise exception 'R-2702 R3: invoice %', inv.st; end if;

  -- R2 (part 2): the payment that closes it carries the invoice's TDS.
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(array['p2b']), false);
  if (r->>'imported')::int <> 1 then raise exception 'R-2702 R2: p2b %', r; end if;
  select i.status::text st into inv from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 's1b';
  select x2.tds_amount, x2.section into x from public.tds_receivable x2 join public.invoices i on i.id = x2.invoice_id
   where i.tenant_id = t and i.zoho_invoice_id = 's1b';
  if inv.st <> 'paid' or x.tds_amount is distinct from 10000 or x.section is distinct from '194JB' then
    raise exception 'R-2702 R2: invoice % TDS % %', inv.st, x.tds_amount, x.section;
  end if;

  raise notice 'R-2702 zoho sales TDS / adjustment / mixed rates: all assertions passed';
end $$;

rollback;
