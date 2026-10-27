-- R-1903 slice 1 — verify my mobile number with an OTP
-- (migration 20261025083015_r1903_phone_otp).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1903_phone_otp.test.sql
--
-- The owner's path (Pardeep, 25 Oct): Settings → Security → Mobile number → +91 number →
-- Verify → type the 6-digit code → the number shows "Verified". The app hashes the code
-- (HMAC) before it reaches the database, so these tests pass 64-hex hashes, never the code.
--
-- What it proves:
--   1. request_phone_otp stores the HASH (a 6-digit plain code is refused), 5-minute expiry,
--      0 attempts; the audit line has the masked number only.
--   2. A resend inside 30 s is refused (cooldown).
--   3. 3 wrong codes → locked for 15 min; the right code is refused while locked, and so is a
--      new code request.
--   4. The right code sets users.phone + phone_verified_at; the users audit row keeps only the
--      masked number; no audit row anywhere holds the full number.
--   5. An expired code is refused.
--   6. Another user cannot verify my code (even with the right hash); my row is untouched.
--   7. phone_verified_at cannot be set by a plain UPDATE; changing the number clears it.
--   8. 5 sends per hour per user, and per phone across users.
--   9. No session → refused; a signed-in login with no company → refused.
--  10. A number already verified on another login is refused ("taken").

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1903000-0000-0000-0000-0000000000a1'::uuid, 'T-R1903 A', 'r1903-a@example.in', '07', 'TRG');
insert into auth.users (id, email) values
  ('c1903000-0000-0000-0000-00000000a0a1', 'r1903-owner-a@example.test'),
  ('c1903000-0000-0000-0000-00000000b0b1', 'r1903-sales-b@example.test'),
  ('c1903000-0000-0000-0000-00000000f0f1', 'r1903-nobody@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1903000-0000-0000-0000-00000000a0a1', 'c1903000-0000-0000-0000-0000000000a1', 'r1903-owner-a@example.in', 'owner', 'Owner A'),
  ('c1903000-0000-0000-0000-00000000b0b1', 'c1903000-0000-0000-0000-0000000000a1', 'r1903-sales-b@example.in', 'sales', 'Sales B');

-- Hashes the app would send (any 64-hex works; the code itself never reaches SQL).
create temp table h (k text primary key, v text) on commit drop;
insert into h values
  ('right1', encode(sha256('r1903-right-1'::bytea), 'hex')),
  ('wrong',  encode(sha256('r1903-wrong'::bytea), 'hex')),
  ('right2', encode(sha256('r1903-right-2'::bytea), 'hex')),
  ('right3', encode(sha256('r1903-right-3'::bytea), 'hex')),
  ('right4', encode(sha256('r1903-right-4'::bytea), 'hex'));
grant select on h to authenticated;

-- ── 1–3 as owner A ─────────────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);

do $$
declare r jsonb; ok boolean;
begin
  -- 1a. A plain 6-digit code is never stored.
  begin
    perform public.request_phone_otp('+919876543210', '123456');
    raise exception 'FAIL 1a: a plain code was accepted';
  exception when sqlstate '22023' then null;
  end;
  -- 1b. Invalid number → plain reason, nothing stored.
  r := public.request_phone_otp('12345', (select v from h where k = 'right1'));
  if r->>'reason' is distinct from 'invalid_phone' then raise exception 'FAIL 1b: %', r; end if;
  -- 1c. The owner's path.
  r := public.request_phone_otp('+919876543210', (select v from h where k = 'right1'));
  if (r->>'ok')::boolean is not true or r->>'otp_id' is null then raise exception 'FAIL 1c: %', r; end if;
  -- 1d. Signed-in users cannot read the OTP table at all.
  begin
    perform 1 from public.phone_otps limit 1;
    raise exception 'FAIL 1d: authenticated can read phone_otps';
  exception when insufficient_privilege then null;
  end;
  -- 2. Resend inside 30 s.
  r := public.request_phone_otp('+919876543210', (select v from h where k = 'right2'));
  if r->>'reason' is distinct from 'cooldown' or (r->>'retry_after_seconds')::int not between 1 and 30 then
    raise exception 'FAIL 2: %', r;
  end if;
  -- 3. Three wrong codes.
  r := public.verify_phone_otp('+919876543210', (select v from h where k = 'wrong'));
  if r->>'reason' is distinct from 'wrong_code' or (r->>'tries_left')::int <> 2 then raise exception 'FAIL 3a: %', r; end if;
  r := public.verify_phone_otp('+919876543210', (select v from h where k = 'wrong'));
  if r->>'reason' is distinct from 'wrong_code' or (r->>'tries_left')::int <> 1 then raise exception 'FAIL 3b: %', r; end if;
  r := public.verify_phone_otp('+919876543210', (select v from h where k = 'wrong'));
  if r->>'reason' is distinct from 'locked' or (r->>'retry_after_seconds')::int <> 900 then raise exception 'FAIL 3c: %', r; end if;
  r := public.verify_phone_otp('+919876543210', (select v from h where k = 'right1'));
  if r->>'reason' is distinct from 'locked' then raise exception 'FAIL 3d: right code passed while locked: %', r; end if;
  r := public.request_phone_otp('+919876543210', (select v from h where k = 'right2'));
  if r->>'reason' is distinct from 'locked' then raise exception 'FAIL 3e: new code while locked: %', r; end if;
