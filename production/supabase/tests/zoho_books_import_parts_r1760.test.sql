-- R-1760 — Zoho Books import in parts (migration 20261022113730_r1760_zoho_books_import_in_parts).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/zoho_books_import_parts_r1760.test.sql
--
-- The owner's case (card R-1760, 22 Oct): a finished dry run of ~1,245 new customers, ~1,371
-- live subscriptions and ~246 open invoices. One call (R-1753's zoho_books_import_apply) took
-- 8.7 s here and the role's 8 s statement_timeout cancelled it — nothing imported. Made-up
-- T- data at that size: 1,300 + 3 contacts, 1,400 + 3 subscriptions, 250 + 1 invoices.
--
-- What it proves:
--   1. begin freezes the plan and sets the cursor; begin again changes nothing.
--   2. Every part (150 rows) finishes far under the 8 s timeout; the import needs many parts;
--      imported_at is set only after the last one; the result matches R-1753's rules (same
--      GSTIN → one customer, existing one untouched, domain already here skipped).
--   3. A part that fails leaves nothing behind and the cursor where it was; after the bad row
--      is fixed, Continue finishes the import — no duplicate customer / subscription / invoice.
--      A part replayed over customers already imported creates nothing (idempotent per Zoho id).
--   4. Tenant B, a sales role and a caller with no company are refused (fail closed);
--      R-1753's one-call apply cannot finish an import begun in parts.
--   5. Undo removes everything every part created (all invoice batches), within the timeout;
--      the customer that was already here is untouched. A half-finished import can be undone.

begin;

-- ── Fixtures ─────────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1760000-0000-0000-0000-0000000000a1'::uuid, 'T-R1760 A', 'r1760-a@example.in', '07', 'TRA'),
  ('c1760000-0000-0000-0000-0000000000b1'::uuid, 'T-R1760 B', 'r1760-b@example.in', '07', 'TRB');

insert into auth.users (id, email) values
  ('c1760000-0000-0000-0000-00000000a0a1', 'r1760-owner-a@example.test'),
  ('c1760000-0000-0000-0000-00000000a0a3', 'r1760-sales-a@example.test'),
  ('c1760000-0000-0000-0000-00000000b0b1', 'r1760-owner-b@example.test'),
  ('c1760000-0000-0000-0000-00000000f0f1', 'r1760-nocompany@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1760000-0000-0000-0000-00000000a0a1', 'c1760000-0000-0000-0000-0000000000a1', 'r1760-owner-a@example.in', 'owner', 'Owner A'),
  ('c1760000-0000-0000-0000-00000000a0a3', 'c1760000-0000-0000-0000-0000000000a1', 'r1760-sales-a@example.in', 'sales', 'Sales A'),
  ('c1760000-0000-0000-0000-00000000b0b1', 'c1760000-0000-0000-0000-0000000000b1', 'r1760-owner-b@example.in', 'owner', 'Owner B');

-- Already in tenant A: T-Old Traders (its GSTIN comes again from Zoho) with a subscription on t-old.in.
insert into public.customers (id, tenant_id, name, gstin, state_code) values
  ('c1760000-0000-0000-0000-0000000c0001', 'c1760000-0000-0000-0000-0000000000a1', 'T-Old Traders', '07AAACT2222B1Z3', '07');
insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, domain, start_date, renewal_date)
values ('c1760000-0000-0000-0000-0000000000a1', 'c1760000-0000-0000-0000-0000000c0001', 'T-Old Traders',
        'Google Workspace Business Starter', 'google', 3, 450, 't-old.in', '2026-01-01', '2026-12-31');

-- Finished dry runs (written by the server with the service role in the app).
insert into public.zoho_books_import_runs (id, tenant_id, org_id, since, phase, scanned_at) values
  ('c1760000-0000-0000-0000-0000000f0001', 'c1760000-0000-0000-0000-0000000000a1', '60000001', '2024-10-22', 'ready', now()),
  ('c1760000-0000-0000-0000-0000000f00b1', 'c1760000-0000-0000-0000-0000000000b1', '60000002', '2024-10-22', 'ready', now());
insert into public.zoho_books_import_records (run_id, tenant_id, kind, zoho_id, data) values
  ('c1760000-0000-0000-0000-0000000f0001', 'c1760000-0000-0000-0000-0000000000a1', 'contact', 'z-c1', '{"name":"T-Alpha Pvt Ltd"}');

