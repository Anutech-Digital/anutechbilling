-- deploy-key: attendancepiningestlock
-- deploy-peek: (to_regclass('public.employee_pin_attempts') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'attendance_settings' and column_name = 'ingest_key'))
-- 20261010000000_attendance_pin_ingest_lock.sql
--
-- R-607 (attendance security, 9 Oct 2026). Pardeep: "doosre ki attendance laga denge". Two of
-- the ways to do that needed no password at all — measured on the local DB:
--
--   1. The biometric device's shared secret, tenants.attendance_ingest_key, is readable by
--      every member (tenants_self_read; role_hardening 20260930175000 named it and left it).
--      POST /api/attendance/punch with that key and any biometric_id marks ANY employee
--      present on ANY date, from anywhere — it is a machine endpoint with no session.
--   2. The kiosk PIN (4–6 digits) had no attempt limit. mark_attendance is callable by every
--      signed-in member straight through PostgREST, so a colleague's PIN falls to a loop.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════
--
--   Ingest key → attendance_settings.ingest_key, which `authenticated` has no column grant on
--   (R-601 made this table column-granted). The owner reads / rotates it through
--   /api/attendance/ingest-key; the punch route looks it up with the server client. The value
--   is COPIED, so the office bridge keeps working with the key it already has. The tenants
--   column is emptied, not dropped — dropping a column other code may still name is a
--   separate change.
--
--   mark_attendance: 5 wrong PINs → 15-minute lock for that employee. Wrong / locked are
--   RETURNED ('wrong_pin' / 'pin_locked'), not raised: a raise would roll back the counter
--   with the rest of the transaction, and the lock would never engage.
--
--   The public expense-claim PIN functions are called only by server routes on the service
--   role (which have their own per-employee rate limit). `authenticated` could call them
--   directly and guess a PIN with no limit, so its EXECUTE is revoked.
--
--   NOT here: hiding employees.pin_hash (the bcrypt hash every member's Payroll screen
--   loads). Its UI lives in accounting/payroll/screens.tsx, held by R-606 right now — that is
--   R-607 part 2.

begin;

-- ── 1. Ingest key: server-only ──────────────────────────────────────────────────
alter table public.attendance_settings add column if not exists ingest_key text;
create unique index if not exists attendance_settings_ingest_key_uidx
  on public.attendance_settings (ingest_key) where ingest_key is not null;

insert into public.attendance_settings (tenant_id, ingest_key)
  select t.id, t.attendance_ingest_key from public.tenants t
   where t.attendance_ingest_key is not null
on conflict (tenant_id) do update set ingest_key = excluded.ingest_key;

update public.tenants set attendance_ingest_key = null where attendance_ingest_key is not null;

comment on column public.tenants.attendance_ingest_key is
  'EMPTY since R-607 (20261010000000) — the key lives in attendance_settings.ingest_key, '
  'which members cannot read. Do not write here: every member can read this row.';

-- No grant on ingest_key to authenticated: the column grants from R-601 list every other
-- column explicitly, so this one stays invisible to members by construction.
grant all on table public.attendance_settings to service_role;

-- ── 2. Kiosk PIN attempt limit ──────────────────────────────────────────────────
create table if not exists public.employee_pin_attempts (
  employee_id  uuid primary key references public.employees(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  failed       integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.employee_pin_attempts enable row level security;
drop policy if exists employee_pin_attempts_service_role on public.employee_pin_attempts;
create policy employee_pin_attempts_service_role on public.employee_pin_attempts
  as permissive for all to service_role using (true) with check (true);
revoke all on table public.employee_pin_attempts from public, anon, authenticated;
grant all on table public.employee_pin_attempts to service_role;

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

-- ── 3. Expense-claim PIN functions: server routes only ──────────────────────────
revoke execute on function public.verify_claim_access(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.submit_expense_claim(uuid, uuid, text, integer, text, text, date, text) from public, anon, authenticated;
revoke execute on function public.edit_claim_public(uuid, uuid, text, uuid, integer, text, text, date) from public, anon, authenticated;
revoke execute on function public.delete_claim_public(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.verify_claim_access(uuid, uuid, text) to service_role;
grant execute on function public.submit_expense_claim(uuid, uuid, text, integer, text, text, date, text) to service_role;
grant execute on function public.edit_claim_public(uuid, uuid, text, uuid, integer, text, text, date) to service_role;
grant execute on function public.delete_claim_public(uuid, uuid, text, uuid) to service_role;

commit;
