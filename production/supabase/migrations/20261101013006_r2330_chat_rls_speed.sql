-- deploy-peek: to_regprocedure('public.chat_my_readable_channel_ids()') is not null and to_regclass('public.chat_messages_channel_top_idx') is not null and to_regclass('public.chat_messages_thread_idx') is not null and exists (select 1 from pg_proc where oid = to_regprocedure('public.chat_unread_counts()') and prosrc like '%R-2330%') and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_messages' and policyname = 'chat_messages_read' and qual like '%chat_my_readable_channel_ids%')
-- deploy-key: r2330chatrlsspeed
-- 20261101013006_r2330_chat_rls_speed.sql
--
-- R-2330 (G-TEAMCHAT, 1 Nov 2026): team chat reads were slow because the read rule ran once PER
-- ROW. Found by the R-2305 audit (local, 10,000 messages): chat_can_read(channel_id) in the
-- policies costs ~1.6 ms a row — a 50-message page 84.6 ms (80 ms of it the function), a
-- 200-reply thread ~320 ms; an older page filtered 5,001 rows (91 ms) because the cursor was not
-- index-assisted and the only index sorts id asc while the page sorts id desc.
--
-- WHAT CHANGES
--   chat_my_readable_channel_ids()  NEW. uuid[] of the channels the caller may read — exactly
--        chat_can_read's rule as a set: staff (chat_is_staff) of the channel's tenant AND (public
--        channel OR a member row of the caller). STABLE, SECURITY DEFINER, search_path ''.
--        Fail-closed: not staff / no user / no tenant → '{}' (reads nothing).
--   Policies chat_channels_read / chat_members_read / chat_messages_read / chat_attachments_read
--        use `channel_id = any ((select public.chat_my_readable_channel_ids())::uuid[])` — the scalar
--        sub-select is an InitPlan, evaluated ONCE per query, not once per row. The tenant check
--        stays as it was. Visibility is unchanged (team_chat_* SQL tests unchanged and green).
--        chat_message_edits_read (R-2331, per message) is left as it is — edit rows are few.
--        chat_can_read() stays for the RPCs and the storage rule (R-2297).
--   Indexes  chat_messages_channel_top_idx (channel_id, created_at desc, id desc) where parent_id
--        is null — the page order exactly, so "newest 50" and "50 older than (t, id)" stop after
--        50 rows. chat_messages_thread_idx (parent_id, created_at, id) where parent_id is not
--        null — the thread order; it replaces chat_messages_parent_idx (parent_id), whose
--        single column it starts with.
--   chat_unread_counts()  (from R-2295 20261031122037, the only definition) also skips
--        kind = 'system' rows: since R-2331 an app notice has author_id NULL, so "not my own row"
--        no longer left it out and Make a task gave its own clicker 1 unread.
-- Test: supabase/tests/team_chat_rls_speed.test.sql. Re-runnable.

begin;

-- ── the readable set, once per query ────────────────────────────────────────────────
create or replace function public.chat_my_readable_channel_ids() returns uuid[]
  language sql stable security definer set search_path = ''
as $$
  -- R-2330: chat_can_read(channel) as a set. Staff of their own tenant only; a PUBLIC channel of
  -- that tenant, or a private channel / DM the caller is a member of — the owner included (the
  -- owner does not read others' DMs). Not staff / no user / no tenant → empty array.
  select case
    when public.chat_is_staff() then
      coalesce((
        select pg_catalog.array_agg(c.id)
          from public.chat_channels c
         where c.tenant_id = public.current_tenant_id()
           and ((c.kind = 'channel' and not c.is_private)
                or exists (select 1 from public.chat_members m
                            where m.channel_id = c.id
                              and m.tenant_id = c.tenant_id
                              and m.user_id = public.current_user_id()))), '{}'::uuid[])
    else '{}'::uuid[]
  end;
$$;
comment on function public.chat_my_readable_channel_ids() is
  'R-2330: ids of the team chat channels the caller may read (same rule as chat_can_read) — used once per query by the chat RLS policies.';
revoke all on function public.chat_my_readable_channel_ids() from public, anon;
grant execute on function public.chat_my_readable_channel_ids() to authenticated, service_role;

-- ── policies: the set is an InitPlan (scalar sub-select), not a per-row call ─────────
drop policy if exists chat_channels_read on public.chat_channels;
create policy chat_channels_read on public.chat_channels for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and id = any ((select public.chat_my_readable_channel_ids())::uuid[]));

drop policy if exists chat_members_read on public.chat_members;
create policy chat_members_read on public.chat_members for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and channel_id = any ((select public.chat_my_readable_channel_ids())::uuid[]));

drop policy if exists chat_messages_read on public.chat_messages;
create policy chat_messages_read on public.chat_messages for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and channel_id = any ((select public.chat_my_readable_channel_ids())::uuid[]));

drop policy if exists chat_attachments_read on public.chat_attachments;
create policy chat_attachments_read on public.chat_attachments for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and channel_id = any ((select public.chat_my_readable_channel_ids())::uuid[]));

-- ── indexes in the order the screen reads ───────────────────────────────────────────
create index if not exists chat_messages_channel_top_idx
  on public.chat_messages (channel_id, created_at desc, id desc) where parent_id is null;
create index if not exists chat_messages_thread_idx
  on public.chat_messages (parent_id, created_at, id) where parent_id is not null;
drop index if exists public.chat_messages_parent_idx;

-- ── unread counts: app notices are not unread ───────────────────────────────────────
create or replace function public.chat_unread_counts()
returns table (channel_id uuid, unread integer, mentions integer)
  language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
-- R-2295: per member channel (not archived): others' undeleted messages after the read mark,
-- and how many of them mention the caller. Channels with nothing unread are left out.
-- R-2330: app notices (kind 'system', author_id NULL since R-2331) are never unread.
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
     and x.kind <> 'system'
     and x.deleted_at is null
   group by m.channel_id;
end;
$$;
revoke all on function public.chat_unread_counts() from public, anon;
grant execute on function public.chat_unread_counts() to authenticated, service_role;

commit;
