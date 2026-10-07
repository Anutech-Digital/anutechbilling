-- deploy-key: aggturn
-- deploy-peek: exists(select 1 from pg_constraint where conname='tenants_aggregate_turnover_check')
-- R-337: the tenant's aggregate annual turnover (AATO) bracket, for e-invoice readiness.
--
-- GST: AATO above ₹5 Cr in any FY since 2017-18 → every B2B invoice needs an IRN from the
-- IRP; AATO ₹10 Cr or more → the IRN must be taken within 30 days of the invoice date.
-- The app does not generate IRNs yet (R-044), so this only switches on WARNINGS:
-- a banner in the issue dialog / invoice page and an ageing banner on /invoices.
-- Nothing is blocked and no tax figure changes.
--
-- NULL = "not sure" = today's behaviour (no banner). The app reads it through
-- lib/compliance/turnover.ts and treats a missing column as NULL, so it works before and
-- after this migration. No backfill: guessing a turnover would be wrong for someone.
--
-- Writes go through the existing owner-only tenant update policy; nothing new to grant.
-- Idempotent.

alter table public.tenants add column if not exists aggregate_turnover text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_aggregate_turnover_check') then
    alter table public.tenants add constraint tenants_aggregate_turnover_check
      check (aggregate_turnover is null or aggregate_turnover in ('up_to_5cr', '5_to_10cr', '10cr_plus'));
  end if;
end $$;

comment on column public.tenants.aggregate_turnover is
  'R-337: up_to_5cr | 5_to_10cr | 10cr_plus — aggregate annual turnover (highest FY since 2017-18). Above 5 Cr = B2B invoices need an e-invoice IRN; 10 Cr+ = IRN within 30 days. NULL = not sure (no warnings).';

notify pgrst, 'reload schema';
