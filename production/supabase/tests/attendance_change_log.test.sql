-- Regression test: R-608 (20261010050000_attendance_change_log.sql). Rolled back.
--
--   LOGGED      an owner inserting / editing / deleting someone's attendance — who + before→after
--   LOGGED      an owner's edit made through the server client (x-actor-id, R-051)
--   NOT LOGGED  the employee's own check-in (mark_self_attendance) — it carries its own proof
--   NOT LOGGED  a kiosk punch (mark_attendance)
--   NOT LOGGED  a write with no person behind it (service role, no actor)
--   NOT LOGGED  the kiosk's selfie-path attach (only selfie_in/selfie_out change)

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.headers', '{}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('46080000-0000-4000-8000-000000000001', 'R608 TEST', 'r608@example.in', '07', 'R608');
insert into auth.users (id, instance_id, aud, role, email) values
  ('46080000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r608-owner@example.in'),
  ('46080000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r608-sales@example.in');
insert into public.employees (id, tenant_id, name, is_active, pin_hash) values
  ('46080000-0000-4000-8000-0000000000e1', '46080000-0000-4000-8000-000000000001', 'Sales Person', true, crypt('1357', gen_salt('bf'))),
  ('46080000-0000-4000-8000-0000000000e2', '46080000-0000-4000-8000-000000000001', 'Friend', true, null);
insert into public.users (id, tenant_id, email, role, is_active, employee_id) values
  ('46080000-0000-4000-8000-00000000000a', '46080000-0000-4000-8000-000000000001', 'r608-owner@example.in', 'owner', true, null),
  ('46080000-0000-4000-8000-00000000000b', '46080000-0000-4000-8000-000000000001', 'r608-sales@example.in', 'sales', true, '46080000-0000-4000-8000-0000000000e1');

-- No person behind it (biometric ingest / cron) → not logged.
insert into public.attendance (tenant_id, employee_id, work_date, check_in, source)
  values ('46080000-0000-4000-8000-000000000001', '46080000-0000-4000-8000-0000000000e2', date '2026-10-01', '2026-10-01 10:00+05:30', 'biometric');

do $$
declare v_n int; v_c jsonb; v_r text; v_who uuid;
begin
  select count(*) into v_n from public.activity_log where tenant_id = '46080000-0000-4000-8000-000000000001' and entity = 'attendance';
  if v_n <> 0 then raise exception 'FAIL 1: a machine write was logged'; end if;

  set local role authenticated;

  -- ── employee's own check-in: not logged ────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','46080000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  v_r := public.mark_self_attendance(null, null, null);   -- R-438: the 0-argument version is server-only now
  if v_r <> 'checked_in' then raise exception 'FAIL 2: self check-in returned %', v_r; end if;

  -- ── owner at the kiosk punches Friend? Friend has no PIN; use Sales Person's PIN via kiosk path
  perform set_config('request.jwt.claims', json_build_object('sub','46080000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  v_r := public.mark_attendance('46080000-0000-4000-8000-0000000000e1', '1357', null);
  -- (Sales Person already checked in seconds ago → 'too_soon'; either way, nothing to log)

  reset role;
  perform set_config('app.attendance_mark', '', true);   -- the kiosk marker is transaction-local; clear it for the HR edits below
  select count(*) into v_n from public.activity_log where tenant_id = '46080000-0000-4000-8000-000000000001' and entity = 'attendance';
  if v_n <> 0 then raise exception 'FAIL 3: own check-in or kiosk punch was logged (% rows)', v_n; end if;

  -- ── owner edits Friend's day: logged with before → after. R-439: no login may write
  --    attendance rows directly any more, so the owner edits through correct_attendance(). ──
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','46080000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  perform public.correct_attendance('46080000-0000-4000-8000-0000000000e2', date '2026-10-01',
          '2026-10-01 10:00+05:30', '2026-10-01 19:00+05:30', 'Forgot to check out');
  perform public.correct_attendance('46080000-0000-4000-8000-0000000000e2', date '2026-10-03',
          '2026-10-03 10:00+05:30', '2026-10-03 18:00+05:30', 'Kiosk was down');
  perform public.correct_attendance('46080000-0000-4000-8000-0000000000e2', date '2026-10-03', null, null, 'Was on leave');
  reset role;

  select count(*) into v_n from public.activity_log
   where tenant_id = '46080000-0000-4000-8000-000000000001' and entity = 'attendance'
     and user_id = '46080000-0000-4000-8000-00000000000a';
  if v_n <> 3 then raise exception 'FAIL 4: expected 3 logged owner changes, got %', v_n; end if;

  select changes into v_c from public.activity_log
   where tenant_id = '46080000-0000-4000-8000-000000000001' and entity = 'attendance' and action = 'update';
  if v_c->'check_out'->>'old' is not null or v_c->'check_out'->>'new' is null then
    raise exception 'FAIL 5: update did not record check_out before/after: %', v_c;
  end if;

  -- ── owner's edit through the server client (x-actor-id) is attributed ──
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.headers', json_build_object('x-actor-id','46080000-0000-4000-8000-00000000000a')::text, true);
  update public.attendance set check_in = '2026-10-01 09:30+05:30'
   where employee_id = '46080000-0000-4000-8000-0000000000e2' and work_date = date '2026-10-01';
  select user_id into v_who from public.activity_log
   where tenant_id = '46080000-0000-4000-8000-000000000001' and entity = 'attendance' and changes ? 'check_in';
  if v_who is distinct from '46080000-0000-4000-8000-00000000000a' then raise exception 'FAIL 6: admin-client edit not attributed (%)', v_who; end if;

  -- ── kiosk selfie attach (only selfie_out changes, server client for the kiosk login): not logged
  select count(*) into v_n from public.activity_log where tenant_id = '46080000-0000-4000-8000-000000000001' and entity = 'attendance';
  update public.attendance set selfie_out = 'x/y/z.jpg'
   where employee_id = '46080000-0000-4000-8000-0000000000e2' and work_date = date '2026-10-01';
  if (select count(*) from public.activity_log where tenant_id = '46080000-0000-4000-8000-000000000001' and entity = 'attendance') <> v_n then
    raise exception 'FAIL 7: a selfie-path attach was logged';
  end if;

  raise notice 'attendance_change_log: all 7 checks passed';
end $$;

rollback;
