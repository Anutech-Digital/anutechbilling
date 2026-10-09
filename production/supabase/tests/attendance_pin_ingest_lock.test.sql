-- Regression test: R-607 (20261010000000_attendance_pin_ingest_lock.sql). Rolled back.
--
--   BLOCKED  a `sales` login reading the biometric ingest key (new column, or the old one)
--   BLOCKED  the 5th wrong kiosk PIN locks the employee; the RIGHT PIN is then refused too
--   BLOCKED  a `sales` login calling verify_claim_access directly (PIN guessing, no limit)
--   ALLOWED  a right PIN before the lock checks in; a wrong one returns 'wrong_pin' and the
--            counter survives (the whole point of returning instead of raising)
--   ALLOWED  service_role (the punch route) finding the tenant by the key

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('46070000-0000-4000-8000-000000000001', 'R607 TEST', 'r607@example.in', '07', 'R607');
insert into auth.users (id, instance_id, aud, role, email) values
  ('46070000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r607-sales@example.in');
insert into public.users (id, tenant_id, email, role, is_active)
  values ('46070000-0000-4000-8000-00000000000b', '46070000-0000-4000-8000-000000000001', 'r607-sales@example.in', 'sales', true);
insert into public.employees (id, tenant_id, name, is_active, pin_hash) values
  ('46070000-0000-4000-8000-0000000000e1', '46070000-0000-4000-8000-000000000001', 'Emp A', true, crypt('4321', gen_salt('bf'))),
  ('46070000-0000-4000-8000-0000000000e2', '46070000-0000-4000-8000-000000000001', 'Emp B', true, crypt('1111', gen_salt('bf')));
insert into public.attendance_settings (tenant_id, ingest_key)
  values ('46070000-0000-4000-8000-000000000001', 'r607-secret-ingest-key');

do $$
declare v_err boolean; v_r text; v_n int; v_t uuid;
begin
  -- ── ALLOWED: service role finds the tenant by key ──────────────────────
  select tenant_id into v_t from public.attendance_settings where ingest_key = 'r607-secret-ingest-key';
  if v_t is distinct from '46070000-0000-4000-8000-000000000001' then raise exception 'FAIL 1: key lookup broke'; end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','46070000-0000-4000-8000-00000000000b','role','authenticated')::text, true);

  -- ── BLOCKED: sales reads the key ───────────────────────────────────────
  v_err := false;
  begin perform ingest_key from public.attendance_settings;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 2: a sales login can read attendance_settings.ingest_key'; end if;
  select count(*) into v_n from public.tenants where attendance_ingest_key is not null;
  if v_n <> 0 then raise exception 'FAIL 3: tenants.attendance_ingest_key still holds a key'; end if;

  -- ── ALLOWED: right PIN checks Emp B in ─────────────────────────────────
  v_r := public.mark_attendance('46070000-0000-4000-8000-0000000000e2', '1111', null);
  if v_r <> 'checked_in' then raise exception 'FAIL 4: right PIN returned %', v_r; end if;

  -- ── wrong PIN x4 → 'wrong_pin', 5th → 'pin_locked' ─────────────────────
  for i in 1..4 loop
    v_r := public.mark_attendance('46070000-0000-4000-8000-0000000000e1', '0000', null);
    if v_r <> 'wrong_pin' then raise exception 'FAIL 5: wrong PIN try % returned %', i, v_r; end if;
  end loop;
  v_r := public.mark_attendance('46070000-0000-4000-8000-0000000000e1', '0000', null);
  if v_r <> 'pin_locked' then raise exception 'FAIL 6: 5th wrong PIN returned %', v_r; end if;

  -- ── BLOCKED: the right PIN is refused while locked ─────────────────────
  v_r := public.mark_attendance('46070000-0000-4000-8000-0000000000e1', '4321', null);
  if v_r <> 'pin_locked' then raise exception 'FAIL 7: right PIN during lock returned %', v_r; end if;

  -- ── BLOCKED: claim PIN function from a login ───────────────────────────
  v_err := false;
  begin perform public.verify_claim_access('46070000-0000-4000-8000-000000000001', '46070000-0000-4000-8000-0000000000e1', '4321');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 8: authenticated can still call verify_claim_access'; end if;

  reset role;
  select count(*) into v_n from public.attendance where employee_id = '46070000-0000-4000-8000-0000000000e1';
  if v_n <> 0 then raise exception 'FAIL 9: a locked PIN still marked attendance'; end if;

  raise notice 'attendance_pin_ingest_lock: all 9 checks passed';
end $$;

rollback;
