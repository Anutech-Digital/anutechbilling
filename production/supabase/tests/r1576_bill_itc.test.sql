-- Regression test: R-1576 (migration 20261018045438_r1576_bill_itc.sql)
--   vendor_bills.document_type + report_pnl / report_balance_sheet `bill_itc_groups`.
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1576_bill_itc.test.sql
--
-- What it proves (tenant A in Delhi, 07; three COGS bills of ₹10,000 + ₹1,800 GST in Oct 2026):
--   1. document_type only takes tax_invoice / proforma / bill_of_supply / other (or NULL).
--   2. report_pnl.bills_gst is unchanged (5400 — old code keeps today's number) and
--      bill_itc_groups carries each bill's type, GSTIN, heads and our state (07), so
--      lib/gst/bill-itc.ts can count only the tax invoice (1800) as credit.
--   3. report_balance_sheet carries the same groups (cumulative, ≤ as_of).
--   4. Another company's bill is in neither.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('d1576000-0000-0000-0000-0000000000a1', 'R1576 A', 'r1576-a@example.in', '07'),
  ('d1576000-0000-0000-0000-0000000000b1', 'R1576 B', 'r1576-b@example.in', '07');
insert into auth.users (id, email) values
  ('d1576000-0000-0000-0000-0000000000a2', 'r1576-user-a@example.test');
insert into public.users (id, tenant_id, email, role) values
  ('d1576000-0000-0000-0000-0000000000a2', 'd1576000-0000-0000-0000-0000000000a1', 'r1576-user-a@example.in', 'owner');

insert into public.vendor_bills (id, tenant_id, vendor_name, vendor_gstin, bill_date, category, subtotal, cgst, sgst, igst, total, status, document_type) values
  ('R1576-TAX', 'd1576000-0000-0000-0000-0000000000a1', 'Tax Inv Vendor', '07AAACA1234A1Z5', '2026-10-05', 'COGS-Workspace', 10000, 900, 900, 0, 11800, 'unpaid', 'tax_invoice'),
  ('R1576-PRO', 'd1576000-0000-0000-0000-0000000000a1', 'Proforma Vendor', '07AAACA1234A1Z5', '2026-10-06', 'COGS-Workspace', 10000, 900, 900, 0, 11800, 'unpaid', 'proforma'),
  ('R1576-OLD', 'd1576000-0000-0000-0000-0000000000a1', 'No GSTIN Vendor', null, '2026-10-07', 'COGS-Workspace', 10000, 900, 900, 0, 11800, 'unpaid', null),
  ('R1576-BBB', 'd1576000-0000-0000-0000-0000000000b1', 'B Vendor', '07AAACA1234A1Z5', '2026-10-07', 'COGS-Workspace', 999999, 77777, 77777, 0, 1155553, 'unpaid', 'proforma');

-- 1
do $$ begin
  begin
    update public.vendor_bills set document_type = 'quotation' where id = 'R1576-TAX';
    raise exception 'FAIL 1: document_type took an unknown value';
  exception when check_violation then null;
  end;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd1576000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);

do $$
declare
  p record; b record; g jsonb;
begin
  -- 2
  select * into p from public.report_pnl('2026-10-01', '2026-10-31');
  if p.cogs <> 30000 then raise exception 'FAIL 2a: cogs % (want 30000)', p.cogs; end if;
  if p.bills_gst <> 5400 then raise exception 'FAIL 2b: bills_gst % (want 5400, unchanged)', p.bills_gst; end if;
  if jsonb_array_length(p.bill_itc_groups) <> 3 then raise exception 'FAIL 2c: % groups (want 3): %', jsonb_array_length(p.bill_itc_groups), p.bill_itc_groups; end if;
  select x into g from jsonb_array_elements(p.bill_itc_groups) x where x->>'document_type' = 'proforma';
  if g is null or (g->>'cgst')::int <> 900 or (g->>'sgst')::int <> 900 or (g->>'n')::int <> 1 or g->>'ownStateCode' <> '07' or g->>'vendorGstin' <> '07AAACA1234A1Z5' then
    raise exception 'FAIL 2d: proforma group %', g;
  end if;
  select x into g from jsonb_array_elements(p.bill_itc_groups) x where x->>'document_type' is null;
  if g is null or g->>'vendorGstin' is not null then raise exception 'FAIL 2e: old no-GSTIN group %', g; end if;

  -- 3, 4
  select * into b from public.report_balance_sheet('2026-10-31');
  if b.bills_gst <> 5400 then raise exception 'FAIL 3a: bills_gst % (want 5400)', b.bills_gst; end if;
  if jsonb_array_length(b.bill_itc_groups) <> 3 then raise exception 'FAIL 3b: % groups (want 3)', jsonb_array_length(b.bill_itc_groups); end if;
  if (select sum((x->>'cgst')::int + (x->>'sgst')::int + (x->>'igst')::int) from jsonb_array_elements(b.bill_itc_groups) x) <> 5400 then
    raise exception 'FAIL 4: another company''s bill leaked into the groups: %', b.bill_itc_groups;
  end if;
  select * into b from public.report_balance_sheet('2026-10-05');
  if jsonb_array_length(b.bill_itc_groups) <> 1 then raise exception 'FAIL 3c: as_of 5 Oct should see 1 bill, saw %', b.bill_itc_groups; end if;
end $$;

rollback;
