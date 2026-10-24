-- R-1753 — Import from a connected Zoho Books (migration 20261022080501_r1753_zoho_books_import).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/zoho_books_import_r1753.test.sql
--
-- The owner's examples (card R-1753), made-up T- data:
--   * Zoho contact T-Alpha Pvt Ltd (GSTIN, business_gst, contact T-Ravi) → a new customer,
--     registered, PAN from the GSTIN, contact person linked;
--   * a second Zoho contact with the SAME GSTIN → matched to that customer, not a second one;
--   * Zoho contact whose GSTIN is already on a customer here → "already exists", unchanged;
--   * t-alpha.in Business Starter, 5 seats, 1 Year (01/04/2026 – 31/03/2027) → one active
--     yearly subscription, MRR ₹750; a domain that already has a subscription → skipped;
--   * open invoice INV-T-009, balance ₹1,180 → an opening invoice (never GST / revenue).
--
-- What it proves:
--   1. apply: customers / contact / subscription / opening invoice written for tenant A only;
--      the run records every created id; what was read from Zoho is deleted.
--   2. The same run cannot be imported twice; a second dry run of the same data creates nothing.
--   3. Tenant isolation: tenant B cannot read A's runs or records, cannot import or undo A's
--      run; a sales role and a caller with no company are refused (fail closed).
--   4. Undo: refused while a payment is recorded on an imported invoice; after the payment is
--      deleted, undo removes exactly what the import created (existing customer untouched).

begin;

-- ── Fixtures ─────────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1753000-0000-0000-0000-0000000000a1'::uuid, 'T-R1753 A', 'r1753-a@example.in', '07', 'TQA'),
  ('c1753000-0000-0000-0000-0000000000b1'::uuid, 'T-R1753 B', 'r1753-b@example.in', '07', 'TQB');

insert into auth.users (id, email) values
  ('c1753000-0000-0000-0000-00000000a0a1', 'r1753-owner-a@example.test'),
  ('c1753000-0000-0000-0000-00000000a0a3', 'r1753-sales-a@example.test'),
  ('c1753000-0000-0000-0000-00000000b0b1', 'r1753-owner-b@example.test'),
  ('c1753000-0000-0000-0000-00000000f0f1', 'r1753-nocompany@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1753000-0000-0000-0000-00000000a0a1', 'c1753000-0000-0000-0000-0000000000a1', 'r1753-owner-a@example.in', 'owner', 'Owner A'),
  ('c1753000-0000-0000-0000-00000000a0a3', 'c1753000-0000-0000-0000-0000000000a1', 'r1753-sales-a@example.in', 'sales', 'Sales A'),
  ('c1753000-0000-0000-0000-00000000b0b1', 'c1753000-0000-0000-0000-0000000000b1', 'r1753-owner-b@example.in', 'owner', 'Owner B');

-- Already in tenant A: T-Old Traders (its GSTIN comes again from Zoho) with a subscription on t-old.in.
insert into public.customers (id, tenant_id, name, gstin, state_code) values
  ('c1753000-0000-0000-0000-0000000c0001', 'c1753000-0000-0000-0000-0000000000a1', 'T-Old Traders', '07AAACT2222B1Z3', '07');
insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, domain, start_date, renewal_date)
values ('c1753000-0000-0000-0000-0000000000a1', 'c1753000-0000-0000-0000-0000000c0001', 'T-Old Traders',
        'Google Workspace Business Starter', 'google', 3, 450, 't-old.in', '2026-01-01', '2026-12-31');

-- The finished dry runs (written by the server with the service role in the app).
insert into public.zoho_books_import_runs (id, tenant_id, org_id, since, phase, scanned_at) values
  ('c1753000-0000-0000-0000-0000000f0001', 'c1753000-0000-0000-0000-0000000000a1', '60000001', '2024-10-22', 'ready', now()),
  ('c1753000-0000-0000-0000-0000000f00b1', 'c1753000-0000-0000-0000-0000000000b1', '60000002', '2024-10-22', 'ready', now());
