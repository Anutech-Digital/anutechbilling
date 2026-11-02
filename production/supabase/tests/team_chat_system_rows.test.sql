-- R-2329 (G-TEAMCHAT, 1 Nov 2026) — team chat SYSTEM notices cannot be edited or deleted by users.
-- Found by the R-2305 break-mode audit: chat_edit_message worked on kind='system' rows (the app's
-- own notices, e.g. "Made a task for Sales, due 02 Nov 2026" written by chat_message_to_task with
-- the caller as author_id). The screen shows system rows centred/italic with no author and no
-- "(edited)", so a member could turn one into a forged app notice ("Owner approved: pay vendor
-- 5 lakh today").
-- Migration: the R-2329 migration (chat_edit_message / chat_delete_message refuse kind='system').
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   1. A system row whose author_id is the member whose action created it (how R-2304 writes it
--      today): that member, the owner, a manager and another member can neither EDIT nor DELETE
--      it — refused 42501 "App notices cannot be edited" / "… cannot be deleted". The row's body,
--      edited_at, deleted_at stay; no chat_message_edits row; no activity_log row.
--   2. A system row with author_id NULL (how it should be written going forward): the owner can
--      neither edit nor delete it either.
--   3. Ordinary messages keep today's rules: the author edits within 15 min (body + edited_at +
--      1 edits row); another member cannot edit it ("own messages"); after 15 min the author
--      cannot ("15 minutes"); a manager cannot delete a teammate's message; the owner can.
--   4. Direct writes: authenticated has no UPDATE/DELETE on chat_messages (RLS + grants), so an
--      UPDATE or DELETE of a system row from the browser is refused (42501).
--
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_system_rows.test.sql

begin;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2329000-0000-0000-0000-0000000000a1', 'r2329-owner@example.test'),
  ('c2329000-0000-0000-0000-0000000000a2', 'r2329-manager@example.test'),
  ('c2329000-0000-0000-0000-0000000000a3', 'r2329-sales@example.test'),
  ('c2329000-0000-0000-0000-0000000000a4', 'r2329-acct@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2329000-0000-0000-0000-0000000000f1', 'R2329 A', 'r2329-a@example.test', '07', 'RTSA');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2329000-0000-0000-0000-0000000000a1', 'c2329000-0000-0000-0000-0000000000f1', 'r2329-owner@example.test',   'Owner',      'owner',      true),
  ('c2329000-0000-0000-0000-0000000000a2', 'c2329000-0000-0000-0000-0000000000f1', 'r2329-manager@example.test', 'Manager',    'manager',    true),
  ('c2329000-0000-0000-0000-0000000000a3', 'c2329000-0000-0000-0000-0000000000f1', 'r2329-sales@example.test',   'Sales',      'sales',      true),
  ('c2329000-0000-0000-0000-0000000000a4', 'c2329000-0000-0000-0000-0000000000f1', 'r2329-acct@example.test',    'Accountant', 'accountant', true);

insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, created_by) values
  ('c2329000-0000-0000-0000-0000000000c1', 'c2329000-0000-0000-0000-0000000000f1', 'channel', 'general', 'general', false, 'c2329000-0000-0000-0000-0000000000a1');
insert into public.chat_members (tenant_id, channel_id, user_id, member_role) values
  ('c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1', 'c2329000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1', 'c2329000-0000-0000-0000-0000000000a2', 'member'),
  ('c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1', 'c2329000-0000-0000-0000-0000000000a3', 'member'),
  ('c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1', 'c2329000-0000-0000-0000-0000000000a4', 'member');

