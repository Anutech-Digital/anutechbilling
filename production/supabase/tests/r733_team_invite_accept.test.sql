\set ON_ERROR_STOP on
-- R-733: a team invite expires (7 days) and is accepted ONCE, atomically.
-- Migration 20261019010621_r733_team_invite_expiry. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r733_team_invite_accept.test.sql
--
-- Expect "PASS r733_team_invite_accept". Failures are collected and listed together.
--   1. a new invite gets expires_at = now() + 7 days
--   2. a signed-in (authenticated) caller is refused (28000) — only the server accepts
--   3. service_role + right token → users row in the inviting company with the invited role
--   4. DOUBLE ACCEPT: the same link a second time (another login) → "already been used", no row
--   5. an expired invite → "expired", no row, invite still open (owner can renew it)
--   6. a wrong token → "not valid", no row
--   7. Google path (no token, verified email) accepts by email
--   8. users insert fails (id already a member) → the claim rolls back with it, invite still open
--   9. EXECUTE is not granted to anon / authenticated

begin;
select set_config('request.jwt.claims', '', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e7330000-0000-0000-0000-0000000000a0', 'R733 A', 'r733a@example.in', '07', 'R73A');

insert into auth.users (id, email) values
  ('e7330000-0000-4000-8000-0000000000a1', 'r733-owner@example.test'),
  ('e7330000-0000-4000-8000-000000000001', 'r733-new@example.test'),
  ('e7330000-0000-4000-8000-000000000002', 'r733-racer@example.test'),
  ('e7330000-0000-4000-8000-000000000003', 'r733-late@example.test'),
  ('e7330000-0000-4000-8000-000000000004', 'r733-wrongtok@example.test'),
  ('e7330000-0000-4000-8000-000000000005', 'r733-google@example.test');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e7330000-0000-4000-8000-0000000000a1', 'e7330000-0000-0000-0000-0000000000a0', 'r733-owner@example.test', 'R733 Owner', 'owner', true);

insert into public.team_invites (tenant_id, email, role, token) values
  ('e7330000-0000-0000-0000-0000000000a0', 'r733-new@example.test',      'support', 'e7330000-0000-4000-8000-00000000f001'),
  ('e7330000-0000-0000-0000-0000000000a0', 'r733-wrongtok@example.test', 'support', 'e7330000-0000-4000-8000-00000000f004'),
  ('e7330000-0000-0000-0000-0000000000a0', 'r733-google@example.test',   'billing', 'e7330000-0000-4000-8000-00000000f005'),
  ('e7330000-0000-0000-0000-0000000000a0', 'r733-member@example.test',   'support', 'e7330000-0000-4000-8000-00000000f006');
insert into public.team_invites (tenant_id, email, role, token, created_at, expires_at) values
  ('e7330000-0000-0000-0000-0000000000a0', 'r733-late@example.test', 'support', 'e7330000-0000-4000-8000-00000000f003',
   now() - interval '8 days', now() - interval '1 day');

create temp table r733_fail (n serial, label text, detail text);

/* One accept as `who` ('service' | 'authenticated' | 'none'). want = 'ok' or a refusal fragment. */
create or replace function pg_temp.r733_accept(p_label text, p_who text, p_email text, p_uid uuid, p_token uuid, p_want text)
returns void language plpgsql as $$
declare v_msg text := ''; v_ok boolean := true;
begin
  perform set_config('request.jwt.claims',
    case p_who when 'service' then '{"role":"service_role"}'
               when 'authenticated' then format('{"sub":"%s","role":"authenticated"}', p_uid)
               else '' end, true);
  begin
    perform public.accept_team_invite(p_email, p_uid, 'R733 Person', 'RP', p_token);
  exception when others then
    v_ok := false; v_msg := sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  if p_want = 'ok' and not v_ok then
    insert into r733_fail(label, detail) values (p_label, 'expected success, got: ' || v_msg);
  elsif p_want <> 'ok' and v_ok then
    insert into r733_fail(label, detail) values (p_label, 'expected refusal, but it SUCCEEDED');
  elsif p_want <> 'ok' and position(p_want in v_msg) = 0 then
    insert into r733_fail(label, detail) values (p_label, format('refused, but message %L lacks %L', v_msg, p_want));
  else
    raise notice 'ok   %', p_label;
  end if;
end $$;

-- 1. default expiry
do $$ begin
  if not exists (select 1 from public.team_invites where email = 'r733-new@example.test'
                  and expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 minute') then
    insert into r733_fail(label, detail) values ('1 default expires_at', 'not now()+7 days');
  end if;
end $$;

-- 2. a signed-in user cannot accept for anyone (would let them join by naming an invited address)
select pg_temp.r733_accept('2 authenticated caller refused', 'authenticated', 'r733-new@example.test',
  'e7330000-0000-4000-8000-000000000001', 'e7330000-0000-4000-8000-00000000f001', 'accepted only by the sign-up page');

-- 3. the real accept
select pg_temp.r733_accept('3 service_role + token accepts', 'service', 'R733-New@Example.test',
  'e7330000-0000-4000-8000-000000000001', 'e7330000-0000-4000-8000-00000000f001', 'ok');
do $$ begin
  if not exists (select 1 from public.users where id = 'e7330000-0000-4000-8000-000000000001'
                  and tenant_id = 'e7330000-0000-0000-0000-0000000000a0' and role = 'support'
                  and email = 'r733-new@example.test') then
    insert into r733_fail(label, detail) values ('3 member row', 'users row missing / wrong tenant, role or email');
  end if;
  if not exists (select 1 from public.team_invites where token = 'e7330000-0000-4000-8000-00000000f001' and accepted_at is not null) then
    insert into r733_fail(label, detail) values ('3 invite marked', 'accepted_at not set');
  end if;
end $$;

-- 4. DOUBLE ACCEPT: the same link again, by a second login
select pg_temp.r733_accept('4 double accept refused', 'service', 'r733-new@example.test',
  'e7330000-0000-4000-8000-000000000002', 'e7330000-0000-4000-8000-00000000f001', 'already been used');
do $$ begin
  if exists (select 1 from public.users where id = 'e7330000-0000-4000-8000-000000000002') then
    insert into r733_fail(label, detail) values ('4 no second member', 'the second accept created a users row');
  end if;
end $$;

-- 5. expired
select pg_temp.r733_accept('5 expired refused', 'service', 'r733-late@example.test',
  'e7330000-0000-4000-8000-000000000003', 'e7330000-0000-4000-8000-00000000f003', 'expired on');
do $$ begin
  if exists (select 1 from public.users where id = 'e7330000-0000-4000-8000-000000000003') then
    insert into r733_fail(label, detail) values ('5 no member', 'expired invite created a users row');
  end if;
  if not exists (select 1 from public.team_invites where email = 'r733-late@example.test' and accepted_at is null) then
    insert into r733_fail(label, detail) values ('5 still open', 'expired invite was marked used');
  end if;
end $$;

-- 6. wrong token
select pg_temp.r733_accept('6 wrong token refused', 'service', 'r733-wrongtok@example.test',
  'e7330000-0000-4000-8000-000000000004', 'e7330000-0000-4000-8000-00000000ffff', 'not valid');

-- 7. Google path: no token, the provider proved the mailbox
select pg_temp.r733_accept('7 google (no token) accepts', 'service', 'r733-google@example.test',
  'e7330000-0000-4000-8000-000000000005', null, 'ok');
do $$ begin
  if not exists (select 1 from public.users where id = 'e7330000-0000-4000-8000-000000000005' and role = 'billing') then
    insert into r733_fail(label, detail) values ('7 member row', 'google accept did not create the billing member');
  end if;
end $$;

-- 8. the users insert fails (this login is already a member) → the claim must roll back too
select pg_temp.r733_accept('8 insert fails', 'service', 'r733-member@example.test',
  'e7330000-0000-4000-8000-0000000000a1', 'e7330000-0000-4000-8000-00000000f006', 'duplicate key');
do $$ begin
  if not exists (select 1 from public.team_invites where email = 'r733-member@example.test' and accepted_at is null) then
    insert into r733_fail(label, detail) values ('8 atomic', 'invite marked used although no member was created');
  end if;
end $$;

-- 9. grants
do $$ begin
  if has_function_privilege('authenticated', 'public.accept_team_invite(text,uuid,text,text,uuid)', 'execute')
     or has_function_privilege('anon', 'public.accept_team_invite(text,uuid,text,text,uuid)', 'execute') then
    insert into r733_fail(label, detail) values ('9 grants', 'anon/authenticated can EXECUTE accept_team_invite');
  end if;
  if not has_function_privilege('service_role', 'public.accept_team_invite(text,uuid,text,text,uuid)', 'execute') then
    insert into r733_fail(label, detail) values ('9 grants', 'service_role cannot EXECUTE accept_team_invite');
  end if;
end $$;

do $$
declare v text;
begin
  select string_agg(format('FAIL %s: %s', label, detail), E'\n' order by n) into v from r733_fail;
  if v is not null then raise exception E'r733_team_invite_accept:\n%', v; end if;
  raise notice 'PASS r733_team_invite_accept';
end $$;

rollback;
