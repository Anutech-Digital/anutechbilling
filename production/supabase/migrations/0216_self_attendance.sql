-- 0216 — self check-in for logged-in app users.
--
-- Each app user (users) can mark their OWN attendance from their login. The
-- login itself is the identity proof (no PIN/selfie needed — unlike the shared
-- kiosk). A user is linked to an employee via users.employee_id.

alter table public.users add column if not exists employee_id uuid references public.employees(id) on delete set null;

-- Best-effort backfill: link users to employees with the same email (same tenant).
update public.users u
set employee_id = e.id
from public.employees e
where u.employee_id is null
  and e.tenant_id = u.tenant_id
  and e.email is not null
  and lower(e.email) = lower(u.email);

-- Link the caller to an employee (one-time, if not auto-matched).
create or replace function public.set_my_employee(p_employee_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if not exists (select 1 from public.employees where id = p_employee_id and tenant_id = v_tenant) then
    raise exception 'Employee not in your workspace';
  end if;
  update public.users set employee_id = p_employee_id where id = auth.uid();
end $$;

-- Today's self-attendance status for the caller.
create or replace function public.my_attendance_today()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_emp uuid; v_name text; v_date date; v_row public.attendance;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then return jsonb_build_object('linked', false); end if;
  select name into v_name from public.employees where id = v_emp;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  return jsonb_build_object(
    'linked', true, 'employee_name', v_name, 'work_date', v_date,
    'check_in', v_row.check_in, 'check_out', v_row.check_out
  );
end $$;

-- Toggle self check-in / check-out for today (login = identity, no PIN/selfie).
create or replace function public.mark_self_attendance()
returns text language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_emp uuid; v_date date; v_row public.attendance;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then raise exception 'Pehle apna employee link karo.'; end if;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  if not found then
    insert into public.attendance (tenant_id, employee_id, work_date, check_in, source)
    values (v_tenant, v_emp, v_date, now(), 'self');
    return 'checked_in';
  elsif v_row.check_out is null then
    update public.attendance set check_out = now() where id = v_row.id;
    return 'checked_out';
  else
    return 'already_done';
  end if;
end $$;

grant execute on function public.set_my_employee(uuid) to authenticated;
grant execute on function public.my_attendance_today() to authenticated;
grant execute on function public.mark_self_attendance() to authenticated;
