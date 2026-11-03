-- Regression test: R-2432 (migration 20261103170000_r2432_partner_mirror_v2.sql)
--   distributor → reseller invoice mirror (tg_mirror_invoice_to_child_vendor_bill) + credit notes.
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
-- What it proves (distributor P in Delhi 07; reseller C in Delhi 07, reseller M in Maharashtra 27):
--   1. A DRAFT invoice to a linked reseller makes no bill (old trigger made an unpaid bill).
--   2. Issuing it (draft → pending) makes the bill with the frozen split — 12% GST, not a /1.18
--      guess: subtotal 10000, CGST 600, SGST 600, total 11200, document_type tax_invoice,
--      vendor_id = a vendor in C with P's GSTIN.
--   3. An inter-state 5% invoice issued straight away → IGST 500; the same vendor is reused for
--      a second invoice to C (one vendor per GSTIN).
--   4. Void of an untouched invoice → its bill is gone; void of a paid one → bill kept + flagged.
--   5. Credit note ₹5,900 (5000 + 900) on an ₹11,800 invoice → bill 5000 / 450 / 450 / 5900.
--   6. Isolation: a customer linked to a tenant that is NOT P's child gets nothing; a draft
--      inserted void gets nothing.

begin;

insert into public.tenants (id, name, email, state_code, gstin) values
  ('d2432000-0000-0000-0000-0000000000f0', 'R2432 Distributor', 'r2432-p@example.test', '07', '07AAACR2432A1Z5');
insert into public.tenants (id, name, email, state_code, parent_tenant_id) values
  ('d2432000-0000-0000-0000-0000000000c1', 'R2432 Reseller Delhi', 'r2432-c@example.test', '07', 'd2432000-0000-0000-0000-0000000000f0'),
  ('d2432000-0000-0000-0000-0000000000c2', 'R2432 Reseller Mumbai', 'r2432-m@example.test', '27', 'd2432000-0000-0000-0000-0000000000f0');
insert into public.tenants (id, name, email, state_code) values
  ('d2432000-0000-0000-0000-0000000000e1', 'R2432 Stranger', 'r2432-x@example.test', '07');

insert into public.customers (id, tenant_id, name, linked_tenant_id) values
  ('d2432000-0000-0000-0000-0000000001c1', 'd2432000-0000-0000-0000-0000000000f0', 'R2432 Reseller Delhi', 'd2432000-0000-0000-0000-0000000000c1'),
  ('d2432000-0000-0000-0000-0000000001c2', 'd2432000-0000-0000-0000-0000000000f0', 'R2432 Reseller Mumbai', 'd2432000-0000-0000-0000-0000000000c2'),
  ('d2432000-0000-0000-0000-0000000001e1', 'd2432000-0000-0000-0000-0000000000f0', 'R2432 Stranger', 'd2432000-0000-0000-0000-0000000000e1');

-- 1: draft
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable, taxable_value, tax_amount, tax_rate, inter_state)
values ('INV-R2432-A', 'd2432000-0000-0000-0000-0000000000f0', 'd2432000-0000-0000-0000-0000000001c1', 'R2432 Reseller Delhi',
        11200, 'draft', current_date, 11200, 10000, 1200, 12, false);

do $$ begin
  if exists (select 1 from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-A') then
    raise exception 'FAIL 1: a draft invoice became a bill in the reseller';
  end if;
end $$;

-- 2: issue it
update public.invoices set status = 'pending' where id = 'INV-R2432-A';

do $$
declare b record; v record;
begin
  select * into b from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-A';
  if b.id is null then raise exception 'FAIL 2a: issuing the invoice made no bill'; end if;
  if b.tenant_id <> 'd2432000-0000-0000-0000-0000000000c1' then raise exception 'FAIL 2b: bill in tenant %', b.tenant_id; end if;
  if (b.subtotal, b.cgst, b.sgst, b.igst, b.total) is distinct from (10000, 600, 600, 0, 11200) then
    raise exception 'FAIL 2c: bill % / % / % / % / % (want 10000 / 600 / 600 / 0 / 11200 — frozen 12%%, no 1.18 guess)',
      b.subtotal, b.cgst, b.sgst, b.igst, b.total;
  end if;
  if b.document_type is distinct from 'tax_invoice' then raise exception 'FAIL 2d: document_type % (want tax_invoice)', b.document_type; end if;
  select * into v from public.vendors where id = b.vendor_id;
  if v.id is null or v.tenant_id <> 'd2432000-0000-0000-0000-0000000000c1' or v.gstin is distinct from '07AAACR2432A1Z5' then
    raise exception 'FAIL 2e: vendor % / % / % (want a C vendor with the distributor GSTIN)', v.id, v.tenant_id, v.gstin;
  end if;
end $$;

-- 3: inter-state 5%, issued straight away; and a second Delhi invoice reusing the vendor
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable, taxable_value, tax_amount, tax_rate, inter_state)
values
  ('INV-R2432-B', 'd2432000-0000-0000-0000-0000000000f0', 'd2432000-0000-0000-0000-0000000001c2', 'R2432 Reseller Mumbai',
   10500, 'pending', current_date, 10500, 10000, 500, 5, true),
  ('INV-R2432-C', 'd2432000-0000-0000-0000-0000000000f0', 'd2432000-0000-0000-0000-0000000001c1', 'R2432 Reseller Delhi',
   11800, 'pending', current_date, 11800, 10000, 1800, 18, false),
  ('INV-R2432-D', 'd2432000-0000-0000-0000-0000000000f0', 'd2432000-0000-0000-0000-0000000001c1', 'R2432 Reseller Delhi',
   11800, 'pending', current_date, 11800, 10000, 1800, 18, false);

