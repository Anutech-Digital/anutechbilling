-- R-2295 (G-TEAMCHAT TC-02, 31 Oct 2026) — team chat RPCs: post, edit, delete, read, DM,
-- channel, unread.
-- Migration: 20261031122037_r2295_team_chat_rpcs.sql (on top of R-2294's tables).
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   0. Shape: the 7 RPCs exist, SECURITY DEFINER, search_path '', executable by authenticated,
--      never by anon.
--   1. Post with 1 attachment + 1 mention → 1 message, 1 attachment, 1 notification for the
--      mentioned member only (not the author, not a non-member, not another company's user);
--      the author's read mark moves.
--   2. A mention of a non-member (private channel) is dropped — no notification; a member who
--      set notify 'none' stays mentioned but gets no notification.
--   3. The 31st message in a minute is refused; the first 30 are stored.
--   4. Editing someone else's message is refused; an own edit writes chat_message_edits
--      (with channel_id) + an activity_log row (entity chat_message) WITHOUT the message text;
--      an edit after 15 minutes is refused.
--   5. Delete blanks the body and keeps the row, removes the attachment rows and returns their
--      paths; author or owner only; the owner cannot delete inside a DM he is not in;
--      activity_log row (entity chat_message, action delete).
--   6. Mark read: member moves own read mark; non-member refused.
--   7. Open DM: idempotent by dm_key "lower:higher" (also finds an existing DM); self, partner,
--      inactive and other-company users refused.
--   8. Create channel: owner/manager only; slug from name; creator = admin; only active staff
--      of the same company become members; duplicate name refused; activity_log entity chat_channel.
--   9. Unread counts: others' messages after the read mark, mentions counted, own and deleted
--      messages not counted.
--  10. EVERY function's own guard fails closed (§17c), each checked on its own: no login,
--      partner_agent, inactive login → 28000; another company's row → not found.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_rpcs.test.sql

begin;

-- ── 0. shape ────────────────────────────────────────────────────────────────────────
do $$
declare
  v_sig text;
  v_p record;
begin
  foreach v_sig in array array[
    'public.chat_post_message(uuid,text,text,uuid,uuid[],jsonb,jsonb)',
    'public.chat_edit_message(uuid,text)',
    'public.chat_delete_message(uuid)',
    'public.chat_mark_read(uuid,timestamptz)',
    'public.chat_open_dm(uuid)',
    'public.chat_create_channel(text,boolean,text,uuid[])',
    'public.chat_unread_counts()'] loop
    if to_regprocedure(v_sig) is null then
      raise exception 'FAIL 0: % does not exist — migration not applied', v_sig;
    end if;
    select p.prosecdef, p.proconfig into v_p from pg_proc p where p.oid = to_regprocedure(v_sig);
    if not v_p.prosecdef or not ('search_path=""' = any (v_p.proconfig)) then
      raise exception 'FAIL 0: % must be SECURITY DEFINER with search_path '''' (got %, %)',
        v_sig, v_p.prosecdef, v_p.proconfig;
    end if;
    if not has_function_privilege('authenticated', v_sig, 'EXECUTE') then
      raise exception 'FAIL 0: authenticated cannot execute %', v_sig;
    end if;
    if has_function_privilege('anon', v_sig, 'EXECUTE') then
      raise exception 'FAIL 0: anon can execute %', v_sig;
    end if;
  end loop;
end $$;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2295000-0000-0000-0000-0000000000a1', 'tc02-owner@example.test'),
  ('c2295000-0000-0000-0000-0000000000a2', 'tc02-acct@example.test'),
  ('c2295000-0000-0000-0000-0000000000a3', 'tc02-sales@example.test'),
  ('c2295000-0000-0000-0000-0000000000a4', 'tc02-partner@example.test'),
  ('c2295000-0000-0000-0000-0000000000a6', 'tc02-gone@example.test'),
  ('c2295000-0000-0000-0000-0000000000a7', 'tc02-manager@example.test'),
  ('c2295000-0000-0000-0000-0000000000b1', 'tc02-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2295000-0000-0000-0000-0000000000f1', 'TC02 A', 'tc02-a@example.test', '07', 'TC2A'),
  ('c2295000-0000-0000-0000-0000000000f2', 'TC02 B', 'tc02-b@example.test', '07', 'TC2B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2295000-0000-0000-0000-0000000000a1', 'c2295000-0000-0000-0000-0000000000f1', 'tc02-owner@example.test',   'Owner',      'owner',         true),
  ('c2295000-0000-0000-0000-0000000000a2', 'c2295000-0000-0000-0000-0000000000f1', 'tc02-acct@example.test',    'Accountant', 'accountant',    true),
  ('c2295000-0000-0000-0000-0000000000a3', 'c2295000-0000-0000-0000-0000000000f1', 'tc02-sales@example.test',   'Sales',      'sales',         true),
  ('c2295000-0000-0000-0000-0000000000a4', 'c2295000-0000-0000-0000-0000000000f1', 'tc02-partner@example.test', 'Partner',    'partner_agent', true),
  ('c2295000-0000-0000-0000-0000000000a6', 'c2295000-0000-0000-0000-0000000000f1', 'tc02-gone@example.test',    'Gone',       'sales',         false),
  ('c2295000-0000-0000-0000-0000000000a7', 'c2295000-0000-0000-0000-0000000000f1', 'tc02-manager@example.test', 'Manager',    'manager',       true),
  ('c2295000-0000-0000-0000-0000000000b1', 'c2295000-0000-0000-0000-0000000000f2', 'tc02-owner-b@example.test', 'Owner B',    'owner',         true);

-- c1 general (public: owner, acct, sales + bad rows for partner / gone),
-- c2 accounts (private: owner + acct), c3 DM acct <-> sales, c9 tenant B general
insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, dm_key, created_by) values
  ('c2295000-0000-0000-0000-0000000000c1', 'c2295000-0000-0000-0000-0000000000f1', 'channel', 'general',  'general',  false, null, 'c2295000-0000-0000-0000-0000000000a1'),
  ('c2295000-0000-0000-0000-0000000000c2', 'c2295000-0000-0000-0000-0000000000f1', 'channel', 'accounts', 'accounts', true,  null, 'c2295000-0000-0000-0000-0000000000a1'),
  ('c2295000-0000-0000-0000-0000000000c3', 'c2295000-0000-0000-0000-0000000000f1', 'dm',      null,       null,       true,
     'c2295000-0000-0000-0000-0000000000a2:c2295000-0000-0000-0000-0000000000a3', 'c2295000-0000-0000-0000-0000000000a2'),
  ('c2295000-0000-0000-0000-0000000000c9', 'c2295000-0000-0000-0000-0000000000f2', 'channel', 'general',  'general',  false, null, 'c2295000-0000-0000-0000-0000000000b1');

insert into public.chat_members (tenant_id, channel_id, user_id, member_role) values
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c1', 'c2295000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c1', 'c2295000-0000-0000-0000-0000000000a2', 'member'),
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c1', 'c2295000-0000-0000-0000-0000000000a3', 'member'),
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c1', 'c2295000-0000-0000-0000-0000000000a4', 'member'),
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c1', 'c2295000-0000-0000-0000-0000000000a6', 'member'),
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c2', 'c2295000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c2', 'c2295000-0000-0000-0000-0000000000a2', 'member'),
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c2', 'c2295000-0000-0000-0000-0000000000a7', 'member'),  -- manager, muted below
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c3', 'c2295000-0000-0000-0000-0000000000a2', 'member'),
  ('c2295000-0000-0000-0000-0000000000f1', 'c2295000-0000-0000-0000-0000000000c3', 'c2295000-0000-0000-0000-0000000000a3', 'member'),
  ('c2295000-0000-0000-0000-0000000000f2', 'c2295000-0000-0000-0000-0000000000c9', 'c2295000-0000-0000-0000-0000000000b1', 'admin');
update public.chat_members set notify = 'none'
 where channel_id = 'c2295000-0000-0000-0000-0000000000c2' and user_id = 'c2295000-0000-0000-0000-0000000000a7';

-- message ids the RPCs return, passed between steps
create temp table tc02_ids (k text primary key, v uuid);
grant all on tc02_ids to authenticated;

set local role authenticated;

create or replace function pg_temp.tc02_as(p_user uuid) returns void language plpgsql as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  end if;
end $$;

-- runs p_sql as the current caller and asserts it is refused with p_state and a message like p_like
create or replace function pg_temp.tc02_refused(p_case text, p_sql text, p_state text, p_like text)
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

create or replace function pg_temp.tc02_id(p_k text) returns uuid language sql as $$
  select v from tc02_ids where k = p_k;
$$;

-- ── 1 + 2. post: attachment + mention; non-member mention dropped ───────────────────
do $$
declare
  v_id uuid;
begin
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  v_id := public.chat_post_message(
    'c2295000-0000-0000-0000-0000000000c1', '@Accountant hi', 'text', null,
    array['c2295000-0000-0000-0000-0000000000a2',   -- accountant: member → notified
          'c2295000-0000-0000-0000-0000000000a2',   -- duplicate → once
          'c2295000-0000-0000-0000-0000000000a1',   -- the author → never
          'c2295000-0000-0000-0000-0000000000a4',   -- partner_agent with a bad member row → no
          'c2295000-0000-0000-0000-0000000000b1',   -- another company → no
          'c2295000-0000-0000-0000-0000000000e9']::uuid[], -- nobody → no
    '[{"type":"invoice","id":"INV-7"}]'::jsonb,
    '[{"path":"c2295000-0000-0000-0000-0000000000f1/chat/c2295000-0000-0000-0000-0000000000c1/x_bill.pdf","name":"bill.pdf","mime":"application/pdf","size":1200}]'::jsonb);
  insert into tc02_ids values ('m1', v_id);

  -- 2. private channel accounts (owner, acct, muted manager): mentioning sales (staff, not a member) is
  --    dropped; the manager stays mentioned but gets no notification (notify 'none')
  v_id := public.chat_post_message(
    'c2295000-0000-0000-0000-0000000000c2', 'books closed', 'text', null,
    array['c2295000-0000-0000-0000-0000000000a3', 'c2295000-0000-0000-0000-0000000000a7']::uuid[], '[]'::jsonb, '[]'::jsonb);
  insert into tc02_ids values ('m2', v_id);

  -- acct posts in #general (used for delete / unread later)
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a2');
  v_id := public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'acct note', 'problem', null,
    '{}'::uuid[], '[]'::jsonb,
    '[{"path":"c2295000-0000-0000-0000-0000000000f1/chat/c2295000-0000-0000-0000-0000000000c1/y_shot.png","name":"shot.png","mime":"image/png","size":500}]'::jsonb);
  insert into tc02_ids values ('m3', v_id);
  -- acct in the DM with sales
  v_id := public.chat_post_message('c2295000-0000-0000-0000-0000000000c3', 'dm text', 'text', null,
    '{}'::uuid[], '[]'::jsonb, '[]'::jsonb);
  insert into tc02_ids values ('m4', v_id);
end $$;

-- input checks (refused, nothing stored)
do $$
begin
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  perform pg_temp.tc02_refused('1a empty', $q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', '   ', 'text', null, '{}'::uuid[], '[]'::jsonb, '[]'::jsonb)$q$,
    '22023', '%empty%');
  perform pg_temp.tc02_refused('1a system kind', $q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'x', 'system', null, '{}'::uuid[], '[]'::jsonb, '[]'::jsonb)$q$,
    '22023', '%kind%');
  perform pg_temp.tc02_refused('1a link with amount', $q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'x', 'text', null, '{}'::uuid[], '[{"type":"invoice","id":"1","amount":5}]'::jsonb, '[]'::jsonb)$q$,
    '22023', '%link%');
  perform pg_temp.tc02_refused('1a attachment outside folder', $q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'x', 'text', null, '{}'::uuid[], '[]'::jsonb, '[{"path":"c2295000-0000-0000-0000-0000000000f2/chat/c2295000-0000-0000-0000-0000000000c1/a.pdf","name":"a.pdf","mime":"application/pdf","size":10}]'::jsonb)$q$,
    '22023', '%attachment%');
  perform pg_temp.tc02_refused('1a too big', $q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'x', 'text', null, '{}'::uuid[], '[]'::jsonb, '[{"path":"c2295000-0000-0000-0000-0000000000f1/chat/c2295000-0000-0000-0000-0000000000c1/a.pdf","name":"a.pdf","mime":"application/pdf","size":10485761}]'::jsonb)$q$,
    '22023', '%10 MB%');
  perform pg_temp.tc02_refused('1a reply to another channel', format($q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c2', 'x', 'text', %L, '{}'::uuid[], '[]'::jsonb, '[]'::jsonb)$q$, pg_temp.tc02_id('m1')),
    'P0002', '%reply%');
end $$;

reset role;
do $$
declare
  v_m1 uuid := (select v from tc02_ids where k = 'm1');
  v_m2 uuid := (select v from tc02_ids where k = 'm2');
  v_m3 uuid := (select v from tc02_ids where k = 'm3');
  v_n int;
  v_txt text;
begin
  if (select count(*) from public.chat_messages where tenant_id = 'c2295000-0000-0000-0000-0000000000f1') <> 4 then
    raise exception 'FAIL 1: expected 4 messages (refused posts stored nothing), got %',
      (select count(*) from public.chat_messages where tenant_id = 'c2295000-0000-0000-0000-0000000000f1');
  end if;
  if (select count(*) from public.chat_attachments where message_id = v_m1) <> 1 then
    raise exception 'FAIL 1: message 1 should have 1 attachment';
  end if;
  if (select uploaded_by from public.chat_attachments where message_id = v_m1) <> 'c2295000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL 1: attachment uploaded_by is not the author';
  end if;
  if (select mentions from public.chat_messages where id = v_m1) <> array['c2295000-0000-0000-0000-0000000000a2']::uuid[] then
    raise exception 'FAIL 1: stored mentions should be the accountant only, got %',
      (select mentions from public.chat_messages where id = v_m1);
  end if;
  select count(*) into v_n from public.notifications where entity_id = v_m1::text;
  if v_n <> 1 then raise exception 'FAIL 1: expected 1 notification for message 1, got %', v_n; end if;
  select title into v_txt from public.notifications
   where entity_id = v_m1::text and user_id = 'c2295000-0000-0000-0000-0000000000a2' and kind = 'chat.mention';
  if v_txt is null or v_txt not like 'Owner mentioned you in #general%' then
    raise exception 'FAIL 1: the accountant''s notification is missing or wrong (title %)', v_txt;
  end if;
  if exists (select 1 from public.notifications where user_id in
               ('c2295000-0000-0000-0000-0000000000a1', 'c2295000-0000-0000-0000-0000000000a3',
                'c2295000-0000-0000-0000-0000000000a4', 'c2295000-0000-0000-0000-0000000000b1')) then
    raise exception 'FAIL 1: someone other than the mentioned member got a notification';
  end if;
  if (select last_read_at from public.chat_members where channel_id = 'c2295000-0000-0000-0000-0000000000c1'
        and user_id = 'c2295000-0000-0000-0000-0000000000a1')
     is distinct from (select created_at from public.chat_messages where id = v_m1) then
    raise exception 'FAIL 1: the author''s read mark did not move to the message';
  end if;
  -- 2
  if (select mentions from public.chat_messages where id = v_m2) <> array['c2295000-0000-0000-0000-0000000000a7']::uuid[]
     or exists (select 1 from public.notifications where entity_id = v_m2::text) then
    raise exception 'FAIL 2: a non-member mention was kept, or a muted member was notified';
  end if;
  -- problem posts start open; text posts have no status
  if (select post_status from public.chat_messages where id = v_m3) is distinct from 'open'
     or (select post_status from public.chat_messages where id = v_m1) is not null then
    raise exception 'FAIL 1: post_status should be open on a problem post only';
  end if;
end $$;

-- ── 3. rate limit: 30 a minute per user ─────────────────────────────────────────────
set local role authenticated;
do $$
declare
  i int;
begin
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a3');
  for i in 1..30 loop
    perform public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'msg ' || i, 'text', null,
      '{}'::uuid[], '[]'::jsonb, '[]'::jsonb);
  end loop;
  perform pg_temp.tc02_refused('3 31st message', $q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'one too many', 'text', null, '{}'::uuid[], '[]'::jsonb, '[]'::jsonb)$q$,
    'P0001', '%too many messages%');
  -- another user is not held back by sales' limit
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a2');
  perform public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'still fine', 'text', null,
    '{}'::uuid[], '[]'::jsonb, '[]'::jsonb);
end $$;
reset role;
do $$
begin
  if (select count(*) from public.chat_messages where author_id = 'c2295000-0000-0000-0000-0000000000a3') <> 30 then
    raise exception 'FAIL 3: sales should have exactly 30 messages, got %',
      (select count(*) from public.chat_messages where author_id = 'c2295000-0000-0000-0000-0000000000a3');
  end if;
end $$;

-- ── 4. edit ─────────────────────────────────────────────────────────────────────────
set local role authenticated;
do $$
begin
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a2');
  perform pg_temp.tc02_refused('4 edit someone else''s', format('select public.chat_edit_message(%L, %L)', pg_temp.tc02_id('m1'), 'hacked'),
    '42501', '%only edit your own%');
  -- the owner may not edit others' text either (only delete)
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  perform pg_temp.tc02_refused('4 owner edits acct', format('select public.chat_edit_message(%L, %L)', pg_temp.tc02_id('m3'), 'x'),
    '42501', '%only edit your own%');
  perform pg_temp.tc02_refused('4 empty edit', format('select public.chat_edit_message(%L, %L)', pg_temp.tc02_id('m1'), '  '),
    '22023', '%empty%');
  perform public.chat_edit_message(pg_temp.tc02_id('m1'), '@Accountant hello');
end $$;
reset role;
do $$
declare
  v_m1 uuid := (select v from tc02_ids where k = 'm1');
  r record;
begin
  if (select body from public.chat_messages where id = v_m1) <> '@Accountant hello'
     or (select edited_at from public.chat_messages where id = v_m1) is null then
    raise exception 'FAIL 4: own edit did not change the body / edited_at';
  end if;
  select * into r from public.chat_message_edits where message_id = v_m1;
  if r.old_body is distinct from '@Accountant hi' or r.channel_id <> 'c2295000-0000-0000-0000-0000000000c1'
     or r.edited_by <> 'c2295000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL 4: chat_message_edits row wrong: %', row_to_json(r);
  end if;
  if (select count(*) from public.chat_message_edits where message_id = v_m1) <> 1 then
    raise exception 'FAIL 4: refused edits wrote history rows';
  end if;
  select * into r from public.activity_log
   where entity = 'chat_message' and entity_id = v_m1::text and action = 'update';
  if r.id is null or r.user_id <> 'c2295000-0000-0000-0000-0000000000a1'
     or r.tenant_id <> 'c2295000-0000-0000-0000-0000000000f1' then
    raise exception 'FAIL 4: no activity_log row for the edit';
  end if;
  if coalesce(r.changes::text, '') || coalesce(r.label, '') like '%Accountant h%' then
    raise exception 'FAIL 4: activity_log carries the message text (owner must not read DM text there)';
  end if;
  -- age message 1 past the 15-minute window
  update public.chat_messages set created_at = created_at - interval '16 minutes' where id = v_m1;
end $$;
set local role authenticated;
do $$
begin
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  perform pg_temp.tc02_refused('4 edit after 15 min', format('select public.chat_edit_message(%L, %L)', pg_temp.tc02_id('m1'), 'late'),
    '42501', '%15 minutes%');
end $$;

-- ── 5. delete ───────────────────────────────────────────────────────────────────────
do $$
declare
  v_res jsonb;
begin
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a3');
  perform pg_temp.tc02_refused('5 sales deletes owner''s', format('select public.chat_delete_message(%L)', pg_temp.tc02_id('m1')),
    '42501', '%author or the owner%');
  -- the manager is not the owner
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a7');
  perform pg_temp.tc02_refused('5 manager deletes acct''s', format('select public.chat_delete_message(%L)', pg_temp.tc02_id('m3')),
    '42501', '%author or the owner%');
  -- the owner cannot reach a DM he is not in
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  perform pg_temp.tc02_refused('5 owner deletes in others'' DM', format('select public.chat_delete_message(%L)', pg_temp.tc02_id('m4')),
    'P0002', '%not found%');
  -- the owner deletes the accountant's message in #general
  v_res := public.chat_delete_message(pg_temp.tc02_id('m3'));
  if (v_res -> 'file_paths') <> '["c2295000-0000-0000-0000-0000000000f1/chat/c2295000-0000-0000-0000-0000000000c1/y_shot.png"]'::jsonb then
    raise exception 'FAIL 5: delete should return the removed file paths, got %', v_res;
  end if;
  -- again: idempotent, nothing more to remove
  v_res := public.chat_delete_message(pg_temp.tc02_id('m3'));
  if jsonb_array_length(v_res -> 'file_paths') <> 0 then
    raise exception 'FAIL 5: a second delete returned paths again: %', v_res;
  end if;
  -- the author deletes their own DM message
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a2');
  perform public.chat_delete_message(pg_temp.tc02_id('m4'));
  -- a deleted message cannot be edited
  perform pg_temp.tc02_refused('5 edit a deleted message', format('select public.chat_edit_message(%L, %L)', pg_temp.tc02_id('m4'), 'back'),
    '22023', '%deleted%');
end $$;
reset role;
do $$
declare
  v_m3 uuid := (select v from tc02_ids where k = 'm3');
  v_m4 uuid := (select v from tc02_ids where k = 'm4');
  r record;
begin
  select * into r from public.chat_messages where id = v_m3;
  if r.id is null then raise exception 'FAIL 5: delete removed the row'; end if;
  if r.body <> '' or r.deleted_at is null or r.deleted_by <> 'c2295000-0000-0000-0000-0000000000a1'
     or r.links <> '[]'::jsonb or cardinality(r.mentions) <> 0 then
    raise exception 'FAIL 5: delete did not blank the message: %', row_to_json(r);
  end if;
  if exists (select 1 from public.chat_attachments where message_id = v_m3) then
    raise exception 'FAIL 5: attachment rows of a deleted message remain';
  end if;
  if (select body from public.chat_messages where id = v_m4) <> '' then
    raise exception 'FAIL 5: author delete did not blank the DM message';
  end if;
  if (select count(*) from public.activity_log where entity = 'chat_message' and action = 'delete'
        and entity_id in (v_m3::text, v_m4::text)) <> 2 then
    raise exception 'FAIL 5: expected 2 activity_log delete rows (repeat delete logs nothing), got %',
      (select count(*) from public.activity_log where entity = 'chat_message' and action = 'delete'
        and entity_id in (v_m3::text, v_m4::text));
  end if;
end $$;

-- ── 6. mark read  +  9. unread counts ───────────────────────────────────────────────
set local role authenticated;
do $$
declare
  r record;
begin
  -- owner: read mark at m1; since then in #general sales' 30 + acct's 'still fine' (+ m3, deleted)
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  select * into r from public.chat_unread_counts() u where u.channel_id = 'c2295000-0000-0000-0000-0000000000c1';
  if r.unread is distinct from 31 or r.mentions is distinct from 0 then
    raise exception 'FAIL 9: owner #general unread/mentions should be 31/0, got %/%', r.unread, r.mentions;
  end if;
  -- accountant: posting 'still fine' (after m1 + sales' 30) moved the read mark → #general clear
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a2');
  if exists (select 1 from public.chat_unread_counts() u where u.channel_id = 'c2295000-0000-0000-0000-0000000000c1') then
    raise exception 'FAIL 9: the accountant''s own post should have marked #general read';
  end if;
  -- the private channel: owner's m2 → 1 unread, no mention
  select * into r from public.chat_unread_counts() u where u.channel_id = 'c2295000-0000-0000-0000-0000000000c2';
  if r.unread is distinct from 1 or r.mentions is distinct from 0 then
    raise exception 'FAIL 9: accountant #accounts unread/mentions should be 1/0, got %/%', r.unread, r.mentions;
  end if;
  -- the owner mentions the accountant again, and posts one more that he then deletes
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  perform public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', '@Accountant again', 'text', null,
    array['c2295000-0000-0000-0000-0000000000a2']::uuid[], '[]'::jsonb, '[]'::jsonb);
  perform public.chat_delete_message(public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'oops', 'text', null,
    '{}'::uuid[], '[]'::jsonb, '[]'::jsonb));
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a2');
  select * into r from public.chat_unread_counts() u where u.channel_id = 'c2295000-0000-0000-0000-0000000000c1';
  if r.unread is distinct from 1 or r.mentions is distinct from 1 then
    raise exception 'FAIL 9: after a new mention (+ a deleted one) unread/mentions should be 1/1, got %/%', r.unread, r.mentions;
  end if;
  -- 6. mark read clears it, and an older time never moves the mark back
  perform public.chat_mark_read('c2295000-0000-0000-0000-0000000000c1', null);
  perform public.chat_mark_read('c2295000-0000-0000-0000-0000000000c1', now() - interval '1 day');
  if exists (select 1 from public.chat_unread_counts() u where u.channel_id = 'c2295000-0000-0000-0000-0000000000c1') then
    raise exception 'FAIL 6: after mark read #general still shows unread (or the mark moved back)';
  end if;
  -- the manager is not in #general
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a7');
  perform pg_temp.tc02_refused('6 non-member marks read', $q$select public.chat_mark_read('c2295000-0000-0000-0000-0000000000c1', null)$q$,
    '42501', '%not a member%');
  -- the owner never sees the acct<->sales DM in his counts
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  if exists (select 1 from public.chat_unread_counts() u where u.channel_id = 'c2295000-0000-0000-0000-0000000000c3') then
    raise exception 'FAIL 9: the owner''s unread counts include a DM he is not in';
  end if;
end $$;

-- ── 7. open DM ──────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid;
  v_b uuid;
begin
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a2');
  v_a := public.chat_open_dm('c2295000-0000-0000-0000-0000000000a1');
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  v_b := public.chat_open_dm('c2295000-0000-0000-0000-0000000000a2');
  if v_a is null or v_a <> v_b then
    raise exception 'FAIL 7: open DM is not idempotent (% vs %)', v_a, v_b;
  end if;
  insert into tc02_ids values ('dm_owner_acct', v_a);
  -- an existing DM (acct <-> sales, made by the fixture) is found, not duplicated
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a3');
  if public.chat_open_dm('c2295000-0000-0000-0000-0000000000a2') <> 'c2295000-0000-0000-0000-0000000000c3' then
    raise exception 'FAIL 7: the existing acct<->sales DM was not reused';
  end if;
  perform pg_temp.tc02_refused('7 DM with self', $q$select public.chat_open_dm('c2295000-0000-0000-0000-0000000000a3')$q$, '22023', '%yourself%');
  perform pg_temp.tc02_refused('7 DM with partner', $q$select public.chat_open_dm('c2295000-0000-0000-0000-0000000000a4')$q$, 'P0002', '%teammate%');
  perform pg_temp.tc02_refused('7 DM with inactive', $q$select public.chat_open_dm('c2295000-0000-0000-0000-0000000000a6')$q$, 'P0002', '%teammate%');
  perform pg_temp.tc02_refused('7 DM with other company', $q$select public.chat_open_dm('c2295000-0000-0000-0000-0000000000b1')$q$, 'P0002', '%teammate%');
  perform pg_temp.tc02_refused('7 DM with null', $q$select public.chat_open_dm(null)$q$, 'P0002', '%teammate%');
end $$;
reset role;
do $$
declare
  v_dm uuid := (select v from tc02_ids where k = 'dm_owner_acct');
begin
  if (select dm_key from public.chat_channels where id = v_dm)
       <> 'c2295000-0000-0000-0000-0000000000a1:c2295000-0000-0000-0000-0000000000a2'
     or (select count(*) from public.chat_members where channel_id = v_dm) <> 2
     or (select count(*) from public.chat_channels where tenant_id = 'c2295000-0000-0000-0000-0000000000f1' and kind = 'dm') <> 2 then
    raise exception 'FAIL 7: DM key / members / count wrong';
  end if;
end $$;

-- ── 8. create channel ───────────────────────────────────────────────────────────────
set local role authenticated;
do $$
declare
  v_ch uuid;
begin
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a3');
  perform pg_temp.tc02_refused('8 sales creates', $q$select public.chat_create_channel('Sales talk', false, null, '{}'::uuid[])$q$,
    '42501', '%owner or a manager%');
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a7');
  v_ch := public.chat_create_channel('  Accounts Team! ', true, 'month end',
    array['c2295000-0000-0000-0000-0000000000a2', 'c2295000-0000-0000-0000-0000000000a4',
          'c2295000-0000-0000-0000-0000000000a6', 'c2295000-0000-0000-0000-0000000000b1']::uuid[]);
  insert into tc02_ids values ('ch_new', v_ch);
  perform pg_temp.tc02_refused('8 duplicate', $q$select public.chat_create_channel('accounts team', false, null, '{}'::uuid[])$q$,
    '23505', '%already exists%');
  perform pg_temp.tc02_refused('8 no name', $q$select public.chat_create_channel(' !! ', false, null, '{}'::uuid[])$q$,
    '22023', '%name%');
end $$;
reset role;
do $$
declare
  v_ch uuid := (select v from tc02_ids where k = 'ch_new');
  r record;
begin
  select * into r from public.chat_channels where id = v_ch;
  if r.name <> 'Accounts Team!' or r.slug <> 'accounts-team' or not r.is_private or r.kind <> 'channel'
     or r.created_by <> 'c2295000-0000-0000-0000-0000000000a7' or r.topic <> 'month end' then
    raise exception 'FAIL 8: channel row wrong: %', row_to_json(r);
  end if;
  if (select array_agg(user_id::text || '=' || member_role order by user_id) from public.chat_members where channel_id = v_ch)
     <> array['c2295000-0000-0000-0000-0000000000a2=member', 'c2295000-0000-0000-0000-0000000000a7=admin'] then
    raise exception 'FAIL 8: members should be the accountant + the manager (admin), got %',
      (select array_agg(user_id::text || '=' || member_role order by user_id) from public.chat_members where channel_id = v_ch);
  end if;
  if not exists (select 1 from public.activity_log where entity = 'chat_channel' and action = 'create'
                   and entity_id = v_ch::text and user_id = 'c2295000-0000-0000-0000-0000000000a7') then
    raise exception 'FAIL 8: no activity_log row for the new channel';
  end if;
end $$;

-- ── 10. every function's own guard fails closed ─────────────────────────────────────
set local role authenticated;
do $$
declare
  v_who uuid;
  v_calls text[] := array[
    $q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c1', 'x', 'text', null, '{}'::uuid[], '[]'::jsonb, '[]'::jsonb)$q$,
    format('select public.chat_edit_message(%L, %L)', pg_temp.tc02_id('m2'), 'x'),
    format('select public.chat_delete_message(%L)', pg_temp.tc02_id('m2')),
    $q$select public.chat_mark_read('c2295000-0000-0000-0000-0000000000c1', null)$q$,
    $q$select public.chat_open_dm('c2295000-0000-0000-0000-0000000000a2')$q$,
    $q$select public.chat_create_channel('guard test', false, null, '{}'::uuid[])$q$,
    $q$select * from public.chat_unread_counts()$q$];
  v_sql text;
begin
  -- no login, a partner_agent (has a bad member row in #general), a deactivated login (same)
  foreach v_who in array array[null, 'c2295000-0000-0000-0000-0000000000a4',
                               'c2295000-0000-0000-0000-0000000000a6']::uuid[] loop
    perform pg_temp.tc02_as(v_who);
    foreach v_sql in array v_calls loop
      perform pg_temp.tc02_refused('10 ' || coalesce(v_who::text, 'no login'), v_sql, '28000', '%team chat%');
    end loop;
  end loop;

  -- another company's owner: every row of company A is "not found"; posting is not allowed
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000b1');
  perform pg_temp.tc02_refused('10 B posts in A', v_calls[1], 'P0002', '%not found%');
  perform pg_temp.tc02_refused('10 B edits A', v_calls[2], 'P0002', '%not found%');
  perform pg_temp.tc02_refused('10 B deletes A', v_calls[3], 'P0002', '%not found%');
  perform pg_temp.tc02_refused('10 B marks A read', v_calls[4], '42501', '%not a member%');
  perform pg_temp.tc02_refused('10 B opens DM with A user', v_calls[5], 'P0002', '%teammate%');
  if exists (select 1 from public.chat_unread_counts() u
              where u.channel_id <> 'c2295000-0000-0000-0000-0000000000c9') then
    raise exception 'FAIL 10: B''s unread counts show a channel of company A';
  end if;

  -- a staff member who is NOT in the channel cannot post (public channel included)
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a7');
  perform pg_temp.tc02_refused('10 manager posts in #general (not a member)', v_calls[1], '42501', '%not a member%');
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a3');
  perform pg_temp.tc02_refused('10 sales posts in private #accounts', $q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c2', 'x', 'text', null, '{}'::uuid[], '[]'::jsonb, '[]'::jsonb)$q$,
    'P0002', '%not found%');
  -- an archived channel takes no new messages
end $$;
reset role;
update public.chat_channels set archived_at = now() where id = 'c2295000-0000-0000-0000-0000000000c2';
set local role authenticated;
do $$
begin
  perform pg_temp.tc02_as('c2295000-0000-0000-0000-0000000000a1');
  perform pg_temp.tc02_refused('10 post in archived', $q$select public.chat_post_message('c2295000-0000-0000-0000-0000000000c2', 'x', 'text', null, '{}'::uuid[], '[]'::jsonb, '[]'::jsonb)$q$,
    '22023', '%archived%');
end $$;

reset role;
do $$ begin raise notice 'team_chat_rpcs: all checks passed'; end $$;

rollback;
