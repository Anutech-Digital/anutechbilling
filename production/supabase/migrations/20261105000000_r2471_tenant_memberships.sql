-- deploy-peek: to_regclass('public.tenant_memberships') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.switch_company(uuid)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.current_tenant_id()') and prosrc like '%R-2471%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.current_user_has_role(text[])') and prosrc like '%R-2471%')
-- deploy-key: r2471memberships
-- 20261105000000_r2471_tenant_memberships.sql
--
-- R-2471 slice 1 (4 Nov 2026) — one login in many companies. Spec: docs/specs/memberships.md.
-- NEEDS AN INDEPENDENT REVIEW before any staging train: current_tenant_id() is under every policy.
--
--   1. public.tenant_memberships (user, company, role, is_active, access_ends_on, the per-company
--      columns that sit on users today, created/ended + audit). RLS: a login reads its own
--      memberships and its selected company's; no writes from request roles.
--   2. The SELECTED company stays users.tenant_id — every policy, definer guard and app read keeps
--      working. The membership is the authority: current_tenant_id(), current_user_has_role()
--      and current_user_is_owner() now also need the ACTIVE, not-ended, not-expired membership
--      of the selected company (fail closed: none → NULL / false). Old users checks stay too.
--   3. Sync triggers keep users' per-company columns a mirror of the selected membership (both
--      ways); a server path that moves a login to a company it is not a member of ends the old
--      membership ('moved') — today's one-company behaviour for every existing path.
--   4. switch_company(tenant) — the server-side selection (no UI yet: slice 2 R-2476).
--      guard_privileged_user_columns gets one early branch for it.
--   5. Backfill: one membership per users row.
--
-- Bodies redefined from their LATEST versions:
--   current_tenant_id()             20261025141647_r1896_employee_exit.sql
--   current_user_has_role(text[])   20261025141647_r1896_employee_exit.sql
--   current_user_is_owner()         20260901100000_users_delete_owner_only.sql
--   guard_privileged_user_columns   20261025141647_r1896_employee_exit.sql
-- Uses public.current_user_id() (R-1901), so staging's apply() auth.uid() rewrite (R-161) has
-- nothing to change. Idempotent.

begin;

-- ── 1. The table ────────────────────────────────────────────────────────────────────
create table if not exists public.tenant_memberships (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  role           public.user_role not null,
  is_active      boolean not null default true,
  access_ends_on date,
  employee_id    uuid references public.employees(id) on delete set null,
  manager_id     uuid references public.users(id) on delete set null,
  can_view_deals boolean not null default false,
  gets_new_leads boolean not null default false,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  ended_at       timestamptz,
  ended_by       uuid references public.users(id) on delete set null,
  end_reason     text,
  constraint tenant_memberships_user_tenant_key unique (user_id, tenant_id),
  constraint tenant_memberships_end_reason_check check (
    end_reason is null or end_reason in ('removed', 'moved', 'left')),
  constraint tenant_memberships_end_pair_check check ((ended_at is null) = (end_reason is null)),
  constraint tenant_memberships_manager_not_self check (manager_id is null or manager_id <> user_id)
);

create index if not exists tenant_memberships_tenant_idx on public.tenant_memberships (tenant_id);

comment on table public.tenant_memberships is
  'R-2471: which companies a login may work in, and as what. users.tenant_id is the SELECTED one; '
  'current_tenant_id() needs that membership active, not ended and not past access_ends_on.';

alter table public.tenant_memberships enable row level security;
revoke all on public.tenant_memberships from public, anon, authenticated;
grant select on public.tenant_memberships to authenticated;
grant all on public.tenant_memberships to service_role;

drop policy if exists tenant_memberships_self_read on public.tenant_memberships;
create policy tenant_memberships_self_read on public.tenant_memberships
  for select to authenticated using (user_id = (select public.current_user_id()));

drop policy if exists tenant_memberships_tenant_read on public.tenant_memberships;
create policy tenant_memberships_tenant_read on public.tenant_memberships
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));