create temp table r1760_payload (k text primary key, v jsonb);
grant all on r1760_payload to authenticated;
-- The R-1753 cases first, then the bulk (the order the plan sends: every contact).
insert into r1760_payload
select 'customers', '[
     {"zoho_id":"z-c1","name":"T-Alpha  Pvt Ltd","gstin":"07AAACT1111A1ZB","gst_treatment":"registered_regular","state":"Delhi","state_code":"07",
      "payment_terms_days":15,"customer_type":"business","contact_name":"T-Ravi","contact_email":"t-ravi@t-alpha.example","contact_phone":"9000000001","since":"2025-04-01"},
     {"zoho_id":"z-c2","name":"T-Alpha Branch","gstin":"07AAACT1111A1ZB","gst_treatment":"registered_regular","state":"Delhi","state_code":"07",
      "payment_terms_days":null,"customer_type":"business","contact_name":null,"contact_email":null,"contact_phone":null,"since":null},
     {"zoho_id":"z-c3","name":"T-Old Traders (Zoho)","gstin":"07AAACT2222B1Z3","gst_treatment":"registered_regular","state":"Delhi","state_code":"07",
      "payment_terms_days":30,"customer_type":"business","contact_name":"T-Someone","contact_email":"t-someone@t-old.example","contact_phone":null,"since":null}
   ]'::jsonb
   || (select jsonb_agg(jsonb_build_object(
         'zoho_id', 'z-' || g, 'name', 'T-R1760 Customer ' || g, 'gstin', null, 'gst_treatment', null,
         'state', 'Delhi', 'state_code', '07', 'payment_terms_days', 15, 'customer_type', 'business',
         'contact_name', 'T-Person ' || g, 'contact_email', 't-person' || g || '@r1760.example', 'contact_phone', null,
         'since', '2025-04-01') order by g)
       from generate_series(1, 1300) g);
insert into r1760_payload
select 'subscriptions', '[
     {"zoho_customer_id":"z-c1","customer_name":"T-Alpha Pvt Ltd","plan":"Google Workspace Business Starter","vendor":"google","seats":5,"mrr":750,
      "start_date":"2025-04-01","renewal_date":"2027-03-31","domain":"T-Alpha.in","billing_cycle":"yearly","term_months":12},
     {"zoho_customer_id":"z-c3","customer_name":"T-Old Traders","plan":"Google Workspace Business Starter","vendor":"google","seats":4,"mrr":600,
      "start_date":"2026-01-01","renewal_date":"2026-12-31","domain":"www.t-old.in","billing_cycle":"yearly","term_months":12},
     {"zoho_customer_id":"z-missing","customer_name":"T-Nobody","plan":"T-Plan","vendor":"other","seats":1,"mrr":100,
      "start_date":"2026-01-01","renewal_date":"2026-12-31","domain":"t-nobody.in","billing_cycle":"monthly","term_months":1}
   ]'::jsonb
   || (select jsonb_agg(jsonb_build_object(
         'zoho_customer_id', 'z-' || (1 + (g - 1) % 1300), 'customer_name', 'x', 'plan', 'Google Workspace Business Starter',
         'vendor', 'google', 'seats', 5, 'mrr', 750, 'start_date', '2025-04-01', 'renewal_date', '2027-03-31',
         'domain', 't-r1760-' || g || '.in', 'billing_cycle', 'yearly', 'term_months', 12) order by g)
       from generate_series(1, 1400) g);
insert into r1760_payload
select 'invoices', '[
     {"number":"INV-T-009","invoice_date":"2026-01-10","due_date":"2026-01-25","zoho_customer_id":"z-c2","total":1180,"balance":1180,
      "currency":"INR","gstin":null,"pos_state_code":"07"}
   ]'::jsonb
   || (select jsonb_agg(jsonb_build_object(
         'number', 'INV-T1760-' || g, 'invoice_date', '2026-01-10', 'due_date', '2026-01-25', 'zoho_customer_id', 'z-' || g,
         'total', 1180, 'balance', 1000, 'currency', 'INR', 'gstin', null, 'pos_state_code', '07') order by g)
       from generate_series(1, 250) g);

-- A bad subscription row in a LATER part (seats 0): that part must fail and leave nothing.
update r1760_payload set v = jsonb_set(v, '{900,seats}', '0'::jsonb) where k = 'subscriptions';

