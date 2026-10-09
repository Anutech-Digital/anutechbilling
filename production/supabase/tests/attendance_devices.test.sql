-- Regression test: attendance passkey devices (R-606, migration 20261009235000_attendance_devices.sql).
-- Rolled back — safe anywhere.
--
--   BLOCKED  a `sales` login INSERTing a device for itself (server writes only)
--   BLOCKED  a `sales` login approving its own pending device (0 rows touched / denied)
--   BLOCKED  a `sales` login reading the webauthn challenges table
--   BLOCKED  a third live device for one employee; a third approved device (trigger)
--   BLOCKED  a device pointing at an employee of another tenant
--   BLOCKED  anon reading devices
--   ALLOWED  sales sees ONLY its own devices; owner sees every device in the tenant
--   ALLOWED  the other tenant's owner sees none of them
--   ALLOWED  require_device readable by authenticated (R-601 column grants)

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('46060000-0000-4000-8000-000000000001', 'R606 TEST',  'r606@example.in',  '07', 'R606'),
  ('46060000-0000-4000-8000-000000000002', 'R606 OTHER', 'r606o@example.in', '07', 'R6O');

insert into auth.users (id, instance_id, aud, role, email) values
  ('46060000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r606-owner@example.in'),
  ('46060000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r606-sales@example.in'),
  ('46060000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r606-mgr@example.in'),
  ('46060000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r606-other@example.in');

insert into public.employees (id, tenant_id, name, is_active) values
  ('46060000-0000-4000-8000-0000000000e1', '46060000-0000-4000-8000-000000000001', 'Sales Emp R606', true),
  ('46060000-0000-4000-8000-0000000000e2', '46060000-0000-4000-8000-000000000001', 'Manager Emp R606', true),
  ('46060000-0000-4000-8000-0000000000e9', '46060000-0000-4000-8000-000000000002', 'Other Emp R606', true);

insert into public.users (id, tenant_id, email, role, is_active, employee_id) values
  ('46060000-0000-4000-8000-00000000000a', '46060000-0000-4000-8000-000000000001', 'r606-owner@example.in', 'owner',   true, null),
  ('46060000-0000-4000-8000-00000000000b', '46060000-0000-4000-8000-000000000001', 'r606-sales@example.in', 'sales',   true, '46060000-0000-4000-8000-0000000000e1'),
  ('46060000-0000-4000-8000-00000000000c', '46060000-0000-4000-8000-000000000001', 'r606-mgr@example.in',   'manager', true, '46060000-0000-4000-8000-0000000000e2'),
  ('46060000-0000-4000-8000-00000000000d', '46060000-0000-4000-8000-000000000002', 'r606-other@example.in', 'owner',   true, null);

insert into public.attendance_settings (tenant_id, require_device)
  values ('46060000-0000-4000-8000-000000000001', true);

/* Fixture devices, written as the server would (service role). */
insert into public.attendance_devices (id, tenant_id, employee_id, user_id, credential_id, public_key, label, status) values
  ('46060000-0000-4000-8000-0000000000d1', '46060000-0000-4000-8000-000000000001', '46060000-0000-4000-8000-0000000000e1',
   '46060000-0000-4000-8000-00000000000b', 'r606-cred-sales-1', 'pk1', 'Sales laptop', 'pending'),
  ('46060000-0000-4000-8000-0000000000d3', '46060000-0000-4000-8000-000000000001', '46060000-0000-4000-8000-0000000000e2',
   '46060000-0000-4000-8000-00000000000c', 'r606-cred-mgr-1', 'pk3', 'Manager phone', 'approved');

