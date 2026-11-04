-- deploy-peek: exists (select 1 from pg_proc where oid = to_regprocedure('public.chat_delete_message(uuid)') and prosrc like '%R-2331%') and exists (select 1 from pg_proc where oid = to_regprocedure('public.chat_edit_message(uuid,text)') and prosrc like '%R-2331%') and to_regprocedure('public.chat_can_read_message_edits(uuid,uuid)') is not null and exists (select 1 from pg_proc where oid = to_regprocedure('public.chat_message_report(uuid)') and prosrc like '%R-2331%')
-- deploy-key: r2331chatdeletescrub
-- 20261031231606_r2331_chat_delete_scrub.sql
--
-- R-2331 (G-TEAMCHAT, 1 Nov 2026): team chat delete / edit remove the old text everywhere.
-- Found by the R-2305 audit: after a member edited then deleted a message, the owner / manager
-- still read the original in chat_message_edits.old_body, and the @mention bell item kept its
-- first 140 characters.
--
-- WHAT CHANGES
--   chat_delete_message   (from R-2329 20261031222632, its latest body; system-row rule kept)
--                         in the same call: the message's chat_message_edits rows are deleted,
--                         and its chat.mention / chat.dm bell items read "Message deleted" (the
--                         rows stay, so bell counts and read marks are unchanged).
--   chat_edit_message     (from R-2329, latest; system-row rule kept) the message's chat.mention /
--                         chat.dm bell items get the NEW text (first 140 chars), never the old.
--   edit history          readable only by the message's AUTHOR and the tenant OWNER (was owner +
--                         manager), still only in channels they can read and never in a DM:
--                         new helper chat_can_read_message_edits(channel, message) used by the
--                         chat_message_edits_read policy; chat_can_read_edits(channel) narrowed
--                         to the owner too, so nothing else can lean on the old manager rule.
--   chat_message_to_task / chat_message_report   (from R-2328 20261031221356, the latest bodies,
--                         copied exactly) — the app notice row they write gets author_id NULL
--                         instead of the clicking member (R-2329 follow-up). author_id is
--                         nullable (R-2294), the same-tenant trigger skips NULL, and the screen
--                         draws kind='system' rows without an author.
-- Test: supabase/tests/team_chat_delete_scrub.test.sql. Re-runnable.

begin;

-- ── edit ────────────────────────────────────────────────────────────────────────────
create or replace function public.chat_edit_message(p_message_id uuid, p_body text) returns void
  language plpgsql security definer set search_path = ''
as $$
-- R-2295: the author edits their own message within 15 minutes; the old text is kept.
-- R-2329: an app notice (kind 'system') is never edited, by anyone.
-- R-2331: the message's bell items (chat.mention / chat.dm) show the new text, never the old.
declare
  v_uid    uuid := public.current_user_id();
  v_tenant uuid := public.current_tenant_id();
  v_m      record;
  v_body   text := pg_catalog.btrim(coalesce(p_body, ''));
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;

  select m.id, m.channel_id, m.author_id, m.body, m.kind, m.deleted_at, m.created_at into v_m
    from public.chat_messages m
   where m.id = p_message_id and m.tenant_id = v_tenant
   for update;
  if v_m.id is null or not public.chat_can_read(v_m.channel_id) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  if v_m.kind = 'system' then
    raise exception 'App notices cannot be edited' using errcode = '42501';
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

  -- R-2331: the bell keeps no copy of the old text
  update public.notifications n
     set body = nullif(pg_catalog.left(v_body, 140), '')
   where n.tenant_id = v_tenant
     and n.entity_id = v_m.id::text
     and n.kind in ('chat.mention', 'chat.dm');

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
-- R-2329: an app notice (kind 'system') is never deleted, by anyone (owner included).
-- R-2331: its edit history goes too, and its bell items (chat.mention / chat.dm) read
-- "Message deleted" — the rows stay so bell counts do not jump.
declare
  v_uid    uuid := public.current_user_id();
  v_tenant uuid := public.current_tenant_id();
  v_m      record;
  v_paths  jsonb;
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;

  select m.id, m.channel_id, m.author_id, m.kind, m.deleted_at into v_m
    from public.chat_messages m
   where m.id = p_message_id and m.tenant_id = v_tenant
   for update;
  if v_m.id is null or not public.chat_can_read(v_m.channel_id) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  if v_m.kind = 'system' then
    raise exception 'App notices cannot be deleted' using errcode = '42501';
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

  -- R-2331: no copy of the text survives — not in the edit history, not in the bell
  delete from public.chat_message_edits e
   where e.message_id = v_m.id and e.tenant_id = v_tenant;

  update public.notifications n
     set body = 'Message deleted'
   where n.tenant_id = v_tenant
     and n.entity_id = v_m.id::text
     and n.kind in ('chat.mention', 'chat.dm');

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, v_uid, 'delete', 'chat_message', v_m.id::text,
          case when v_m.author_id is distinct from v_uid then 'Deleted a teammate''s team chat message'
               else 'Deleted a team chat message' end,
          pg_catalog.jsonb_build_object('channel_id', v_m.channel_id, 'author_id', v_m.author_id,
                                        'files_removed', pg_catalog.jsonb_array_length(v_paths)));

  return pg_catalog.jsonb_build_object('deleted', true, 'file_paths', v_paths);