insert into public.zoho_books_import_records (run_id, tenant_id, kind, zoho_id, data) values
  ('c1753000-0000-0000-0000-0000000f0001', 'c1753000-0000-0000-0000-0000000000a1', 'contact', 'z-c1', '{"name":"T-Alpha Pvt Ltd"}'),
  ('c1753000-0000-0000-0000-0000000f00b1', 'c1753000-0000-0000-0000-0000000000b1', 'contact', 'z-b1', '{"name":"T-Bee"}');

create temp table r1753_payload (k text primary key, v jsonb);
grant all on r1753_payload to authenticated;
insert into r1753_payload values
  ('customers', '[
     {"zoho_id":"z-c1","name":"T-Alpha  Pvt Ltd","gstin":"07AAACT1111A1ZB","gst_treatment":"registered_regular","state":"Delhi","state_code":"07",
      "payment_terms_days":15,"customer_type":"business","contact_name":"T-Ravi","contact_email":"t-ravi@t-alpha.example","contact_phone":"9000000001","since":"2025-04-01"},
     {"zoho_id":"z-c2","name":"T-Alpha Branch","gstin":"07AAACT1111A1ZB","gst_treatment":"registered_regular","state":"Delhi","state_code":"07",
      "payment_terms_days":null,"customer_type":"business","contact_name":null,"contact_email":null,"contact_phone":null,"since":null},
     {"zoho_id":"z-c3","name":"T-Old Traders (Zoho)","gstin":"07AAACT2222B1Z3","gst_treatment":"registered_regular","state":"Delhi","state_code":"07",
      "payment_terms_days":30,"customer_type":"business","contact_name":"T-Someone","contact_email":"t-someone@t-old.example","contact_phone":null,"since":null}
   ]'),
  ('subscriptions', '[
     {"zoho_customer_id":"z-c1","customer_name":"T-Alpha Pvt Ltd","plan":"Google Workspace Business Starter","vendor":"google","seats":5,"mrr":750,
      "start_date":"2025-04-01","renewal_date":"2027-03-31","domain":"T-Alpha.in","billing_cycle":"yearly","term_months":12},
     {"zoho_customer_id":"z-c3","customer_name":"T-Old Traders","plan":"Google Workspace Business Starter","vendor":"google","seats":4,"mrr":600,
      "start_date":"2026-01-01","renewal_date":"2026-12-31","domain":"www.t-old.in","billing_cycle":"yearly","term_months":12},
     {"zoho_customer_id":"z-missing","customer_name":"T-Nobody","plan":"T-Plan","vendor":"other","seats":1,"mrr":100,
      "start_date":"2026-01-01","renewal_date":"2026-12-31","domain":"t-nobody.in","billing_cycle":"monthly","term_months":1}
   ]'),
  ('invoices', '[
     {"number":"INV-T-009","invoice_date":"2026-01-10","due_date":"2026-01-25","zoho_customer_id":"z-c2","total":1180,"balance":1180,
      "currency":"INR","gstin":null,"pos_state_code":"07"}
   ]');

-- Valid GSTINs for the fixtures above (checksum is part of the format the app enforces in TS).
do $$
begin
  if not public.gstin_checksum_ok('07AAACT1111A1ZB') or not public.gstin_checksum_ok('07AAACT2222B1Z3') then
    raise exception 'FIXTURE: a test GSTIN has a wrong checksum';
  end if;
end $$;

set local role authenticated;

