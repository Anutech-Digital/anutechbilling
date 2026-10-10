-- deploy-key: attendanceoutsideoffice
-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'attendance_anywhere')
-- 20261010040000_attendance_outside_office.sql
--
-- R-605 (10 Oct 2026). Pardeep: "kuch log bahar se laga sakte hai attendance" — a per-employee
-- switch the owner sets. Everyone else marks only on the office Wi-Fi once the owner has
-- locked it (attendance_settings.allowed_ips); the rule itself lives in
-- lib/attendance/office-network.ts and is applied by /api/attendance/self, the kiosk route
-- and device registration.
--
-- The column grant is required: R-607 part 2 (20261010010000) moved employees to per-column
-- SELECT grants, so a new column is invisible to members until it is granted here.

begin;

alter table public.employees
  add column if not exists attendance_anywhere boolean not null default false;

comment on column public.employees.attendance_anywhere is
  'Owner allows this employee to mark attendance from outside the office Wi-Fi (R-605). '
  'Such marks carry the attendance flag outside_office for the owner''s review.';

grant select (attendance_anywhere) on public.employees to authenticated;

commit;
