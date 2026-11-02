-- deploy-peek: exists (select 1 from pg_proc where oid = to_regprocedure('public.chat_edit_message(uuid,text)') and prosrc like '%R-2333%') and exists (select 1 from pg_proc where oid = to_regprocedure('public.chat_message_to_task(uuid,uuid,timestamp with time zone)') and prosrc like '%R-2333%') and exists (select 1 from pg_proc where oid = to_regprocedure('public.chat_message_report(uuid)') and prosrc like '%R-2333%') and exists (select 1 from pg_proc where oid = to_regprocedure('public.chat_create_channel(text,boolean,text,uuid[])') and prosrc like '%R-2333%')
-- deploy-key: r2333chatratelimits
-- 20261101000724_r2333_chat_rate_limits.sql
--
-- R-2333 (G-TEAMCHAT, 1 Nov 2026): team chat rate limits on edits, Make a task / Report and new
-- channels. Found by the R-2305 audit (#9): the 30-a-minute limit counted posts only
-- (chat_post_message); edits within 15 minutes were unlimited (each adds a chat_message_edits
-- row of up to 4,000 characters), and to-task / report / create channel had no limit.
--
-- WHAT CHANGES (same approach as the post limit: count this user's own rows of the last minute,
-- refuse with P0001 "Too many … — wait a minute …"; refused and no-op calls write nothing, so
-- they never use the allowance; app notices (author_id NULL) are never counted against anyone)
--   chat_edit_message     (from R-2331 20261031231606, latest body) ≤ 20 edits a minute per user
--                         (counted from chat_message_edits.edited_by).
--   chat_message_to_task  (from R-2331, latest) + chat_message_report (from R-2331, latest)
--                         together ≤ 10 a minute per user (counted from the to-task activity_log
--                         row + the team-chat feedback rows the user filed). A post that already
--                         has its task / report still returns it (not counted, not refused).
--   chat_create_channel   (from R-2295 20261031122037, the only definition) ≤ 5 a minute per user
--                         (counted from chat_channels.created_by).
--   Each takes one per-user advisory lock (2333) right after the sign-in check, BEFORE any row
--   lock, so two tabs cannot race past a limit and the lock order cannot deadlock.
--   Everything else in the four bodies is copied exactly (R-2328 private-post rules, R-2329
--   system-row refusal, R-2331 bell scrub + author_id NULL).
-- Test: supabase/tests/team_chat_rate_limits.test.sql. Re-runnable.

begin;

-- ── edit ────────────────────────────────────────────────────────────────────────────
create or replace function public.chat_edit_message(p_message_id uuid, p_body text) returns void
  language plpgsql security definer set search_path = ''
as $$
-- R-2295: the author edits their own message within 15 minutes; the old text is kept.
-- R-2329: an app notice (kind 'system') is never edited, by anyone.
-- R-2331: the message's bell items (chat.mention / chat.dm) show the new text, never the old.
-- R-2333: at most 20 edits a minute per user.
declare
  v_uid    uuid := public.current_user_id();
  v_tenant uuid := public.current_tenant_id();
  v_m      record;
  v_body   text := pg_catalog.btrim(coalesce(p_body, ''));
begin
  if v_uid is null or v_tenant is null or not public.chat_is_staff() then
    raise exception 'Sign in as a team member to use team chat' using errcode = '28000';
  end if;

  -- R-2333: one lock per user, taken before any row lock (two tabs cannot race past the limit,
  -- and every counting chat RPC takes its locks in the same order)
  perform pg_catalog.pg_advisory_xact_lock(2333, pg_catalog.hashtext(v_uid::text));

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

  -- R-2333: rate limit — 20 edits a minute per user (each edit keeps a copy of the old text)
  if (select count(*) from public.chat_message_edits e
       where e.tenant_id = v_tenant and e.edited_by = v_uid
         and e.edited_at > pg_catalog.clock_timestamp() - interval '1 minute') >= 20 then
    raise exception 'Too many edits — wait a minute and try again' using errcode = 'P0001';
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
-- R-2333: Make a task + Report together, at most 10 a minute per user.
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

  -- R-2333: one lock per user, taken before any row lock (two tabs cannot race past the limit,
  -- and every counting chat RPC takes its locks in the same order)
  perform pg_catalog.pg_advisory_xact_lock(2333, pg_catalog.hashtext(v_uid::text));

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

  -- R-2333: rate limit — Make a task + Report together, 10 a minute per user
  if (select count(*) from public.activity_log a
       where a.tenant_id = v_tenant and a.user_id = v_uid
         and a.entity = 'task' and a.label = 'Made a task from a team chat post'
         and a.created_at > pg_catalog.clock_timestamp() - interval '1 minute')
     + (select count(*) from public.feedback f
         where f.tenant_id = v_tenant and f.reported_by = v_uid
           and f.page_path like '/team-chat?c=%'
           and f.created_at > pg_catalog.clock_timestamp() - interval '1 minute') >= 10 then
    raise exception 'Too many tasks and reports from chat — wait a minute and try again' using errcode = 'P0001';
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
-- R-2333: Make a task + Report together, at most 10 a minute per user.
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

  -- R-2333: one lock per user, taken before any row lock (two tabs cannot race past the limit,
  -- and every counting chat RPC takes its locks in the same order)
  perform pg_catalog.pg_advisory_xact_lock(2333, pg_catalog.hashtext(v_uid::text));

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

  -- R-2333: rate limit — Make a task + Report together, 10 a minute per user
  if (select count(*) from public.activity_log a
       where a.tenant_id = v_tenant and a.user_id = v_uid
         and a.entity = 'task' and a.label = 'Made a task from a team chat post'
         and a.created_at > pg_catalog.clock_timestamp() - interval '1 minute')
     + (select count(*) from public.feedback f
         where f.tenant_id = v_tenant and f.reported_by = v_uid
           and f.page_path like '/team-chat?c=%'
           and f.created_at > pg_catalog.clock_timestamp() - interval '1 minute') >= 10 then
    raise exception 'Too many tasks and reports from chat — wait a minute and try again' using errcode = 'P0001';
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
-- R-2333: at most 5 new channels a minute per user.
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

  -- R-2333: one lock per user, taken before any row lock (two tabs cannot race past the limit,
  -- and every counting chat RPC takes its locks in the same order)
  perform pg_catalog.pg_advisory_xact_lock(2333, pg_catalog.hashtext(v_uid::text));
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

  -- R-2333: rate limit — 5 new channels a minute per user
  if (select count(*) from public.chat_channels c
       where c.tenant_id = v_tenant and c.kind = 'channel' and c.created_by = v_uid
         and c.created_at > pg_catalog.clock_timestamp() - interval '1 minute') >= 5 then
    raise exception 'Too many new channels — wait a minute and try again' using errcode = 'P0001';
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

-- ── grants (unchanged; restated so this file stands alone) ──────────────────────────
revoke all on function
  public.chat_edit_message(uuid, text),
  public.chat_message_to_task(uuid, uuid, timestamptz),
  public.chat_message_report(uuid),
  public.chat_create_channel(text, boolean, text, uuid[])
  from public, anon;
grant execute on function
  public.chat_edit_message(uuid, text),
  public.chat_message_to_task(uuid, uuid, timestamptz),
  public.chat_message_report(uuid),
  public.chat_create_channel(text, boolean, text, uuid[])
  to authenticated, service_role;

commit;
