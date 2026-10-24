-- R-1736 (22 Oct 2026): a customer's GST treatment, PAN from GSTIN, and the SEZ head.
--
-- Owner examples (card R-1736), on the REAL invoice path (generate_invoice):
--   Delhi GSTIN, Regular, seller in Delhi        → CGST + SGST (inter_state false)
--   Delhi GSTIN, SEZ with payment, seller Delhi  → IGST        (inter_state true)
-- plus: the backfill rule fills a customer saved without a treatment, PAN = GSTIN chars
-- 3–12 only for a checksum-valid GSTIN, and the treatment frozen on the invoice cannot be
-- changed after issue.
--
-- Run in ONE rolled-back transaction (CLAUDE.md §17c). Exit 0 = pass, any FAIL raises.

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address (supplier_invoice_problem).
-- Every company this test creates gets both unless the test sets them itself (an unregistered
-- one gets only the address). Rolled back with the test.
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

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c0de1736-0000-4000-8000-000000000001', 'R1736 GST TREATMENT TEST', 'r1736@example.in', '07', 'R1736');

do $$
declare
  v_tenant uuid := 'c0de1736-0000-4000-8000-000000000001';
  v_reg    uuid := 'c0de1736-0000-4000-8000-0000000000c1';
  v_sez    uuid := 'c0de1736-0000-4000-8000-0000000000c2';
  v_ind    uuid := 'c0de1736-0000-4000-8000-0000000000c3';
  v_us     uuid := 'c0de1736-0000-4000-8000-0000000000c4';
  v_unreg  uuid := 'c0de1736-0000-4000-8000-0000000000c5';
  v_t      text;
  v_pan    text;
  v_inter  boolean;
  v_snap   text;
  v_tax    integer;
begin
  -- ── The rule (backfill + fill-on-insert) ────────────────────────────────
  insert into public.customers (id, tenant_id, name, country, state_code, gstin, customer_type)
    values (v_reg,   v_tenant, 'Delhi Regular', 'India', '07', '07AAACR5055K1Z9', 'business'),
           (v_ind,   v_tenant, 'Asha Person',   'India', '07', null,              'individual'),
           (v_us,    v_tenant, 'US Inc',        'United States', null, null,       'business'),
           (v_unreg, v_tenant, 'Kirana Store',  'India', '07', null,              'business');
  insert into public.customers (id, tenant_id, name, country, state_code, gstin, customer_type, gst_treatment)
    values (v_sez, v_tenant, 'Delhi SEZ Unit', 'India', '07', '07ABDCA0298H1ZP', 'business', 'sez_with_payment');

  select gst_treatment, pan into v_t, v_pan from public.customers where id = v_reg;
  if v_t is distinct from 'registered_regular' then raise exception 'FAIL rule: GSTIN customer got %, expected registered_regular', v_t; end if;
  if v_pan is distinct from 'AAACR5055K' then raise exception 'FAIL pan: got %, expected AAACR5055K (GSTIN chars 3–12)', v_pan; end if;
  select gst_treatment into v_t from public.customers where id = v_ind;
  if v_t is distinct from 'consumer' then raise exception 'FAIL rule: individual got %, expected consumer', v_t; end if;
  select gst_treatment into v_t from public.customers where id = v_us;
  if v_t is distinct from 'overseas' then raise exception 'FAIL rule: US customer got %, expected overseas', v_t; end if;
  select gst_treatment into v_t from public.customers where id = v_unreg;
  if v_t is distinct from 'unregistered_business' then raise exception 'FAIL rule: business without GSTIN got %, expected unregistered_business', v_t; end if;
  select gst_treatment into v_t from public.customers where id = v_sez;
  if v_t is distinct from 'sez_with_payment' then raise exception 'FAIL: an explicit SEZ treatment was overwritten (%)', v_t; end if;

  -- An invalid GSTIN never invents a PAN.
  if public.pan_from_gstin('07AAACR5055K1Z5') is not null then raise exception 'FAIL pan: bad-checksum GSTIN produced a PAN'; end if;
  -- A new GSTIN brings its own PAN.
  update public.customers set gstin = '07ABDCA0298H1ZP' where id = v_reg;
  select pan into v_pan from public.customers where id = v_reg;
  if v_pan is distinct from 'ABDCA0298H' then raise exception 'FAIL pan: GSTIN changed but PAN stayed %', v_pan; end if;
  -- PAN format is enforced.
  begin
    update public.customers set pan = 'NOTAPAN' where id = v_unreg;
    raise exception 'FAIL pan: a malformed PAN was saved';
  exception when check_violation then null;
  end;
  -- Every customer has a treatment (backfilled + NOT NULL).
  if exists (select 1 from public.customers where gst_treatment is null) then
    raise exception 'FAIL backfill: a customer has no GST treatment';
  end if;

  -- ── Owner example 1: Delhi Regular, seller Delhi → CGST + SGST ───────────
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                             line_items, status, payment_status)
    values ('TESTQ-R1736-REG', v_tenant, v_reg, 'Delhi Regular', 11800, 10000, 18, '[]'::jsonb, 'sent', 'awaiting');
  perform public.generate_invoice('TESTQ-R1736-REG');
  select inter_state, gst_treatment into v_inter, v_snap from public.invoices where quote_id = 'TESTQ-R1736-REG';
  if v_inter is distinct from false then raise exception 'FAIL example 1: Delhi regular invoice inter_state=% (expected CGST+SGST)', v_inter; end if;
  if v_snap is distinct from 'registered_regular' then raise exception 'FAIL snapshot: invoice treatment %, expected registered_regular', v_snap; end if;

  -- ── Owner example 2: Delhi SEZ with payment, seller Delhi → IGST ─────────
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                             line_items, status, payment_status)
    values ('TESTQ-R1736-SEZ', v_tenant, v_sez, 'Delhi SEZ Unit', 11800, 10000, 18, '[]'::jsonb, 'sent', 'awaiting');
  perform public.generate_invoice('TESTQ-R1736-SEZ');
  select inter_state, gst_treatment, tax_amount into v_inter, v_snap, v_tax from public.invoices where quote_id = 'TESTQ-R1736-SEZ';
  if v_inter is distinct from true then raise exception 'FAIL example 2: Delhi SEZ invoice inter_state=% (expected IGST)', v_inter; end if;
  if v_tax is distinct from 1800 then raise exception 'FAIL example 2: tax amount moved to % (expected 1800 — only the head changes)', v_tax; end if;

  -- ── A later customer edit never changes the issued invoice ───────────────
  update public.customers set gst_treatment = 'registered_regular' where id = v_sez;
  select gst_treatment into v_snap from public.invoices where quote_id = 'TESTQ-R1736-SEZ';
  if v_snap is distinct from 'sez_with_payment' then raise exception 'FAIL snapshot: invoice treatment followed the customer edit (%)', v_snap; end if;
  begin
    update public.invoices set gst_treatment = 'registered_regular' where quote_id = 'TESTQ-R1736-SEZ';
    raise exception 'FAIL freeze: an issued invoice''s gst_treatment was changed';
  exception when others then
    if sqlerrm not like '%gst_treatment%cannot be changed%' and sqlerrm not like '%cannot be changed%gst_treatment%' then
      raise exception 'FAIL freeze: wrong refusal: %', sqlerrm;
    end if;
  end;

  raise notice 'PASS: treatment rule, PAN, Delhi regular → CGST+SGST, Delhi SEZ → IGST, snapshot frozen';
end $$;

select 'PASS' as customer_gst_treatment;

rollback;
