-- deploy-peek: to_regclass('public.phone_otps') is not null and to_regprocedure('public.verify_phone_otp(text,text)') is not null and to_regprocedure('public.request_phone_otp(text,text)') is not null
-- deploy-key: r1903phoneotp
-- 20261025083015_r1903_phone_otp.sql
--
-- R-1903 slice 1 (25 Oct 2026, Pardeep): verify my mobile number with a one-time code, from
-- Settings → Security → Mobile number. Slice 2 (login with a mobile OTP) builds on the verified
-- number; slice 3 wires the MSG91 SMS gateway after DLT. Nothing here sends an SMS.
--
-- ─── WHAT IT ADDS ──────────────────────────────────────────────────────────────────────────
--   users.phone_verified_at   when the number in users.phone was proven by an OTP. A changed
--                             number is not verified (trigger below). One verified owner per
--                             number (unique index) — slice 2 logs in by it.
--   phone_otps                one row per code sent: HMAC hash (never the code), 5-minute
--                             expiry, attempts, 15-minute lock after 3 wrong tries. Service
--                             role only — no signed-in user can read a hash.
--   request_phone_otp()       limits + store; audit "otp_sent" with the MASKED number.
--   verify_phone_otp()        one atomic check (§17b): wrong → attempts (+lock), right → the
--                             number is saved and marked verified. Audit sent/failed/verified.
--   cancel_phone_otp()        the SMS could not go out → that code is void, audit says so.
--   mask_phone()              '+919876543210' → '+91 98*****210' — the only form in any log.
--
-- The code is generated and HMAC-hashed in the app (src/lib/sms/otp.ts) with a server secret,
-- so a copy of this table alone cannot be brute-forced back to codes.
--
-- Cloud SQL: no extensions (gen_random_uuid / sha256 / hashtextextended are core), no auth.*,
-- user from public.current_user_id(), company from public.current_tenant_id() (fails closed).

-- ── 1. users.phone_verified_at ──────────────────────────────────────────────────────────────
alter table public.users add column if not exists phone_verified_at timestamptz;
comment on column public.users.phone_verified_at is
  'R-1903: when users.phone was proven by an OTP (verify_phone_otp). Null = not verified. '
  'Cleared by trigger when the number changes; set only by verify_phone_otp.';

create unique index if not exists users_verified_phone_unique
  on public.users (phone) where phone_verified_at is not null;

-- ── 2. mask_phone ───────────────────────────────────────────────────────────────────────────
create or replace function public.mask_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p is null then null
    when p ~ '^\+91[0-9]{10}$' then '+91 ' || substr(p, 4, 2) || '*****' || right(p, 3)
    when length(p) > 4 then repeat('*', length(p) - 3) || right(p, 3)
    else '***'
  end;
$$;
revoke all on function public.mask_phone(text) from public, anon;
grant execute on function public.mask_phone(text) to authenticated, service_role;

