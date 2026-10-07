-- Regression test: R-395 — a portal customer cannot read tenant secrets or our margin/internal
-- notes, and current_customer_id() refuses to guess (migration 20261007233000_customer_rls_leaks).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/customer_portal_rls_leaks.test.sql
--
-- Proves, as a signed-in CUSTOMER (customer_users row, no public.users row):
--   1. tenants: no direct row at all (attendance_ingest_key unreachable); portal_my_tenant()
--      returns the display fields and has no secret column.
--   2. quotes: no direct row (total_cost / notes / payment_notes unreachable); portal_my_quotes()
--      returns own non-draft quotes only, with no cost column and no line_items[].cost.
--   3. subscriptions: no direct row (write_off_reason unreachable); portal_my_subscriptions()
--      returns own rows with the basic fields.
--   4. Own invoices, payments and own customer row are STILL readable; another customer's are not.
--   5. Two links + no selection → current_customer_id() is NULL and nothing is readable; a
--      server claim selecting one of the user's OWN customers works; a claim naming a customer the
--      user is not linked to is ignored.
-- And for everyone else:
--   6. Staff (public.users owner) still read the full tenants/quotes/subscriptions rows, incl. the
--      internal columns; the portal readers give staff nothing.
--   7. anon cannot execute the portal readers; authenticated + service_role can.
--
-- Ids are captured BEFORE every role switch and carried in GUCs (the trap documented in
-- portal_customer_users_no_self_update.test.sql: a SELECT run after `set role` is filtered to
-- nothing and every later comparison silently becomes "= NULL").

begin;

-- ── fixtures (as postgres) ──────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code, doc_code, gstin, attendance_ingest_key, upi_vpa)
  values ('ffffffff-0000-0000-0000-000000395a01', 'R395 Reseller', 'r395@example.in', '07', 'R395',
          '07AAAAA0000A1Z5', 'r395-SECRET-ingest-key', 'r395@upi'),
         ('ffffffff-0000-0000-0000-000000395a02', 'R395 Other', 'r395o@example.in', '07', 'R39O',
          null, 'r395-OTHER-secret', null);

insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-000000395c0a', 'ffffffff-0000-0000-0000-000000395a01', 'Cust A'),
         ('cccccccc-0000-0000-0000-000000395c0b', 'ffffffff-0000-0000-0000-000000395a01', 'Cust B'),
         ('cccccccc-0000-0000-0000-000000395c0c', 'ffffffff-0000-0000-0000-000000395a02', 'Cust C (other tenant)');

insert into auth.users (id, instance_id, aud, role, email) values
  ('dddddddd-0000-0000-0000-000000395d0a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r395-cust@example.test'),
  ('dddddddd-0000-0000-0000-000000395d05', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r395-staff@example.test');

insert into public.users (id, tenant_id, email, role)
  values ('dddddddd-0000-0000-0000-000000395d05', 'ffffffff-0000-0000-0000-000000395a01', 'r395-staff@example.test', 'owner');

insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role)
  values ('dddddddd-0000-0000-0000-000000395d0a', 'cccccccc-0000-0000-0000-000000395c0a',
          'ffffffff-0000-0000-0000-000000395a01', 'r395-cust@example.test', 'admin');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           notes, payment_notes, status, line_items, terms_conditions)
  values ('Q-R395-A', 'ffffffff-0000-0000-0000-000000395a01', 'cccccccc-0000-0000-0000-000000395c0a', 'Cust A',
          'Google Workspace Business Starter', 5, 11800, 10000, 7000, 'INTERNAL margin note', 'INTERNAL pay note',
          'sent', '[{"id":"l1","name":"GW Starter","qty":5,"rate":2000,"cost":1400,"list_rate":2100}]', 'Pay in 7 days'),
         ('Q-R395-AD', 'ffffffff-0000-0000-0000-000000395a01', 'cccccccc-0000-0000-0000-000000395c0a', 'Cust A',
          'Draft plan', 1, 100, 100, 50, null, null, 'draft', '[]', null),
         ('Q-R395-B', 'ffffffff-0000-0000-0000-000000395a01', 'cccccccc-0000-0000-0000-000000395c0b', 'Cust B',
          'Other plan', 2, 2000, 2000, 1500, null, null, 'sent', '[]', null);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, used, mrr, status,
                                  start_date, renewal_date, write_off_reason, is_urgent, vendor_cost_per_seat_month)
  values ('aaaaaaaa-0000-0000-0000-000000395b0a', 'ffffffff-0000-0000-0000-000000395a01', 'cccccccc-0000-0000-0000-000000395c0a',
          'Cust A', 'GW Starter', 'google', 5, 4, 1000, 'active', current_date, current_date + 365, 'INTERNAL write-off', true, 140),
         ('aaaaaaaa-0000-0000-0000-000000395b0b', 'ffffffff-0000-0000-0000-000000395a01', 'cccccccc-0000-0000-0000-000000395c0b',
          'Cust B', 'GW Starter', 'google', 2, 2, 400, 'active', current_date, current_date + 365, null, false, null);

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount)
  values ('INV-R395-A', 'ffffffff-0000-0000-0000-000000395a01', 'cccccccc-0000-0000-0000-000000395c0a', 'Cust A', 11800),
         ('INV-R395-B', 'ffffffff-0000-0000-0000-000000395a01', 'cccccccc-0000-0000-0000-000000395c0b', 'Cust B', 2000);

