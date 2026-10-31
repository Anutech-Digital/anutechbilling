-- R-2328 (G-TEAMCHAT, found by the R-2305 audit) — "Make a task" / "Report as bug / idea" on a
-- post in a DM or a PRIVATE channel must not copy the post's text into tasks / feedback, which
-- every staff member of the company (and the platform feedback view) can read.
-- Migration: 20261031221356_r2328_chat_private_post_link_only.sql (redefines R-2304's
-- chat_message_to_task + chat_message_report).
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   0. Shape: both RPCs SECURITY DEFINER, search_path '', authenticated yes, anon no.
--   1. DM: the OWNER (a member of the DM) cannot make a task from / report the other person's
--      post (42501 "poster"); in a private channel a MANAGER and a plain member cannot either.
--      A non-member and another company get "not found". Nothing is written by a refused call.
--   2. DM: the poster makes a task for a teammate who is NOT in the DM: title is the neutral
--      "Team chat post (private)", notes are ONLY "From team chat: /team-chat?c=<dm>&m=<msg>",
--      no record link copied (customer_id etc. null); the owner's notification holds no text.
--   3. DM: the poster reports the post: title + body hold no text, page_path = the link back, no
--      screenshot rows (the image stays in the chat).
--   4. Private channel: the poster's task + report — same, no text.
--   5. Public channel: unchanged — title from the first line, notes = text + link, report body =
--      the text.
--   6. Sweep: no task / feedback / notification / activity_log row of the company holds any word
--      of the private posts.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_private_to_task.test.sql

begin;

-- ── 0. shape ────────────────────────────────────────────────────────────────────────
do $$
declare
  v_sig text;
  v_p record;
begin
  foreach v_sig in array array[
    'public.chat_message_to_task(uuid,uuid,timestamptz)',
    'public.chat_message_report(uuid)'] loop
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
-- a1 owner, a2 accountant, a3 sales, a5 manager, a7 sales (outsider: in no private room),
-- b1 owner of company B
insert into auth.users (id, email) values
  ('c2328000-0000-0000-0000-0000000000a1', 'r2328-owner@example.test'),
  ('c2328000-0000-0000-0000-0000000000a2', 'r2328-acct@example.test'),
  ('c2328000-0000-0000-0000-0000000000a3', 'r2328-sales@example.test'),
  ('c2328000-0000-0000-0000-0000000000a5', 'r2328-mgr@example.test'),
  ('c2328000-0000-0000-0000-0000000000a7', 'r2328-outsider@example.test'),
  ('c2328000-0000-0000-0000-0000000000b1', 'r2328-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2328000-0000-0000-0000-0000000000f1', 'R2328 A', 'r2328-a@example.test', '07', 'RTCA'),
  ('c2328000-0000-0000-0000-0000000000f2', 'R2328 B', 'r2328-b@example.test', '07', 'RTCB');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2328000-0000-0000-0000-0000000000a1', 'c2328000-0000-0000-0000-0000000000f1', 'r2328-owner@example.test',    'Owner',      'owner',      true),
  ('c2328000-0000-0000-0000-0000000000a2', 'c2328000-0000-0000-0000-0000000000f1', 'r2328-acct@example.test',     'Accountant', 'accountant', true),
  ('c2328000-0000-0000-0000-0000000000a3', 'c2328000-0000-0000-0000-0000000000f1', 'r2328-sales@example.test',    'Sales',      'sales',      true),
  ('c2328000-0000-0000-0000-0000000000a5', 'c2328000-0000-0000-0000-0000000000f1', 'r2328-mgr@example.test',      'Manager',    'manager',    true),
  ('c2328000-0000-0000-0000-0000000000a7', 'c2328000-0000-0000-0000-0000000000f1', 'r2328-outsider@example.test', 'Outsider',   'sales',      true),
  ('c2328000-0000-0000-0000-0000000000b1', 'c2328000-0000-0000-0000-0000000000f2', 'r2328-owner-b@example.test',  'Owner B',    'owner',      true);

insert into public.customers (id, tenant_id, name) values
  ('c2328000-0000-0000-0000-0000000000d1', 'c2328000-0000-0000-0000-0000000000f1', 'R2328 Client X');

