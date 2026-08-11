-- 0193 — Project labour allocation (attach employees to a project as a cost).
--
-- An attached employee's salary/time is a real cost of the project, so it must
-- show in the PROJECT P&L. BUT salaries already hit the COMPANY P&L exactly once
-- (via pay_salary → an `expenses` row, category 'Salaries'). So labour on a
-- project is a MANAGEMENT OVERLAY: it lives in its own table, is read only by the
-- project P&L view, and is NEVER written to `expenses` — guaranteeing salaries
-- are never double-counted company-wide.
--
-- Cost model = time% × salary × months (an employee can be split across many
-- projects — allocation is a % of their monthly gross, not the whole salary).

create table if not exists public.project_labour (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  project_id   uuid not null references public.project_sales(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  percent      numeric not null default 100 check (percent > 0 and percent <= 100),  -- % of the employee's time on THIS project
  months       numeric not null default 1 check (months > 0),                        -- how long
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, project_id, employee_id)
);

create index if not exists project_labour_project_idx on public.project_labour (project_id);
create index if not exists project_labour_employee_idx on public.project_labour (employee_id);

alter table public.project_labour enable row level security;

-- Tenant isolation (same shape as project_sales / payroll tables).
drop policy if exists project_labour_rw on public.project_labour;
create policy project_labour_rw on public.project_labour
  for all
  using (tenant_id = (select tenant_id from public.users where id = auth.uid()))
  with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));

drop trigger if exists trg_project_labour_updated_at on public.project_labour;
create trigger trg_project_labour_updated_at
  before update on public.project_labour
  for each row execute function public.handle_updated_at();

comment on table public.project_labour is 'Employee time allocated to a project (management overlay for per-project P&L). Cost = employees.monthly_gross × percent% × months. NEVER written to expenses — company P&L is unaffected (salaries are booked once via payroll).';