-- ── 1. Import ────────────────────────────────────────────────────────────────────────────
do $$
declare v jsonb; v_c record; v_s record; v_i record; v_run record; v_old record; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1753000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.zoho_books_import_apply('c1753000-0000-0000-0000-0000000f0001',
         (select p.v from r1753_payload p where k = 'customers'),
         (select p.v from r1753_payload p where k = 'subscriptions'),
         (select p.v from r1753_payload p where k = 'invoices'));
  if (v->>'customers_created')::int <> 1 or (v->>'customers_existing')::int <> 1 or (v->>'contacts_created')::int <> 1
     or (v->>'subscriptions_created')::int <> 1 or (v->>'subscriptions_already')::int <> 1 or (v->>'subscriptions_no_customer')::int <> 1
     or (v->>'invoices_imported')::int <> 1 or (v->>'open_balance')::bigint <> 1180 or (v->>'mrr')::bigint <> 750 then
    raise exception 'FAIL 1a: import result %', v;
  end if;

  select * into v_c from public.customers where tenant_id = 'c1753000-0000-0000-0000-0000000000a1' and gstin = '07AAACT1111A1ZB';
  if v_c.name <> 'T-Alpha Pvt Ltd' or v_c.gst_treatment <> 'registered_regular' or v_c.pan <> 'AAACT1111A'
     or v_c.payment_terms_days <> 15 or v_c.state_code <> '07' or v_c.since <> '2025-04-01' then
    raise exception 'FAIL 1b: new customer wrong: %', row_to_json(v_c);
  end if;
  select count(*) into v_n from public.customers where tenant_id = 'c1753000-0000-0000-0000-0000000000a1' and gstin = '07AAACT1111A1ZB';
  if v_n <> 1 then raise exception 'FAIL 1c: same GSTIN created % customers (want 1)', v_n; end if;
  if not exists (select 1 from public.customer_contacts cc join public.contacts ct on ct.id = cc.contact_id
                  where cc.customer_id = v_c.id and cc.is_primary and ct.full_name = 'T-Ravi' and ct.email = 't-ravi@t-alpha.example') then
    raise exception 'FAIL 1d: contact person not linked';
  end if;
  select * into v_old from public.customers where id = 'c1753000-0000-0000-0000-0000000c0001';
  if v_old.name <> 'T-Old Traders' or v_old.payment_terms_days is not null then
    raise exception 'FAIL 1e: an existing customer was changed: %', row_to_json(v_old);
  end if;

  select * into v_s from public.subscriptions where tenant_id = 'c1753000-0000-0000-0000-0000000000a1' and domain = 't-alpha.in';
  if v_s.customer_id <> v_c.id or v_s.seats <> 5 or v_s.mrr <> 750 or v_s.status <> 'active' or v_s.billing_cycle <> 'yearly'
     or v_s.term_months <> 12 or v_s.start_date <> '2025-04-01' or v_s.renewal_date <> '2027-03-31' or v_s.customer_name <> 'T-Alpha Pvt Ltd' then
    raise exception 'FAIL 1f: subscription wrong: %', row_to_json(v_s);
  end if;
  select count(*) into v_n from public.subscriptions where tenant_id = 'c1753000-0000-0000-0000-0000000000a1' and domain = 't-old.in';
  if v_n <> 1 then raise exception 'FAIL 1g: t-old.in now has % subscriptions (want the 1 it had)', v_n; end if;

  select * into v_i from public.invoices where tenant_id = 'c1753000-0000-0000-0000-0000000000a1' and external_number = 'INV-T-009';
  if v_i.document_kind <> 'opening_invoice' or v_i.customer_id <> v_c.id or v_i.opening_balance <> 1180
     or coalesce(v_i.tax_amount, -1) <> 0 or public.invoice_is_sale(v_i.document_kind) then
    raise exception 'FAIL 1h: opening invoice wrong: %', row_to_json(v_i);
  end if;

  select * into v_run from public.zoho_books_import_runs where id = 'c1753000-0000-0000-0000-0000000f0001';
  if v_run.imported_at is null or v_run.imported_by <> 'c1753000-0000-0000-0000-00000000a0a1'
     or array_length(v_run.created_customer_ids, 1) <> 1 or array_length(v_run.created_subscription_ids, 1) <> 1
     or array_length(v_run.created_contact_ids, 1) <> 1 or v_run.invoice_batch_id <> v_i.import_batch_id then
    raise exception 'FAIL 1i: run row wrong: %', row_to_json(v_run);
  end if;
  if exists (select 1 from public.zoho_books_import_records where run_id = 'c1753000-0000-0000-0000-0000000f0001') then
    raise exception 'FAIL 1j: what was read from Zoho was kept after the import';
  end if;
  if exists (select 1 from public.customers where tenant_id = 'c1753000-0000-0000-0000-0000000000b1') then
    raise exception 'FAIL 1k: something was written into tenant B';
  end if;
  raise notice 'PASS 1: 1 customer (+1 same GSTIN matched, 1 existing untouched), contact, t-alpha.in 5 seats ₹750, INV-T-009 ₹1180 opening';
