-- R-2636 (9 Nov 2026, split from R-2171): quote → invoice for a customer abroad. generate_invoice took the
-- rate from the QUOTE and set inter_state = false for an export, so a quote that still charged 18% became an
-- "export" invoice with CGST+SGST — the wrong head on a zero-rated supply (and R-2444's LUT check, which is
-- only for 0%, never fired). It also counted country 'Bharat' as abroad (CGST+SGST for a buyer in another
-- state) while supply_is_zero_rated / isExportSupply say India.
-- Migration 20261109181239_r2636_export_tax_head. Self-asserting, ONE transaction, rolled back.
-- Local/test DB only. Red without the migration (A issues a CGST+SGST export, D issues CGST+SGST, F inserts,
-- I says "no state on record").
--
--   A. Customer abroad (United States) + accepted quote at 18% → refused before a number, nothing issued;
--      a second try is refused the same way.
--   B. Same customer, 0% quote → export invoice at 0% (tax 0, treatment overseas).
--   C. 0% export quote, company with NO LUT → R-2444's refusal (unchanged).
--   D. Country 'Bharat', state 27, seller 07, 18% quote → IGST (inter_state true), tax ₹9,000.
--   E. Country 'Bharat', state 07 (seller's state) → CGST+SGST 18% (inter_state false).
--   F. Any other path: an app Tax Invoice abroad carrying GST with inter_state false → refused by the trigger.
--   G. Export with payment of IGST (inter_state true, tax > 0) → not refused (legal head, GSTR-1 6A WPAY).
--   H. Zoho FY sales import session → an export row as filed with CGST+SGST is not refused.
--   I. Overseas + empty country + no state → R-2620's "pick its country" message, not "no state on record".

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
-- I: an Overseas customer that lost its country (Zoho import), no state either.
insert into public.customers (id, tenant_id, name, state_code, country, gstin, customer_type, gst_treatment, domain) values
  ('cccccccc-0000-0000-0000-000000263605','dddddddd-0000-0000-0000-000000263601','R2636 Lost Country',null,'Germany',null,'business','overseas','l2636.example');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R2636-A',  'dddddddd-0000-0000-0000-000000263601','cccccccc-0000-0000-0000-000000263601','R2636 Peak LLC',     59000, 50000, 18, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-B',  'dddddddd-0000-0000-0000-000000263601','cccccccc-0000-0000-0000-000000263601','R2636 Peak LLC',     50000, 50000,  0, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-C',  'dddddddd-0000-0000-0000-000000263602','cccccccc-0000-0000-0000-000000263604','R2636 Oslo AS',      50000, 50000,  0, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-D',  'dddddddd-0000-0000-0000-000000263601','cccccccc-0000-0000-0000-000000263602','R2636 Pune Bharat',  59000, 50000, 18, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-E',  'dddddddd-0000-0000-0000-000000263601','cccccccc-0000-0000-0000-000000263603','R2636 Delhi Bharat', 59000, 50000, 18, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2636-I',  'dddddddd-0000-0000-0000-000000263601','cccccccc-0000-0000-0000-000000263605','R2636 Lost Country', 50000, 50000,  0, 'accepted', 'received', '[]'::jsonb);
update public.customers set country = '' where id = 'cccccccc-0000-0000-0000-000000263605';

do $$
declare
  c_t constant uuid := 'dddddddd-0000-0000-0000-000000263601';
  ok boolean; v_msg text; n int; v_inv text; i record; k int;
begin
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000263601","role":"authenticated"}', true);

  -- A. 18% quote abroad → refused, twice, nothing issued
  for k in 1..2 loop
    ok := false; v_msg := null;
    begin
      perform public.generate_invoice('Q-R2636-A');
    exception when check_violation then
      get stacked diagnostics v_msg = message_text;
      ok := v_msg like 'Cannot issue this invoice: R2636 Peak LLC is a customer abroad (United States), so it is an export%0%% GST under your LUT%Q-R2636-A charges 18%% GST (₹9,000)%never CGST+SGST%Nothing was issued%new quote%0%% GST%';
      if not ok then raise exception 'FAIL A: wrong message "%"', v_msg; end if;
    end;
    if not ok then raise exception 'FAIL A: an 18%% quote abroad was invoiced (try %)', k; end if;
  end loop;
  select count(*) into n from public.invoices where tenant_id = c_t and customer_id = 'cccccccc-0000-0000-0000-000000263601';
  if n <> 0 then raise exception 'FAIL A: % invoice rows left', n; end if;
  if (select invoice_id from public.quotes where id = 'Q-R2636-A') is not null then raise exception 'FAIL A: quote marked invoiced'; end if;
  raise notice 'A PASS: 18%% quote abroad refused, nothing issued';

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

  -- F. any other path: CGST+SGST on an export refused by the trigger
  ok := false; v_msg := null;
  begin
    insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                                 taxable_value, tax_amount, tax_rate, inter_state)
    values ('INV-R2636-F', c_t, 'cccccccc-0000-0000-0000-000000263601', 'R2636 Peak LLC', 59000, 'pending',
            public.ist_today(), public.ist_today() + 30, 50000, 9000, 18, false);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'R2636 Peak LLC is a customer abroad (United States): an export invoice never carries CGST+SGST.%';
    if not ok then raise exception 'FAIL F: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL F: a CGST+SGST export invoice was inserted'; end if;
  raise notice 'F PASS: CGST+SGST on an export refused on every path';

  -- G. export with payment of IGST → allowed
  insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                               taxable_value, tax_amount, tax_rate, inter_state)
  values ('INV-R2636-G', c_t, 'cccccccc-0000-0000-0000-000000263601', 'R2636 Peak LLC', 59000, 'pending',
          public.ist_today(), public.ist_today() + 30, 50000, 9000, 18, true);
  raise notice 'G PASS: export with IGST (WPAY) allowed';

  -- H. Zoho FY sales import session: as filed, not refused
  perform set_config('app.zoho_sale_import', 'on', true);
  ok := true;
  begin
    insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                                 taxable_value, tax_amount, tax_rate, inter_state)
    values ('INV-R2636-H', c_t, 'cccccccc-0000-0000-0000-000000263601', 'R2636 Peak LLC', 59000, 'pending',
            public.ist_today(), public.ist_today() + 30, 50000, 9000, 18, false);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg not like '%never carries CGST+SGST%';
  end;
  perform set_config('app.zoho_sale_import', '', true);
  if not ok then raise exception 'FAIL H: Zoho import session refused by the R-2636 guard'; end if;
  raise notice 'H PASS: Zoho import session not refused';

  -- I. Overseas + no country + no state → the country reason
  ok := false; v_msg := null;
  begin
    perform public.generate_invoice('Q-R2636-I');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'R2636 Lost Country is marked Overseas but has no country on record%pick its country%';
    if not ok then raise exception 'FAIL I: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL I: Overseas + no country invoiced'; end if;
  raise notice 'I PASS: Overseas + no country → pick its country';
end $$;

-- C. no LUT → R-2444's refusal, unchanged
do $$
declare ok boolean := false; v_msg text;
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
end $$;

rollback;