insert into public.payments (tenant_id, customer_id, quote_id, amount, method)
  values ('ffffffff-0000-0000-0000-000000395a01', 'cccccccc-0000-0000-0000-000000395c0a', 'Q-R395-A', 11800, 'upi'),
         ('ffffffff-0000-0000-0000-000000395a01', 'cccccccc-0000-0000-0000-000000395c0b', 'Q-R395-B', 2000, 'upi');

-- ── 0. the leaky policies are gone, the readers exist and expose no internal column ─────────
do $$
declare v_fn text; v_res text;
begin
  if exists (select 1 from pg_policy where polname in
               ('tenants_select_own_customer', 'quotes_select_own_customer', 'subscriptions_select_own_customer')) then
    raise exception 'FAIL 0: a broad customer SELECT policy is still installed';
  end if;
  foreach v_fn in array array['portal_my_tenant', 'portal_my_quotes', 'portal_my_subscriptions'] loop
    select pg_get_function_result(p.oid) into v_res
      from pg_proc p where p.proname = v_fn and p.pronamespace = 'public'::regnamespace;
    if v_res is null then raise exception 'FAIL 0: %() missing', v_fn; end if;
    if v_res ~* '(attendance_ingest_key|total_cost|\mnotes\M|payment_notes|write_off|is_urgent|reminder_count|vendor_cost|remit_|approved_margin|external_ref)' then
      raise exception 'FAIL 0: %() returns an internal column: %', v_fn, v_res;
    end if;
  end loop;
end $$;

-- ── 7. grants ──────────────────────────────────────────────────────────────────────────────
do $$
declare v_fn text;
begin
  foreach v_fn in array array['portal_my_tenant()', 'portal_my_quotes()', 'portal_my_subscriptions()'] loop
    if has_function_privilege('anon', 'public.' || v_fn, 'EXECUTE') then
      raise exception 'FAIL 7: anon can execute %', v_fn;
    end if;
    if not has_function_privilege('authenticated', 'public.' || v_fn, 'EXECUTE')
       or not has_function_privilege('service_role', 'public.' || v_fn, 'EXECUTE') then
      raise exception 'FAIL 7: authenticated/service_role cannot execute %', v_fn;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.current_customer_id()', 'EXECUTE') then
    raise exception 'FAIL 7: authenticated lost current_customer_id (every customer policy would break)';
  end if;
end $$;

-- ── 1–4. as the customer (one link) ────────────────────────────────────────────────────────
select set_config('r395.cust', 'dddddddd-0000-0000-0000-000000395d0a', true);
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('r395.cust'), 'role', 'authenticated')::text, true);

