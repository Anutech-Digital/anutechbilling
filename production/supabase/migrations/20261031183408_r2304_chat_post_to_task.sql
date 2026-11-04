-- deploy-peek: to_regprocedure('public.chat_message_to_task(uuid,uuid,timestamptz)') is not null and to_regprocedure('public.chat_message_report(uuid)') is not null
-- deploy-key: r2304chatposttotask
-- 20261031183408_r2304_chat_post_to_task.sql
--
-- R-2304 (G-TEAMCHAT TC-11, 31 Oct 2026): a team chat Problem / Suggestion post becomes a Task
-- or a bug / idea report. Pardeep (31 Oct): "koi problem ho ya suggestion ho" — these must not
-- get lost in chat. Plan: Anutech-HQ/drafts/TEAM-CHAT/audit-and-plan.md (TC-11). Decision 8:
-- both buttons are shown, the poster chooses.
--
-- FUNCTIONS (plpgsql, SECURITY DEFINER, search_path '', tenant + user from the CALLER — same
-- guards as R-2295's chat RPCs: no user / tenant / not staff → 28000; another company's message
-- or a channel the caller cannot read → P0002 "not found"; not a member → 42501)
--   chat_message_to_task(message, owner default caller, due_at default tomorrow 10:00 IST) → task id
--       the poster (or the owner / a manager) of an undeleted problem/suggestion post; owner must
--       be an active staff teammate of the company. ONE transaction: 1 row in public.tasks (title
--       "Problem: <first line>", notes = message text + link back /team-chat?c=&m=, kind custom,
--       lead/quote/customer/subscription id from the FIRST such record link that exists in this
--       company — tasks allow one link only; a task for someone else is delegated_by the caller
--       and notifies them), post_status 'task' + task_id on the message, one 'system' reply in
--       its thread, an activity_log row (no message text). Idempotent: a post that already has
--       its task returns that task.
--   chat_message_report(message) → feedback id
--       same who/what rules; files the post in public.feedback the way the in-app report form
--       does (lib/queries/feedback.ts submitFeedback): problem → 'bug', suggestion → 'feature',
--       title = first line, page_path = the link back; image attachments become
--       feedback_screenshots rows pointing at the SAME documents-bucket file (no copy). Stores
--       feedback_id; post_status 'reported' unless the post already has a task (stays 'task');
--       one 'system' reply. Idempotent. The screen then asks /api/feedback/triage (not fatal).
-- Test: supabase/tests/team_chat_to_task.test.sql. Re-runnable.

begin;

-- ── post → task ─────────────────────────────────────────────────────────────────────
create or replace function public.chat_message_to_task(
  p_message_id uuid,
  p_owner_id   uuid        default null,
  p_due_at     timestamptz default null
) returns uuid
  language plpgsql security definer set search_path = ''
as $$
-- R-2304: make ONE task from a team chat problem / suggestion post.
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
  for v_l in select e.v from pg_catalog.jsonb_array_elements(coalesce(v_m.links, '[]'::jsonb)) as e(v) loop
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

  insert into public.tasks
    (tenant_id, owner_id, title, notes, kind, due_at, status,
     lead_id, quote_id, customer_id, subscription_id, delegated_by, delegated_at)
  values
    (v_tenant, v_owner, v_title,
     case when pg_catalog.btrim(v_m.body) = '' then '' else pg_catalog.btrim(v_m.body) || E'\n\n' end
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
  values (v_tenant, v_m.channel_id, v_uid, coalesce(v_m.parent_id, v_m.id),
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
   where a.message_id = v_m.id and a.tenant_id = v_tenant and a.mime like 'image/%'
   order by a.created_at, a.id;

  update public.chat_messages m
     set feedback_id = v_fb,
         post_status = case when m.post_status = 'task' then 'task' else 'reported' end
   where m.id = v_m.id;

  insert into public.chat_messages (tenant_id, channel_id, author_id, parent_id, body, kind, created_at)
  values (v_tenant, v_m.channel_id, v_uid, coalesce(v_m.parent_id, v_m.id),
          case when v_type = 'bug' then 'Reported as a bug' else 'Sent as an idea' end,
          'system', v_now);

  return v_fb;
end;
$$;

revoke all on function
  public.chat_message_to_task(uuid, uuid, timestamptz),
  public.chat_message_report(uuid)
  from public, anon;
grant execute on function
  public.chat_message_to_task(uuid, uuid, timestamptz),
  public.chat_message_report(uuid)
  to authenticated, service_role;

commit;
