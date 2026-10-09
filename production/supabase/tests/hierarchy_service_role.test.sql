-- R-458: the service connection (createAdminClient / app_service / Cloud SQL service_role,
-- all NOBYPASSRLS) must see owner-assigned leads, quotes and customers through the
-- RESTRICTIVE *_hierarchy_* policies — while a sales user still cannot see a peer's rows
-- and the owner still sees everything. Asserts the LIVE function (apply
-- 20261009200000_hierarchy_service_role.sql first). Self-asserting; rolled back.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/hierarchy_service_role.test.sql
--
-- Expect "PASS hierarchy_service_role". Before the migration it raises
-- "FAIL service leads: 0 owner-assigned rows".
--
-- HOW THE SERVICE CONNECTION IS MIMICKED LOCALLY
--   Local Supabase's service_role has BYPASSRLS, which would make the test pass vacuously.
--   So a throw-away login r458_svc is created NOBYPASSRLS and made a member of service_role
--   (table grants are inherited; BYPASSRLS is not), a permissive `to service_role` policy is
--   added on the three tables (what Cloud SQL has), and request.jwt.claims carries
--   role=service_role with no sub — exactly what auth.role()/current_request_role() report
--   for app_service. All of it is rolled back.

begin;

insert into auth.users (id, email) values
  ('e4580000-0000-4000-8000-00000000000a', 'r458-owner@example.test'),
  ('e4580000-0000-4000-8000-00000000000c', 'r458-repa@example.test'),
  ('e4580000-0000-4000-8000-00000000000d', 'r458-repb@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e4580000-0000-0000-0000-0000000000d1', 'R458 T', 'r458@example.in', '07', 'R458');

insert into public.users (id, tenant_id, email, full_name, role, is_active, manager_id) values
  ('e4580000-0000-4000-8000-00000000000a', 'e4580000-0000-0000-0000-0000000000d1', 'r458-owner@example.in', 'R458 Owner', 'owner', true, null),
  ('e4580000-0000-4000-8000-00000000000c', 'e4580000-0000-0000-0000-0000000000d1', 'r458-repa@example.in', 'R458 Rep A', 'sales', true, null),
  ('e4580000-0000-4000-8000-00000000000d', 'e4580000-0000-0000-0000-0000000000d1', 'r458-repb@example.in', 'R458 Rep B', 'sales', true, null);

-- Every row belongs to Rep B.
insert into public.leads (id, tenant_id, company, owner_id) values
  ('L-R458-B', 'e4580000-0000-0000-0000-0000000000d1', 'R458 Lead Co', 'e4580000-0000-4000-8000-00000000000d');
insert into public.quotes (id, tenant_id, customer_name, owner_id) values
  ('Q-R458-B', 'e4580000-0000-0000-0000-0000000000d1', 'R458 Quote Co', 'e4580000-0000-4000-8000-00000000000d');
insert into public.customers (id, tenant_id, name, account_manager_id) values
  ('e4580000-0000-4000-8000-0000000000c1', 'e4580000-0000-0000-0000-0000000000d1', 'R458 Customer Co', 'e4580000-0000-4000-8000-00000000000d');

-- The Cloud SQL / app_service shape: service_role permissions, NO bypass.
create role r458_svc nologin nobypassrls in role service_role;
grant r458_svc to current_user;
create policy r458_service_all on public.leads     for all to service_role using (true) with check (true);
create policy r458_service_all on public.quotes    for all to service_role using (true) with check (true);
create policy r458_service_all on public.customers for all to service_role using (true) with check (true);

create temp table r458_result (who text, leads int, quotes int, customers int);
grant all on r458_result to r458_svc, authenticated;

-- ── 1. Service connection ────────────────────────────────────────────────────
set local role r458_svc;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into r458_result
  select 'service',
    (select count(*) from public.leads     where id = 'L-R458-B'),
    (select count(*) from public.quotes    where id = 'Q-R458-B'),
    (select count(*) from public.customers where id = 'e4580000-0000-4000-8000-0000000000c1');
reset role;

-- ── 2. Rep A (sales, not Rep B's manager) ────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e4580000-0000-4000-8000-00000000000c"}', true);
insert into r458_result
  select 'repa',
    (select count(*) from public.leads     where id = 'L-R458-B'),
    (select count(*) from public.quotes    where id = 'Q-R458-B'),
    (select count(*) from public.customers where id = 'e4580000-0000-4000-8000-0000000000c1');
reset role;

-- ── 3. Owner sees all by role ───────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e4580000-0000-4000-8000-00000000000a"}', true);
insert into r458_result
  select 'owner',
    (select count(*) from public.leads     where id = 'L-R458-B'),
    (select count(*) from public.quotes    where id = 'Q-R458-B'),
    (select count(*) from public.customers where id = 'e4580000-0000-4000-8000-0000000000c1');
reset role;

-- ── 4. Rep B still sees their own ────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e4580000-0000-4000-8000-00000000000d"}', true);
insert into r458_result
  select 'repb',
    (select count(*) from public.leads     where id = 'L-R458-B'),
    (select count(*) from public.quotes    where id = 'Q-R458-B'),
    (select count(*) from public.customers where id = 'e4580000-0000-4000-8000-0000000000c1');
reset role;

do $$
declare r record;
begin
  for r in select * from r458_result loop
    if r.who in ('service','owner','repb') then
      if r.leads <> 1 then raise exception 'FAIL % leads: % owner-assigned rows (want 1)', r.who, r.leads; end if;
      if r.quotes <> 1 then raise exception 'FAIL % quotes: % owner-assigned rows (want 1)', r.who, r.quotes; end if;
      if r.customers <> 1 then raise exception 'FAIL % customers: % owner-assigned rows (want 1)', r.who, r.customers; end if;
    else
      if r.leads + r.quotes + r.customers <> 0 then
        raise exception 'FAIL repa sees a peer''s rows: leads % quotes % customers %', r.leads, r.quotes, r.customers;
      end if;
    end if;
  end loop;
  if (select count(*) from r458_result) <> 4 then raise exception 'FAIL: % cases ran, want 4', (select count(*) from r458_result); end if;
  raise notice 'PASS hierarchy_service_role: service + owner + Rep B see the owner-assigned lead/quote/customer; Rep A sees none';
end $$;

rollback;
