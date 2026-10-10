-- Regression test: attendance rows and settings are written by HR roles, not by any member.
-- Migration 20261009213000_attendance_role_writes.sql (R-601). Rolled back — safe anywhere.
--
--   BLOCKED  a `sales` login INSERTing a present day for itself straight into attendance
--   BLOCKED  a `sales` login UPDATEing / clearing flags on its own row (0 rows touched)
--   BLOCKED  a `sales` login reading attendance_settings.presence_secret
--   BLOCKED  a `sales` login switching off require_selfie
--   BLOCKED  anon touching attendance at all
--   ALLOWED  the same `sales` login checking in through mark_self_attendance()
--   ALLOWED  an owner marking reviewed / correcting a row, and reading the non-secret settings
--
-- The ALLOWED rows matter as much as the BLOCKED ones: a lock that also stopped the
-- employee's own check-in would be switched off within a day (L103).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('46010000-0000-4000-8000-000000000001', 'R601 TEST', 'r601@example.in', '07', 'R601');

insert into auth.users (id, instance_id, aud, role, email) values
  ('46010000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r601-owner@example.in'),
  ('46010000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r601-sales@example.in');

insert into public.employees (id, tenant_id, name, is_active)
  values ('46010000-0000-4000-8000-0000000000e1', '46010000-0000-4000-8000-000000000001', 'Sales Emp R601', true);

insert into public.users (id, tenant_id, email, role, is_active, employee_id) values
  ('46010000-0000-4000-8000-00000000000a', '46010000-0000-4000-8000-000000000001', 'r601-owner@example.in', 'owner', true, null),
  ('46010000-0000-4000-8000-00000000000b', '46010000-0000-4000-8000-000000000001', 'r601-sales@example.in', 'sales', true, '46010000-0000-4000-8000-0000000000e1');

insert into public.attendance_settings (tenant_id, require_selfie, presence_secret)
  values ('46010000-0000-4000-8000-000000000001', true, 'r601-secret-seed');

/* Yesterday's row with a flag the employee would like gone. */
insert into public.attendance (tenant_id, employee_id, work_date, check_in, source, flags)
  values ('46010000-0000-4000-8000-000000000001', '46010000-0000-4000-8000-0000000000e1',
          (now() at time zone 'Asia/Kolkata')::date - 1, now() - interval '1 day', 'self', array['no_location']);

do $$
declare v_err boolean; v_n int; v_action text; v_flags text[];
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','46010000-0000-4000-8000-00000000000b','role','authenticated')::text, true);

  -- ── BLOCKED: sales inserts a present day for itself ─────────────────────
  v_err := false;
  begin
    insert into public.attendance (tenant_id, employee_id, work_date, check_in, source)
    values ('46010000-0000-4000-8000-000000000001', '46010000-0000-4000-8000-0000000000e1',
            (now() at time zone 'Asia/Kolkata')::date - 5, now() - interval '5 days', 'self');
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 1: a sales login inserted its own attendance row directly'; end if;

  -- ── BLOCKED: sales clears its flag (RLS → 0 rows, no error) ──────────────
  update public.attendance set flags = '{}', reviewed_at = now()
   where employee_id = '46010000-0000-4000-8000-0000000000e1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 2: a sales login updated % attendance row(s)', v_n; end if;

  -- ── BLOCKED: sales reads the presence seed ──────────────────────────────
  v_err := false;
  begin
    perform presence_secret from public.attendance_settings;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 3: a sales login can read presence_secret'; end if;

  -- ── BLOCKED: sales switches the selfie rule off (RLS → 0 rows) ──────────
  update public.attendance_settings set require_selfie = false;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: a sales login changed attendance_settings'; end if;

  -- ── ALLOWED: sales checks in through the RPC ────────────────────────────
  v_action := public.mark_self_attendance();
  if v_action <> 'checked_in' then raise exception 'FAIL 5: mark_self_attendance returned %', v_action; end if;

  -- ── ALLOWED: owner reviews + corrects, reads non-secret settings ────────
  perform set_config('request.jwt.claims', json_build_object('sub','46010000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  update public.attendance set reviewed_at = now()
   where employee_id = '46010000-0000-4000-8000-0000000000e1'
     and work_date = (now() at time zone 'Asia/Kolkata')::date - 1;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 6: owner could not mark the row reviewed (% rows)', v_n; end if;

  perform require_selfie, require_presence, allowed_ips from public.attendance_settings;
  update public.attendance_settings set require_presence = true;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 7: owner could not change attendance_settings'; end if;

  reset role;

  -- ── BLOCKED: anon ───────────────────────────────────────────────────────
  set local role anon;
  v_err := false;
  begin
    perform 1 from public.attendance limit 1;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 8: anon can still read attendance'; end if;
  reset role;

  select flags into v_flags from public.attendance
   where employee_id = '46010000-0000-4000-8000-0000000000e1'
     and work_date = (now() at time zone 'Asia/Kolkata')::date - 1;
  if v_flags <> array['no_location'] then raise exception 'FAIL 9: flags changed to %', v_flags; end if;

  raise notice 'attendance_role_writes: all 9 checks passed';
end $$;

rollback;
