\set ON_ERROR_STOP on
-- R-1010: a sign-in row is written by the SERVER only; the browser can no longer write it.
-- Migration 20261023173100_r1010_server_login_log.sql. ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres < supabase/tests/r1010_server_login_log.test.sql
--
--   IGNORED  a signed-in user calls log_activity('login') (any case / spaces) → no row
--   KEPT     log_activity with any other action still writes (AI audit uses it)
--   BLOCKED  a signed-in user inserting an activity_log row directly
--   ALLOWED  service_role (the app server) writes the login row with ip / device / signed_in_at
--   ONCE     the same user + signed_in_at twice → 23505; another sign-in time → a new row
--   READ     the owner sees the row; a sales user does not (R-1002 unchanged)

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1010000-0000-4000-8000-0000000000a1', 'r1010-owner@example.test'),
  ('e1010000-0000-4000-8000-0000000000a5', 'r1010-sales@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1010000-0000-0000-0000-0000000000a0', 'R1010 A', 'r1010a@example.in', '07', 'R10A');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1010000-0000-4000-8000-0000000000a1', 'e1010000-0000-0000-0000-0000000000a0', 'r1010-owner@example.in', 'R1010 Owner', 'owner', true),
  ('e1010000-0000-4000-8000-0000000000a5', 'e1010000-0000-0000-0000-0000000000a0', 'r1010-sales@example.in', 'R1010 Sales', 'sales', true);

do $$
declare
  c_t     constant uuid := 'e1010000-0000-0000-0000-0000000000a0';
  c_owner constant uuid := 'e1010000-0000-4000-8000-0000000000a1';
  c_sales constant uuid := 'e1010000-0000-4000-8000-0000000000a5';
  v_n int; v_err boolean;
begin
  -- ── IGNORED: the browser path ─────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('role','authenticated','sub',c_sales)::text, true);
  set local role authenticated;
  perform public.log_activity('login', 'session');
  perform public.log_activity(' LOGIN ', 'session', null, 'forged');
  perform public.log_activity('r1010_probe', 'session', null, 'kept');

  -- ── BLOCKED: direct insert ────────────────────────────────────────────────
  v_err := false;
  begin
    insert into public.activity_log (tenant_id, user_id, action, entity, label)
    values (c_t, c_sales, 'login', 'session', 'forged direct');
  exception when insufficient_privilege then v_err := true; end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if not v_err then raise exception 'FAIL 3: a signed-in user inserted an activity_log row directly'; end if;

  select count(*) into v_n from public.activity_log where tenant_id = c_t and action ilike '%login%';
  if v_n <> 0 then raise exception 'FAIL 1: the browser wrote % login row(s) through log_activity', v_n; end if;

  select count(*) into v_n from public.activity_log where tenant_id = c_t and action = 'r1010_probe';
  if v_n <> 1 then raise exception 'FAIL 2: log_activity stopped writing non-login actions (% rows)', v_n; end if;

  -- ── ALLOWED: the server (service_role) writes the sign-in ─────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  insert into public.activity_log (tenant_id, user_id, action, entity, label, changes) values
    (c_t, c_sales, 'login', 'session', 'Chrome on Windows · IP 203.0.113.7',
     jsonb_build_object('ip','203.0.113.7','device','Chrome on Windows','method','session','signed_in_at','2026-10-23T10:00:00Z'));

  -- ── ONCE per sign-in ─────────────────────────────────────────────────────
  v_err := false;
  begin
    insert into public.activity_log (tenant_id, user_id, action, entity, label, changes) values
      (c_t, c_sales, 'login', 'session', 'again',
       jsonb_build_object('ip','203.0.113.7','device','Chrome on Windows','method','session','signed_in_at','2026-10-23T10:00:00Z'));
  exception when unique_violation then v_err := true; end;
  if not v_err then raise exception 'FAIL 4: the same sign-in was recorded twice'; end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, label, changes) values
    (c_t, c_sales, 'login', 'session', 'next sign-in',
     jsonb_build_object('ip','203.0.113.8','device','Safari on iPhone','method','session','signed_in_at','2026-10-23T12:00:00Z'));
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ── READ: owner yes, sales no ─────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('role','authenticated','sub',c_owner)::text, true);
  set local role authenticated;
  select count(*) into v_n from public.activity_log where action = 'login' and tenant_id = c_t;
  reset role;
  if v_n <> 2 then raise exception 'FAIL 5: the owner sees % sign-in rows, expected 2', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('role','authenticated','sub',c_sales)::text, true);
  set local role authenticated;
  select count(*) into v_n from public.activity_log where action = 'login' and tenant_id = c_t;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if v_n <> 0 then raise exception 'FAIL 6: a sales user sees % sign-in rows', v_n; end if;

  raise notice 'R-1010 server login log: ALL PASS';
end $$;

rollback;