end;
$$;

-- ── edit history: the author and the owner only ─────────────────────────────────────
create or replace function public.chat_can_read_edits(p_channel_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  -- R-2294: edit history — in a channel they can read, never a DM.
  -- R-2331: the OWNER only (manager removed); the author's own rows: chat_can_read_message_edits.
  select public.chat_can_read(p_channel_id)
     and exists (select 1 from public.chat_channels c
                  where c.id = p_channel_id and c.kind = 'channel')
     and exists (select 1 from public.users u
                  where u.id = public.current_user_id()
                    and u.tenant_id = public.current_tenant_id()
                    and u.role::text = 'owner');
$$;

create or replace function public.chat_can_read_message_edits(p_channel_id uuid, p_message_id uuid)
returns boolean
  language sql stable security definer set search_path = ''
as $$
  -- R-2331: a message's edit history — its author or the tenant owner, in a channel they can
  -- read, never a DM. Fail-closed: a NULL channel / message / user gives false.
  select coalesce(
           public.chat_can_read_edits(p_channel_id)
           or (public.chat_can_read(p_channel_id)
               and exists (select 1 from public.chat_channels c
                            where c.id = p_channel_id and c.kind = 'channel')
               and exists (select 1 from public.chat_messages m
                            where m.id = p_message_id
                              and m.channel_id = p_channel_id
                              and m.tenant_id = public.current_tenant_id()
                              and m.author_id = public.current_user_id())),
         false);
$$;
revoke all on function public.chat_can_read_edits(uuid), public.chat_can_read_message_edits(uuid, uuid)
  from public, anon;
grant execute on function public.chat_can_read_edits(uuid), public.chat_can_read_message_edits(uuid, uuid)
  to authenticated, service_role;

drop policy if exists chat_message_edits_read on public.chat_message_edits;
create policy chat_message_edits_read on public.chat_message_edits for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and public.chat_can_read_message_edits(channel_id, message_id));

-- ── R-2328's two RPCs, unchanged except the app notice's author_id (NULL) ───────────
-- ── post → task ─────────────────────────────────────────────────────────────────────
create or replace function public.chat_message_to_task(
  p_message_id uuid,
  p_owner_id   uuid        default null,
  p_due_at     timestamptz default null
) returns uuid
  language plpgsql security definer set search_path = ''
