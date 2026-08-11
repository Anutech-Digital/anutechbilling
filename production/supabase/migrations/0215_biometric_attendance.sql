-- 0215 — biometric attendance ingest.
--
-- A LAN fingerprint terminal (e.g. Hikvision) can't reach a cloud app directly.
-- A small "bridge" on an office PC reads the device's punch log and POSTs each
-- punch to /api/attendance/punch with a per-tenant ingest key. Each device user
-- maps to an employee via employees.biometric_id. Punches land in `attendance`
-- with source='biometric' — first punch of the day = check-in, latest = check-out.

alter table public.employees add column if not exists biometric_id text;
create index if not exists idx_employees_biometric on public.employees(tenant_id, biometric_id);
comment on column public.employees.biometric_id is 'This employee''s user number on the biometric attendance machine (maps device punches → employee).';

-- Per-tenant secret the bridge sends (header x-ingest-key) to authenticate punches.
alter table public.tenants add column if not exists attendance_ingest_key text;
update public.tenants set attendance_ingest_key = replace(gen_random_uuid()::text, '-', '')
  where attendance_ingest_key is null;
create unique index if not exists idx_tenants_attendance_ingest_key on public.tenants(attendance_ingest_key);
