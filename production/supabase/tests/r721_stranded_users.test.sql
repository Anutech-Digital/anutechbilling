\set ON_ERROR_STOP on
-- R-721 (P1 SECURITY): Team -> "Claim a colleague" is scoped to the caller's own workspace.
-- Migration 20261011124100_r721_stranded_users. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r721_stranded_users.test.sql
--
-- Expect "PASS r721_stranded_users". Failures are collected and listed together, so on the old
-- bodies the run names every hole (proved 11 Oct 2026).
--
--   Owner of A must NOT see / claim: a stranded login with a join request to B; one with no
--     request at all; one invited by A who has NOT signed in since the invite; a person alone
--     in an empty workspace C with no request to A.
--   Refusals are generic: "no account" and "no request" read the same; no other company's name.
--   Owner of A CAN see + claim: a stranded login with a pending join request to A; one invited
--     by A who signed in after the invite; a person in an empty workspace D who asked to join A.
--   An INACTIVE owner of A is refused both functions. service_role sees everyone and can claim.

begin;
select set_config('request.jwt.claims', '', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e7210000-0000-0000-0000-0000000000a0', 'R721 A',          'r721a@example.in', '07', 'R72A'),
  ('e7210000-0000-0000-0000-0000000000b0', 'R721 B',          'r721b@example.in', '07', 'R72B'),
  ('e7210000-0000-0000-0000-0000000000c0', 'R721 Secret Co',  'r721c@example.in', '07', 'R72C'),
  ('e7210000-0000-0000-0000-0000000000d0', 'R721 Stray Co',   'r721d@example.in', '07', 'R72D');

insert into auth.users (id, email, last_sign_in_at) values
  ('e7210000-0000-4000-8000-0000000000a1', 'r721-owner-a@example.test',    now()),
  ('e7210000-0000-4000-8000-0000000000a2', 'r721-inactive-a@example.test', now()),
  ('e7210000-0000-4000-8000-0000000000b1', 'r721-owner-b@example.test',    now()),
  ('e7210000-0000-4000-8000-0000000000c1', 'r721-lonely-c@example.test',   now()),
  ('e7210000-0000-4000-8000-0000000000d1', 'r721-stray-d@example.test',    now()),
  -- stranded (no public.users row):
  ('e7210000-0000-4000-8000-000000000501', 'r721-wants-b@example.test',    now()),
  ('e7210000-0000-4000-8000-000000000502', 'r721-nobody@example.test',     now()),
  ('e7210000-0000-4000-8000-000000000503', 'r721-wants-a@example.test',    now()),
  ('e7210000-0000-4000-8000-000000000504', 'r721-inv-stale@example.test',  now() - interval '2 days'),
  ('e7210000-0000-4000-8000-000000000505', 'r721-inv-fresh@example.test',  now());

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e7210000-0000-4000-8000-0000000000a1', 'e7210000-0000-0000-0000-0000000000a0', 'r721-owner-a@example.test',    'R721 Owner A',  'owner', true),
  ('e7210000-0000-4000-8000-0000000000a2', 'e7210000-0000-0000-0000-0000000000a0', 'r721-inactive-a@example.test', 'R721 Inactive', 'owner', false),
  ('e7210000-0000-4000-8000-0000000000b1', 'e7210000-0000-0000-0000-0000000000b0', 'r721-owner-b@example.test',    'R721 Owner B',  'owner', true),
  ('e7210000-0000-4000-8000-0000000000c1', 'e7210000-0000-0000-0000-0000000000c0', 'r721-lonely-c@example.test',   'R721 Lonely',   'owner', true),
  ('e7210000-0000-4000-8000-0000000000d1', 'e7210000-0000-0000-0000-0000000000d0', 'r721-stray-d@example.test',    'R721 Stray',    'owner', true);

insert into public.join_requests (tenant_id, auth_user_id, email, matched_by) values
  ('e7210000-0000-0000-0000-0000000000b0', 'e7210000-0000-4000-8000-000000000501', 'r721-wants-b@example.test', 'manual'),
  ('e7210000-0000-0000-0000-0000000000a0', 'e7210000-0000-4000-8000-000000000503', 'r721-wants-a@example.test', 'manual'),
  ('e7210000-0000-0000-0000-0000000000a0', 'e7210000-0000-4000-8000-0000000000d1', 'r721-stray-d@example.test', 'manual');

insert into public.team_invites (tenant_id, email, role, created_at) values
  ('e7210000-0000-0000-0000-0000000000a0', 'r721-inv-stale@example.test', 'support', now() - interval '1 day'),
  ('e7210000-0000-0000-0000-0000000000a0', 'r721-inv-fresh@example.test', 'support', now() - interval '1 hour');

create temp table r721_fail (n serial, label text, detail text);

/* Run one merge as a signed-in user. want = 'ok' or 'refused'. Returns the error text ('' on ok). */
create or replace function pg_temp.r721_merge(p_label text, p_uid text, p_email text, p_tenant uuid, p_want text)
returns text language plpgsql as $$
declare v_msg text := ''; v_ok boolean := true;
begin
  perform set_config('request.jwt.claims',
    case when p_uid = 'service' then '{"role":"service_role"}'
         else format('{"sub":"%s","role":"authenticated"}', p_uid) end, true);
  begin
    perform public.merge_stranded_user_into_tenant(p_email, p_tenant, 'support');
  exception when others then
    v_ok := false; v_msg := sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  if p_want = 'ok' and not v_ok then
    insert into r721_fail(label, detail) values (p_label, 'expected success, got: ' || v_msg);
  elsif p_want = 'refused' and v_ok then
    insert into r721_fail(label, detail) values (p_label, 'expected refusal, but the claim SUCCEEDED');
  else
    raise notice 'ok   %', p_label;
  end if;
  return v_msg;
end $$;

/* Emails the caller sees in list_stranded_auth_users(); null = the call was refused. */
create or replace function pg_temp.r721_list(p_uid text)
returns text[] language plpgsql as $$
declare v text[];
begin
  perform set_config('request.jwt.claims',
    case when p_uid = 'service' then '{"role":"service_role"}'
         else format('{"sub":"%s","role":"authenticated"}', p_uid) end, true);
  begin
    select coalesce(array_agg(s.email order by s.email), '{}') into v
      from public.list_stranded_auth_users() s where s.email like 'r721-%';
  exception when others then
    v := null;
  end;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

do $$
declare
  a   constant text := 'e7210000-0000-4000-8000-0000000000a1';
  ina constant text := 'e7210000-0000-4000-8000-0000000000a2';
  ta  constant uuid := 'e7210000-0000-0000-0000-0000000000a0';
  v   text[];
  m1  text; m2 text; m3 text;
begin
  -- ── LIST ───────────────────────────────────────────────────────────────
  v := pg_temp.r721_list(a);
  if v is null then
    insert into r721_fail(label, detail) values ('list/owner A', 'refused for an active owner');
  else
    if 'r721-wants-b@example.test' = any(v) then
      insert into r721_fail(label, detail) values ('list/owner A', 'sees a login that asked to join B'); end if;
    if 'r721-nobody@example.test' = any(v) then
      insert into r721_fail(label, detail) values ('list/owner A', 'sees a login with no request at all'); end if;
    if 'r721-inv-stale@example.test' = any(v) then
      insert into r721_fail(label, detail) values ('list/owner A', 'sees an invitee who has not signed in since the invite'); end if;
    if not ('r721-wants-a@example.test' = any(v)) then
      insert into r721_fail(label, detail) values ('list/owner A', 'does NOT see a login that asked to join A'); end if;
    if not ('r721-inv-fresh@example.test' = any(v)) then
      insert into r721_fail(label, detail) values ('list/owner A', 'does NOT see an invitee who signed in after the invite'); end if;
    raise notice 'list owner A -> %', v;
  end if;

  if pg_temp.r721_list(ina) is not null then
    insert into r721_fail(label, detail) values ('list/inactive owner', 'an INACTIVE owner can still list'); end if;

  v := pg_temp.r721_list('service');
  if v is null or not ('r721-wants-b@example.test' = any(v)) or not ('r721-nobody@example.test' = any(v)) then
    insert into r721_fail(label, detail) values ('list/service_role', 'platform admin path lost the full list: ' || coalesce(v::text, 'refused')); end if;

  -- ── MERGE: refusals ────────────────────────────────────────────────────
  m1 := pg_temp.r721_merge('merge/A pulls B''s requester',     a, 'r721-wants-b@example.test',   ta, 'refused');
  m2 := pg_temp.r721_merge('merge/A pulls a no-request login', a, 'r721-nobody@example.test',    ta, 'refused');
  m3 := pg_temp.r721_merge('merge/A pulls an unknown address', a, 'r721-ghost@example.test',     ta, 'refused');
        perform pg_temp.r721_merge('merge/A pulls a stale invitee', a, 'r721-inv-stale@example.test', ta, 'refused');
  if replace(m1, 'r721-wants-b@example.test', 'X') is distinct from replace(m3, 'r721-ghost@example.test', 'X') then
    insert into r721_fail(label, detail) values ('merge/generic error',
      format('"has account, no request" and "no account" read differently: [%s] vs [%s]', m1, m3)); end if;
  if m3 ilike '%no account%' or m3 ilike '%exists%' then
    insert into r721_fail(label, detail) values ('merge/generic error', 'says whether an account exists: ' || m3); end if;

  m1 := pg_temp.r721_merge('merge/A pulls lonely owner of C', a, 'r721-lonely-c@example.test', ta, 'refused');
  if m1 like '%Secret Co%' then
    insert into r721_fail(label, detail) values ('merge/tenant-name leak', m1); end if;
  if (select tenant_id from public.users where id = 'e7210000-0000-4000-8000-0000000000c1') <> 'e7210000-0000-0000-0000-0000000000c0'
     or not exists (select 1 from public.tenants where id = 'e7210000-0000-0000-0000-0000000000c0') then
    insert into r721_fail(label, detail) values ('merge/A pulls lonely owner of C', 'C was emptied/deleted'); end if;

  perform pg_temp.r721_merge('merge/inactive owner of A', ina, 'r721-wants-a@example.test', ta, 'refused');
  perform pg_temp.r721_merge('merge/owner B into A',      'e7210000-0000-4000-8000-0000000000b1', 'r721-wants-a@example.test', ta, 'refused');

  -- ── MERGE: the legitimate case still works ─────────────────────────────
  perform pg_temp.r721_merge('merge/A claims its own requester', a, 'r721-wants-a@example.test',   ta, 'ok');
  perform pg_temp.r721_merge('merge/A claims a fresh invitee',   a, 'r721-inv-fresh@example.test', ta, 'ok');
  perform pg_temp.r721_merge('merge/A claims empty-workspace requester', a, 'r721-stray-d@example.test', ta, 'ok');
  if not exists (select 1 from public.users where id = 'e7210000-0000-4000-8000-000000000503' and tenant_id = ta) then
    insert into r721_fail(label, detail) values ('merge/A claims its own requester', 'no users row in A afterwards'); end if;
  if exists (select 1 from public.join_requests where email = 'r721-wants-a@example.test' and status = 'pending_approval') then
    insert into r721_fail(label, detail) values ('merge/A claims its own requester', 'join request left pending'); end if;
  if (select tenant_id from public.users where id = 'e7210000-0000-4000-8000-0000000000d1') is distinct from ta then
    insert into r721_fail(label, detail) values ('merge/A claims empty-workspace requester', 'not moved into A'); end if;

  perform pg_temp.r721_merge('merge/service_role claims no-request login', 'service', 'r721-nobody@example.test', ta, 'ok');
end $$;

do $$
declare v text;
begin
  if exists (select 1 from r721_fail) then
    select string_agg(format('  FAIL %s: %s', label, detail), E'\n' order by n) into v from r721_fail;
    raise exception E'r721_stranded_users — % failure(s):\n%', (select count(*) from r721_fail), v;
  end if;
  raise notice 'PASS r721_stranded_users';
end $$;

rollback;
