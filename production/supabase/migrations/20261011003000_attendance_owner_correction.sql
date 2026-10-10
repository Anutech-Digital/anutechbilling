-- deploy-key: salaryrules
-- deploy-peek: to_regclass('public.attendance_corrections') is not null and to_regprocedure('public.correct_attendance(uuid,date,timestamptz,timestamptz,text)') is not null
-- 20261011003000_attendance_owner_correction.sql
--
-- R-439 (Pardeep, 8 Oct; Haan 10 Oct "naye sire se banana hai"). Salary rules for late /
-- half day + the owner's correction screen.
--
-- ══ ALREADY THERE (reused, not duplicated) ═══════════════════════════════════════
--   attendance_settings.shift_start / shift_end / late_grace_minutes / half_day_under_hours
--   (R-604, 20261009230000) — the office time, grace and half-day rule. The rule itself lives
--   in ONE pure TS function, src/lib/attendance/shift.ts dayStatus(), used by the register,
--   My Attendance and payroll's loss-of-pay suggestion. The database does NOT compute
--   late / half day anywhere, so there is no second copy to keep in step.
--   correct_attendance() (R-603) — the one write path for fixing a day.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   1. Only the OWNER may correct a day. R-603 let manager / accountant / billing do it too;
--      the card says employees and managers cannot. Enforced in the function (owner role +
--      tenant guard; current_tenant_id() NULL → refused) AND at the table:
--   2. `authenticated` loses INSERT / DELETE / TRUNCATE and UPDATE on every column except
--      reviewed_at / reviewed_by (the review queue, still owner + manager + money roles via
--      the R-601 policy). So no login — not even the owner — can rewrite check_in / check_out
--      straight through the REST API without a reason and an audit row. The same rule is also
--      a BEFORE trigger (attendance_direct_write_guard), so a later grant / policy re-run
--      cannot reopen it; the R-601 insert / delete policies are dropped. Employees still mark
--      through the SECURITY DEFINER RPCs (mark_attendance, mark_self_attendance,
--      undo_my_last_punch) and the server's service-role client, which grants do not touch.
--      Measured before: no app code writes attendance directly as `authenticated` except the
--      reviewed_at update (src/lib/queries/my-attendance.ts).
--   3. attendance_corrections — append-only audit: who, when, old → new check-in / check-out /
--      status, reason. Written by correct_attendance() in the same transaction as the change,
--      so a correction without its audit row cannot exist. Readable by the roles that see the
--      register (owner / manager / accountant / billing) in their own tenant; nobody can write
--      it directly. service_role policy because Cloud SQL has no BYPASSRLS.
--   correct_attendance keeps its signature (the app and its types do not change shape).

begin;

-- ── 3. audit table ───────────────────────────────────────────────────────────────
create table if not exists public.attendance_corrections (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  work_date      date not null,
  changed_by     uuid references public.users(id) on delete set null,
  changed_at     timestamptz not null default now(),
  old_status     text not null check (old_status in ('present', 'absent')),
  new_status     text not null check (new_status in ('present', 'absent')),
  old_check_in   timestamptz,
  old_check_out  timestamptz,
  new_check_in   timestamptz,
  new_check_out  timestamptz,
  reason         text not null check (length(btrim(reason)) >= 3)
);

create index if not exists attendance_corrections_day_idx
  on public.attendance_corrections (tenant_id, employee_id, work_date, changed_at desc);

alter table public.attendance_corrections enable row level security;

drop policy if exists attendance_corrections_read_hr on public.attendance_corrections;
create policy attendance_corrections_read_hr on public.attendance_corrections for select
  using (tenant_id = public.current_tenant_id()
         and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));

drop policy if exists attendance_corrections_service_role on public.attendance_corrections;
create policy attendance_corrections_service_role on public.attendance_corrections
  as permissive for all to service_role using (true) with check (true);

revoke all on table public.attendance_corrections from public, anon, authenticated;
grant select on table public.attendance_corrections to authenticated;
grant all on table public.attendance_corrections to service_role;

