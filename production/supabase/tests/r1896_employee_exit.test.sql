-- R-1896 — an employee who leaves: their login ends after the last working day, and no salary
-- can be run for a month after they left.
-- Migration: 20261025141647_r1896_employee_exit.sql
--
-- Before the migration there was no exit date at all: unticking "Active employee" left the
-- linked login (users) working — part 0 shows that gap — and nothing stopped a payslip for a
-- month after the person had left. This file FAILS without the migration (start_employee_exit /
-- access_ends_on do not exist) and PASSES with it.
--
--   0. Gap that remains by design: employees.is_active = false alone does NOT end a login —
--      that is why "Start exit" exists (documents the old behaviour, not a regression).
--   1. A non-owner (manager) cannot start an exit; cannot clear their own access_ends_on.
--   2. Owner starts an exit with the last day in the FUTURE → the manager still works today.
--   3. Last day = TODAY → still works today (works through the last day).
--   4. Last day = YESTERDAY → current_tenant_id() NULL, no role, vault rows 0.
--   5. Payslip for the exit month is fine; for the month after it is refused (trigger).
--   6. Exit refused while a later month's salary exists.
--   7. Cancel exit → login works again, employee active.
--   8. An owner's own / owner-linked login cannot be ended from here.
--
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c1896000-0000-0000-0000-0000000000a1', 'r1896-owner@example.test'),
  ('c1896000-0000-0000-0000-0000000000a2', 'r1896-mgr@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c1896000-0000-0000-0000-0000000000f0', 'R1896 T', 'r1896@example.test', '07', 'R1896');

insert into public.employees (id, tenant_id, name, monthly_gross, joining_date) values
  ('c1896000-0000-0000-0000-0000000000e1', 'c1896000-0000-0000-0000-0000000000f0', 'R1896 Leaver', 105000, '2020-01-01'),
  ('c1896000-0000-0000-0000-0000000000e2', 'c1896000-0000-0000-0000-0000000000f0', 'R1896 Owner Staff', 50000, '2020-01-01');

insert into public.users (id, tenant_id, email, full_name, role, is_active, employee_id) values
  ('c1896000-0000-0000-0000-0000000000a1', 'c1896000-0000-0000-0000-0000000000f0', 'r1896-owner@example.test', 'R1896 Owner', 'owner', true, 'c1896000-0000-0000-0000-0000000000e2'),
  ('c1896000-0000-0000-0000-0000000000a2', 'c1896000-0000-0000-0000-0000000000f0', 'r1896-mgr@example.test', 'R1896 Mgr', 'manager', true, 'c1896000-0000-0000-0000-0000000000e1');

insert into public.vault_passwords (tenant_id, title, category)
  values ('c1896000-0000-0000-0000-0000000000f0', 'R1896 Google Admin', 'google_admin');

set local role authenticated;

-- ── 0. employees.is_active = false alone leaves the login working (why Start exit exists) ──
reset role;
update public.employees set is_active = false where id = 'c1896000-0000-0000-0000-0000000000e1';
set local role authenticated;
do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is null then
    raise exception 'FAIL 0: expected the old behaviour (login still works after unticking the employee)';
  end if;
  raise notice 'PASS 0: unticking the employee alone does not end the login — gap Start exit closes';
end $$;
reset role;
update public.employees set is_active = true where id = 'c1896000-0000-0000-0000-0000000000e1';
set local role authenticated;

-- ── 1. A manager cannot start an exit or clear their own end date ──────────────────────
do $$
declare v_refused boolean := false; v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  begin
    perform public.start_employee_exit('c1896000-0000-0000-0000-0000000000e2', public.ist_today(), 'resigned');
  exception when insufficient_privilege then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like 'Only an owner can start%' then
    raise exception 'FAIL 1a: manager could start an exit (msg %)', v_msg;
  end if;

  v_refused := false;
  begin
    update public.users set access_ends_on = public.ist_today() + 30
     where id = 'c1896000-0000-0000-0000-0000000000a2';
  exception when insufficient_privilege then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like '%login end date%' then
    raise exception 'FAIL 1b: a manager could set their own access_ends_on (msg %)', v_msg;
  end if;
  raise notice 'PASS 1: manager cannot start an exit or change a login end date';
end $$;

-- ── 2. Last day in the future → still works today ──────────────────────────────────────
do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  v_r := public.start_employee_exit('c1896000-0000-0000-0000-0000000000e1', public.ist_today() + 5, 'resigned',
                                    public.ist_today() - 25, 'moving city');
  if (v_r->>'logins_ending')::int <> 1 then raise exception 'FAIL 2: logins_ending = %', v_r; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is distinct from 'c1896000-0000-0000-0000-0000000000f0'::uuid then
    raise exception 'FAIL 2: exiting manager lost access before the last day';
  end if;
  raise notice 'PASS 2: last day in 5 days → still working today';
