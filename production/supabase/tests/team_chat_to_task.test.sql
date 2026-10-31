-- R-2304 (G-TEAMCHAT TC-11, 31 Oct 2026) — a team chat Problem / Suggestion post becomes a Task
-- (chat_message_to_task) or a bug / idea report (chat_message_report).
-- Migration: 20261031183408_r2304_chat_post_to_task.sql (on top of R-2294 tables + R-2295 RPCs).
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   0. Shape: both RPCs exist, SECURITY DEFINER, search_path '', executable by authenticated,
--      never by anon.
--   1. The poster makes a task from an open problem for a teammate with a due date: exactly 1
--      task in the company, owner = that teammate, due date kept, delegated_by = the poster,
--      notes = the message text + the link back /team-chat?c=<channel>&m=<message>, customer_id
--      from the FIRST of lead/quote/customer/subscription links (an invoice link before it is
--      skipped); the message gets post_status 'task' + task_id; ONE system reply in its thread;
--      the new owner gets ONE 'task.assigned' notification opening /tasks?tab=all&task=<id>.
--   2. Idempotent: a second call returns the same task — no second task, no second reply.
--   3. Defaults: no owner / due → the caller owns it, due tomorrow; a lead link fills lead_id.
--   4. Refused: a plain text message, a deleted post, an owner from another company / inactive,
--      a member who is neither the poster nor owner/manager, a non-member (42501), another company
--      (not found), no login / partner (28000). Nothing is written by a refused call.
--   R-2328: #support is a PUBLIC channel here — a DM / private channel post keeps no text and
--   only its poster may use it; that is team_chat_private_to_task.test.sql.
--   5. All in one transaction: a task insert that fails (bad due date) leaves no task, no status.
--   6. Report: a problem → feedback 'bug', a suggestion → 'feature'; title = first line,
--      page_path = the link back, reported_by = the caller; image files become feedback
--      screenshots (a PDF does not); feedback_id stored, post_status 'reported' (a post that
--      already has a task keeps 'task'); 1 system reply; a second call returns the same report.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_to_task.test.sql

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
insert into auth.users (id, email) values
  ('c2304000-0000-0000-0000-0000000000a1', 'tc11-owner@example.test'),
  ('c2304000-0000-0000-0000-0000000000a2', 'tc11-acct@example.test'),
  ('c2304000-0000-0000-0000-0000000000a3', 'tc11-sales@example.test'),
  ('c2304000-0000-0000-0000-0000000000a4', 'tc11-partner@example.test'),
  ('c2304000-0000-0000-0000-0000000000a6', 'tc11-gone@example.test'),
  ('c2304000-0000-0000-0000-0000000000a7', 'tc11-outsider@example.test'),
  ('c2304000-0000-0000-0000-0000000000b1', 'tc11-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2304000-0000-0000-0000-0000000000f1', 'TC11 A', 'tc11-a@example.test', '07', 'TCBA'),
  ('c2304000-0000-0000-0000-0000000000f2', 'TC11 B', 'tc11-b@example.test', '07', 'TCBB');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2304000-0000-0000-0000-0000000000a1', 'c2304000-0000-0000-0000-0000000000f1', 'tc11-owner@example.test',    'Owner',      'owner',         true),
  ('c2304000-0000-0000-0000-0000000000a2', 'c2304000-0000-0000-0000-0000000000f1', 'tc11-acct@example.test',     'Accountant', 'accountant',    true),
  ('c2304000-0000-0000-0000-0000000000a3', 'c2304000-0000-0000-0000-0000000000f1', 'tc11-sales@example.test',    'Sales',      'sales',         true),
  ('c2304000-0000-0000-0000-0000000000a4', 'c2304000-0000-0000-0000-0000000000f1', 'tc11-partner@example.test',  'Partner',    'partner_agent', true),
  ('c2304000-0000-0000-0000-0000000000a6', 'c2304000-0000-0000-0000-0000000000f1', 'tc11-gone@example.test',     'Gone',       'sales',         false),
  ('c2304000-0000-0000-0000-0000000000a7', 'c2304000-0000-0000-0000-0000000000f1', 'tc11-outsider@example.test', 'Outsider',   'sales',         true),
  ('c2304000-0000-0000-0000-0000000000b1', 'c2304000-0000-0000-0000-0000000000f2', 'tc11-owner-b@example.test',  'Owner B',    'owner',         true);

