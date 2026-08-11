-- 0214 — Project task roadmap. Each project (project_sales) gets an ordered list
-- of tasks that can be assigned to the employees allocated to that project
-- (project_labour = the team). Pure ops/tracking — no money impact.

create table if not exists public.project_tasks (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  project_id           uuid not null references public.project_sales(id) on delete cascade,
  title                text not null,
  description          text,
  status               text not null default 'todo',   -- 'todo' | 'in_progress' | 'done'
  assignee_employee_id uuid references public.employees(id) on delete set null,
  due_date             date,
  seq                  integer not null default 0,      -- roadmap order
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_project_tasks_project on public.project_tasks(project_id, seq);
create index if not exists idx_project_tasks_assignee on public.project_tasks(assignee_employee_id);

alter table public.project_tasks enable row level security;

-- Tenant-scoped: a user only ever sees/edits their own tenant's project tasks.
drop policy if exists project_tasks_tenant_all on public.project_tasks;
create policy project_tasks_tenant_all on public.project_tasks
  for all
  using      (tenant_id = (select tenant_id from public.users where id = auth.uid()))
  with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));

grant select, insert, update, delete on public.project_tasks to authenticated;