end $$;

reset role;
do $$
begin
  if (select access_ends_on from public.users where id = 'c1896000-0000-0000-0000-0000000000a2') <> public.ist_today() + 5 then
    raise exception 'FAIL 2b: access_ends_on not set to the last day';
  end if;
  if not (select is_active from public.employees where id = 'c1896000-0000-0000-0000-0000000000e1') then
    raise exception 'FAIL 2c: employee made inactive before the last day';
  end if;
end $$;
set local role authenticated;

-- ── 3. Last day = today → still works today ────────────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  perform public.start_employee_exit('c1896000-0000-0000-0000-0000000000e1', public.ist_today(), 'resigned');
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is null then
    raise exception 'FAIL 3: login ended ON the last working day (should end after it)';
  end if;
  raise notice 'PASS 3: last day today → works through today';
end $$;

-- ── 4. Last day = yesterday → no tenant, no role, no vault ────────────────────────────
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  perform public.start_employee_exit('c1896000-0000-0000-0000-0000000000e1', public.ist_today() - 1, 'resigned');
  -- the owner still works
  if public.current_tenant_id() is null then raise exception 'FAIL 4: owner lost access'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is not null then
    raise exception 'FAIL 4a: login still has a tenant after the last working day';
  end if;
  if public.current_user_has_role('owner', 'manager') then
    raise exception 'FAIL 4b: login still holds its role after the last working day';
  end if;
  select count(*) into v_n from public.vault_passwords;
  if v_n <> 0 then raise exception 'FAIL 4c: ex-employee still reads % vault rows', v_n; end if;
  raise notice 'PASS 4: day after the last day → no tenant, no role, 0 vault rows';
end $$;

reset role;
do $$
begin
  if (select is_active from public.employees where id = 'c1896000-0000-0000-0000-0000000000e1') then
    raise exception 'FAIL 4d: a past last day should make the employee inactive';
  end if;
end $$;

-- ── 5. Payslip for the exit month OK, for the month after refused ─────────────────────
do $$
declare v_exit date := public.ist_today() - 1; v_refused boolean := false; v_msg text;
begin
  insert into public.salary_payments (tenant_id, employee_id, period, pay_date, gross, net)
  values ('c1896000-0000-0000-0000-0000000000f0', 'c1896000-0000-0000-0000-0000000000e1',
          to_char(v_exit, 'YYYY-MM'), v_exit, 50000, 50000);
  begin
    insert into public.salary_payments (tenant_id, employee_id, period, pay_date, gross, net)
    values ('c1896000-0000-0000-0000-0000000000f0', 'c1896000-0000-0000-0000-0000000000e1',
            to_char(v_exit + interval '1 month', 'YYYY-MM'), v_exit, 50000, 50000);
  exception when others then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like 'R1896 Leaver left on %' then
    raise exception 'FAIL 5: salary after the exit month was not refused (msg %)', v_msg;
  end if;
  raise notice 'PASS 5: exit month payslip ok; next month refused: %', v_msg;
end $$;

-- ── 6. Exit refused while a later month's salary exists ───────────────────────────────
do $$
declare v_refused boolean := false; v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.start_employee_exit('c1896000-0000-0000-0000-0000000000e1', public.ist_today() - 40, 'resigned');
  exception when others then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like '%already run — undo it first%' then
    raise exception 'FAIL 6: exit before an already-run salary month was allowed (msg %)', v_msg;
  end if;
  raise notice 'PASS 6: %', v_msg;
end $$;

-- ── 7. Cancel → works again ───────────────────────────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  perform public.cancel_employee_exit('c1896000-0000-0000-0000-0000000000e1');
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is null then raise exception 'FAIL 7: cancelled exit still blocks the login'; end if;
  raise notice 'PASS 7: cancel exit gives the login back';
end $$;

-- ── 8. Owner-linked login cannot be ended here ────────────────────────────────────────
do $$
declare v_refused boolean := false; v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1896000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  begin
    perform public.start_employee_exit('c1896000-0000-0000-0000-0000000000e2', public.ist_today(), 'resigned');
  exception when insufficient_privilege then v_refused := true; v_msg := sqlerrm;
  end;
  if not v_refused or v_msg not like '%your own login%' then
    raise exception 'FAIL 8: owner could end their own login (msg %)', v_msg;
  end if;
  raise notice 'PASS 8: own / owner login refused';
end $$;

rollback;
