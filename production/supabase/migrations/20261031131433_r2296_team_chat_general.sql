-- deploy-peek: to_regprocedure('public.chat_general_backfill()') is not null and exists (select 1 from pg_catalog.pg_trigger where tgname = 'trg_users_chat_general' and tgrelid = to_regclass('public.users'))
-- deploy-key: r2296teamchatgeneral
-- 20261031131433_r2296_team_chat_general.sql
--
-- R-2296 (G-TEAMCHAT TC-03, 31 Oct 2026): #general for every company + auto-join staff.
-- Pardeep (31 Oct): day one of team chat must not be empty — everyone lands in one channel.
-- Plan: Anutech-HQ/drafts/TEAM-CHAT/audit-and-plan.md (TC-03).
--
-- "Staff" = the same rule as chat_is_staff() (R-2294): active, role not partner_agent / personal,
-- and the company is not a personal workspace.
--
-- WHAT IS HERE (all SECURITY DEFINER, search_path '', NOT callable by signed-in users or anon)
--   chat_general_ensure(tenant) → channel id   the company's public #general (slug general);
--       reuses a channel already named general; creates one (created_by = first active owner)
--       when missing; a personal workspace → NULL (no team chat there).
--   chat_general_sync_user(user)                staff → member of their company's #general (owner
--       = admin, others member); not staff (deactivated, partner_agent, personal) → removed from
--       it; also leaves the #general of any company they no longer belong to.
--   chat_general_backfill() → (channels_added, members_added, members_removed)
--       every non-personal company gets #general with all its active staff; non-staff member rows
--       in a #general are dropped. Re-running adds and removes nothing.
--   trg_users_chat_general   DEFERRED constraint trigger on users (insert, or update of
--       is_active / role / tenant_id) → chat_general_sync_user at COMMIT. Deferred so the
--       membership follows the user's final state of the transaction, and so rolled-back test
--       fixtures (team_chat_rls / rpcs / storage build their own #general) never see it.
--       A failure here only warns — an invite or deactivation must never fail because of chat;
--       the backfill repairs any gap.
--
-- A deactivated user also cannot read anything anyway (chat_is_staff checks is_active); removing
-- the #general row keeps member lists and unread counts honest. Reactivation rejoins.
-- No money here, so no books-lock trigger.
-- Test: supabase/tests/team_chat_general.test.sql. Re-runnable.

begin;

create or replace function public.chat_general_ensure(p_tenant_id uuid) returns uuid
  language plpgsql security definer set search_path = ''
as $$
-- R-2296: the company's public #general (created when missing). Personal workspace / unknown → NULL.
declare
  v_id uuid;
begin
  if p_tenant_id is null or not exists (
       select 1 from public.tenants t
        where t.id = p_tenant_id and t.workspace_kind is distinct from 'personal') then
    return null;
  end if;

  select c.id into v_id
    from public.chat_channels c
   where c.tenant_id = p_tenant_id and c.kind = 'channel' and c.slug = 'general';
  if v_id is not null then
    return v_id;
  end if;

  insert into public.chat_channels (tenant_id, kind, name, slug, topic, is_private, created_by)
  values (p_tenant_id, 'channel', 'general', 'general', 'Company-wide chat for the whole team', false,
          (select u.id from public.users u
            where u.tenant_id = p_tenant_id and u.is_active and u.role::text = 'owner'
            order by u.created_at nulls last, u.id
            limit 1))
  on conflict (tenant_id, slug) where kind = 'channel' do nothing
  returning id into v_id;

  if v_id is null then  -- made by a parallel transaction a moment ago
    select c.id into v_id
      from public.chat_channels c
     where c.tenant_id = p_tenant_id and c.kind = 'channel' and c.slug = 'general';
  end if;
  return v_id;
end;
$$;

create or replace function public.chat_general_sync_user(p_user_id uuid) returns void
  language plpgsql security definer set search_path = ''
as $$
-- R-2296: keep one user's #general membership in line with chat_is_staff()'s rule.
declare
  v_u  record;
  v_ch uuid;
begin
  if p_user_id is null then
    return;
  end if;
  select u.id, u.tenant_id, u.is_active, u.role::text as role, t.workspace_kind
    into v_u
    from public.users u
    left join public.tenants t on t.id = u.tenant_id
   where u.id = p_user_id;
  if v_u.id is null then
    return;  -- deleted: chat_members cascades
  end if;

  -- moved to another company: leave every other company's #general
  delete from public.chat_members m
   using public.chat_channels c
   where m.user_id = p_user_id
     and c.id = m.channel_id
     and c.kind = 'channel' and c.slug = 'general'
     and c.tenant_id is distinct from v_u.tenant_id;

  if v_u.tenant_id is not null
     and coalesce(v_u.is_active, false)
     and v_u.role not in ('partner_agent', 'personal')
     and v_u.workspace_kind is distinct from 'personal' then
    v_ch := public.chat_general_ensure(v_u.tenant_id);
    if v_ch is not null then
      insert into public.chat_members (tenant_id, channel_id, user_id, member_role)
      values (v_u.tenant_id, v_ch, p_user_id, case when v_u.role = 'owner' then 'admin' else 'member' end)
      on conflict (channel_id, user_id) do nothing;
    end if;
  else
    delete from public.chat_members m
     using public.chat_channels c
     where m.user_id = p_user_id
       and c.id = m.channel_id
       and c.kind = 'channel' and c.slug = 'general';
  end if;
end;
$$;

create or replace function public.chat_general_backfill()
returns table (channels_added integer, members_added integer, members_removed integer)
  language plpgsql security definer set search_path = ''
as $$
-- R-2296: every non-personal company gets #general with all active staff; non-staff rows go.
declare
  v_t       record;
  v_before  int;
  v_n       int;
begin
  channels_added := 0;
  members_added := 0;
  members_removed := 0;

  for v_t in
    select t.id from public.tenants t
     where t.workspace_kind is distinct from 'personal'
     order by t.id
  loop
    select count(*) into v_before from public.chat_channels c
     where c.tenant_id = v_t.id and c.kind = 'channel' and c.slug = 'general';
    perform public.chat_general_ensure(v_t.id);
    if v_before = 0 then
      channels_added := channels_added + 1;
    end if;
  end loop;

  insert into public.chat_members (tenant_id, channel_id, user_id, member_role)
  select c.tenant_id, c.id, u.id, case when u.role::text = 'owner' then 'admin' else 'member' end
    from public.chat_channels c
    join public.tenants t on t.id = c.tenant_id and t.workspace_kind is distinct from 'personal'
    join public.users u on u.tenant_id = c.tenant_id
   where c.kind = 'channel' and c.slug = 'general'
     and u.is_active
     and u.role::text not in ('partner_agent', 'personal')
  on conflict (channel_id, user_id) do nothing;
  get diagnostics v_n = row_count;
  members_added := v_n;

  delete from public.chat_members m
   using public.chat_channels c
   where c.id = m.channel_id
     and c.kind = 'channel' and c.slug = 'general'
     and not exists (
       select 1 from public.users u
         join public.tenants t on t.id = u.tenant_id
        where u.id = m.user_id
          and u.tenant_id = c.tenant_id
          and u.is_active
          and u.role::text not in ('partner_agent', 'personal')
          and t.workspace_kind is distinct from 'personal');
  get diagnostics v_n = row_count;
  members_removed := v_n;

  return next;
end;
$$;

create or replace function public.tg_users_chat_general() returns trigger
  language plpgsql security definer set search_path = ''
as $$
-- R-2296: deferred — runs at COMMIT with the user's final row. Never blocks the user change.
begin
  begin
    perform public.chat_general_sync_user(new.id);
  exception when others then
    raise warning 'R-2296: team chat #general sync failed for user %: % (%)', new.id, sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

revoke all on function public.chat_general_ensure(uuid), public.chat_general_sync_user(uuid),
  public.chat_general_backfill(), public.tg_users_chat_general() from public, anon, authenticated;
grant execute on function public.chat_general_ensure(uuid), public.chat_general_sync_user(uuid),
  public.chat_general_backfill() to service_role;

drop trigger if exists trg_users_chat_general on public.users;
create constraint trigger trg_users_chat_general
  after insert or update of is_active, role, tenant_id on public.users
  deferrable initially deferred
  for each row execute function public.tg_users_chat_general();

-- backfill every company now (idempotent)
do $$
declare
  r record;
begin
  select * into r from public.chat_general_backfill();
  raise notice 'R-2296 #general backfill: % channel(s) added, % member(s) added, % removed',
    r.channels_added, r.members_added, r.members_removed;
end $$;

commit;
