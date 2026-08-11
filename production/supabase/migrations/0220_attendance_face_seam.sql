-- 0220 — face-verification seam (Phase 4, zero-cost, vendor-ready).
--
-- Opt-in premium tier. When require_face_match is on, a self check-in selfie is
-- compared against the employee's enrolled reference face via a PLUGGABLE
-- provider (see lib/attendance/face). The default provider is a stub that adds
-- a 'face_review' flag → the owner review queue (Phase 3) — NO external call,
-- NO cost, NO keys. A certified vendor switches on purely via env config later.

alter table public.attendance_settings
  add column if not exists require_face_match boolean not null default false;

alter table public.employees
  add column if not exists face_enrolled_at timestamptz,
  add column if not exists face_ref_path text;   -- storage path of the reference face

-- Self page also needs to know if the caller has enrolled a reference face.
create or replace function public.my_attendance_today()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_emp uuid; v_name text; v_date date; v_row public.attendance;
        v_consent timestamptz; v_retention int; v_face timestamptz;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then return jsonb_build_object('linked', false); end if;
  select name, attendance_consent_at, face_enrolled_at into v_name, v_consent, v_face from public.employees where id = v_emp;
  select coalesce(selfie_retention_days, 180) into v_retention from public.attendance_settings where tenant_id = v_tenant;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  return jsonb_build_object(
    'linked', true, 'employee_name', v_name, 'work_date', v_date,
    'check_in', v_row.check_in, 'check_out', v_row.check_out,
    'consent_at', v_consent, 'retention_days', coalesce(v_retention, 180),
    'face_enrolled', (v_face is not null)
  );
end $$;
grant execute on function public.my_attendance_today() to authenticated;