end $$;

-- ── 2. Not twice; a second dry run of the same data creates nothing ──────────────────────
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1753000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  begin
    perform public.zoho_books_import_apply('c1753000-0000-0000-0000-0000000f0001', '[]', '[]', '[]');
    raise exception 'FAIL 2a: the same run was imported twice';
  exception when others then
    if sqlerrm not like '%already imported%' then raise; end if;
  end;
end $$;
reset role;
insert into public.zoho_books_import_runs (id, tenant_id, org_id, since, phase, scanned_at) values
  ('c1753000-0000-0000-0000-0000000f0002', 'c1753000-0000-0000-0000-0000000000a1', '60000001', '2024-10-22', 'ready', now());
set local role authenticated;
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1753000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.zoho_books_import_apply('c1753000-0000-0000-0000-0000000f0002',
         (select p.v from r1753_payload p where k = 'customers'),
         (select p.v from r1753_payload p where k = 'subscriptions'),
         (select p.v from r1753_payload p where k = 'invoices'));
  if (v->>'customers_created')::int <> 0 or (v->>'customers_existing')::int <> 3 or (v->>'subscriptions_created')::int <> 0
     or (v->>'subscriptions_already')::int <> 2 or (v->>'invoices_imported')::int <> 0 or v->'invoices_skipped' <> '["INV-T-009"]'::jsonb then
    raise exception 'FAIL 2b: re-import created rows: %', v;
  end if;
  raise notice 'PASS 2: same run refused; a new dry run of the same data → 0 new (all already here)';
end $$;

-- ── 3. Tenant isolation and roles (fail closed) ──────────────────────────────────────────
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1753000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.zoho_books_import_runs where tenant_id = 'c1753000-0000-0000-0000-0000000000a1';
  if v_n <> 0 then raise exception 'FAIL 3a: tenant B reads % of A''s runs', v_n; end if;
  select count(*) into v_n from public.zoho_books_import_records;
  if v_n <> 1 then raise exception 'FAIL 3b: tenant B sees % records (want only its own 1)', v_n; end if;
  begin
    perform public.zoho_books_import_apply('c1753000-0000-0000-0000-0000000f0001', '[]', '[]', '[]');
    raise exception 'FAIL 3c: tenant B imported A''s run';
  exception when others then
    if sqlerrm not like '%was not found%' then raise; end if;
  end;
  begin
    perform public.zoho_books_import_undo('c1753000-0000-0000-0000-0000000f0001', 'not mine');
    raise exception 'FAIL 3d: tenant B undid A''s import';
  exception when others then
    if sqlerrm not like '%was not found%' then raise; end if;
  end;
  begin
    insert into public.zoho_books_import_runs (tenant_id, org_id, since) values ('c1753000-0000-0000-0000-0000000000b1', 'x', '2026-01-01');
    raise exception 'FAIL 3e: a browser session wrote a run row';
  exception when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c1753000-0000-0000-0000-00000000a0a3', 'role', 'authenticated')::text, true);
  begin
    perform public.zoho_books_import_apply('c1753000-0000-0000-0000-0000000f0001', '[]', '[]', '[]');
    raise exception 'FAIL 3f: a sales role imported';
  exception when others then
    if sqlerrm not like 'Only an owner, manager or accountant%' then raise; end if;
  end;
  select count(*) into v_n from public.zoho_books_import_runs;
  if v_n <> 0 then raise exception 'FAIL 3g: a sales role reads % runs', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c1753000-0000-0000-0000-00000000f0f1', 'role', 'authenticated')::text, true);
  begin
    perform public.zoho_books_import_apply('c1753000-0000-0000-0000-0000000f0001', '[]', '[]', '[]');
    raise exception 'FAIL 3h: a caller with no company imported';
  exception when others then
    if sqlerrm not like '%active user who has finished sign-in%' then raise; end if;
  end;
  begin
    perform public.zoho_books_import_undo('c1753000-0000-0000-0000-0000000f0001', 'no company');
    raise exception 'FAIL 3i: a caller with no company undid';
  exception when others then
    if sqlerrm not like '%active user who has finished sign-in%' then raise; end if;
  end;
  raise notice 'PASS 3: tenant B / sales / no-company refused; RLS hides A''s runs and records';