do $$
declare b record; n int;
begin
  select * into b from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-B';
  if b.id is null or b.tenant_id <> 'd2432000-0000-0000-0000-0000000000c2'
     or (b.subtotal, b.cgst, b.sgst, b.igst, b.total) is distinct from (10000, 0, 0, 500, 10500) then
    raise exception 'FAIL 3a: inter-state bill % % / % / % / % / %', b.id, b.subtotal, b.cgst, b.sgst, b.igst, b.total;
  end if;
  select count(*) into n from public.vendors where tenant_id = 'd2432000-0000-0000-0000-0000000000c1';
  if n <> 1 then raise exception 'FAIL 3b: % vendors in C (want 1 — reused by GSTIN)', n; end if;
end $$;

-- 4: void untouched A → bill gone; D partly paid → kept + flagged
update public.vendor_bills set paid_amount = 1000, status = 'partial' where source_tenant_invoice_id = 'INV-R2432-D';
update public.invoices set status = 'void' where id in ('INV-R2432-A', 'INV-R2432-D');

do $$
declare b record;
begin
  if exists (select 1 from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-A') then
    raise exception 'FAIL 4a: the voided invoice''s unpaid bill is still there';
  end if;
  select * into b from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-D';
  if b.id is null or b.total <> 11800 or b.paid_amount <> 1000 then
    raise exception 'FAIL 4b: the paid bill must stay unchanged, got % / % / %', b.id, b.total, b.paid_amount;
  end if;
  if b.notes not like '%voided invoice INV-R2432-D%' then raise exception 'FAIL 4c: no void flag on the paid bill: %', b.notes; end if;
end $$;

-- 5: credit note on C
insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('CN-R2432-1', 'd2432000-0000-0000-0000-0000000000f0', 'INV-R2432-C', 'd2432000-0000-0000-0000-0000000001c1', 'R2432 Reseller Delhi',
        5900, 5000, 900, 18, false);

do $$
declare b record;
begin
  select * into b from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-C';
  if (b.subtotal, b.cgst, b.sgst, b.igst, b.total) is distinct from (5000, 450, 450, 0, 5900) then
    raise exception 'FAIL 5: after the credit note the bill is % / % / % / % / % (want 5000 / 450 / 450 / 0 / 5900)',
      b.subtotal, b.cgst, b.sgst, b.igst, b.total;
  end if;
end $$;

-- 7: review cases
--   7a credit note stored with inter_state=false on an IGST bill → IGST comes down, never CGST/SGST.
insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('CN-R2432-2', 'd2432000-0000-0000-0000-0000000000f0', 'INV-R2432-B', 'd2432000-0000-0000-0000-0000000001c2', 'R2432 Reseller Mumbai',
        2100, 2000, 100, 5, false);
--   7b a credit note from ANOTHER company naming the distributor's invoice moves nothing.
insert into public.credit_notes (id, tenant_id, invoice_id, customer_name, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('CN-R2432-X', 'd2432000-0000-0000-0000-0000000000e1', 'INV-R2432-C', 'Someone', 1180, 1000, 180, 18, false);
--   7c a bill the OLD trigger made for a draft (/1.18 guess, no document_type) is rebuilt on issue.
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable, taxable_value, tax_amount, tax_rate, inter_state)
values ('INV-R2432-O', 'd2432000-0000-0000-0000-0000000000f0', 'd2432000-0000-0000-0000-0000000001c1', 'R2432 Reseller Delhi',
        10500, 'draft', current_date, 10500, 10000, 500, 5, false);
insert into public.vendor_bills (id, tenant_id, vendor_name, bill_no, bill_date, category, subtotal, cgst, sgst, igst, total, status, source_tenant_invoice_id)
values ('VB-PARTNER-INV-R2432-O', 'd2432000-0000-0000-0000-0000000000c1', 'R2432 Distributor', 'INV-R2432-O', current_date, 'cloud_subscriptions',
        8898, 801, 801, 0, 10500, 'unpaid', 'INV-R2432-O');
update public.invoices set status = 'pending' where id = 'INV-R2432-O';
--   7d a third reseller (Pune) already has a vendor with the distributor's NAME but another GSTIN.
insert into public.tenants (id, name, email, state_code, parent_tenant_id) values
  ('d2432000-0000-0000-0000-0000000000c3', 'R2432 Reseller Pune', 'r2432-pune@example.test', '27', 'd2432000-0000-0000-0000-0000000000f0');
insert into public.customers (id, tenant_id, name, linked_tenant_id) values
  ('d2432000-0000-0000-0000-0000000001c3', 'd2432000-0000-0000-0000-0000000000f0', 'R2432 Reseller Pune', 'd2432000-0000-0000-0000-0000000000c3');
insert into public.vendors (tenant_id, name, gstin) values
  ('d2432000-0000-0000-0000-0000000000c3', 'R2432 Distributor', '27AAACZ9999Z1Z5');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable, taxable_value, tax_amount, tax_rate, inter_state)
