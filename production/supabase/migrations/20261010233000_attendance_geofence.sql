-- deploy-key: geofence
-- deploy-peek: (to_regprocedure('public.mark_self_attendance(double precision,double precision,double precision,text)') is not null and to_regprocedure('public.set_office_location(double precision,double precision,integer,text)') is not null)
-- 20261010233000_attendance_geofence.sql
--
-- R-438 (10 Oct 2026, fresh rebuild on manager-pardeep). Office location (geofence) for self
-- check-in.
--
-- ══ WHY ═════════════════════════════════════════════════════════════════════════
--   Pardeep: employees mark attendance from home. GPS was only written down (geo_in/geo_out
--   by /api/attendance/self), never checked.
--   And mark_self_attendance() (no arguments) was EXECUTE-able by every signed-in user, so one
--   direct RPC call skipped every check the route makes (office Wi-Fi, office code, selfie,
--   device passkey).
--
-- ══ WHAT CHANGES ════════════════════════════════════════════════════════════════
--   attendance_settings: office_lat, office_lng, office_radius_m (default 150), geofence_mode
--     off | flag | block (default off — nothing changes until the owner sets it).
--     Written ONLY through set_office_location() (owner only, current_tenant_id(), fail
--     closed); `authenticated` gets SELECT on the columns but no INSERT/UPDATE grant, so a
--     manager or employee cannot switch the check off with a REST call.
--   mark_self_attendance(p_lat, p_lng, p_accuracy, p_code default null) — SECURITY DEFINER:
--     • no company on the login (current_tenant_id() null) → refused, 28000 (R-454 / §17c)
--     • require_presence on → the office code is checked HERE too (validate_presence_code),
--       so a direct call can no longer skip it. The route still checks first for its reply.
--     • distance to the office measured in the database (haversine, plain SQL math — Cloud SQL
--       has no extensions schema). Up to 100 m of the phone's reported accuracy widens the
--       circle, so a weak fix just inside the office is not refused.
--         block → outside: refused "You are about 500 m from the office …" (hint outside_office)
--                 no location: refused (hint no_location)
--         flag  → the mark goes through with flag outside_office / no_location
--         off   → location ignored
--       Staff the owner allowed to mark from anywhere (employees.attendance_anywhere, R-605)
--       are never refused: block acts as flag for them.
--     • Flags are written in the SAME insert/update as the mark (one row change).
--   The old no-argument mark_self_attendance() is revoked from authenticated (service_role
--   keeps it) — a direct call gets "permission denied".
--
-- ══ NOT A CURE FOR FAKE-GPS APPS ═══════════════════════════════════════════════
--   The location is what the phone reports. A direct caller can type any coordinates; the
--   office Wi-Fi lock (R-605), the office code and the device passkey (R-606) remain the hard
--   checks. The selfie is still only checked by the route (a photo cannot be checked in SQL).
--
-- Test: supabase/tests/attendance_geofence.test.sql

begin;

alter table public.attendance_settings
  add column if not exists office_lat      double precision,
  add column if not exists office_lng      double precision,
  add column if not exists office_radius_m integer not null default 150,
  add column if not exists geofence_mode   text    not null default 'off';

alter table public.attendance_settings drop constraint if exists attendance_settings_geofence_check;
alter table public.attendance_settings add constraint attendance_settings_geofence_check check (
      (office_lat is null or office_lat between -90 and 90)
  and (office_lng is null or office_lng between -180 and 180)
  and office_radius_m between 25 and 5000
  and geofence_mode in ('off', 'flag', 'block')
  and (geofence_mode = 'off' or (office_lat is not null and office_lng is not null))
);

comment on column public.attendance_settings.geofence_mode is
  'R-438: what self check-in does outside the office circle — off | flag (mark + outside_office flag) | block (refused). Owner sets it via set_office_location().';

/* R-601 moved this table to per-column grants. Members may READ the office location (the
   My Attendance screen can show "you are 40 m from the office"); nobody but the server and
   set_office_location() writes it. */
grant select (office_lat, office_lng, office_radius_m, geofence_mode)
  on public.attendance_settings to authenticated;
grant all on table public.attendance_settings to service_role;

-- ── Distance in metres (haversine). Pure arithmetic. ────────────────────────────
create or replace function public.attendance_distance_m(
  p_lat1 double precision, p_lng1 double precision, p_lat2 double precision, p_lng2 double precision
)
returns double precision
language sql
immutable
set search_path to 'public'
as $$
  select 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(p_lat2 - p_lat1) / 2), 2)
    + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
  )))
$$;

revoke all on function public.attendance_distance_m(double precision, double precision, double precision, double precision) from public, anon;
grant execute on function public.attendance_distance_m(double precision, double precision, double precision, double precision) to authenticated, service_role;