/* R-450: Cloud SQL has no BYPASSRLS — the server (service_role) client needs its own policy. */
drop policy if exists tenant_memberships_service_role on public.tenant_memberships;
create policy tenant_memberships_service_role on public.tenant_memberships
  for all to service_role using (true) with check (true);

drop trigger if exists tenant_memberships_activity on public.tenant_memberships;
create trigger tenant_memberships_activity
  after insert or update or delete on public.tenant_memberships
  for each row execute function public.log_row_change();

-- ── 2. Backfill (before the helpers start requiring it) ────────────────────────────
insert into public.tenant_memberships
  (user_id, tenant_id, role, is_active, access_ends_on, employee_id, manager_id,
   can_view_deals, gets_new_leads, created_at)
select u.id, u.tenant_id, u.role, u.is_active, u.access_ends_on, u.employee_id, u.manager_id,
       u.can_view_deals, u.gets_new_leads, u.created_at
  from public.users u
on conflict (user_id, tenant_id) do nothing;

-- ── 3. Sync triggers ────────────────────────────────────────────────────────────────
create or replace function public.tg_r2471_users_to_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
/* R-2471: users' per-company columns are the mirror of the SELECTED company's membership. */
declare
  v_switch boolean := false;
begin
  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    /* A switch lands on an active membership with exactly these values (switch_company); any
       other change of company is a server move (claim-merge, OAuth re-link, scripts). */
    select exists (
      select 1 from public.tenant_memberships m
       where m.user_id = new.id and m.tenant_id = new.tenant_id
         and m.is_active and m.ended_at is null
         and new.is_active
         and m.role = new.role
         and m.access_ends_on is not distinct from new.access_ends_on
         and m.employee_id    is not distinct from new.employee_id
         and m.manager_id     is not distinct from new.manager_id
         and m.can_view_deals = new.can_view_deals
         and m.gets_new_leads = new.gets_new_leads) into v_switch;
    if v_switch then
      return null;
    end if;
    update public.tenant_memberships
       set ended_at = now(), end_reason = 'moved', ended_by = public.current_user_id(),
           updated_at = now()
     where user_id = old.id and tenant_id = old.tenant_id and ended_at is null;
  end if;

  insert into public.tenant_memberships as m
    (user_id, tenant_id, role, is_active, access_ends_on, employee_id, manager_id,
     can_view_deals, gets_new_leads, created_by)
  values
    (new.id, new.tenant_id, new.role, new.is_active, new.access_ends_on, new.employee_id,
     new.manager_id, new.can_view_deals, new.gets_new_leads, public.current_user_id())
  on conflict (user_id, tenant_id) do update
     set role = excluded.role, is_active = excluded.is_active,
         access_ends_on = excluded.access_ends_on, employee_id = excluded.employee_id,
         manager_id = excluded.manager_id, can_view_deals = excluded.can_view_deals,
         gets_new_leads = excluded.gets_new_leads,
         /* a move INTO a company re-opens an ended membership; a same-company edit never does */
         ended_at   = case when tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id
                           then null else m.ended_at end,
         end_reason = case when tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id
                           then null else m.end_reason end,
         ended_by   = case when tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id
                           then null else m.ended_by end,
         updated_at = now()
   where m.role is distinct from excluded.role
      or m.is_active is distinct from excluded.is_active
      or m.access_ends_on is distinct from excluded.access_ends_on
      or m.employee_id is distinct from excluded.employee_id
      or m.manager_id is distinct from excluded.manager_id
      or m.can_view_deals is distinct from excluded.can_view_deals
      or m.gets_new_leads is distinct from excluded.gets_new_leads
      or (tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id and m.ended_at is not null);
  return null;
end;
$$;

drop trigger if exists users_r2471_membership_sync on public.users;
create trigger users_r2471_membership_sync
  after insert or update of tenant_id, role, is_active, access_ends_on, employee_id, manager_id,
                            can_view_deals, gets_new_leads
  on public.users
  for each row execute function public.tg_r2471_users_to_membership();

