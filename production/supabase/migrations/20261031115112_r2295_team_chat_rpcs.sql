-- deploy-peek: to_regprocedure('public.chat_post_message(uuid,text,text,uuid,uuid[],jsonb,jsonb)') is not null and to_regprocedure('public.chat_unread_counts()') is not null and to_regprocedure('public.chat_create_channel(text,boolean,text,uuid[])') is not null
-- deploy-key: r2295teamchatrpcs
-- 20261031115112_r2295_team_chat_rpcs.sql
--
-- R-2295 (G-TEAMCHAT TC-02, 31 Oct 2026): the team chat write RPCs. R-2294 gave signed-in users
-- SELECT only on the chat tables — every write goes through these SECURITY DEFINER functions
-- (CLAUDE.md §17b), so a message, its files, its mention notifications and the author's read
-- mark are written together or not at all, and a browser cannot fake a mention.
-- Plan: Anutech-HQ/drafts/TEAM-CHAT/audit-and-plan.md (TC-02). Pardeep's decisions (31 Oct):
-- channels by owner/manager, DMs by anyone, the owner does not read others' DMs, edit window
-- 15 minutes, delete by the author or the owner.
--
-- FUNCTIONS (all plpgsql, SECURITY DEFINER, search_path '', tenant + user from the CALLER)
--   chat_post_message(channel, body, kind, parent, mentions[], links, attachments) → message id
--       member only; kind text/problem/suggestion (problem/suggestion start post_status 'open');
--       links [{type,id}] only; up to 5 attachments [{path,name,mime,size}] in
--       {tenant}/chat/{channel}/, 10 MB each; mentions kept only for active staff members of the
--       channel (never the author) and each gets ONE 'chat.mention' notification (unless the
--       member set notify 'none'); the author's read mark moves to the message; 30 messages per
--       minute per user (advisory lock, so two tabs cannot race past it).
--   chat_edit_message(message, body)        author only, within 15 minutes, not deleted; old body
--       → chat_message_edits (with channel_id); activity_log update/chat_message.
--   chat_delete_message(message) → {deleted, file_paths}   author or the owner, in a channel they
--       can read (so never inside a DM the owner is not in); blanks body/links/mentions, keeps the
--       row, removes the attachment rows and returns their storage paths for the caller to remove
--       (R-2297's storage rule); repeat = no-op. activity_log delete/chat_message.
--   chat_mark_read(channel, at)             member only; read mark only moves forward, never past now.
--   chat_open_dm(user) → channel id         any staff, with an active staff teammate of the same
--       company; idempotent by dm_key "lower uuid:higher uuid" (on conflict), both member rows.
--   chat_create_channel(name, private, topic, members[]) → channel id   owner/manager only; slug from
--       the name; the creator is admin; only active staff of the company are added;
--       activity_log create/chat_channel.
--   chat_unread_counts() → (channel_id, unread, mentions)   the caller's member channels (not
--       archived): others' undeleted messages after the read mark.
--
-- GUARDS (§17c fail-closed, each function carries its OWN): no user / no tenant / not staff
-- (partner_agent, personal, deactivated, personal workspace) → 28000 "… team chat". A row of
-- another company or a channel the caller cannot read → P0002 "not found" (no existence leak).
-- activity_log never carries message text: owner/manager read it and the owner must not read
-- others' DMs (decision 2).
-- Times use clock_timestamp() so the order of messages and read marks is exact even inside one
-- transaction.
-- Test: supabase/tests/team_chat_rpcs.test.sql. Re-runnable.

begin;

-- ── post ────────────────────────────────────────────────────────────────────────────
create or replace function public.chat_post_message(
  p_channel_id  uuid,
  p_body        text,
  p_kind        text    default 'text',
  p_parent_id   uuid    default null,
  p_mentions    uuid[]  default '{}',
  p_links       jsonb   default '[]'::jsonb,
  p_attachments jsonb   default '[]'::jsonb
) returns uuid
  language plpgsql security definer set search_path = ''