-- ── Owner sets the office location ──────────────────────────────────────────────
create or replace function public.set_office_location(
  p_lat double precision, p_lng double precision, p_radius_m integer, p_mode text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'No company for this login — the office location cannot be changed' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only the owner can change where attendance may be marked from' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('off', 'flag', 'block') then
    raise exception 'Pick off, flag or block' using errcode = '22023';
  end if;
  if p_mode <> 'off' and (p_lat is null or p_lng is null) then
    raise exception 'Set the office location first, then turn the check on' using errcode = '22023';
  end if;
  if p_radius_m is null or p_radius_m not between 25 and 5000 then
    raise exception 'The office circle must be 25 to 5000 metres' using errcode = '22023';
  end if;

  insert into public.attendance_settings (tenant_id, office_lat, office_lng, office_radius_m, geofence_mode, updated_at)
  values (v_tenant, p_lat, p_lng, p_radius_m, p_mode, now())
  on conflict (tenant_id) do update
    set office_lat = excluded.office_lat, office_lng = excluded.office_lng,
        office_radius_m = excluded.office_radius_m, geofence_mode = excluded.geofence_mode,
        updated_at = now();
end;
$$;

revoke all on function public.set_office_location(double precision, double precision, integer, text) from public, anon;
grant execute on function public.set_office_location(double precision, double precision, integer, text) to authenticated, service_role;

-- ── mark_self_attendance(lat, lng, accuracy, code) ──────────────────────────────
/* Same marking rules as before (first tap in, second out, 90-second misclick guard, then
   already_done), with the company guard, office code and office location in front. */
create or replace function public.mark_self_attendance(
  p_lat double precision, p_lng double precision, p_accuracy double precision, p_code text default null
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid      uuid := auth.uid();
  v_tenant   uuid := public.current_tenant_id();
  v_emp      uuid;
  v_anywhere boolean;
  v_date     date;
  v_row      public.attendance;
  v_set      public.attendance_settings;
  v_mode     text;
  v_dist     double precision;
  v_away     text;
  v_flag     text;
begin
  if v_uid is null or v_tenant is null then
    raise exception 'No company for this login — attendance cannot be marked' using errcode = '28000';
  end if;

  select u.employee_id into v_emp from public.users u where u.id = v_uid and u.tenant_id = v_tenant;
  if v_emp is null then raise exception 'Pehle apna employee link karo.'; end if;
  select coalesce(e.attendance_anywhere, false) into v_anywhere
    from public.employees e where e.id = v_emp and e.tenant_id = v_tenant;
  if not found then raise exception 'Pehle apna employee link karo.'; end if;

  select * into v_set from public.attendance_settings where tenant_id = v_tenant;

  -- Office code: the route checks it first; checking again here closes the direct-call path.
  if coalesce(v_set.require_presence, false) and not public.validate_presence_code(p_code) then
    raise exception 'Office code galat ya expire ho gaya — office tablet pe abhi jo code hai wahi daalo.'
      using errcode = 'P0001', hint = 'presence_code';
  end if;

  -- Office location.
  v_mode := coalesce(v_set.geofence_mode, 'off');
  if v_mode = 'block' and v_anywhere then v_mode := 'flag'; end if;
  if v_mode <> 'off' and v_set.office_lat is not null and v_set.office_lng is not null then
    if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
      if v_mode = 'block' then
        raise exception 'Your location is off — turn on location (GPS) and try again. Attendance can only be marked at the office.'
          using errcode = 'P0001', hint = 'no_location';
      end if;
      v_flag := 'no_location';
    else
      v_dist := public.attendance_distance_m(v_set.office_lat, v_set.office_lng, p_lat, p_lng);
      if v_dist > v_set.office_radius_m + least(greatest(coalesce(p_accuracy, 0), 0), 100) then
        if v_mode = 'block' then
          v_away := case when v_dist < 1000 then (round(v_dist / 10) * 10)::bigint || ' m'
                         else to_char(round((v_dist / 1000)::numeric, 1), 'FM999990.0') || ' km' end;
          raise exception 'You are about % from the office — attendance can only be marked within % m of it.',
            v_away, v_set.office_radius_m
            using errcode = 'P0001', hint = 'outside_office';
        end if;
        v_flag := 'outside_office';
      end if;
    end if;
  end if;

  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance
   where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  if not found then
    insert into public.attendance (tenant_id, employee_id, work_date, check_in, source, flags)
    values (v_tenant, v_emp, v_date, now(), 'self',
            case when v_flag is null then '{}'::text[] else array[v_flag] end);
    return 'checked_in';
  elsif v_row.check_out is null then
    if now() - v_row.check_in < interval '90 seconds' then
      return 'too_soon';
    end if;
    update public.attendance
       set check_out = now(),
           flags = case when v_flag is null or v_flag = any (coalesce(flags, '{}'::text[])) then flags
                        else coalesce(flags, '{}'::text[]) || v_flag end
     where id = v_row.id;
    return 'checked_out';
  else
    return 'already_done';
  end if;
end;
$$;

revoke all on function public.mark_self_attendance(double precision, double precision, double precision, text) from public, anon;
grant execute on function public.mark_self_attendance(double precision, double precision, double precision, text) to authenticated, service_role;

-- The old one skipped every check when called directly. Service role only from now on.
revoke all on function public.mark_self_attendance() from public, anon, authenticated;
grant execute on function public.mark_self_attendance() to service_role;

commit;
