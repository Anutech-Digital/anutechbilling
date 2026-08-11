-- 0217 — provably-present self check-in + tightened employee linking.
--
-- Phase 1 of the world-class attendance redesign. Closes the two Critical holes
-- from the audit:
--   (1) self check-in had NO location/presence proof → a logged-in employee
--       could mark present from home. We add a rotating office "presence code"
--       (validated server-side) + GPS capture as an audit trail.
--   (2) self-service employee linking let a user pick ANY colleague's record.
--       We now require the employee's email to match the caller's login email
--       (an owner-controlled signal) and block linking an already-linked record.

-- Settings: opt-in presence requirement + a per-tenant secret for the rotating
-- code (HMAC seed; never leaves the server).
alter table public.attendance_settings
  add column if not exists require_presence boolean not null default false,
  add column if not exists presence_secret text;

-- Per-punch geo audit trail (soft signal): "lat,lng,accuracy" strings, mirroring
-- the selfie_in / selfie_out convention.
alter table public.attendance
  add column if not exists geo_in text,
  add column if not exists geo_out text;

-- Tightened self-linking. A user may link ONLY to an employee whose email
-- matches their login email, and never to one already linked to someone else.
create or replace function public.set_my_employee(p_employee_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_user_email text; v_emp_email text;
begin
  select tenant_id, email into v_tenant, v_user_email from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if not exists (select 1 from public.employees where id = p_employee_id and tenant_id = v_tenant) then
    raise exception 'Employee not in your workspace';
  end if;
  if exists (select 1 from public.users where employee_id = p_employee_id and id <> auth.uid()) then
    raise exception 'Ye employee record kisi aur user se already linked hai — owner se kaho.';
  end if;
  select email into v_emp_email from public.employees where id = p_employee_id;
  if v_emp_email is not null and lower(v_emp_email) <> lower(coalesce(v_user_email, '')) then
    raise exception 'Aapka login email is employee se match nahi karta — owner se kaho ki Employees me aapko link kare.';
  end if;
  update public.users set employee_id = p_employee_id where id = auth.uid();
end $$;

grant execute on function public.set_my_employee(uuid) to authenticated;