-- e1 problem post by Sales; s1 its system reply written the R-2304 way (author = Sales, the
-- member whose "Make task" click wrote it); s2 a system row with no author; t1 Sales' plain text
-- (fresh), t2 Sales' plain text from 20 minutes ago, t3 Accountant's plain text (for delete).
insert into public.chat_messages (id, tenant_id, channel_id, author_id, parent_id, body, kind, post_status, created_at) values
  ('c2329000-0000-0000-0000-0000000000e1', 'c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1',
   'c2329000-0000-0000-0000-0000000000a3', null, 'Vendor bill pending', 'problem', 'task', now()),
  ('c2329000-0000-0000-0000-0000000000e2', 'c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1',
   'c2329000-0000-0000-0000-0000000000a3', 'c2329000-0000-0000-0000-0000000000e1', 'Made a task for Sales, due 02 Nov 2026', 'system', null, now()),
  ('c2329000-0000-0000-0000-0000000000e3', 'c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1',
   null, 'c2329000-0000-0000-0000-0000000000e1', 'Reported as a bug', 'system', null, now()),
  ('c2329000-0000-0000-0000-0000000000e4', 'c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1',
   'c2329000-0000-0000-0000-0000000000a3', null, 'hello team', 'text', null, now()),
  ('c2329000-0000-0000-0000-0000000000e5', 'c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1',
   'c2329000-0000-0000-0000-0000000000a3', null, 'old note', 'text', null, now() - interval '20 minutes'),
  ('c2329000-0000-0000-0000-0000000000e6', 'c2329000-0000-0000-0000-0000000000f1', 'c2329000-0000-0000-0000-0000000000c1',
   'c2329000-0000-0000-0000-0000000000a4', null, 'acct note', 'text', null, now());

set local role authenticated;

create or replace function pg_temp.r2329_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.r2329_refused(p_case text, p_sql text, p_state text, p_like text)
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

-- ── 1 + 2. system rows: nobody edits or deletes them ────────────────────────────────
do $$
declare
  v_who  uuid;
  v_row  uuid;
begin
  foreach v_row in array array['c2329000-0000-0000-0000-0000000000e2', 'c2329000-0000-0000-0000-0000000000e3']::uuid[] loop
    -- Sales (the member whose action wrote e2), Owner, Manager, Accountant
    foreach v_who in array array['c2329000-0000-0000-0000-0000000000a3', 'c2329000-0000-0000-0000-0000000000a1',
                                 'c2329000-0000-0000-0000-0000000000a2', 'c2329000-0000-0000-0000-0000000000a4']::uuid[] loop
      perform pg_temp.r2329_as(v_who);
      perform pg_temp.r2329_refused('1 edit ' || v_row || ' as ' || v_who,
        format('select public.chat_edit_message(%L::uuid, %L)', v_row, 'Owner approved: pay vendor 5 lakh today'),
        '42501', '%App notices cannot be edited%');
      perform pg_temp.r2329_refused('1 delete ' || v_row || ' as ' || v_who,
        format('select public.chat_delete_message(%L::uuid)', v_row),
        '42501', '%App notices cannot be deleted%');
    end loop;
  end loop;
end $$;

reset role;
do $$
begin
  if (select body from public.chat_messages where id = 'c2329000-0000-0000-0000-0000000000e2') <> 'Made a task for Sales, due 02 Nov 2026'
     or (select body from public.chat_messages where id = 'c2329000-0000-0000-0000-0000000000e3') <> 'Reported as a bug' then
    raise exception 'FAIL 1: a system notice''s text changed';
  end if;
  if exists (select 1 from public.chat_messages
              where id in ('c2329000-0000-0000-0000-0000000000e2', 'c2329000-0000-0000-0000-0000000000e3')
                and (edited_at is not null or deleted_at is not null)) then
    raise exception 'FAIL 1: a system notice got edited_at / deleted_at';
  end if;
  if exists (select 1 from public.chat_message_edits
              where message_id in ('c2329000-0000-0000-0000-0000000000e2', 'c2329000-0000-0000-0000-0000000000e3')) then
    raise exception 'FAIL 1: an edit history row was written for a system notice';
  end if;
  if exists (select 1 from public.activity_log
              where entity = 'chat_message'
                and entity_id in ('c2329000-0000-0000-0000-0000000000e2', 'c2329000-0000-0000-0000-0000000000e3')) then
    raise exception 'FAIL 1: activity_log logged an edit/delete of a system notice';
  end if;
end $$;
set local role authenticated;

