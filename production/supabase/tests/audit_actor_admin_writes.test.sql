-- Regression test: R-051 part 3 — an admin-client (service role) write made for a signed-in
-- user records that user in the audit log, and nobody else can claim to be someone
-- (migration 20261007240000). Self-asserting; rolled back.
--
-- PostgREST hands the request to Postgres as two GUCs: request.jwt.claims (verified JWT)
-- and request.headers (json). createAdminClientFor(userId) sends `x-actor-id`. Below we set
-- the same GUCs by hand.
--
-- Proves:
--   1. service role + x-actor-id (staff of the row's tenant) → activity_log row, user_id = staff.
--      (Without the migration there is NO row: log_row_change returned on auth.uid() null.)
--   2. service role + no actor (cron / webhook) → no row, as before.
--   3. service role + set_config('app.actor_id') (SQL / RPC path) → attributed too.
--   4. SPOOF: a signed-in user sending x-actor-id = someone else → logged as THEMSELVES.
--   5. SPOOF: anon JWT + x-actor-id / app.actor_id → no row, audit_service_actor() null.
--   6. garbage x-actor-id → the write still succeeds, no row, no error.
--   7. actor from ANOTHER tenant (platform support) → user_id null, actor_label 'Platform support'.
--   8. subscriptions seat change via service role + actor → contract_amendments changed_by =
--      staff, source 'user' (was 'system').
--   9. anon / authenticated cannot execute audit_service_actor().
--
-- Owns all its fixtures (AGENTS.md L11).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.headers', '{}', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('ffffffff-0000-0000-0000-000000051301','AUDIT T','audit@example.in','07','R513'),
  ('ffffffff-0000-0000-0000-000000051302','OTHER T','other@example.in','07','R514');
insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-000000051301','r051-staff@example.test'),
  ('dddddddd-0000-0000-0000-000000051302','r051-staff2@example.test'),
  ('dddddddd-0000-0000-0000-000000051303','r051-platform@example.test');
insert into public.users (id, tenant_id, email, role) values
  ('dddddddd-0000-0000-0000-000000051301','ffffffff-0000-0000-0000-000000051301','r051-staff@example.test','owner'),
  ('dddddddd-0000-0000-0000-000000051302','ffffffff-0000-0000-0000-000000051301','r051-staff2@example.test','sales'),
  ('dddddddd-0000-0000-0000-000000051303','ffffffff-0000-0000-0000-000000051302','r051-platform@example.test','owner');
insert into public.customers (id, tenant_id, name, contact_email) values
  ('cccccccc-0000-0000-0000-000000051301','ffffffff-0000-0000-0000-000000051301','Audit Cust','c@audit.example');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date, auto_renew)
  values ('aaaaaaaa-0000-0000-0000-000000051301','ffffffff-0000-0000-0000-000000051301','cccccccc-0000-0000-0000-000000051301',
          'Audit Cust','Google Workspace Standard','google',10,8640,'active',current_date,current_date+365,true);
delete from public.activity_log where tenant_id = 'ffffffff-0000-0000-0000-000000051301';

do $$
declare
  v_t   constant uuid := 'ffffffff-0000-0000-0000-000000051301';
  v_c   constant uuid := 'cccccccc-0000-0000-0000-000000051301';
  v_row record;
  v_n   int;
  v_svc constant text := '{"role":"service_role"}';