end $$;

-- ── 4. Undo: refused while a payment exists, then removes exactly what was created ───────
do $$
declare v jsonb; v_pay uuid; v_cust uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1753000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  select customer_id into v_cust from public.invoices where external_number = 'INV-T-009' and tenant_id = 'c1753000-0000-0000-0000-0000000000a1';
  v := public.record_multi_invoice_payment(
    v_cust, '2026-10-21', 'bank_transfer', null, 'T-UTR-1753-01', 500,
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from public.invoices where external_number = 'INV-T-009'), 'amount', 500)),
    false, null);
  v_pay := (v->'lines'->0->>'payment_id')::uuid;
  begin
    perform public.zoho_books_import_undo('c1753000-0000-0000-0000-0000000f0001', 'wrong org');
    raise exception 'FAIL 4a: undo went through while a payment is recorded';
  exception when others then
    if sqlerrm not like '%cannot be undone%' and sqlerrm not like '%cannot be removed: a payment%' then raise; end if;
  end;
  if not exists (select 1 from public.subscriptions where domain = 't-alpha.in') then
    raise exception 'FAIL 4b: a refused undo still removed the subscription';
  end if;
  insert into r1753_payload values ('pay', to_jsonb(v_pay::text));
  raise notice 'PASS 4a: undo refused while ₹500 is paid on INV-T-009';
end $$;

reset role;
delete from public.payments where id = (select (p.v #>> '{}')::uuid from r1753_payload p where k = 'pay');
update public.invoices set paid_amount = amount - opening_balance where external_number = 'INV-T-009';
set local role authenticated;

do $$
declare v jsonb; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1753000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  begin
    perform public.zoho_books_import_undo('c1753000-0000-0000-0000-0000000f0001', '');
    raise exception 'FAIL 4c: undo without a reason';
  exception when others then
    if sqlerrm not like 'Write why you are undoing%' then raise; end if;
  end;
  v := public.zoho_books_import_undo('c1753000-0000-0000-0000-0000000f0001', 'wrong org');
  if (v->>'customers_removed')::int <> 1 or (v->>'subscriptions_removed')::int <> 1 or (v->>'invoices_removed')::int <> 1 then
    raise exception 'FAIL 4d: undo result %', v;
  end if;
  if exists (select 1 from public.customers where gstin = '07AAACT1111A1ZB')
     or exists (select 1 from public.subscriptions where domain = 't-alpha.in')
     or exists (select 1 from public.invoices where external_number = 'INV-T-009')
     or exists (select 1 from public.contacts where email = 't-ravi@t-alpha.example') then
    raise exception 'FAIL 4e: undo left rows behind';
  end if;
  if not exists (select 1 from public.customers where id = 'c1753000-0000-0000-0000-0000000c0001')
     or (select count(*) from public.subscriptions where domain = 't-old.in') <> 1 then
    raise exception 'FAIL 4f: undo touched what was already here';
  end if;
  if (select undone_at from public.zoho_books_import_runs where id = 'c1753000-0000-0000-0000-0000000f0001') is null then
    raise exception 'FAIL 4g: run not marked undone';
  end if;
  begin
    perform public.zoho_books_import_undo('c1753000-0000-0000-0000-0000000f0001', 'again');
    raise exception 'FAIL 4h: undone twice';
  exception when others then
    if sqlerrm not like '%already undone%' then raise; end if;
  end;
  raise notice 'PASS 4: undo removed 1 customer, its contact, 1 subscription, 1 opening invoice; T-Old untouched';
end $$;

rollback;