as $$
-- R-2295: post a team chat message (+ attachments + mention notifications + author read mark).
declare
  v_uid      uuid := public.current_user_id();
  v_tenant   uuid := public.current_tenant_id();
  v_ch       record;
  v_body     text := pg_catalog.btrim(coalesce(p_body, ''));
  v_kind     text := coalesce(p_kind, 'text');
  v_links    jsonb := coalesce(p_links, '[]'::jsonb);
  v_att      jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_mentions uuid[];
  v_now      timestamptz;
  v_id       uuid;
  v_author   text;
  v_where    text;
  v_a        jsonb;
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;

  select c.id, c.kind, c.name, c.archived_at into v_ch
    from public.chat_channels c
   where c.id = p_channel_id and c.tenant_id = v_tenant;
  if v_ch.id is null or not public.chat_can_read(p_channel_id) then
    raise exception 'Channel not found' using errcode = 'P0002';
  end if;
  if not public.is_chat_member(p_channel_id) then
    raise exception 'You are not a member of this channel' using errcode = '42501';
  end if;
  if v_ch.archived_at is not null then
    raise exception 'This channel is archived — it takes no new messages' using errcode = '22023';
  end if;

  if v_kind not in ('text', 'problem', 'suggestion') then
    raise exception 'Unknown message kind "%"', v_kind using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_body) > 4000 then
    raise exception 'Message is too long (max 4000 characters)' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_att) <> 'array' or pg_catalog.jsonb_array_length(v_att) > 5 then
    raise exception 'Up to 5 attachments per message' using errcode = '22023';
  end if;
  if v_body = '' and pg_catalog.jsonb_array_length(v_att) = 0 then
    raise exception 'Message is empty' using errcode = '22023';
  end if;
  if not public.chat_links_ok(v_links) then
    raise exception 'Record links must be a list of {type, id} only' using errcode = '22023';
  end if;
  if coalesce(pg_catalog.cardinality(p_mentions), 0) > 50 then
    raise exception 'Too many mentions (max 50)' using errcode = '22023';
  end if;
  if p_parent_id is not null and not exists (
       select 1 from public.chat_messages m
        where m.id = p_parent_id and m.tenant_id = v_tenant and m.channel_id = p_channel_id) then
    raise exception 'The message you reply to was not found in this channel' using errcode = 'P0002';
  end if;

  for v_a in select e.v from pg_catalog.jsonb_array_elements(v_att) as e(v) loop
    if pg_catalog.jsonb_typeof(v_a) <> 'object'
       or pg_catalog.jsonb_typeof(v_a -> 'path') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_a -> 'name') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_a -> 'mime') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_a -> 'size') is distinct from 'number' then
      raise exception 'Each attachment needs path, name, mime and size' using errcode = '22023';
    end if;
    if (v_a ->> 'path') not like v_tenant::text || '/chat/' || p_channel_id::text || '/_%'
       or pg_catalog.strpos(v_a ->> 'path', '..') > 0 then
      raise exception 'An attachment is not in this channel''s folder' using errcode = '22023';
    end if;
    if (v_a ->> 'size')::numeric < 1 or (v_a ->> 'size')::numeric > 10485760 then
      raise exception 'An attachment is empty or larger than 10 MB' using errcode = '22023';
    end if;
    if pg_catalog.char_length(v_a ->> 'name') not between 1 and 255
       or pg_catalog.char_length(v_a ->> 'mime') not between 1 and 127 then
      raise exception 'An attachment name or type is empty or too long' using errcode = '22023';
    end if;
  end loop;

  -- rate limit: 30 messages a minute per user (lock first, so two tabs cannot both pass)
  perform pg_catalog.pg_advisory_xact_lock(2295, pg_catalog.hashtext(v_uid::text));
  v_now := pg_catalog.clock_timestamp();
  if (select count(*) from public.chat_messages m
       where m.tenant_id = v_tenant and m.author_id = v_uid
         and m.created_at > v_now - interval '1 minute') >= 30 then
    raise exception 'Too many messages — wait a minute and send again' using errcode = 'P0001';
  end if;

  -- mentions: active staff members of this channel only, never the author, each once
  select coalesce(pg_catalog.array_agg(distinct m.user_id), '{}'::uuid[]) into v_mentions
    from public.chat_members m
    join public.users u on u.id = m.user_id and u.tenant_id = m.tenant_id
   where m.channel_id = p_channel_id
     and m.tenant_id = v_tenant
     and m.user_id = any (coalesce(p_mentions, '{}'::uuid[]))
     and m.user_id <> v_uid
     and u.is_active
     and u.role::text not in ('partner_agent', 'personal');

  insert into public.chat_messages
    (tenant_id, channel_id, author_id, parent_id, body, kind, post_status, mentions, links, created_at)
  values
    (v_tenant, p_channel_id, v_uid, p_parent_id, v_body, v_kind,
     case when v_kind in ('problem', 'suggestion') then 'open' end, v_mentions, v_links, v_now)
  returning id into v_id;

  insert into public.chat_attachments
    (tenant_id, message_id, channel_id, file_path, file_name, mime, size_bytes, uploaded_by, created_at)
  select v_tenant, v_id, p_channel_id, e.v ->> 'path', e.v ->> 'name', e.v ->> 'mime',
         (e.v ->> 'size')::numeric::bigint, v_uid, v_now
    from pg_catalog.jsonb_array_elements(v_att) as e(v);

  if pg_catalog.cardinality(v_mentions) > 0 then
    select coalesce(nullif(pg_catalog.btrim(u.full_name), ''), 'A teammate') into v_author
      from public.users u where u.id = v_uid;
    v_where := case when v_ch.kind = 'dm' then 'a direct message' else '#' || v_ch.name end;
    insert into public.notifications (tenant_id, user_id, kind, title, body, href, entity_id)
    select v_tenant, m.user_id, 'chat.mention',
           pg_catalog.left(coalesce(v_author, 'A teammate') || ' mentioned you in ' || v_where, 200),
           nullif(pg_catalog.left(v_body, 140), ''),
           '/team-chat?c=' || p_channel_id::text || '&m=' || v_id::text,
           v_id::text
      from public.chat_members m
     where m.channel_id = p_channel_id
       and m.tenant_id = v_tenant
       and m.user_id = any (v_mentions)
       and m.notify <> 'none';
  end if;

  update public.chat_members m
     set last_read_at = greatest(coalesce(m.last_read_at, '-infinity'::timestamptz), v_now)
   where m.channel_id = p_channel_id and m.user_id = v_uid and m.tenant_id = v_tenant;

  return v_id;
