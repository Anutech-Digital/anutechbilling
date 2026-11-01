-- R-2333 (G-TEAMCHAT, 1 Nov 2026) — team chat: rate-limit edits, to-task / report and new channels.
-- Found by the R-2305 audit (#9): the 30-a-minute limit counted posts only (chat_post_message);
-- edits within 15 minutes were unlimited (each adds a chat_message_edits row of up to 4,000
-- characters), and chat_message_to_task / chat_message_report / chat_create_channel had no limit.
-- Migration: the R-2333 migration (same advisory-lock + count-the-last-minute approach as the
-- post limit, per user).
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   1. Sales edits own message 20 times in a minute: all pass. The 21st edit is refused
--      "Too many edits — wait a minute and try again" (P0001); still 20 edit-history rows.
--      An edit that changes nothing is not refused (nothing is written).
--   2. Per user: the Manager (no edits yet) edits own message twice — fine (ordinary use).
--   3. After the minute passes (edit rows moved 2 minutes back) Sales can edit again.
--   4. Make a task + Report together: 10 in a minute pass, the 11th is refused
--      "Too many tasks and reports from chat — wait a minute and try again" (P0001).
--      Asking again for a post that already has its task returns that task (not refused).
--      The app notices those calls wrote (author_id NULL) do not count as Sales's posts.
--   5. New channels: 5 in a minute pass, the 6th is refused "Too many new channels — wait a
--      minute and try again" (P0001). Refused attempts (bad name) do not use the allowance:
--      the Manager, after 6 refused tries, still creates 5. After the minute, the owner can
--      create again.
--
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_rate_limits.test.sql

begin;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2333000-0000-0000-0000-0000000000a1', 'r2333-owner@example.test'),
  ('c2333000-0000-0000-0000-0000000000a2', 'r2333-manager@example.test'),
  ('c2333000-0000-0000-0000-0000000000a3', 'r2333-sales@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2333000-0000-0000-0000-0000000000f1', 'R2333 A', 'r2333-a@example.test', '07', 'RTRL');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2333000-0000-0000-0000-0000000000a1', 'c2333000-0000-0000-0000-0000000000f1', 'r2333-owner@example.test',   'Owner',   'owner',   true),
  ('c2333000-0000-0000-0000-0000000000a2', 'c2333000-0000-0000-0000-0000000000f1', 'r2333-manager@example.test', 'Manager', 'manager', true),
  ('c2333000-0000-0000-0000-0000000000a3', 'c2333000-0000-0000-0000-0000000000f1', 'r2333-sales@example.test',   'Sales',   'sales',   true);

-- #general made by the owner an hour ago (outside the minute)
insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, created_by, created_at) values
  ('c2333000-0000-0000-0000-0000000000c1', 'c2333000-0000-0000-0000-0000000000f1', 'channel', 'general', 'general', false, 'c2333000-0000-0000-0000-0000000000a1', now() - interval '1 hour');
insert into public.chat_members (tenant_id, channel_id, user_id, member_role) values
  ('c2333000-0000-0000-0000-0000000000f1', 'c2333000-0000-0000-0000-0000000000c1', 'c2333000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2333000-0000-0000-0000-0000000000f1', 'c2333000-0000-0000-0000-0000000000c1', 'c2333000-0000-0000-0000-0000000000a2', 'member'),
  ('c2333000-0000-0000-0000-0000000000f1', 'c2333000-0000-0000-0000-0000000000c1', 'c2333000-0000-0000-0000-0000000000a3', 'member');

create temp table r2333_ids (k text primary key, v uuid);
grant all on r2333_ids to authenticated;

set local role authenticated;

create or replace function pg_temp.r2333_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.r2333_refused(p_case text, p_sql text, p_state text, p_like text)
returns void language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_state or v_msg not ilike p_like then
      raise exception 'FAIL %: % refused with % "%" — expected % "%"', p_case, p_sql, v_state, v_msg, p_state, p_like;
    end if;
    return;
  end;
  raise exception 'FAIL %: % was NOT refused (expected % "%")', p_case, p_sql, p_state, p_like;
end $$;

-- ── 1. 20 edits pass, the 21st is refused ───────────────────────────────────────────
do $$
declare
  v_m uuid;
  v_n int;
begin
  perform pg_temp.r2333_as('c2333000-0000-0000-0000-0000000000a3');
  v_m := public.chat_post_message('c2333000-0000-0000-0000-0000000000c1', 'draft 0');
  insert into r2333_ids values ('m1', v_m);
  for i in 1..20 loop
    perform public.chat_edit_message(v_m, 'draft ' || i);
  end loop;
  perform pg_temp.r2333_refused('1', format('select public.chat_edit_message(%L, %L)', v_m, 'draft 21'),
    'P0001', 'Too many edits — wait a minute and try again');
  -- an edit that changes nothing writes nothing and is not refused
  perform public.chat_edit_message(v_m, 'draft 20');
  if (select body from public.chat_messages where id = v_m) <> 'draft 20' then
    raise exception 'FAIL 1: the refused edit changed the message';
  end if;
