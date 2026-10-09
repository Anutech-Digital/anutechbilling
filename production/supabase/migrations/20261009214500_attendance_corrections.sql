-- deploy-key: attendancecorrections
-- deploy-peek: to_regprocedure('public.correct_attendance(uuid,date,timestamptz,timestamptz,text)') is not null
-- 20261009214500_attendance_corrections  (R-603, 9 Oct 2026)
--
-- WHAT WAS WRONG
--   The Attendance Register was read-only. A forgotten checkout or a day the kiosk was down
--   stayed wrong forever, so payroll's "present" count (and the LOP suggestion built on it)
--   stayed wrong too.
--
-- WHAT THIS ADDS
--   attendance.corrected_by / corrected_at / correction_note — who fixed a day, when, and why.
--   correct_attendance(employee, date, check_in, check_out, note) — the ONE write path:
--     * only owner / manager / accountant / billing (current_user_has_role, S41);
--     * employee must belong to the caller's tenant;
--     * note is required (>= 3 characters after trim) — every manual edit says why;
--     * check_out must be after check_in when both are given; check_out alone is refused;
--     * the date may not be in the future (IST);
--     * both times null = mark absent (the row is deleted);
--     * otherwise upsert on (tenant_id, employee_id, work_date) with source 'manual'.
--   No payroll money logic changes: present days move only because the data moves.

begin;

alter table public.attendance
  add column if not exists corrected_by uuid references public.users(id) on delete set null,
  add column if not exists corrected_at timestamptz,
  add column if not exists correction_note text;

create or replace function public.correct_attendance(
  p_employee_id uuid,
  p_work_date   date,
  p_check_in    timestamptz,
  p_check_out   timestamptz,
  p_note        text
) returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_note   text := btrim(coalesce(p_note, ''));
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_tenant is null
     or not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only the owner, a manager, an accountant or billing can fix attendance.'
      using errcode = '42501';
  end if;

  if p_employee_id is null or p_work_date is null then
    raise exception 'Employee and date are required.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.employees e
                 where e.id = p_employee_id and e.tenant_id = v_tenant) then
    raise exception 'Employee not found.' using errcode = '42501';
  end if;

  if length(v_note) < 3 then
    raise exception 'Write a short note (why this is being fixed).' using errcode = '22023';
  end if;

  if p_work_date > v_today then
    raise exception 'Cannot fix attendance for a future date.' using errcode = '22023';
  end if;

  -- Both empty → mark absent.
  if p_check_in is null and p_check_out is null then
    delete from public.attendance
     where tenant_id = v_tenant and employee_id = p_employee_id and work_date = p_work_date;
    return 'absent';
  end if;

  if p_check_in is null then
    raise exception 'Check in time is required.' using errcode = '22023';
  end if;

  if p_check_out is not null and p_check_out <= p_check_in then
    raise exception 'Check out must be after check in.' using errcode = '22023';
  end if;

  insert into public.attendance
    (tenant_id, employee_id, work_date, check_in, check_out, source,
     corrected_by, corrected_at, correction_note)
  values
    (v_tenant, p_employee_id, p_work_date, p_check_in, p_check_out, 'manual',
     auth.uid(), now(), v_note)
  on conflict (tenant_id, employee_id, work_date) do update
    set check_in        = excluded.check_in,
        check_out       = excluded.check_out,
        source          = 'manual',
        corrected_by    = excluded.corrected_by,
        corrected_at    = excluded.corrected_at,
        correction_note = excluded.correction_note;

  return 'saved';
end;
$function$;

comment on function public.correct_attendance(uuid, date, timestamptz, timestamptz, text) is
  'R-603: owner/manager/accountant/billing fix one employee-day (missed punch / forgotten '
  'checkout). Note required; both times null deletes the row (absent). Sets source=manual '
  'and corrected_by/at/note.';

revoke all on function public.correct_attendance(uuid, date, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.correct_attendance(uuid, date, timestamptz, timestamptz, text) to authenticated, service_role;

commit;
