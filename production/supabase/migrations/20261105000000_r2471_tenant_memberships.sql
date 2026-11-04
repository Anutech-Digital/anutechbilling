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
/* FK lookups for ON DELETE SET NULL when a login / employee row goes. */
create index if not exists tenant_memberships_employee_idx on public.tenant_memberships (employee_id) where employee_id is not null;
create index if not exists tenant_memberships_manager_idx on public.tenant_memberships (manager_id) where manager_id is not null;
create index if not exists tenant_memberships_created_by_idx on public.tenant_memberships (created_by) where created_by is not null;
create index if not exists tenant_memberships_ended_by_idx on public.tenant_memberships (ended_by) where ended_by is not null;

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

/* Insert/update only: a membership row is deleted only by CASCADE (its login or its company
   going — the users row's own audit covers that), and logging during a company delete would
   write an activity_log row for a tenant that is being removed (FK error, merge_stranded). */
drop trigger if exists tenant_memberships_activity on public.tenant_memberships;
create trigger tenant_memberships_activity
  after insert or update on public.tenant_memberships
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
         and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
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
  elsif tg_op = 'UPDATE' and new.is_active and not old.is_active and exists (
          select 1 from public.tenant_memberships m
           where m.user_id = new.id and m.tenant_id = new.tenant_id and m.ended_at is not null) then
    /* Turning a login back on in a company it was REMOVED from would be silently undone by the
       mirror (ended → inactive). Say what to do instead. */
    raise exception 'This person was removed from this company. Invite them again from the Team page to give them access.'
      using errcode = '42501';
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
     R-2471: the role is the one in the membership of the company current_tenant_id() returns
     (the SELECTED company; for a job, its app.tenant_id) — so the role and the tenant always
     come from the same membership. current_tenant_id() already requires that membership active,
     not ended and not expired. For the selected company the users mirror must agree too (role,
     active, end date): if they ever drift, no role (fail closed). */
  select exists (
    select 1 from public.tenant_memberships m
      join public.users u on u.id = m.user_id
    where m.user_id = public.current_user_id()
      and m.tenant_id = public.current_tenant_id()
      and m.is_active and m.ended_at is null
      and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
      and m.role::text = any (p_roles)
      and (u.tenant_id is distinct from m.tenant_id
           or (u.role = m.role and u.is_active
               and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())))
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
  /* R-2471: owner of the current company by its active membership — one definition with
     current_user_has_role('owner'), so it now also needs MFA (R-731) and the end date (R-1896)
     like every other role check. */
  select public.current_user_has_role('owner');
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
     and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
     for share;   -- a concurrent change to this membership waits for the switch (and v.v.)
  if v_m.id is null then
    raise exception 'You are not a member of that company, or your access there has ended. Ask that company''s owner to invite you again.'
      using errcode = '42501';
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

-- ── 7. "Empty workspace" scans: a membership is not business data ─────────────────
-- merge_stranded_user_into_tenant (Team → Claim a colleague) and tenant_holds_business_records
-- (R-2469) count every public table with a tenant_id, minus bookkeeping tables. The new
-- tenant_memberships row every login now has would make every stranded workspace look "full".
-- Bodies copied from their LATEST versions (20261025160239_r1922 / 20261104090100_r2469); the
-- only change is 'tenant_memberships' in the carve-out list. create or replace keeps grants.

create or replace function public.merge_stranded_user_into_tenant(
  p_email text, p_tenant_id uuid, p_role user_role default 'support'::user_role)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_email        text := lower(btrim(p_email));
  v_trusted      boolean;
  v_dest_name    text;
  v_auth_id      uuid;
  v_auth_name    text;
  v_old_tid      uuid;
  v_old_name     text;
  v_old_users    int;
  v_sql          text;
  v_holdings     jsonb;
  v_rows         bigint;
  v_action       text;
  v_deleted      boolean := false;
  v_member_id    uuid;
  v_generic      text;
  v_last_sign_in timestamptz;