insert into public.customers (id, tenant_id, name) values
  ('c2304000-0000-0000-0000-0000000000d1', 'c2304000-0000-0000-0000-0000000000f1', 'TC11 Client X'),
  ('c2304000-0000-0000-0000-0000000000d9', 'c2304000-0000-0000-0000-0000000000f2', 'TC11 B Client');
insert into public.leads (id, tenant_id, company) values
  ('TC11-LEAD-1', 'c2304000-0000-0000-0000-0000000000f1', 'TC11 Lead Co');

-- c1 #support (public — R-2328: private posts are team_chat_private_to_task.test.sql): owner,
-- acct, sales + a bad row for the partner; c9 tenant B
insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, created_by) values
  ('c2304000-0000-0000-0000-0000000000c1', 'c2304000-0000-0000-0000-0000000000f1', 'channel', 'support', 'support', false, 'c2304000-0000-0000-0000-0000000000a1'),
  ('c2304000-0000-0000-0000-0000000000c9', 'c2304000-0000-0000-0000-0000000000f2', 'channel', 'general', 'general', false, 'c2304000-0000-0000-0000-0000000000b1');
insert into public.chat_members (tenant_id, channel_id, user_id, member_role) values
  ('c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000c1', 'c2304000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000c1', 'c2304000-0000-0000-0000-0000000000a2', 'member'),
  ('c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000c1', 'c2304000-0000-0000-0000-0000000000a3', 'member'),
  ('c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000c1', 'c2304000-0000-0000-0000-0000000000a4', 'member'),
  ('c2304000-0000-0000-0000-0000000000f2', 'c2304000-0000-0000-0000-0000000000c9', 'c2304000-0000-0000-0000-0000000000b1', 'admin');

