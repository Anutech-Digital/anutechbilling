-- R-2297 (G-TEAMCHAT TC-04, 31 Oct 2026) — team chat files in the documents bucket.
-- Migration: 20261031115100_r2297_team_chat_storage.sql (chat branch in public.storage_object_allowed).
--
-- Path: {tenant}/chat/{channel_id}/{uuid}_{safe-name}. Before the migration the chat folder fell
-- into the default documents rule (owner/manager only), so a sales member could not upload or
-- open a file in their own channel — case 1 FAILS on the old function.
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   1. A member (sales) uploads into a public channel and a DM it is in, and reads the files there.
--   2. Non-members: cannot upload into a channel they are not in (public or private); cannot read
--      a private channel's or a DM's files — the OWNER included for a DM between two staff; a
--      staff non-member of a PUBLIC channel reads its files (same rule as the message rows,
--      chat_can_read) but still cannot upload there.
--   3. Another tenant: reads 0, cannot upload into tenant A's folder, nor into its own tenant
--      folder with tenant A's channel id.
--   4. Delete: the uploader deletes its own file; another member cannot; the tenant owner can
--      (in a channel it can read), not in a DM it is not in.
--   5. No replace (update) for anyone; the upload must carry the caller as owner.
--   6. Bad paths are refused: no uuid prefix, a non-uuid channel, extra folders, unsafe name.
--   7. partner_agent / personal / deactivated logins with a (bad) member row: nothing.
--   8. The rest of the documents rule is unchanged: sales cannot write the vault, owner can.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_storage.test.sql

begin;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2297000-0000-0000-0000-0000000000a1', 'tc04-owner@example.test'),
  ('c2297000-0000-0000-0000-0000000000a2', 'tc04-acct@example.test'),
  ('c2297000-0000-0000-0000-0000000000a3', 'tc04-sales@example.test'),
  ('c2297000-0000-0000-0000-0000000000a4', 'tc04-partner@example.test'),
  ('c2297000-0000-0000-0000-0000000000a6', 'tc04-gone@example.test'),
  ('c2297000-0000-0000-0000-0000000000a7', 'tc04-manager@example.test'),
  ('c2297000-0000-0000-0000-0000000000b1', 'tc04-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2297000-0000-0000-0000-0000000000f1', 'TC04 A', 'tc04-a@example.test', '07', 'TC4A'),
  ('c2297000-0000-0000-0000-0000000000f2', 'TC04 B', 'tc04-b@example.test', '07', 'TC4B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2297000-0000-0000-0000-0000000000a1', 'c2297000-0000-0000-0000-0000000000f1', 'tc04-owner@example.test',   'Owner A',    'owner',         true),
  ('c2297000-0000-0000-0000-0000000000a2', 'c2297000-0000-0000-0000-0000000000f1', 'tc04-acct@example.test',    'Accountant', 'accountant',    true),
  ('c2297000-0000-0000-0000-0000000000a3', 'c2297000-0000-0000-0000-0000000000f1', 'tc04-sales@example.test',   'Sales',      'sales',         true),
  ('c2297000-0000-0000-0000-0000000000a4', 'c2297000-0000-0000-0000-0000000000f1', 'tc04-partner@example.test', 'Partner',    'partner_agent', true),
  ('c2297000-0000-0000-0000-0000000000a6', 'c2297000-0000-0000-0000-0000000000f1', 'tc04-gone@example.test',    'Gone',       'sales',         false),
  ('c2297000-0000-0000-0000-0000000000a7', 'c2297000-0000-0000-0000-0000000000f1', 'tc04-manager@example.test', 'Manager',    'manager',       true),
  ('c2297000-0000-0000-0000-0000000000b1', 'c2297000-0000-0000-0000-0000000000f2', 'tc04-owner-b@example.test', 'Owner B',    'owner',         true);