values ('INV-R2432-N', 'd2432000-0000-0000-0000-0000000000f0', 'd2432000-0000-0000-0000-0000000001c3', 'R2432 Reseller Pune',
        1180, 'pending', current_date, 1180, 1000, 180, 18, true);

do $$
declare b record; v record;
begin
  select * into b from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-B';
  if (b.subtotal, b.cgst, b.sgst, b.igst, b.total) is distinct from (8000, 0, 0, 400, 8400) then
    raise exception 'FAIL 7a: IGST bill after a note flagged intra-state is % / % / % / % / % (want 8000 / 0 / 0 / 400 / 8400)',
      b.subtotal, b.cgst, b.sgst, b.igst, b.total;
  end if;
  select * into b from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-C';
  if b.total <> 5900 then raise exception 'FAIL 7b: another company''s credit note moved the bill to %', b.total; end if;
  select * into b from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-O';
  if (b.subtotal, b.cgst, b.sgst, b.total, b.document_type) is distinct from (10000, 250, 250, 10500, 'tax_invoice') or b.vendor_id is null then
    raise exception 'FAIL 7c: old draft bill not rebuilt: % / % / % / % / % vendor %', b.subtotal, b.cgst, b.sgst, b.total, b.document_type, b.vendor_id;
  end if;
  select * into b from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-N';
  select * into v from public.vendors where id = b.vendor_id;
  if v.gstin is distinct from '07AAACR2432A1Z5' or v.pan is distinct from 'AAACR2432A' then
    raise exception 'FAIL 7d: bill linked to vendor % (gstin %, pan %) — want a new vendor with the distributor GSTIN + PAN', v.name, v.gstin, v.pan;
  end if;
end $$;

-- 6: isolation + void-at-insert
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable, taxable_value, tax_amount, tax_rate, inter_state)
values
  ('INV-R2432-X', 'd2432000-0000-0000-0000-0000000000f0', 'd2432000-0000-0000-0000-0000000001e1', 'R2432 Stranger',
   11800, 'pending', current_date, 11800, 10000, 1800, 18, false),
  ('INV-R2432-V', 'd2432000-0000-0000-0000-0000000000f0', 'd2432000-0000-0000-0000-0000000001c1', 'R2432 Reseller Delhi',
   11800, 'void', current_date, 11800, 10000, 1800, 18, false);

do $$ begin
  if exists (select 1 from public.vendor_bills where tenant_id = 'd2432000-0000-0000-0000-0000000000e1') then
    raise exception 'FAIL 6a: a tenant that is not the distributor''s child got a bill';
  end if;
  if exists (select 1 from public.vendor_bills where source_tenant_invoice_id = 'INV-R2432-V') then
    raise exception 'FAIL 6b: an invoice inserted as void became a bill';
  end if;
  raise notice 'PASS R-2432: draft no bill; issue → frozen 12%% split + vendor; IGST 5%%; vendor reused; void removes unpaid / flags paid; CN reduces; isolation';
end $$;

rollback;
