-- 0207 — Employee reasoning assessments (AI-generated MCQ tests + public take link).
create table if not exists public.assessments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  title        text not null,
  topic        text,
  difficulty   text not null default 'medium',
  questions    jsonb not null default '[]'::jsonb,
  public_token text not null unique,
  pass_pct     int  not null default 40,
  status       text not null default 'active',
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists assessments_tenant_idx on public.assessments (tenant_id, created_at desc);

create table if not exists public.assessment_attempts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  employee_id   uuid references public.employees(id) on delete set null,
  candidate_name text not null,
  answers       jsonb not null default '[]'::jsonb,
  score         int not null,
  total         int not null,
  pct           int not null,
  grade         text not null,
  submitted_at  timestamptz not null default now()
);
create index if not exists assessment_attempts_idx on public.assessment_attempts (tenant_id, assessment_id, submitted_at desc);

alter table public.assessments enable row level security;
alter table public.assessment_attempts enable row level security;

drop policy if exists assessments_all on public.assessments;
create policy assessments_all on public.assessments
  for all using (tenant_id = (select tenant_id from public.users where id = auth.uid()))
  with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));
drop policy if exists attempts_select on public.assessment_attempts;
create policy attempts_select on public.assessment_attempts
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

grant select, insert, update, delete on public.assessments to authenticated;
grant select on public.assessment_attempts to authenticated;
-- Public take + submit happen through service-role API routes, not anon RLS.