-- channels: A general (public: owner, accountant, sales), A accounts (private: owner + accountant),
--           A DM accountant <-> sales, B general
insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, dm_key, created_by) values
  ('c2297000-0000-0000-0000-0000000000c1', 'c2297000-0000-0000-0000-0000000000f1', 'channel', 'general',  'general',  false, null, 'c2297000-0000-0000-0000-0000000000a1'),
  ('c2297000-0000-0000-0000-0000000000c2', 'c2297000-0000-0000-0000-0000000000f1', 'channel', 'accounts', 'accounts', true,  null, 'c2297000-0000-0000-0000-0000000000a1'),
  ('c2297000-0000-0000-0000-0000000000c3', 'c2297000-0000-0000-0000-0000000000f1', 'dm',      null,       null,       true,
     'c2297000-0000-0000-0000-0000000000a2:c2297000-0000-0000-0000-0000000000a3', 'c2297000-0000-0000-0000-0000000000a2'),
  ('c2297000-0000-0000-0000-0000000000c9', 'c2297000-0000-0000-0000-0000000000f2', 'channel', 'general',  'general',  false, null, 'c2297000-0000-0000-0000-0000000000b1');

insert into public.chat_members (tenant_id, channel_id, user_id, member_role) values
  ('c2297000-0000-0000-0000-0000000000f1', 'c2297000-0000-0000-0000-0000000000c1', 'c2297000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2297000-0000-0000-0000-0000000000f1', 'c2297000-0000-0000-0000-0000000000c1', 'c2297000-0000-0000-0000-0000000000a2', 'member'),
  ('c2297000-0000-0000-0000-0000000000f1', 'c2297000-0000-0000-0000-0000000000c1', 'c2297000-0000-0000-0000-0000000000a3', 'member'),
  ('c2297000-0000-0000-0000-0000000000f1', 'c2297000-0000-0000-0000-0000000000c2', 'c2297000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2297000-0000-0000-0000-0000000000f1', 'c2297000-0000-0000-0000-0000000000c2', 'c2297000-0000-0000-0000-0000000000a2', 'member'),
  ('c2297000-0000-0000-0000-0000000000f1', 'c2297000-0000-0000-0000-0000000000c3', 'c2297000-0000-0000-0000-0000000000a2', 'member'),
  ('c2297000-0000-0000-0000-0000000000f1', 'c2297000-0000-0000-0000-0000000000c3', 'c2297000-0000-0000-0000-0000000000a3', 'member'),
  -- bad data on purpose: outsiders with a member row must still get nothing
  ('c2297000-0000-0000-0000-0000000000f1', 'c2297000-0000-0000-0000-0000000000c1', 'c2297000-0000-0000-0000-0000000000a4', 'member'),
  ('c2297000-0000-0000-0000-0000000000f1', 'c2297000-0000-0000-0000-0000000000c1', 'c2297000-0000-0000-0000-0000000000a6', 'member'),
  ('c2297000-0000-0000-0000-0000000000f2', 'c2297000-0000-0000-0000-0000000000c9', 'c2297000-0000-0000-0000-0000000000b1', 'admin');

-- Files already stored (as the upload route would have stored them).
insert into storage.objects (bucket_id, name, owner) values
  ('documents', 'c2297000-0000-0000-0000-0000000000f1/chat/c2297000-0000-0000-0000-0000000000c2/11111111-1111-4111-8111-111111111111_ledger.pdf', 'c2297000-0000-0000-0000-0000000000a2'),
  ('documents', 'c2297000-0000-0000-0000-0000000000f1/chat/c2297000-0000-0000-0000-0000000000c3/22222222-2222-4222-8222-222222222222_dm-note.pdf', 'c2297000-0000-0000-0000-0000000000a2'),
  ('documents', 'c2297000-0000-0000-0000-0000000000f1/chat/c2297000-0000-0000-0000-0000000000c1/33333333-3333-4333-8333-333333333333_owner-plan.pdf', 'c2297000-0000-0000-0000-0000000000a1'),
  ('documents', 'c2297000-0000-0000-0000-0000000000f2/chat/c2297000-0000-0000-0000-0000000000c9/44444444-4444-4444-8444-444444444444_b.pdf', 'c2297000-0000-0000-0000-0000000000b1');

create function pg_temp.tc04_insert_refused(p_name text, p_owner uuid) returns boolean
language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner) values ('documents', p_name, p_owner);
  return false;
exception when insufficient_privilege then
  return true;
end $$;

create function pg_temp.tc04_seen(p_prefix text) returns int
language sql as $$
  select count(*)::int from storage.objects where bucket_id = 'documents' and name like p_prefix || '%'
