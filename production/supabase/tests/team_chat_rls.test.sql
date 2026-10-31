-- R-2294 (G-TEAMCHAT TC-01, 31 Oct 2026) — team chat tables + membership RLS.
-- Migration: 20261031104420_r2294_team_chat_tables.sql
--
-- Pardeep's decisions (31 Oct): channels by owner/manager, DMs by anyone, the OWNER DOES NOT
-- READ other people's DMs, team chat hidden from partner_agent and personal users.
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   0. Shape: 5 tables with RLS; is_chat_member() STABLE SECURITY DEFINER search_path '';
--      authenticated has SELECT only (writes go through RPCs, R-2295); links hold {type,id} only;
--      a member row / author from another tenant is refused.
--   1. Other tenant reads 0 rows of tenant A from every chat table (and still sees its own).
--   2. A non-member reads 0 from a private channel and from a DM — the OWNER included for a DM
--      between two staff — but reads a public channel.
--   3. A member reads their private channel / DM, its members and its attachment; owner/manager
--      read edit history of a channel they can read, never of a DM (not even their own DM);
--      sales reads none.
--   4. partner_agent, personal and deactivated users read 0 — even with a (bad) member row.
--   5. No tenant (unknown login / no login) → 0 rows; is_chat_member(NULL) and
--      is_chat_member(<channel>) are false.
--   6. A signed-in member cannot insert / update / delete any chat row directly.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/team_chat_rls.test.sql

begin;

-- ── 0. shape ────────────────────────────────────────────────────────────────────────
do $$
declare
  v_t text;
  v_p record;