create or replace function public.tg_r2471_membership_to_users()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
/* R-2471: a change to the SELECTED company's membership shows on the users mirror (slice 3's
   Remove / role change; the R-722 middleware sign-out reads users.is_active). */
begin
  update public.users u
     set role = new.role,
         is_active = new.is_active and new.ended_at is null,
         access_ends_on = new.access_ends_on,
         employee_id = new.employee_id,
         manager_id = new.manager_id,
         can_view_deals = new.can_view_deals,
         gets_new_leads = new.gets_new_leads
   where u.id = new.user_id and u.tenant_id = new.tenant_id
     and (u.role is distinct from new.role
          or u.is_active is distinct from (new.is_active and new.ended_at is null)
          or u.access_ends_on is distinct from new.access_ends_on
          or u.employee_id is distinct from new.employee_id
          or u.manager_id is distinct from new.manager_id
          or u.can_view_deals is distinct from new.can_view_deals
          or u.gets_new_leads is distinct from new.gets_new_leads);
  return null;
end;
$$;

drop trigger if exists tenant_memberships_r2471_users_sync on public.tenant_memberships;
create trigger tenant_memberships_r2471_users_sync
  after insert or update on public.tenant_memberships
  for each row execute function public.tg_r2471_membership_to_users();

revoke all on function public.tg_r2471_users_to_membership() from public, anon, authenticated;
revoke all on function public.tg_r2471_membership_to_users() from public, anon, authenticated;

-- ── 4. The helpers read the selected ACTIVE membership ─────────────────────────────
create or replace function public.current_tenant_id() returns uuid
  language sql stable security definer set search_path = ''