end $$;

reset role;
do $$
begin
  if (select count(*) from public.chat_message_edits
       where message_id = (select v from r2333_ids where k = 'm1')) <> 20 then
    raise exception 'FAIL 1: expected 20 edit-history rows';
  end if;
end $$;
set local role authenticated;

-- ── 2. per user: the Manager's ordinary edits are untouched ─────────────────────────
do $$
declare
  v_m uuid;
begin
  perform pg_temp.r2333_as('c2333000-0000-0000-0000-0000000000a2');
  v_m := public.chat_post_message('c2333000-0000-0000-0000-0000000000c1', 'meeting at 3');
  perform public.chat_edit_message(v_m, 'meeting at 4');
  perform public.chat_edit_message(v_m, 'meeting at 4:30');
end $$;

-- ── 3. after the minute, Sales can edit again ───────────────────────────────────────
reset role;
update public.chat_message_edits set edited_at = edited_at - interval '2 minutes'
 where tenant_id = 'c2333000-0000-0000-0000-0000000000f1';
set local role authenticated;
do $$
begin
  perform pg_temp.r2333_as('c2333000-0000-0000-0000-0000000000a3');
  perform public.chat_edit_message((select v from r2333_ids where k = 'm1'), 'final text');
end $$;

-- ── 4. Make a task + Report: 10 a minute together ───────────────────────────────────
do $$
declare
  v_p    uuid[] := '{}';
  v_t    uuid;
  v_t2   uuid;
begin
  perform pg_temp.r2333_as('c2333000-0000-0000-0000-0000000000a3');
  for i in 1..11 loop
    v_p := v_p || public.chat_post_message('c2333000-0000-0000-0000-0000000000c1',
                    'Problem ' || i, (case when i % 2 = 0 then 'suggestion' else 'problem' end));
  end loop;
  for i in 1..6 loop
    v_t := public.chat_message_to_task(v_p[i]);
  end loop;
  for i in 7..10 loop
    perform public.chat_message_report(v_p[i]);
  end loop;
  perform pg_temp.r2333_refused('4', format('select public.chat_message_report(%L)', v_p[11]),
    'P0001', 'Too many tasks and reports from chat — wait a minute and try again');
  perform pg_temp.r2333_refused('4', format('select public.chat_message_to_task(%L)', v_p[11]),
    'P0001', 'Too many tasks and reports from chat — wait a minute and try again');
  -- the post that already has its task: same task back, not refused
  v_t2 := public.chat_message_to_task(v_p[6]);
  if v_t2 is distinct from v_t then
    raise exception 'FAIL 4: asking again should return the same task';
  end if;
  -- 10 app notices (author NULL) + 12 own posts: Sales can still post
  perform public.chat_post_message('c2333000-0000-0000-0000-0000000000c1', 'still here');
end $$;

reset role;
do $$
begin
  if (select count(*) from public.chat_messages
       where tenant_id = 'c2333000-0000-0000-0000-0000000000f1' and kind = 'system' and author_id is null) <> 10 then
    raise exception 'FAIL 4: expected 10 app notices';
  end if;
end $$;
set local role authenticated;

-- ── 5. new channels: 5 a minute ─────────────────────────────────────────────────────
do $$
begin
  perform pg_temp.r2333_as('c2333000-0000-0000-0000-0000000000a1');
  for i in 1..5 loop
    perform public.chat_create_channel('owner room ' || i);
  end loop;
  perform pg_temp.r2333_refused('5', 'select public.chat_create_channel(''owner room 6'')',
    'P0001', 'Too many new channels — wait a minute and try again');

  -- refused tries (no name / duplicate) do not use the Manager's allowance
  perform pg_temp.r2333_as('c2333000-0000-0000-0000-0000000000a2');
  for i in 1..3 loop
    perform pg_temp.r2333_refused('5', 'select public.chat_create_channel(''!!!'')', '22023', 'Give the channel a name%');
    perform pg_temp.r2333_refused('5', 'select public.chat_create_channel(''owner room 1'')', '23505', 'A channel with this name already exists');
  end loop;
  for i in 1..5 loop
    perform public.chat_create_channel('manager room ' || i);
  end loop;
end $$;

reset role;
update public.chat_channels set created_at = created_at - interval '2 minutes'
 where tenant_id = 'c2333000-0000-0000-0000-0000000000f1';
set local role authenticated;
do $$
begin
  perform pg_temp.r2333_as('c2333000-0000-0000-0000-0000000000a1');
  perform public.chat_create_channel('owner room 6');
end $$;

do $$ begin raise notice 'team_chat_rate_limits: all checks passed'; end $$;

rollback;