-- posts (written directly: the posting RPC is R-2295's, tested there)
insert into public.chat_messages (id, tenant_id, channel_id, author_id, body, kind, post_status, links) values
  ('c2304000-0000-0000-0000-0000000000e1', 'c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000c1',
   'c2304000-0000-0000-0000-0000000000a2', E'Client X DNS down\nsince 10 am', 'problem', 'open',
   '[{"type":"invoice","id":"INV-7"},{"type":"customer","id":"c2304000-0000-0000-0000-0000000000d1"},{"type":"lead","id":"TC11-LEAD-1"}]'::jsonb),
  ('c2304000-0000-0000-0000-0000000000e2', 'c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000c1',
   'c2304000-0000-0000-0000-0000000000a3', 'Add a dark mode', 'suggestion', 'open',
   '[{"type":"customer","id":"c2304000-0000-0000-0000-0000000000d9"},{"type":"lead","id":"TC11-LEAD-1"}]'::jsonb),
  ('c2304000-0000-0000-0000-0000000000e3', 'c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000c1',
   'c2304000-0000-0000-0000-0000000000a2', 'just text', 'text', null, '[]'::jsonb),
  ('c2304000-0000-0000-0000-0000000000e4', 'c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000c1',
   'c2304000-0000-0000-0000-0000000000a2', '', 'problem', 'open', '[]'::jsonb),
  ('c2304000-0000-0000-0000-0000000000e5', 'c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000c1',
   'c2304000-0000-0000-0000-0000000000a2', 'Printer jam', 'problem', 'open', '[]'::jsonb);
update public.chat_messages set deleted_at = now() where id = 'c2304000-0000-0000-0000-0000000000e4';

insert into public.chat_attachments (tenant_id, message_id, channel_id, file_path, file_name, mime, size_bytes, uploaded_by) values
  ('c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000e1', 'c2304000-0000-0000-0000-0000000000c1',
   'c2304000-0000-0000-0000-0000000000f1/chat/c2304000-0000-0000-0000-0000000000c1/a_shot.png', 'shot.png', 'image/png', 500, 'c2304000-0000-0000-0000-0000000000a2'),
  ('c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000e1', 'c2304000-0000-0000-0000-0000000000c1',
   'c2304000-0000-0000-0000-0000000000f1/chat/c2304000-0000-0000-0000-0000000000c1/b_bill.pdf', 'bill.pdf', 'application/pdf', 900, 'c2304000-0000-0000-0000-0000000000a2');

create temp table tc11_ids (k text primary key, v uuid);
grant all on tc11_ids to authenticated;

set local role authenticated;

create or replace function pg_temp.tc11_as(p_user uuid) returns void language plpgsql as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  end if;
end $$;

create or replace function pg_temp.tc11_refused(p_case text, p_sql text, p_state text, p_like text)
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

-- ── 4. refused calls first (nothing may be written by them) ─────────────────────────
do $$
declare
  v_e1 text := 'c2304000-0000-0000-0000-0000000000e1';
begin
  -- no login, partner (bad member row), deactivated → 28000
  perform pg_temp.tc11_as(null);
  perform pg_temp.tc11_refused('4 no login task', format('select public.chat_message_to_task(%L)', v_e1), '28000', '%team chat%');
  perform pg_temp.tc11_refused('4 no login report', format('select public.chat_message_report(%L)', v_e1), '28000', '%team chat%');
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a4');
  perform pg_temp.tc11_refused('4 partner task', format('select public.chat_message_to_task(%L)', v_e1), '28000', '%team chat%');
  perform pg_temp.tc11_refused('4 partner report', format('select public.chat_message_report(%L)', v_e1), '28000', '%team chat%');
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a6');
  perform pg_temp.tc11_refused('4 inactive task', format('select public.chat_message_to_task(%L)', v_e1), '28000', '%team chat%');

  -- another company: not found (no existence leak)
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000b1');
  perform pg_temp.tc11_refused('4 B task', format('select public.chat_message_to_task(%L)', v_e1), 'P0002', '%not found%');
  perform pg_temp.tc11_refused('4 B report', format('select public.chat_message_report(%L)', v_e1), 'P0002', '%not found%');

  -- a staff member who is not in the (public) channel: can read it, but is not a member
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a7');
  perform pg_temp.tc11_refused('4 non-member task', format('select public.chat_message_to_task(%L)', v_e1), '42501', '%not a member%');
  perform pg_temp.tc11_refused('4 non-member report', format('select public.chat_message_report(%L)', v_e1), '42501', '%not a member%');

  -- a member who is neither the poster nor owner/manager
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a3');
  perform pg_temp.tc11_refused('4 other member task', format('select public.chat_message_to_task(%L)', v_e1), '42501', '%poster%');
  perform pg_temp.tc11_refused('4 other member report', format('select public.chat_message_report(%L)', v_e1), '42501', '%poster%');

  -- the poster, but: a plain text message, a deleted post, a bad owner
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a2');
  perform pg_temp.tc11_refused('4 text message', $q$select public.chat_message_to_task('c2304000-0000-0000-0000-0000000000e3')$q$, '22023', '%problem or suggestion%');
  perform pg_temp.tc11_refused('4 text report', $q$select public.chat_message_report('c2304000-0000-0000-0000-0000000000e3')$q$, '22023', '%problem or suggestion%');
  perform pg_temp.tc11_refused('4 deleted', $q$select public.chat_message_to_task('c2304000-0000-0000-0000-0000000000e4')$q$, '22023', '%deleted%');
  perform pg_temp.tc11_refused('4 owner of B', format('select public.chat_message_to_task(%L, %L)', v_e1, 'c2304000-0000-0000-0000-0000000000b1'), 'P0002', '%teammate%');
  perform pg_temp.tc11_refused('4 inactive owner', format('select public.chat_message_to_task(%L, %L)', v_e1, 'c2304000-0000-0000-0000-0000000000a6'), 'P0002', '%teammate%');
  perform pg_temp.tc11_refused('4 partner owner', format('select public.chat_message_to_task(%L, %L)', v_e1, 'c2304000-0000-0000-0000-0000000000a4'), 'P0002', '%teammate%');
end $$;

reset role;
do $$
begin
  if exists (select 1 from public.tasks where tenant_id in ('c2304000-0000-0000-0000-0000000000f1', 'c2304000-0000-0000-0000-0000000000f2')) then
    raise exception 'FAIL 4: a refused call wrote a task';
  end if;
  if exists (select 1 from public.chat_messages where channel_id = 'c2304000-0000-0000-0000-0000000000c1'
              and (kind = 'system' or task_id is not null or feedback_id is not null or post_status not in ('open'))) then
    raise exception 'FAIL 4: a refused call changed a message or added a reply';
  end if;
  if exists (select 1 from public.feedback where tenant_id = 'c2304000-0000-0000-0000-0000000000f1') then
    raise exception 'FAIL 4: a refused call wrote a report';
  end if;
end $$;
set local role authenticated;

-- ── 1. the poster makes a task for sales, due 5 Nov ─────────────────────────────────
do $$
declare
  v_id uuid;
begin
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a2');
  v_id := public.chat_message_to_task('c2304000-0000-0000-0000-0000000000e1',
    'c2304000-0000-0000-0000-0000000000a3', '2026-11-05 10:00:00+05:30');
  insert into tc11_ids values ('t1', v_id);
  -- 2. idempotent
  if public.chat_message_to_task('c2304000-0000-0000-0000-0000000000e1') is distinct from v_id then
    raise exception 'FAIL 2: a second call made a different task';
  end if;
end $$;

reset role;
do $$
declare
  v_t record;
  v_m record;
  v_n int;
begin
  select count(*) into v_n from public.tasks where tenant_id = 'c2304000-0000-0000-0000-0000000000f1';
  if v_n <> 1 then raise exception 'FAIL 1/2: expected 1 task, got %', v_n; end if;
  select * into v_t from public.tasks where id = (select v from tc11_ids where k = 't1');
  if v_t.owner_id is distinct from 'c2304000-0000-0000-0000-0000000000a3'::uuid then
    raise exception 'FAIL 1: owner is %, expected sales', v_t.owner_id;
  end if;
  if v_t.due_at <> '2026-11-05 10:00:00+05:30'::timestamptz then
    raise exception 'FAIL 1: due_at is %', v_t.due_at;
  end if;
  if v_t.delegated_by is distinct from 'c2304000-0000-0000-0000-0000000000a2'::uuid or v_t.delegated_at is null then
    raise exception 'FAIL 1: delegated_by/at not set (%, %)', v_t.delegated_by, v_t.delegated_at;
  end if;
  if v_t.status <> 'pending' then raise exception 'FAIL 1: status %', v_t.status; end if;
  if v_t.title not like '%Client X DNS down%' or v_t.title like '%since 10 am%' then
    raise exception 'FAIL 1: title "%" should be the first line', v_t.title;
  end if;
  if v_t.notes not like E'Client X DNS down\nsince 10 am%'
     or v_t.notes not like '%/team-chat?c=c2304000-0000-0000-0000-0000000000c1&m=c2304000-0000-0000-0000-0000000000e1%' then
    raise exception 'FAIL 1: notes "%" need the message text and the link back', v_t.notes;
  end if;
  if v_t.customer_id is distinct from 'c2304000-0000-0000-0000-0000000000d1'::uuid
     or v_t.lead_id is not null or v_t.quote_id is not null or v_t.subscription_id is not null then
    raise exception 'FAIL 1: links — customer %, lead %, quote %, sub % (expected the customer only)',
      v_t.customer_id, v_t.lead_id, v_t.quote_id, v_t.subscription_id;
  end if;

  select post_status, task_id into v_m from public.chat_messages where id = 'c2304000-0000-0000-0000-0000000000e1';
  if v_m.post_status <> 'task' or v_m.task_id is distinct from v_t.id then
    raise exception 'FAIL 1: message status % / task_id %', v_m.post_status, v_m.task_id;
  end if;
  select count(*) into v_n from public.chat_messages
   where parent_id = 'c2304000-0000-0000-0000-0000000000e1' and kind = 'system'
     and body like '%task%' and body like '%Sales%';
  if v_n <> 1 then raise exception 'FAIL 1/2: expected 1 system reply naming the owner, got %', v_n; end if;
  select count(*) into v_n from public.notifications
   where user_id = 'c2304000-0000-0000-0000-0000000000a3' and kind = 'task.assigned'
     and href = '/tasks?tab=all&task=' || v_t.id::text;
  if v_n <> 1 then raise exception 'FAIL 1/2: the new owner should get 1 task.assigned notification, got %', v_n; end if;
end $$;
set local role authenticated;

-- ── 3. defaults: the OWNER makes a task from sales' suggestion (other company's customer is
--      skipped; the lead link fills lead_id); owner = caller, due tomorrow ───────────
do $$
declare
  v_id uuid;
