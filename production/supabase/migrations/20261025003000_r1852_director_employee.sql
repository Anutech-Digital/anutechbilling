-- deploy-peek: exists(select 1 from information_schema.columns where table_schema='public' and table_name='company_directors' and column_name='employee_id') and to_regprocedure('public.set_director_employee(uuid,uuid)') is not null
-- deploy-key: r1852directoremployee
-- 20261025003000_r1852_director_employee.sql
--
-- R-1852 (epic R-1841, Phase 3 — Pvt Ltd): which employee is a director.
--
-- A whole-time / managing director who draws a salary is an employee of the company and is
-- paid through Payroll (TDS on salary, Income-tax Act s.192). The accounts show directors'
-- remuneration apart from staff salaries, so the P&L must know which payroll entries are a
-- director's. Payroll keeps booking them as "Salaries" (pay_salary is unchanged); the P&L moves
-- a linked employee's payroll rows into the Director's Remuneration line
-- (lib/accounting/director-remuneration.ts), found through salary_payments.expense_id.
--
-- ══ THE DATA ═══════════════════════════════════════════════════════════════════════════
--   company_directors.employee_id — nullable, references employees(id) ON DELETE SET NULL
--   (deleting the employee leaves the director in the register). One employee is one director:
--   unique per company where set.
--
-- ══ THE FUNCTION ═══════════════════════════════════════════════════════════════════════
--   set_director_employee(p_director_id, p_employee_id) — null unlinks. §17c guard; roles owner,
--   manager, accountant (the directors register's roles, R-1850); both rows must be in the
--   caller's company; only a Pvt Ltd (or an empty type). Not a money write. Authenticated has
--   no direct write on the table (R-1850), so this is the only way in. save_company_director
--   does not touch employee_id, so editing a director keeps the link.
--
-- Nothing existing changes. Proof: supabase/tests/r1852_director_employee.test.sql (one rollback).

begin;

alter table public.company_directors
  add column if not exists employee_id uuid references public.employees(id) on delete set null;

comment on column public.company_directors.employee_id is
  'R-1852: the employee Payroll pays this director as (salary, TDS u/s 192). The P&L shows that payroll under Director''s Remuneration.';

create unique index if not exists company_directors_tenant_employee_uq
  on public.company_directors (tenant_id, employee_id) where employee_id is not null;

create or replace function public.set_director_employee(p_director_id uuid, p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_type     text;
  v_other    text;
begin
  /* R-1852: §17c guard + the directors register's roles (R-1850). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change the directors register' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is not null and v_type <> 'pvt_ltd' then
    raise exception 'The directors register is for a Pvt Ltd company — set the business type in Settings → Company first.';
  end if;

  perform 1 from public.company_directors where id = p_director_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That director is not in your company.'; end if;

  if p_employee_id is not null then
    perform 1 from public.employees where id = p_employee_id and tenant_id = v_tenant;
    if not found then raise exception 'That employee is not in your company.'; end if;
    select name into v_other from public.company_directors
     where tenant_id = v_tenant and employee_id = p_employee_id and id <> p_director_id;
    if found then raise exception 'This employee is already linked to director %.', v_other; end if;
  end if;

  update public.company_directors
     set employee_id = p_employee_id, updated_at = now()
   where id = p_director_id and tenant_id = v_tenant;
end;
$$;

revoke all on function public.set_director_employee(uuid, uuid) from public, anon;
grant execute on function public.set_director_employee(uuid, uuid) to authenticated, service_role;

commit;