end;
$$;

-- ── edit ────────────────────────────────────────────────────────────────────────────
create or replace function public.chat_edit_message(p_message_id uuid, p_body text) returns void
  language plpgsql security definer set search_path = ''
as $$
-- R-2295: the author edits their own message within 15 minutes; the old text is kept.
declare
  v_uid    uuid := public.current_user_id();
  v_tenant uuid := public.current_tenant_id();
  v_m      record;
  v_body   text := pg_catalog.btrim(coalesce(p_body, ''));
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;

  select m.id, m.channel_id, m.author_id, m.body, m.deleted_at, m.created_at into v_m
    from public.chat_messages m
   where m.id = p_message_id and m.tenant_id = v_tenant
   for update;
  if v_m.id is null or not public.chat_can_read(v_m.channel_id) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  if v_m.author_id is distinct from v_uid then
    raise exception 'You can only edit your own messages' using errcode = '42501';
  end if;
  if not public.is_chat_member(v_m.channel_id) then
    raise exception 'You are not a member of this channel' using errcode = '42501';
  end if;
  if v_m.deleted_at is not null then
    raise exception 'This message was deleted' using errcode = '22023';
  end if;
  if v_m.created_at < pg_catalog.clock_timestamp() - interval '15 minutes' then
    raise exception 'Messages can be edited for 15 minutes only' using errcode = '42501';
  end if;
  if v_body = '' then
    raise exception 'Message is empty — delete it instead' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_body) > 4000 then
    raise exception 'Message is too long (max 4000 characters)' using errcode = '22023';
  end if;
  if v_body = v_m.body then
    return;
  end if;

  insert into public.chat_message_edits (tenant_id, message_id, channel_id, old_body, edited_by)
  values (v_tenant, v_m.id, v_m.channel_id, v_m.body, v_uid);

  update public.chat_messages m
     set body = v_body, edited_at = pg_catalog.clock_timestamp()
   where m.id = v_m.id;

  -- no message text here: owner/manager read activity_log, and DMs stay private
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, v_uid, 'update', 'chat_message', v_m.id::text, 'Edited a team chat message',
          pg_catalog.jsonb_build_object('channel_id', v_m.channel_id));
end;
$$;

