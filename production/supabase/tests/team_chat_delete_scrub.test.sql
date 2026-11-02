-- R-2331 (G-TEAMCHAT, 1 Nov 2026) — team chat delete/edit remove the old text everywhere.
-- Found by the R-2305 audit: after a member edited then deleted a message, the owner/manager still
-- read the original in chat_message_edits.old_body, and the @mention bell item kept its first
-- 140 characters.
-- Migration: the R-2331 migration (chat_delete_message / chat_edit_message scrub; edit history
-- readable by the author and the owner only; app notices written with author_id NULL).
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   1. Sales posts "@Accountant @Manager salary of Ravi is 50000" (2 chat.mention bell items with
--      that text), then edits it: the bell items now carry the NEW text (first 140 chars), never
--      the old one; 1 edit-history row.
--   2. Edit history is readable by the message's author (Sales) and the owner — NOT by the
--      manager, the accountant or anyone else.
--   3. Sales deletes it: in the same call its edit-history rows are gone and both bell items
--      (and a chat.dm item for it) read "Message deleted" — the rows stay (bell counts), no
--      notification anywhere still holds the old or new text. A notification of ANOTHER message
--      is untouched.
--   4. The owner deleting a teammate's message scrubs the same way.
--   5. R-2329 rules kept: a system row is still refused for edit and delete.
--   6. App notices written by "Make a task" / "Report as bug" have author_id NULL (R-2329
--      follow-up); the post itself still gets its task / report.
--
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_delete_scrub.test.sql

begin;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2331000-0000-0000-0000-0000000000a1', 'r2331-owner@example.test'),
  ('c2331000-0000-0000-0000-0000000000a2', 'r2331-manager@example.test'),
  ('c2331000-0000-0000-0000-0000000000a3', 'r2331-sales@example.test'),
  ('c2331000-0000-0000-0000-0000000000a4', 'r2331-acct@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2331000-0000-0000-0000-0000000000f1', 'R2331 A', 'r2331-a@example.test', '07', 'RTDS');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2331000-0000-0000-0000-0000000000a1', 'c2331000-0000-0000-0000-0000000000f1', 'r2331-owner@example.test',   'Owner',      'owner',      true),
  ('c2331000-0000-0000-0000-0000000000a2', 'c2331000-0000-0000-0000-0000000000f1', 'r2331-manager@example.test', 'Manager',    'manager',    true),
  ('c2331000-0000-0000-0000-0000000000a3', 'c2331000-0000-0000-0000-0000000000f1', 'r2331-sales@example.test',   'Sales',      'sales',      true),
  ('c2331000-0000-0000-0000-0000000000a4', 'c2331000-0000-0000-0000-0000000000f1', 'r2331-acct@example.test',    'Accountant', 'accountant', true);

insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, created_by) values
  ('c2331000-0000-0000-0000-0000000000c1', 'c2331000-0000-0000-0000-0000000000f1', 'channel', 'general', 'general', false, 'c2331000-0000-0000-0000-0000000000a1');
insert into public.chat_members (tenant_id, channel_id, user_id, member_role) values
  ('c2331000-0000-0000-0000-0000000000f1', 'c2331000-0000-0000-0000-0000000000c1', 'c2331000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2331000-0000-0000-0000-0000000000f1', 'c2331000-0000-0000-0000-0000000000c1', 'c2331000-0000-0000-0000-0000000000a2', 'member'),
  ('c2331000-0000-0000-0000-0000000000f1', 'c2331000-0000-0000-0000-0000000000c1', 'c2331000-0000-0000-0000-0000000000a3', 'member'),
  ('c2331000-0000-0000-0000-0000000000f1', 'c2331000-0000-0000-0000-0000000000c1', 'c2331000-0000-0000-0000-0000000000a4', 'member');

-- e1 a problem post by Sales (for case 6); e2 a system row (case 5)
insert into public.chat_messages (id, tenant_id, channel_id, author_id, parent_id, body, kind, post_status, created_at) values
  ('c2331000-0000-0000-0000-0000000000e1', 'c2331000-0000-0000-0000-0000000000f1', 'c2331000-0000-0000-0000-0000000000c1',
   'c2331000-0000-0000-0000-0000000000a3', null, 'Printer is broken', 'problem', 'open', now()),
  ('c2331000-0000-0000-0000-0000000000e2', 'c2331000-0000-0000-0000-0000000000f1', 'c2331000-0000-0000-0000-0000000000c1',
   null, 'c2331000-0000-0000-0000-0000000000e1', 'Reported as a bug', 'system', null, now());

create temp table r2331_ids (k text primary key, v uuid);
grant all on r2331_ids to authenticated;

