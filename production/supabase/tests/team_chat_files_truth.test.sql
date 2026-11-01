-- R-2332 (G-TEAMCHAT, 1 Nov 2026) — team chat files: storage is the truth.
-- Migration: 20261101021737_r2332_chat_files_storage_truth.sql. Found by the R-2305 audit:
--   #5 a removed / orphan file stayed visible to every reader of the channel;
--   #6 chat_post_message trusted the caller's mime / size / path;
--   #7 a member could upload straight to storage, skipping the upload route's checks.
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting; all fail before the migration)
--   0. Shape: ticket functions are service_role only; the ticket table is closed to browsers.
--   1. Direct upload (#7): no ticket → refused; another user's ticket → refused; an expired
--      ticket → refused; the caller's own open ticket → stored; after the route closes the
--      ticket the same path cannot be uploaded again. A ticket is refused for another
--      company's folder, a bad shape and a partner login.
--   2. Read (#5): a file on no message is seen by its uploader and the owner, not by the other
--      readers of the channel.
--   3. Post (#6): mime / size are storage's (the caller's text/html + 1 byte are ignored); the
--      same path on a second message, twice in one message, a path never uploaded, someone
--      else's upload, an odd path, a stored text/html file, a stored 15 MB file and a file with
--      no size are all refused. Once on a message, the channel's readers see the file.
--   4. Delete (#5): a live message's file cannot be deleted from storage (uploader or owner);
--      after chat_delete_message the readers no longer see it and the uploader / owner can
--      delete it.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_files_truth.test.sql

begin;

-- ── 0. shape ────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.chat_upload_tickets') is null then
    raise exception 'FAIL 0: public.chat_upload_tickets is missing (R-2332 migration not applied)'; end if;
  if to_regprocedure('public.chat_upload_ticket_open(uuid,text)') is null
     or to_regprocedure('public.chat_upload_ticket_close(text)') is null
     or to_regprocedure('public.chat_stored_file(text)') is null then
    raise exception 'FAIL 0: an R-2332 function is missing'; end if;
  if has_function_privilege('authenticated', 'public.chat_upload_ticket_open(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.chat_upload_ticket_open(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.chat_upload_ticket_close(text)', 'EXECUTE') then
    raise exception 'FAIL 0: a browser login can open / close an upload ticket'; end if;
  if not has_function_privilege('service_role', 'public.chat_upload_ticket_open(uuid,text)', 'EXECUTE') then
    raise exception 'FAIL 0: the upload route (service_role) cannot open a ticket'; end if;
  if has_table_privilege('authenticated', 'public.chat_upload_tickets', 'SELECT')
     or has_table_privilege('authenticated', 'public.chat_upload_tickets', 'INSERT') then
    raise exception 'FAIL 0: authenticated can read / write chat_upload_tickets'; end if;
  if has_function_privilege('anon', 'public.chat_stored_file(text)', 'EXECUTE') then
    raise exception 'FAIL 0: anon can call chat_stored_file'; end if;
  raise notice 'PASS 0: tickets are the route''s only';
end $$;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2332000-0000-0000-0000-0000000000a1', 'r2332-owner@example.test'),
  ('c2332000-0000-0000-0000-0000000000a2', 'r2332-acct@example.test'),
  ('c2332000-0000-0000-0000-0000000000a3', 'r2332-sales@example.test'),
  ('c2332000-0000-0000-0000-0000000000a4', 'r2332-partner@example.test'),
  ('c2332000-0000-0000-0000-0000000000b1', 'r2332-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2332000-0000-0000-0000-0000000000f1', 'R2332 A', 'r2332-a@example.test', '07', 'RFTA'),
  ('c2332000-0000-0000-0000-0000000000f2', 'R2332 B', 'r2332-b@example.test', '07', 'RFTB');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2332000-0000-0000-0000-0000000000a1', 'c2332000-0000-0000-0000-0000000000f1', 'r2332-owner@example.test',   'Owner',      'owner',         true),
  ('c2332000-0000-0000-0000-0000000000a2', 'c2332000-0000-0000-0000-0000000000f1', 'r2332-acct@example.test',    'Accountant', 'accountant',    true),
  ('c2332000-0000-0000-0000-0000000000a3', 'c2332000-0000-0000-0000-0000000000f1', 'r2332-sales@example.test',   'Sales',      'sales',         true),
  ('c2332000-0000-0000-0000-0000000000a4', 'c2332000-0000-0000-0000-0000000000f1', 'r2332-partner@example.test', 'Partner',    'partner_agent', true),
  ('c2332000-0000-0000-0000-0000000000b1', 'c2332000-0000-0000-0000-0000000000f2', 'r2332-owner-b@example.test', 'Owner B',    'owner',         true);

insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, created_by) values
  ('c2332000-0000-0000-0000-0000000000c1', 'c2332000-0000-0000-0000-0000000000f1', 'channel', 'general', 'general', false, 'c2332000-0000-0000-0000-0000000000a1');
insert into public.chat_members (tenant_id, channel_id, user_id, member_role) values
  ('c2332000-0000-0000-0000-0000000000f1', 'c2332000-0000-0000-0000-0000000000c1', 'c2332000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2332000-0000-0000-0000-0000000000f1', 'c2332000-0000-0000-0000-0000000000c1', 'c2332000-0000-0000-0000-0000000000a2', 'member'),
  ('c2332000-0000-0000-0000-0000000000f1', 'c2332000-0000-0000-0000-0000000000c1', 'c2332000-0000-0000-0000-0000000000a3', 'member');

-- paths used below (folder = tenant A / #general)
create temp table r2332_p (k text primary key, v text);
insert into r2332_p values
  ('dir',      'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/'),
  ('quote',    'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/11111111-1111-4111-8111-111111111111_quote.pdf'),
  ('noticket', 'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/22222222-2222-4222-8222-222222222222_page.pdf'),
  ('acctkt',   'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/33333333-3333-4333-8333-333333333333_acct.pdf'),
  ('expired',  'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/44444444-4444-4444-8444-444444444444_old.pdf'),
  ('html',     'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/55555555-5555-4555-8555-555555555555_page.pdf'),
  ('huge',     'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/66666666-6666-4666-8666-666666666666_big.pdf'),
  ('nosize',   'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/77777777-7777-4777-8777-777777777777_n.pdf'),
  ('second',   'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/88888888-8888-4888-8888-888888888888_shot.png'),
  ('never',    'c2332000-0000-0000-0000-0000000000f1/chat/c2332000-0000-0000-0000-0000000000c1/99999999-9999-4999-8999-999999999999_ghost.pdf');
grant select on r2332_p to authenticated, service_role;
create temp table r2332_ids (k text primary key, v uuid);
grant all on r2332_ids to authenticated;

-- stored as if a browser had pushed them (superuser = no rule): sales's text/html "pdf", a 15 MB
-- file and one with no size — they reach chat_post_message only through its own checks
insert into storage.objects (bucket_id, name, owner, metadata)
select 'documents', v, 'c2332000-0000-0000-0000-0000000000a3', m::jsonb
  from r2332_p join (values
    ('html',   '{"mimetype":"text/html","size":200}'),
    ('huge',   '{"mimetype":"application/pdf","size":15728640}'),
    ('nosize', '{"mimetype":"application/pdf"}')) as x(k, m) using (k);

create function pg_temp.p(p_k text) returns text language sql as $$ select v from r2332_p where k = p_k $$;
create function pg_temp.as_user(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true)
$$;
-- an upload as the CURRENT caller (what storage-api does with the caller's session)
create function pg_temp.upload_refused(p_name text, p_owner uuid, p_meta jsonb) returns boolean
language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', p_name, p_owner, p_meta);
  return false;
exception when insufficient_privilege then
  return true;
end $$;
create function pg_temp.seen(p_name text) returns int language sql as $$
  select count(*)::int from storage.objects where bucket_id = 'documents' and name = p_name
$$;
create function pg_temp.refused(p_case text, p_sql text, p_like text) returns void
language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not ilike p_like then
      raise exception 'FAIL %: refused with "%" — expected "%"', p_case, v_msg, p_like;
    end if;
    return;
  end;
  raise exception 'FAIL %: was NOT refused (expected "%")', p_case, p_like;
end $$;
grant execute on function pg_temp.p(text), pg_temp.as_user(uuid), pg_temp.upload_refused(text, uuid, jsonb),
  pg_temp.seen(text), pg_temp.refused(text, text, text) to authenticated, service_role;

-- the upload route opens tickets (service_role): sales for quote / second / expired, the
-- accountant for acctkt; expired is pushed 11 minutes back
set local role service_role;
do $$
begin
  perform public.chat_upload_ticket_open('c2332000-0000-0000-0000-0000000000a3', pg_temp.p('quote'));
  perform public.chat_upload_ticket_open('c2332000-0000-0000-0000-0000000000a3', pg_temp.p('second'));
  perform public.chat_upload_ticket_open('c2332000-0000-0000-0000-0000000000a3', pg_temp.p('expired'));
  perform public.chat_upload_ticket_open('c2332000-0000-0000-0000-0000000000a2', pg_temp.p('acctkt'));

  perform pg_temp.refused('1 ticket in another company''s folder',
    format('select public.chat_upload_ticket_open(%L, %L)', 'c2332000-0000-0000-0000-0000000000b1', pg_temp.p('noticket')),
    '%path%');
  perform pg_temp.refused('1 ticket for a bad shape',
    format('select public.chat_upload_ticket_open(%L, %L)', 'c2332000-0000-0000-0000-0000000000a3', pg_temp.p('dir') || 'x_bill.pdf'),
    '%path%');
  perform pg_temp.refused('1 ticket for a partner login',
    format('select public.chat_upload_ticket_open(%L, %L)', 'c2332000-0000-0000-0000-0000000000a4', pg_temp.p('noticket')),
    '%team chat user%');
end $$;
reset role;
update public.chat_upload_tickets set created_at = clock_timestamp() - interval '11 minutes'
 where path = pg_temp.p('expired');

set local role authenticated;

-- ── 1. direct upload (#7) ───────────────────────────────────────────────────────────
do $$
declare
  me  uuid := 'c2332000-0000-0000-0000-0000000000a3';
  pdf jsonb := '{"mimetype":"application/pdf","size":1200}';
begin
  perform pg_temp.as_user(me);
  if not pg_temp.upload_refused(pg_temp.p('noticket'), me, pdf) then
    raise exception 'FAIL 1: a member uploaded straight to storage with no ticket (skips the route''s checks)'; end if;
  if not pg_temp.upload_refused(pg_temp.p('acctkt'), me, pdf) then
    raise exception 'FAIL 1: sales uploaded on the accountant''s ticket'; end if;
  if not pg_temp.upload_refused(pg_temp.p('expired'), me, pdf) then
    raise exception 'FAIL 1: an expired ticket still let an upload in'; end if;
  if pg_temp.upload_refused(pg_temp.p('quote'), me, pdf) then
    raise exception 'FAIL 1: the route''s upload (own open ticket) was refused'; end if;
  if pg_temp.upload_refused(pg_temp.p('second'), me, '{"mimetype":"image/png","size":500}') then
    raise exception 'FAIL 1: the route''s second upload was refused'; end if;
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a2');
  if pg_temp.upload_refused(pg_temp.p('acctkt'), 'c2332000-0000-0000-0000-0000000000a2', pdf) then
    raise exception 'FAIL 1: the accountant''s route upload was refused'; end if;
  raise notice 'PASS 1a: only an upload with its own open ticket is stored';
end $$;

-- the route closes its tickets; a removed file cannot come back on the old ticket
reset role;
set local role service_role;
select public.chat_upload_ticket_close(pg_temp.p('quote'));
select public.chat_upload_ticket_close(pg_temp.p('second'));
select public.chat_upload_ticket_close(pg_temp.p('acctkt'));
reset role;
set local role authenticated;
do $$ begin perform set_config('storage.allow_delete_query', 'true', true); end $$;  -- the Storage API sets this
do $$
declare
  me  uuid := 'c2332000-0000-0000-0000-0000000000a3';
  v_n int;
begin
  perform pg_temp.as_user(me);
  delete from storage.objects where bucket_id = 'documents' and name = pg_temp.p('quote');
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 1: the uploader could not remove its own unsent file (% rows)', v_n; end if;
  if not pg_temp.upload_refused(pg_temp.p('quote'), me, '{"mimetype":"text/html","size":10}') then
    raise exception 'FAIL 1: a closed ticket let other bytes in under the same path'; end if;
  raise notice 'PASS 1b: tickets are single-use';
end $$;

-- put quote back the way the route would (new ticket, upload, close)
reset role;
set local role service_role;
select public.chat_upload_ticket_open('c2332000-0000-0000-0000-0000000000a3', pg_temp.p('quote'));
reset role;
set local role authenticated;
do $$
begin
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a3');
  if pg_temp.upload_refused(pg_temp.p('quote'), 'c2332000-0000-0000-0000-0000000000a3', '{"mimetype":"application/pdf","size":1200}') then
    raise exception 'FAIL 1: re-upload with a fresh ticket was refused'; end if;
end $$;
reset role;
set local role service_role;
select public.chat_upload_ticket_close(pg_temp.p('quote'));
reset role;
set local role authenticated;

-- ── 2. read (#5): a file on no message ──────────────────────────────────────────────
do $$
begin
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a2');
  if pg_temp.seen(pg_temp.p('quote')) <> 0 then
    raise exception 'FAIL 2: another reader of the channel sees a file that is on no message'; end if;
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a3');
  if pg_temp.seen(pg_temp.p('quote')) <> 1 then
    raise exception 'FAIL 2: the uploader does not see its own unsent file'; end if;
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a1');
  if pg_temp.seen(pg_temp.p('quote')) <> 1 then
    raise exception 'FAIL 2: the owner does not see an unsent file in a channel it reads'; end if;
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000b1');
  if pg_temp.seen(pg_temp.p('quote')) <> 0 then
    raise exception 'FAIL 2: another company sees the file'; end if;
  raise notice 'PASS 2: an unsent file is seen by its uploader and the owner only';
end $$;

-- ── 3. post (#6) ────────────────────────────────────────────────────────────────────
do $$
declare
  v_id  uuid;
  v_row record;
  att   text := '[{"path":"%s","name":"%s","mime":"%s","size":%s}]';
  q     text := $q$select public.chat_post_message('c2332000-0000-0000-0000-0000000000c1', 'x', 'text', null, '{}'::uuid[], '[]'::jsonb, %L::jsonb)$q$;
begin
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a3');
  -- the caller lies: text/html, 1 byte → storage's application/pdf, 1200 are kept
  v_id := public.chat_post_message('c2332000-0000-0000-0000-0000000000c1', 'the quote', 'text', null, '{}'::uuid[], '[]'::jsonb,
    format(att, pg_temp.p('quote'), 'Quote Oct.pdf', 'text/html', 1)::jsonb);
  insert into r2332_ids values ('m1', v_id);
  select a.mime, a.size_bytes, a.file_name into v_row from public.chat_attachments a where a.message_id = v_id;
  if v_row.mime is distinct from 'application/pdf' or v_row.size_bytes is distinct from 1200 then
    raise exception 'FAIL 3: the attachment kept the caller''s type / size (%, %), not storage''s', v_row.mime, v_row.size_bytes; end if;
  if v_row.file_name is distinct from 'Quote Oct.pdf' then
    raise exception 'FAIL 3: the display name was lost: %', v_row.file_name; end if;

  perform pg_temp.refused('3 same path on a second message', format(q, format(att, pg_temp.p('quote'), 'q.pdf', 'application/pdf', 1200)), '%already on another message%');
  perform pg_temp.refused('3 same path twice in one message',
    format(q, format('[{"path":"%s","name":"a.png"},{"path":"%s","name":"b.png"}]', pg_temp.p('second'), pg_temp.p('second'))), '%twice%');
  perform pg_temp.refused('3 a path never uploaded', format(q, format(att, pg_temp.p('never'), 'g.pdf', 'application/pdf', 10)), '%not uploaded by you%');
  perform pg_temp.refused('3 someone else''s upload', format(q, format(att, pg_temp.p('acctkt'), 'a.pdf', 'application/pdf', 10)), '%not uploaded by you%');
  perform pg_temp.refused('3 an odd path', format(q, format(att, pg_temp.p('dir') || 'x_bill.pdf', 'b.pdf', 'application/pdf', 10)), '%folder%');
  perform pg_temp.refused('3 a nested path', format(q, format(att, pg_temp.p('dir') || 'sub/11111111-1111-4111-8111-111111111112_b.pdf', 'b.pdf', 'application/pdf', 10)), '%folder%');
  perform pg_temp.refused('3 stored text/html', format(q, format(att, pg_temp.p('html'), 'page.pdf', 'application/pdf', 200)), '%type%');
  perform pg_temp.refused('3 stored 15 MB', format(q, format(att, pg_temp.p('huge'), 'big.pdf', 'application/pdf', 1000)), '%10 MB%');
  perform pg_temp.refused('3 stored with no size', format(q, format(att, pg_temp.p('nosize'), 'n.pdf', 'application/pdf', 1000)), '%10 MB%');

  v_id := public.chat_post_message('c2332000-0000-0000-0000-0000000000c1', 'screenshot', 'text', null, '{}'::uuid[], '[]'::jsonb,
    format('[{"path":"%s","name":"shot.png"}]', pg_temp.p('second'))::jsonb);   -- no mime/size sent at all
  insert into r2332_ids values ('m2', v_id);
  if (select a.mime from public.chat_attachments a where a.message_id = v_id) is distinct from 'image/png' then
    raise exception 'FAIL 3: an attachment without a sent type did not take storage''s'; end if;

  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a2');
  if pg_temp.seen(pg_temp.p('quote')) <> 1 or pg_temp.seen(pg_temp.p('second')) <> 1 then
    raise exception 'FAIL 3: a reader of the channel cannot see a file that is on a message'; end if;
  raise notice 'PASS 3: attachment type / size / path are storage''s; one message per file';
end $$;

-- ── 4. delete (#5) ──────────────────────────────────────────────────────────────────
do $$
declare
  v_n   int;
  v_res jsonb;
begin
  -- a live message's file stays put — for its uploader and for the owner
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a3');
  delete from storage.objects where bucket_id = 'documents' and name = pg_temp.p('quote');
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: the uploader pulled a file out from under a live message'; end if;
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a1');
  delete from storage.objects where bucket_id = 'documents' and name = pg_temp.p('second');
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: the owner pulled a file out from under a live message'; end if;

  -- sales deletes m1; even if its browser never removes the file, readers no longer see it
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a3');
  v_res := public.chat_delete_message((select v from r2332_ids where k = 'm1'));
  if v_res -> 'file_paths' <> jsonb_build_array(pg_temp.p('quote')) then
    raise exception 'FAIL 4: delete did not hand back the file path: %', v_res; end if;
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a2');
  if pg_temp.seen(pg_temp.p('quote')) <> 0 then
    raise exception 'FAIL 4: a deleted message''s file is still seen by the channel''s readers'; end if;
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a3');
  delete from storage.objects where bucket_id = 'documents' and name = pg_temp.p('quote');
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 4: the uploader could not remove a deleted message''s file (% rows)', v_n; end if;

  -- the owner deletes sales's m2 and removes its file
  perform pg_temp.as_user('c2332000-0000-0000-0000-0000000000a1');
  v_res := public.chat_delete_message((select v from r2332_ids where k = 'm2'));
  delete from storage.objects where bucket_id = 'documents' and name = pg_temp.p('second');
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 4: the owner could not remove the file of a message it deleted (% rows)', v_n; end if;
  raise notice 'PASS 4: files leave storage only once off their message';
end $$;

rollback;
