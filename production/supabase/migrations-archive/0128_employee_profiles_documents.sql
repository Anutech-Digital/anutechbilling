-- 0128: employee full profile + document vault
-- ============================================================================
-- Adds HR profile fields to employees, a tenant-scoped employee_documents table,
-- and a PRIVATE storage bucket ('employee-docs') for ID/resume uploads. Documents
-- hold sensitive PII (Aadhaar etc.) so both the table and the bucket are locked to
-- the owning tenant via RLS; files are only ever served through short-lived signed
-- URLs. Storage path convention: {tenant_id}/{employee_id}/{uuid}-{filename}.

-- ── Profile fields ──────────────────────────────────────────────────────────
alter table public.employees
  add column if not exists email                   text,
  add column if not exists phone                   text,
  add column if not exists designation             text,
  add column if not exists date_of_birth           date,
  add column if not exists address                 text,
  add column if not exists emergency_contact_name  text,
  add column if not exists emergency_contact_phone text;

-- ── Documents table ─────────────────────────────────────────────────────────
create table if not exists public.employee_documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  doc_type     text not null default 'other',   -- aadhaar | pan | voter_id | resume | offer_letter | other
  file_name    text not null,
  file_path    text not null unique,            -- object key inside the 'employee-docs' bucket
  mime_type    text,
  size_bytes   integer,
  uploaded_by  uuid,
  uploaded_at  timestamptz not null default now()
);
create index if not exists employee_documents_employee_idx on public.employee_documents(employee_id);
create index if not exists employee_documents_tenant_idx   on public.employee_documents(tenant_id);

alter table public.employee_documents enable row level security;

drop policy if exists "employee_documents tenant all" on public.employee_documents;
create policy "employee_documents tenant all" on public.employee_documents
  for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- ── Private storage bucket + tenant-scoped object policies ────────────────────
insert into storage.buckets (id, name, public)
values ('employee-docs', 'employee-docs', false)
on conflict (id) do nothing;

drop policy if exists "employee-docs tenant read"   on storage.objects;
drop policy if exists "employee-docs tenant insert" on storage.objects;
drop policy if exists "employee-docs tenant delete" on storage.objects;

create policy "employee-docs tenant read" on storage.objects
  for select to authenticated
  using (bucket_id = 'employee-docs' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

create policy "employee-docs tenant insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'employee-docs' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

create policy "employee-docs tenant delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'employee-docs' and (storage.foldername(name))[1] = public.current_tenant_id()::text);
