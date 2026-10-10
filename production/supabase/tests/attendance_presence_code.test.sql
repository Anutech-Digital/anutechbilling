-- Regression test: the office-code seed stays in the database; the code is checked there.
-- Migration 20261010203000_presence_code_check.sql (R-440). Rolled back — safe anywhere.
--
--   SAME     presence_code_at() gives the exact codes src/lib/attendance/presence.ts gives
--   BLOCKED  a `sales` login reading presence_secret (column, select *), or the helper
--   ALLOWED  the same `sales` login: correct current code → true
--   BLOCKED  a wrong code → false and counted; 5 wrong → locked, even the right code refused
--   BLOCKED  a login with no company (fails closed, 28000) and anon
--   ALLOWED  owner / manager check a code; the server (service_role) reads the seed for the
--            kiosk display — raw seed is never needed by any member's UI
--
-- Without the migration validate_presence_code / presence_code_at do not exist and the file
-- errors; with a fail-open tenant check or no attempt limit, FAIL 9 / FAIL 7 fire.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('44400000-0000-4000-8000-000000000001', 'R440 TEST', 'r440@example.in', '07', 'R440');

insert into auth.users (id, instance_id, aud, role, email) values
  ('44400000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r440-owner@example.in'),
  ('44400000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r440-sales@example.in'),
  ('44400000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r440-manager@example.in'),
  ('44400000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r440-nocompany@example.in');

insert into public.employees (id, tenant_id, name, is_active) values
  ('44400000-0000-4000-8000-0000000000e1', '44400000-0000-4000-8000-000000000001', 'Sales Emp R440', true);

insert into public.users (id, tenant_id, email, role, is_active, employee_id) values
  ('44400000-0000-4000-8000-00000000000a', '44400000-0000-4000-8000-000000000001', 'r440-owner@example.in',   'owner',   true, null),
  ('44400000-0000-4000-8000-00000000000b', '44400000-0000-4000-8000-000000000001', 'r440-sales@example.in',   'sales',   true, '44400000-0000-4000-8000-0000000000e1'),
  ('44400000-0000-4000-8000-00000000000c', '44400000-0000-4000-8000-000000000001', 'r440-manager@example.in', 'manager', true, null);
-- 0000000000d has no public.users row → current_tenant_id() is NULL (portal / mid-signup login).

insert into public.attendance_settings (tenant_id, require_presence, presence_secret)
  values ('44400000-0000-4000-8000-000000000001', true, 'r440-test-seed');

do $$
declare
  v_err   boolean;
  v_msg   text;
  v_state text;
  v_ok    boolean;
  v_n     int;
  v_code  text;
  v_wrong text;
  i       int;
  c_sales   constant text := '44400000-0000-4000-8000-00000000000b';
  c_owner   constant text := '44400000-0000-4000-8000-00000000000a';
  c_manager constant text := '44400000-0000-4000-8000-00000000000c';
  c_nocomp  constant text := '44400000-0000-4000-8000-00000000000d';
begin
  -- ── SAME: SQL code = Node presenceCode() (vectors from presence.ts, 10 Oct) ────
  if public.presence_code_at('r440-test-seed', 0)        <> '686024'
  or public.presence_code_at('r440-test-seed', 39000000) <> '472419'
  or public.presence_code_at('r440-test-seed', 39000001) <> '526338'
  or public.presence_code_at(repeat('x', 100), 12345)    <> '363347' then
    raise exception 'FAIL 1: presence_code_at does not match presence.ts';
  end if;

  -- The current code, computed as the server would for the kiosk.
  v_code  := public.presence_code_at('r440-test-seed', floor(extract(epoch from clock_timestamp()) / 45)::bigint);
  v_wrong := lpad(((v_code::int + 500000) % 1000000)::text, 6, '0');

  -- ── sales login ──────────────────────────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', c_sales, 'role', 'authenticated')::text, true);

  v_err := false;
  begin perform presence_secret from public.attendance_settings;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 2: a sales login can read presence_secret'; end if;

  v_err := false;
  begin perform * from public.attendance_settings;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 3: a sales login can select * (incl. presence_secret)'; end if;

  v_err := false;
  begin perform public.presence_code_at('anything', 1);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 4: a sales login can call presence_code_at'; end if;

  if not public.validate_presence_code(v_code) then
    raise exception 'FAIL 5: the correct office code was refused';
  end if;

  if public.validate_presence_code(v_wrong) or public.validate_presence_code('12ab56') or public.validate_presence_code(null) then
    raise exception 'FAIL 6: a wrong code was accepted';
  end if;

  v_err := false;
  begin perform 1 from public.presence_code_attempts;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 6b: a sales login can read presence_code_attempts'; end if;

  -- 3 misses so far (wrong, '12ab56', null). Two more → locked.
  perform public.validate_presence_code(v_wrong);
  perform public.validate_presence_code(v_wrong);
  v_err := false;
  begin perform public.validate_presence_code(v_code);
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err or v_msg <> 'PRESENCE_CODE_LOCKED' then
    raise exception 'FAIL 7: after 5 wrong codes the right code still passed (no attempt limit)';
  end if;

  -- ── owner and manager can check a code (separate counters) ─────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  if not public.validate_presence_code(v_code) then raise exception 'FAIL 8: owner check refused'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', c_manager, 'role', 'authenticated')::text, true);
  if not public.validate_presence_code(v_code) then raise exception 'FAIL 8b: manager check refused'; end if;

  -- ── BLOCKED: no-company login (fail closed, §17c) ────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', c_nocomp, 'role', 'authenticated')::text, true);
  v_err := false;
  begin v_ok := public.validate_presence_code(v_code);
  exception when others then v_err := true; v_state := sqlstate; end;
  if not v_err or v_state <> '28000' then
    raise exception 'FAIL 9: a login with no company was not refused (got %)', coalesce(v_ok::text, v_state);
  end if;
  reset role;

  -- ── BLOCKED: anon ────────────────────────────────────────────────────────────
  set local role anon;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_err := false;
  begin perform public.validate_presence_code(v_code);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 10: anon can call validate_presence_code'; end if;
  reset role;

  -- ── ALLOWED: the server reads the seed for the kiosk display ─────────────────
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select count(*) into v_n from public.attendance_settings
   where tenant_id = '44400000-0000-4000-8000-000000000001' and presence_secret is not null;
  if v_n <> 1 then raise exception 'FAIL 11: service_role cannot read the seed for the kiosk'; end if;
  reset role;

  -- Lock row is the sales login's, counted 5.
  select failed into v_n from public.presence_code_attempts where user_id = c_sales::uuid and locked_until > now();
  if coalesce(v_n, 0) <> 5 then raise exception 'FAIL 12: expected a locked row with 5 misses, got %', v_n; end if;

  raise notice 'attendance_presence_code: all checks passed';
end $$;

rollback;
