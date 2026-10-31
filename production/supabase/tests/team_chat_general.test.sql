-- R-2296 (G-TEAMCHAT TC-03, 31 Oct 2026) — #general for every company + auto-join staff.
-- Migration: 20261031131433_r2296_team_chat_general.sql (on top of R-2294 tables, R-2295 RPCs).
--
-- The users trigger is a DEFERRED constraint trigger (it runs at COMMIT), so the other team chat
-- tests — which insert users and then their own #general by hand, and end in ROLLBACK — never
-- see it. This file fires it on purpose with SET CONSTRAINTS ALL IMMEDIATE.
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   0. Shape: helpers + trigger function exist, SECURITY DEFINER, search_path ''; NOT executable
--      by authenticated / anon; the users trigger is deferrable, initially deferred.
--   1. A new company's first staff users → ONE public #general, active staff (owner = admin)
--      are members; partner_agent, personal-role and deactivated users are not.
--   2. A personal workspace gets no #general and its user joins nothing.
--   3. A teammate added later joins the same #general (still one channel).
--   4. Deactivated → member row removed AND chat_can_read false AND 0 messages visible;
--      reactivated → rejoins and sees the older message again.
--   5. Staff → partner_agent: removed; moved to another company: leaves the old #general,
--      joins the new one.
--   6. A channel already named general (made by the owner) is reused, never duplicated.
--   7. Backfill: adds #general + staff to a company the trigger did not reach, drops non-staff
--      members; the second run adds and removes nothing (idempotent).
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_general.test.sql

begin;

-- ── 0. shape ────────────────────────────────────────────────────────────────────────
do $$
declare
  v_sig text;
  v_p record;
  v_t record;
