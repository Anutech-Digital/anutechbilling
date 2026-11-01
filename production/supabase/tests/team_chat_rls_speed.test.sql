-- R-2330 (G-TEAMCHAT, 1 Nov 2026) — team chat reads check the readable channels ONCE per query.
-- Found by the R-2305 audit (local, 10,000 messages): chat_can_read(channel_id) ran per row in the
-- chat RLS policies (~1.6 ms a row: a 50-message page 84.6 ms, a 200-reply thread ~320 ms), and
-- an older page filtered 5,001 rows because the cursor was not index-assisted.
-- Also (R-2331 side effect): an app notice (kind 'system', author_id NULL) counted as unread.
-- Migration: the R-2330 migration (chat_my_readable_channel_ids(), new policies, indexes,
-- chat_unread_counts skips system rows).
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   0. Shape: chat_my_readable_channel_ids() STABLE SECURITY DEFINER search_path '' returning
--      uuid[], no anon execute; the read policies of chat_channels / chat_members /
--      chat_messages / chat_attachments use it and no longer call chat_can_read per row;
--      the page index (channel_id, created_at desc, id desc) where parent_id is null and the
--      thread index (parent_id, created_at, id) where parent_id is not null exist.
--   1. SAME VISIBILITY: for every login of the fixture (owner, manager, members, a non-member,
--      partner_agent, personal, deactivated, other tenant, unknown login, no login) and every
--      channel of both tenants, "channel in chat_my_readable_channel_ids()" equals
--      chat_can_read(channel) — the per-row rule it replaces.
--   2. Plans: as a signed-in member, the newest page and an older page (cursor
--      created_at <= t and (created_at < t or (created_at = t and id < x)), what the hook sends)
--      run on chat_messages_channel_top_idx with the readable set as an InitPlan — no
--      chat_can_read in the plan — and the older page needs no rows filtered beyond ties; a
--      thread runs on chat_messages_thread_idx.
--   3. The pages return the right rows: newest 50 = the 50 newest top-level messages; the older
--      page = the next 50 (no gap, no repeat), with a tie on created_at broken by id.
--   4. Unread: a system notice (author NULL) after the read mark is NOT unread; a teammate's
--      text message is (1), and a mention counts.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_rls_speed.test.sql

begin;

-- ── 0. shape ────────────────────────────────────────────────────────────────────────
do $$
declare
  v_p record;
  v_t text;
  v_q text;