create temp table r1760_times (part int, stage text, ms numeric);
grant all on r1760_times to authenticated;

set local role authenticated;

-- ── 1. Begin ─────────────────────────────────────────────────────────────────────────────
do $$
declare v jsonb; v2 jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1760000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  begin
    perform public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0001', 150);
    raise exception 'FAIL 1a: a step ran before the import began';
  exception when others then
    if sqlerrm not like 'The import has not started%' then raise; end if;
  end;
  v := public.zoho_books_import_begin('c1760000-0000-0000-0000-0000000f0001',
         (select p.v from r1760_payload p where k = 'customers'),
         (select p.v from r1760_payload p where k = 'subscriptions'),
         (select p.v from r1760_payload p where k = 'invoices'));
  if v->>'stage' <> 'customers' or (v->>'offset')::int <> 0 or (v->'totals'->>'customers')::int <> 1303
     or (v->'totals'->>'subscriptions')::int <> 1403 or (v->'totals'->>'invoices')::int <> 251 or (v->>'done')::boolean then
    raise exception 'FAIL 1b: begin %', v;
  end if;
  perform public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0001', 150);
  v2 := public.zoho_books_import_begin('c1760000-0000-0000-0000-0000000f0001', '[]', '[]', '[]');
  if v2->>'stage' <> 'customers' or (v2->>'offset')::int <> 150 or (v2->'totals'->>'customers')::int <> 1303 then
    raise exception 'FAIL 1c: begin again reset the import: %', v2;
  end if;
  if (select imported_at from public.zoho_books_import_runs where id = 'c1760000-0000-0000-0000-0000000f0001') is not null then
    raise exception 'FAIL 1d: imported_at set after the first part';
  end if;
  raise notice 'PASS 1: begin froze 1,303 / 1,403 / 251; begin again kept offset 150';
end $$;

-- ── 3a. A part replayed over customers already imported creates nothing ──────────────────
reset role;
update public.zoho_books_import_runs set import_offset = 0 where id = 'c1760000-0000-0000-0000-0000000f0001';
set local role authenticated;
do $$
declare v jsonb; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1760000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0001', 150);
  select count(*) into v_n from public.customers where tenant_id = 'c1760000-0000-0000-0000-0000000000a1';
  -- T-Old + T-Alpha + 147 bulk (z-c2 matched T-Alpha, z-c3 matched T-Old) = 149.
  if v_n <> 149 or (v->>'offset')::int <> 150 then
    raise exception 'FAIL 3a: replaying the first part made % customers (want 149), offset %', v_n, v->>'offset';
  end if;
  raise notice 'PASS 3a: first part replayed — still 149 customers, no duplicate';
end $$;

-- ── 2 + 3. Parts until the bad row; each part timed ──────────────────────────────────────
do $$
declare v jsonb; v_t0 timestamptz; v_part int := 1; v_failed boolean := false; v_off int; v_stage text; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1760000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  loop
    v_part := v_part + 1;
    select import_stage, import_offset into v_stage, v_off from public.zoho_books_import_runs where id = 'c1760000-0000-0000-0000-0000000f0001';
    v_t0 := clock_timestamp();
    begin
      v := public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0001', 150);
    exception when others then
      if sqlerrm not like 'Subscription t-r1760-898.in has no seats%' then raise; end if;
      v_failed := true;
    end;
    insert into r1760_times values (v_part, v_stage, extract(epoch from clock_timestamp() - v_t0) * 1000);
    exit when v_failed or (v->>'done')::boolean or v_part > 60;
  end loop;
  if not v_failed then raise exception 'FAIL 3b: the bad subscription row did not stop its part'; end if;
  -- Cursor still at the start of the failed part; nothing of that part written.
  select import_stage, import_offset into v_stage, v_off from public.zoho_books_import_runs where id = 'c1760000-0000-0000-0000-0000000f0001';
  if v_stage <> 'subscriptions' or v_off <> 900 then
    raise exception 'FAIL 3c: after the failed part the cursor is % %, want subscriptions 900', v_stage, v_off;
  end if;
  select count(*) into v_n from public.subscriptions where tenant_id = 'c1760000-0000-0000-0000-0000000000a1';
  -- t-old (here before) + the 898 created from plan rows 1..900 (t-old skipped, z-missing has no customer) = 899.
  if v_n <> 899 then raise exception 'FAIL 3d: % subscriptions after the failed part (want 899)', v_n; end if;
  if (select array_length(created_subscription_ids, 1) from public.zoho_books_import_runs where id = 'c1760000-0000-0000-0000-0000000f0001') <> 898 then
    raise exception 'FAIL 3e: the run lost or gained created subscription ids';
  end if;
  raise notice 'PASS 3b: part at subscriptions 900 failed (row 901 has no seats) — cursor kept, nothing of it written';