-- cd = DM owner <-> accountant; cp = private channel (owner, acct, sales, manager);
-- cg = public channel (owner, acct)
insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, dm_key, created_by) values
  ('c2328000-0000-0000-0000-0000000000cd', 'c2328000-0000-0000-0000-0000000000f1', 'dm', null, null, true,
   'c2328000-0000-0000-0000-0000000000a1:c2328000-0000-0000-0000-0000000000a2', 'c2328000-0000-0000-0000-0000000000a1'),
  ('c2328000-0000-0000-0000-0000000000cf', 'c2328000-0000-0000-0000-0000000000f1', 'channel', 'hr', 'hr', true, null,
   'c2328000-0000-0000-0000-0000000000a1'),
  ('c2328000-0000-0000-0000-0000000000ce', 'c2328000-0000-0000-0000-0000000000f1', 'channel', 'general', 'general', false, null,
   'c2328000-0000-0000-0000-0000000000a1');
insert into public.chat_members (tenant_id, channel_id, user_id, member_role) values
  ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000cd', 'c2328000-0000-0000-0000-0000000000a1', 'member'),
  ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000cd', 'c2328000-0000-0000-0000-0000000000a2', 'member'),
  ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000cf', 'c2328000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000cf', 'c2328000-0000-0000-0000-0000000000a2', 'member'),
  ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000cf', 'c2328000-0000-0000-0000-0000000000a3', 'member'),
  ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000cf', 'c2328000-0000-0000-0000-0000000000a5', 'member'),
  ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000ce', 'c2328000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000ce', 'c2328000-0000-0000-0000-0000000000a2', 'member');

-- the private words: "zebrasecret" (DM) and "okapisecret" (private channel)
insert into public.chat_messages (id, tenant_id, channel_id, author_id, body, kind, post_status, links) values
  -- DM, the accountant's problem (with a customer link + an image)
  ('c2328000-0000-0000-0000-0000000000e1', 'c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000cd',
   'c2328000-0000-0000-0000-0000000000a2', E'zebrasecret salary issue\nmore zebrasecret detail', 'problem', 'open',
   '[{"type":"customer","id":"c2328000-0000-0000-0000-0000000000d1"}]'::jsonb),
  -- DM, the accountant's second problem (for the report)
  ('c2328000-0000-0000-0000-0000000000e2', 'c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000cd',
   'c2328000-0000-0000-0000-0000000000a2', 'zebrasecret laptop broken', 'problem', 'open', '[]'::jsonb),
  -- private channel, the sales person's suggestion
  ('c2328000-0000-0000-0000-0000000000e3', 'c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000cf',
   'c2328000-0000-0000-0000-0000000000a3', E'okapisecret leave policy\nokapisecret more', 'suggestion', 'open', '[]'::jsonb),
  -- public channel, the accountant's problem
  ('c2328000-0000-0000-0000-0000000000e4', 'c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000ce',
   'c2328000-0000-0000-0000-0000000000a2', E'Printer jam on floor 2\nsince morning', 'problem', 'open', '[]'::jsonb);

insert into public.chat_attachments (tenant_id, message_id, channel_id, file_path, file_name, mime, size_bytes, uploaded_by) values
  ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000e2', 'c2328000-0000-0000-0000-0000000000cd',
   'c2328000-0000-0000-0000-0000000000f1/chat/c2328000-0000-0000-0000-0000000000cd/a_shot.png', 'shot.png', 'image/png', 500,
   'c2328000-0000-0000-0000-0000000000a2');

create temp table r2328_ids (k text primary key, v uuid);
grant all on r2328_ids to authenticated;

set local role authenticated;

create or replace function pg_temp.r2328_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.r2328_refused(p_case text, p_sql text, p_state text, p_like text)
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

-- ── 1. refused: not the poster in a DM / private channel; non-member; other company ──
do $$
declare
  v_e1 text := 'c2328000-0000-0000-0000-0000000000e1';
  v_e3 text := 'c2328000-0000-0000-0000-0000000000e3';
