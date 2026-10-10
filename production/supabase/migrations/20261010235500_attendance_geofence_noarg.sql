-- deploy-key: geofencefix
-- deploy-peek: (exists(select 1 from pg_proc where oid = to_regprocedure('public.mark_self_attendance()') and prosrc like '%R-438 fix%') and has_function_privilege('authenticated', 'public.mark_self_attendance()', 'execute'))
-- 20261010235500_attendance_geofence_noarg.sql
--
-- R-438 follow-up (10 Oct 2026). 20261010233000_attendance_geofence.sql revoked the
-- no-argument mark_self_attendance() from `authenticated`. That turned CI red: existing
-- callers running as a signed-in member (attendance_role_writes / attendance_change_log SQL
-- tests) got "permission denied for function mark_self_attendance".
--
-- Option (a): the no-argument version is callable again by members, but it is no longer a
-- way around the checks. It is now exactly "mark with no location and no office code", run
-- through the 4-argument function, so every database rule applies:
--   • no company on the login                → refused (28000, §17c)
--   • require_presence on                     → refused (no office code)
--   • geofence block                          → refused (hint no_location)
--   • geofence flag                           → marked + flag no_location
--   • staff the owner allowed "anywhere"      → marked + flag no_location (never refused)
--   • geofence off                            → marks exactly as before
-- The route (/api/attendance/self) keeps calling the 4-argument version with the phone's
-- location and the office code.
--
-- Test: supabase/tests/attendance_geofence.test.sql (OLD section).

begin;

create or replace function public.mark_self_attendance()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- R-438 fix: no location, no office code — the 4-argument function decides.
  return public.mark_self_attendance(null::double precision, null::double precision, null::double precision, null::text);
end;
$$;

revoke all on function public.mark_self_attendance() from public, anon;
grant execute on function public.mark_self_attendance() to authenticated, service_role;

commit;
