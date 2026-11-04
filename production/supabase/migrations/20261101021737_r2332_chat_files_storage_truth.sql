-- deploy-peek: to_regclass('public.chat_upload_tickets') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.chat_post_message(uuid,text,text,uuid,uuid[],jsonb,jsonb)') and prosrc like '%R-2332%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.storage_object_allowed(text,text,text,uuid)') and prosrc like '%R-2332%')
-- deploy-key: r2332chatfilestruth
-- deploy-user: postgres
-- 20261101021737_r2332_chat_files_storage_truth.sql
--
-- R-2332 (G-TEAMCHAT, found by the R-2305 audit #5–#7, 1 Nov 2026): team chat files — storage
-- is the truth.
--   #5 a file removed from the composer (or of a deleted message when the browser's storage
--      delete failed) stayed in storage, and every reader of the channel could list / open it;
--   #6 chat_post_message trusted the caller's mime / size / path (text/html, a fake size, odd
--      paths, the same path on two messages);
--   #7 a member could upload straight to storage, skipping the upload route's bytes check and
--      its 10 MB cap (the documents bucket allows 20 MB and is shared with other features, so
--      its limit is not the place to fix it).
--
-- WHAT CHANGES
--   1. public.chat_upload_tickets + chat_upload_ticket_open / _close (service_role only). The
--      upload route (POST /api/team-chat/upload), AFTER its own checks (member, type, real
--      bytes, 10 MB), opens a ticket for the exact path it is about to write, uploads with the
--      CALLER's session (owner = caller, as before) and closes the ticket. A browser cannot
--      open a ticket, so a direct upload into a chat folder is refused (#7). A ticket lives at
--      most 10 minutes and is single-use (closed right after the upload).
--   2. public.storage_object_allowed, chat branch (R-2297 body otherwise unchanged):
--        select  chat_can_read(channel) AND (the file is on a message — a chat_attachments row
--                — OR the caller uploaded it OR the caller is the tenant owner). A file not on
--                any message (removed from the composer, or of a deleted message) is no longer
--                seen by the channel's readers (#5). The owner still sees it so the owner's
--                "delete a teammate's message" can remove it.
--        insert  member, as itself, AND an open ticket for this exact path and caller (#7).
--        delete  uploader or owner in a channel they can read, AND the file is on no message
--                (a live message's file cannot be pulled from under it; chat_delete_message
--                removes the rows first, then the browser deletes the files — R-2295).
--        update  never.
--   3. public.chat_stored_file(path) → (mime, size_bytes): the stored object's own metadata,
--      ONLY for an object the caller uploaded. Owner postgres (reads storage.objects).
--   4. public.chat_post_message (only definition: R-2295, 20261031122037; body copied, guards
--      kept): each attachment path must have the exact shape {tenant}/chat/{channel}/{uuid}_
--      {safe-name}, must exist in storage uploaded by the caller, must not already be on a
--      chat_attachments row (and not twice in one message); mime and size come from storage,
--      not the caller (#6) — only the type list the route accepts, 1 byte .. 10 MB. The display
--      name stays the caller's (1..255). Callers may still send mime/size; they are ignored.
--   5. Index chat_attachments (file_path) — the storage rule looks a path up on every read.
--
-- ORPHANS (#5, the second half): storage.objects cannot be deleted from SQL here (Supabase's
-- storage.protect_delete trigger; the bytes live outside Postgres anyway), so files still go via
-- the Storage API: the composer's remove button now deletes its upload (attachments.tsx), and a
-- deleted message's files are removed by the browser as before. When that browser delete fails
-- the file stays but only its uploader / the owner can see it (rule above). A nightly sweep of
-- such leftovers needs a new cron route — not built here (reported on the card).
--
-- Runs as postgres on Cloud SQL (like R-2297): storage_object_allowed and chat_stored_file are
-- postgres's (storage.objects is the storage admin's, postgres is its member); chat_post_message
-- keeps its owner (create or replace). Idempotent.
-- Test: supabase/tests/team_chat_files_truth.test.sql (+ team_chat_storage, team_chat_rpcs).

begin;

-- ── 1. upload tickets ───────────────────────────────────────────────────────────────
create table if not exists public.chat_upload_tickets (
  path       text primary key,
  tenant_id  uuid not null,
  user_id    uuid not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
comment on table public.chat_upload_tickets is
  'R-2332: one row per team chat upload in progress — written only by the upload route (service_role, chat_upload_ticket_open), read by storage_object_allowed: a chat-folder upload needs an open ticket for its exact path and uploader. Single-use, 10 minutes.';
create index if not exists chat_upload_tickets_created_idx on public.chat_upload_tickets (created_at);
alter table public.chat_upload_tickets enable row level security;
revoke all on table public.chat_upload_tickets from public, anon, authenticated;
-- Cloud SQL has no BYPASSRLS: the house service_role stand-in (R-450). Browsers get nothing.
drop policy if exists zzz_service_role_all on public.chat_upload_tickets;
create policy zzz_service_role_all on public.chat_upload_tickets as permissive for all to service_role
  using (true) with check (true);

create or replace function public.chat_upload_ticket_open(p_user_id uuid, p_path text) returns void
  language plpgsql security definer set search_path = ''
as $$
-- R-2332: the upload route opens a ticket for the path it is about to write (after its own
-- member / type / bytes / size checks). Path shape and the user's tenant are checked again here.
declare
  v_tenant uuid;
  v_parts  text[] := pg_catalog.string_to_array(coalesce(p_path, ''), '/');
begin
  select u.tenant_id into v_tenant
    from public.users u
   where u.id = p_user_id and u.is_active and u.role::text not in ('partner_agent', 'personal');
  if v_tenant is null then
    raise exception 'Not a team chat user' using errcode = '42501';
  end if;
  if coalesce(pg_catalog.cardinality(v_parts), 0) <> 4
     or v_parts[1] <> v_tenant::text
     or v_parts[2] <> 'chat'
     or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9._-]{1,150}$'
     or pg_catalog.strpos(p_path, '..') > 0 then
    raise exception 'Not a team chat file path' using errcode = '22023';
  end if;

  -- old tickets (route crashed between open and close) go here, so the table stays tiny
  delete from public.chat_upload_tickets t where t.created_at < pg_catalog.clock_timestamp() - interval '10 minutes';
  insert into public.chat_upload_tickets (path, tenant_id, user_id)
  values (p_path, v_tenant, p_user_id);
end;
$$;

create or replace function public.chat_upload_ticket_close(p_path text) returns void
  language sql security definer set search_path = ''
as $$
  -- R-2332: single use — the route closes the ticket as soon as its upload has finished.
  delete from public.chat_upload_tickets t where t.path = p_path;
$$;

revoke all on function public.chat_upload_ticket_open(uuid, text) from public, anon, authenticated;
revoke all on function public.chat_upload_ticket_close(text) from public, anon, authenticated;
grant execute on function public.chat_upload_ticket_open(uuid, text) to service_role;
grant execute on function public.chat_upload_ticket_close(text) to service_role;

-- ── 5. path lookups ─────────────────────────────────────────────────────────────────
create index if not exists chat_attachments_file_path_idx on public.chat_attachments (file_path);

-- ── 2. storage rule (R-2297 body + R-2332 chat branch) ──────────────────────────────
create or replace function public.storage_object_allowed(p_bucket text, p_name text, p_op text, p_owner uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.current_tenant_id();
  v_parts  text[];
  v_n      int;
  v_folder text;
  v_file   text;
  v_role   text;
  v_emp    uuid;
  v_mine   boolean;
  v_money  boolean;
  v_hr     boolean;
  v_om     boolean;
  v_own    boolean;
  v_chan   uuid;
  v_on_msg boolean;
begin
  /* R-724 (+ R-2297 chat folder, R-2332 chat files = storage truth). The one rule for who may
     touch a file in a private bucket. Folder 1 is always the caller's tenant; the rest depends
     on the bucket, the folder and the caller's role. */
  if v_uid is null or v_tenant is null or p_name is null or p_op not in ('select', 'insert', 'update', 'delete') then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  v_n     := coalesce(cardinality(v_parts), 0);
  if v_n < 2 or v_parts[1] <> v_tenant::text or '' = any (v_parts) or '.' = any (v_parts) or '..' = any (v_parts) then
    return false;
  end if;
  v_folder := case when v_n >= 3 then v_parts[2] end;
  v_file   := v_parts[v_n];

  select u.role::text, u.employee_id into v_role, v_emp
    from public.users u where u.id = v_uid and u.is_active;
  if v_role is null then return false; end if;

  v_money := v_role in ('owner', 'manager', 'accountant', 'billing');
  v_hr    := v_role in ('owner', 'manager', 'accountant');
  v_om    := v_role in ('owner', 'manager');
  v_mine  := p_owner is not null and p_owner = v_uid;

  if p_bucket = 'employee-docs' then
    if v_folder in ('vendor-bills', 'reimbursements') then
      return case p_op
        when 'select' then v_money or v_mine
        when 'insert' then v_money or (v_folder = 'vendor-bills' and v_mine)
        when 'delete' then v_hr
        else false
      end;
    end if;
    -- {t}/{employeeId}/… — KYC, salary, letters.
    return case p_op when 'update' then false else v_hr end;

  elsif p_bucket = 'attendance-selfies' then
    if v_folder = '_enroll' then
      return p_op = 'select' and v_hr;
    end if;
    v_own := v_n = 3 and v_emp is not null and left(v_file, 37) = v_emp::text || '_';
    return case p_op
      when 'select' then v_money or v_own
      when 'insert' then v_own
      when 'update' then v_own
      else false
    end;

  elsif p_bucket = 'documents' then
    /* R-2297: team chat files {t}/chat/{channel}/{uuid}_{safe-name} — the channel decides, not
       the role. Any other shape under chat/ is refused (never the owner/manager default).
       R-2332: storage is the truth —
         read   = chat_can_read(channel) AND (the file is on a message, or the caller uploaded
                  it, or the caller is the owner): a removed / orphan file is not shown to the
                  channel's readers;
         upload = a member, as itself, with an open upload ticket for this exact path (only the
                  upload route opens one, after its bytes + 10 MB checks);
         delete = the uploader, or the owner where it can read, and only while the file is on
                  no message;
         no replace. */
    if v_folder = 'chat' then
      if v_n <> 4
         or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or v_file !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9._-]{1,150}$'
         or position('..' in v_file) > 0 then
        return false;
      end if;
      v_chan := v_parts[3]::uuid;
      if p_op in ('select', 'delete') then
        v_on_msg := exists (select 1 from public.chat_attachments a
                             where a.file_path = p_name and a.tenant_id = v_tenant and a.channel_id = v_chan);
      end if;
      return case p_op
        when 'select' then public.chat_can_read(v_chan) and (v_on_msg or v_mine or v_role = 'owner')
        when 'insert' then v_mine and public.is_chat_member(v_chan)
                           and exists (select 1 from public.chat_upload_tickets t
                                        where t.path = p_name and t.user_id = v_uid and t.tenant_id = v_tenant
                                          and t.created_at > clock_timestamp() - interval '10 minutes')
        when 'delete' then (v_mine or v_role = 'owner') and public.chat_can_read(v_chan) and not v_on_msg
        else false
      end;
    elsif v_folder = 'feedback' then
      return case p_op
        when 'select' then v_om or v_mine
        when 'insert' then v_mine
        else false
      end;
    elsif v_folder in ('payments', 'inbound-bills') then
      return p_op = 'select' and v_money;
    end if;
    return v_om;

  elsif p_bucket = 'tds-certificates' then
    return v_money;
  end if;

  return false;
end;
$function$;

comment on function public.storage_object_allowed(text, text, text, uuid) is
  'R-724: who may select/insert/update/delete a file in employee-docs, attendance-selfies, documents and tds-certificates — tenant folder AND role (and own employee / own upload where the app needs it). R-2297: documents {tenant}/chat/{channel}/{uuid}_{name} follows the team chat channel (chat_can_read / is_chat_member). R-2332: chat files — read only while on a message (or by uploader / owner), upload only with the route''s ticket, delete only while on no message.';

revoke all on function public.storage_object_allowed(text, text, text, uuid) from public, anon;
grant execute on function public.storage_object_allowed(text, text, text, uuid) to authenticated, service_role, supabase_storage_admin;

-- ── 3. the stored file's own type and size ──────────────────────────────────────────
create or replace function public.chat_stored_file(p_path text)
returns table (mime text, size_bytes bigint)
  language sql stable security definer set search_path = ''
as $$
  -- R-2332: what storage recorded for a chat file the CALLER uploaded (nothing for anyone else's).
  select pg_catalog.lower(pg_catalog.split_part(o.metadata ->> 'mimetype', ';', 1)),
         case when (o.metadata ->> 'size') ~ '^[0-9]{1,12}$' then (o.metadata ->> 'size')::bigint end
    from storage.objects o
   where o.bucket_id = 'documents'
     and o.name = p_path
     and o.owner = public.current_user_id()
   limit 1;
$$;
revoke all on function public.chat_stored_file(text) from public, anon;
grant execute on function public.chat_stored_file(text) to authenticated;
do $$
begin
  -- chat_post_message's definer on Cloud SQL (it owns the app's functions) calls it too
  if exists (select 1 from pg_roles where rolname = 'resellersos_migration') then
    execute 'grant execute on function public.chat_stored_file(text) to resellersos_migration';
  end if;
end $$;

-- ── 4. post ─────────────────────────────────────────────────────────────────────────
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
-- R-2332: an attachment is a file the caller uploaded to THIS channel's folder (exact shape),
-- on no other message; its type and size come from storage, not from the caller.
declare
  v_uid      uuid := public.current_user_id();
  v_tenant   uuid := public.current_tenant_id();
  v_ch       record;
  v_body     text := pg_catalog.btrim(coalesce(p_body, ''));
  v_kind     text := coalesce(p_kind, 'text');
  v_links    jsonb := coalesce(p_links, '[]'::jsonb);
  v_att      jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_files    jsonb := '[]'::jsonb;
  v_mentions uuid[];
  v_now      timestamptz;
  v_id       uuid;
  v_author   text;
  v_where    text;
  v_a        jsonb;
  v_path     text;
  v_mime     text;
  v_size     bigint;
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
       or pg_catalog.jsonb_typeof(v_a -> 'name') is distinct from 'string' then
      raise exception 'Each attachment needs path and name' using errcode = '22023';
    end if;
    v_path := v_a ->> 'path';
    -- R-2332: the exact shape the upload route writes, in THIS company + channel
    if v_path !~ ('^' || v_tenant::text || '/chat/' || p_channel_id::text
                  || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9._-]{1,150}$')
       or pg_catalog.strpos(v_path, '..') > 0 then
      raise exception 'An attachment is not in this channel''s folder' using errcode = '22023';
    end if;
    if pg_catalog.char_length(v_a ->> 'name') not between 1 and 255 then
      raise exception 'An attachment name is empty or too long' using errcode = '22023';
    end if;
    if v_files @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('path', v_path)) then
      raise exception 'The same file is attached twice' using errcode = '22023';
    end if;

    -- one message per file: lock the path, then look (two tabs cannot both attach it)
    perform pg_catalog.pg_advisory_xact_lock(2332, pg_catalog.hashtext(v_path));
    if exists (select 1 from public.chat_attachments a where a.file_path = v_path) then
      raise exception 'This file is already on another message — attach it again' using errcode = '22023';
    end if;

    select f.mime, f.size_bytes into v_mime, v_size from public.chat_stored_file(v_path) f;
    if not found then
      raise exception 'An attachment was not uploaded by you — attach the file again' using errcode = '22023';
    end if;
    if v_size is null or v_size < 1 or v_size > 10485760 then
      raise exception 'An attachment is empty or larger than 10 MB' using errcode = '22023';
    end if;
    if v_mime is null or v_mime not in (
         'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'text/plain', 'application/zip') then
      raise exception 'This file type cannot be shared in team chat' using errcode = '22023';
    end if;

    v_files := v_files || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'path', v_path, 'name', v_a ->> 'name', 'mime', v_mime, 'size', v_size));
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
         (e.v ->> 'size')::bigint, v_uid, v_now
    from pg_catalog.jsonb_array_elements(v_files) as e(v);

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

commit;