begin
  v_generic := format(
    'Cannot claim %s. Only someone with a pending invite or join request to your workspace, who has signed in at least once, can be claimed. Invite them from Team → Invite teammate using this exact address, ask them to sign in once, then claim them.',
    v_email);

  /* R-721: trusted server paths (R-454 rule) act as platform admin. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null and auth.uid() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));

  -- ── 1. The caller must be an ACTIVE owner of the destination workspace ──
  --    R-1615: current_tenant_id() + current_user_has_role() (active AND MFA step done).
  if not v_trusted then
    if public.current_tenant_id() is null then
      raise exception
        'Claiming a colleague needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
        using errcode = '28000';
    end if;
    if p_tenant_id is distinct from public.current_tenant_id()
       or not public.current_user_has_role('owner') then
      raise exception
        'Only the owner of a workspace can claim someone into it. Ask your workspace owner to open Team → Claim a colleague.'
        using errcode = '42501';
    end if;
  end if;

  select t.name into v_dest_name from public.tenants t where t.id = p_tenant_id;
  if v_dest_name is null then
    raise exception 'That workspace does not exist.' using errcode = 'P0002';
  end if;

  -- ── 2. Already in this workspace? Only the role may need correcting. ────
  select u.id into v_member_id
    from public.users u
   where u.tenant_id = p_tenant_id and lower(u.email) = v_email
   limit 1;

  if v_member_id is not null then
    update public.users set role = p_role where id = v_member_id and role <> p_role;
    v_action  := case when found then 'role_updated' else 'already_member' end;
    v_auth_id := v_member_id;
    select coalesce(nullif(btrim(u.full_name), ''), split_part(v_email, '@', 1))
      into v_auth_name from public.users u where u.id = v_member_id;
  else
    select au.id,
           coalesce(
             nullif(btrim(au.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(au.raw_user_meta_data ->> 'name'), ''),
             split_part(au.email, '@', 1)
           ),
           au.last_sign_in_at
      into v_auth_id, v_auth_name, v_last_sign_in
      from auth.users au
     where lower(au.email) = v_email
     limit 1;

    -- ── 3. R-721: they must have asked, or been asked, to join THIS workspace.
    --    A join request is their own act. An invite is the owner's act, so it counts only
    --    once they have signed in AFTER it was sent (their half of the handshake) — an owner
    --    cannot invite someone else's address and pull them in the same minute.
    --    "No account" and "no request" give the SAME words: no existence oracle.
    if v_auth_id is null
       or (not v_trusted and not (
            exists (select 1 from public.join_requests jr
                     where jr.tenant_id = p_tenant_id and jr.status = 'pending_approval'
                       and (jr.auth_user_id = v_auth_id or lower(jr.email) = v_email))
         or exists (select 1 from public.team_invites i
                     where i.tenant_id = p_tenant_id and i.accepted_at is null
                       and lower(i.email) = v_email
                       and v_last_sign_in >= i.created_at))) then
      raise exception '%', v_generic using errcode = '42501';
    end if;

    select u.tenant_id into v_old_tid from public.users u where u.id = v_auth_id;

    if v_old_tid = p_tenant_id then
      -- Row email differs from the login email but the person is here already.
      update public.users set role = p_role where id = v_auth_id and role <> p_role;
      v_action := case when found then 'role_updated' else 'already_member' end;

    -- 3b. Truly stranded: an auth account with no profile anywhere.
    elsif v_old_tid is null then
      insert into public.users (id, tenant_id, email, full_name, initials, role, color)
      values (
        v_auth_id, p_tenant_id, v_email, v_auth_name,
        upper(left(regexp_replace(coalesce(v_auth_name, v_email), '[^A-Za-z]', '', 'g'), 2)),
        p_role, 'indigo'
      );
      v_action := 'attached';

    -- 3c. They are sitting in another (accidental) workspace.
    else
      select t.name, (select count(*) from public.users u2 where u2.tenant_id = t.id)
        into v_old_name, v_old_users
        from public.tenants t where t.id = v_old_tid;

      if v_old_users > 1 then
        raise exception
          'Cannot claim %: they are in another company that has other people in it. That is a separate company, not an accidental workspace — moving them is a platform-admin job.%',
          v_email,
          case when v_trusted then format(' ("%s", %s people)', v_old_name, v_old_users) else '' end
          using errcode = '23505';
      end if;

      -- Count everything that is not bookkeeping. Fail-safe: unlisted table = data.
      select string_agg(
               format('select %L::text as tbl, count(*)::bigint as n from public.%I where tenant_id = %L%s',
                      c.table_name, c.table_name, v_old_tid,
                      /* R-1834: the empty Petty Cash every company is born with is not data. Its
                         bank lines (if any) still count, through bank_transactions. */
                      case when c.table_name = 'bank_accounts'
                           then ' and not (is_default_petty_cash and opening_balance = 0)'
                           /* R-1922: the Customer messages switch every company is born with is a
                              setting, not data. Any other switch row still counts. */
                           when c.table_name = 'automation_jobs'
                           then ' and job <> ''customer_messages'''
                           else '' end),
               ' union all ')
        into v_sql
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema
         and t.table_name   = c.table_name
         and t.table_type   = 'BASE TABLE'
       where c.table_schema = 'public'
         and c.column_name  = 'tenant_id'
         and c.table_name not in (
               'users', 'activity_log', 'team_invites', 'tenant_secrets',
               'document_series', 'customer_number_seq', 'user_google_tokens',
               'tenant_domains', 'join_requests', 'email_log', 'api_keys', 'tenant_memberships'
             );

      execute format(
        'select coalesce(jsonb_object_agg(tbl, n) filter (where n > 0), ''{}''::jsonb),
                coalesce(sum(n), 0) from (%s) s', v_sql)
        into v_holdings, v_rows;

      if v_rows > 0 then
        raise exception
          'Cannot claim %: their current workspace still holds records. Moving them out would leave that data with no one who can sign in and see it. They should move or export it first — this tool only clears empty workspaces.%',
          v_email,
          case when v_trusted then format(' ("%s": %s records, %s)', v_old_name, v_rows, v_holdings::text) else '' end
          using errcode = '23503';
      end if;

      update public.users
         set tenant_id = p_tenant_id,
             role      = p_role,
             email     = v_email
       where id = v_auth_id;

      delete from public.tenants where id = v_old_tid;
      v_deleted := true;
      v_action  := 'moved';
    end if;
  end if;

  -- ── 4. Any open request / invite from this person is now settled ────────
  update public.join_requests
     set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where tenant_id = p_tenant_id
     and lower(email) = v_email
     and status = 'pending_approval';

  update public.team_invites
     set accepted_at = now()
   where tenant_id = p_tenant_id
     and lower(email) = v_email
     and accepted_at is null;

  -- ── 5. Visible in the destination workspace, not just in a server log ───
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (
    p_tenant_id, auth.uid(), v_action, 'user', v_auth_id::text,
    format('Claimed %s into %s as %s%s',
           v_email, coalesce(v_dest_name, 'this workspace'), p_role,
           case when v_deleted then format(' (removed empty workspace "%s")', v_old_name) else '' end)
  );

  return jsonb_build_object(
    'action',             v_action,
    'email',              v_email,
    'full_name',          v_auth_name,
    'auth_user_id',       v_auth_id,
    'role',               p_role,
    'tenant_id',          p_tenant_id,
    'tenant_name',        v_dest_name,
    'old_tenant_name',    v_old_name,
    'old_tenant_deleted', v_deleted
  );
end;
$function$;

create or replace function public.tenant_holds_business_records(p_tenant uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tbl text;
  v_hit boolean;
begin
  /* R-2469: same tables and carve-outs as merge_stranded_user_into_tenant (R-721/R-1834/
     R-1922) — but a yes/no, so one EXISTS per table and stop at the first hit (no full counts). */
  for v_tbl in
    select c.table_name
      from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name   = c.table_name
     and t.table_type   = 'BASE TABLE'
   where c.table_schema = 'public'
     and c.column_name  = 'tenant_id'
     and c.table_name not in (
           'users', 'activity_log', 'team_invites', 'tenant_secrets',
           'document_series', 'customer_number_seq', 'user_google_tokens',
           'tenant_domains', 'join_requests', 'email_log', 'api_keys', 'tenant_memberships'
         )
  loop
    execute format('select exists (select 1 from public.%I where tenant_id = $1%s)',
                   v_tbl,
                   case when v_tbl = 'bank_accounts'
                        then ' and not (is_default_petty_cash and opening_balance = 0)'
                        when v_tbl = 'automation_jobs'
                        then ' and job <> ''customer_messages'''
                        else '' end)
      into v_hit using p_tenant;
    if v_hit then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- ── 8. Restoring a company backup never restores memberships ───────────────────────
-- restore_tenant_backup puts every tenant_id table back from the snapshot in replica mode (no
-- triggers, no FKs) — except users, because who may sign in is not part of the books. The same
-- holds for tenant_memberships: restoring them would give a REMOVED member their access back,
-- drop members added since the snapshot and bypass the users mirror. Body copied from its
-- LATEST version (20261018173040_r1556); the only change is 'tenant_memberships' in the list.

create or replace function public.restore_tenant_backup(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_payload jsonb; r record; col_list text; has_identity bool; n int := 0;
begin
  -- R-1556: was role = 'owner' from users by auth.uid() — no is_active, no MFA step.
  if v_tenant is null then
    raise exception 'Restoring a backup needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only the owner can restore'
      using errcode = 'insufficient_privilege';
  end if;
  select s.payload into v_payload from backup.snapshots s where s.id = p_id and s.tenant_id = v_tenant;
  if v_payload is null then raise exception 'Restore point not found'; end if;

  perform backup._take(v_tenant, 'Before restore ' || to_char(now(), 'DD Mon HH24:MI'), 'auto');

  set local session_replication_role = replica;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id' and c.table_name not in ('tenant_secrets','users','tenant_memberships')
    group by c.table_name order by c.table_name
  loop
    if not (v_payload ? r.table_name) then continue; end if;
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position), bool_or(is_identity = 'YES')
      into col_list, has_identity
    from information_schema.columns
    where table_schema='public' and table_name = r.table_name and is_generated <> 'ALWAYS';
    execute format('delete from public.%I where tenant_id = $1', r.table_name) using v_tenant;
    execute format(
      'insert into public.%I (%s) %s select %s from jsonb_populate_recordset(null::public.%I, $1)',
      r.table_name, col_list, case when has_identity then 'overriding system value' else '' end, col_list, r.table_name
    ) using (v_payload -> r.table_name);
    n := n + 1;
  end loop;

  set local session_replication_role = origin;
  return jsonb_build_object('restored_tables', n, 'restored_at', now());
end $function$;


commit;
