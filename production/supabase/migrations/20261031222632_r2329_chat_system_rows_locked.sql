-- deploy-peek: exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'chat_edit_message' and p.prosrc like '%R-2329%') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'chat_delete_message' and p.prosrc like '%R-2329%')
-- deploy-key: r2329chatsystemrowslocked
-- 20261031222632_r2329_chat_system_rows_locked.sql
--
-- R-2329 (G-TEAMCHAT, 1 Nov 2026): team chat SYSTEM notices cannot be edited or deleted by users.
-- Found by the R-2305 break-mode audit: chat_edit_message (R-2295) worked on kind='system' rows.
-- Those rows are the app's own notices (e.g. "Made a task for Sales, due 02 Nov 2026", written by
-- chat_message_to_task with the clicking member as author_id), and the screen shows them centred
-- and italic with no author and no "(edited)" — so a member could turn one into a forged app
-- notice ("Owner approved: pay vendor 5 lakh today"), and delete would let anyone erase the trail.
--
-- WHAT CHANGES (both functions start from their latest body, R-2295 20261031122037; only the
-- kind='system' guard is new)
--   chat_edit_message(message, body)   a kind='system' row → 42501 "App notices cannot be edited"
--   chat_delete_message(message)       a kind='system' row → 42501 "App notices cannot be deleted"
--   The rule holds whoever wrote the row (author = the member, NULL, or anyone else) and for every
--   role incl. owner/manager. Ordinary messages keep R-2295's rules (edit: author, 15 minutes;
--   delete: author or owner). The guard runs right after the not-found check, so a row the caller
--   cannot read still says "not found" (no existence leak), and nothing is written on refusal.
--   Direct UPDATE/DELETE on chat_messages stays impossible for authenticated (R-2294: SELECT-only
--   policies and grants) — the SQL test proves it for system rows.
--
-- NOT HERE (R-2328 is rewriting chat_message_to_task / chat_message_report in parallel): writing
-- new system rows with author_id NULL. Not needed for this rule — the guard is on kind.
-- Test: supabase/tests/team_chat_system_rows.test.sql. Re-runnable.

begin;

-- ── edit ────────────────────────────────────────────────────────────────────────────
create or replace function public.chat_edit_message(p_message_id uuid, p_body text) returns void
  language plpgsql security definer set search_path = ''
as $$
-- R-2295: the author edits their own message within 15 minutes; the old text is kept.
-- R-2329: an app notice (kind 'system') is never edited, by anyone.
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

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, v_uid, 'delete', 'chat_message', v_m.id::text,
          case when v_m.author_id is distinct from v_uid then 'Deleted a teammate''s team chat message'
               else 'Deleted a team chat message' end,
          pg_catalog.jsonb_build_object('channel_id', v_m.channel_id, 'author_id', v_m.author_id,
                                        'files_removed', pg_catalog.jsonb_array_length(v_paths)));

  return pg_catalog.jsonb_build_object('deleted', true, 'file_paths', v_paths);
end;
$$;

-- ── grants (unchanged from R-2295; restated so this file stands alone) ──────────────
revoke all on function public.chat_edit_message(uuid, text), public.chat_delete_message(uuid) from public, anon;
grant execute on function public.chat_edit_message(uuid, text), public.chat_delete_message(uuid)
  to authenticated, service_role;

commit;
