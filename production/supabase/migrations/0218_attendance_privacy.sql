-- 0218 — attendance privacy shield (Phase 2): consent + retention + transparency.
--
-- DPDP Act 2023: a face selfie is sensitive personal data. Capture explicit
-- consent (purpose = attendance), keep it only for a set retention window, and
-- let the person see their own record + withdraw. This migration adds the data;
-- the retention auto-delete runs from /api/cron/attendance-retention.

alter table public.attendance_settings
  add column if not exists selfie_retention_days integer not null default 180;

alter table public.employees
  add column if not exists attendance_consent_at timestamptz,
  add column if not exists attendance_consent_source text; -- 'self' | 'owner'

-- The caller records consent for their OWN linked employee (self check-in flow).
create or replace function public.record_attendance_consent()
returns void language plpgsql security definer set search_path = public as $$
declare v_emp uuid;
begin
  select employee_id into v_emp from public.users where id = auth.uid();
  if v_emp is null then raise exception 'Pehle apna employee link karo.'; end if;
  update public.employees
    set attendance_consent_at = now(), attendance_consent_source = 'self'
    where id = v_emp;
end $$;

-- Today's status now also carries consent + retention (drives the self page).
create or replace function public.my_attendance_today()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_emp uuid; v_name text; v_date date; v_row public.attendance;
        v_consent timestamptz; v_retention int;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then return jsonb_build_object('linked', false); end if;
  select name, attendance_consent_at into v_name, v_consent from public.employees where id = v_emp;
  select coalesce(selfie_retention_days, 180) into v_retention from public.attendance_settings where tenant_id = v_tenant;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  return jsonb_build_object(
    'linked', true, 'employee_name', v_name, 'work_date', v_date,
    'check_in', v_row.check_in, 'check_out', v_row.check_out,
    'consent_at', v_consent, 'retention_days', coalesce(v_retention, 180)
  );
end $$;

-- The caller's own recent attendance — transparency builds trust.
create or replace function public.my_attendance_history(p_days int default 14)
returns table(work_date date, check_in timestamptz, check_out timestamptz, source text)
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_emp uuid;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then return; end if;
  return query
    select a.work_date, a.check_in, a.check_out, a.source
    from public.attendance a
    where a.tenant_id = v_tenant and a.employee_id = v_emp
      and a.work_date >= ((now() at time zone 'Asia/Kolkata')::date - greatest(p_days, 1))
    order by a.work_date desc;
end $$;

grant execute on function public.record_attendance_consent() to authenticated;
grant execute on function public.my_attendance_history(int) to authenticated;
grant execute on function public.my_attendance_today() to authenticated;