do $$
declare v_n int; v_t record; v_q record; v_s record;
begin
  if auth.uid()::text is distinct from current_setting('r395.cust', true) then
    raise exception 'SETUP FAIL: impersonation did not take (auth.uid() = %)', auth.uid();
  end if;
  if public.current_customer_id() is distinct from 'cccccccc-0000-0000-0000-000000395c0a'::uuid then
    raise exception 'SETUP FAIL: current_customer_id() = %, expected Cust A', public.current_customer_id();
  end if;

  -- 4 first: the positive control. If this reads 0, the "0 rows" checks below prove nothing.
  select count(*) into v_n from public.invoices where id in ('INV-R395-A', 'INV-R395-B');
  if v_n <> 1 then raise exception 'FAIL 4: customer sees % of the 2 invoices, expected only their own 1', v_n; end if;
  select count(*) into v_n from public.invoices where id = 'INV-R395-A';
  if v_n <> 1 then raise exception 'FAIL 4: customer cannot read their own invoice'; end if;
  select count(*) into v_n from public.payments where quote_id in ('Q-R395-A', 'Q-R395-B');
  if v_n <> 1 then raise exception 'FAIL 4: customer sees % payments, expected own 1', v_n; end if;
  select count(*) into v_n from public.customers where id in ('cccccccc-0000-0000-0000-000000395c0a', 'cccccccc-0000-0000-0000-000000395c0b');
  if v_n <> 1 then raise exception 'FAIL 4: customer sees % customer rows, expected own 1', v_n; end if;

  -- 1. tenants
  select count(*) into v_n from public.tenants;
  if v_n <> 0 then raise exception 'FAIL 1: customer reads % tenants row(s) directly (attendance_ingest_key exposed)', v_n; end if;
  select count(*) into v_n from public.tenants where attendance_ingest_key is not null;
  if v_n <> 0 then raise exception 'FAIL 1: attendance_ingest_key reachable'; end if;
  select * into v_t from public.portal_my_tenant();
  if v_t.name is distinct from 'R395 Reseller' or v_t.gstin is distinct from '07AAAAA0000A1Z5'
     or v_t.upi_vpa is distinct from 'r395@upi' then
    raise exception 'FAIL 1: portal_my_tenant() did not return own tenant display fields (%)', row_to_json(v_t);
  end if;
  if row_to_json(v_t)::text like '%SECRET%' then raise exception 'FAIL 1: secret in portal_my_tenant()'; end if;

  -- 2. quotes
  select count(*) into v_n from public.quotes;
  if v_n <> 0 then raise exception 'FAIL 2: customer reads % quote row(s) directly (total_cost/notes exposed)', v_n; end if;
  select count(*) into v_n from public.quotes where total_cost is not null or notes is not null or payment_notes is not null;
  if v_n <> 0 then raise exception 'FAIL 2: total_cost/notes/payment_notes reachable'; end if;
  select count(*) into v_n from public.portal_my_quotes();
  if v_n <> 1 then raise exception 'FAIL 2: portal_my_quotes() returned % rows, expected own non-draft 1', v_n; end if;
  select * into v_q from public.portal_my_quotes();
  if v_q.id <> 'Q-R395-A' or v_q.amount <> 11800 or v_q.terms_conditions is distinct from 'Pay in 7 days' then
    raise exception 'FAIL 2: wrong quote / fields: %', row_to_json(v_q);
  end if;
  if jsonb_array_length(v_q.line_items) <> 1 or (v_q.line_items->0->>'rate')::int <> 2000
     or (v_q.line_items->0) ? 'cost' or (v_q.line_items->0) ? 'list_rate' then
    raise exception 'FAIL 2: line_items leak cost or lost display fields: %', v_q.line_items;
  end if;
  if row_to_json(v_q)::text ~ '(INTERNAL|7000|1400)' then
    raise exception 'FAIL 2: internal value in portal_my_quotes(): %', row_to_json(v_q);
  end if;

  -- 3. subscriptions
  select count(*) into v_n from public.subscriptions;
  if v_n <> 0 then raise exception 'FAIL 3: customer reads % subscription row(s) directly (write_off_reason exposed)', v_n; end if;
  select count(*) into v_n from public.portal_my_subscriptions();
  if v_n <> 1 then raise exception 'FAIL 3: portal_my_subscriptions() returned % rows, expected own 1', v_n; end if;
  select * into v_s from public.portal_my_subscriptions();
  if v_s.id <> 'aaaaaaaa-0000-0000-0000-000000395b0a' or v_s.seats <> 5 or v_s.used <> 4
     or v_s.status <> 'active' or v_s.renewal_date is null then
    raise exception 'FAIL 3: wrong subscription fields: %', row_to_json(v_s);
  end if;
  if row_to_json(v_s)::text like '%INTERNAL%' then raise exception 'FAIL 3: write_off_reason leaked'; end if;
end $$;

reset role;

-- ── 5. two links: refuse unless a server claim selects one of the user's OWN customers ──────
-- Today customer_users.auth_user_id is UNIQUE, so this cannot happen yet; Phase 1 (one row per
-- contact per customer) will drop it. Simulate that here — rolled back with everything else.
alter table public.customer_users drop constraint customer_users_auth_user_id_key;
insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role)
  values ('dddddddd-0000-0000-0000-000000395d0a', 'cccccccc-0000-0000-0000-000000395c0b',
          'ffffffff-0000-0000-0000-000000395a01', 'r395-cust@example.test', 'admin');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('r395.cust'), 'role', 'authenticated')::text, true);