begin
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a1');
  v_id := public.chat_message_to_task('c2304000-0000-0000-0000-0000000000e2');
  insert into tc11_ids values ('t2', v_id);
end $$;
reset role;
do $$
declare
  v_t record;
begin
  select * into v_t from public.tasks where id = (select v from tc11_ids where k = 't2');
  if v_t.owner_id is distinct from 'c2304000-0000-0000-0000-0000000000a1'::uuid or v_t.delegated_by is not null then
    raise exception 'FAIL 3: owner % delegated_by % (expected the caller, not delegated)', v_t.owner_id, v_t.delegated_by;
  end if;
  if (v_t.due_at at time zone 'Asia/Kolkata')::date <> (now() at time zone 'Asia/Kolkata')::date + 1 then
    raise exception 'FAIL 3: default due % is not tomorrow (IST)', v_t.due_at;
  end if;
  if v_t.lead_id is distinct from 'TC11-LEAD-1' or v_t.customer_id is not null then
    raise exception 'FAIL 3: lead % customer % (B''s customer must be skipped)', v_t.lead_id, v_t.customer_id;
  end if;
end $$;
set local role authenticated;

-- ── 5. one transaction: a failing task insert leaves nothing ────────────────────────
do $$
begin
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a2');
  perform pg_temp.tc11_refused('5 infinite due', $q$select public.chat_message_to_task('c2304000-0000-0000-0000-0000000000e5', null, 'infinity'::timestamptz)$q$, '22023', '%due%');
