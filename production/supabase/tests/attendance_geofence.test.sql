-- Regression test: self check-in office location (geofence) is decided INSIDE the database.
-- Migrations 20261010233000_attendance_geofence.sql + 20261010235500_attendance_geofence_noarg.sql
-- (R-438). Rolled back — safe anywhere.
--
--   OFF      a far-away location marks as before, no outside_office flag
--   BLOCK    ~500 m away → refused "You are about 500 m from the office" (hint outside_office);
--            no location → refused (hint no_location); inside the circle → checked_in
--   ANYWHERE an employee the owner allows outside (R-605) is flagged, never refused
--   FLAG     far away → checked_in + flag outside_office; far check-out adds the flag too
--   OLD      the no-argument mark_self_attendance() is callable by members (other callers and
--            tests use it) but is "no location, no office code": block refuses (no_location),
--            flag marks + no_location, the office code rule refuses it
--   OWNER    only the owner may change the office location: a manager is refused by the
--            function AND cannot write the columns directly
--   CODE     require_presence on: a direct call without the office code is refused
--   NOCOMP   a login with no company is refused (28000) — fails closed (§17c)
--
-- Without the migration the 4-argument function does not exist and the file errors. With the
-- distance check removed FAIL 3 fires; with the owner check removed FAIL 9 fires; with the old
-- no-argument function marking without the checks FAIL 8 / 8b / 10c fire; revoked, FAIL 8c.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('43800000-0000-4000-8000-000000000001', 'R438 TEST', 'r438@example.in', '07', 'R438');