do $$
declare v_n int;
begin
  if public.current_customer_id() is not null then
    raise exception 'FAIL 5a: two links and no selection, but current_customer_id() guessed %', public.current_customer_id();
  end if;
  select count(*) into v_n from public.invoices where id in ('INV-R395-A', 'INV-R395-B');
  if v_n <> 0 then raise exception 'FAIL 5a: ambiguous customer still reads % invoices', v_n; end if;
  select count(*) into v_n from public.portal_my_quotes();
  if v_n <> 0 then raise exception 'FAIL 5a: ambiguous customer still reads % quotes', v_n; end if;
  select count(*) into v_n from public.portal_my_tenant();
  if v_n <> 0 then raise exception 'FAIL 5a: ambiguous customer still reads the tenant profile'; end if;
end $$;

-- 5b. server-selected customer B (app_metadata is server-only in Supabase Auth)
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('r395.cust'), 'role', 'authenticated',
                    'app_metadata', json_build_object('customer_id', 'cccccccc-0000-0000-0000-000000395c0b'))::text, true);
do $$
declare v_n int; v_id text;
begin
  if public.current_customer_id() is distinct from 'cccccccc-0000-0000-0000-000000395c0b'::uuid then
    raise exception 'FAIL 5b: selected customer B not honoured (got %)', public.current_customer_id();
  end if;
  select count(*), min(id) into v_n, v_id from public.invoices where id in ('INV-R395-A', 'INV-R395-B');
  if v_n <> 1 or v_id <> 'INV-R395-B' then raise exception 'FAIL 5b: with B selected saw % invoice(s) (%)', v_n, v_id; end if;
  select count(*), min(id) into v_n, v_id from public.portal_my_quotes();
  if v_n <> 1 or v_id <> 'Q-R395-B' then raise exception 'FAIL 5b: with B selected saw % quote(s) (%)', v_n, v_id; end if;
end $$;

-- 5c. a claim naming a customer the user is NOT linked to is ignored → null, not that customer
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('r395.cust'), 'role', 'authenticated',
                    'customer_id', 'cccccccc-0000-0000-0000-000000395c0c')::text, true);
do $$ begin
  if public.current_customer_id() is not null then
    raise exception 'FAIL 5c: a claim for an unlinked customer was honoured (%)', public.current_customer_id();
  end if;
  if exists (select 1 from public.portal_my_tenant()) then
    raise exception 'FAIL 5c: unlinked claim exposed a tenant profile';
  end if;
end $$;

reset role;

-- ── 6. staff are unchanged ──────────────────────────────────────────────────────────────────
select set_config('r395.staff', 'dddddddd-0000-0000-0000-000000395d05', true);
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('r395.staff'), 'role', 'authenticated')::text, true);
do $$
declare v_n int; v_key text; v_cost int; v_wo text;
begin
  select attendance_ingest_key into v_key from public.tenants where id = 'ffffffff-0000-0000-0000-000000395a01';
  if v_key is distinct from 'r395-SECRET-ingest-key' then raise exception 'FAIL 6: staff lost their own tenants row'; end if;
  select count(*) into v_n from public.tenants where id = 'ffffffff-0000-0000-0000-000000395a02';
  if v_n <> 0 then raise exception 'FAIL 6: staff read another tenant'; end if;
  select count(*) into v_n from public.quotes where id like 'Q-R395-%';
  if v_n <> 3 then raise exception 'FAIL 6: staff see % of 3 quotes', v_n; end if;
  select total_cost into v_cost from public.quotes where id = 'Q-R395-A';
  if v_cost is distinct from 7000 then raise exception 'FAIL 6: staff lost total_cost'; end if;
  select count(*) into v_n from public.subscriptions where customer_id in ('cccccccc-0000-0000-0000-000000395c0a', 'cccccccc-0000-0000-0000-000000395c0b');
  if v_n <> 2 then raise exception 'FAIL 6: staff see % of 2 subscriptions', v_n; end if;
  select write_off_reason into v_wo from public.subscriptions where id = 'aaaaaaaa-0000-0000-0000-000000395b0a';
  if v_wo is distinct from 'INTERNAL write-off' then raise exception 'FAIL 6: staff lost write_off_reason'; end if;
  if public.current_customer_id() is not null then raise exception 'FAIL 6: staff resolved to a customer'; end if;
  if exists (select 1 from public.portal_my_tenant()) or exists (select 1 from public.portal_my_quotes())
     or exists (select 1 from public.portal_my_subscriptions()) then
    raise exception 'FAIL 6: the portal readers returned rows to a staff user';
  end if;
end $$;

reset role;

select 'PASS' as customer_portal_rls_leaks;

rollback;