$$;

create function pg_temp.tc04_as(p_uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true)
$$;

grant execute on function pg_temp.tc04_insert_refused(text, uuid) to authenticated;
grant execute on function pg_temp.tc04_seen(text) to authenticated;
grant execute on function pg_temp.tc04_as(uuid) to authenticated;

set local role authenticated;

-- ── 1. a member uploads and reads ──────────────────────────────────────────────────
do $$
declare
  a    text := 'c2297000-0000-0000-0000-0000000000f1/chat/';
  me   uuid := 'c2297000-0000-0000-0000-0000000000a3';
  v_n  int;
begin
  perform pg_temp.tc04_as(me);
  if pg_temp.tc04_insert_refused(a || 'c2297000-0000-0000-0000-0000000000c1/55555555-5555-4555-8555-555555555555_quote.pdf', me) then
    raise exception 'FAIL 1: a member (sales) could not upload into #general'; end if;
  if pg_temp.tc04_insert_refused(a || 'c2297000-0000-0000-0000-0000000000c3/66666666-6666-4666-8666-666666666666_photo.jpg', me) then
    raise exception 'FAIL 1: a member could not upload into its own DM'; end if;
  v_n := pg_temp.tc04_seen(a || 'c2297000-0000-0000-0000-0000000000c1/');
  if v_n <> 2 then raise exception 'FAIL 1: sales sees % files in #general, expected 2 (its own + the owner''s)', v_n; end if;
  v_n := pg_temp.tc04_seen(a || 'c2297000-0000-0000-0000-0000000000c3/');
  if v_n <> 2 then raise exception 'FAIL 1: sales sees % files in its DM, expected 2', v_n; end if;
  raise notice 'PASS 1: a member uploads into its channel / DM and reads the files there';
end $$;

-- ── 2. non-members ─────────────────────────────────────────────────────────────────
do $$
declare
  a    text := 'c2297000-0000-0000-0000-0000000000f1/chat/';
  v_n  int;
