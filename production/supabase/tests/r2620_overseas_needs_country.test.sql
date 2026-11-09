-- R-2620 (9 Nov 2026): a customer marked Overseas with no country (or country India) is read as India
-- (G5), so a NEW quote / invoice to it was taxed as a domestic sale silently. Now refused with the reason.
-- Migration 20261109050500_r2620_overseas_needs_country. Self-asserting, ONE transaction, rolled back.
-- Local/test DB only. Red without the migration (B, C, E, F issue / send with no refusal).
--
--   A. Draft quote for the Overseas + no-country customer → allowed (a draft may wait).
--   B. Quote inserted as sent → refused "… marked Overseas but has no country on record … quote …".
--   C. A draft flipped to sent → refused the same way.
--   D. A quote sent earlier (while the country was set) → accepted later → not stopped.
--   E. Quote → invoice (generate_invoice) for that customer → refused "… this invoice …"; no invoice row.
--   F. Overseas + country India → refused "its country is India".
--   G. Overseas + United States → sent and invoiced at 0% under the LUT (export path unchanged).
--   H. Domestic customer with an empty country → sent and invoiced at 18% (empty = India is right here).
--   I. Zoho FY sales import session (app.zoho_sale_import = on) → the same customer's quote / invoice
--      is not refused (it records a sale already filed).
--   J. overseas_country_missing() truth table.

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
  ('dddddddd-0000-0000-0000-000000262001','R2620 Exporter','r2620@example.in','07','X620','AD070426002620X','2027-03-31');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000262001','owner2620@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000262001','dddddddd-0000-0000-0000-000000262001','owner2620@example.in','Owner 2620','owner', now() - interval '1 day');