as $$
-- R-2304: make ONE task from a team chat problem / suggestion post.
-- R-2328: a DM / private-channel post — only its poster, and no message text is stored.
-- R-2331: the app notice it writes has no author (author_id NULL) — it is the app speaking.
declare
  v_uid     uuid := public.current_user_id();
  v_tenant  uuid := public.current_tenant_id();
  v_m       record;
  v_owner   uuid := coalesce(p_owner_id, public.current_user_id());
  v_owner_n text;
  v_due     timestamptz;
  v_now     timestamptz := pg_catalog.clock_timestamp();
  v_first   text;
  v_title   text;
  v_href    text;
  v_l       jsonb;
  v_lead    text;
  v_quote   text;
  v_cust    uuid;
  v_sub     uuid;
  v_task    uuid;
  v_private boolean;
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;

  select m.id, m.channel_id, m.parent_id, m.author_id, m.body, m.kind, m.post_status, m.links,
         m.task_id, m.deleted_at
    into v_m
    from public.chat_messages m
   where m.id = p_message_id and m.tenant_id = v_tenant
   for update;
  if v_m.id is null or not public.chat_can_read(v_m.channel_id) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  if not public.is_chat_member(v_m.channel_id) then
    raise exception 'You are not a member of this channel' using errcode = '42501';
  end if;
  -- R-2328: a DM or private channel — only the poster, never the owner / a manager for them
  select (c.kind = 'dm' or c.is_private) into v_private
    from public.chat_channels c
   where c.id = v_m.channel_id and c.tenant_id = v_tenant;
  v_private := coalesce(v_private, true);
  if v_private and v_m.author_id is distinct from v_uid then
    raise exception 'Only the poster can do this with a private or direct-message post' using errcode = '42501';
  end if;
  if v_m.author_id is distinct from v_uid
     and not exists (select 1 from public.users u
                      where u.id = v_uid and u.tenant_id = v_tenant and u.role::text in ('owner', 'manager')) then
    raise exception 'Only the poster, the owner or a manager can make a task from this post' using errcode = '42501';
  end if;
  if v_m.kind not in ('problem', 'suggestion') then
    raise exception 'Only a problem or suggestion post can become a task' using errcode = '22023';
  end if;
  if v_m.deleted_at is not null then
    raise exception 'This message was deleted' using errcode = '22023';
  end if;

  -- idempotent: the post already has its task
  if v_m.task_id is not null and exists (select 1 from public.tasks t
                                          where t.id = v_m.task_id and t.tenant_id = v_tenant) then
    return v_m.task_id;
  end if;

  select coalesce(nullif(pg_catalog.btrim(u.full_name), ''), u.email) into v_owner_n
    from public.users u
   where u.id = v_owner and u.tenant_id = v_tenant and u.is_active
     and u.role::text not in ('partner_agent', 'personal');
  if v_owner_n is null then
    raise exception 'That teammate was not found' using errcode = 'P0002';
  end if;

  v_due := coalesce(p_due_at,
    (((v_now at time zone 'Asia/Kolkata')::date + 1) + time '10:00') at time zone 'Asia/Kolkata');
  if not pg_catalog.isfinite(v_due) or v_due > v_now + interval '5 years' then
    raise exception 'Pick a real due date' using errcode = '22023';
  end if;

  -- first lead / quote / customer / subscription link that exists in THIS company
  -- (R-2328: not for a private post — which record a DM talks about is private too)
  for v_l in select e.v from pg_catalog.jsonb_array_elements(
               case when v_private then '[]'::jsonb else coalesce(v_m.links, '[]'::jsonb) end) as e(v) loop
    if (v_l ->> 'type') = 'lead' then
      select l.id into v_lead from public.leads l where l.id = (v_l ->> 'id') and l.tenant_id = v_tenant;
    elsif (v_l ->> 'type') = 'quote' then
      select q.id into v_quote from public.quotes q where q.id = (v_l ->> 'id') and q.tenant_id = v_tenant;
    elsif (v_l ->> 'type') = 'customer' and (v_l ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select c.id into v_cust from public.customers c where c.id = (v_l ->> 'id')::uuid and c.tenant_id = v_tenant;
    elsif (v_l ->> 'type') = 'subscription' and (v_l ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select s.id into v_sub from public.subscriptions s where s.id = (v_l ->> 'id')::uuid and s.tenant_id = v_tenant;
    end if;
    exit when v_lead is not null or v_quote is not null or v_cust is not null or v_sub is not null;
  end loop;

  v_href  := '/team-chat?c=' || v_m.channel_id::text || '&m=' || v_m.id::text;
  v_first := pg_catalog.btrim(pg_catalog.split_part(pg_catalog.btrim(v_m.body), E'\n', 1));
  v_title := case when v_m.kind = 'problem' then 'Problem: ' else 'Suggestion: ' end
             || coalesce(nullif(pg_catalog.left(v_first, 180), ''), 'from team chat');
  if v_private then
    v_title := 'Team chat post (private)';  -- R-2328: no message text
  end if;

  insert into public.tasks
    (tenant_id, owner_id, title, notes, kind, due_at, status,
     lead_id, quote_id, customer_id, subscription_id, delegated_by, delegated_at)
  values
    (v_tenant, v_owner, v_title,
     case when v_private or pg_catalog.btrim(v_m.body) = '' then '' else pg_catalog.btrim(v_m.body) || E'\n\n' end
       || 'From team chat: ' || v_href,
     'custom', v_due, 'pending',
     v_lead, v_quote, v_cust, v_sub,
     case when v_owner <> v_uid then v_uid end,
     case when v_owner <> v_uid then v_now end)
  returning id into v_task;

  update public.chat_messages m
     set post_status = 'task', task_id = v_task
   where m.id = v_m.id;

  insert into public.chat_messages (tenant_id, channel_id, author_id, parent_id, body, kind, created_at)
  values (v_tenant, v_m.channel_id, null, coalesce(v_m.parent_id, v_m.id),
          'Made a task for ' || v_owner_n || ', due '
            || pg_catalog.to_char(v_due at time zone 'Asia/Kolkata', 'DD Mon YYYY'),
          'system', v_now);

  if v_owner <> v_uid then
    insert into public.notifications (tenant_id, user_id, kind, title, body, href, entity_id)
    values (v_tenant, v_owner, 'task.assigned',
            pg_catalog.left('New task from team chat: ' || v_title, 200),
            null, '/tasks?tab=all&task=' || v_task::text, v_task::text);
  end if;

  -- no message text here: owner/manager read activity_log, and DMs stay private
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, v_uid, 'create', 'task', v_task::text, 'Made a task from a team chat post',
          pg_catalog.jsonb_build_object('channel_id', v_m.channel_id, 'message_id', v_m.id,
                                        'owner_id', v_owner));

  return v_task;
end;
$$;

-- ── post → bug / idea report ────────────────────────────────────────────────────────
create or replace function public.chat_message_report(p_message_id uuid) returns uuid
  language plpgsql security definer set search_path = ''
as $$
-- R-2304: file a team chat problem (bug) / suggestion (feature) as an in-app report.
-- R-2328: a DM / private-channel post — only its poster, and no message text is stored.
-- R-2331: the app notice it writes has no author (author_id NULL) — it is the app speaking.
declare
  v_uid    uuid := public.current_user_id();
  v_tenant uuid := public.current_tenant_id();
  v_m      record;
  v_me     record;
  v_now    timestamptz := pg_catalog.clock_timestamp();
  v_first  text;
  v_body   text;
  v_type   text;
  v_fb     uuid;
  v_private boolean;
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;

  select m.id, m.channel_id, m.parent_id, m.author_id, m.body, m.kind, m.post_status,
         m.feedback_id, m.deleted_at
    into v_m
    from public.chat_messages m
   where m.id = p_message_id and m.tenant_id = v_tenant
   for update;
  if v_m.id is null or not public.chat_can_read(v_m.channel_id) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  if not public.is_chat_member(v_m.channel_id) then
    raise exception 'You are not a member of this channel' using errcode = '42501';
  end if;
  -- R-2328: a DM or private channel — only the poster, never the owner / a manager for them
  select (c.kind = 'dm' or c.is_private) into v_private
    from public.chat_channels c
   where c.id = v_m.channel_id and c.tenant_id = v_tenant;
  v_private := coalesce(v_private, true);
  if v_private and v_m.author_id is distinct from v_uid then
    raise exception 'Only the poster can do this with a private or direct-message post' using errcode = '42501';
  end if;
  if v_m.author_id is distinct from v_uid
     and not exists (select 1 from public.users u
                      where u.id = v_uid and u.tenant_id = v_tenant and u.role::text in ('owner', 'manager')) then
    raise exception 'Only the poster, the owner or a manager can report this post' using errcode = '42501';
  end if;
  if v_m.kind not in ('problem', 'suggestion') then
    raise exception 'Only a problem or suggestion post can be reported' using errcode = '22023';
  end if;
  if v_m.deleted_at is not null then
    raise exception 'This message was deleted' using errcode = '22023';
  end if;

  if v_m.feedback_id is not null and exists (select 1 from public.feedback f
                                              where f.id = v_m.feedback_id and f.tenant_id = v_tenant) then
    return v_m.feedback_id;
  end if;

  select u.full_name, u.email into v_me from public.users u where u.id = v_uid;
  v_type  := case when v_m.kind = 'problem' then 'bug' else 'feature' end;
  v_body  := pg_catalog.btrim(v_m.body);
  v_first := pg_catalog.btrim(pg_catalog.split_part(v_body, E'\n', 1));
  v_first := coalesce(nullif(pg_catalog.left(v_first, 200), ''),
                      case when v_m.kind = 'problem' then 'Problem from team chat' else 'Suggestion from team chat' end);
  if v_private then
    -- R-2328: no message text — only the link back to the post
    v_first := 'Team chat post (private)';
    v_body  := 'Private team chat post — open it in team chat: /team-chat?c=' || v_m.channel_id::text
               || '&m=' || v_m.id::text;
  end if;

  insert into public.feedback
    (tenant_id, reported_type, reported_severity, title, body, page_path,
     reported_by, reporter_name, reporter_email, filed_via)
  values
    (v_tenant, v_type, 'medium', v_first, coalesce(nullif(v_body, ''), v_first),
     '/team-chat?c=' || v_m.channel_id::text || '&m=' || v_m.id::text,
     v_uid, v_me.full_name, v_me.email, 'form')
  returning id into v_fb;

  -- image files of the post = the report's screenshots (same documents-bucket file, no copy)
  insert into public.feedback_screenshots (feedback_id, tenant_id, file_path, file_name, byte_size)
  select v_fb, v_tenant, a.file_path, a.file_name, a.size_bytes::int
    from public.chat_attachments a
   where not v_private  -- R-2328: a private post's image stays in the chat
     and a.message_id = v_m.id and a.tenant_id = v_tenant and a.mime like 'image/%'
   order by a.created_at, a.id;

  update public.chat_messages m
     set feedback_id = v_fb,
         post_status = case when m.post_status = 'task' then 'task' else 'reported' end
   where m.id = v_m.id;

  insert into public.chat_messages (tenant_id, channel_id, author_id, parent_id, body, kind, created_at)
  values (v_tenant, v_m.channel_id, null, coalesce(v_m.parent_id, v_m.id),
          case when v_type = 'bug' then 'Reported as a bug' else 'Sent as an idea' end,
          'system', v_now);

  return v_fb;
end;
$$;

-- ── grants (unchanged; restated so this file stands alone) ──────────────────────────
revoke all on function public.chat_edit_message(uuid, text), public.chat_delete_message(uuid) from public, anon;
grant execute on function public.chat_edit_message(uuid, text), public.chat_delete_message(uuid)
  to authenticated, service_role;
revoke all on function
  public.chat_message_to_task(uuid, uuid, timestamptz),
  public.chat_message_report(uuid)
  from public, anon;
grant execute on function
  public.chat_message_to_task(uuid, uuid, timestamptz),
  public.chat_message_report(uuid)
  to authenticated, service_role;

commit;