do $$
declare v_err boolean; v_n int; v_b boolean;
begin
  -- ── BLOCKED: a third live device (trigger, even for the server) ─────────
  insert into public.attendance_devices (tenant_id, employee_id, credential_id, public_key, label, status)
  values ('46060000-0000-4000-8000-000000000001', '46060000-0000-4000-8000-0000000000e1', 'r606-cred-sales-2', 'pk2', 'Sales phone', 'approved');
  v_err := false;
  begin
    insert into public.attendance_devices (tenant_id, employee_id, credential_id, public_key, label)
    values ('46060000-0000-4000-8000-000000000001', '46060000-0000-4000-8000-0000000000e1', 'r606-cred-sales-3', 'pk', 'Third');
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 1: a third live device was accepted'; end if;

  -- ── BLOCKED: a third APPROVED device after revoking-and-adding ──────────
  update public.attendance_devices set status = 'approved' where id = '46060000-0000-4000-8000-0000000000d1';
  insert into public.attendance_devices (tenant_id, employee_id, credential_id, public_key, label, status)
  values ('46060000-0000-4000-8000-000000000001', '46060000-0000-4000-8000-0000000000e1', 'r606-cred-sales-r', 'pk', 'Old', 'revoked');
  v_err := false;
  begin
    update public.attendance_devices set status = 'approved' where credential_id = 'r606-cred-sales-r';
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 2: a third approved device was accepted'; end if;
  update public.attendance_devices set status = 'pending', approved_at = null where id = '46060000-0000-4000-8000-0000000000d1';

  -- ── BLOCKED: device for an employee of another tenant ───────────────────
  v_err := false;
  begin
    insert into public.attendance_devices (tenant_id, employee_id, credential_id, public_key, label)
    values ('46060000-0000-4000-8000-000000000001', '46060000-0000-4000-8000-0000000000e9', 'r606-cred-x', 'pk', 'Cross');
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 3: a device was tied to another tenant''s employee'; end if;

  -- ══ as SALES ════════════════════════════════════════════════════════════
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','46060000-0000-4000-8000-00000000000b','role','authenticated')::text, true);

  v_err := false;
  begin
    insert into public.attendance_devices (tenant_id, employee_id, credential_id, public_key, label)
    values ('46060000-0000-4000-8000-000000000001', '46060000-0000-4000-8000-0000000000e1', 'r606-cred-evil', 'pk', 'Evil');
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 4: a sales login inserted a device directly'; end if;

  v_err := false;
  begin
    update public.attendance_devices set status = 'approved' where id = '46060000-0000-4000-8000-0000000000d1';
    get diagnostics v_n = row_count;
    if v_n = 0 then v_err := true; end if;
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 5: a sales login approved its own device'; end if;

  select count(*) into v_n from public.attendance_devices;
  if v_n <> 3 then raise exception 'FAIL 6: sales sees % devices, expected its own 3', v_n; end if;
  select count(*) into v_n from public.attendance_devices where employee_id <> '46060000-0000-4000-8000-0000000000e1';
  if v_n <> 0 then raise exception 'FAIL 7: sales sees a colleague''s device'; end if;

  v_err := false;
  begin
    perform 1 from public.attendance_webauthn_challenges;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 8: a sales login can read webauthn challenges'; end if;

  select require_device into v_b from public.attendance_settings;
  if v_b is distinct from true then raise exception 'FAIL 9: require_device not readable by authenticated'; end if;

  -- ══ as MANAGER — sees only own device (owner-only approval, owner-only overview) ══
  perform set_config('request.jwt.claims', json_build_object('sub','46060000-0000-4000-8000-00000000000c','role','authenticated')::text, true);
  select count(*) into v_n from public.attendance_devices;
  if v_n <> 1 then raise exception 'FAIL 10: manager sees % devices, expected own 1', v_n; end if;

  -- ══ as OWNER ════════════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub','46060000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  select count(*) into v_n from public.attendance_devices;
  if v_n <> 4 then raise exception 'FAIL 11: owner sees % devices, expected all 4 in the tenant', v_n; end if;

  -- ══ as the OTHER tenant's owner ═════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub','46060000-0000-4000-8000-00000000000d','role','authenticated')::text, true);
  select count(*) into v_n from public.attendance_devices where tenant_id = '46060000-0000-4000-8000-000000000001';
  if v_n <> 0 then raise exception 'FAIL 12: another tenant sees % of our devices', v_n; end if;

  reset role;

  -- ── BLOCKED: anon ───────────────────────────────────────────────────────
  set local role anon;
  v_err := false;
  begin
    perform 1 from public.attendance_devices limit 1;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 13: anon can read attendance_devices'; end if;
  reset role;

  raise notice 'attendance_devices: all 13 checks passed';
end $$;

rollback;