-- ── 2. no direct time edits through the API ──────────────────────────────────────
revoke insert, update, delete, truncate on table public.attendance from authenticated;
grant update (reviewed_at, reviewed_by) on public.attendance to authenticated;

/* Grants alone are not enough: cloudsql/09-grant-what-policies-allow.sql hands a table back
   the privileges its policies describe, and cloudsql/05 can restore the old tenant-only write
   policies (measured 10 Oct: the local DB got table UPDATE back after this migration). So the
   rule also lives in a trigger, which no grant or policy re-run can undo. It fires only for
   statements run AS `authenticated` — the REST API. SECURITY DEFINER functions (marking RPCs,
   correct_attendance) run as their owner and the server's client as service_role, so they
   pass. */
drop policy if exists attendance_insert_hr_roles on public.attendance;
drop policy if exists attendance_delete_hr_roles on public.attendance;

create or replace function public.attendance_direct_write_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if current_user <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op <> 'UPDATE'
     or (to_jsonb(new) - 'reviewed_at' - 'reviewed_by') is distinct from (to_jsonb(old) - 'reviewed_at' - 'reviewed_by') then
    raise exception 'Attendance times can only be changed by the owner, with a reason (Fix attendance).'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function public.attendance_direct_write_guard() from public, anon, authenticated;

drop trigger if exists trg_attendance_direct_write_guard on public.attendance;
create trigger trg_attendance_direct_write_guard
  before insert or update or delete on public.attendance
  for each row execute function public.attendance_direct_write_guard();

-- ── 1. owner-only correction, with the audit row ─────────────────────────────────
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
  v_old    public.attendance;
  v_had    boolean;
begin
  if v_tenant is null or not public.current_user_has_role('owner') then
    raise exception 'Only the owner can correct attendance.' using errcode = '42501';
  end if;

  if p_employee_id is null or p_work_date is null then
    raise exception 'Employee and date are required.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.employees e
                 where e.id = p_employee_id and e.tenant_id = v_tenant) then
    raise exception 'Employee not found.' using errcode = '42501';
  end if;

  if length(v_note) < 3 then
    raise exception 'Write a reason (why this is being corrected).' using errcode = '22023';
  end if;

  if p_work_date > v_today then
    raise exception 'Cannot correct attendance for a future date.' using errcode = '22023';
  end if;

  if p_check_in is null and p_check_out is not null then
    raise exception 'Check in time is required.' using errcode = '22023';
  end if;

  if p_check_out is not null and p_check_out <= p_check_in then
    raise exception 'Check out must be after check in.' using errcode = '22023';
  end if;

  select * into v_old from public.attendance
   where tenant_id = v_tenant and employee_id = p_employee_id and work_date = p_work_date
   for update;
  v_had := found and v_old.check_in is not null;

  insert into public.attendance_corrections
    (tenant_id, employee_id, work_date, changed_by, old_status, new_status,
     old_check_in, old_check_out, new_check_in, new_check_out, reason)
  values
    (v_tenant, p_employee_id, p_work_date, auth.uid(),
     case when v_had then 'present' else 'absent' end,
     case when p_check_in is not null then 'present' else 'absent' end,
     v_old.check_in, v_old.check_out, p_check_in, p_check_out, v_note);

  -- Both empty → mark absent.
  if p_check_in is null then
    delete from public.attendance
     where tenant_id = v_tenant and employee_id = p_employee_id and work_date = p_work_date;
    return 'absent';
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
  'R-439: the OWNER fixes one employee-day (missed punch / wrong check-out / mark absent). '
  'Reason required; every call writes attendance_corrections (who, when, old, new, reason). '
  'Both times null deletes the row (absent). Sets source=manual and corrected_by/at/note.';

revoke all on function public.correct_attendance(uuid, date, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.correct_attendance(uuid, date, timestamptz, timestamptz, text) to authenticated, service_role;

commit;
