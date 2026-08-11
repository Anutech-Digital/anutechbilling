-- 0221 — accidental check-out guard + undo.
--
-- Problem: an employee checks in, then a stray second tap ~2 min later marks a
-- check-out by mistake, ending their day. Fixes:
--   • Double-tap guard — a check-out within 90s of check-in is treated as an
--     accidental tap and IGNORED (returns 'too_soon', no change). Kiosk + self.
--   • Undo — the employee can undo their last punch within 15 min
--     (clear a wrong check-out, or remove a wrong check-in). After that the
--     owner corrects it from the register (final safety net).
-- (A 90s..10min accidental check-out is caught by a client confirm dialog.)

-- Kiosk PIN path.
create or replace function public.mark_attendance(p_employee_id uuid, p_pin text, p_ip text default null)
returns text language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_hash   text;
  v_active boolean;
  v_date   date := (now() at time zone 'Asia/Kolkata')::date;
  v_row    public.attendance;
begin
  select pin_hash, is_active into v_hash, v_active from public.employees
    where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  if not coalesce(v_active, false) then raise exception 'Employee is inactive'; end if;
  if v_hash is null then raise exception 'No PIN set — ask the owner to set your PIN'; end if;
  if p_pin is null or crypt(p_pin, v_hash) <> v_hash then raise exception 'Wrong PIN'; end if;

  select * into v_row from public.attendance
    where tenant_id = v_tenant and employee_id = p_employee_id and work_date = v_date;

  if not found then
    insert into public.attendance (tenant_id, employee_id, work_date, check_in, source, marked_ip)
    values (v_tenant, p_employee_id, v_date, now(), 'kiosk', p_ip);
    return 'checked_in';
  elsif v_row.check_out is null then
    if now() - v_row.check_in < interval '90 seconds' then
      return 'too_soon';   -- accidental double tap right after check-in
    end if;
    update public.attendance set check_out = now(), marked_ip = coalesce(p_ip, marked_ip) where id = v_row.id;
    return 'checked_out';
  else
    return 'already_done';
  end if;
end;
$function$;

-- Self check-in path.
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
    if now() - v_row.check_in < interval '90 seconds' then
      return 'too_soon';   -- accidental double tap right after check-in
    end if;
    update public.attendance set check_out = now() where id = v_row.id;
    return 'checked_out';
  else
    return 'already_done';
  end if;
end $$;

-- Employee undoes their own last punch within 15 minutes.
create or replace function public.undo_my_last_punch()
returns text language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_emp uuid; v_date date; v_row public.attendance;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then raise exception 'Pehle apna employee link karo.'; end if;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  if not found then raise exception 'Aaj ka koi attendance record nahi.'; end if;

  if v_row.check_out is not null then
    if now() - v_row.check_out > interval '15 minutes' then
      raise exception 'Undo ka 15-min time nikal gaya — owner se correction karao.';
    end if;
    update public.attendance set check_out = null, selfie_out = null, geo_out = null, check_out_device = null where id = v_row.id;
    return 'undo_checkout';
  else
    if now() - v_row.check_in > interval '15 minutes' then
      raise exception 'Undo ka 15-min time nikal gaya — owner se correction karao.';
    end if;
    delete from public.attendance where id = v_row.id;
    return 'undo_checkin';
  end if;
end $$;

grant execute on function public.undo_my_last_punch() to authenticated;