begin
  -- the OWNER is in the DM, but it is the accountant's post
  perform pg_temp.r2328_as('c2328000-0000-0000-0000-0000000000a1');
  perform pg_temp.r2328_refused('1 owner DM task', format('select public.chat_message_to_task(%L)', v_e1), '42501', '%poster%');
  perform pg_temp.r2328_refused('1 owner DM report', format('select public.chat_message_report(%L)', v_e1), '42501', '%poster%');
  -- the owner and a MANAGER in the private channel, on the sales person's post
  perform pg_temp.r2328_refused('1 owner private task', format('select public.chat_message_to_task(%L)', v_e3), '42501', '%poster%');
  perform pg_temp.r2328_refused('1 owner private report', format('select public.chat_message_report(%L)', v_e3), '42501', '%poster%');
  perform pg_temp.r2328_as('c2328000-0000-0000-0000-0000000000a5');
  perform pg_temp.r2328_refused('1 manager private task', format('select public.chat_message_to_task(%L)', v_e3), '42501', '%poster%');
  perform pg_temp.r2328_refused('1 manager private report', format('select public.chat_message_report(%L)', v_e3), '42501', '%poster%');
  -- a plain member of the private channel
  perform pg_temp.r2328_as('c2328000-0000-0000-0000-0000000000a2');
  perform pg_temp.r2328_refused('1 member private task', format('select public.chat_message_to_task(%L)', v_e3), '42501', '%poster%');
  -- not in the DM (manager, outsider) → not found
  perform pg_temp.r2328_as('c2328000-0000-0000-0000-0000000000a5');
  perform pg_temp.r2328_refused('1 manager not in DM', format('select public.chat_message_to_task(%L)', v_e1), 'P0002', '%not found%');
  perform pg_temp.r2328_as('c2328000-0000-0000-0000-0000000000a7');
  perform pg_temp.r2328_refused('1 outsider DM report', format('select public.chat_message_report(%L)', v_e1), 'P0002', '%not found%');
  perform pg_temp.r2328_refused('1 outsider private task', format('select public.chat_message_to_task(%L)', v_e3), 'P0002', '%not found%');
  -- another company
  perform pg_temp.r2328_as('c2328000-0000-0000-0000-0000000000b1');
  perform pg_temp.r2328_refused('1 B task', format('select public.chat_message_to_task(%L)', v_e1), 'P0002', '%not found%');
  perform pg_temp.r2328_refused('1 B report', format('select public.chat_message_report(%L)', v_e3), 'P0002', '%not found%');
end $$;

