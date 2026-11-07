-- R-2547: FY receipts import in smaller parts is resumable and never books a payment twice.
-- Staging 7 Nov: part 0 (250) was booked, part 1 timed out (8 s statement limit). The fix sends parts
-- of 50 in the same stable order, so the payments of the old part 0 come again inside the new parts
-- 0..4: each must count as "already" (no second receipt), a part that died (statement cancelled:
-- the whole call rolled back) leaves nothing behind and books normally when run again, and the
-- next parts book only the rest. Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values ('b2547000-0000-0000-0000-0000000000a1', 'r2547-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2547000-0000-0000-0000-0000000000f0', 'R2547 T', 'r2547@example.test', '07', '07AAACR2547A1Z5', 'R2547');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2547000-0000-0000-0000-0000000000a1', 'b2547000-0000-0000-0000-0000000000f0', 'r2547-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'b2547000-0000-0000-0000-0000000000f0';
insert into public.customers (id, tenant_id, name, gstin, state_code, country) values
  ('b2547000-0000-0000-0000-0000000000c1', 'b2547000-0000-0000-0000-0000000000f0', 'R2547 Buyer', null, '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2547000-0000-0000-0000-0000000000d1', 'b2547000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-04-01');

-- 8 FY sales and 8 Zoho payments (payment g pays sale g in full), read from Zoho.
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2547000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zi' || g, 'INV/25-26/R2547-' || g, date '2025-05-01' + g, 'sent',
  jsonb_build_object('number', 'INV/25-26/R2547-' || g, 'date', (date '2025-05-01' + g)::text, 'dueDate', (date '2025-05-01' + g)::text,
    'status', 'sent', 'customerName', 'Buyer', 'gstin', '', 'posStateCode', '07', 'head', 'cgst_sgst', 'currency', 'INR', 'fxRate', null,
    'taxable', 1000 * g, 'tax', 180 * g, 'amount', 1180 * g, 'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', 1000 * g, 'taxable', 1000 * g))), now()
  from generate_series(1, 8) g;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2547000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'p' || g, 'R2547PAY-' || g, date '2025-06-01' + g, '',
  jsonb_build_object('zohoId', 'p' || g, 'number', 'R2547PAY-' || g, 'date', (date '2025-06-01' + g)::text, 'status', '', 'zohoCustomerId', 'zc',
    'customerName', 'Buyer', 'method', 'bank_transfer', 'zohoMode', 'Bank Transfer', 'reference', 'R2547UTR' || lpad(g::text, 6, '0'),
    'depositAccountId', 'za', 'depositAccountName', 'HDFC', 'amount', 1180 * g, 'receivedPaise', 118000 * g,
    'lines', jsonb_build_array(jsonb_build_object('zohoInvoiceId', 'zi' || g, 'invoiceNumber', 'INV/25-26/R2547-' || g, 'settle', 1180 * g, 'tds', 0)),
    'excess', 0, 'tds', 0, 'problems', '[]'::jsonb), now()
  from generate_series(1, 8) g;

-- picks a..b in the scan's stable order, as the route sends one part
create function pg_temp.picks(a int, b int) returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('zoho_payment_id', 'p' || g, 'bank_account_id', 'b2547000-0000-0000-0000-0000000000d1') order by g)
    from generate_series(a, b) g;
$f$;
grant execute on function pg_temp.picks(int, int) to authenticated;

select set_config('request.jwt.claims', json_build_object('sub', 'b2547000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  t constant uuid := 'b2547000-0000-0000-0000-0000000000f0';
  r jsonb;
  n int;
  paid numeric;
begin
  r := public.import_zoho_fy_sales('2025-26', (select jsonb_agg(jsonb_build_object('zoho_invoice_id', 'zi' || g,
         'customer_id', 'b2547000-0000-0000-0000-0000000000c1') order by g) from generate_series(1, 8) g), false);
  if (r->>'imported')::int <> 8 then raise exception 'SETUP: sales import %', r; end if;

  -- 1. the OLD big part 0: payments 1..5 in one call (what staging booked before the timeout)
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(1, 5), false);
  if (r->>'imported')::int <> 5 then raise exception 'FAIL 1: old part 0 %', r; end if;

  -- 2. a part that dies (statement cancelled) rolls back as a whole: nothing of payments 6..7 stays
  begin
    perform public.import_zoho_fy_receipts('2025-26', pg_temp.picks(6, 7), false);
    raise exception using errcode = '57014', message = 'canceling statement due to statement timeout';
  exception when query_canceled then null;
  end;
  if exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id in ('p6', 'p7')) then
    raise exception 'FAIL 2: a cancelled part left receipts behind';
  end if;

  -- 3. resumed with SMALLER parts (3) from the start: 1..3 already; 4..6 = 2 already + 1 new; 7..8 new
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(1, 3), false);
  if (r->>'imported')::int <> 0 or (r->>'already')::int <> 3 then raise exception 'FAIL 3a: part 0 again %', r; end if;
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(4, 6), false);
  if (r->>'imported')::int <> 1 or (r->>'already')::int <> 2 then raise exception 'FAIL 3b: part 1 %', r; end if;
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(7, 8), false);
  if (r->>'imported')::int <> 2 or (r->>'already')::int <> 0 then raise exception 'FAIL 3c: part 2 %', r; end if;

  -- 4. and the whole run once more: everything already, nothing new
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(1, 8), false);
  if (r->>'imported')::int <> 0 or (r->>'already')::int <> 8 then raise exception 'FAIL 4: full rerun %', r; end if;

  -- 5. exactly one receipt per Zoho payment, every sale paid once (never over)
  select count(*) into n from public.zoho_fy_receipts z where z.tenant_id = t;
  if n <> 8 then raise exception 'FAIL 5a: % zoho_fy_receipts rows, expected 8', n; end if;
  select count(*) into n from public.payments p
   where p.tenant_id = t and p.status = 'received' and p.invoice_id in (select i.id from public.invoices i where i.tenant_id = t and i.zoho_invoice_id is not null);
  if n <> 8 then raise exception 'FAIL 5b: % receipts on the sales, expected 8', n; end if;
  select coalesce(sum(i.paid_amount), 0) into paid from public.invoices i where i.tenant_id = t and i.zoho_invoice_id is not null;
  if paid <> 1180 * 36 then raise exception 'FAIL 5c: sales paid %, expected %', paid, 1180 * 36; end if;
  select count(*) into n from public.invoices i where i.tenant_id = t and i.zoho_invoice_id is not null and i.paid_amount > i.amount;
  if n <> 0 then raise exception 'FAIL 5d: % sales paid more than their total', n; end if;

  raise notice 'R-2547 receipts parts resume: all checks passed';
end $$;

rollback;
