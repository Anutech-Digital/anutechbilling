-- deploy-key: attendanceshift
-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'attendance_settings' and column_name = 'half_day_under_hours')
-- 20261009230000_attendance_shift.sql
--
-- R-604 (9 Oct 2026). Office hours on the workspace, the same for every employee — Pardeep:
-- "10 morning to 6 evening", "15 minute baad late", "4 gante se kam par half day",
-- "late sirf dikhana hai", "half day par salary kaatni hai".
--
-- The defaults ARE those answers, so ANUTECH needs no row edit and a workspace with no
-- attendance_settings row reads the same values from lib/attendance/shift.ts DEFAULT_SHIFT.
--
-- Column grants: R-601 (20261009213000) replaced the table-level grants on this table with
-- per-column ones so presence_secret stays server-only. A new column is therefore invisible
-- to `authenticated` until it is granted here — which is the point of that design, and why
-- these grants are not optional.

begin;

alter table public.attendance_settings
  add column if not exists shift_start          time    not null default '10:00',
  add column if not exists shift_end            time    not null default '18:00',
  add column if not exists late_grace_minutes   integer not null default 15,
  add column if not exists half_day_under_hours numeric(4,2) not null default 4;

alter table public.attendance_settings drop constraint if exists attendance_settings_shift_check;
alter table public.attendance_settings add constraint attendance_settings_shift_check check (
  shift_end > shift_start
  and late_grace_minutes between 0 and 240
  and half_day_under_hours > 0 and half_day_under_hours <= 12
);

grant select (shift_start, shift_end, late_grace_minutes, half_day_under_hours)
  on public.attendance_settings to authenticated;
grant insert (shift_start, shift_end, late_grace_minutes, half_day_under_hours)
  on public.attendance_settings to authenticated;
grant update (shift_start, shift_end, late_grace_minutes, half_day_under_hours)
  on public.attendance_settings to authenticated;

commit;