as $$
  /* R-722: an inactive user (users.is_active = false) has no tenant — every policy built on
     this gives them nothing.
     R-731: an MFA-enrolled user whose session is not aal2 has no tenant either
     (public.session_mfa_ok()).
     R-1896: nor does a login past its access_ends_on (an employee after their last working
     day) — checked against the IST date on every call, so no job has to switch it off.
     R-2471: the tenant is the SELECTED company (users.tenant_id) and only while this login's
     membership there is active, not ended and not past its access_ends_on. No membership →
     NULL. A job for a user needs that user's active membership in app.tenant_id. */
  select case
    when session_user = 'app_runtime' then (
      select u.tenant_id from public.users u
        join public.tenant_memberships m on m.user_id = u.id and m.tenant_id = u.tenant_id
       where u.id = nullif(current_setting('app.user_id', true), '')::uuid
         and u.is_active
         and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
         and m.is_active and m.ended_at is null
         and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
         and public.session_mfa_ok()
         and (nullif(current_setting('app.tenant_id', true), '') is null
              or u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
       limit 1)
    when session_user = 'app_jobs' then
      case when nullif(current_setting('app.user_id', true), '') is null
        then nullif(current_setting('app.tenant_id', true), '')::uuid
        else (select m.tenant_id from public.tenant_memberships m
               where m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
                 and m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
                 and m.is_active and m.ended_at is null
                 and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
               limit 1)
      end
    when session_user in ('app_service', 'app_anon') then null
    else (select u.tenant_id from public.users u
            join public.tenant_memberships m on m.user_id = u.id and m.tenant_id = u.tenant_id
           where u.id = public.current_user_id() and u.is_active
             and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
             and m.is_active and m.ended_at is null
             and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
             and public.session_mfa_ok() limit 1)
  end;
$$;

comment on function public.current_tenant_id() is
  'Selected company of the signed-in user — NULL when there is none, the user is deactivated (R-722), MFA is enrolled and this session is not aal2 (R-731), the login is past its access_ends_on (R-1896), or its membership in the selected company is off / ended / expired (R-2471).';

create or replace function public.current_user_has_role(variadic p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  /* `is_active` matters as much as the role: a deactivated owner is how an ex-employee
     keeps their access. current_user_is_owner() already checks it; this matches.
     R-1556: and the session must have passed two-step sign-in if the user enrolled
     (session_mfa_ok(), R-731) — a password-only session holds no role.
     R-1896: a login past its access_ends_on holds no role either.
     R-2471: the role is the one in the SELECTED company's active membership. */
  select exists (
    select 1 from public.users u
      join public.tenant_memberships m on m.user_id = u.id and m.tenant_id = u.tenant_id
    where u.id = public.current_user_id()
      and u.is_active
      and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
      and m.is_active and m.ended_at is null
      and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
      and m.role::text = any (p_roles)
  ) and public.session_mfa_ok();
$function$;

comment on function public.current_user_has_role(text[]) is
  'True when the signed-in user is ACTIVE (and not past access_ends_on, R-1896), holds one of the given roles in the SELECTED company''s active membership (R-2471), and (if MFA-enrolled) '
  'this session is aal2. The single definition of "who may touch this". S41, R-1556.';

create or replace function public.current_user_is_owner()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  /* R-2471: owner of the SELECTED company, by its active membership (and the users mirror). */
  select exists (
    select 1 from public.users u
      join public.tenant_memberships m on m.user_id = u.id and m.tenant_id = u.tenant_id
    where u.id = public.current_user_id() and u.role = 'owner' and u.is_active
      and m.role = 'owner' and m.is_active and m.ended_at is null
      and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
  );
$$;

revoke all on function public.current_user_is_owner() from public;
grant execute on function public.current_user_is_owner() to authenticated;

-- ── 5. guard_privileged_user_columns: one early branch for a switch ────────────────
create or replace function public.guard_privileged_user_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_is_owner  boolean;
  v_emp_email text;
begin
  /* R-712: nothing guarded changed → the common case (names, reminder prefs) pays nothing. */
  if new.role           is not distinct from old.role
     and new.manager_id     is not distinct from old.manager_id
     and new.can_view_deals is not distinct from old.can_view_deals
     and new.gets_new_leads is not distinct from old.gets_new_leads
     and new.tenant_id      is not distinct from old.tenant_id
     and new.is_active      is not distinct from old.is_active
     and new.access_ends_on is not distinct from old.access_ends_on
     and new.employee_id    is not distinct from old.employee_id
     and new.email          is not distinct from old.email then
    return new;
  end if;

  /* Server paths (OAuth callback re-link, claim-merge, reset-data, scripts) carry no user. */
  if v_uid is null or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  /* R-2471: switching MY OWN selected company (switch_company). Allowed only onto an ACTIVE,
     not-ended, not-expired membership of mine, with exactly that membership's values — so a
     switch can never invent a company or a role. */
  if old.id = v_uid
     and new.tenant_id is distinct from old.tenant_id
     and new.email is not distinct from old.email
     and new.is_active
     and exists (
       select 1 from public.tenant_memberships m
        where m.user_id = v_uid and m.tenant_id = new.tenant_id
          and m.is_active and m.ended_at is null
          and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
          and m.role = new.role
          and m.access_ends_on is not distinct from new.access_ends_on
          and m.employee_id    is not distinct from new.employee_id
          and m.manager_id     is not distinct from new.manager_id
          and m.can_view_deals = new.can_view_deals
          and m.gets_new_leads = new.gets_new_leads) then
    return new;
  end if;

  /* Moving a login between workspaces: never your own row. The one legitimate signed-in path
     is merge_stranded_user_into_tenant (Team -> Claim a colleague, SECURITY DEFINER, its own
     empty-workspace checks): an ACTIVE owner of the DESTINATION pulling someone else in. RLS
     hides other workspaces' rows from a plain PATCH, so only definer code reaches this branch. */
  if new.tenant_id is distinct from old.tenant_id then
    if old.id = v_uid or not exists (
         select 1 from public.users u
          where u.id = v_uid and u.role = 'owner' and u.is_active and u.tenant_id = new.tenant_id) then
      raise exception 'A login cannot be moved to another workspace from the app.'
        using errcode = '42501';
    end if;
  end if;

  if new.employee_id is distinct from old.employee_id and new.employee_id is not null then
    if not exists (select 1 from public.employees e
                    where e.id = new.employee_id and e.tenant_id = new.tenant_id) then
      raise exception 'Employee not in your workspace' using errcode = '42501';
    end if;
    if exists (select 1 from public.users u
                where u.employee_id = new.employee_id and u.id <> old.id) then
      raise exception 'This employee record is already linked to another login.' using errcode = '42501';
    end if;
  end if;

  if new.email is distinct from old.email then
    if new.email is null
       or exists (select 1 from public.users u
                   where lower(u.email) = lower(new.email) and u.id <> old.id)
       or exists (select 1 from public.team_invites i
                   where lower(i.email) = lower(new.email) and i.accepted_at is null
                     and i.tenant_id <> new.tenant_id) then
      raise exception 'This email already belongs to another login or a pending invite.' using errcode = '42501';
    end if;
  end if;

  select exists (
    select 1 from public.users u
     where u.id = v_uid and u.role = 'owner' and u.is_active and u.tenant_id = new.tenant_id
  ) into v_is_owner;

  if v_is_owner then
    return new;
  end if;

  /* The one self-service change: link MY login to MY employee record (set_my_employee rules). */
  if old.id = v_uid
     and new.employee_id is distinct from old.employee_id and new.employee_id is not null
     and new.role           is not distinct from old.role
     and new.manager_id     is not distinct from old.manager_id
     and new.can_view_deals is not distinct from old.can_view_deals
     and new.gets_new_leads is not distinct from old.gets_new_leads
     and new.is_active      is not distinct from old.is_active
     and new.access_ends_on is not distinct from old.access_ends_on
     and new.email          is not distinct from old.email then
    select e.email into v_emp_email from public.employees e where e.id = new.employee_id;
    if v_emp_email is not null and lower(v_emp_email) <> lower(coalesce(old.email, '')) then
      raise exception 'Your login email does not match this employee record. Ask an owner to link you.' using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'Only an owner can change a teammate''s role, reporting manager, deals access, new-lead assignment, active status, login end date, email or employee link. Ask an owner to do it on the Team page (/team).'
    using errcode = '42501';
end;
$$;

comment on function public.guard_privileged_user_columns() is
  'R-712: signed-in callers can never change users.tenant_id (one exception, R-2471: switching your OWN selected company onto an active membership with exactly its values); role / manager_id / can_view_deals / gets_new_leads / is_active / access_ends_on (R-1896) / email / employee_id need an ACTIVE owner of the SAME tenant (one exception: linking your own login to your own employee record, set_my_employee rules). employee_id must be in-tenant and unlinked; email may not collide with another login or another tenant''s pending invite. No auth.uid() / service_role passes through.';

-- ── 6. switch_company ───────────────────────────────────────────────────────────────
create or replace function public.switch_company(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
/* R-2471: select which company this login works in. Only onto an ACTIVE membership of the
   caller (not ended, not past access_ends_on), only after MFA when enrolled. Every column the
   membership owns is copied onto users in the same UPDATE, so role / active / employee link
   always match the selected company. */
declare
  v_uid uuid := public.current_user_id();
  v_m   public.tenant_memberships;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not public.session_mfa_ok() then
    raise exception 'Finish two-step sign-in before switching company.' using errcode = '42501';
  end if;
  select * into v_m from public.tenant_memberships m
   where m.user_id = v_uid and m.tenant_id = p_tenant_id
     and m.is_active and m.ended_at is null
     and (m.access_ends_on is null or m.access_ends_on >= public.ist_today());
  if v_m.id is null then
    raise exception 'You are not a member of that company.' using errcode = '42501';
  end if;
  update public.users
     set tenant_id = v_m.tenant_id, role = v_m.role, is_active = true,
         access_ends_on = v_m.access_ends_on, employee_id = v_m.employee_id,
         manager_id = v_m.manager_id, can_view_deals = v_m.can_view_deals,
         gets_new_leads = v_m.gets_new_leads
   where id = v_uid;
  return v_m.tenant_id;
end;
$$;

revoke all on function public.switch_company(uuid) from public, anon;
grant execute on function public.switch_company(uuid) to authenticated, service_role;

commit;