-- ── 3. phone_otps ───────────────────────────────────────────────────────────────────────────
create table if not exists public.phone_otps (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  user_id      uuid        not null references public.users(id) on delete cascade,
  phone        text        not null check (phone ~ '^\+91[6-9][0-9]{9}$'),
  purpose      text        not null default 'verify_phone' check (purpose in ('verify_phone', 'login')),
  code_hash    text        not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz not null,
  attempts     integer     not null default 0 check (attempts >= 0),
  locked_until timestamptz,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
comment on table public.phone_otps is
  'R-1903: one row per mobile OTP sent. code_hash = HMAC of the code (never the code). '
  'Service role only; read and written through request_phone_otp / verify_phone_otp.';
create index if not exists phone_otps_user_time_idx  on public.phone_otps (user_id, created_at desc);
create index if not exists phone_otps_phone_time_idx on public.phone_otps (phone, created_at desc);

alter table public.phone_otps enable row level security;
revoke all on table public.phone_otps from public;
revoke all on table public.phone_otps from anon;
revoke all on table public.phone_otps from authenticated;
grant all on table public.phone_otps to service_role;
drop policy if exists zzz_service_role_all on public.phone_otps;
create policy zzz_service_role_all on public.phone_otps
  as permissive for all to service_role using (true) with check (true);

-- ── 4. A changed number is not verified; "verified" is set only by verify_phone_otp ────────
create or replace function public.r1903_users_phone_verified_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  /* verify_phone_otp sets this flag for its own UPDATE, and runs as the function owner — a
     signed-in role (PostgREST, Prisma app_runtime) can never be the one that sets it. */
  if coalesce(current_setting('app.r1903_phone_verify', true), '') = 'on'
     and current_user::text not in ('anon', 'authenticated', 'authenticator', 'app_runtime', 'app_anon', 'app_jobs') then
    return new;
  end if;
  if new.phone is distinct from old.phone then
    new.phone_verified_at := null;
  elsif new.phone_verified_at is not null and new.phone_verified_at is distinct from old.phone_verified_at then
    raise exception 'A mobile number is marked verified only by its OTP. Open Settings → Security → Mobile number and press Verify.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists users_phone_verified_guard on public.users;
create trigger users_phone_verified_guard
  before update on public.users
  for each row execute function public.r1903_users_phone_verified_guard();

-- ── 5. Who is asking: a signed-in, active user of a company (fails closed, §17c) ────────────
create or replace function public.r1903_otp_caller()
returns table (user_id uuid, tenant_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := public.current_user_id();
  v_caller uuid := public.current_tenant_id();
  v_tenant uuid;
begin
  if v_uid is null then
    raise exception 'R-1903: your session has ended — sign in again, then verify your mobile number.'
      using errcode = '28000';
  end if;
  select u.tenant_id into v_tenant from public.users u where u.id = v_uid and u.is_active;
  if v_tenant is null or v_caller is null or v_tenant <> v_caller then
    raise exception 'R-1903: sign in to your company account to verify your mobile number.'
      using errcode = '28000';
  end if;
  return query select v_uid, v_tenant;
end;
$$;
revoke all on function public.r1903_otp_caller() from public, anon, authenticated;

-- ── 6. request_phone_otp ────────────────────────────────────────────────────────────────────
create or replace function public.request_phone_otp(p_phone text, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid;
  v_tenant uuid;
  v_until  timestamptz;
  v_last   timestamptz;
  v_oldest timestamptz;
  v_n      integer;
  v_id     uuid;
  v_exp    timestamptz := now() + interval '5 minutes';
begin
  select c.user_id, c.tenant_id into v_uid, v_tenant from public.r1903_otp_caller() c;

  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'R-1903: the code must be hashed before it is stored.' using errcode = '22023';
  end if;
  if p_phone is null or p_phone !~ '^\+91[6-9][0-9]{9}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  -- Two quick presses must not both pass the limits: one at a time per user, then per number.
  perform pg_advisory_xact_lock(hashtextextended('r1903:u:' || v_uid::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('r1903:p:' || p_phone, 0));

  select max(o.locked_until) into v_until from public.phone_otps o
   where o.user_id = v_uid and o.phone = p_phone and o.locked_until > now();
  if v_until is not null then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'retry_after_seconds', ceil(extract(epoch from v_until - now()))::int);
  end if;

  select max(o.created_at) into v_last from public.phone_otps o
   where (o.user_id = v_uid or o.phone = p_phone) and o.created_at > now() - interval '30 seconds';
  if v_last is not null then
    return jsonb_build_object('ok', false, 'reason', 'cooldown',
      'retry_after_seconds', greatest(1, ceil(30 - extract(epoch from now() - v_last)))::int);
  end if;

  select count(*), min(o.created_at) into v_n, v_oldest from public.phone_otps o
   where o.user_id = v_uid and o.created_at > now() - interval '1 hour';
  if v_n >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited',
      'retry_after_seconds', greatest(1, ceil(3600 - extract(epoch from now() - v_oldest)))::int);
  end if;
  select count(*), min(o.created_at) into v_n, v_oldest from public.phone_otps o
   where o.phone = p_phone and o.created_at > now() - interval '1 hour';
  if v_n >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited',
      'retry_after_seconds', greatest(1, ceil(3600 - extract(epoch from now() - v_oldest)))::int);
  end if;

  -- A new code replaces every earlier one of this user.
  update public.phone_otps set consumed_at = now()
   where user_id = v_uid and purpose = 'verify_phone' and consumed_at is null;

  insert into public.phone_otps (tenant_id, user_id, phone, purpose, code_hash, expires_at)
  values (v_tenant, v_uid, p_phone, 'verify_phone', p_code_hash, v_exp)
  returning id into v_id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, v_uid, 'otp_sent', 'users', v_uid::text,
          'Mobile OTP sent to ' || public.mask_phone(p_phone),
          jsonb_build_object('phone', public.mask_phone(p_phone), 'purpose', 'verify_phone'));

  return jsonb_build_object('ok', true, 'otp_id', v_id, 'expires_at', v_exp, 'resend_after_seconds', 30);
end;
$$;
revoke all on function public.request_phone_otp(text, text) from public, anon;
grant execute on function public.request_phone_otp(text, text) to authenticated, service_role;

