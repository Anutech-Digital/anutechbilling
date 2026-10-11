-- deploy-key: r712users
-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.guard_privileged_user_columns()') and prosrc like '%R-712%') and exists(select 1 from pg_policy where polrelid = to_regclass('public.users') and polname = 'users_self_update' and polwithcheck is not null)
-- 20261011041200_r712_users_self_update.sql
--
-- R-712 (P0, security audit 10 Oct) + the users.email part of R-729.
--
-- ══ THE HOLE ═════════════════════════════════════════════════════════════════════
--   users_self_update was USING (id = auth.uid()) with no WITH CHECK, and the column guard
--   guard_privileged_user_columns (last defined in 20261002120000_lead_auto_assign.sql, same
--   body re-emitted by prisma 20261005120000_tenant_context) only asked "is the caller an owner
--   ANYWHERE?". Every signup owns its own company, so:
--     PATCH /users?id=eq.<me> {tenant_id:<victim>}  → owner inside the victim company.
--   Also: anyone could set their own employee_id to any employee (attendance in someone else's
--   name), a deactivated owner could set is_active = true, and any member could change any
--   teammate's email (users_tenant_update) or their own — the login callback re-links a users
--   row BY EMAIL, so an invitee's email copied onto a row captures that person's first login,
--   and a new email written onto the owner's row hands the owner row to whoever logs in with it.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   Guard (signed-in callers only; service_role / no auth.uid() still pass through):
--   * tenant_id: a signed-in caller can never move their OWN row. The only signed-in move left is
--     an active owner of the destination pulling someone else in — merge_stranded_user_into_tenant
--     (Team -> Claim a colleague, SECURITY DEFINER); RLS keeps plain PATCHes off other
--     workspaces' rows, and the new WITH CHECK stops a self-row PATCH too.
--   * "owner" now means: role owner AND is_active AND in the row's tenant (after the update —
--     the same tenant as before, except in that claim move).
--   * email and employee_id join the owner-only columns.
--   * One self-service path stays: a non-owner linking THEIR OWN login to an employee record,
--     with exactly the rules of set_my_employee (same workspace, not linked to someone else,
--     employee email empty or equal to the login email) — so the /my-attendance link keeps
--     working and a direct PATCH gives no more than that RPC does.
--   * For everyone (owners too): an employee_id must be in the row's workspace and not linked to
--     another login; an email may not be one another login already has, nor a pending invite of
--     another workspace.
--   Policy: users_self_update gets WITH CHECK (id = auth.uid() and tenant_id = current_tenant_id()).
--   Names, reminder prefs and every other column stay self-editable.
--
-- Staging's apply() rewrites auth.uid()/auth.role() for the Prisma path (R-161), so write them plainly.
-- Idempotent: create or replace + alter policy.

begin;

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
     and new.employee_id    is not distinct from old.employee_id
     and new.email          is not distinct from old.email then
    return new;
  end if;

  /* Server paths (OAuth callback re-link, claim-merge, reset-data, scripts) carry no user. */
  if v_uid is null or coalesce(auth.role(), '') = 'service_role' then
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
     and new.email          is not distinct from old.email then
    select e.email into v_emp_email from public.employees e where e.id = new.employee_id;
    if v_emp_email is not null and lower(v_emp_email) <> lower(coalesce(old.email, '')) then
      raise exception 'Your login email does not match this employee record. Ask an owner to link you.' using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'Only an owner can change a teammate''s role, reporting manager, deals access, new-lead assignment, active status, email or employee link. Ask an owner to do it on the Team page (/team).'
    using errcode = '42501';
end;
$$;

comment on function public.guard_privileged_user_columns() is
  'R-712: signed-in callers can never change users.tenant_id; role / manager_id / can_view_deals / gets_new_leads / is_active / email / employee_id need an ACTIVE owner of the SAME tenant (one exception: linking your own login to your own employee record, set_my_employee rules). employee_id must be in-tenant and unlinked; email may not collide with another login or another tenant''s pending invite. No auth.uid() / service_role passes through.';

alter policy "users_self_update" on public.users
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()) and tenant_id = (select public.current_tenant_id()));

commit;