end $$;

reset role;
do $$
declare n int; lab text; row public.phone_otps;
begin
  select * into row from public.phone_otps
   where user_id = 'c1903000-0000-0000-0000-00000000a0a1' order by created_at desc limit 1;
  if row.code_hash <> (select v from h where k = 'right1') or row.code_hash ~ '^[0-9]{6}$' then
    raise exception 'FAIL 1e: stored hash wrong: %', row.code_hash;
  end if;
  if row.expires_at <> now() + interval '5 minutes' then raise exception 'FAIL 1f: expiry %', row.expires_at - now(); end if;
  if row.attempts <> 3 or row.locked_until <> now() + interval '15 minutes' then
    raise exception 'FAIL 3f: attempts % lock %', row.attempts, row.locked_until - now();
  end if;
  select count(*) into n from public.phone_otps where user_id = 'c1903000-0000-0000-0000-00000000a0a1';
  if n <> 1 then raise exception 'FAIL 1g: % rows (refused requests must store nothing)', n; end if;
  select label into lab from public.activity_log
   where tenant_id = 'c1903000-0000-0000-0000-0000000000a1' and action = 'otp_sent';
  if lab is distinct from 'Mobile OTP sent to +91 98*****210' then raise exception 'FAIL 1h: audit label %', lab; end if;
  select count(*) into n from public.activity_log
   where tenant_id = 'c1903000-0000-0000-0000-0000000000a1' and action = 'otp_failed';
  if n <> 3 then raise exception 'FAIL 3g: % otp_failed rows', n; end if;
  -- Time passes: lock over, cooldown over.
  update public.phone_otps set locked_until = now() - interval '1 second',
         created_at = now() - interval '16 minutes', expires_at = now() - interval '11 minutes'
   where user_id = 'c1903000-0000-0000-0000-00000000a0a1';
end $$;

-- ── 4–5 as owner A ─────────────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  r := public.request_phone_otp('+919876543210', (select v from h where k = 'right2'));
  if (r->>'ok')::boolean is not true then raise exception 'FAIL 4a: %', r; end if;
  -- The old code no longer works (a newer one replaced it).
  r := public.verify_phone_otp('+919876543210', (select v from h where k = 'right1'));
  if r->>'reason' is distinct from 'wrong_code' then raise exception 'FAIL 4b: old code %', r; end if;
  r := public.verify_phone_otp('+919876543210', (select v from h where k = 'right2'));
  if (r->>'ok')::boolean is not true or r->>'phone_verified_at' is null then raise exception 'FAIL 4c: %', r; end if;
  -- Used once: the same code again is refused.
  r := public.verify_phone_otp('+919876543210', (select v from h where k = 'right2'));
  if r->>'reason' is distinct from 'no_code' then raise exception 'FAIL 4d: reuse %', r; end if;
end $$;

reset role;
do $$
declare u public.users; n int; ch jsonb;
begin
  select * into u from public.users where id = 'c1903000-0000-0000-0000-00000000a0a1';
  if u.phone is distinct from '+919876543210' or u.phone_verified_at is null then
    raise exception 'FAIL 4e: phone % verified %', u.phone, u.phone_verified_at;
  end if;
  select count(*) into n from public.activity_log
   where tenant_id = 'c1903000-0000-0000-0000-0000000000a1' and action = 'otp_verified'
     and label = 'Mobile verified: +91 98*****210';
  if n <> 1 then raise exception 'FAIL 4f: % otp_verified rows', n; end if;
  select changes into ch from public.activity_log
   where tenant_id = 'c1903000-0000-0000-0000-0000000000a1' and action = 'update' and entity = 'users'
   order by id desc limit 1;
  if ch->'phone'->>'new' is distinct from '+91 98*****210' then raise exception 'FAIL 4g: users audit %', ch; end if;
  select count(*) into n from public.activity_log
   where tenant_id = 'c1903000-0000-0000-0000-0000000000a1'
     and (coalesce(changes::text, '') || coalesce(label, '')) like '%9876543210%';
  if n <> 0 then raise exception 'FAIL 4h: % audit rows hold the full number', n; end if;
  update public.phone_otps set created_at = now() - interval '31 seconds'
   where user_id = 'c1903000-0000-0000-0000-00000000a0a1';
end $$;