-- ── 7. verify_phone_otp ─────────────────────────────────────────────────────────────────────
create or replace function public.verify_phone_otp(p_phone text, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid;
  v_tenant uuid;
  r        public.phone_otps;
  v_att    integer;
  v_at     timestamptz := now();
  v_log    bigint;
begin
  select c.user_id, c.tenant_id into v_uid, v_tenant from public.r1903_otp_caller() c;

  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'R-1903: the code must be hashed before it is checked.' using errcode = '22023';
  end if;
  if p_phone is null or p_phone !~ '^\+91[6-9][0-9]{9}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('r1903:u:' || v_uid::text, 0));

  -- Only MY newest code for this number — another user's code is never looked at.
  select * into r from public.phone_otps o
   where o.user_id = v_uid and o.phone = p_phone and o.purpose = 'verify_phone'
   order by o.created_at desc
   limit 1
   for update;
  if not found or r.consumed_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'no_code');
  end if;
  if r.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'retry_after_seconds', ceil(extract(epoch from r.locked_until - now()))::int);
  end if;
  if r.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  if r.code_hash <> p_code_hash then
    -- Returned, not raised: a raise would roll the attempt count back.
    update public.phone_otps
       set attempts = attempts + 1,
           locked_until = case when attempts + 1 >= 3 then now() + interval '15 minutes' end
     where id = r.id
     returning attempts into v_att;
    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (v_tenant, v_uid, 'otp_failed', 'users', v_uid::text,
            'Wrong mobile OTP for ' || public.mask_phone(p_phone),
            jsonb_build_object('phone', public.mask_phone(p_phone), 'attempt', v_att, 'locked', v_att >= 3));
    if v_att >= 3 then
      return jsonb_build_object('ok', false, 'reason', 'locked', 'retry_after_seconds', 900);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'tries_left', 3 - v_att);
  end if;

  update public.phone_otps set consumed_at = now() where id = r.id;

  -- Proven, but already the verified number of another login → never two owners of one number.
  if exists (select 1 from public.users u
              where u.phone = p_phone and u.phone_verified_at is not null and u.id <> v_uid) then
    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (v_tenant, v_uid, 'otp_failed', 'users', v_uid::text,
            'Mobile ' || public.mask_phone(p_phone) || ' is verified on another login',
            jsonb_build_object('phone', public.mask_phone(p_phone), 'reason', 'taken'));
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end if;

  perform set_config('app.r1903_phone_verify', 'on', true);
  update public.users set phone = p_phone, phone_verified_at = v_at where id = v_uid;
  perform set_config('app.r1903_phone_verify', '', true);

  -- users_activity (log_row_change) copied the old and new number in full: keep them masked.
  select max(a.id) into v_log from public.activity_log a
   where a.tenant_id = v_tenant and a.entity = 'users' and a.entity_id = v_uid::text
     and a.action = 'update' and a.changes ? 'phone';
  if v_log is not null then
    update public.activity_log a
       set changes = jsonb_set(a.changes, '{phone}', jsonb_build_object(
             'old', public.mask_phone(a.changes->'phone'->>'old'),
             'new', public.mask_phone(a.changes->'phone'->>'new')))
     where a.id = v_log;
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, v_uid, 'otp_verified', 'users', v_uid::text,
          'Mobile verified: ' || public.mask_phone(p_phone),
          jsonb_build_object('phone', public.mask_phone(p_phone)));

  return jsonb_build_object('ok', true, 'phone', p_phone, 'phone_verified_at', v_at);
end;
$$;
revoke all on function public.verify_phone_otp(text, text) from public, anon;
grant execute on function public.verify_phone_otp(text, text) to authenticated, service_role;

-- ── 8. cancel_phone_otp — the SMS did not go out ────────────────────────────────────────────
create or replace function public.cancel_phone_otp(p_otp_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid;
  v_tenant uuid;
  v_phone  text;
begin
  select c.user_id, c.tenant_id into v_uid, v_tenant from public.r1903_otp_caller() c;
  update public.phone_otps set consumed_at = now()
   where id = p_otp_id and user_id = v_uid and consumed_at is null
   returning phone into v_phone;
  if v_phone is null then
    return false;
  end if;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, v_uid, 'otp_send_failed', 'users', v_uid::text,
          'Mobile OTP could not be sent to ' || public.mask_phone(v_phone),
          jsonb_build_object('phone', public.mask_phone(v_phone)));
  return true;
end;
$$;
revoke all on function public.cancel_phone_otp(uuid) from public, anon;
grant execute on function public.cancel_phone_otp(uuid) to authenticated, service_role;
