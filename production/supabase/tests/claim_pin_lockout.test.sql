-- Regression test: R-725 (20261011154500_r725_claim_pin_lockout.sql). Rolled back.
--
--   ALLOWED  right PIN → 'ok' and clears the wrong-count
--   BLOCKED  the 5th wrong PIN in a row locks; the RIGHT PIN is then refused too
--   BLOCKED  the counter survives (returned, not raised) and the 10th wrong PIN locks longer
--   BLOCKED  a kiosk lock (employee_pin_attempts) also locks the claim PIN
--   BLOCKED  another tenant's employee id → 'not_found', nothing counted
--   BLOCKED  a signed-in member calling claim_pin_check / reading the counter table

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('47250000-0000-4000-8000-000000000001', 'R725 TEST', 'r725@example.in', '07', 'R725'),
  ('47250000-0000-4000-8000-000000000002', 'R725 OTHER', 'r725b@example.in', '07', 'R72B');
insert into auth.users (id, instance_id, aud, role, email) values
  ('47250000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r725-sales@example.in');
insert into public.users (id, tenant_id, email, role, is_active)
  values ('47250000-0000-4000-8000-00000000000b', '47250000-0000-4000-8000-000000000001', 'r725-sales@example.in', 'sales', true);
insert into public.employees (id, tenant_id, name, is_active, pin_hash) values
  ('47250000-0000-4000-8000-0000000000e1', '47250000-0000-4000-8000-000000000001', 'Emp A', true, crypt('4321', gen_salt('bf'))),
  ('47250000-0000-4000-8000-0000000000e2', '47250000-0000-4000-8000-000000000001', 'Emp B', true, crypt('1111', gen_salt('bf'))),
  ('47250000-0000-4000-8000-0000000000e3', '47250000-0000-4000-8000-000000000002', 'Emp C', true, crypt('2222', gen_salt('bf')));

do $$
declare v_err boolean; v_r text; v_n int; v_lock1 timestamptz; v_lock2 timestamptz;
  t uuid := '47250000-0000-4000-8000-000000000001';
  a uuid := '47250000-0000-4000-8000-0000000000e1';
  b uuid := '47250000-0000-4000-8000-0000000000e2';
  c uuid := '47250000-0000-4000-8000-0000000000e3';
begin
  -- ALLOWED: right PIN
  v_r := public.claim_pin_check(t, b, '1111');
  if v_r <> 'ok' then raise exception 'FAIL 1: right PIN returned %', v_r; end if;

  -- a wrong one, then right → counter cleared
  v_r := public.claim_pin_check(t, b, '0000');
  if v_r <> 'wrong_pin' then raise exception 'FAIL 2: wrong PIN returned %', v_r; end if;
  v_r := public.claim_pin_check(t, b, '1111');
  select count(*) into v_n from public.expense_claim_pin_attempts where employee_id = b;
  if v_r <> 'ok' or v_n <> 0 then raise exception 'FAIL 3: right PIN did not clear the counter (% / %)', v_r, v_n; end if;

  -- wrong x4 → wrong_pin, 5th → pin_locked, then right PIN refused
  for i in 1..4 loop
    v_r := public.claim_pin_check(t, a, '0000');
    if v_r <> 'wrong_pin' then raise exception 'FAIL 4: wrong try % returned %', i, v_r; end if;
  end loop;
  v_r := public.claim_pin_check(t, a, '0000');
  if v_r <> 'pin_locked' then raise exception 'FAIL 5: 5th wrong PIN returned %', v_r; end if;
  v_r := public.claim_pin_check(t, a, '4321');
  if v_r <> 'pin_locked' then raise exception 'FAIL 6: right PIN during lock returned %', v_r; end if;

  -- lock grows: expire it, 5 more wrong → longer lock, counter kept
  select locked_until into v_lock1 from public.expense_claim_pin_attempts where employee_id = a;
  update public.expense_claim_pin_attempts set locked_until = now() - interval '1 second' where employee_id = a;
  for i in 1..5 loop v_r := public.claim_pin_check(t, a, '9999'); end loop;
  select locked_until, failed into v_lock2, v_n from public.expense_claim_pin_attempts where employee_id = a;
  if v_r <> 'pin_locked' or v_n <> 10 or v_lock2 - now() <= v_lock1 - now() + interval '10 minutes' then
    raise exception 'FAIL 7: second lock did not grow (r=% failed=%)', v_r, v_n;
  end if;

  -- kiosk lock also blocks the claim PIN
  insert into public.employee_pin_attempts (employee_id, tenant_id, failed, locked_until)
    values (b, t, 5, now() + interval '15 minutes');
  v_r := public.claim_pin_check(t, b, '1111');
  if v_r <> 'pin_locked' then raise exception 'FAIL 8: kiosk lock ignored, returned %', v_r; end if;

  -- other tenant's employee
  v_r := public.claim_pin_check(t, c, '0000');
  select count(*) into v_n from public.expense_claim_pin_attempts where employee_id = c;
  if v_r <> 'not_found' or v_n <> 0 then raise exception 'FAIL 9: cross-tenant employee returned % (counted %)', v_r, v_n; end if;

  -- BLOCKED: a login
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','47250000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  v_err := false;
  begin perform public.claim_pin_check(t, a, '4321');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 10: authenticated can call claim_pin_check'; end if;
  v_err := false;
  begin perform count(*) from public.expense_claim_pin_attempts;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 11: authenticated can read expense_claim_pin_attempts'; end if;
  reset role;

  raise notice 'claim_pin_lockout: all 11 checks passed';
end $$;

rollback;
