-- Regression test: R-439 owner-only attendance correction + audit trail.
-- Migration 20261011003000_attendance_owner_correction.sql. ONE transaction, rolled back.
--
--   OWNER    fixes a wrong check-out → row updated AND one attendance_corrections row with
--            who / when / old → new / reason; mark absent → audit present → absent
--   REFUSED  manager, accountant, the employee himself, a login with no company (tenant NULL)
--            → 42501 and NOTHING written (no row change, no audit row); empty reason refused
--   DIRECT   no login (owner included) can insert / delete / change check_out straight
--            through the API; reviewed_at still updatable by a manager (review queue)
--   AUDIT    append-only for logins; a manager can read his tenant's trail; another tenant's
--            owner sees none of it
--
-- Mutations measured 10 Oct (each turns this red): owner check widened back to manager →
-- FAIL 3; audit insert removed from the function → FAIL 1; direct-write trigger dropped →
-- FAIL 8 (the test hands the table grants back first, as cloudsql/09 would); audit table
-- opened for writes (grant + permissive policy) → FAIL 10; reason check removed from the
-- function → the table's own reason check errors the run.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.headers', '{}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('43900000-0000-4000-8000-000000000001', 'R439 TEST', 'r439@example.in', '07', 'R439A'),
  ('43900000-0000-4000-8000-000000000002', 'R439 OTHER', 'r439b@example.in', '07', 'R439B');

insert into auth.users (id, instance_id, aud, role, email) values
  ('43900000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r439-owner@example.in'),
  ('43900000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r439-manager@example.in'),
  ('43900000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r439-accountant@example.in'),
  ('43900000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r439-emp@example.in'),
  ('43900000-0000-4000-8000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r439-nocompany@example.in'),
  ('43900000-0000-4000-8000-00000000000f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r439-other-owner@example.in');

insert into public.employees (id, tenant_id, name, is_active) values
  ('43900000-0000-4000-8000-0000000000e1', '43900000-0000-4000-8000-000000000001', 'R439 Ravi', true);

insert into public.users (id, tenant_id, email, role, is_active, employee_id) values
  ('43900000-0000-4000-8000-00000000000a', '43900000-0000-4000-8000-000000000001', 'r439-owner@example.in',      'owner',      true, null),
  ('43900000-0000-4000-8000-00000000000b', '43900000-0000-4000-8000-000000000001', 'r439-manager@example.in',    'manager',    true, null),
  ('43900000-0000-4000-8000-00000000000c', '43900000-0000-4000-8000-000000000001', 'r439-accountant@example.in', 'accountant', true, null),
  ('43900000-0000-4000-8000-00000000000d', '43900000-0000-4000-8000-000000000001', 'r439-emp@example.in',        'sales',      true, '43900000-0000-4000-8000-0000000000e1'),
  ('43900000-0000-4000-8000-00000000000f', '43900000-0000-4000-8000-000000000002', 'r439-other-owner@example.in','owner',      true, null);
-- ...0e has no public.users row → current_tenant_id() is NULL.

-- A kiosk day 2 days ago (IST) with a WRONG check-out: 10:20 → 11:00.
insert into public.attendance (tenant_id, employee_id, work_date, check_in, check_out, source)
  values ('43900000-0000-4000-8000-000000000001', '43900000-0000-4000-8000-0000000000e1',
          (now() at time zone 'Asia/Kolkata')::date - 2,
          (((now() at time zone 'Asia/Kolkata')::date - 2)::text || 'T10:20:00+05:30')::timestamptz,
          (((now() at time zone 'Asia/Kolkata')::date - 2)::text || 'T11:00:00+05:30')::timestamptz, 'kiosk');

do $$
declare
  c_emp  constant uuid := '43900000-0000-4000-8000-0000000000e1';
  d      date := (now() at time zone 'Asia/Kolkata')::date - 2;
  v_err  boolean;
  v_n    int;
  v_r    text;
  v_a    public.attendance_corrections;
  v_out  timestamptz;
  who    text;