begin
  foreach v_sig in array array[
    'public.chat_general_ensure(uuid)',
    'public.chat_general_sync_user(uuid)',
    'public.chat_general_backfill()',
    'public.tg_users_chat_general()'] loop
    if to_regprocedure(v_sig) is null then
      raise exception 'FAIL 0: % does not exist — migration not applied', v_sig;
    end if;
    select p.prosecdef, p.proconfig into v_p from pg_proc p where p.oid = to_regprocedure(v_sig);
    if not v_p.prosecdef or not ('search_path=""' = any (v_p.proconfig)) then
      raise exception 'FAIL 0: % must be SECURITY DEFINER with search_path '''' (got %, %)',
        v_sig, v_p.prosecdef, v_p.proconfig;
    end if;
    if has_function_privilege('authenticated', v_sig, 'EXECUTE')
       or has_function_privilege('anon', v_sig, 'EXECUTE') then
      raise exception 'FAIL 0: % must not be callable by signed-in users or anon', v_sig;
    end if;
  end loop;

  select t.tgdeferrable, t.tginitdeferred into v_t
    from pg_trigger t
   where t.tgrelid = 'public.users'::regclass and t.tgname = 'trg_users_chat_general';
  if v_t is null or not v_t.tgdeferrable or not v_t.tginitdeferred then
    raise exception 'FAIL 0: trg_users_chat_general on users must exist, deferrable initially deferred';
  end if;
end $$;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2296000-0000-0000-0000-0000000000a1', 'tc03-owner@example.test'),
  ('c2296000-0000-0000-0000-0000000000a2', 'tc03-acct@example.test'),
  ('c2296000-0000-0000-0000-0000000000a3', 'tc03-sales@example.test'),
  ('c2296000-0000-0000-0000-0000000000a4', 'tc03-partner@example.test'),
  ('c2296000-0000-0000-0000-0000000000a5', 'tc03-personal@example.test'),
  ('c2296000-0000-0000-0000-0000000000a6', 'tc03-gone@example.test'),
  ('c2296000-0000-0000-0000-0000000000b1', 'tc03-owner-b@example.test'),
  ('c2296000-0000-0000-0000-0000000000d1', 'tc03-owner-d@example.test'),
  ('c2296000-0000-0000-0000-0000000000e1', 'tc03-owner-e@example.test'),
  ('c2296000-0000-0000-0000-0000000000e2', 'tc03-partner-e@example.test'),
  ('c2296000-0000-0000-0000-0000000000f9', 'tc03-me@example.test');

insert into public.tenants (id, name, email, state_code, doc_code, workspace_kind) values
  ('c2296000-0000-0000-0000-0000000000f1', 'TC03 A', 'tc03-a@example.test', '07', 'TC3A', 'business'),
  ('c2296000-0000-0000-0000-0000000000f2', 'TC03 B', 'tc03-b@example.test', '07', 'TC3B', 'business'),
  ('c2296000-0000-0000-0000-0000000000f3', 'TC03 P', 'tc03-p@example.test', '07', 'TC3P', 'personal'),
  ('c2296000-0000-0000-0000-0000000000f4', 'TC03 D', 'tc03-d@example.test', '07', 'TC3D', 'business'),
  ('c2296000-0000-0000-0000-0000000000f5', 'TC03 E', 'tc03-e@example.test', '07', 'TC3E', 'business');

-- ── 1. first users of company A ─────────────────────────────────────────────────────
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2296000-0000-0000-0000-0000000000a1', 'c2296000-0000-0000-0000-0000000000f1', 'tc03-owner@example.test',    'Owner',      'owner',         true),
  ('c2296000-0000-0000-0000-0000000000a2', 'c2296000-0000-0000-0000-0000000000f1', 'tc03-acct@example.test',     'Accountant', 'accountant',    true),
  ('c2296000-0000-0000-0000-0000000000a4', 'c2296000-0000-0000-0000-0000000000f1', 'tc03-partner@example.test',  'Partner',    'partner_agent', true),
  ('c2296000-0000-0000-0000-0000000000a5', 'c2296000-0000-0000-0000-0000000000f1', 'tc03-personal@example.test', 'Personal',   'personal',      true),
  ('c2296000-0000-0000-0000-0000000000a6', 'c2296000-0000-0000-0000-0000000000f1', 'tc03-gone@example.test',     'Gone',       'sales',         false),
  ('c2296000-0000-0000-0000-0000000000b1', 'c2296000-0000-0000-0000-0000000000f2', 'tc03-owner-b@example.test',  'Owner B',    'owner',         true),
  ('c2296000-0000-0000-0000-0000000000f9', 'c2296000-0000-0000-0000-0000000000f3', 'tc03-me@example.test',       'Me',         'owner',         true);

-- the trigger is deferred: nothing yet inside the transaction
do $$
begin
  if exists (select 1 from public.chat_channels where tenant_id = 'c2296000-0000-0000-0000-0000000000f1') then
    raise exception 'FAIL 1: #general appeared before commit — the trigger must be DEFERRED (other chat tests build their own #general)';
  end if;
end $$;

set constraints all immediate;
set constraints all deferred;


do $$
declare
  v_n int;
  v_ch record;
  v_m text;
begin
  select count(*) into v_n from public.chat_channels
   where tenant_id = 'c2296000-0000-0000-0000-0000000000f1' and kind = 'channel' and slug = 'general';
  if v_n <> 1 then raise exception 'FAIL 1: company A should have exactly one #general, has %', v_n; end if;

  select * into v_ch from public.chat_channels
   where tenant_id = 'c2296000-0000-0000-0000-0000000000f1' and slug = 'general';
  if v_ch.is_private or v_ch.name <> 'general' or v_ch.archived_at is not null then
    raise exception 'FAIL 1: #general must be public, named general, not archived (got private=%, name=%)',
      v_ch.is_private, v_ch.name;
  end if;
  if v_ch.created_by is distinct from 'c2296000-0000-0000-0000-0000000000a1'::uuid then
    raise exception 'FAIL 1: #general created_by should be the owner, got %', v_ch.created_by;
  end if;

  select string_agg(u.full_name || ':' || m.member_role, ',' order by u.full_name) into v_m
    from public.chat_members m join public.users u on u.id = m.user_id
   where m.channel_id = v_ch.id;
  if v_m is distinct from 'Accountant:member,Owner:admin' then
    raise exception 'FAIL 1: #general members should be Accountant:member,Owner:admin (no partner, personal, deactivated), got %', v_m;
  end if;

  select count(*) into v_n from public.chat_channels c
    join public.chat_members m on m.channel_id = c.id
   where c.tenant_id = 'c2296000-0000-0000-0000-0000000000f2' and c.slug = 'general'
     and m.user_id = 'c2296000-0000-0000-0000-0000000000b1';
  if v_n <> 1 then raise exception 'FAIL 1: company B owner should be in B''s own #general'; end if;

  -- ── 2. personal workspace ──
  select count(*) into v_n from public.chat_channels where tenant_id = 'c2296000-0000-0000-0000-0000000000f3';
  if v_n <> 0 then raise exception 'FAIL 2: a personal workspace got % chat channel(s)', v_n; end if;
  select count(*) into v_n from public.chat_members where user_id = 'c2296000-0000-0000-0000-0000000000f9';
  if v_n <> 0 then raise exception 'FAIL 2: a personal workspace user joined % channel(s)', v_n; end if;
end $$;

-- an older message in A's #general (seen again after reactivation in 4)
insert into public.chat_messages (tenant_id, channel_id, author_id, body)
select c.tenant_id, c.id, 'c2296000-0000-0000-0000-0000000000a1', 'Welcome team'
  from public.chat_channels c
 where c.tenant_id = 'c2296000-0000-0000-0000-0000000000f1' and c.slug = 'general';

-- ── 3. a teammate added later ───────────────────────────────────────────────────────
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2296000-0000-0000-0000-0000000000a3', 'c2296000-0000-0000-0000-0000000000f1', 'tc03-sales@example.test', 'Sales', 'sales', true);
set constraints all immediate;
set constraints all deferred;

do $$
declare
  v_n int;
begin
  select count(*) into v_n from public.chat_channels
   where tenant_id = 'c2296000-0000-0000-0000-0000000000f1' and kind = 'channel' and slug = 'general';
  if v_n <> 1 then raise exception 'FAIL 3: a new teammate made a second #general (% now)', v_n; end if;
  if not exists (select 1 from public.chat_members m join public.chat_channels c on c.id = m.channel_id
                  where c.tenant_id = 'c2296000-0000-0000-0000-0000000000f1' and c.slug = 'general'
                    and m.user_id = 'c2296000-0000-0000-0000-0000000000a3' and m.member_role = 'member') then
    raise exception 'FAIL 3: the new active sales teammate did not join #general';
  end if;
end $$;

-- ── 4. deactivate / reactivate ──────────────────────────────────────────────────────
create or replace function pg_temp.tc03_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.tc03_general(p_tenant uuid) returns uuid language sql as $$
  select c.id from public.chat_channels c where c.tenant_id = p_tenant and c.kind = 'channel' and c.slug = 'general';
$$;
create temp table tc03_ids (k text primary key, v uuid);
insert into tc03_ids values ('genA', pg_temp.tc03_general('c2296000-0000-0000-0000-0000000000f1'));
grant select on tc03_ids to authenticated;
grant execute on function pg_temp.tc03_as(uuid) to authenticated;

-- before: the accountant reads #general
set local role authenticated;
select pg_temp.tc03_as('c2296000-0000-0000-0000-0000000000a2');
do $$
declare v_n int;
begin
  if not public.chat_can_read((select v from tc03_ids where k = 'genA')) then
    raise exception 'FAIL 4 (setup): the active accountant cannot read #general';
  end if;
  select count(*) into v_n from public.chat_messages where channel_id = (select v from tc03_ids where k = 'genA');
  if v_n <> 1 then raise exception 'FAIL 4 (setup): the accountant sees % #general messages, expected 1', v_n; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

update public.users set is_active = false where id = 'c2296000-0000-0000-0000-0000000000a2';
set constraints all immediate;
set constraints all deferred;

do $$
begin
  if exists (select 1 from public.chat_members
              where channel_id = (select v from tc03_ids where k = 'genA')
                and user_id = 'c2296000-0000-0000-0000-0000000000a2') then
    raise exception 'FAIL 4: a deactivated user is still a #general member';
  end if;
end $$;

set local role authenticated;
select pg_temp.tc03_as('c2296000-0000-0000-0000-0000000000a2');
do $$
declare v_n int;
begin
  if public.chat_can_read((select v from tc03_ids where k = 'genA')) then
    raise exception 'FAIL 4: a deactivated user can still read #general';
  end if;
  select count(*) into v_n from public.chat_messages where channel_id = (select v from tc03_ids where k = 'genA');
  if v_n <> 0 then raise exception 'FAIL 4: a deactivated user still sees % #general message(s)', v_n; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

update public.users set is_active = true where id = 'c2296000-0000-0000-0000-0000000000a2';
set constraints all immediate;
set constraints all deferred;

set local role authenticated;
select pg_temp.tc03_as('c2296000-0000-0000-0000-0000000000a2');
do $$
declare v_n int;
begin
  if not public.is_chat_member((select v from tc03_ids where k = 'genA')) then
    raise exception 'FAIL 4: a reactivated user did not rejoin #general';
  end if;
  select count(*) into v_n from public.chat_messages where channel_id = (select v from tc03_ids where k = 'genA');
  if v_n <> 1 then raise exception 'FAIL 4: a reactivated user sees % older #general message(s), expected 1', v_n; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ── 5. role change + moved to another company ──────────────────────────────────────
update public.users set role = 'partner_agent' where id = 'c2296000-0000-0000-0000-0000000000a3';
update public.users set tenant_id = 'c2296000-0000-0000-0000-0000000000f2' where id = 'c2296000-0000-0000-0000-0000000000a2';
set constraints all immediate;
set constraints all deferred;

do $$
declare v_m text;
begin
  select string_agg(u.full_name, ',' order by u.full_name) into v_m
    from public.chat_members m join public.users u on u.id = m.user_id
   where m.channel_id = (select v from tc03_ids where k = 'genA');
  if v_m is distinct from 'Owner' then
    raise exception 'FAIL 5: A''s #general should keep only Owner (sales became partner_agent, accountant moved), got %', v_m;
  end if;
  if not exists (select 1 from public.chat_members
                  where channel_id = pg_temp.tc03_general('c2296000-0000-0000-0000-0000000000f2')
                    and user_id = 'c2296000-0000-0000-0000-0000000000a2'
                    and tenant_id = 'c2296000-0000-0000-0000-0000000000f2') then
    raise exception 'FAIL 5: the moved accountant did not join company B''s #general';
  end if;
end $$;

-- ── 6. a channel already named general is reused ───────────────────────────────────
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2296000-0000-0000-0000-0000000000d1', 'c2296000-0000-0000-0000-0000000000f4', 'tc03-owner-d@example.test', 'Owner D', 'owner', true);
insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, created_by) values
  ('c2296000-0000-0000-0000-0000000000c4', 'c2296000-0000-0000-0000-0000000000f4', 'channel', 'General', 'general', false,
   'c2296000-0000-0000-0000-0000000000d1');
set constraints all immediate;
set constraints all deferred;

do $$
declare v_n int;
begin
  select count(*) into v_n from public.chat_channels
   where tenant_id = 'c2296000-0000-0000-0000-0000000000f4' and kind = 'channel' and slug = 'general';
  if v_n <> 1 then raise exception 'FAIL 6: company D has % #general channels, expected the existing one only', v_n; end if;
  if not exists (select 1 from public.chat_members
                  where channel_id = 'c2296000-0000-0000-0000-0000000000c4'
                    and user_id = 'c2296000-0000-0000-0000-0000000000d1') then
    raise exception 'FAIL 6: company D owner did not join the existing #general';
  end if;
end $$;

-- ── 7. backfill ─────────────────────────────────────────────────────────────────────
-- company E: users whose trigger has not fired yet (still deferred) + a non-staff member row
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2296000-0000-0000-0000-0000000000e1', 'c2296000-0000-0000-0000-0000000000f5', 'tc03-owner-e@example.test',   'Owner E',   'owner',         true),
  ('c2296000-0000-0000-0000-0000000000e2', 'c2296000-0000-0000-0000-0000000000f5', 'tc03-partner-e@example.test', 'Partner E', 'partner_agent', true);
-- a stray partner member row in A's #general (e.g. added by hand before this card)
insert into public.chat_members (tenant_id, channel_id, user_id)
values ('c2296000-0000-0000-0000-0000000000f1', (select v from tc03_ids where k = 'genA'), 'c2296000-0000-0000-0000-0000000000a4');

do $$
declare
  r record;
  v_m text;
begin
  select * into r from public.chat_general_backfill();
  if r.channels_added < 1 or r.members_added < 1 or r.members_removed < 1 then
    raise exception 'FAIL 7: first backfill should add E''s #general + owner and drop A''s partner row, got %/%/%',
      r.channels_added, r.members_added, r.members_removed;
  end if;

  select string_agg(u.full_name, ',' order by u.full_name) into v_m
    from public.chat_members m join public.users u on u.id = m.user_id
   where m.channel_id = pg_temp.tc03_general('c2296000-0000-0000-0000-0000000000f5');
  if v_m is distinct from 'Owner E' then
    raise exception 'FAIL 7: company E #general after backfill should be Owner E only, got %', v_m;
  end if;
  if exists (select 1 from public.chat_members
              where channel_id = (select v from tc03_ids where k = 'genA')
                and user_id = 'c2296000-0000-0000-0000-0000000000a4') then
    raise exception 'FAIL 7: backfill left the partner_agent in A''s #general';
  end if;
  if exists (select 1 from public.chat_channels where tenant_id = 'c2296000-0000-0000-0000-0000000000f3') then
    raise exception 'FAIL 7: backfill gave the personal workspace a channel';
  end if;

  select * into r from public.chat_general_backfill();
  if r.channels_added <> 0 or r.members_added <> 0 or r.members_removed <> 0 then
    raise exception 'FAIL 7: second backfill must change nothing, got %/%/%',
      r.channels_added, r.members_added, r.members_removed;
  end if;
end $$;

-- the deferred trigger for company E fires now — still one #general, nothing new
set constraints all immediate;
do $$
declare v_n int;
begin
  select count(*) into v_n from public.chat_channels
   where tenant_id = 'c2296000-0000-0000-0000-0000000000f5' and kind = 'channel' and slug = 'general';
  if v_n <> 1 then raise exception 'FAIL 7: trigger after backfill made % #general channels for E', v_n; end if;
  select count(*) into v_n from public.chat_members where channel_id = pg_temp.tc03_general('c2296000-0000-0000-0000-0000000000f5');
  if v_n <> 1 then raise exception 'FAIL 7: company E #general has % members after the trigger, expected 1', v_n; end if;
end $$;

select 'R-2296 team_chat_general: ALL PASS' as result;

rollback;
