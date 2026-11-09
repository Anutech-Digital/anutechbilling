-- R-2636 (9 Nov 2026, split from R-2171): quote → invoice for a customer abroad. generate_invoice took the
-- rate from the QUOTE and set inter_state = false for an export, so a quote that still charged 18% became an
-- "export" invoice with CGST+SGST — the wrong head on a zero-rated supply (and R-2444's LUT check, which is
-- only for 0%, never fired). It also counted country 'Bharat' as abroad (CGST+SGST for a buyer in another
-- state) while supply_is_zero_rated / isExportSupply say India.
-- Migration 20261109181239_r2636_export_tax_head. Self-asserting, ONE transaction, rolled back.
-- Local/test DB only. Red without the migration (A issues a CGST+SGST export, D issues CGST+SGST, F keeps
-- CGST+SGST).
--
--   A. Customer abroad (United States) + accepted quote at 18% (₹50,000 + ₹9,000) → export WITH payment of
--      IGST: amount ₹59,000 kept, tax ₹9,000, inter_state true (never CGST+SGST, never refused).
--   B. Same customer, 0% quote → export invoice at 0% (tax 0, treatment overseas).
--   C. 0% export quote, company with NO LUT → R-2444's refusal (unchanged); C2: 18% quote there → IGST.
--   D. Country 'Bharat', state 27, seller 07, 18% quote → IGST (inter_state true), tax ₹9,000.
--   E. Country 'Bharat', state 07 (seller's state) → CGST+SGST 18% (inter_state false).
--   F. Any other path (e.g. a project milestone at 18%): an app Tax Invoice abroad with GST and inter_state
--      false → stored with inter_state true (IGST), not refused.
--   G. Export with payment of IGST (inter_state true, tax > 0) → not refused (legal head, GSTR-1 6A WPAY).
--   H. Zoho FY sales import session → an export row as filed with CGST+SGST is not refused.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code, lut_number, lut_valid_upto) values
  ('dddddddd-0000-0000-0000-000000263601','R2636 Exporter','r2636@example.in','07','X636','AD070426002636X','2027-03-31');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000263602','R2636 No LUT Co','r2636b@example.in','07','Y636');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000263601','owner2636@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000263602','owner2636b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000263601','dddddddd-0000-0000-0000-000000263601','owner2636@example.in','Owner 2636','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000263602','dddddddd-0000-0000-0000-000000263602','owner2636b@example.in','Owner 2636b','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, gstin, customer_type, gst_treatment, domain) values
  ('cccccccc-0000-0000-0000-000000263601','dddddddd-0000-0000-0000-000000263601','R2636 Peak LLC',null,'United States',null,'business','overseas','p2636.example'),
  ('cccccccc-0000-0000-0000-000000263602','dddddddd-0000-0000-0000-000000263601','R2636 Pune Bharat','27','Bharat',null,'business','unregistered_business','b2636.example'),
  ('cccccccc-0000-0000-0000-000000263603','dddddddd-0000-0000-0000-000000263601','R2636 Delhi Bharat','07','Bharat',null,'business','unregistered_business','d2636.example'),
  ('cccccccc-0000-0000-0000-000000263604','dddddddd-0000-0000-0000-000000263602','R2636 Oslo AS',null,'Norway',null,'business','overseas','o2636.example');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R2636-A',  'dddddddd-0000-0000-0000-000000263601','cccccccc-0000-0000-0000-000000263601','R2636 Peak LLC',     59000, 50000, 18, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-B',  'dddddddd-0000-0000-0000-000000263601','cccccccc-0000-0000-0000-000000263601','R2636 Peak LLC',     50000, 50000,  0, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-C',  'dddddddd-0000-0000-0000-000000263602','cccccccc-0000-0000-0000-000000263604','R2636 Oslo AS',      50000, 50000,  0, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-C2', 'dddddddd-0000-0000-0000-000000263602','cccccccc-0000-0000-0000-000000263604','R2636 Oslo AS',      59000, 50000, 18, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-D',  'dddddddd-0000-0000-0000-000000263601','cccccccc-0000-0000-0000-000000263602','R2636 Pune Bharat',  59000, 50000, 18, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-E',  'dddddddd-0000-0000-0000-000000263601','cccccccc-0000-0000-0000-000000263603','R2636 Delhi Bharat', 59000, 50000, 18, 'accepted', 'received', '[]'::jsonb);

do $$
declare
  c_t constant uuid := 'dddddddd-0000-0000-0000-000000263601';
  ok boolean; v_msg text; n int; v_inv text; i record; k int;