begin
  set local role authenticated;

  -- ── REFUSED: manager, accountant, the employee, no company ─────────────────────
  foreach who in array array['43900000-0000-4000-8000-00000000000b',
                             '43900000-0000-4000-8000-00000000000c',
                             '43900000-0000-4000-8000-00000000000d',
                             '43900000-0000-4000-8000-00000000000e'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    v_err := false;
    begin
      perform public.correct_attendance(c_emp, d, (d::text || 'T10:20:00+05:30')::timestamptz,
                                        (d::text || 'T19:00:00+05:30')::timestamptz, 'Trying to fix');
    exception when insufficient_privilege then v_err := true; end;
    if not v_err then
      if who = '43900000-0000-4000-8000-00000000000e' then
        raise exception 'FAIL 6: a login with no company (tenant NULL) corrected attendance';
      end if;
      raise exception 'FAIL 3: non-owner % corrected attendance', who;
    end if;
  end loop;

  reset role;
  select count(*) into v_n from public.attendance_corrections where employee_id = c_emp;
  if v_n <> 0 then raise exception 'FAIL 4: a refused correction wrote % audit row(s)', v_n; end if;
  select check_out into v_out from public.attendance where employee_id = c_emp and work_date = d;
  if v_out <> (d::text || 'T11:00:00+05:30')::timestamptz then raise exception 'FAIL 4: refused correction changed the row'; end if;
  set local role authenticated;

  -- ── OWNER: empty reason refused ───────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', '43900000-0000-4000-8000-00000000000a', 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    perform public.correct_attendance(c_emp, d, (d::text || 'T10:20:00+05:30')::timestamptz,
                                      (d::text || 'T19:00:00+05:30')::timestamptz, '   ');
  exception when invalid_parameter_value then v_err := true; end;
  if not v_err then raise exception 'FAIL 5: owner saved a correction with no reason'; end if;

  -- ── OWNER fixes the wrong check-out ───────────────────────────────────────────
  v_r := public.correct_attendance(c_emp, d, (d::text || 'T10:20:00+05:30')::timestamptz,
                                   (d::text || 'T19:00:00+05:30')::timestamptz, '  Kiosk recorded 11:00 by mistake ');
  if v_r <> 'saved' then raise exception 'FAIL 2: owner correction returned %', v_r; end if;

  select * into v_a from public.attendance_corrections where employee_id = c_emp;
  get diagnostics v_n = row_count;
  if v_a.id is null then raise exception 'FAIL 1: no audit row for the owner''s correction'; end if;
  if v_a.changed_by <> '43900000-0000-4000-8000-00000000000a' then raise exception 'FAIL 1: audit who = %', v_a.changed_by; end if;
  if v_a.changed_at is null or v_a.work_date <> d then raise exception 'FAIL 1: audit when / date wrong'; end if;
  if v_a.old_check_out <> (d::text || 'T11:00:00+05:30')::timestamptz
     or v_a.new_check_out <> (d::text || 'T19:00:00+05:30')::timestamptz
     or v_a.old_check_in <> (d::text || 'T10:20:00+05:30')::timestamptz then
    raise exception 'FAIL 1: audit old/new wrong: % → %', v_a.old_check_out, v_a.new_check_out;
  end if;
  if v_a.old_status <> 'present' or v_a.new_status <> 'present' then raise exception 'FAIL 1: audit status wrong'; end if;
  if v_a.reason <> 'Kiosk recorded 11:00 by mistake' then raise exception 'FAIL 1: audit reason %', v_a.reason; end if;

  select check_out into v_out from public.attendance where employee_id = c_emp and work_date = d;
  if v_out <> (d::text || 'T19:00:00+05:30')::timestamptz then raise exception 'FAIL 2: row check_out not corrected'; end if;

  -- ── OWNER marks the day absent → audit present → absent ───────────────────────
  v_r := public.correct_attendance(c_emp, d, null, null, 'Was on leave');
  if v_r <> 'absent' then raise exception 'FAIL 7: mark absent returned %', v_r; end if;
  if not exists (select 1 from public.attendance_corrections where employee_id = c_emp and old_status = 'present'
                 and new_status = 'absent' and new_check_in is null and reason = 'Was on leave') then
    raise exception 'FAIL 7: mark absent not in the audit trail';
  end if;
  -- put the day back for the direct-write checks
  perform public.correct_attendance(c_emp, d, (d::text || 'T10:20:00+05:30')::timestamptz,
                                    (d::text || 'T19:00:00+05:30')::timestamptz, 'Leave was cancelled');
  if (select count(*) from public.attendance_corrections where employee_id = c_emp) <> 3 then
    raise exception 'FAIL 7: expected 3 audit rows';
  end if;

  -- ── DIRECT writes through the API: refused for every login, owner included ────
  --    Even with the table privileges handed back (what cloudsql/09 does on a re-run), the
  --    trigger refuses — the grant revoke is only the first wall.
  reset role;
  grant insert, update, delete on public.attendance to authenticated;
  set local role authenticated;
  foreach who in array array['43900000-0000-4000-8000-00000000000a', '43900000-0000-4000-8000-00000000000b',
                             '43900000-0000-4000-8000-00000000000d'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    -- refused = the trigger raises (owner / manager) or RLS hides the row (the employee): 0 rows
    v_n := 0;
    begin
      update public.attendance set check_out = check_out + interval '2 hours' where employee_id = c_emp;
      get diagnostics v_n = row_count;
    exception when insufficient_privilege then v_n := 0; end;
    if v_n <> 0 then raise exception 'FAIL 8: % changed check_out directly', who; end if;
    v_err := false;
    begin
      insert into public.attendance (tenant_id, employee_id, work_date, check_in, source)
        values ('43900000-0000-4000-8000-000000000001', c_emp, d - 1, now() - interval '3 days', 'manual');
    exception when insufficient_privilege then v_err := true; end;
    if not v_err then raise exception 'FAIL 8: % inserted attendance directly', who; end if;
    -- delete: no policy left → RLS hides the row (0 rows) or the trigger refuses; either way it stays
    v_n := 0;
    begin
      delete from public.attendance where employee_id = c_emp;
      get diagnostics v_n = row_count;
    exception when insufficient_privilege then v_n := 0; end;
    if v_n <> 0 then raise exception 'FAIL 8: % deleted attendance directly', who; end if;
  end loop;

  -- review queue still works for a manager
  perform set_config('request.jwt.claims', json_build_object('sub', '43900000-0000-4000-8000-00000000000b', 'role', 'authenticated')::text, true);
  update public.attendance set reviewed_at = now() where employee_id = c_emp and work_date = d;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 9: manager could not mark a day reviewed (% rows)', v_n; end if;

  -- ── AUDIT: manager reads it; other tenant's owner sees nothing; nobody writes ──
  select count(*) into v_n from public.attendance_corrections where employee_id = c_emp;
  if v_n <> 3 then raise exception 'FAIL 10: manager sees % audit rows, expected 3', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', '43900000-0000-4000-8000-00000000000f', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.attendance_corrections;
  if v_n <> 0 then raise exception 'FAIL 10: another tenant''s owner read % audit rows', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', '43900000-0000-4000-8000-00000000000a', 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    delete from public.attendance_corrections where employee_id = c_emp;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 11: owner deleted the audit trail'; end if;
  v_err := false;
  begin
    update public.attendance_corrections set reason = 'rewritten' where employee_id = c_emp;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 11: owner rewrote the audit trail'; end if;
  v_err := false;
  begin
    insert into public.attendance_corrections (tenant_id, employee_id, work_date, old_status, new_status, reason)
      values ('43900000-0000-4000-8000-000000000001', c_emp, d, 'absent', 'present', 'forged row');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 11: owner forged an audit row'; end if;

  reset role;
  raise notice 'attendance_owner_correction: all 11 checks passed';
end $$;

rollback;
