\set ON_ERROR_STOP on
-- R-2469 (4 Nov 2026): an owner can bring back an employee whose address is held by an
-- invite in ANOTHER workspace, when that invite is stale — never pull someone out of a real
-- company. Migration r2469_release_stale_team_invite. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2469_replace_stale_invite.test.sql
--
-- Expect "PASS r2469_replace_stale_invite". Failures are collected and listed together.
--
--   Owner of A (Excel) MAY clear ('released', invite gone):
--     an EXPIRED pending invite in a real company R; an invite in a blank workspace B whose only
--     member is the invitee (accidental blank workspace); an ACCEPTED invite in R for someone who is
--     no longer a member there.
--   Owner of A may NOT clear ('in_use' / 'member_elsewhere' / 'none', invite stays) — 'member_elsewhere'
--   for anyone in a real company (the 4 Nov staging case: Pratik is a member of another company):
--     a pending unexpired invite in R; an invite in an empty workspace whose member is someone
--     ELSE; an accepted invite in R for someone still in R; an invite in a solo workspace that
--     holds records; A's own invite.
--   Not an active owner → refused. The audit row in A never names the other workspace.
--   End to end: after the clear, A invites Pratik, Pratik signs in, A claims him → he is in A
--   and his blank workspace is gone.

begin;
select set_config('request.jwt.claims', '', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2469000-0000-0000-0000-0000000000a0', 'R2469 Excel',      'r2469a@example.in', '07', 'R24A'),
  ('e2469000-0000-0000-0000-0000000000b0', 'R2469 Blank',      'r2469b@example.in', '07', 'R24B'),
  ('e2469000-0000-0000-0000-0000000000c0', 'R2469 Fresh Co',   'r2469c@example.in', '07', 'R24C'),
  ('e2469000-0000-0000-0000-0000000000d0', 'R2469 Secret Real','r2469d@example.in', '07', 'R24D'),
  ('e2469000-0000-0000-0000-0000000000e0', 'R2469 Solo Data',  'r2469e@example.in', '07', 'R24E');

insert into auth.users (id, email, last_sign_in_at) values
  ('e2469000-0000-4000-8000-0000000000a1', 'r2469-owner-a@example.test',   now()),
  ('e2469000-0000-4000-8000-0000000000a2', 'r2469-sales-a@example.test',   now()),
  ('e2469000-0000-4000-8000-0000000000a3', 'r2469-inactive-a@example.test',now()),
  ('e2469000-0000-4000-8000-0000000000b1', 'r2469-pratik@example.test',    now() - interval '1 day'),
  ('e2469000-0000-4000-8000-0000000000c1', 'r2469-owner-c@example.test',   now()),
  ('e2469000-0000-4000-8000-0000000000d1', 'r2469-owner-d@example.test',   now()),
  ('e2469000-0000-4000-8000-0000000000d2', 'r2469-staff-d@example.test',   now()),
  ('e2469000-0000-4000-8000-0000000000e1', 'r2469-solo-e@example.test',    now());

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2469000-0000-4000-8000-0000000000a1', 'e2469000-0000-0000-0000-0000000000a0', 'r2469-owner-a@example.test',    'Owner A',    'owner', true),
  ('e2469000-0000-4000-8000-0000000000a2', 'e2469000-0000-0000-0000-0000000000a0', 'r2469-sales-a@example.test',    'Sales A',    'sales', true),
  ('e2469000-0000-4000-8000-0000000000a3', 'e2469000-0000-0000-0000-0000000000a0', 'r2469-inactive-a@example.test', 'Inactive A', 'owner', false),
  ('e2469000-0000-4000-8000-0000000000b1', 'e2469000-0000-0000-0000-0000000000b0', 'r2469-pratik@example.test',     'Pratik',     'owner', true),
  ('e2469000-0000-4000-8000-0000000000c1', 'e2469000-0000-0000-0000-0000000000c0', 'r2469-owner-c@example.test',    'Owner C',    'owner', true),
  ('e2469000-0000-4000-8000-0000000000d1', 'e2469000-0000-0000-0000-0000000000d0', 'r2469-owner-d@example.test',    'Owner D',    'owner', true),
  ('e2469000-0000-4000-8000-0000000000d2', 'e2469000-0000-0000-0000-0000000000d0', 'r2469-staff-d@example.test',    'Staff D',    'sales', true),
  ('e2469000-0000-4000-8000-0000000000e1', 'e2469000-0000-0000-0000-0000000000e0', 'r2469-solo-e@example.test',     'Solo E',     'owner', true);

insert into public.customers (id, tenant_id, name, contact_email) values
  ('e2469000-0000-4000-8000-00000000ee01', 'e2469000-0000-0000-0000-0000000000e0', 'R2469 real customer', 'x@example.test');

insert into public.team_invites (tenant_id, email, role, created_at, expires_at, accepted_at) values
  -- may be cleared
  ('e2469000-0000-0000-0000-0000000000d0', 'r2469-expired@example.test',  'support', now() - interval '9 days', now() - interval '2 days', null),
  ('e2469000-0000-0000-0000-0000000000b0', 'r2469-pratik@example.test',   'support', now() - interval '2 days', now() + interval '5 days', null),
  ('e2469000-0000-0000-0000-0000000000d0', 'r2469-left-d@example.test',   'support', now() - interval '30 days', now() - interval '23 days', now() - interval '29 days'),
  -- must stay
  ('e2469000-0000-0000-0000-0000000000d0', 'r2469-pending-d@example.test','support', now() - interval '1 day',  now() + interval '6 days', null),
  ('e2469000-0000-0000-0000-0000000000c0', 'r2469-fresh-c@example.test',  'support', now() - interval '1 day',  now() + interval '6 days', null),
  ('e2469000-0000-0000-0000-0000000000d0', 'r2469-staff-d@example.test',  'sales',   now() - interval '30 days', now() - interval '23 days', now() - interval '29 days'),
  ('e2469000-0000-0000-0000-0000000000e0', 'r2469-solo-e@example.test',   'support', now() - interval '1 day',  now() + interval '6 days', null),
  ('e2469000-0000-0000-0000-0000000000a0', 'r2469-own-a@example.test',    'support', now() - interval '1 day',  now() + interval '6 days', null);

create temp table r2469_fail (n serial, label text, detail text);

/* Call release_stale_team_invite as a signed-in user. Returns 'true'/'false' or 'ERR: <msg>'. */
create or replace function pg_temp.r2469_release(p_uid text, p_email text)
returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', p_uid), true);
  begin
    v := public.release_stale_team_invite(p_email)::text;
  exception when others then
    v := 'ERR: ' || sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create or replace function pg_temp.r2469_expect(p_label text, p_uid text, p_email text, p_want text)
returns void language plpgsql as $$
declare v text := pg_temp.r2469_release(p_uid, p_email);
begin
  if p_want = 'ERR' then
    if v not like 'ERR:%' then
      insert into r2469_fail(label, detail) values (p_label, 'expected a refusal, got ' || v);
    else raise notice 'ok   % (%)', p_label, v; end if;
  elsif v is distinct from p_want then
    insert into r2469_fail(label, detail) values (p_label, format('expected %s, got %s', p_want, v));
  else
    raise notice 'ok   %', p_label;
  end if;
end $$;

do $$
declare
  a   constant text := 'e2469000-0000-4000-8000-0000000000a1';
  ta  constant uuid := 'e2469000-0000-0000-0000-0000000000a0';
  v   jsonb;
  msg text;
begin
  -- ── who may call ────────────────────────────────────────────────────────
  perform pg_temp.r2469_expect('sales of A is refused',          'e2469000-0000-4000-8000-0000000000a2', 'r2469-expired@example.test', 'ERR');
  perform pg_temp.r2469_expect('inactive owner of A is refused', 'e2469000-0000-4000-8000-0000000000a3', 'r2469-expired@example.test', 'ERR');
  if not exists (select 1 from public.team_invites where email = 'r2469-expired@example.test') then
    insert into r2469_fail(label, detail) values ('refused callers', 'a refused caller still deleted the invite'); end if;

  -- ── must stay ───────────────────────────────────────────────────────────
  perform pg_temp.r2469_expect('pending unexpired invite in a real company', a, 'r2469-pending-d@example.test', 'in_use');
  perform pg_temp.r2469_expect('empty workspace of SOMEONE ELSE',            a, 'r2469-fresh-c@example.test',   'in_use');
  perform pg_temp.r2469_expect('accepted invite, still a member of R',       a, 'r2469-staff-d@example.test',   'member_elsewhere');
  perform pg_temp.r2469_expect('solo workspace that holds records',          a, 'r2469-solo-e@example.test',    'member_elsewhere');
  -- the 4 Nov staging case: an active member of another real company, no invite left anywhere
  perform pg_temp.r2469_expect('member of a real company, no invite',        a, 'R2469-Owner-D@example.test',   'member_elsewhere');
  perform pg_temp.r2469_expect('A''s own invite',                           a, 'r2469-own-a@example.test',     'none');
  perform pg_temp.r2469_expect('no invite anywhere',                         a, 'r2469-nobody@example.test',    'none');
  if (select count(*) from public.team_invites where email in (
        'r2469-pending-d@example.test', 'r2469-fresh-c@example.test', 'r2469-staff-d@example.test',
        'r2469-solo-e@example.test', 'r2469-own-a@example.test')) <> 5 then
    insert into r2469_fail(label, detail) values ('must stay', 'an invite that must stay was deleted'); end if;

  -- ── may be cleared ──────────────────────────────────────────────────────
  perform pg_temp.r2469_expect('EXPIRED pending invite in a real company', a, 'r2469-expired@example.test', 'released');
  perform pg_temp.r2469_expect('accepted invite, person has left R',       a, 'r2469-left-d@example.test',  'released');
  perform pg_temp.r2469_expect('blank workspace whose only member is the invitee (Pratik)', a, '  R2469-Pratik@Example.test ', 'released');
  if exists (select 1 from public.team_invites where email in (
        'r2469-expired@example.test', 'r2469-left-d@example.test', 'r2469-pratik@example.test')) then
    insert into r2469_fail(label, detail) values ('may be cleared', 'invite still there after released'); end if;

  -- ── audit: in A, never names the other workspace ────────────────────────
  if (select count(*) from public.activity_log where tenant_id = ta and action = 'stale_invite_released') <> 3 then
    insert into r2469_fail(label, detail) values ('audit', 'expected 3 stale_invite_released rows in A, got '
      || (select count(*) from public.activity_log where tenant_id = ta and action = 'stale_invite_released')); end if;
  if exists (select 1 from public.activity_log where tenant_id = ta and action = 'stale_invite_released'
              and (label ilike '%Secret Real%' or label ilike '%Blank%' or label ilike '%e2469000-0000-0000%'
                   or label ~ '[(](expired|already used|empty workspace)[)]')) then
    insert into r2469_fail(label, detail) values ('audit', 'A''s audit row names the other workspace or its state'); end if;
  -- the workspace that lost the invite sees why, without being told who
  if (select count(*) from public.activity_log
       where tenant_id = 'e2469000-0000-0000-0000-0000000000d0' and action = 'stale_invite_released') <> 2 then
    insert into r2469_fail(label, detail) values ('audit', 'workspace D did not get its 2 lines'); end if;
  if exists (select 1 from public.activity_log where tenant_id <> ta and action = 'stale_invite_released'
              and label ilike '%Excel%') then
    insert into r2469_fail(label, detail) values ('audit', 'the other workspace''s line names the caller'); end if;

  -- ── end to end: invite → sign in → claim ────────────────────────────────
  update auth.users set last_sign_in_at = now() where id = 'e2469000-0000-4000-8000-0000000000b1';
  begin
    insert into public.team_invites (tenant_id, email, role, invited_by, created_at)
    values (ta, 'r2469-pratik@example.test', 'sales', a::uuid, now() - interval '1 minute');
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', a), true);
    v := public.merge_stranded_user_into_tenant('r2469-pratik@example.test', ta, 'sales');
  exception when others then
    msg := sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  if msg is not null then
    insert into r2469_fail(label, detail) values ('end to end claim', 'claim refused: ' || msg);
  else
    if (select tenant_id from public.users where id = 'e2469000-0000-4000-8000-0000000000b1') is distinct from ta then
      insert into r2469_fail(label, detail) values ('end to end claim', 'Pratik is not in A'); end if;
    if exists (select 1 from public.tenants where id = 'e2469000-0000-0000-0000-0000000000b0') then
      insert into r2469_fail(label, detail) values ('end to end claim', 'blank workspace was not removed'); end if;
  end if;
end $$;

do $$
declare v text;
begin
  if exists (select 1 from r2469_fail) then
    select string_agg(format('  FAIL %s: %s', label, detail), E'\n' order by n) into v from r2469_fail;
    raise exception E'r2469_replace_stale_invite — % failure(s):\n%', (select count(*) from r2469_fail), v;
  end if;
  raise notice 'PASS r2469_replace_stale_invite';
end $$;

rollback;
