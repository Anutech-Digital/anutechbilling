-- Regression test: an invoice can only be created by the numbering path, and a refund
-- needs a money role. Migration 20260930176000 (R-042). Rolled back — safe on production.
--
--   BLOCKED  a `sales` login INSERTing straight into public.invoices
--   BLOCKED  an OWNER doing the same — the rule is about the path, not the person
--   BLOCKED  a `sales` login calling refund_payment
--   ALLOWED  generate_invoice still creating an invoice with no INSERT policy present
--   ALLOWED  an owner refunding
--
-- The two ALLOWED cases are the ones that matter most here. If dropping the policy broke
-- generate_invoice, every invoice in the product would stop — so that is asserted rather
-- than reasoned. And a refund rule that also stopped the owner would be found in minutes
-- and switched off (L103).
--
-- Fixture owns its data (L11). Ids read before the role switch, carried in the JWT (L14).

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
  values ('40420000-0000-4000-8000-000000000001', 'R042 TEST', 'r042@example.in', '07', 'R042');

insert into auth.users (id, instance_id, aud, role, email) values
  ('40420000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r042-owner@example.in'),
  ('40420000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r042-sales@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('40420000-0000-4000-8000-00000000000a', '40420000-0000-4000-8000-000000000001', 'r042-owner@example.in', 'owner', true),
  ('40420000-0000-4000-8000-00000000000b', '40420000-0000-4000-8000-000000000001', 'r042-sales@example.in', 'sales', true);

-- state_code set, because R-041 now refuses an invoice with an unknown place of supply.
insert into public.customers (id, tenant_id, name, state_code, country)
  values ('40420000-0000-4000-8000-0000000000c1', '40420000-0000-4000-8000-000000000001', 'Cust R042', '07', 'India');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                           status, payment_status, line_items)
  values ('Q-R042', '40420000-0000-4000-8000-000000000001', '40420000-0000-4000-8000-0000000000c1',
          'Cust R042', 118000, 100000, 18, 'accepted', 'awaiting', '[]'::jsonb);

/* A SECOND quote, deliberately never invoiced. refund_payment refuses a refund against a
   quote that already carries a GST invoice — credit note first — and that guard is correct
   and is not what this file is testing. Using the invoiced quote here would have the right
   outcome for the wrong reason, which is the shape L97 warns about. */
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                           status, payment_status, line_items)
  values ('Q-R042-NOINV', '40420000-0000-4000-8000-000000000001', '40420000-0000-4000-8000-0000000000c1',
          'Cust R042', 5000, 5000, 0, 'accepted', 'received', '[]'::jsonb);

do $$
declare v_err boolean; v_msg text; v_inv text; v_n int; v_pay uuid;
begin
  -- ── ALLOWED: the numbering path still works with no INSERT policy ────────
  /* Asserted first, and asserted at all, because this is what a wrong drop would break —
     and it would break EVERY invoice in the product, not an edge case. */
  select invoice_id into v_inv from public.generate_invoice('Q-R042');
  if v_inv is null then
    raise exception 'FAIL 1: generate_invoice stopped working after the INSERT policy was dropped';
  end if;
  if v_inv !~ '^INV-R042-\d{2}-\d{4}$' then
    raise exception 'FAIL 1: unexpected number shape %', v_inv;
  end if;

  -- ── BLOCKED: a direct insert, as a sales login ───────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','40420000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  v_err := false;
  begin
    insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, paid_amount, adjusted_advances)
    values ('INV-R042-27-9999', '40420000-0000-4000-8000-000000000001', '40420000-0000-4000-8000-0000000000c1',
            'Cust R042', 1, 'pending', current_date, 0, '[]'::jsonb);
  exception when others then v_err := true; end;
  if not v_err then
    raise exception 'FAIL 2: a sales login wrote an invoice number the series never issued';
  end if;

  -- ── BLOCKED: the same insert, as the OWNER ───────────────────────────────
  /* The rule is about the PATH, not the person. An owner writing a number by hand breaks
     the gapless series exactly as badly, and there is a correct route for everything they
     might want (generate_invoice, create_direct_invoice, raise_project_milestone_invoice). */
  perform set_config('request.jwt.claims', json_build_object('sub','40420000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  v_err := false;
  begin
    insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, paid_amount, adjusted_advances)
    values ('INV-R042-27-9998', '40420000-0000-4000-8000-000000000001', '40420000-0000-4000-8000-0000000000c1',
            'Cust R042', 1, 'pending', current_date, 0, '[]'::jsonb);
  exception when others then v_err := true; end;
  if not v_err then
    raise exception 'FAIL 3: an OWNER hand-wrote an invoice number outside the series';
  end if;

  select count(*) into v_n from public.invoices where id like 'INV-R042-27-999%';
  if v_n <> 0 then raise exception 'FAIL 4: % hand-written invoice row(s) survived', v_n; end if;
  reset role;

  -- ── Refunds ──────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at)
    values ('40420000-0000-4000-8000-0000000000d1', '40420000-0000-4000-8000-000000000001', 'Q-R042-NOINV',
            '40420000-0000-4000-8000-0000000000c1', 5000, 'bank_transfer', 'received', now())
    returning id into v_pay;

  -- sales: refused
  perform set_config('request.jwt.claims', json_build_object('sub','40420000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  v_err := false;
  begin
    perform public.refund_payment(v_pay, 'duplicate charge by the customer');
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then
    raise exception 'FAIL 5: a sales login sent money back and burned a Refund Voucher number';
  end if;
  /* §24 — say who CAN, or the operator has no next step. */
  if v_msg not ilike '%owner%' and v_msg not ilike '%accountant%' then
    raise exception 'FAIL 5: refusal did not name who may refund: %', v_msg;
  end if;

  -- owner: allowed. Without this the rule stops the business and gets deleted.
  perform set_config('request.jwt.claims', json_build_object('sub','40420000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  perform public.refund_payment(v_pay, 'duplicate charge by the customer');
  select count(*) into v_n from public.payments where id = v_pay and refund_voucher_no is not null;
  if v_n <> 1 then raise exception 'FAIL 6: the OWNER could not refund — the guard is too tight'; end if;

  raise notice 'PASS: invoices only via the numbering path (% issued); refunds need a money role', v_inv;
end $$;

rollback;
