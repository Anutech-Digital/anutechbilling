-- deploy-key: attendancerolewrites
-- deploy-peek: (exists(select 1 from pg_policy where polname = 'attendance_update_hr_roles') and not exists(select 1 from pg_policy where polname = 'tenant isolation write' and polrelid = to_regclass('public.attendance')))
-- 20261009213000_attendance_role_writes.sql
--
-- R-601 (attendance security, 9 Oct 2026).
--
-- ══ WHAT WAS OPEN, measured on the local DB ══════════════════════════════════
--
--   attendance           "tenant isolation write / update / delete" — tenant only, no role.
--                        Any member (a sales rep, a support login) could insert a row for any
--                        date, rewrite check_in / check_out, clear `flags` or set
--                        `reviewed_at` straight through PostgREST. Every gate the app puts in
--                        front of a mark — PIN, selfie, office IP, rotating office code, face
--                        match — sits in the API route, so one direct REST call skipped all of
--                        them. Payroll reads "present" from these rows (loss-of-pay).
--   attendance_settings  same four policies. Any member could switch off require_selfie /
--                        require_presence / the office-IP list, and could READ
--                        presence_secret — the seed of the rotating office code, i.e. compute
--                        today's code at home.
--   anon                 baseline GRANT ALL on both tables.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════
--
--   Direct writes to `attendance` → owner / manager / accountant / billing only (the roles
--   that see the Attendance Register and its review queue: nav OMB + the money roles).
--   Employees still mark through the SECURITY DEFINER RPCs (mark_attendance,
--   mark_self_attendance, undo_my_last_punch) — those do not go through these policies.
--   The selfie / geo / device / flags patch that /api/attendance/self and /mark add after
--   the RPC now uses the server's service-role client, scoped by tenant + employee in code.
--
--   attendance_settings writes → owner / manager. presence_secret is no longer selectable
--   by `authenticated` at all (column grants); only the server reads it.
--
--   READS of `attendance` stay at tenant isolation. Narrowing who may see colleagues' rows
--   (geo, selfie paths) is a separate product decision — flagged on the board, not decided
--   here.

begin;

revoke all on table public.attendance, public.attendance_settings from anon;

-- ── attendance: writes by HR roles only ──────────────────────────────────────────
drop policy if exists "tenant isolation write"  on public.attendance;
drop policy if exists "tenant isolation update" on public.attendance;
drop policy if exists "tenant isolation delete" on public.attendance;
drop policy if exists attendance_insert_hr_roles on public.attendance;
drop policy if exists attendance_update_hr_roles on public.attendance;
drop policy if exists attendance_delete_hr_roles on public.attendance;

create policy attendance_insert_hr_roles on public.attendance for insert
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy attendance_update_hr_roles on public.attendance for update
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy attendance_delete_hr_roles on public.attendance for delete
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));

-- ── attendance_settings: writes by owner / manager; the secret is server-only ────
drop policy if exists "tenant isolation write"  on public.attendance_settings;
drop policy if exists "tenant isolation update" on public.attendance_settings;
drop policy if exists "tenant isolation delete" on public.attendance_settings;
drop policy if exists attendance_settings_insert_admin on public.attendance_settings;
drop policy if exists attendance_settings_update_admin on public.attendance_settings;

create policy attendance_settings_insert_admin on public.attendance_settings for insert
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));
create policy attendance_settings_update_admin on public.attendance_settings for update
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));

/* Column grants: a table-level SELECT would override any column revoke, so take the table
   grant away and give back every column except presence_secret. INSERT/UPDATE likewise
   leave presence_secret out — the server (service role) is the only writer of the seed. */
revoke select, insert, update, delete on table public.attendance_settings from authenticated;
grant select (tenant_id, allowed_ips, updated_at, require_selfie, require_presence,
              selfie_retention_days, require_face_match)
  on public.attendance_settings to authenticated;
grant insert (tenant_id, allowed_ips, updated_at, require_selfie, require_presence,
              selfie_retention_days, require_face_match)
  on public.attendance_settings to authenticated;
grant update (tenant_id, allowed_ips, updated_at, require_selfie, require_presence,
              selfie_retention_days, require_face_match)
  on public.attendance_settings to authenticated;
grant all on table public.attendance_settings to service_role;

-- ── The employee's only write path: the marking RPCs ─────────────────────────────
/* With direct writes gone these RPCs are the ONLY way an employee marks attendance, so
   their grants are stated here instead of trusted. Measured 9 Oct on the local DB:
   mark_self_attendance() had lost its `authenticated` EXECUTE (only postgres/service_role
   left — drift, no migration in the repo revokes it), i.e. "Check in" on My Attendance
   failed with "permission denied". anon never had a reason to call any of them. */
revoke all on function public.mark_self_attendance()           from public, anon;
revoke all on function public.mark_attendance(uuid, text, text) from public, anon;
revoke all on function public.undo_my_last_punch()             from public, anon;
grant execute on function public.mark_self_attendance()           to authenticated, service_role;
grant execute on function public.mark_attendance(uuid, text, text) to authenticated, service_role;
grant execute on function public.undo_my_last_punch()             to authenticated, service_role;

commit;
