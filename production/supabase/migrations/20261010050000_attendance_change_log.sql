-- deploy-key: attendancechangelog
-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_attendance_change_log' and tgrelid = to_regclass('public.attendance'))
-- 20261010050000_attendance_change_log.sql
--
-- R-608 (10 Oct 2026). Pardeep: "R-608 shuru karo". Loophole audit #4: owner / manager /
-- accountant / billing may write attendance rows directly (R-601 kept that for them) and NOTHING
-- recorded it — only the R-603 "Fix attendance" RPC stamped corrected_by. A manager could fill
-- a friend's month quietly and payroll would pay it.
--
-- ══ WHAT IS RECORDED, in activity_log (entity 'attendance') ═════════════════════
--   Every insert / update / delete of an attendance row by anyone OTHER than the employee the
--   row belongs to — who (user_id, or 'Platform support'), when, and before → after per column.
--
-- ══ WHAT IS NOT, on purpose ════════════════════════════════════════════════════
--   • The employee's own marks: mark_self_attendance, undo_my_last_punch, and the selfie / geo /
--     device / flags patch /api/attendance/self adds after them (service role acting for that
--     same employee). These already carry their own proof (selfie, device, IP), and logging
--     every punch would bury the edits this log exists to show. An employee has no other way
--     to write their row since R-601.
--   • Kiosk punches: mark_attendance sets the transaction-local app.attendance_mark = 'kiosk'.
--     A client cannot set that setting (no SQL access; set_config is not an exposed RPC), so a
--     direct HR write can never pass itself off as a kiosk punch.
--   • The kiosk route's selfie-path attach right after a punch (only selfie_in/selfie_out change).
--   • Writes with no person behind them (biometric ingest, cron): same rule as log_row_change.
--
-- Uses the same actor resolution as log_row_change (auth.uid(), else audit_service_actor()
-- for admin-client writes made for a signed-in user — R-051).

begin;

create or replace function public.log_attendance_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row      public.attendance;
  v_uid      uuid := auth.uid();
  v_actor    uuid;
  v_user     uuid;
  v_label    text;
  v_old      jsonb;
  v_new      jsonb;
  v_changes  jsonb := '{}'::jsonb;
  v_key      text;
  v_actor_emp uuid;
  v_actor_lbl text;
begin
  if coalesce(current_setting('app.attendance_mark', true), '') = 'kiosk' then return null; end if;

  v_actor := coalesce(v_uid, public.audit_service_actor());
  if v_actor is null then return null; end if;              -- machine / cron: nothing to attribute

  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;

  select u.employee_id into v_actor_emp from public.users u where u.id = v_actor and u.tenant_id = v_row.tenant_id;
  if v_actor_emp is not null and v_actor_emp = v_row.employee_id then return null; end if;  -- own mark

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old); v_new := to_jsonb(new);
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = 'created_at' then continue; end if;
      if v_new->v_key is distinct from v_old->v_key then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old->v_key, 'new', v_new->v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then return null; end if;
    /* The kiosk route attaches the selfie path right after a punch, on the server client
       acting for the kiosk login — proof being filed, not attendance being changed. */
    if (select bool_and(k in ('selfie_in', 'selfie_out')) from jsonb_object_keys(v_changes) k) then return null; end if;
  elsif tg_op = 'INSERT' then
    v_changes := jsonb_build_object('new', to_jsonb(new) - 'created_at');
  else
    v_changes := jsonb_build_object('old', to_jsonb(old) - 'created_at');
  end if;

  select u.id into v_user from public.users u where u.id = v_actor and u.tenant_id = v_row.tenant_id;
  if v_user is null then v_actor_lbl := 'Platform support'; end if;

  select left(coalesce(e.name, 'Employee') || ' · ' || to_char(v_row.work_date, 'DD Mon YYYY'), 120)
    into v_label from public.employees e where e.id = v_row.employee_id;

  insert into public.activity_log (tenant_id, user_id, actor_label, action, entity, entity_id, label, changes)
  values (v_row.tenant_id, v_user, v_actor_lbl, lower(tg_op), 'attendance', v_row.id::text,
          coalesce(v_label, to_char(v_row.work_date, 'DD Mon YYYY')), v_changes);
  return null;
end
$function$;

revoke all on function public.log_attendance_change() from public, anon, authenticated;

drop trigger if exists trg_attendance_change_log on public.attendance;
create trigger trg_attendance_change_log
  after insert or update or delete on public.attendance
  for each row execute function public.log_attendance_change();

-- mark_attendance (kiosk) — body unchanged from 20261010000000 except the one marked line.
create or replace function public.mark_attendance(p_employee_id uuid, p_pin text, p_ip text default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_hash   text;
  v_active boolean;
  v_date   date := (now() at time zone 'Asia/Kolkata')::date;
  v_row    public.attendance;
  v_lock   timestamptz;
  v_failed integer;
begin
  /* R-608: tell the change-log trigger this write is a kiosk punch (transaction-local). */
  perform set_config('app.attendance_mark', 'kiosk', true);
  select pin_hash, is_active into v_hash, v_active from public.employees
    where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  if not coalesce(v_active, false) then raise exception 'Employee is inactive'; end if;
  if v_hash is null then raise exception 'No PIN set — ask the owner to set your PIN'; end if;

  /* R-607: checked BEFORE the PIN, so a locked PIN cannot be confirmed by guessing it. */
  select locked_until into v_lock from public.employee_pin_attempts where employee_id = p_employee_id;
  if v_lock is not null and v_lock > now() then
    return 'pin_locked';
  end if;

  if p_pin is null or crypt(p_pin, v_hash) <> v_hash then
    insert into public.employee_pin_attempts as a (employee_id, tenant_id, failed, updated_at)
      values (p_employee_id, v_tenant, 1, now())
    on conflict (employee_id) do update
      set failed = case when a.locked_until is not null and a.locked_until <= now() then 1 else a.failed + 1 end,
          locked_until = null,
          updated_at = now()
    returning failed into v_failed;
    if v_failed >= 5 then
      update public.employee_pin_attempts set locked_until = now() + interval '15 minutes'
       where employee_id = p_employee_id;
      return 'pin_locked';
    end if;
    return 'wrong_pin';
  end if;

  delete from public.employee_pin_attempts where employee_id = p_employee_id;

  select * into v_row from public.attendance
    where tenant_id = v_tenant and employee_id = p_employee_id and work_date = v_date;

  if not found then
    insert into public.attendance (tenant_id, employee_id, work_date, check_in, source, marked_ip)
    values (v_tenant, p_employee_id, v_date, now(), 'kiosk', p_ip);
    return 'checked_in';
  elsif v_row.check_out is null then
    if now() - v_row.check_in < interval '90 seconds' then
      return 'too_soon';
    end if;
    update public.attendance set check_out = now(), marked_ip = coalesce(p_ip, marked_ip) where id = v_row.id;
    return 'checked_out';
  else
    return 'already_done';
  end if;
end;
$function$;

revoke all on function public.mark_attendance(uuid, text, text) from public, anon;
grant execute on function public.mark_attendance(uuid, text, text) to authenticated, service_role;

commit;