end $$;

-- Fix the bad row the way a new plan would carry it, then Continue.
reset role;
update public.zoho_books_import_runs
   set import_plan = jsonb_set(import_plan, '{subscriptions,900,seats}', '5'::jsonb)
 where id = 'c1760000-0000-0000-0000-0000000f0001';
set local role authenticated;

do $$
declare v jsonb; v_t0 timestamptz; v_part int := 100; v_stage text; v_n int; v_max numeric; v_parts int; v_run record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1760000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  loop
    v_part := v_part + 1;
    select import_stage into v_stage from public.zoho_books_import_runs where id = 'c1760000-0000-0000-0000-0000000f0001';
    v_t0 := clock_timestamp();
    v := public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0001', 150);
    insert into r1760_times values (v_part, v_stage, extract(epoch from clock_timestamp() - v_t0) * 1000);
    exit when (v->>'done')::boolean or v_part > 160;
    if (select imported_at from public.zoho_books_import_runs where id = 'c1760000-0000-0000-0000-0000000f0001') is not null then
      raise exception 'FAIL 2a: imported_at set before the last part';
    end if;
  end loop;
  if not (v->>'done')::boolean then raise exception 'FAIL 2b: the import never finished: %', v; end if;

  select max(ms), count(*) into v_max, v_parts from r1760_times;
  raise notice 'Parts: %, slowest % ms; by stage: %', v_parts, round(v_max),
    (select string_agg(format('%s max %s ms', stage, round(m)), ', ') from (select stage, max(ms) m from r1760_times group by stage) s);
  if v_parts < 15 then raise exception 'FAIL 2c: only % parts — the import was not split', v_parts; end if;
  -- The role's timeout is 8 s; a part must stay well under it (also on a slower server).
  if v_max > 3000 then raise exception 'FAIL 2d: a part took % ms (want under 3,000 — the role timeout is 8,000)', round(v_max); end if;

  v := v->'result';
  if (v->>'customers_created')::int <> 1301 or (v->>'customers_existing')::int <> 1 or (v->>'contacts_created')::int <> 1301
     or (v->>'subscriptions_created')::int <> 1401 or (v->>'subscriptions_already')::int <> 1 or (v->>'subscriptions_no_customer')::int <> 1
     or (v->>'invoices_imported')::int <> 251 or (v->>'open_balance')::bigint <> 1180 + 250 * 1000
     or (v->>'mrr')::bigint <> 1401 * 750 or jsonb_array_length(v->'invoice_batch_ids') <> 2 then
    raise exception 'FAIL 2e: import result %', v;
  end if;

  -- No duplicates anywhere.
  select count(*) into v_n from (select name from public.customers where tenant_id = 'c1760000-0000-0000-0000-0000000000a1' group by name having count(*) > 1) d;
  if v_n <> 0 then raise exception 'FAIL 3f: % customer names twice', v_n; end if;
  select count(*) into v_n from public.customers where tenant_id = 'c1760000-0000-0000-0000-0000000000a1';
  if v_n <> 1302 then raise exception 'FAIL 3g: % customers (want 1,301 new + T-Old)', v_n; end if;
  select count(*) into v_n from (select domain from public.subscriptions where tenant_id = 'c1760000-0000-0000-0000-0000000000a1' group by domain having count(*) > 1) d;
  if v_n <> 0 then raise exception 'FAIL 3h: % domains twice', v_n; end if;
  select count(*) into v_n from public.subscriptions where tenant_id = 'c1760000-0000-0000-0000-0000000000a1';
  if v_n <> 1402 then raise exception 'FAIL 3i: % subscriptions (want 1,401 new + t-old)', v_n; end if;
  select count(*) into v_n from public.invoices where tenant_id = 'c1760000-0000-0000-0000-0000000000a1' and document_kind = 'opening_invoice';
  if v_n <> 251 then raise exception 'FAIL 3j: % opening invoices (want 251)', v_n; end if;
  if (select count(*) from public.customers where tenant_id = 'c1760000-0000-0000-0000-0000000000a1' and gstin = '07AAACT1111A1ZB') <> 1 then
    raise exception 'FAIL 2f: the same GSTIN made two customers';
  end if;
  if (select name from public.customers where id = 'c1760000-0000-0000-0000-0000000c0001') <> 'T-Old Traders' then
    raise exception 'FAIL 2g: an existing customer was changed';
  end if;
  -- Subscriptions of later parts found customers made by earlier parts.
  if not exists (select 1 from public.subscriptions s join public.customers c on c.id = s.customer_id
                  where s.domain = 't-r1760-1400.in' and c.name = 'T-R1760 Customer 100') then
    raise exception 'FAIL 2h: a subscription did not find its customer from an earlier part';
  end if;

  select * into v_run from public.zoho_books_import_runs where id = 'c1760000-0000-0000-0000-0000000f0001';
  if v_run.imported_at is null or v_run.import_stage <> 'done' or v_run.import_plan is not null
     or array_length(v_run.created_customer_ids, 1) <> 1301 or array_length(v_run.created_subscription_ids, 1) <> 1401
     or array_length(v_run.invoice_batch_ids, 1) <> 2 or v_run.invoice_batch_id <> v_run.invoice_batch_ids[1] then
    raise exception 'FAIL 2i: run row wrong: stage % ids % / % batches %', v_run.import_stage,
      array_length(v_run.created_customer_ids, 1), array_length(v_run.created_subscription_ids, 1), v_run.invoice_batch_ids;
  end if;
  if exists (select 1 from public.zoho_books_import_records where run_id = 'c1760000-0000-0000-0000-0000000f0001') then
    raise exception 'FAIL 2j: what was read from Zoho was kept after the import';
  end if;
  -- A lost answer to the last part: asking again returns the same result, imports nothing.
  v := public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0001', 150);
  if not (v->>'done')::boolean or (select count(*) from public.customers where tenant_id = 'c1760000-0000-0000-0000-0000000000a1') <> 1302 then
    raise exception 'FAIL 2k: a step after the end changed something: %', v;
  end if;
  raise notice 'PASS 2+3: % parts, slowest % ms; 1,301 customers, 1,401 subscriptions, 251 invoices; no duplicate', v_parts, round(v_max);