insert into auth.users (id, instance_id, aud, role, email) values
  ('43800000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r438-owner@example.in'),
  ('43800000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r438-manager@example.in'),
  ('43800000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r438-nocompany@example.in'),
  ('43800000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r438-e1@example.in'),
  ('43800000-0000-4000-8000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r438-e2@example.in'),
  ('43800000-0000-4000-8000-0000000000b3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r438-e3@example.in'),
  ('43800000-0000-4000-8000-0000000000b4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r438-e4@example.in'),
  ('43800000-0000-4000-8000-0000000000b5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r438-e5@example.in'),
  ('43800000-0000-4000-8000-0000000000b6', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r438-e6@example.in');

insert into public.employees (id, tenant_id, name, is_active, attendance_anywhere) values
  ('43800000-0000-4000-8000-0000000000e1', '43800000-0000-4000-8000-000000000001', 'R438 Block', true, false),
  ('43800000-0000-4000-8000-0000000000e2', '43800000-0000-4000-8000-000000000001', 'R438 Off', true, false),
  ('43800000-0000-4000-8000-0000000000e3', '43800000-0000-4000-8000-000000000001', 'R438 Flag', true, false),
  ('43800000-0000-4000-8000-0000000000e4', '43800000-0000-4000-8000-000000000001', 'R438 Anywhere', true, true),
  ('43800000-0000-4000-8000-0000000000e5', '43800000-0000-4000-8000-000000000001', 'R438 Code', true, false),
  ('43800000-0000-4000-8000-0000000000e6', '43800000-0000-4000-8000-000000000001', 'R438 NoArg', true, false);

insert into public.users (id, tenant_id, email, role, is_active, employee_id) values
  ('43800000-0000-4000-8000-00000000000a', '43800000-0000-4000-8000-000000000001', 'r438-owner@example.in',   'owner',   true, null),
  ('43800000-0000-4000-8000-00000000000c', '43800000-0000-4000-8000-000000000001', 'r438-manager@example.in', 'manager', true, null),
  ('43800000-0000-4000-8000-0000000000b1', '43800000-0000-4000-8000-000000000001', 'r438-e1@example.in', 'sales', true, '43800000-0000-4000-8000-0000000000e1'),
  ('43800000-0000-4000-8000-0000000000b2', '43800000-0000-4000-8000-000000000001', 'r438-e2@example.in', 'sales', true, '43800000-0000-4000-8000-0000000000e2'),
  ('43800000-0000-4000-8000-0000000000b3', '43800000-0000-4000-8000-000000000001', 'r438-e3@example.in', 'sales', true, '43800000-0000-4000-8000-0000000000e3'),
  ('43800000-0000-4000-8000-0000000000b4', '43800000-0000-4000-8000-000000000001', 'r438-e4@example.in', 'sales', true, '43800000-0000-4000-8000-0000000000e4'),
  ('43800000-0000-4000-8000-0000000000b5', '43800000-0000-4000-8000-000000000001', 'r438-e5@example.in', 'sales', true, '43800000-0000-4000-8000-0000000000e5'),
  ('43800000-0000-4000-8000-0000000000b6', '43800000-0000-4000-8000-000000000001', 'r438-e6@example.in', 'sales', true, '43800000-0000-4000-8000-0000000000e6');
-- ...0d has no public.users row → current_tenant_id() is NULL (portal / mid-signup login).

insert into public.attendance_settings (tenant_id, require_presence, require_selfie)
  values ('43800000-0000-4000-8000-000000000001', false, false);

do $$
declare
  v_err   boolean;
  v_msg   text;
  v_hint  text;
  v_state text;
  v_res   text;
  v_flags text[];
  v_code  text;
  c_t       constant uuid := '43800000-0000-4000-8000-000000000001';
  c_owner   constant text := '43800000-0000-4000-8000-00000000000a';
  c_manager constant text := '43800000-0000-4000-8000-00000000000c';
  c_nocomp  constant text := '43800000-0000-4000-8000-00000000000d';
  -- Office in Delhi; 0.0051° east is ~498 m away (same numbers as geofence.test.ts).
  c_olat constant double precision := 28.6139;
  c_olng constant double precision := 77.2090;
  c_far  constant double precision := 77.2141;
begin
  set local role authenticated;

  -- ── OFF (default): location ignored ─────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', '43800000-0000-4000-8000-0000000000b2', 'role', 'authenticated')::text, true);
  v_res := public.mark_self_attendance(c_olat, c_far, 10);
  if v_res <> 'checked_in' then raise exception 'FAIL 1: off mode did not mark (got %)', v_res; end if;

  -- ── OWNER sets the office, mode block ───────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform public.set_office_location(c_olat, c_olng, 150, 'block');

  -- ── BLOCK: ~500 m away refused with the distance ────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', '43800000-0000-4000-8000-0000000000b1', 'role', 'authenticated')::text, true);
  v_err := false;
  begin perform public.mark_self_attendance(c_olat, c_far, 10);
  exception when others then v_err := true; v_msg := sqlerrm; get stacked diagnostics v_hint = pg_exception_hint; end;
  if not v_err then raise exception 'FAIL 3: block mode let a check-in from ~500 m through'; end if;
  if v_msg not like 'You are about 500 m from the office%' or v_hint <> 'outside_office' then
    raise exception 'FAIL 3b: wrong refusal: % / %', v_msg, v_hint;
  end if;

  -- a huge "accuracy" widens the circle by at most 100 m
  v_err := false;
  begin perform public.mark_self_attendance(c_olat, c_far, 5000);
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 3c: a 5 km accuracy claim got a far check-in through'; end if;

  v_err := false;
  begin perform public.mark_self_attendance(null, null, null);
  exception when others then v_err := true; v_msg := sqlerrm; get stacked diagnostics v_hint = pg_exception_hint; end;
  if not v_err or v_hint <> 'no_location' then raise exception 'FAIL 4: block mode let a check-in with no location through'; end if;

  if exists (select 1 from public.attendance where employee_id = '43800000-0000-4000-8000-0000000000e1') then
    raise exception 'FAIL 4b: a refused check-in still wrote a row';
  end if;

  -- OLD (block): the no-argument version is "no location" → refused, nothing written
  v_err := false; v_hint := null;
  begin perform public.mark_self_attendance();
  exception when insufficient_privilege then
    raise exception 'FAIL 8c: the no-argument mark_self_attendance() is not callable by members (breaks existing callers)';
  when others then v_err := true; get stacked diagnostics v_hint = pg_exception_hint; end;
  if not v_err or v_hint <> 'no_location' then
    raise exception 'FAIL 8: the no-argument mark_self_attendance() skipped block mode';
  end if;
  if exists (select 1 from public.attendance where employee_id = '43800000-0000-4000-8000-0000000000e1') then
    raise exception 'FAIL 8a: a refused no-argument check-in still wrote a row';
  end if;

  -- inside the office (~5 m away)
  v_res := public.mark_self_attendance(28.61395, 77.20905, 15);
  if v_res <> 'checked_in' then raise exception 'FAIL 5: block mode refused a check-in inside the office (got %)', v_res; end if;
  select flags into v_flags from public.attendance where employee_id = '43800000-0000-4000-8000-0000000000e1';
  if 'outside_office' = any (v_flags) then raise exception 'FAIL 5b: an inside check-in was flagged'; end if;

  -- ── ANYWHERE: owner-allowed staff are flagged, not refused ──────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', '43800000-0000-4000-8000-0000000000b4', 'role', 'authenticated')::text, true);
  v_res := public.mark_self_attendance(c_olat, c_far, 10);
  select flags into v_flags from public.attendance where employee_id = '43800000-0000-4000-8000-0000000000e4';
  if v_res <> 'checked_in' or not ('outside_office' = any (v_flags)) then
    raise exception 'FAIL 6: an "anywhere" employee in block mode: % / %', v_res, v_flags;
  end if;

  -- ── FLAG: marks and flags ───────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform public.set_office_location(c_olat, c_olng, 150, 'flag');
  perform set_config('request.jwt.claims', json_build_object('sub', '43800000-0000-4000-8000-0000000000b3', 'role', 'authenticated')::text, true);
  v_res := public.mark_self_attendance(c_olat, c_far, 10);
  select flags into v_flags from public.attendance where employee_id = '43800000-0000-4000-8000-0000000000e3';
  if v_res <> 'checked_in' or not ('outside_office' = any (v_flags)) then
    raise exception 'FAIL 7: flag mode: % / % (expected checked_in + outside_office)', v_res, v_flags;
  end if;

  -- far check-out of a clean day (e1 checked in inside) adds the flag
  reset role;
  update public.attendance set check_in = now() - interval '2 hours'
   where employee_id = '43800000-0000-4000-8000-0000000000e1';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '43800000-0000-4000-8000-0000000000b1', 'role', 'authenticated')::text, true);
  v_res := public.mark_self_attendance(c_olat, c_far, 10);
  select flags into v_flags from public.attendance where employee_id = '43800000-0000-4000-8000-0000000000e1';
  if v_res <> 'checked_out' or not ('outside_office' = any (v_flags)) then
    raise exception 'FAIL 7b: far check-out in flag mode: % / %', v_res, v_flags;
  end if;

  -- ── OLD (flag): the no-argument version marks + flags no_location ───────────
  perform set_config('request.jwt.claims', json_build_object('sub', '43800000-0000-4000-8000-0000000000b6', 'role', 'authenticated')::text, true);
  v_res := public.mark_self_attendance();
  select flags into v_flags from public.attendance where employee_id = '43800000-0000-4000-8000-0000000000e6';
  if v_res <> 'checked_in' or not ('no_location' = any (coalesce(v_flags, '{}'))) then
    raise exception 'FAIL 8b: no-argument check-in in flag mode: % / % (expected checked_in + no_location)', v_res, v_flags;
  end if;

  -- ── OWNER only ──────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', c_manager, 'role', 'authenticated')::text, true);
  v_err := false;
  begin perform public.set_office_location(c_olat, c_olng, 150, 'off');
  exception when others then v_err := true; v_state := sqlstate; end;
  if not v_err or v_state <> '42501' then raise exception 'FAIL 9: a manager changed the office location'; end if;

  v_err := false;
  begin update public.attendance_settings set geofence_mode = 'off' where tenant_id = c_t;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 9b: a manager can write geofence_mode directly'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', '43800000-0000-4000-8000-0000000000b3', 'role', 'authenticated')::text, true);
  v_err := false;
  begin perform public.set_office_location(0, 0, 5000, 'off');
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 9c: an employee changed the office location'; end if;

  -- owner: turning the check on without a location is refused
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  v_err := false;
  begin perform public.set_office_location(null, null, 150, 'block');
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 9d: block mode saved without an office location'; end if;

  if (select geofence_mode from public.attendance_settings where tenant_id = c_t) <> 'flag' then
    raise exception 'FAIL 9e: the setting changed after refused writes';
  end if;

  -- ── CODE: a direct call cannot skip the office code ─────────────────────────
  reset role;
  update public.attendance_settings set require_presence = true, presence_secret = 'r438-test-seed' where tenant_id = c_t;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '43800000-0000-4000-8000-0000000000b5', 'role', 'authenticated')::text, true);
  v_err := false;
  begin perform public.mark_self_attendance(c_olat, c_olng, 10);
  exception when others then v_err := true; get stacked diagnostics v_hint = pg_exception_hint; end;
  if not v_err or v_hint <> 'presence_code' then raise exception 'FAIL 10: a direct call skipped the office code'; end if;
  v_err := false; v_hint := null;
  begin perform public.mark_self_attendance();
  exception when others then v_err := true; get stacked diagnostics v_hint = pg_exception_hint; end;
  if not v_err or v_hint <> 'presence_code' then raise exception 'FAIL 10c: the no-argument call skipped the office code'; end if;
  -- the right code (computed as the server would for the kiosk) marks
  reset role;
  v_code := public.presence_code_at('r438-test-seed', floor(extract(epoch from clock_timestamp()) / 45)::bigint);
  set local role authenticated;
  v_res := public.mark_self_attendance(c_olat, c_olng, 10, v_code);
  if v_res <> 'checked_in' then raise exception 'FAIL 10b: the right office code was refused (got %)', v_res; end if;

  -- ── NOCOMP: no company → refused, fail closed ───────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', c_nocomp, 'role', 'authenticated')::text, true);
  v_err := false;
  begin perform public.mark_self_attendance(c_olat, c_olng, 10);
  exception when others then v_err := true; v_state := sqlstate; end;
  if not v_err or v_state <> '28000' then raise exception 'FAIL 11: a login with no company was not refused'; end if;
  v_err := false;
  begin perform public.set_office_location(c_olat, c_olng, 150, 'off');
  exception when others then v_err := true; v_state := sqlstate; end;
  if not v_err or v_state <> '28000' then raise exception 'FAIL 11b: a login with no company reached set_office_location'; end if;

  raise notice 'attendance_geofence: all checks passed';
end $$;

rollback;