-- ── delete (soft) ───────────────────────────────────────────────────────────────────
create or replace function public.chat_delete_message(p_message_id uuid) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
-- R-2295: the author or the owner deletes a message: the row stays (thread + order intact), its
-- text, links, mentions and attachment rows go. Returns the removed file paths.
declare
  v_uid    uuid := public.current_user_id();
  v_tenant uuid := public.current_tenant_id();
  v_m      record;
  v_paths  jsonb;
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;

  select m.id, m.channel_id, m.author_id, m.deleted_at into v_m
    from public.chat_messages m
   where m.id = p_message_id and m.tenant_id = v_tenant
   for update;
  if v_m.id is null or not public.chat_can_read(v_m.channel_id) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  if v_m.author_id is distinct from v_uid
     and not exists (select 1 from public.users u
                      where u.id = v_uid and u.tenant_id = v_tenant and u.role::text = 'owner') then
    raise exception 'Only the author or the owner can delete this message' using errcode = '42501';
  end if;
  if v_m.deleted_at is not null then
    return pg_catalog.jsonb_build_object('deleted', true, 'file_paths', '[]'::jsonb);
  end if;

  with d as (
    delete from public.chat_attachments a
     where a.message_id = v_m.id and a.tenant_id = v_tenant
    returning a.file_path)
  select coalesce(pg_catalog.jsonb_agg(d.file_path order by d.file_path), '[]'::jsonb) into v_paths from d;

  update public.chat_messages m
     set body = '', links = '[]'::jsonb, mentions = '{}'::uuid[],
         pinned_at = null, pinned_by = null,
         deleted_at = pg_catalog.clock_timestamp(), deleted_by = v_uid
   where m.id = v_m.id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, v_uid, 'delete', 'chat_message', v_m.id::text,
          case when v_m.author_id is distinct from v_uid then 'Deleted a teammate''s team chat message'
               else 'Deleted a team chat message' end,
          pg_catalog.jsonb_build_object('channel_id', v_m.channel_id, 'author_id', v_m.author_id,
                                        'files_removed', pg_catalog.jsonb_array_length(v_paths)));

  return pg_catalog.jsonb_build_object('deleted', true, 'file_paths', v_paths);
end;
$$;

-- ── mark read ───────────────────────────────────────────────────────────────────────
create or replace function public.chat_mark_read(p_channel_id uuid, p_at timestamptz default null)
returns timestamptz
  language plpgsql security definer set search_path = ''
as $$
-- R-2295: move the caller's read mark forward (never back, never past now).
declare
  v_uid    uuid := public.current_user_id();
  v_tenant uuid := public.current_tenant_id();
  v_now    timestamptz := pg_catalog.clock_timestamp();
  v_at     timestamptz;
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;
  if not public.is_chat_member(p_channel_id) then
    raise exception 'You are not a member of this channel' using errcode = '42501';
  end if;

  update public.chat_members m
     set last_read_at = greatest(coalesce(m.last_read_at, '-infinity'::timestamptz),
                                 least(coalesce(p_at, v_now), v_now))
   where m.channel_id = p_channel_id and m.user_id = v_uid and m.tenant_id = v_tenant
  returning m.last_read_at into v_at;
  return v_at;
end;
$$;

-- ── open DM ─────────────────────────────────────────────────────────────────────────
create or replace function public.chat_open_dm(p_user_id uuid) returns uuid
  language plpgsql security definer set search_path = ''
as $$
-- R-2295: the one DM between the caller and a teammate (made on first use). dm_key = the two ids
-- sorted "lower:higher", unique per company, so two people opening it at once get the same one.
declare
  v_uid    uuid := public.current_user_id();
  v_tenant uuid := public.current_tenant_id();
  v_key    text;
  v_id     uuid;
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;
  if p_user_id = v_uid then
    raise exception 'You cannot send a direct message to yourself' using errcode = '22023';
  end if;
  if p_user_id is null or not exists (
       select 1 from public.users u
        where u.id = p_user_id and u.tenant_id = v_tenant and u.is_active
          and u.role::text not in ('partner_agent', 'personal')) then
    raise exception 'That teammate was not found' using errcode = 'P0002';
  end if;

  v_key := case when v_uid::text < p_user_id::text
                then v_uid::text || ':' || p_user_id::text
                else p_user_id::text || ':' || v_uid::text end;

  insert into public.chat_channels (tenant_id, kind, is_private, dm_key, created_by)
  values (v_tenant, 'dm', true, v_key, v_uid)
  on conflict (tenant_id, dm_key) where kind = 'dm' do nothing
  returning id into v_id;
  if v_id is null then
    select c.id into v_id from public.chat_channels c
     where c.tenant_id = v_tenant and c.kind = 'dm' and c.dm_key = v_key;
  end if;

  insert into public.chat_members (tenant_id, channel_id, user_id)
  values (v_tenant, v_id, v_uid), (v_tenant, v_id, p_user_id)
  on conflict (channel_id, user_id) do nothing;

  return v_id;
end;
$$;

-- ── create channel ──────────────────────────────────────────────────────────────────
create or replace function public.chat_create_channel(
  p_name       text,
  p_is_private boolean default false,
  p_topic      text    default null,
  p_member_ids uuid[]  default '{}'
) returns uuid
  language plpgsql security definer set search_path = ''