end $$;

-- ── 4. Tenant isolation, roles, one-call apply over parts ────────────────────────────────
reset role;
insert into public.zoho_books_import_runs (id, tenant_id, org_id, since, phase, scanned_at) values
  ('c1760000-0000-0000-0000-0000000f0002', 'c1760000-0000-0000-0000-0000000000a1', '60000001', '2024-10-22', 'ready', now());
set local role authenticated;
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1760000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  begin
    perform public.zoho_books_import_begin('c1760000-0000-0000-0000-0000000f0002', '[]', '[]', '[]');
    raise exception 'FAIL 4a: tenant B began A''s import';
  exception when others then
    if sqlerrm not like '%was not found%' then raise; end if;
  end;
  begin
    perform public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0002', 150);
    raise exception 'FAIL 4b: tenant B stepped A''s import';
  exception when others then
    if sqlerrm not like '%was not found%' then raise; end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1760000-0000-0000-0000-00000000a0a3', 'role', 'authenticated')::text, true);
  begin
    perform public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0002', 150);
    raise exception 'FAIL 4c: a sales role imported';
  exception when others then
    if sqlerrm not like 'Only an owner, manager or accountant%' then raise; end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1760000-0000-0000-0000-00000000f0f1', 'role', 'authenticated')::text, true);
  begin
    perform public.zoho_books_import_begin('c1760000-0000-0000-0000-0000000f0002', '[]', '[]', '[]');
    raise exception 'FAIL 4d: a caller with no company began';
  exception when others then
    if sqlerrm not like '%active user who has finished sign-in%' then raise; end if;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c1760000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.zoho_books_import_begin('c1760000-0000-0000-0000-0000000f0002',
         '[{"zoho_id":"z-p1","name":"T-R1760 Partial One","gstin":null,"customer_type":"business"},
           {"zoho_id":"z-p2","name":"T-R1760 Partial Two","gstin":null,"customer_type":"business"}]',
         '[]', '[]');
  begin
    perform public.zoho_books_import_apply('c1760000-0000-0000-0000-0000000f0002', '[]', '[]', '[]');
    raise exception 'FAIL 4e: R-1753 apply finished an import begun in parts';
  exception when others then
    if sqlerrm not like 'This import is running in parts%' then raise; end if;
  end;
  v := public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0002', 1);
  if (v->>'offset')::int <> 1 or (v->>'done')::boolean then raise exception 'FAIL 4f: partial step %', v; end if;
  raise notice 'PASS 4: tenant B / sales / no-company refused; R-1753 apply refused over parts';