-- 5. Expired code (owner A, a second number).
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
select public.request_phone_otp('+919811111111', (select v from h where k = 'right3'));
reset role;
update public.phone_otps set expires_at = now() - interval '1 second', created_at = now() - interval '6 minutes'
 where phone = '+919811111111';
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  r := public.verify_phone_otp('+919811111111', (select v from h where k = 'right3'));
  if r->>'reason' is distinct from 'expired' then raise exception 'FAIL 5: %', r; end if;
  -- 6 (setup): A asks for a code on a third number.
  r := public.request_phone_otp('+919812345678', (select v from h where k = 'right4'));
  if (r->>'ok')::boolean is not true then raise exception 'FAIL 6a: %', r; end if;
  -- 7a. A cannot mark themselves verified with a plain UPDATE.
  begin
    update public.users set phone_verified_at = now() + interval '1 second'
     where id = 'c1903000-0000-0000-0000-00000000a0a1';
    raise exception 'FAIL 7a: plain update set phone_verified_at';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 6. Sales B (same company) tries A's code — even with the right hash.
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  r := public.verify_phone_otp('+919812345678', (select v from h where k = 'right4'));
  if r->>'reason' is distinct from 'no_code' then raise exception 'FAIL 6b: B verified A''s code: %', r; end if;
  -- 10. B cannot take A's verified number either: B gets a code for it and types it right.
  r := public.request_phone_otp('+919876543210', (select v from h where k = 'right1'));
  if (r->>'ok')::boolean is not true then raise exception 'FAIL 10a: %', r; end if;
  r := public.verify_phone_otp('+919876543210', (select v from h where k = 'right1'));
  if r->>'reason' is distinct from 'taken' then raise exception 'FAIL 10b: %', r; end if;
end $$;

reset role;
do $$
declare row public.phone_otps; u public.users;
begin
  select * into row from public.phone_otps where phone = '+919812345678';
  if row.attempts <> 0 or row.consumed_at is not null then raise exception 'FAIL 6c: A''s row touched'; end if;
  select * into u from public.users where id = 'c1903000-0000-0000-0000-00000000b0b1';
  if u.phone is not null or u.phone_verified_at is not null then raise exception 'FAIL 10c: B got the number'; end if;
end $$;

-- 7b. Changing the number clears "verified" (Team page / admin edit / own edit).
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
update public.users set phone = '+919899999999' where id = 'c1903000-0000-0000-0000-00000000a0a1';
reset role;
do $$
declare u public.users;
begin
  select * into u from public.users where id = 'c1903000-0000-0000-0000-00000000a0a1';
  if u.phone <> '+919899999999' or u.phone_verified_at is not null then
    raise exception 'FAIL 7b: changed number still verified (%)', u.phone_verified_at;
  end if;
  -- 8 (setup): five sends in the last hour for A, and five for a number from B.
  delete from public.phone_otps;
  insert into public.phone_otps (tenant_id, user_id, phone, code_hash, expires_at, created_at, consumed_at)
  select 'c1903000-0000-0000-0000-0000000000a1', 'c1903000-0000-0000-0000-00000000a0a1', '+919800000001',
         (select v from h where k = 'wrong'), now(), now() - (g * interval '5 minutes'), now()
    from generate_series(1, 5) g;
  insert into public.phone_otps (tenant_id, user_id, phone, code_hash, expires_at, created_at, consumed_at)
  select 'c1903000-0000-0000-0000-0000000000a1', 'c1903000-0000-0000-0000-00000000b0b1', '+919800000002',
         (select v from h where k = 'wrong'), now(), now() - (g * interval '5 minutes'), now()
    from generate_series(1, 5) g;
end $$;

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  r := public.request_phone_otp('+919800000009', (select v from h where k = 'right1'));
  if r->>'reason' is distinct from 'rate_limited' or (r->>'retry_after_seconds')::int <> 2100 then
    raise exception 'FAIL 8a: per-user limit %', r;
  end if;
end $$;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  -- B's own sends are also 5 → use the per-phone path: B asks for the number that already had 5.
  r := public.request_phone_otp('+919800000002', (select v from h where k = 'right1'));
  if r->>'reason' is distinct from 'rate_limited' then raise exception 'FAIL 8b: %', r; end if;
end $$;
reset role;
-- Per phone ACROSS users: move B's five rows to A's company-mate... i.e. make them A-less:
-- A (now under the per-user limit after clearing A's rows) asks for B's busy number.
delete from public.phone_otps where user_id = 'c1903000-0000-0000-0000-00000000a0a1';
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
do $$
declare r jsonb;
begin
  r := public.request_phone_otp('+919800000002', (select v from h where k = 'right1'));
  if r->>'reason' is distinct from 'rate_limited' then raise exception 'FAIL 8c: per-phone limit %', r; end if;
end $$;

-- 9. No session; signed in with no company.
select set_config('request.jwt.claims', '', true);
do $$
begin
  begin
    perform public.request_phone_otp('+919876543210', (select v from h where k = 'right1'));
    raise exception 'FAIL 9a: no session accepted';
  exception when sqlstate '28000' then null;
  end;
end $$;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1903000-0000-0000-0000-00000000f0f1', 'role', 'authenticated')::text, true);
do $$
begin
  begin
    perform public.verify_phone_otp('+919876543210', (select v from h where k = 'right1'));
    raise exception 'FAIL 9b: no-company login accepted';
  exception when sqlstate '28000' then null;
  end;
end $$;

reset role;
select 'R-1903 phone OTP: all checks passed' as result;

rollback;