begin
  if to_regprocedure('public.is_chat_member(uuid)') is null then
    raise exception 'FAIL 0: public.is_chat_member(uuid) does not exist — migration not applied';
  end if;
  select p.provolatile, p.prosecdef, p.proconfig into v_p
    from pg_proc p where p.oid = 'public.is_chat_member(uuid)'::regprocedure;
  if v_p.provolatile <> 's' or not v_p.prosecdef or not ('search_path=""' = any (v_p.proconfig)) then
    raise exception 'FAIL 0: is_chat_member must be STABLE SECURITY DEFINER with search_path '''' (got %, %, %)',
      v_p.provolatile, v_p.prosecdef, v_p.proconfig;
  end if;
  foreach v_t in array array['chat_channels', 'chat_members', 'chat_messages', 'chat_attachments',
                             'chat_message_edits'] loop
    if to_regclass('public.' || v_t) is null then
      raise exception 'FAIL 0: table public.% is missing', v_t;
    end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || v_t)::regclass) then
      raise exception 'FAIL 0: RLS is off on %', v_t;
    end if;
    if has_table_privilege('authenticated', 'public.' || v_t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || v_t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || v_t, 'DELETE')
       or has_table_privilege('anon', 'public.' || v_t, 'SELECT') then
      raise exception 'FAIL 0: % grants a write to authenticated or a read to anon', v_t;
    end if;
    if not has_table_privilege('authenticated', 'public.' || v_t, 'SELECT') then
      raise exception 'FAIL 0: authenticated cannot SELECT %', v_t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_t
                     and policyname = 'zzz_service_role_all' and 'service_role' = any (roles)) then
      raise exception 'FAIL 0: % has no zzz_service_role_all policy', v_t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_t
                     and policyname = 'gp09_personal_wall' and permissive = 'RESTRICTIVE'
                     and qual ilike '%( SELECT is_personal_session()%') then
      raise exception 'FAIL 0: % has no gp09_personal_wall', v_t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_t
                 and cmd <> 'SELECT' and permissive = 'PERMISSIVE'
                 and ('authenticated' = any (roles) or 'public' = any (roles))) then
      raise exception 'FAIL 0: % has a write policy for signed-in users (writes are RPC-only)', v_t;
    end if;
  end loop;
end $$;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2294000-0000-0000-0000-0000000000a1', 'tc01-owner@example.test'),
  ('c2294000-0000-0000-0000-0000000000a2', 'tc01-acct@example.test'),
  ('c2294000-0000-0000-0000-0000000000a3', 'tc01-sales@example.test'),
  ('c2294000-0000-0000-0000-0000000000a4', 'tc01-partner@example.test'),
  ('c2294000-0000-0000-0000-0000000000a5', 'tc01-personal@example.test'),
  ('c2294000-0000-0000-0000-0000000000a6', 'tc01-gone@example.test'),
  ('c2294000-0000-0000-0000-0000000000a7', 'tc01-manager@example.test'),
  ('c2294000-0000-0000-0000-0000000000b1', 'tc01-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2294000-0000-0000-0000-0000000000f1', 'TC01 A', 'tc01-a@example.test', '07', 'TC1A'),
  ('c2294000-0000-0000-0000-0000000000f2', 'TC01 B', 'tc01-b@example.test', '07', 'TC1B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2294000-0000-0000-0000-0000000000a1', 'c2294000-0000-0000-0000-0000000000f1', 'tc01-owner@example.test',    'Owner A',    'owner',         true),
  ('c2294000-0000-0000-0000-0000000000a2', 'c2294000-0000-0000-0000-0000000000f1', 'tc01-acct@example.test',     'Accountant', 'accountant',    true),
  ('c2294000-0000-0000-0000-0000000000a3', 'c2294000-0000-0000-0000-0000000000f1', 'tc01-sales@example.test',    'Sales',      'sales',         true),
  ('c2294000-0000-0000-0000-0000000000a4', 'c2294000-0000-0000-0000-0000000000f1', 'tc01-partner@example.test',  'Partner',    'partner_agent', true),
  ('c2294000-0000-0000-0000-0000000000a5', 'c2294000-0000-0000-0000-0000000000f1', 'tc01-personal@example.test', 'Personal',   'personal',      true),
  ('c2294000-0000-0000-0000-0000000000a6', 'c2294000-0000-0000-0000-0000000000f1', 'tc01-gone@example.test',     'Gone',       'sales',         false),
  ('c2294000-0000-0000-0000-0000000000a7', 'c2294000-0000-0000-0000-0000000000f1', 'tc01-manager@example.test',  'Manager',    'manager',       true),
  ('c2294000-0000-0000-0000-0000000000b1', 'c2294000-0000-0000-0000-0000000000f2', 'tc01-owner-b@example.test',  'Owner B',    'owner',         true);

-- channels: A general (public), A accounts (private: owner + accountant),
--           A DM accountant <-> sales, A DM owner <-> accountant, B general (public)
insert into public.chat_channels (id, tenant_id, kind, name, slug, is_private, dm_key, created_by) values
  ('c2294000-0000-0000-0000-0000000000c1', 'c2294000-0000-0000-0000-0000000000f1', 'channel', 'general',  'general',  false, null, 'c2294000-0000-0000-0000-0000000000a1'),
  ('c2294000-0000-0000-0000-0000000000c2', 'c2294000-0000-0000-0000-0000000000f1', 'channel', 'accounts', 'accounts', true,  null, 'c2294000-0000-0000-0000-0000000000a1'),
  ('c2294000-0000-0000-0000-0000000000c3', 'c2294000-0000-0000-0000-0000000000f1', 'dm',      null,       null,       true,
     'c2294000-0000-0000-0000-0000000000a2:c2294000-0000-0000-0000-0000000000a3', 'c2294000-0000-0000-0000-0000000000a2'),
  ('c2294000-0000-0000-0000-0000000000c4', 'c2294000-0000-0000-0000-0000000000f1', 'dm',      null,       null,       true,
     'c2294000-0000-0000-0000-0000000000a1:c2294000-0000-0000-0000-0000000000a2', 'c2294000-0000-0000-0000-0000000000a1'),
  ('c2294000-0000-0000-0000-0000000000c9', 'c2294000-0000-0000-0000-0000000000f2', 'channel', 'general',  'general',  false, null, 'c2294000-0000-0000-0000-0000000000b1');

insert into public.chat_members (tenant_id, channel_id, user_id, member_role) values
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c1', 'c2294000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c1', 'c2294000-0000-0000-0000-0000000000a2', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c1', 'c2294000-0000-0000-0000-0000000000a3', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c2', 'c2294000-0000-0000-0000-0000000000a1', 'admin'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c2', 'c2294000-0000-0000-0000-0000000000a2', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c3', 'c2294000-0000-0000-0000-0000000000a2', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c3', 'c2294000-0000-0000-0000-0000000000a3', 'member'),
  -- bad data on purpose: outsiders that somehow got a member row must still read nothing
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c1', 'c2294000-0000-0000-0000-0000000000a4', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c3', 'c2294000-0000-0000-0000-0000000000a4', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c1', 'c2294000-0000-0000-0000-0000000000a5', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c3', 'c2294000-0000-0000-0000-0000000000a5', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c1', 'c2294000-0000-0000-0000-0000000000a6', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c3', 'c2294000-0000-0000-0000-0000000000a6', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c4', 'c2294000-0000-0000-0000-0000000000a1', 'member'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c4', 'c2294000-0000-0000-0000-0000000000a2', 'member'),
  ('c2294000-0000-0000-0000-0000000000f2', 'c2294000-0000-0000-0000-0000000000c9', 'c2294000-0000-0000-0000-0000000000b1', 'admin');

insert into public.chat_messages (id, tenant_id, channel_id, author_id, body, links) values
  ('c2294000-0000-0000-0000-0000000000d1', 'c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c1', 'c2294000-0000-0000-0000-0000000000a1', 'hello team', '[{"type":"invoice","id":"INV-1"}]'),
  ('c2294000-0000-0000-0000-0000000000d2', 'c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c2', 'c2294000-0000-0000-0000-0000000000a2', 'accounts only', '[]'),
  ('c2294000-0000-0000-0000-0000000000d3', 'c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c3', 'c2294000-0000-0000-0000-0000000000a2', 'private dm', '[]'),
  ('c2294000-0000-0000-0000-0000000000d4', 'c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c4', 'c2294000-0000-0000-0000-0000000000a2', 'owner dm', '[]'),
  ('c2294000-0000-0000-0000-0000000000d9', 'c2294000-0000-0000-0000-0000000000f2', 'c2294000-0000-0000-0000-0000000000c9', 'c2294000-0000-0000-0000-0000000000b1', 'tenant b', '[]');

insert into public.chat_attachments (tenant_id, message_id, channel_id, file_path, file_name, mime, size_bytes, uploaded_by) values
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000d3', 'c2294000-0000-0000-0000-0000000000c3',
   'c2294000-0000-0000-0000-0000000000f1/chat/c2294000-0000-0000-0000-0000000000c3/x_statement.pdf', 'statement.pdf', 'application/pdf', 1000,
   'c2294000-0000-0000-0000-0000000000a2'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000d1', 'c2294000-0000-0000-0000-0000000000c1',
   'c2294000-0000-0000-0000-0000000000f1/chat/c2294000-0000-0000-0000-0000000000c1/y_note.txt', 'note.txt', 'text/plain', 10,
   'c2294000-0000-0000-0000-0000000000a1');

insert into public.chat_message_edits (tenant_id, message_id, channel_id, old_body, edited_by) values
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000d1', 'c2294000-0000-0000-0000-0000000000c1', 'helo team', 'c2294000-0000-0000-0000-0000000000a1'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000d3', 'c2294000-0000-0000-0000-0000000000c3', 'privat dm',  'c2294000-0000-0000-0000-0000000000a2'),
  ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000d4', 'c2294000-0000-0000-0000-0000000000c4', 'ownr dm',    'c2294000-0000-0000-0000-0000000000a2');

-- 0b. data rules (superuser — no RLS in the way, only constraints/triggers)
do $$
declare v_blocked boolean;
begin
  -- links: ids only, never an amount or a name
  begin
    insert into public.chat_messages (tenant_id, channel_id, author_id, body, links)
    values ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c1',
            'c2294000-0000-0000-0000-0000000000a1', 'x', '[{"type":"invoice","id":"INV-1","amount":5000}]');
    v_blocked := false;
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 0b: a link carrying an amount was stored'; end if;

  -- a user of tenant B cannot be made a member of a tenant A channel
  begin
    insert into public.chat_members (tenant_id, channel_id, user_id)
    values ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000c2',
            'c2294000-0000-0000-0000-0000000000b1');
    v_blocked := false;
  exception when others then v_blocked := sqlerrm like '%R-2294%';
  end;
  if not v_blocked then raise exception 'FAIL 0b: a tenant-B user became a member of a tenant-A channel'; end if;

  -- a member row cannot point at a channel of another tenant
  begin
    insert into public.chat_members (tenant_id, channel_id, user_id)
    values ('c2294000-0000-0000-0000-0000000000f2', 'c2294000-0000-0000-0000-0000000000c2',
            'c2294000-0000-0000-0000-0000000000b1');
    v_blocked := false;
  exception when foreign_key_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 0b: a tenant-B member row points at a tenant-A channel'; end if;

  -- an attachment path must sit in {tenant}/chat/{channel}/
  begin
    insert into public.chat_attachments (tenant_id, message_id, channel_id, file_path, file_name, mime, size_bytes)
    values ('c2294000-0000-0000-0000-0000000000f1', 'c2294000-0000-0000-0000-0000000000d1',
            'c2294000-0000-0000-0000-0000000000c1', 'c2294000-0000-0000-0000-0000000000f2/chat/x/evil.pdf',
            'evil.pdf', 'application/pdf', 10);
    v_blocked := false;
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 0b: an attachment path outside {tenant}/chat/{channel}/ was stored'; end if;
end $$;

set local role authenticated;

create or replace function pg_temp.tc01_as(p_user uuid) returns void language plpgsql as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  end if;
end $$;

-- rows of tenant A this caller can see: channels, members, messages, attachments, edits
create or replace function pg_temp.tc01_seen(p_channel uuid) returns text language sql as $$
  select format('ch=%s mem=%s msg=%s att=%s ed=%s',
    (select count(*) from public.chat_channels    where id = p_channel),
    (select count(*) from public.chat_members     where channel_id = p_channel),
    (select count(*) from public.chat_messages    where channel_id = p_channel),
    (select count(*) from public.chat_attachments where channel_id = p_channel),
    (select count(*) from public.chat_message_edits where channel_id = p_channel));
$$;

do $$
declare
  v_owner   uuid := 'c2294000-0000-0000-0000-0000000000a1';
  v_acct    uuid := 'c2294000-0000-0000-0000-0000000000a2';
  v_sales   uuid := 'c2294000-0000-0000-0000-0000000000a3';
  v_partner uuid := 'c2294000-0000-0000-0000-0000000000a4';
  v_pers    uuid := 'c2294000-0000-0000-0000-0000000000a5';
  v_gone    uuid := 'c2294000-0000-0000-0000-0000000000a6';
  v_mgr     uuid := 'c2294000-0000-0000-0000-0000000000a7';
  v_owner_b uuid := 'c2294000-0000-0000-0000-0000000000b1';
  v_gen     uuid := 'c2294000-0000-0000-0000-0000000000c1';
  v_accts   uuid := 'c2294000-0000-0000-0000-0000000000c2';
  v_dm      uuid := 'c2294000-0000-0000-0000-0000000000c3';
  v_dm_own  uuid := 'c2294000-0000-0000-0000-0000000000c4';
  v_gen_b   uuid := 'c2294000-0000-0000-0000-0000000000c9';
  v_none    text := 'ch=0 mem=0 msg=0 att=0 ed=0';
  v_who     uuid;
  v_s       text;
  n         bigint;
  v_blocked boolean;
begin
  ------------------------------------------------------------------ 1. other tenant
  perform pg_temp.tc01_as(v_owner_b);
  select count(*) into n from public.chat_channels where tenant_id = 'c2294000-0000-0000-0000-0000000000f1';
  if n <> 0 then raise exception 'FAIL 1: tenant B owner reads % tenant-A channel(s)', n; end if;
  foreach v_who in array array[v_gen, v_accts, v_dm] loop
    v_s := pg_temp.tc01_seen(v_who);
    if v_s <> v_none then raise exception 'FAIL 1: tenant B owner reads tenant-A channel %: %', v_who, v_s; end if;
  end loop;
  v_s := pg_temp.tc01_seen(v_gen_b);
  if v_s <> 'ch=1 mem=1 msg=1 att=0 ed=0' then
    raise exception 'FAIL 1 (setup): tenant B owner should read own #general, got %', v_s;
  end if;

  ------------------------------------------------------------------ 2. non-members
  -- sales: public #general yes (no edit history — not owner/manager), private #accounts no
  perform pg_temp.tc01_as(v_sales);
  v_s := pg_temp.tc01_seen(v_gen);
  if v_s <> 'ch=1 mem=6 msg=1 att=1 ed=0' then raise exception 'FAIL 2: sales on #general sees %', v_s; end if;
  v_s := pg_temp.tc01_seen(v_accts);
  if v_s <> v_none then raise exception 'FAIL 2: sales (non-member) reads private #accounts: %', v_s; end if;

  -- the OWNER is not in the accountant<->sales DM: reads nothing of it (decision 2)
  perform pg_temp.tc01_as(v_owner);
  v_s := pg_temp.tc01_seen(v_dm);
  if v_s <> v_none then raise exception 'FAIL 2: owner reads a DM between two staff: %', v_s; end if;
  if public.is_chat_member(v_dm) then raise exception 'FAIL 2: is_chat_member(dm) true for the owner'; end if;
  perform pg_temp.tc01_as(v_mgr);
  v_s := pg_temp.tc01_seen(v_dm);
  if v_s <> v_none then raise exception 'FAIL 2: manager reads a DM between two staff: %', v_s; end if;
  v_s := pg_temp.tc01_seen(v_accts);
  if v_s <> v_none then raise exception 'FAIL 2: manager (non-member) reads private #accounts: %', v_s; end if;

  ------------------------------------------------------------------ 3. members
  perform pg_temp.tc01_as(v_acct);
  v_s := pg_temp.tc01_seen(v_dm);
  -- accountant is in the DM but not owner/manager → no edit history
  if v_s <> 'ch=1 mem=5 msg=1 att=1 ed=0' then raise exception 'FAIL 3: accountant on own DM sees %', v_s; end if;
  if not public.is_chat_member(v_dm) then raise exception 'FAIL 3: is_chat_member(dm) false for a member'; end if;
  v_s := pg_temp.tc01_seen(v_accts);
  if v_s <> 'ch=1 mem=2 msg=1 att=0 ed=0' then raise exception 'FAIL 3: accountant on #accounts sees %', v_s; end if;

  perform pg_temp.tc01_as(v_sales);
  v_s := pg_temp.tc01_seen(v_dm);
  if v_s <> 'ch=1 mem=5 msg=1 att=1 ed=0' then raise exception 'FAIL 3: sales on own DM sees %', v_s; end if;

  perform pg_temp.tc01_as(v_owner);
  v_s := pg_temp.tc01_seen(v_accts);
  if v_s <> 'ch=1 mem=2 msg=1 att=0 ed=0' then raise exception 'FAIL 3: owner on #accounts sees %', v_s; end if;
  v_s := pg_temp.tc01_seen(v_gen);
  if v_s <> 'ch=1 mem=6 msg=1 att=1 ed=1' then raise exception 'FAIL 3: owner on #general sees %', v_s; end if;
  -- owner's OWN DM: reads it, but never its edit history (DMs have none to read)
  v_s := pg_temp.tc01_seen(v_dm_own);
  if v_s <> 'ch=1 mem=2 msg=1 att=0 ed=0' then raise exception 'FAIL 3: owner on own DM sees %', v_s; end if;
  select count(*) into n from public.chat_message_edits;
  if n <> 1 then raise exception 'FAIL 3: owner reads % edit rows (expected only the #general one)', n; end if;

  perform pg_temp.tc01_as(v_mgr);
  v_s := pg_temp.tc01_seen(v_gen);
  if v_s <> 'ch=1 mem=6 msg=1 att=1 ed=1' then raise exception 'FAIL 3: manager on public #general sees %', v_s; end if;

  ------------------------------------------------------------------ 4. outsiders
  foreach v_who in array array[v_partner, v_pers, v_gone] loop
    perform pg_temp.tc01_as(v_who);
    select count(*) into n from public.chat_channels;
    if n <> 0 then raise exception 'FAIL 4: user % (partner/personal/inactive) reads % channel(s)', v_who, n; end if;
    foreach v_s in array array[pg_temp.tc01_seen(v_gen), pg_temp.tc01_seen(v_dm)] loop
      if v_s <> v_none then raise exception 'FAIL 4: user % (partner/personal/inactive) reads %', v_who, v_s; end if;
    end loop;
    if public.is_chat_member(v_gen) or public.is_chat_member(v_dm) then
      raise exception 'FAIL 4: is_chat_member true for user % (partner/personal/inactive)', v_who;
    end if;
  end loop;

  ------------------------------------------------------------------ 5. no tenant
  foreach v_who in array array['c2294000-0000-0000-0000-0000000000ee'::uuid, null] loop
    perform pg_temp.tc01_as(v_who);
    select count(*) into n from public.chat_channels;
    if n <> 0 then raise exception 'FAIL 5: a login with no tenant (%) reads % channel(s)', v_who, n; end if;
    select count(*) into n from public.chat_messages;
    if n <> 0 then raise exception 'FAIL 5: a login with no tenant (%) reads % message(s)', v_who, n; end if;
    if public.is_chat_member(v_gen) then raise exception 'FAIL 5: is_chat_member true with no tenant (%)', v_who; end if;
  end loop;
  perform pg_temp.tc01_as(v_acct);
  if public.is_chat_member(null) then raise exception 'FAIL 5: is_chat_member(NULL) is true'; end if;

  ------------------------------------------------------------------ 6. no direct writes
  perform pg_temp.tc01_as(v_acct);
  begin
    insert into public.chat_messages (tenant_id, channel_id, author_id, body)
    values ('c2294000-0000-0000-0000-0000000000f1', v_dm, v_acct, 'direct');
    v_blocked := false;
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 6: a member inserted a message directly'; end if;
  begin
    update public.chat_messages set body = 'changed' where channel_id = v_dm;
    v_blocked := false;
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 6: a member updated a message directly'; end if;
  begin
    insert into public.chat_members (tenant_id, channel_id, user_id)
    values ('c2294000-0000-0000-0000-0000000000f1', v_accts, v_acct);
    v_blocked := false;
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 6: a user added a member row directly'; end if;
  perform pg_temp.tc01_as(v_owner);
  begin
    delete from public.chat_channels where id = v_gen;
    v_blocked := false;
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 6: the owner deleted a channel directly'; end if;
end $$;

do $$ begin raise notice 'team_chat_rls: all checks passed'; end $$;

rollback;