-- c1 starts with its country (and a state, the silent case — with no state generate_invoice already
-- refused as "no state") so its earlier quotes (D, E, I) can be sent; the country is blanked below, like a
-- Zoho-imported customer that lost it.
insert into public.customers (id, tenant_id, name, state_code, country, gstin, customer_type, gst_treatment, domain) values
  ('cccccccc-0000-0000-0000-000000262001','dddddddd-0000-0000-0000-000000262001','R2620 Design Studio','27','United States',null,'business','overseas','d2620.example'),
  ('cccccccc-0000-0000-0000-000000262002','dddddddd-0000-0000-0000-000000262001','R2620 India Overseas',null,'India',null,'business','overseas','i2620.example'),
  ('cccccccc-0000-0000-0000-000000262003','dddddddd-0000-0000-0000-000000262001','R2620 US Client LLC',null,'United States',null,'business','overseas','u2620.example'),
  ('cccccccc-0000-0000-0000-000000262004','dddddddd-0000-0000-0000-000000262001','R2620 Delhi Shop','07','',null,'business','unregistered_business','s2620.example');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R2620-SENT', 'dddddddd-0000-0000-0000-000000262001','cccccccc-0000-0000-0000-000000262001','R2620 Design Studio', 50000, 50000, 0, 'sent',     'none',  '[]'::jsonb),
  ('Q-R2620-ACC',  'dddddddd-0000-0000-0000-000000262001','cccccccc-0000-0000-0000-000000262001','R2620 Design Studio', 50000, 50000, 0, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2620-ZOHO', 'dddddddd-0000-0000-0000-000000262001','cccccccc-0000-0000-0000-000000262001','R2620 Design Studio', 50000, 50000, 0, 'accepted', 'received', '[]'::jsonb);
update public.customers set country = '' where id = 'cccccccc-0000-0000-0000-000000262001';

do $$
declare
  c_t constant uuid := 'dddddddd-0000-0000-0000-000000262001';
  ok boolean; v_msg text; n int; v_inv text; i record;
begin
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000262001","role":"authenticated"}', true);

  -- A. draft allowed
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, line_items)
  values ('Q-R2620-DRAFT', c_t, 'cccccccc-0000-0000-0000-000000262001', 'R2620 Design Studio', 59000, 50000, 18, 'draft', '[]'::jsonb);
  raise notice 'A PASS: draft quote for Overseas + no country saved';

  -- B. inserted as sent → refused
  ok := false;
  begin
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, line_items)
    values ('Q-R2620-B', c_t, 'cccccccc-0000-0000-0000-000000262001', 'R2620 Design Studio', 59000, 50000, 18, 'sent', '[]'::jsonb);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'R2620 Design Studio is marked Overseas but has no country on record, so this quote would be taxed as an Indian sale.%pick its country%';
    if not ok then raise exception 'FAIL B: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL B: a sent quote for Overseas + no country was saved'; end if;
  raise notice 'B PASS: sent quote refused with the reason';

  -- C. draft → sent refused
  ok := false;
  begin
    update public.quotes set status = 'sent' where id = 'Q-R2620-DRAFT';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%marked Overseas but has no country on record%quote%';
  end;
  if not ok then raise exception 'FAIL C: a draft for Overseas + no country was sent (msg "%")', v_msg; end if;
  raise notice 'C PASS: draft → sent refused';

  -- D. sent earlier → accepted later: not stopped
  update public.quotes set status = 'accepted' where id = 'Q-R2620-SENT';
  raise notice 'D PASS: a quote already sent can still be accepted';

  -- E. quote → invoice refused, nothing issued
  ok := false;
  begin
    perform public.generate_invoice('Q-R2620-ACC');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'R2620 Design Studio is marked Overseas but has no country on record, so this invoice would be taxed as an Indian sale.%';
    if not ok then raise exception 'FAIL E: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL E: an invoice was issued to Overseas + no country'; end if;
  select count(*) into n from public.invoices where tenant_id = c_t and customer_id = 'cccccccc-0000-0000-0000-000000262001';
  if n <> 0 then raise exception 'FAIL E: % invoice rows left', n; end if;
  raise notice 'E PASS: invoice refused, none issued';

  -- F. Overseas + India refused
  ok := false;
  begin
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, line_items)
    values ('Q-R2620-F', c_t, 'cccccccc-0000-0000-0000-000000262002', 'R2620 India Overseas', 59000, 50000, 18, 'sent', '[]'::jsonb);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'R2620 India Overseas is marked Overseas but its country is India%';
  end;
  if not ok then raise exception 'FAIL F: Overseas + India not refused (msg "%")', v_msg; end if;
  raise notice 'F PASS: Overseas + India refused';

  -- G. Overseas + US: sent + invoiced at 0% under the LUT
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R2620-G', c_t, 'cccccccc-0000-0000-0000-000000262003', 'R2620 US Client LLC', 50000, 50000, 0, 'accepted', 'received', '[]'::jsonb);
  select invoice_id into v_inv from public.generate_invoice('Q-R2620-G');
  select * into i from public.invoices where id = v_inv;
  if v_inv is null or i.tax_rate <> 0 or i.gst_treatment is distinct from 'overseas' then
    raise exception 'FAIL G: export invoice % at % (%)', v_inv, i.tax_rate, i.gst_treatment;
  end if;
  raise notice 'G PASS: Overseas + US invoiced at 0%%';

  -- H. domestic, empty country: 18%
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R2620-H', c_t, 'cccccccc-0000-0000-0000-000000262004', 'R2620 Delhi Shop', 59000, 50000, 18, 'accepted', 'received', '[]'::jsonb);
  select invoice_id into v_inv from public.generate_invoice('Q-R2620-H');
  if v_inv is null or (select tax_rate from public.invoices where id = v_inv) <> 18 then
    raise exception 'FAIL H: domestic blank-country invoice not issued at 18%%';
  end if;
  raise notice 'H PASS: domestic customer with empty country unchanged';

  -- I. Zoho FY sales import session: not refused
  perform set_config('app.zoho_sale_import', 'on', true);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R2620-I', c_t, 'cccccccc-0000-0000-0000-000000262001', 'R2620 Design Studio', 50000, 50000, 0, 'accepted', 'received', '[]'::jsonb);
  ok := true;
  begin
    perform public.generate_invoice('Q-R2620-ZOHO');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg not like '%marked Overseas%';
  end;
  perform set_config('app.zoho_sale_import', '', true);
  if not ok then raise exception 'FAIL I: the Zoho import session was refused by the R-2620 guard'; end if;
  raise notice 'I PASS: Zoho import session not refused';

  -- J. truth table
  if not public.overseas_country_missing('overseas', null) or not public.overseas_country_missing('overseas', '  ')
     or not public.overseas_country_missing('overseas', 'IN') or public.overseas_country_missing('overseas', 'UAE')
     or public.overseas_country_missing('sez_with_payment', '') or public.overseas_country_missing(null, '') then
    raise exception 'FAIL J: overseas_country_missing truth table';
  end if;
  raise notice 'J PASS: overseas_country_missing';
end $$;

rollback;