begin
  -- 1. service role + header actor of this tenant
  perform set_config('request.jwt.claims', v_svc, true);
  perform set_config('request.headers', '{"x-actor-id":"dddddddd-0000-0000-0000-000000051301"}', true);
  update public.customers set name = 'Audit Cust 1' where id = v_c;
  select * into v_row from public.activity_log where tenant_id = v_t and entity = 'customers' order by created_at desc, id desc limit 1;
  if v_row is null then raise exception 'FAIL 1: admin write with actor left no activity_log row'; end if;
  if v_row.user_id is distinct from 'dddddddd-0000-0000-0000-000000051301'::uuid then
    raise exception 'FAIL 1: user_id expected staff, got %', v_row.user_id; end if;
  if v_row.actor_label is not null then raise exception 'FAIL 1: actor_label should be null, got %', v_row.actor_label; end if;
  delete from public.activity_log where tenant_id = v_t;

  -- 2. service role, no actor → nothing (cron / webhook unchanged)
  perform set_config('request.headers', '{}', true);
  update public.customers set name = 'Audit Cust 2' where id = v_c;
  select count(*) into v_n from public.activity_log where tenant_id = v_t;
  if v_n <> 0 then raise exception 'FAIL 2: system write logged % rows, expected 0', v_n; end if;

  -- 3. service role + app.actor_id (SQL / RPC path)
  perform set_config('app.actor_id', 'dddddddd-0000-0000-0000-000000051302', true);
  update public.customers set name = 'Audit Cust 3' where id = v_c;
  select * into v_row from public.activity_log where tenant_id = v_t limit 1;
  if v_row.user_id is distinct from 'dddddddd-0000-0000-0000-000000051302'::uuid then
    raise exception 'FAIL 3: app.actor_id not used, user_id %', v_row.user_id; end if;
  perform set_config('app.actor_id', '', true);
  delete from public.activity_log where tenant_id = v_t;

  -- 4. SPOOF: signed-in sales user claims to be the owner via the header
  perform set_config('request.jwt.claims',
    json_build_object('sub','dddddddd-0000-0000-0000-000000051302','role','authenticated')::text, true);
  perform set_config('request.headers', '{"x-actor-id":"dddddddd-0000-0000-0000-000000051301"}', true);
  perform set_config('app.actor_id', 'dddddddd-0000-0000-0000-000000051301', true);
  if public.audit_service_actor() is not null then raise exception 'FAIL 4: actor honoured for a user session'; end if;
  update public.customers set name = 'Audit Cust 4' where id = v_c;
  select * into v_row from public.activity_log where tenant_id = v_t limit 1;
  if v_row.user_id is distinct from 'dddddddd-0000-0000-0000-000000051302'::uuid then
    raise exception 'FAIL 4: spoofed actor won, user_id %', v_row.user_id; end if;
  delete from public.activity_log where tenant_id = v_t;

  -- 5. SPOOF: anon JWT with header + app.actor_id
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  if public.audit_service_actor() is not null then raise exception 'FAIL 5: actor honoured for anon'; end if;
  update public.customers set name = 'Audit Cust 5' where id = v_c;
  select count(*) into v_n from public.activity_log where tenant_id = v_t;
  if v_n <> 0 then raise exception 'FAIL 5: anon write with spoofed actor logged % rows', v_n; end if;
  perform set_config('app.actor_id', '', true);

  -- 6. garbage header → write still works, nothing logged, no error
  perform set_config('request.jwt.claims', v_svc, true);
  perform set_config('request.headers', '{"x-actor-id":"1; drop table users"}', true);
  update public.customers set name = 'Audit Cust 6' where id = v_c;
  select count(*) into v_n from public.activity_log where tenant_id = v_t;
  if v_n <> 0 then raise exception 'FAIL 6: garbage actor logged % rows', v_n; end if;
  perform set_config('request.headers', 'not json', true);
  if public.audit_service_actor() is not null then raise exception 'FAIL 6: non-json headers gave an actor'; end if;

  -- 7. actor of another tenant → logged, not named
  perform set_config('request.headers', '{"x-actor-id":"dddddddd-0000-0000-0000-000000051303"}', true);
  update public.customers set name = 'Audit Cust 7' where id = v_c;
  select * into v_row from public.activity_log where tenant_id = v_t limit 1;
  if v_row is null or v_row.user_id is not null or v_row.actor_label is distinct from 'Platform support' then
    raise exception 'FAIL 7: cross-tenant actor expected null/Platform support, got %/%', v_row.user_id, v_row.actor_label; end if;

  -- 8. seat change through the admin client for the owner → amendment attributed
  perform set_config('request.headers', '{"x-actor-id":"dddddddd-0000-0000-0000-000000051301"}', true);
  update public.subscriptions set seats = 12 where id = 'aaaaaaaa-0000-0000-0000-000000051301';
  select * into v_row from public.contract_amendments where subscription_id = 'aaaaaaaa-0000-0000-0000-000000051301';
  if v_row.changed_by is distinct from 'dddddddd-0000-0000-0000-000000051301'::uuid or v_row.source <> 'user' then
    raise exception 'FAIL 8: amendment expected owner/user, got %/%', v_row.changed_by, v_row.source; end if;
  -- and without an actor it stays system
  perform set_config('request.headers', '{}', true);
  update public.subscriptions set seats = 14 where id = 'aaaaaaaa-0000-0000-0000-000000051301';
  select * into v_row from public.contract_amendments where subscription_id = 'aaaaaaaa-0000-0000-0000-000000051301' and seats_to = 14;
  if v_row.changed_by is not null or v_row.source <> 'system' then
    raise exception 'FAIL 8: system amendment expected null/system, got %/%', v_row.changed_by, v_row.source; end if;

  -- 9. grants
  if has_function_privilege('anon', 'public.audit_service_actor()', 'execute')
     or has_function_privilege('authenticated', 'public.audit_service_actor()', 'execute') then
    raise exception 'FAIL 9: anon/authenticated may execute audit_service_actor()'; end if;

  raise notice 'PASS: admin writes carry the acting user; header/app.actor_id ignored for anon + sessions; cron unchanged';
end $$;
rollback;
