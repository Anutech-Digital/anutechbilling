-- 0185 — Store the tenant's LUT (Letter of Undertaking) for zero-rated exports
--
-- Exporters who ship WITHOUT paying IGST must hold a valid LUT (CGST Rule 96A).
-- We keep the ARN/number + its validity on the tenant so export invoices can
-- print "Supply meant for export under LUT — <no>" and the GST report can label
-- zero-rated sales correctly. Purely identity data; RLS on tenants already
-- limits UPDATE to the owner.

alter table public.tenants
  add column if not exists lut_number     text,
  add column if not exists lut_valid_upto date;

comment on column public.tenants.lut_number     is 'LUT / ARN number for zero-rated exports without IGST (CGST Rule 96A)';
comment on column public.tenants.lut_valid_upto is 'LUT validity end date (usually the financial year end)';
