-- deploy-key: attendancedevices
-- deploy-peek: (to_regclass('public.attendance_devices') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'attendance_settings' and column_name = 'require_device'))
-- 20261009235000_attendance_devices.sql  (R-606, 9 Oct 2026)
--
-- ══ THE THREAT ═══════════════════════════════════════════════════════════════
--   Pardeep: "doosre ke email id ko apne computer par login karke uski attendance laga
--   denge". A colleague who knows someone's password checks them in from HIS laptop. The
--   only device signal so far was a random localStorage token (lib/attendance/device.ts)
--   that adds a soft `new_device` flag and blocks nothing.
--
-- ══ WHAT THIS ADDS ═══════════════════════════════════════════════════════════
--   attendance_devices      one WebAuthn passkey per employee device (fingerprint / face /
--                           Windows Hello). The private key never leaves the device; we keep
--                           only the public key + signature counter. A new device is
--                           'pending' until the OWNER approves it; max 2 live devices
--                           (pending + approved) per employee, max 2 approved — enforced by
--                           trg_attendance_devices_limit, so the route cannot be the only
--                           guard.
--   attendance_webauthn_challenges  one short-lived challenge per user (server only).
--   attendance_settings.require_device  when true, /api/attendance/self refuses a check-in
--                           that is not signed by an approved device of THAT employee.
--
--   Reads: the employee sees their own devices, the owner sees every device in the tenant.
--   Writes: none for authenticated — every write is the server (service role) after it has
--   verified the WebAuthn response and the caller's role in code.

begin;

-- ── attendance_devices ────────────────────────────────────────────────────────
create table if not exists public.attendance_devices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  user_id       uuid references public.users(id) on delete set null,
  credential_id text not null unique,
  public_key    text not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  label         text not null,
  backed_up     boolean not null default false,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  created_at    timestamptz not null default now(),
  approved_by   uuid references public.users(id) on delete set null,
  approved_at   timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz
);

create index if not exists attendance_devices_tenant_employee_idx
  on public.attendance_devices (tenant_id, employee_id) where status <> 'revoked';

alter table public.attendance_devices enable row level security;

drop policy if exists attendance_devices_select on public.attendance_devices;
create policy attendance_devices_select on public.attendance_devices for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (employee_id = (select u.employee_id from public.users u where u.id = auth.uid())
              or public.current_user_has_role('owner')));

drop policy if exists zzz_service_role_all on public.attendance_devices;
create policy zzz_service_role_all on public.attendance_devices
  as permissive for all to service_role using (true) with check (true);

revoke all on table public.attendance_devices from anon, authenticated;
grant select on table public.attendance_devices to authenticated;
grant all on table public.attendance_devices to service_role;

/* The device limit lives in the database too: two requests racing past the route's count
   must not leave an employee with three devices. The employee row is locked first so the
   counts below see each other. Also pins the device to an employee of the SAME tenant. */
create or replace function public.tg_attendance_devices_limit()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_live int; v_approved int;
begin
  perform 1 from public.employees e
   where e.id = new.employee_id and e.tenant_id = new.tenant_id
   for update;
  if not found then
    raise exception 'This employee is not in this workspace. Open Payroll → Employees and pick the right person.';
  end if;

  if new.status = 'revoked' then
    return new;
  end if;

  select count(*) filter (where status <> 'revoked'),
         count(*) filter (where status = 'approved')
    into v_live, v_approved
    from public.attendance_devices
   where employee_id = new.employee_id
     and id <> new.id;

  if tg_op = 'INSERT' and v_live >= 2 then
    raise exception 'This employee already has 2 devices. Ask the owner to remove one in Payroll → Attendance → Devices, then register again.';
  end if;
  if new.status = 'approved' and v_approved >= 2 then
    raise exception 'This employee already has 2 approved devices. Remove one in Payroll → Attendance → Devices first, then approve.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_attendance_devices_limit on public.attendance_devices;
create trigger trg_attendance_devices_limit
  before insert or update of status, employee_id, tenant_id on public.attendance_devices
  for each row execute function public.tg_attendance_devices_limit();

-- ── attendance_webauthn_challenges (server only) ──────────────────────────────
create table if not exists public.attendance_webauthn_challenges (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  challenge  text not null,
  purpose    text not null check (purpose in ('register', 'auth')),
  expires_at timestamptz not null
);

alter table public.attendance_webauthn_challenges enable row level security;

drop policy if exists zzz_service_role_all on public.attendance_webauthn_challenges;
create policy zzz_service_role_all on public.attendance_webauthn_challenges
  as permissive for all to service_role using (true) with check (true);

revoke all on table public.attendance_webauthn_challenges from anon, authenticated;
grant all on table public.attendance_webauthn_challenges to service_role;

-- ── attendance_settings.require_device ────────────────────────────────────────
alter table public.attendance_settings
  add column if not exists require_device boolean not null default false;

/* R-601 moved attendance_settings to COLUMN grants for authenticated — a new column is
   invisible to the app until it is granted by name. */
grant select (require_device), insert (require_device), update (require_device)
  on public.attendance_settings to authenticated;

commit;
