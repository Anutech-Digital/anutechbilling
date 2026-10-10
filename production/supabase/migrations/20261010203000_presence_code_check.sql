-- deploy-key: presencesecret
-- deploy-peek: (to_regclass('public.presence_code_attempts') is not null and to_regprocedure('public.validate_presence_code(text)') is not null and to_regprocedure('public.presence_code_at(text,bigint)') is not null)
-- 20261010203000_presence_code_check.sql
--
-- R-440 (attendance security, found 8 Oct during R-438). The rotating office code proves
-- "I am in the office": it is shown only on the office tablet. Its seed,
-- attendance_settings.presence_secret, used to be readable by every member, so anyone could
-- compute today's code at home.
--
-- Already done before this file:
--   R-601 (20261009213000)  `authenticated` lost SELECT on presence_secret (column grants).
--   R-605                   GET /api/attendance/presence-code (the kiosk display) is
--                           owner / manager only.
--
-- ══ WHAT CHANGES HERE ═════════════════════════════════════════════════════════
--
--   validate_presence_code(p_code) → boolean, SECURITY DEFINER. The office code is now
--   checked INSIDE the database for the caller's own company (current_tenant_id()), so
--   /api/attendance/self no longer pulls the seed into the app at all. Fails CLOSED (§17c):
--   a login with no company is refused (28000), it never falls through to "any tenant".
--
--   Attempt limit: the function is reachable straight through PostgREST, and a 6-digit code
--   with two valid windows falls to a fast loop. 5 wrong codes → 15-minute lock for that
--   login (presence_code_attempts). Wrong codes RETURN false (a raise would roll back the
--   counter); only an already-locked caller gets an exception, which writes nothing.
--
--   presence_code_at(secret, window) — the same HMAC-SHA256 + TOTP truncation as
--   src/lib/attendance/presence.ts presenceCode(), built on core sha256() so it needs no
--   pgcrypto (Cloud SQL has no `extensions` schema). Service-role / definer-internal only.
--
--   Leftover grants: `authenticated` / `anon` still held TRUNCATE / REFERENCES / TRIGGER on
--   attendance_settings, and REFERENCES on the presence_secret column. None is reachable
--   through PostgREST, but none is needed either — taken away so nothing a member holds
--   names the seed.

begin;

-- ── 1. Leftover privileges on the settings table ────────────────────────────────
revoke truncate, references, trigger on table public.attendance_settings from anon, authenticated;
revoke references (presence_secret) on table public.attendance_settings from anon, authenticated;

-- ── 2. Attempt counter (one row per login) ──────────────────────────────────────
create table if not exists public.presence_code_attempts (
  user_id      uuid primary key references public.users(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  failed       integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.presence_code_attempts enable row level security;
drop policy if exists presence_code_attempts_service_role on public.presence_code_attempts;
create policy presence_code_attempts_service_role on public.presence_code_attempts
  as permissive for all to service_role using (true) with check (true);
revoke all on table public.presence_code_attempts from public, anon, authenticated;
grant all on table public.presence_code_attempts to service_role;

-- ── 3. The code for one 45-second window (mirror of presence.ts presenceCode) ───
create or replace function public.presence_code_at(p_secret text, p_window bigint)
returns text
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_key   bytea := convert_to(p_secret, 'UTF8');
  v_ipad  bytea;
  v_opad  bytea;
  v_mac   bytea;
  v_off   int;
  v_bin   bigint;
  i       int;
begin
  if p_secret is null or p_window is null then return null; end if;
  -- HMAC-SHA256 (RFC 2104): block size 64, longer keys are hashed first.
  if length(v_key) > 64 then v_key := sha256(v_key); end if;
  v_key  := v_key || decode(repeat('00', 64 - length(v_key)), 'hex');
  v_ipad := v_key;
  v_opad := v_key;
  for i in 0..63 loop
    v_ipad := set_byte(v_ipad, i, get_byte(v_key, i) # 54);   -- 0x36
    v_opad := set_byte(v_opad, i, get_byte(v_key, i) # 92);   -- 0x5c
  end loop;
  v_mac := sha256(v_opad || sha256(v_ipad || convert_to(p_window::text, 'UTF8')));
  -- Dynamic truncation, exactly as presence.ts.
  v_off := get_byte(v_mac, 31) & 15;
  v_bin := ((get_byte(v_mac, v_off) & 127)::bigint << 24)
         | (get_byte(v_mac, v_off + 1)::bigint << 16)
         | (get_byte(v_mac, v_off + 2)::bigint << 8)
         |  get_byte(v_mac, v_off + 3)::bigint;
  return lpad((v_bin % 1000000)::text, 6, '0');
end;
$function$;

revoke all on function public.presence_code_at(text, bigint) from public, anon, authenticated;
grant execute on function public.presence_code_at(text, bigint) to service_role;

-- ── 4. The check self check-in calls ────────────────────────────────────────────
create or replace function public.validate_presence_code(p_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
/* R-440: checks the rotating office code for the CALLER'S company without the seed ever
   leaving the database. Accepts the current 45 s window and the previous one (same
   tolerance as presence.ts validateCode). */
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.current_tenant_id();
  v_secret text;
  v_window bigint;
  v_att    public.presence_code_attempts%rowtype;
  v_found  boolean;
  v_failed int;
  v_code   text := btrim(coalesce(p_code, ''));
begin
  if v_tenant is null or v_uid is null then
    raise exception 'No company for this login — office code cannot be checked' using errcode = '28000';
  end if;

  select * into v_att from public.presence_code_attempts where user_id = v_uid;
  v_found := found;
  if v_found and v_att.locked_until is not null and v_att.locked_until > now() then
    raise exception 'PRESENCE_CODE_LOCKED' using errcode = 'P0001',
      hint = 'Too many wrong office codes. Try again after ' || to_char(v_att.locked_until at time zone 'Asia/Kolkata', 'HH24:MI') || ' IST.';
  end if;

  select s.presence_secret into v_secret
    from public.attendance_settings s where s.tenant_id = v_tenant;

  v_window := floor(extract(epoch from clock_timestamp()) / 45)::bigint;

  if v_secret is not null and v_code ~ '^[0-9]{6}$'
     and (public.presence_code_at(v_secret, v_window) = v_code
          or public.presence_code_at(v_secret, v_window - 1) = v_code) then
    delete from public.presence_code_attempts where user_id = v_uid;
    return true;
  end if;

  if v_secret is null then
    return false;   -- the owner never opened the kiosk; nothing to guess against
  end if;

  -- Count this miss. A finished lock, or misses older than 15 minutes, start again at 1.
  if v_found and v_att.locked_until is null and v_att.updated_at > now() - interval '15 minutes' then
    v_failed := v_att.failed + 1;
  else
    v_failed := 1;
  end if;
  insert into public.presence_code_attempts (user_id, tenant_id, failed, locked_until, updated_at)
  values (v_uid, v_tenant, v_failed,
          case when v_failed >= 5 then now() + interval '15 minutes' end, now())
  on conflict (user_id) do update
    set failed = excluded.failed, locked_until = excluded.locked_until,
        tenant_id = excluded.tenant_id, updated_at = excluded.updated_at;
  return false;
end;
$function$;

revoke all on function public.validate_presence_code(text) from public, anon;
grant execute on function public.validate_presence_code(text) to authenticated, service_role;

commit;
