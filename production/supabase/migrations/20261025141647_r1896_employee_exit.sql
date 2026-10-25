-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.start_employee_exit(uuid,date,text,date,text)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.current_tenant_id()') and prosrc like '%R-1896%') and exists(select 1 from pg_trigger where tgname = 'trg_salary_after_exit')
-- deploy-key: r1896employeeexit
-- 20261025141647_r1896_employee_exit.sql
--
-- R-1896 slice 1 (25 Oct 2026) — "Start exit" for an employee who leaves.
--
-- Before: an employee had only is_active. Unticking it did not touch their login (users), so
-- an ex-employee kept full access until someone remembered /team on the right day; payroll
-- either kept them for ever or dropped them before their last salary was paid.
--
--   1. employees: exit_date (LAST WORKING DAY), exit_reason, resignation_date, exit_note,
--      exit_started_at. One fact, one place: the last working day lives on the employee.
--   2. users.access_ends_on — the linked login works through this IST day and is off from the
--      next one. NO CRON: current_tenant_id() and current_user_has_role() compare it with
--      public.ist_today() on every call, so every RLS policy, SECURITY DEFINER guard and the
--      vault (vault_passwords / personal vault policies are built on current_tenant_id()) stop
--      on the right day by themselves. The middleware reads the same column to end the session.
--      Owner-only, like is_active (guard_privileged_user_columns below).
--   3. start_employee_exit / cancel_employee_exit — owner only, one transaction each: the
--      employee's exit fields + their login's access_ends_on together (§17b).
--   4. trg_salary_after_exit — no payslip for a month after the exit month (pay_salary and any
--      other insert path), so payroll cannot run for someone who has left.
--
-- Bodies redefined from their LATEST versions:
--   current_tenant_id()            20261016103100_r731_mfa_tenant.sql
--   current_user_has_role(text[])  20261018173040_r1556_backup_mfa_tenant.sql
--   guard_privileged_user_columns  20261011041200_r712_users_self_update.sql
-- Idempotent.

begin;