-- ── 3. ordinary messages keep today's rules ─────────────────────────────────────────
do $$
begin
  -- another member cannot edit Sales' message
  perform pg_temp.r2329_as('c2329000-0000-0000-0000-0000000000a4');
  perform pg_temp.r2329_refused('3 edit other',
    'select public.chat_edit_message(''c2329000-0000-0000-0000-0000000000e4''::uuid, ''x'')',
    '42501', '%only edit your own%');
  -- the owner cannot edit Sales' message either
  perform pg_temp.r2329_as('c2329000-0000-0000-0000-0000000000a1');
  perform pg_temp.r2329_refused('3 edit owner',
    'select public.chat_edit_message(''c2329000-0000-0000-0000-0000000000e4''::uuid, ''x'')',
    '42501', '%only edit your own%');
  -- the author, after 15 minutes
  perform pg_temp.r2329_as('c2329000-0000-0000-0000-0000000000a3');
  perform pg_temp.r2329_refused('3 edit late',
    'select public.chat_edit_message(''c2329000-0000-0000-0000-0000000000e5''::uuid, ''x'')',
    '42501', '%15 minutes%');
  -- the author, in time: works
  perform public.chat_edit_message('c2329000-0000-0000-0000-0000000000e4', 'hello team (fixed)');
  -- a manager cannot delete a teammate's message
  perform pg_temp.r2329_as('c2329000-0000-0000-0000-0000000000a2');
  perform pg_temp.r2329_refused('3 delete manager',
    'select public.chat_delete_message(''c2329000-0000-0000-0000-0000000000e6''::uuid)',
    '42501', '%author or the owner%');
  -- the owner can
  perform pg_temp.r2329_as('c2329000-0000-0000-0000-0000000000a1');
  perform public.chat_delete_message('c2329000-0000-0000-0000-0000000000e6');
  -- the author deletes their own
  perform pg_temp.r2329_as('c2329000-0000-0000-0000-0000000000a3');
  perform public.chat_delete_message('c2329000-0000-0000-0000-0000000000e5');
end $$;

reset role;
do $$
begin
  if (select body from public.chat_messages where id = 'c2329000-0000-0000-0000-0000000000e4') <> 'hello team (fixed)'
     or (select edited_at from public.chat_messages where id = 'c2329000-0000-0000-0000-0000000000e4') is null then
    raise exception 'FAIL 3: the author''s in-time edit did not land';
  end if;
  if (select count(*) from public.chat_message_edits where message_id = 'c2329000-0000-0000-0000-0000000000e4') <> 1 then
    raise exception 'FAIL 3: expected exactly 1 edit history row for the author''s edit';
  end if;
  if (select deleted_at from public.chat_messages where id = 'c2329000-0000-0000-0000-0000000000e6') is null
     or (select deleted_at from public.chat_messages where id = 'c2329000-0000-0000-0000-0000000000e5') is null then
    raise exception 'FAIL 3: owner delete / author delete of a text message did not land';
  end if;
end $$;
set local role authenticated;

-- ── 4. direct writes from the browser are refused ───────────────────────────────────
do $$
begin
  perform pg_temp.r2329_as('c2329000-0000-0000-0000-0000000000a3');
  perform pg_temp.r2329_refused('4 update',
    'update public.chat_messages set body = ''Owner approved: pay vendor 5 lakh today'' where id = ''c2329000-0000-0000-0000-0000000000e2''',
    '42501', '%permission denied%');
  perform pg_temp.r2329_as('c2329000-0000-0000-0000-0000000000a1');
  perform pg_temp.r2329_refused('4 delete',
    'delete from public.chat_messages where id = ''c2329000-0000-0000-0000-0000000000e2''',
    '42501', '%permission denied%');
end $$;

reset role;
do $$
begin
  if (select body from public.chat_messages where id = 'c2329000-0000-0000-0000-0000000000e2') <> 'Made a task for Sales, due 02 Nov 2026' then
    raise exception 'FAIL 4: a direct write changed a system notice';
  end if;
end $$;

select 'R-2329 team_chat_system_rows: all cases passed' as result;

rollback;