end $$;

-- ── 5. Undo: everything of every part; a half-finished import too ────────────────────────
do $$
declare v jsonb; v_t0 timestamptz; v_ms numeric; v_max numeric := 0; v_calls int := 0; v_run record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1760000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  loop
    v_calls := v_calls + 1;
    v_t0 := clock_timestamp();
    v := public.zoho_books_import_undo('c1760000-0000-0000-0000-0000000f0001', 'wrong org');
    v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;
    v_max := greatest(v_max, v_ms);
    exit when (v->>'done')::boolean or v_calls > 20;
    -- While the undo is half way, the import cannot be continued and is not marked undone.
    if (select undone_at from public.zoho_books_import_runs where id = 'c1760000-0000-0000-0000-0000000f0001') is not null then
      raise exception 'FAIL 5h: marked undone before everything was removed';
    end if;
    begin
      perform public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0001', 150);
      raise exception 'FAIL 5i: a step ran while the import was being undone';
    exception when others then
      if sqlerrm not like 'This import is being undone%' and sqlerrm not like 'This import was undone%' then raise; end if;
    end;
  end loop;
  raise notice 'Undo of 1,301 customers: % calls, slowest % ms', v_calls, round(v_max);
  if not (v->>'done')::boolean then raise exception 'FAIL 5j: undo never finished: %', v; end if;
  if v_max > 4500 then raise exception 'FAIL 5a: an undo call took % ms (the role timeout is 8,000)', round(v_max); end if;
  if (v->>'customers_removed')::int <> 1301 or (v->>'subscriptions_removed')::int <> 1401 or (v->>'invoices_removed')::int <> 251 then
    raise exception 'FAIL 5b: undo result %', v;
  end if;
  if (select count(*) from public.customers where tenant_id = 'c1760000-0000-0000-0000-0000000000a1' and name like 'T-R1760 Customer%') <> 0
     or exists (select 1 from public.customers where gstin = '07AAACT1111A1ZB')
     or (select count(*) from public.subscriptions where tenant_id = 'c1760000-0000-0000-0000-0000000000a1') <> 1
     or exists (select 1 from public.invoices where tenant_id = 'c1760000-0000-0000-0000-0000000000a1')
     or exists (select 1 from public.contacts where email like 't-person%@r1760.example') then
    raise exception 'FAIL 5c: undo left rows behind';
  end if;
  if not exists (select 1 from public.customers where id = 'c1760000-0000-0000-0000-0000000c0001') then
    raise exception 'FAIL 5d: undo removed the customer that was already here';
  end if;

  -- Half-finished import (1 of 2 customers): undo takes it back and closes the run.
  v := public.zoho_books_import_undo('c1760000-0000-0000-0000-0000000f0002', 'stopped half way');
  if (v->>'customers_removed')::int <> 1 or exists (select 1 from public.customers where name like 'T-R1760 Partial%') then
    raise exception 'FAIL 5e: half-finished undo %', v;
  end if;
  select * into v_run from public.zoho_books_import_runs where id = 'c1760000-0000-0000-0000-0000000f0002';
  if v_run.undone_at is null or v_run.imported_at is null or v_run.import_stage <> 'done' then
    raise exception 'FAIL 5f: half-finished run not closed (a new dry run would be blocked)';
  end if;
  begin
    perform public.zoho_books_import_step('c1760000-0000-0000-0000-0000000f0002', 150);
    raise exception 'FAIL 5g: an undone import continued';
  exception when others then
    if sqlerrm not like 'This import was undone%' then raise; end if;
  end;
  raise notice 'PASS 5: undo removed 1,301 customers, 1,401 subscriptions, 251 invoices (2 batches) in % calls (slowest % ms); half-finished undo closes the run', v_calls, round(v_max);
end $$;

rollback;