reset role;
do $$
begin
  if exists (select 1 from public.tasks where tenant_id in ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000f2'))
     or exists (select 1 from public.feedback where tenant_id in ('c2328000-0000-0000-0000-0000000000f1', 'c2328000-0000-0000-0000-0000000000f2')) then
    raise exception 'FAIL 1: a refused call wrote a task or a report';
  end if;
  if exists (select 1 from public.chat_messages where tenant_id = 'c2328000-0000-0000-0000-0000000000f1'
              and (kind = 'system' or task_id is not null or feedback_id is not null or post_status <> 'open')) then
    raise exception 'FAIL 1: a refused call changed a message or added a reply';
  end if;
end $$;
set local role authenticated;

-- ── 2–5. the posters act ────────────────────────────────────────────────────────────
do $$
declare
  v_id uuid;
begin
  -- 2. DM post → task for the outsider (not in the DM)
  perform pg_temp.r2328_as('c2328000-0000-0000-0000-0000000000a2');
  v_id := public.chat_message_to_task('c2328000-0000-0000-0000-0000000000e1', 'c2328000-0000-0000-0000-0000000000a7');
  insert into r2328_ids values ('t_dm', v_id);
  -- 3. DM post → report
  v_id := public.chat_message_report('c2328000-0000-0000-0000-0000000000e2');
  insert into r2328_ids values ('f_dm', v_id);
  -- 5. public post → task + report
  v_id := public.chat_message_to_task('c2328000-0000-0000-0000-0000000000e4');
  insert into r2328_ids values ('t_pub', v_id);
  v_id := public.chat_message_report('c2328000-0000-0000-0000-0000000000e4');
  insert into r2328_ids values ('f_pub', v_id);
  -- 4. private channel post → task (for the outsider) + report, by its poster
  perform pg_temp.r2328_as('c2328000-0000-0000-0000-0000000000a3');
  v_id := public.chat_message_to_task('c2328000-0000-0000-0000-0000000000e3', 'c2328000-0000-0000-0000-0000000000a7');
  insert into r2328_ids values ('t_priv', v_id);
  v_id := public.chat_message_report('c2328000-0000-0000-0000-0000000000e3');
  insert into r2328_ids values ('f_priv', v_id);
end $$;

reset role;
do $$
declare
  v_t record;
  v_f record;
  v_n int;
begin
  -- 2. DM task
  select * into v_t from public.tasks where id = (select v from r2328_ids where k = 't_dm');
  if v_t.title <> 'Team chat post (private)' then
    raise exception 'FAIL 2: DM task title is "%" — expected the neutral "Team chat post (private)"', v_t.title;
  end if;
  if v_t.notes <> 'From team chat: /team-chat?c=c2328000-0000-0000-0000-0000000000cd&m=c2328000-0000-0000-0000-0000000000e1' then
    raise exception 'FAIL 2: DM task notes are "%" — expected only the link back', v_t.notes;
  end if;
  if v_t.customer_id is not null or v_t.lead_id is not null or v_t.quote_id is not null or v_t.subscription_id is not null then
    raise exception 'FAIL 2: DM task copied a record link (customer %)', v_t.customer_id;
  end if;
  if v_t.owner_id is distinct from 'c2328000-0000-0000-0000-0000000000a7'::uuid then
    raise exception 'FAIL 2: DM task owner is %', v_t.owner_id;
  end if;
  select count(*) into v_n from public.notifications
   where user_id = 'c2328000-0000-0000-0000-0000000000a7' and kind = 'task.assigned';
  if v_n <> 2 then raise exception 'FAIL 2/4: the outsider should get 2 task.assigned notifications, got %', v_n; end if;
  if (select post_status from public.chat_messages where id = 'c2328000-0000-0000-0000-0000000000e1') <> 'task' then
    raise exception 'FAIL 2: the DM post should be marked task';
  end if;

  -- 3. DM report
  select * into v_f from public.feedback where id = (select v from r2328_ids where k = 'f_dm');
  if v_f.title <> 'Team chat post (private)'
     or v_f.page_path <> '/team-chat?c=c2328000-0000-0000-0000-0000000000cd&m=c2328000-0000-0000-0000-0000000000e2'
     or v_f.body not like '%/team-chat?c=c2328000-0000-0000-0000-0000000000cd&m=c2328000-0000-0000-0000-0000000000e2%'
     or v_f.reported_type <> 'bug' then
    raise exception 'FAIL 3: DM report is %', row_to_json(v_f);
  end if;
  if exists (select 1 from public.feedback_screenshots where feedback_id = v_f.id) then
    raise exception 'FAIL 3: a DM image was attached to the report';
  end if;

  -- 4. private channel task + report
  select * into v_t from public.tasks where id = (select v from r2328_ids where k = 't_priv');
  if v_t.title <> 'Team chat post (private)'
     or v_t.notes <> 'From team chat: /team-chat?c=c2328000-0000-0000-0000-0000000000cf&m=c2328000-0000-0000-0000-0000000000e3' then
    raise exception 'FAIL 4: private task is "%" / "%"', v_t.title, v_t.notes;
  end if;
  select * into v_f from public.feedback where id = (select v from r2328_ids where k = 'f_priv');
  if v_f.title <> 'Team chat post (private)' or v_f.reported_type <> 'feature' then
    raise exception 'FAIL 4: private report is %', row_to_json(v_f);
  end if;

  -- 5. public channel: unchanged
  select * into v_t from public.tasks where id = (select v from r2328_ids where k = 't_pub');
  if v_t.title <> 'Problem: Printer jam on floor 2'
     or v_t.notes not like E'Printer jam on floor 2\nsince morning%'
     or v_t.notes not like '%/team-chat?c=c2328000-0000-0000-0000-0000000000ce&m=c2328000-0000-0000-0000-0000000000e4' then
    raise exception 'FAIL 5: public task changed: "%" / "%"', v_t.title, v_t.notes;
  end if;
  select * into v_f from public.feedback where id = (select v from r2328_ids where k = 'f_pub');
  if v_f.title <> 'Printer jam on floor 2' or v_f.body not like E'Printer jam on floor 2\nsince morning%' then
    raise exception 'FAIL 5: public report changed: %', row_to_json(v_f);
  end if;

  -- 6. sweep: no private word anywhere the whole company (or the platform) can read
  if exists (select 1 from public.tasks where tenant_id = 'c2328000-0000-0000-0000-0000000000f1'
              and (title ~ '(zebra|okapi)secret' or coalesce(notes, '') ~ '(zebra|okapi)secret')) then
    raise exception 'FAIL 6: a task holds private chat text';
  end if;
  if exists (select 1 from public.feedback where tenant_id = 'c2328000-0000-0000-0000-0000000000f1'
              and (title ~ '(zebra|okapi)secret' or coalesce(body, '') ~ '(zebra|okapi)secret')) then
    raise exception 'FAIL 6: a report holds private chat text';
  end if;
  if exists (select 1 from public.notifications where tenant_id = 'c2328000-0000-0000-0000-0000000000f1'
              and (coalesce(title, '') ~ '(zebra|okapi)secret' or coalesce(body, '') ~ '(zebra|okapi)secret')) then
    raise exception 'FAIL 6: a notification holds private chat text';
  end if;
  if exists (select 1 from public.activity_log where tenant_id = 'c2328000-0000-0000-0000-0000000000f1'
              and (coalesce(label, '') ~ '(zebra|okapi)secret' or coalesce(changes::text, '') ~ '(zebra|okapi)secret')) then
    raise exception 'FAIL 6: the activity log holds private chat text';
  end if;
end $$;

do $$ begin raise notice 'team_chat_private_to_task: all checks passed'; end $$;

rollback;
