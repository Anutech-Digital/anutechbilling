-- Regression test: R-605 (20261010040000_attendance_outside_office.sql). Rolled back.
--
--   ALLOWED  a member reading attendance_anywhere (My Attendance + Payroll list need it —
--            R-607 made employees column-granted, so a missing grant = "permission denied")
--   BLOCKED  a `sales` login switching itself to "Can mark from outside office"
--   DEFAULT  off for a new employee

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('46050000-0000-4000-8000-000000000001', 'R605 TEST', 'r605@example.in', '07', 'R605');
insert into auth.users (id, instance_id, aud, role, email) values
  ('46050000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r605-sales@example.in');
insert into public.employees (id, tenant_id, name, is_active)
  values ('46050000-0000-4000-8000-0000000000e1', '46050000-0000-4000-8000-000000000001', 'Field Sales', true);
insert into public.users (id, tenant_id, email, role, is_active, employee_id)
  values ('46050000-0000-4000-8000-00000000000b', '46050000-0000-4000-8000-000000000001', 'r605-sales@example.in', 'sales', true, '46050000-0000-4000-8000-0000000000e1');

do $$
declare v boolean; v_n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','46050000-0000-4000-8000-00000000000b','role','authenticated')::text, true);

  select attendance_anywhere into v from public.employees where id = '46050000-0000-4000-8000-0000000000e1';
  if v is distinct from false then raise exception 'FAIL 1: attendance_anywhere unreadable or not false by default (%)', v; end if;

  update public.employees set attendance_anywhere = true where id = '46050000-0000-4000-8000-0000000000e1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 2: a sales login turned on its own outside-office permission'; end if;

  reset role;
  raise notice 'attendance_outside_office: all 2 checks passed';
end $$;

rollback;