begin
  -- sales is not in the private #accounts
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a3');
  v_n := pg_temp.tc04_seen(a || 'c2297000-0000-0000-0000-0000000000c2/');
  if v_n <> 0 then raise exception 'FAIL 2: a non-member reads % files of a private channel', v_n; end if;
  if not pg_temp.tc04_insert_refused(a || 'c2297000-0000-0000-0000-0000000000c2/77777777-7777-4777-8777-777777777777_x.pdf', 'c2297000-0000-0000-0000-0000000000a3') then
    raise exception 'FAIL 2: a non-member uploaded into a private channel'; end if;

  -- the manager is in no channel: reads the PUBLIC channel's files (as its messages), uploads nowhere
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a7');
  v_n := pg_temp.tc04_seen(a || 'c2297000-0000-0000-0000-0000000000c1/');
  if v_n <> 2 then raise exception 'FAIL 2: a staff non-member sees % files of a public channel, expected 2 (same as its messages)', v_n; end if;
  if not pg_temp.tc04_insert_refused(a || 'c2297000-0000-0000-0000-0000000000c1/88888888-8888-4888-8888-888888888888_x.pdf', 'c2297000-0000-0000-0000-0000000000a7') then
    raise exception 'FAIL 2: a non-member uploaded into a public channel'; end if;
  v_n := pg_temp.tc04_seen(a || 'c2297000-0000-0000-0000-0000000000c2/') + pg_temp.tc04_seen(a || 'c2297000-0000-0000-0000-0000000000c3/');
  if v_n <> 0 then raise exception 'FAIL 2: the manager (non-member) reads % private / DM files', v_n; end if;

  -- the OWNER does not read a DM between two staff
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a1');
  v_n := pg_temp.tc04_seen(a || 'c2297000-0000-0000-0000-0000000000c3/');
  if v_n <> 0 then raise exception 'FAIL 2: the owner reads % files of a DM it is not in', v_n; end if;
  if not pg_temp.tc04_insert_refused(a || 'c2297000-0000-0000-0000-0000000000c3/99999999-9999-4999-8999-999999999999_x.pdf', 'c2297000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 2: the owner uploaded into a DM it is not in'; end if;
  v_n := pg_temp.tc04_seen(a || 'c2297000-0000-0000-0000-0000000000c2/');
  if v_n <> 1 then raise exception 'FAIL 2: the owner (member) sees % files of #accounts, expected 1', v_n; end if;
  raise notice 'PASS 2: non-members cannot upload; private / DM files stay with members (owner too)';
end $$;

-- ── 3. another tenant ──────────────────────────────────────────────────────────────
do $$
declare
  me   uuid := 'c2297000-0000-0000-0000-0000000000b1';
  v_n  int;
begin
  perform pg_temp.tc04_as(me);
  v_n := pg_temp.tc04_seen('c2297000-0000-0000-0000-0000000000f1/');
  if v_n <> 0 then raise exception 'FAIL 3: another tenant''s owner reads % chat files of tenant A', v_n; end if;
  if not pg_temp.tc04_insert_refused('c2297000-0000-0000-0000-0000000000f1/chat/c2297000-0000-0000-0000-0000000000c1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa_x.pdf', me) then
    raise exception 'FAIL 3: another tenant uploaded into tenant A''s chat folder'; end if;
  if not pg_temp.tc04_insert_refused('c2297000-0000-0000-0000-0000000000f2/chat/c2297000-0000-0000-0000-0000000000c1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab_x.pdf', me) then
    raise exception 'FAIL 3: another tenant uploaded under its own folder with tenant A''s channel id'; end if;
  v_n := pg_temp.tc04_seen('c2297000-0000-0000-0000-0000000000f2/chat/c2297000-0000-0000-0000-0000000000c9/');
  if v_n <> 1 then raise exception 'FAIL 3: tenant B''s owner sees % of its own chat files, expected 1', v_n; end if;
  if pg_temp.tc04_insert_refused('c2297000-0000-0000-0000-0000000000f2/chat/c2297000-0000-0000-0000-0000000000c9/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb_b2.pdf', me) then
    raise exception 'FAIL 3: tenant B''s owner could not upload into its own #general'; end if;
  raise notice 'PASS 3: tenants are walled off';
end $$;

-- ── 4. delete ──────────────────────────────────────────────────────────────────────
do $$ begin perform set_config('storage.allow_delete_query', 'true', true); end $$;  -- the Storage API sets this; a raw DELETE needs it on local Supabase
do $$
declare
  g    text := 'c2297000-0000-0000-0000-0000000000f1/chat/c2297000-0000-0000-0000-0000000000c1/';
  dm   text := 'c2297000-0000-0000-0000-0000000000f1/chat/c2297000-0000-0000-0000-0000000000c3/';
  v_n  int;
begin
  -- the accountant (member, not uploader) cannot delete sales' or the owner's file
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a2');
  delete from storage.objects where bucket_id = 'documents' and name = g || '55555555-5555-4555-8555-555555555555_quote.pdf';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: a member deleted someone else''s file (% rows)', v_n; end if;

  -- the owner cannot delete in a DM it is not in
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a1');
  delete from storage.objects where bucket_id = 'documents' and name like dm || '%';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: the owner deleted % files in a DM it is not in', v_n; end if;

  -- the uploader deletes its own
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a3');
  delete from storage.objects where bucket_id = 'documents' and name = dm || '66666666-6666-4666-8666-666666666666_photo.jpg';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 4: the uploader could not delete its own file (% rows)', v_n; end if;
  delete from storage.objects where bucket_id = 'documents' and name = dm || '22222222-2222-4222-8222-222222222222_dm-note.pdf';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: sales deleted the accountant''s file in their DM (% rows)', v_n; end if;

  -- the owner deletes a member's file in a channel it can read
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a1');
  delete from storage.objects where bucket_id = 'documents' and name = g || '55555555-5555-4555-8555-555555555555_quote.pdf';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 4: the owner could not delete a file in #general (% rows)', v_n; end if;
  raise notice 'PASS 4: delete by the uploader or the owner only';
end $$;

-- ── 5. no replace; owner must be the caller ────────────────────────────────────────
do $$
declare
  g    text := 'c2297000-0000-0000-0000-0000000000f1/chat/c2297000-0000-0000-0000-0000000000c1/';
  v_n  int;
begin
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a1');
  update storage.objects set metadata = '{"tc04":"swapped"}'::jsonb
   where bucket_id = 'documents' and name = g || '33333333-3333-4333-8333-333333333333_owner-plan.pdf';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 5: a chat file was replaced in place (% rows)', v_n; end if;

  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a3');
  if not pg_temp.tc04_insert_refused(g || 'cccccccc-cccc-4ccc-8ccc-cccccccccccc_x.pdf', 'c2297000-0000-0000-0000-0000000000a2') then
    raise exception 'FAIL 5: an upload was stored under someone else''s name (owner)'; end if;
  if not pg_temp.tc04_insert_refused(g || 'cccccccc-cccc-4ccc-8ccc-cccccccccccd_x.pdf', null) then
    raise exception 'FAIL 5: an upload with no owner was stored'; end if;
  raise notice 'PASS 5: no replace; the uploader is always the caller';
end $$;

-- ── 6. bad paths ───────────────────────────────────────────────────────────────────
do $$
declare
  t    text := 'c2297000-0000-0000-0000-0000000000f1/chat/';
  c1   text := 'c2297000-0000-0000-0000-0000000000c1';
  me   uuid := 'c2297000-0000-0000-0000-0000000000a1';  -- owner: the default vault rule would let it in
  bad  text;
begin
  perform pg_temp.tc04_as(me);
  foreach bad in array array[
    t || c1 || '/quote.pdf',                                                         -- no uuid prefix
    t || 'general/dddddddd-dddd-4ddd-8ddd-dddddddddddd_x.pdf',                       -- channel not a uuid
    t || c1 || '/sub/dddddddd-dddd-4ddd-8ddd-dddddddddddd_x.pdf',                    -- extra folder
    t || c1 || '/dddddddd-dddd-4ddd-8ddd-dddddddddddd_bad name<x>.pdf',              -- unsafe name
    t || c1 || '/dddddddd-dddd-4ddd-8ddd-dddddddddddd_',                             -- empty name
    t || c1 || '/dddddddd-dddd-4ddd-8ddd-dddddddddddd_a..b.pdf',                      -- '..' (chat_attachments refuses it too)
    t || c1                                                                          -- no file
  ] loop
    if not pg_temp.tc04_insert_refused(bad, me) then
      raise exception 'FAIL 6: a bad chat path was stored: %', bad; end if;
  end loop;
  raise notice 'PASS 6: only {tenant}/chat/{channel}/{uuid}_{safe-name}';
end $$;

-- ── 7. partner_agent / deactivated with a member row ───────────────────────────────
do $$
declare
  g    text := 'c2297000-0000-0000-0000-0000000000f1/chat/c2297000-0000-0000-0000-0000000000c1/';
  u    uuid;
  v_n  int;
begin
  foreach u in array array['c2297000-0000-0000-0000-0000000000a4', 'c2297000-0000-0000-0000-0000000000a6']::uuid[] loop
    perform pg_temp.tc04_as(u);
    v_n := pg_temp.tc04_seen(g);
    if v_n <> 0 then raise exception 'FAIL 7: % reads % chat files', u, v_n; end if;
    if not pg_temp.tc04_insert_refused(g || 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee_x.pdf', u) then
      raise exception 'FAIL 7: % uploaded a chat file', u; end if;
  end loop;
  raise notice 'PASS 7: partner_agent and deactivated logins get nothing';
end $$;

-- ── 8. the rest of documents is unchanged ──────────────────────────────────────────
do $$
declare
  t    text := 'c2297000-0000-0000-0000-0000000000f1/';
begin
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a3');
  if not pg_temp.tc04_insert_refused(t || 'ffffffff-ffff-4fff-8fff-ffffffffffff-vault.pdf', 'c2297000-0000-0000-0000-0000000000a3') then
    raise exception 'FAIL 8: sales uploaded into the company documents vault'; end if;
  perform pg_temp.tc04_as('c2297000-0000-0000-0000-0000000000a1');
  if pg_temp.tc04_insert_refused(t || 'ffffffff-ffff-4fff-8fff-fffffffffffe-vault.pdf', 'c2297000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 8: the owner could not upload into the vault'; end if;
  raise notice 'PASS 8: vault rule unchanged';
end $$;

rollback;