set local role authenticated;

create or replace function pg_temp.r2331_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.r2331_refused(p_case text, p_sql text, p_state text, p_like text)
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

-- ── 1. post with 2 mentions, then edit ──────────────────────────────────────────────
do $$
declare
  v_m  uuid;
  v_m2 uuid;
begin
  perform pg_temp.r2331_as('c2331000-0000-0000-0000-0000000000a3');
  v_m := public.chat_post_message('c2331000-0000-0000-0000-0000000000c1',
    '@Accountant @Manager salary of Ravi is 50000', 'text', null,
    array['c2331000-0000-0000-0000-0000000000a4', 'c2331000-0000-0000-0000-0000000000a2']::uuid[]);
  insert into r2331_ids values ('m1', v_m);
  perform public.chat_edit_message(v_m, '@Accountant @Manager please check the payroll sheet');
  -- a second message by Sales mentioning the Accountant (must stay untouched by m1's delete)
  v_m2 := public.chat_post_message('c2331000-0000-0000-0000-0000000000c1',
    '@Accountant lunch at 1?', 'text', null,
    array['c2331000-0000-0000-0000-0000000000a4']::uuid[]);
  insert into r2331_ids values ('m2', v_m2);
  -- the Accountant's message mentioning Sales (case 4: the owner deletes it)
  perform pg_temp.r2331_as('c2331000-0000-0000-0000-0000000000a4');
  insert into r2331_ids values ('m3', public.chat_post_message('c2331000-0000-0000-0000-0000000000c1',
    '@Sales the GST total is 7777', 'text', null, array['c2331000-0000-0000-0000-0000000000a3']::uuid[]));
end $$;

reset role;
do $$
declare
  v_m uuid := (select v from r2331_ids where k = 'm1');
  v_n int;
begin
  select count(*) into v_n from public.notifications where entity_id = v_m::text and kind = 'chat.mention';
  if v_n <> 2 then raise exception 'FAIL 1 (setup): expected 2 mention bell items, got %', v_n; end if;
  if exists (select 1 from public.notifications where entity_id = v_m::text
              and coalesce(body, '') like '%50000%') then
    raise exception 'FAIL 1: after the edit a bell item still shows the OLD text';
  end if;
  if (select count(*) from public.notifications where entity_id = v_m::text
       and body = '@Accountant @Manager please check the payroll sheet') <> 2 then
    raise exception 'FAIL 1: after the edit the bell items should show the new text, got %',
      (select string_agg(coalesce(body, '<null>'), ' | ') from public.notifications where entity_id = v_m::text);
  end if;
  if (select count(*) from public.chat_message_edits where message_id = v_m) <> 1 then
    raise exception 'FAIL 1: expected 1 edit-history row';
  end if;
  -- a chat.dm bell item for the same message (the kind R-2303 reserves for a DM bell)
  insert into public.notifications (tenant_id, user_id, kind, title, body, href, entity_id)
  values ('c2331000-0000-0000-0000-0000000000f1', 'c2331000-0000-0000-0000-0000000000a1', 'chat.dm',
          'New message from Sales', 'salary of Ravi is 50000', '/team-chat', v_m::text);
end $$;
set local role authenticated;

-- ── 2. who reads the edit history ───────────────────────────────────────────────────
do $$
declare
  v_m uuid := (select v from r2331_ids where k = 'm1');
  v_n int;
begin
  perform pg_temp.r2331_as('c2331000-0000-0000-0000-0000000000a3');   -- author
  select count(*) into v_n from public.chat_message_edits where message_id = v_m;
  if v_n <> 1 then raise exception 'FAIL 2: the author should read own edit history, got % rows', v_n; end if;
  perform pg_temp.r2331_as('c2331000-0000-0000-0000-0000000000a1');   -- owner
  select count(*) into v_n from public.chat_message_edits where message_id = v_m;
  if v_n <> 1 then raise exception 'FAIL 2: the owner should read the edit history, got % rows', v_n; end if;
  perform pg_temp.r2331_as('c2331000-0000-0000-0000-0000000000a2');   -- manager
  select count(*) into v_n from public.chat_message_edits where message_id = v_m;
  if v_n <> 0 then raise exception 'FAIL 2: the MANAGER reads % edit-history row(s) of a teammate''s message', v_n; end if;
  perform pg_temp.r2331_as('c2331000-0000-0000-0000-0000000000a4');   -- accountant
  select count(*) into v_n from public.chat_message_edits where message_id = v_m;
  if v_n <> 0 then raise exception 'FAIL 2: the accountant reads % edit-history row(s)', v_n; end if;
end $$;

-- ── 3. the author deletes ───────────────────────────────────────────────────────────
do $$
begin
  perform pg_temp.r2331_as('c2331000-0000-0000-0000-0000000000a3');
  perform public.chat_delete_message((select v from r2331_ids where k = 'm1'));
end $$;

reset role;
do $$
declare
  v_m  uuid := (select v from r2331_ids where k = 'm1');
  v_m2 uuid := (select v from r2331_ids where k = 'm2');
begin
  if exists (select 1 from public.chat_message_edits where message_id = v_m) then
    raise exception 'FAIL 3: edit-history rows of a deleted message remain (old text readable)';
  end if;
  if (select count(*) from public.notifications where entity_id = v_m::text) <> 3 then
    raise exception 'FAIL 3: delete must keep the bell rows (expected 3), got %',
      (select count(*) from public.notifications where entity_id = v_m::text);
  end if;
  if exists (select 1 from public.notifications where entity_id = v_m::text
              and (body is distinct from 'Message deleted')) then
    raise exception 'FAIL 3: a bell item of the deleted message still reads %',
      (select string_agg(coalesce(body, '<null>'), ' | ') from public.notifications
        where entity_id = v_m::text and body is distinct from 'Message deleted');
  end if;
  if exists (select 1 from public.notifications
              where tenant_id = 'c2331000-0000-0000-0000-0000000000f1'
                and (coalesce(body, '') || coalesce(title, '')) ~ '(50000|payroll sheet)') then
    raise exception 'FAIL 3: a notification still holds the deleted message''s text';
  end if;
  if (select body from public.notifications where entity_id = v_m2::text) is distinct from '@Accountant lunch at 1?' then
    raise exception 'FAIL 3: another message''s bell item was changed';
  end if;
end $$;
set local role authenticated;

-- ── 4. the owner deletes a teammate's message  +  5. system rows still locked ──────
do $$
begin
  perform pg_temp.r2331_as('c2331000-0000-0000-0000-0000000000a1');
  perform public.chat_delete_message((select v from r2331_ids where k = 'm3'));
  perform pg_temp.r2331_refused('5 edit system row',
    format('select public.chat_edit_message(%L::uuid, %L)', 'c2331000-0000-0000-0000-0000000000e2', 'forged'),
    '42501', '%App notices cannot be edited%');
  perform pg_temp.r2331_refused('5 delete system row',
    format('select public.chat_delete_message(%L::uuid)', 'c2331000-0000-0000-0000-0000000000e2'),
    '42501', '%App notices cannot be deleted%');
end $$;

reset role;
do $$
declare
  v_m3 uuid := (select v from r2331_ids where k = 'm3');
begin
  if (select count(*) from public.notifications where entity_id = v_m3::text) <> 1
     or exists (select 1 from public.notifications where entity_id = v_m3::text and body is distinct from 'Message deleted') then
    raise exception 'FAIL 4: owner delete did not scrub the bell item: %',
      (select string_agg(coalesce(body, '<null>'), ' | ') from public.notifications where entity_id = v_m3::text);
  end if;
end $$;
set local role authenticated;

-- ── 6. app notices from "Make a task" / "Report as bug" have no author ──────────────
do $$
begin
  perform pg_temp.r2331_as('c2331000-0000-0000-0000-0000000000a3');
  insert into r2331_ids values ('task', public.chat_message_to_task('c2331000-0000-0000-0000-0000000000e1'));
  insert into r2331_ids values ('fb', public.chat_message_report('c2331000-0000-0000-0000-0000000000e1'));
end $$;

reset role;
do $$
declare
  v_n int;
begin
  if (select task_id from public.chat_messages where id = 'c2331000-0000-0000-0000-0000000000e1')
       is distinct from (select v from r2331_ids where k = 'task')
     or (select feedback_id from public.chat_messages where id = 'c2331000-0000-0000-0000-0000000000e1')
       is distinct from (select v from r2331_ids where k = 'fb') then
    raise exception 'FAIL 6: the post did not get its task / report';
  end if;
  select count(*) into v_n from public.chat_messages
   where parent_id = 'c2331000-0000-0000-0000-0000000000e1' and kind = 'system'
     and id <> 'c2331000-0000-0000-0000-0000000000e2';
  if v_n <> 2 then raise exception 'FAIL 6: expected 2 new app notices, got %', v_n; end if;
  if exists (select 1 from public.chat_messages
              where parent_id = 'c2331000-0000-0000-0000-0000000000e1' and kind = 'system'
                and author_id is not null) then
    raise exception 'FAIL 6: an app notice was written with the clicking member as author_id';
  end if;
end $$;

do $$ begin raise notice 'team_chat_delete_scrub: all checks passed'; end $$;

rollback;