end $$;
reset role;
do $$
begin
  if exists (select 1 from public.chat_messages where id = 'c2304000-0000-0000-0000-0000000000e5'
              and (post_status <> 'open' or task_id is not null))
     or exists (select 1 from public.chat_messages where parent_id = 'c2304000-0000-0000-0000-0000000000e5') then
    raise exception 'FAIL 5: a refused call left a status or a reply';
  end if;
end $$;
set local role authenticated;

-- ── 6. report: problem e5 → bug; problem e1 (has a task) → bug, keeps 'task'; suggestion → feature
do $$
declare
  v_id uuid;
begin
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a2');
  v_id := public.chat_message_report('c2304000-0000-0000-0000-0000000000e1');
  insert into tc11_ids values ('f1', v_id);
  if public.chat_message_report('c2304000-0000-0000-0000-0000000000e1') is distinct from v_id then
    raise exception 'FAIL 6: a second report call made a different report';
  end if;
  v_id := public.chat_message_report('c2304000-0000-0000-0000-0000000000e5');
  insert into tc11_ids values ('f5', v_id);
  perform pg_temp.tc11_as('c2304000-0000-0000-0000-0000000000a3');
  v_id := public.chat_message_report('c2304000-0000-0000-0000-0000000000e2');
  insert into tc11_ids values ('f2', v_id);
end $$;
reset role;
do $$
declare
  v_f record;
  v_n int;
begin
  select count(*) into v_n from public.feedback where tenant_id = 'c2304000-0000-0000-0000-0000000000f1';
  if v_n <> 3 then raise exception 'FAIL 6: expected 3 reports, got %', v_n; end if;

  select * into v_f from public.feedback where id = (select v from tc11_ids where k = 'f1');
  if v_f.reported_type <> 'bug' or v_f.title <> 'Client X DNS down'
     or v_f.reported_by is distinct from 'c2304000-0000-0000-0000-0000000000a2'::uuid
     or v_f.reporter_name <> 'Accountant'
     or v_f.page_path <> '/team-chat?c=c2304000-0000-0000-0000-0000000000c1&m=c2304000-0000-0000-0000-0000000000e1'
     or v_f.body not like E'Client X DNS down\nsince 10 am%' then
    raise exception 'FAIL 6: report f1 is %', row_to_json(v_f);
  end if;
  select count(*) into v_n from public.feedback_screenshots where feedback_id = v_f.id;
  if v_n <> 1 or not exists (select 1 from public.feedback_screenshots
                              where feedback_id = v_f.id and file_name = 'shot.png'
                                and file_path like '%/chat/%/a_shot.png' and byte_size = 500) then
    raise exception 'FAIL 6: expected the 1 image as a screenshot (not the PDF), got %', v_n;
  end if;
  if (select feedback_id from public.chat_messages where id = 'c2304000-0000-0000-0000-0000000000e1') is distinct from v_f.id
     or (select post_status from public.chat_messages where id = 'c2304000-0000-0000-0000-0000000000e1') <> 'task' then
    raise exception 'FAIL 6: e1 must store feedback_id and keep post_status task';
  end if;
  if (select post_status from public.chat_messages where id = 'c2304000-0000-0000-0000-0000000000e5') <> 'reported'
     or (select feedback_id from public.chat_messages where id = 'c2304000-0000-0000-0000-0000000000e5')
        is distinct from (select v from tc11_ids where k = 'f5') then
    raise exception 'FAIL 6: e5 must be reported with its feedback_id';
  end if;
  if (select reported_type from public.feedback where id = (select v from tc11_ids where k = 'f2')) <> 'feature' then
    raise exception 'FAIL 6: a suggestion must be filed as feature';
  end if;
  select count(*) into v_n from public.chat_messages
   where parent_id = 'c2304000-0000-0000-0000-0000000000e1' and kind = 'system';
  if v_n <> 2 then raise exception 'FAIL 6: e1 should have 2 system replies (task + report), got %', v_n; end if;
end $$;

do $$ begin raise notice 'team_chat_to_task: all checks passed'; end $$;

rollback;
