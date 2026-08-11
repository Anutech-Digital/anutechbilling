-- 0219 — smart deterrence (Phase 3): anomaly flags + soft device binding + review.
--
-- Honest browser-first deterrence (no ML liveness — see blueprint): every punch
-- is scored for anomalies (odd hours, missing location, a new/unknown device)
-- and surfaced to the owner for review. Deterrence works by RAISING PERCEIVED
-- DETECTION, not by blocking honest users. Real face-match + certified liveness
-- stays a Phase-4 premium tier.

alter table public.attendance
  add column if not exists flags text[] not null default '{}',
  add column if not exists check_in_device  text,   -- sha256 of a soft device token
  add column if not exists check_out_device text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.users(id) on delete set null;

create index if not exists attendance_flags_idx
  on public.attendance (tenant_id) where cardinality(flags) > 0 and reviewed_at is null;