as $$
-- R-2295: owner/manager create a channel (decision 1); the creator is its admin.
declare
  v_uid     uuid := public.current_user_id();
  v_tenant  uuid := public.current_tenant_id();
  v_name    text := pg_catalog.btrim(coalesce(p_name, ''));
  v_topic   text := nullif(pg_catalog.btrim(coalesce(p_topic, '')), '');
  v_private boolean := coalesce(p_is_private, false);
  v_slug    text;
  v_id      uuid;
  v_added   int;
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;
  if not exists (select 1 from public.users u
                  where u.id = v_uid and u.tenant_id = v_tenant and u.role::text in ('owner', 'manager')) then
    raise exception 'Only the owner or a manager can create channels' using errcode = '42501';
  end if;

  v_slug := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(v_name), '[^a-z0-9]+', '-', 'g'), '-');
  v_slug := pg_catalog.btrim(pg_catalog.left(v_slug, 80), '-');
  if v_slug = '' or pg_catalog.char_length(v_name) > 80 then
    raise exception 'Give the channel a name with letters or numbers (up to 80 characters)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(v_topic, '')) > 250 then
    raise exception 'Channel topic is too long (max 250 characters)' using errcode = '22023';
  end if;
  if exists (select 1 from public.chat_channels c
              where c.tenant_id = v_tenant and c.kind = 'channel' and c.slug = v_slug) then
    raise exception 'A channel with this name already exists' using errcode = '23505';
  end if;

  begin
    insert into public.chat_channels (tenant_id, kind, name, slug, topic, is_private, created_by)
    values (v_tenant, 'channel', v_name, v_slug, v_topic, v_private, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'A channel with this name already exists' using errcode = '23505';
  end;

  insert into public.chat_members (tenant_id, channel_id, user_id, member_role)
  values (v_tenant, v_id, v_uid, 'admin');

  insert into public.chat_members (tenant_id, channel_id, user_id, member_role)
  select distinct v_tenant, v_id, u.id, 'member'
    from public.users u
   where u.id = any (coalesce(p_member_ids, '{}'::uuid[]))
     and u.id <> v_uid
     and u.tenant_id = v_tenant
     and u.is_active
     and u.role::text not in ('partner_agent', 'personal');
  get diagnostics v_added = row_count;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, v_uid, 'create', 'chat_channel', v_id::text,
          case when v_private then 'Created a private team chat channel'
               else 'Created team chat channel #' || v_name end,
          pg_catalog.jsonb_build_object('is_private', v_private, 'members_added', v_added));

  return v_id;
end;
$$;

-- ── unread counts ───────────────────────────────────────────────────────────────────
create or replace function public.chat_unread_counts()
returns table (channel_id uuid, unread integer, mentions integer)
  language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
-- R-2295: per member channel (not archived): others' undeleted messages after the read mark,
-- and how many of them mention the caller. Channels with nothing unread are left out.
declare
  v_uid    uuid := public.current_user_id();
  v_tenant uuid := public.current_tenant_id();
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;

  return query
  select m.channel_id,
         count(*)::integer,
         (count(*) filter (where v_uid = any (x.mentions)))::integer
    from public.chat_members m
    join public.chat_channels c
      on c.id = m.channel_id and c.tenant_id = m.tenant_id and c.archived_at is null
    join public.chat_messages x
      on x.channel_id = m.channel_id and x.tenant_id = m.tenant_id
   where m.user_id = v_uid
     and m.tenant_id = v_tenant
     and x.created_at > coalesce(m.last_read_at, '-infinity'::timestamptz)
     and x.author_id is distinct from v_uid
     and x.deleted_at is null
   group by m.channel_id;
end;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────────────
revoke all on function
  public.chat_post_message(uuid, text, text, uuid, uuid[], jsonb, jsonb),
  public.chat_edit_message(uuid, text),
  public.chat_delete_message(uuid),
  public.chat_mark_read(uuid, timestamptz),
  public.chat_open_dm(uuid),
  public.chat_create_channel(text, boolean, text, uuid[]),
  public.chat_unread_counts()
  from public, anon;
grant execute on function
  public.chat_post_message(uuid, text, text, uuid, uuid[], jsonb, jsonb),
  public.chat_edit_message(uuid, text),
  public.chat_delete_message(uuid),
  public.chat_mark_read(uuid, timestamptz),
  public.chat_open_dm(uuid),
  public.chat_create_channel(text, boolean, text, uuid[]),
  public.chat_unread_counts()
  to authenticated, service_role;

commit;