begin
  if to_regprocedure('public.chat_my_readable_channel_ids()') is null then
    raise exception 'FAIL 0: public.chat_my_readable_channel_ids() does not exist — migration not applied';
  end if;
  select p.provolatile, p.prosecdef, p.proconfig, p.prorettype::regtype::text as rt into v_p
    from pg_proc p where p.oid = 'public.chat_my_readable_channel_ids()'::regprocedure;
  if v_p.provolatile <> 's' or not v_p.prosecdef or not ('search_path=""' = any (v_p.proconfig)) or v_p.rt <> 'uuid[]' then
    raise exception 'FAIL 0: chat_my_readable_channel_ids must be STABLE SECURITY DEFINER search_path '''' returning uuid[] (got %, %, %, %)',
      v_p.provolatile, v_p.prosecdef, v_p.proconfig, v_p.rt;
  end if;
  if has_function_privilege('anon', 'public.chat_my_readable_channel_ids()', 'EXECUTE') then
    raise exception 'FAIL 0: anon may execute chat_my_readable_channel_ids()';
  end if;
  foreach v_t in array array['chat_channels', 'chat_members', 'chat_messages', 'chat_attachments'] loop
    select qual into v_q from pg_policies
     where schemaname = 'public' and tablename = v_t and policyname = v_t || '_read';
    if v_q is null then raise exception 'FAIL 0: % has no %_read policy', v_t, v_t; end if;
    if v_q not like '%( SELECT chat_my_readable_channel_ids()%' then
      raise exception 'FAIL 0: %_read does not use the once-per-query readable set: %', v_t, v_q;
    end if;
    if v_q like '%chat_can_read(%' then
      raise exception 'FAIL 0: %_read still calls chat_can_read per row: %', v_t, v_q;
    end if;
    if v_q not like '%tenant_id = ( SELECT current_tenant_id()%' then
      raise exception 'FAIL 0: %_read lost its tenant check: %', v_t, v_q;
    end if;
  end loop;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'chat_messages_channel_top_idx'
                   and indexdef like '%(channel_id, created_at DESC, id DESC) WHERE (parent_id IS NULL)%') then
    raise exception 'FAIL 0: page index chat_messages_channel_top_idx (channel_id, created_at desc, id desc) where parent_id is null is missing';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'chat_messages_thread_idx'
                   and indexdef like '%(parent_id, created_at, id) WHERE (parent_id IS NOT NULL)%') then
    raise exception 'FAIL 0: thread index chat_messages_thread_idx (parent_id, created_at, id) where parent_id is not null is missing';
  end if;
end $$;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2330000-0000-0000-0000-0000000000a1', 'r2330-owner@example.test'),
  ('c2330000-0000-0000-0000-0000000000a2', 'r2330-acct@example.test'),
  ('c2330000-0000-0000-0000-0000000000a3', 'r2330-sales@example.test'),
  ('c2330000-0000-0000-0000-0000000000a4', 'r2330-partner@example.test'),
  ('c2330000-0000-0000-0000-0000000000a5', 'r2330-personal@example.test'),
  ('c2330000-0000-0000-0000-0000000000a6', 'r2330-gone@example.test'),
  ('c2330000-0000-0000-0000-0000000000a7', 'r2330-manager@example.test'),
  ('c2330000-0000-0000-0000-0000000000b1', 'r2330-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2330000-0000-0000-0000-0000000000f1', 'R2330 A', 'r2330-a@example.test', '07', 'RSPA'),
  ('c2330000-0000-0000-0000-0000000000f2', 'R2330 B', 'r2330-b@example.test', '07', 'RSPB');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2330000-0000-0000-0000-0000000000a1', 'c2330000-0000-0000-0000-0000000000f1', 'r2330-owner@example.test',    'Owner A',    'owner',         true),
  ('c2330000-0000-0000-0000-0000000000a2', 'c2330000-0000-0000-0000-0000000000f1', 'r2330-acct@example.test',     'Accountant', 'accountant',    true),
  ('c2330000-0000-0000-0000-0000000000a3', 'c2330000-0000-0000-0000-0000000000f1', 'r2330-sales@example.test',    'Sales',      'sales',         true),
  ('c2330000-0000-0000-0000-0000000000a4', 'c2330000-0000-0000-0000-0000000000f1', 'r2330-partner@example.test',  'Partner',    'partner_agent', true),
  ('c2330000-0000-0000-0000-0000000000a5', 'c2330000-0000-0000-0000-0000000000f1', 'r2330-personal@example.test', 'Personal',   'personal',      true),
  ('c2330000-0000-0000-0000-0000000000a6', 'c2330000-0000-0000-0000-0000000000f1', 'r2330-gone@example.test',     'Gone',       'sales',         false),
  ('c2330000-0000-0000-0000-0000000000a7', 'c2330000-0000-0000-0000-0000000000f1', 'r2330-manager@example.test',  'Manager',    'manager',       true),
  ('c2330000-0000-0000-0000-0000000000b1', 'c2330000-0000-0000-0000-0000000000f2', 'r2330-owner-b@example.test',  'Owner B',    'owner',         true);

-- A: #general (public), #accounts (private: owner + accountant), #archive (public, archived),
--    DM accountant<->sales, DM owner<->accountant; B: #general (public), #hr (private: owner B)
insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, dm_key, created_by, archived_at) values
  ('c2330000-0000-0000-0000-0000000000c1', 'c2330000-0000-0000-0000-0000000000f1', 'channel', 'general',  'general',  false, null, 'c2330000-0000-0000-0000-0000000000a1', null),
  ('c2330000-0000-0000-0000-0000000000c2', 'c2330000-0000-0000-0000-0000000000f1', 'channel', 'accounts', 'accounts', true,  null, 'c2330000-0000-0000-0000-0000000000a1', null),
  ('c2330000-0000-0000-0000-0000000000c5', 'c2330000-0000-0000-0000-0000000000f1', 'channel', 'archive',  'archive',  false, null, 'c2330000-0000-0000-0000-0000000000a1', now()),
  ('c2330000-0000-0000-0000-0000000000c3', 'c2330000-0000-0000-0000-0000000000f1', 'dm',      null,       null,       true,
     'c2330000-0000-0000-0000-0000000000a2:c2330000-0000-0000-0000-0000000000a3', 'c2330000-0000-0000-0000-0000000000a2', null),
  ('c2330000-0000-0000-0000-0000000000c4', 'c2330000-0000-0000-0000-0000000000f1', 'dm',      null,       null,       true,
     'c2330000-0000-0000-0000-0000000000a1:c2330000-0000-0000-0000-0000000000a2', 'c2330000-0000-0000-0000-0000000000a1', null),
  ('c2330000-0000-0000-0000-0000000000c9', 'c2330000-0000-0000-0000-0000000000f2', 'channel', 'general',  'general',  false, null, 'c2330000-0000-0000-0000-0000000000b1', null),
  ('c2330000-0000-0000-0000-0000000000ca', 'c2330000-0000-0000-0000-0000000000f2', 'channel', 'hr',       'hr',       true,  null, 'c2330000-0000-0000-0000-0000000000b1', null);

insert into public.chat_members (tenant_id, channel_id, user_id, member_role, last_read_at) values
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c1', 'c2330000-0000-0000-0000-0000000000a1', 'admin',  null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c1', 'c2330000-0000-0000-0000-0000000000a2', 'member', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c1', 'c2330000-0000-0000-0000-0000000000a3', 'member', now() - interval '1 hour'),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c2', 'c2330000-0000-0000-0000-0000000000a1', 'admin',  null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c2', 'c2330000-0000-0000-0000-0000000000a2', 'member', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c3', 'c2330000-0000-0000-0000-0000000000a2', 'member', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c3', 'c2330000-0000-0000-0000-0000000000a3', 'member', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c4', 'c2330000-0000-0000-0000-0000000000a1', 'member', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c4', 'c2330000-0000-0000-0000-0000000000a2', 'member', null),
  -- bad data on purpose: outsiders with a member row must still read nothing
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c3', 'c2330000-0000-0000-0000-0000000000a4', 'member', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c3', 'c2330000-0000-0000-0000-0000000000a5', 'member', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c3', 'c2330000-0000-0000-0000-0000000000a6', 'member', null),
  ('c2330000-0000-0000-0000-0000000000f2', 'c2330000-0000-0000-0000-0000000000c9', 'c2330000-0000-0000-0000-0000000000b1', 'admin',  null),
  ('c2330000-0000-0000-0000-0000000000f2', 'c2330000-0000-0000-0000-0000000000ca', 'c2330000-0000-0000-0000-0000000000b1', 'admin',  null);

-- #general: 120 top-level messages, one a minute ending 2 hours ago (older than Sales' read
-- mark), messages 60 and 61 share one created_at (tie broken by id), plus 3 replies to the newest.
insert into public.chat_messages (id, tenant_id, channel_id, author_id, body, created_at)
select ('c2330000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid,
       'c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c1',
       'c2330000-0000-0000-0000-0000000000a1', 'm' || g,
       now() - interval '2 hours' - (120 - case when g = 61 then 60 else g end) * interval '1 minute'
  from generate_series(1, 120) g;
insert into public.chat_messages (tenant_id, channel_id, author_id, parent_id, body, created_at)
select 'c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c1',
       'c2330000-0000-0000-0000-0000000000a2', 'c2330000-0000-0000-0001-000000000120', 'reply ' || g,
       now() - interval '90 minutes' + g * interval '1 second'
  from generate_series(1, 3) g;
analyze public.chat_messages;

-- every channel of both tenants (captured before RLS applies)
create temp table r2330_channels on commit drop as select id from public.chat_channels
 where tenant_id in ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000f2');
grant select on r2330_channels to authenticated;

set local role authenticated;

create or replace function pg_temp.r2330_as(p_user uuid) returns void language plpgsql as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  end if;
end $$;

-- the plan text of a query
create or replace function pg_temp.r2330_plan(p_sql text) returns text language plpgsql as $$
declare
  v_line text;
  v_out  text := '';
begin
  for v_line in execute 'explain (costs off) ' || p_sql loop
    v_out := v_out || v_line || E'\n';
  end loop;
  return v_out;
end $$;

-- ── 1. same visibility as chat_can_read, every login × every channel ────────────────
do $$
declare
  v_who  uuid;
  v_ch   uuid;
  v_set  uuid[];
  v_old  boolean;
  v_n    int := 0;
begin
  foreach v_who in array array[
      'c2330000-0000-0000-0000-0000000000a1', 'c2330000-0000-0000-0000-0000000000a2',
      'c2330000-0000-0000-0000-0000000000a3', 'c2330000-0000-0000-0000-0000000000a4',
      'c2330000-0000-0000-0000-0000000000a5', 'c2330000-0000-0000-0000-0000000000a6',
      'c2330000-0000-0000-0000-0000000000a7', 'c2330000-0000-0000-0000-0000000000b1',
      'c2330000-0000-0000-0000-0000000000ee', null]::uuid[] loop
    perform pg_temp.r2330_as(v_who);
    v_set := public.chat_my_readable_channel_ids();
    if v_set is null then raise exception 'FAIL 1: readable set is NULL for % (must be an array, empty when none)', v_who; end if;
    for v_ch in select id from r2330_channels loop
      v_old := public.chat_can_read(v_ch);
      if (v_ch = any (v_set)) is distinct from v_old then
        raise exception 'FAIL 1: login % channel %: readable set says %, chat_can_read says %',
          v_who, v_ch, v_ch = any (v_set), v_old;
      end if;
      v_n := v_n + 1;
    end loop;
  end loop;
  if v_n <> 70 then raise exception 'FAIL 1 (setup): compared % login×channel pairs, expected 70', v_n; end if;

  -- spot checks of the decisions themselves (so a wrong chat_can_read cannot hide a wrong set)
  perform pg_temp.r2330_as('c2330000-0000-0000-0000-0000000000a1');  -- owner A
  v_set := public.chat_my_readable_channel_ids();
  if 'c2330000-0000-0000-0000-0000000000c3'::uuid = any (v_set) then
    raise exception 'FAIL 1: the owner reads the accountant<->sales DM';
  end if;
  if not ('c2330000-0000-0000-0000-0000000000c4'::uuid = any (v_set)) or not ('c2330000-0000-0000-0000-0000000000c2'::uuid = any (v_set)) then
    raise exception 'FAIL 1: the owner misses own DM or private #accounts: %', v_set;
  end if;
  perform pg_temp.r2330_as('c2330000-0000-0000-0000-0000000000a7');  -- manager, member of nothing
  v_set := public.chat_my_readable_channel_ids();
  if 'c2330000-0000-0000-0000-0000000000c2'::uuid = any (v_set) or 'c2330000-0000-0000-0000-0000000000c3'::uuid = any (v_set)
     or not ('c2330000-0000-0000-0000-0000000000c1'::uuid = any (v_set)) then
    raise exception 'FAIL 1: manager (non-member) set is wrong: %', v_set;
  end if;
  perform pg_temp.r2330_as('c2330000-0000-0000-0000-0000000000b1');  -- tenant B owner
  v_set := public.chat_my_readable_channel_ids();
  if exists (select 1 from unnest(v_set) x where x::text not like '%-0000000000c9' and x::text not like '%-0000000000ca') then
    raise exception 'FAIL 1: tenant B reads a tenant A channel: %', v_set;
  end if;
  foreach v_who in array array['c2330000-0000-0000-0000-0000000000a4', 'c2330000-0000-0000-0000-0000000000a5',
                               'c2330000-0000-0000-0000-0000000000a6', 'c2330000-0000-0000-0000-0000000000ee', null]::uuid[] loop
    perform pg_temp.r2330_as(v_who);
    if cardinality(public.chat_my_readable_channel_ids()) <> 0 then
      raise exception 'FAIL 1: partner/personal/inactive/no-tenant login % reads channels: %', v_who, public.chat_my_readable_channel_ids();
    end if;
  end loop;
end $$;

-- ── 2. plans: once per query, on the page / thread index ────────────────────────────
do $$
declare
  v_plan text;
  v_sql  text;
  v_t    timestamptz;
  v_id   uuid;
begin
  perform pg_temp.r2330_as('c2330000-0000-0000-0000-0000000000a3');  -- Sales, member of #general
  perform set_config('enable_seqscan', 'off', true);
  perform set_config('enable_bitmapscan', 'off', true);

  v_sql := $q$select * from public.chat_messages
                where channel_id = 'c2330000-0000-0000-0000-0000000000c1' and parent_id is null
                order by created_at desc, id desc limit 50$q$;
  v_plan := pg_temp.r2330_plan(v_sql);
  if v_plan like '%chat_can_read%' then raise exception 'FAIL 2: newest page still calls chat_can_read per row:%', E'\n' || v_plan; end if;
  if v_plan not like '%Index Scan using chat_messages_channel_top_idx%' or v_plan like '%Sort%' then
    raise exception 'FAIL 2: newest page is not read in index order from chat_messages_channel_top_idx:%', E'\n' || v_plan;
  end if;
  if v_plan not like '%InitPlan%' then raise exception 'FAIL 2: newest page has no InitPlan for the readable set:%', E'\n' || v_plan; end if;

  select created_at, id into v_t, v_id from public.chat_messages
   where channel_id = 'c2330000-0000-0000-0000-0000000000c1' and parent_id is null
   order by created_at desc, id desc offset 49 limit 1;
  v_sql := format($q$select * from public.chat_messages
                where channel_id = 'c2330000-0000-0000-0000-0000000000c1' and parent_id is null
                  and created_at <= %1$L and (created_at < %1$L or (created_at = %1$L and id < %2$L))
                order by created_at desc, id desc limit 50$q$, v_t, v_id);
  v_plan := pg_temp.r2330_plan(v_sql);
  if v_plan like '%chat_can_read%' or v_plan not like '%Index Scan using chat_messages_channel_top_idx%'
     or v_plan not like '%Index Cond:%created_at <=%' or v_plan like '%Sort%' then
    raise exception 'FAIL 2: older page does not range-scan chat_messages_channel_top_idx on created_at:%', E'\n' || v_plan;
  end if;

  v_plan := pg_temp.r2330_plan($q$select * from public.chat_messages
                where parent_id = 'c2330000-0000-0000-0001-000000000120' order by created_at, id limit 200$q$);
  if v_plan like '%chat_can_read%' or v_plan not like '%Index Scan using chat_messages_thread_idx%' or v_plan like '%Sort%' then
    raise exception 'FAIL 2: thread is not read in order from chat_messages_thread_idx:%', E'\n' || v_plan;
  end if;

  v_plan := pg_temp.r2330_plan($q$select * from public.chat_attachments where channel_id = 'c2330000-0000-0000-0000-0000000000c1'$q$)
         || pg_temp.r2330_plan($q$select * from public.chat_members where channel_id = 'c2330000-0000-0000-0000-0000000000c1'$q$)
         || pg_temp.r2330_plan($q$select * from public.chat_channels$q$);
  if v_plan like '%chat_can_read%' then raise exception 'FAIL 2: attachments / members / channels still call chat_can_read per row:%', E'\n' || v_plan; end if;

  perform set_config('enable_seqscan', 'on', true);
  perform set_config('enable_bitmapscan', 'on', true);
end $$;

-- ── 3. the pages hold the right rows ────────────────────────────────────────────────
do $$
declare
  v_first text[];
  v_next  text[];
  v_t     timestamptz;
  v_id    uuid;
begin
  perform pg_temp.r2330_as('c2330000-0000-0000-0000-0000000000a3');
  select array_agg(body order by created_at desc, id desc) into v_first from (
    select body, created_at, id from public.chat_messages
     where channel_id = 'c2330000-0000-0000-0000-0000000000c1' and parent_id is null
     order by created_at desc, id desc limit 50) s;
  if v_first[1] <> 'm120' or v_first[50] <> 'm71' or cardinality(v_first) <> 50 then
    raise exception 'FAIL 3: newest page is wrong: % … % (%)', v_first[1], v_first[50], cardinality(v_first);
  end if;
  select created_at, id into v_t, v_id from public.chat_messages where body = 'm71'
     and channel_id = 'c2330000-0000-0000-0000-0000000000c1';
  select array_agg(body order by created_at desc, id desc) into v_next from (
    select body, created_at, id from public.chat_messages
     where channel_id = 'c2330000-0000-0000-0000-0000000000c1' and parent_id is null
       and created_at <= v_t and (created_at < v_t or (created_at = v_t and id < v_id))
     order by created_at desc, id desc limit 50) s;
  -- m61 and m60 share created_at; id desc puts m61 first
  if cardinality(v_next) <> 50 or v_next[1] <> 'm70' or v_next[10] <> 'm61' or v_next[11] <> 'm60' or v_next[50] <> 'm21' then
    raise exception 'FAIL 3: older page is wrong: %', v_next;
  end if;

  -- a non-member of the private channel and another tenant still read none of these
  perform pg_temp.r2330_as('c2330000-0000-0000-0000-0000000000b1');
  if exists (select 1 from public.chat_messages where channel_id = 'c2330000-0000-0000-0000-0000000000c1') then
    raise exception 'FAIL 3: tenant B reads tenant A #general messages';
  end if;
end $$;

-- ── 4. unread: app notices are not unread ───────────────────────────────────────────
reset role;
-- after Sales' read mark (1 hour ago): a system notice (author NULL, R-2331), one from Owner
-- that mentions Sales, one by Sales (own — never unread), one deleted
insert into public.chat_messages (tenant_id, channel_id, author_id, parent_id, body, kind, mentions, created_at, deleted_at) values
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c1', null,
   'c2330000-0000-0000-0001-000000000120', 'Made a task for Sales, due 02 Nov 2026', 'system', '{}', now() - interval '10 minutes', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c1', 'c2330000-0000-0000-0000-0000000000a1',
   null, 'please check', 'text', array['c2330000-0000-0000-0000-0000000000a3']::uuid[], now() - interval '9 minutes', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c1', 'c2330000-0000-0000-0000-0000000000a3',
   null, 'my own', 'text', '{}', now() - interval '8 minutes', null),
  ('c2330000-0000-0000-0000-0000000000f1', 'c2330000-0000-0000-0000-0000000000c1', 'c2330000-0000-0000-0000-0000000000a1',
   null, 'gone', 'text', '{}', now() - interval '7 minutes', now());
set local role authenticated;
do $$
declare
  v_unread int;
  v_ment   int;
begin
  perform pg_temp.r2330_as('c2330000-0000-0000-0000-0000000000a3');
  select unread, mentions into v_unread, v_ment from public.chat_unread_counts()
   where channel_id = 'c2330000-0000-0000-0000-0000000000c1';
  if v_unread is distinct from 1 or v_ment is distinct from 1 then
    raise exception 'FAIL 4: Sales #general unread=% mentions=% — expected 1 and 1 (the system notice must not count)', v_unread, v_ment;
  end if;
end $$;

do $$ begin raise notice 'team_chat_rls_speed: all checks passed'; end $$;

rollback;
