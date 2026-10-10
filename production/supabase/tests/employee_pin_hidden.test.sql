-- Regression test: R-607 part 2 (20261010010000_employee_pin_hidden.sql). Rolled back.
--
--   BLOCKED  a `sales` login reading employees.pin_hash
--   BLOCKED  an OWNER reading it too — nobody's browser needs the hash
--   BLOCKED  anon reading employees
--   ALLOWED  members reading every other column + pin_set (the Payroll screen's list)
--   ALLOWED  the kiosk RPC still checking the PIN (SECURITY DEFINER reads the hash)

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('46072000-0000-4000-8000-000000000001', 'R607B TEST', 'r607b@example.in', '07', 'R67B');
insert into auth.users (id, instance_id, aud, role, email) values
  ('46072000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r607b-owner@example.in'),
  ('46072000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r607b-sales@example.in');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('46072000-0000-4000-8000-00000000000a', '46072000-0000-4000-8000-000000000001', 'r607b-owner@example.in', 'owner', true),
  ('46072000-0000-4000-8000-00000000000b', '46072000-0000-4000-8000-000000000001', 'r607b-sales@example.in', 'sales', true);
insert into public.employees (id, tenant_id, name, is_active, pin_hash) values
  ('46072000-0000-4000-8000-0000000000e1', '46072000-0000-4000-8000-000000000001', 'Emp With PIN', true, crypt('2468', gen_salt('bf'))),
  ('46072000-0000-4000-8000-0000000000e2', '46072000-0000-4000-8000-000000000001', 'Emp No PIN', true, null);

do $$
declare v_err boolean; v_set boolean; v_name text; v_r text;
begin
  set local role authenticated;

  -- ── sales: hash refused, everything else readable ──────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','46072000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  v_err := false;
  begin perform pin_hash from public.employees;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 1: a sales login can read employees.pin_hash'; end if;

  select pin_set, name into v_set, v_name from public.employees where id = '46072000-0000-4000-8000-0000000000e1';
  if v_set is not true or v_name <> 'Emp With PIN' then raise exception 'FAIL 2: pin_set/name not readable (% %)', v_set, v_name; end if;
  select pin_set into v_set from public.employees where id = '46072000-0000-4000-8000-0000000000e2';
  if v_set is not false then raise exception 'FAIL 3: pin_set should be false without a PIN'; end if;

  -- ── owner: hash refused as well ────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','46072000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  v_err := false;
  begin perform pin_hash from public.employees;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 4: an owner can read employees.pin_hash'; end if;

  -- ── the kiosk RPC still verifies the PIN ───────────────────────────────
  v_r := public.mark_attendance('46072000-0000-4000-8000-0000000000e1', '2468', null);
  if v_r <> 'checked_in' then raise exception 'FAIL 5: mark_attendance with the right PIN returned %', v_r; end if;

  reset role;
  set local role anon;
  v_err := false;
  begin perform 1 from public.employees limit 1;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 6: anon can read employees'; end if;
  reset role;

  raise notice 'employee_pin_hidden: all 6 checks passed';
end $$;

rollback;