-- ── 1. Exit facts on the employee ───────────────────────────────────────────────────
alter table public.employees add column if not exists exit_date date;
alter table public.employees add column if not exists exit_reason text;
alter table public.employees add column if not exists resignation_date date;
alter table public.employees add column if not exists exit_note text;
alter table public.employees add column if not exists exit_started_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_exit_reason_check') then
    alter table public.employees add constraint employees_exit_reason_check check (
      exit_reason is null or exit_reason in
        ('resigned', 'terminated', 'retired', 'absconding', 'death', 'contract_ended', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employees_exit_pair_check') then
    alter table public.employees add constraint employees_exit_pair_check check (
      (exit_date is null) = (exit_reason is null));
  end if;
end $$;

comment on column public.employees.exit_date is
  'R-1896: last working day. Paid up to this day; no payslip after this month; the linked login ends after it.';
comment on column public.employees.exit_reason is
  'R-1896: resigned / terminated / retired / absconding / death / contract_ended / other.';

-- ── 2. Login end date ───────────────────────────────────────────────────────────────
alter table public.users add column if not exists access_ends_on date;
comment on column public.users.access_ends_on is
  'R-1896: this login works through this IST day and is off from the next (current_tenant_id, middleware). Owner-only.';

create or replace function public.current_tenant_id() returns uuid
  language sql stable security definer set search_path = ''
as $$
  /* R-722: an inactive user (users.is_active = false) has no tenant — every policy built on
     this gives them nothing.
     R-731: an MFA-enrolled user whose session is not aal2 has no tenant either
     (public.session_mfa_ok()).
     R-1896: nor does a login past its access_ends_on (an employee after their last working
     day) — checked against the IST date on every call, so no job has to switch it off. */
  select case
    when session_user = 'app_runtime' then (
      select u.tenant_id from public.users u
       where u.id = nullif(current_setting('app.user_id', true), '')::uuid
         and u.is_active
         and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
         and public.session_mfa_ok()
         and (nullif(current_setting('app.tenant_id', true), '') is null
              or u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
       limit 1)
    when session_user = 'app_jobs' then
      case when nullif(current_setting('app.user_id', true), '') is null
        then nullif(current_setting('app.tenant_id', true), '')::uuid
        else (select u.tenant_id from public.users u
               where u.id = nullif(current_setting('app.user_id', true), '')::uuid
                 and u.is_active
                 and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
                 and u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
               limit 1)
      end
    when session_user in ('app_service', 'app_anon') then null
    else (select u.tenant_id from public.users u
           where u.id = auth.uid() and u.is_active
             and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
             and public.session_mfa_ok() limit 1)
  end;
$$;

comment on function public.current_tenant_id() is
  'Tenant of the signed-in user — NULL when there is none, the user is deactivated (R-722), MFA is enrolled and this session is not aal2 (R-731), or the login is past its access_ends_on (R-1896).';

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
     R-1896: a login past its access_ends_on holds no role either. */
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.is_active
      and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
      and u.role::text = any (p_roles)
  ) and public.session_mfa_ok();
$function$;

comment on function public.current_user_has_role(text[]) is
  'True when the signed-in user is ACTIVE (and not past access_ends_on, R-1896), holds one of the given roles, and (if MFA-enrolled) '
  'this session is aal2. The single definition of "who may touch this". S41, R-1556.';

-- access_ends_on is owner-only, exactly like is_active (R-712 body + one column).
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
  'R-712: signed-in callers can never change users.tenant_id; role / manager_id / can_view_deals / gets_new_leads / is_active / access_ends_on (R-1896) / email / employee_id need an ACTIVE owner of the SAME tenant (one exception: linking your own login to your own employee record, set_my_employee rules). employee_id must be in-tenant and unlinked; email may not collide with another login or another tenant''s pending invite. No auth.uid() / service_role passes through.';

-- ── 3. Start / cancel an exit (owner only, one transaction) ─────────────────────────
create or replace function public.start_employee_exit(
  p_employee_id uuid,
  p_last_day date,
  p_reason text,
  p_resignation_date date default null,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_emp    public.employees;
  v_login  record;
  v_late   text;
  v_n      int := 0;
begin
  /* R-1896 */
  if v_tenant is null then raise exception 'No tenant context' using errcode = '42501'; end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only an owner can start an employee''s exit (it ends their login).' using errcode = '42501';
  end if;
  if p_last_day is null then raise exception 'Pick the last working day.'; end if;
  if p_reason is null or p_reason not in ('resigned', 'terminated', 'retired', 'absconding', 'death', 'contract_ended', 'other') then
    raise exception 'Pick a reason for leaving.';
  end if;

  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Employee not found'; end if;
  if v_emp.joining_date is not null and p_last_day < v_emp.joining_date then
    raise exception 'The last working day (%) is before % joined (%).', p_last_day, v_emp.name, v_emp.joining_date;
  end if;
  if p_resignation_date is not null and p_resignation_date > p_last_day then
    raise exception 'The resignation date cannot be after the last working day.';
  end if;

  select s.period into v_late from public.salary_payments s
   where s.employee_id = p_employee_id and s.tenant_id = v_tenant
     and s.period > to_char(p_last_day, 'YYYY-MM')
   order by s.period limit 1;
  if v_late is not null then
    raise exception '%''s salary for % is already run — undo it first, then start the exit.', v_emp.name, v_late;
  end if;

  for v_login in select u.id, u.role from public.users u
                  where u.employee_id = p_employee_id and u.tenant_id = v_tenant loop
    if v_login.id = auth.uid() then
      raise exception 'This is your own login — you cannot end it from here.' using errcode = '42501';
    end if;
    if v_login.role::text = 'owner' then
      raise exception '%''s login is an owner. Make someone else owner on Team first.', v_emp.name using errcode = '42501';
    end if;
  end loop;

  update public.employees
     set exit_date = p_last_day,
         exit_reason = p_reason,
         resignation_date = p_resignation_date,
         exit_note = nullif(trim(coalesce(p_note, '')), ''),
         exit_started_at = now(),
         is_active = case when p_last_day < public.ist_today() then false else is_active end,
         updated_at = now()
   where id = p_employee_id;

  update public.users set access_ends_on = p_last_day
   where employee_id = p_employee_id and tenant_id = v_tenant;
  get diagnostics v_n = row_count;

  return jsonb_build_object('employee_id', p_employee_id, 'exit_date', p_last_day, 'logins_ending', v_n);
end;
$$;

comment on function public.start_employee_exit(uuid, date, text, date, text) is
  'R-1896: owner starts an exit — last working day + reason on the employee, the linked login ends after that IST day. Atomic.';

create or replace function public.cancel_employee_exit(p_employee_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_emp    public.employees;
begin
  /* R-1896 */
  if v_tenant is null then raise exception 'No tenant context' using errcode = '42501'; end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only an owner can cancel an exit.' using errcode = '42501';
  end if;
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Employee not found'; end if;
  if v_emp.exit_date is null then raise exception '% has no exit to cancel.', v_emp.name; end if;

  update public.users set access_ends_on = null
   where employee_id = p_employee_id and tenant_id = v_tenant
     and access_ends_on = v_emp.exit_date;

  update public.employees
     set exit_date = null, exit_reason = null, resignation_date = null, exit_note = null,
         exit_started_at = null, is_active = true, updated_at = now()
   where id = p_employee_id;
end;
$$;

comment on function public.cancel_employee_exit(uuid) is
  'R-1896: owner undoes an exit (mistake / stays on) — clears the exit and the login end date it set.';

revoke all on function public.start_employee_exit(uuid, date, text, date, text) from public, anon;
grant execute on function public.start_employee_exit(uuid, date, text, date, text) to authenticated, service_role;
revoke all on function public.cancel_employee_exit(uuid) from public, anon;
grant execute on function public.cancel_employee_exit(uuid) to authenticated, service_role;

-- ── 4. No payslip after the exit month ──────────────────────────────────────────────
create or replace function public.tg_salary_after_exit() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exit date;
  v_name text;
begin
  /* R-1896 */
  select e.exit_date, e.name into v_exit, v_name from public.employees e where e.id = new.employee_id;
  if v_exit is not null and new.period > to_char(v_exit, 'YYYY-MM') then
    raise exception '% left on % — no salary after %.', v_name, to_char(v_exit, 'DD Mon YYYY'), to_char(v_exit, 'Mon YYYY')
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_salary_after_exit() from public, anon;

drop trigger if exists trg_salary_after_exit on public.salary_payments;
create trigger trg_salary_after_exit
  before insert or update of period, employee_id on public.salary_payments
  for each row execute function public.tg_salary_after_exit();

commit;