begin
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000263601","role":"authenticated"}', true);

  -- A. 18% quote abroad → IGST (export with payment), amount kept
  select invoice_id into v_inv from public.generate_invoice('Q-R2636-A');
  select * into i from public.invoices where id = v_inv;
  if v_inv is null or i.inter_state is distinct from true or i.tax_amount <> 9000 or i.tax_rate <> 18 or i.amount <> 59000
     or i.taxable_value <> 50000 then
    raise exception 'FAIL A: 18%% export invoice % inter_state % tax % amount %', v_inv, i.inter_state, i.tax_amount, i.amount;
  end if;
  raise notice 'A PASS: 18%% quote abroad → IGST %, never CGST+SGST', v_inv;

  -- B. 0% quote abroad → export 0%
  select invoice_id into v_inv from public.generate_invoice('Q-R2636-B');
  select * into i from public.invoices where id = v_inv;
  if v_inv is null or i.tax_rate <> 0 or i.tax_amount <> 0 or i.gst_treatment is distinct from 'overseas' or i.amount <> 50000 then
    raise exception 'FAIL B: export invoice % rate % tax % (%)', v_inv, i.tax_rate, i.tax_amount, i.gst_treatment;
  end if;
  raise notice 'B PASS: 0%% quote abroad → export invoice at 0%%';

  -- D. 'Bharat' in another state → IGST
  select invoice_id into v_inv from public.generate_invoice('Q-R2636-D');
  select * into i from public.invoices where id = v_inv;
  if i.inter_state is distinct from true or i.tax_amount <> 9000 or i.tax_rate <> 18 then
    raise exception 'FAIL D: Bharat buyer in state 27 got inter_state % tax %', i.inter_state, i.tax_amount;
  end if;
  raise notice 'D PASS: Bharat = India, other state → IGST';

  -- E. 'Bharat' in the seller's state → CGST+SGST
  select invoice_id into v_inv from public.generate_invoice('Q-R2636-E');
  select * into i from public.invoices where id = v_inv;
  if i.inter_state is distinct from false or i.tax_amount <> 9000 then
    raise exception 'FAIL E: Bharat buyer in state 07 got inter_state % tax %', i.inter_state, i.tax_amount;
  end if;
  raise notice 'E PASS: Bharat same state → CGST+SGST';

  -- F. any other path: CGST+SGST on an export is stored as IGST
  insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                               taxable_value, tax_amount, tax_rate, inter_state)
  values ('INV-R2636-F', c_t, 'cccccccc-0000-0000-0000-000000263601', 'R2636 Peak LLC', 59000, 'pending',
          public.ist_today(), public.ist_today() + 30, 50000, 9000, 18, false);
  if (select inter_state from public.invoices where id = 'INV-R2636-F') is distinct from true then
    raise exception 'FAIL F: an export with GST was stored as CGST+SGST';
  end if;
  raise notice 'F PASS: CGST+SGST on an export becomes IGST on every path';

  -- G. export with payment of IGST → allowed
  insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                               taxable_value, tax_amount, tax_rate, inter_state)
  values ('INV-R2636-G', c_t, 'cccccccc-0000-0000-0000-000000263601', 'R2636 Peak LLC', 59000, 'pending',
          public.ist_today(), public.ist_today() + 30, 50000, 9000, 18, true);
  raise notice 'G PASS: export with IGST (WPAY) allowed';

  -- H. Zoho FY sales import session: as filed, untouched
  perform set_config('app.zoho_sale_import', 'on', true);
  insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                               taxable_value, tax_amount, tax_rate, inter_state)
  values ('INV-R2636-H', c_t, 'cccccccc-0000-0000-0000-000000263601', 'R2636 Peak LLC', 59000, 'pending',
          public.ist_today(), public.ist_today() + 30, 50000, 9000, 18, false);
  perform set_config('app.zoho_sale_import', '', true);
  if (select inter_state from public.invoices where id = 'INV-R2636-H') is distinct from false then
    raise exception 'FAIL H: the Zoho import row was changed';
  end if;
  raise notice 'H PASS: Zoho import kept as filed';
end $$;

-- C. no LUT → R-2444's refusal, unchanged
do $$
declare ok boolean := false; v_msg text; v_inv text;
begin
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000263602","role":"authenticated"}', true);
  begin
    perform public.generate_invoice('Q-R2636-C');
  exception when check_violation or raise_exception then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg ilike '%LUT%';
  end;
  if not ok then raise exception 'FAIL C: 0%% export with no LUT not refused for the LUT (msg "%")', v_msg; end if;
  raise notice 'C PASS: no LUT → R-2444 refusal';
  -- C2. no LUT, 18% export quote → IGST (export with payment needs no LUT)
  select invoice_id into v_inv from public.generate_invoice('Q-R2636-C2');
  if (select i.inter_state from public.invoices i where i.id = v_inv) is distinct from true then
    raise exception 'FAIL C2: 18%% export with no LUT not issued as IGST';
  end if;
  raise notice 'C2 PASS: no LUT, 18%% export → IGST';
end $$;

rollback;
