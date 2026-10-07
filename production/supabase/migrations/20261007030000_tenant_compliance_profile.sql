-- R-262: business type + GST filing mode on the tenant, so the Compliance Calendar
-- stops treating every business as a Pvt Ltd filing GST monthly.
--
-- Audit: a proprietor was shown AOC-4 / MGT-7 / AGM / DPT-3 / ADT-1 (₹100/day penalties
-- he can never owe), and a QRMP filer saw GSTR-1 due on the 11th of every month.
-- The owner sets both in Settings → Company → Compliance profile; lib/compliance/
-- obligations.ts (obligationsFor) narrows the calendar from them.
--
-- NULL = not set yet = today's behaviour (Pvt Ltd, monthly). The app reads these through
-- lib/compliance/profile.ts and treats a missing column as NULL, so it works before and
-- after this migration. No backfill: guessing a business type would be wrong for someone.
--
-- Writes go through the existing owner-only tenant update policy; nothing new to grant.
-- Idempotent.

alter table public.tenants add column if not exists business_type text;
alter table public.tenants add column if not exists gst_filing text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_business_type_check') then
    alter table public.tenants add constraint tenants_business_type_check
      check (business_type is null or business_type in ('proprietor', 'partnership', 'llp', 'pvt_ltd'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenants_gst_filing_check') then
    alter table public.tenants add constraint tenants_gst_filing_check
      check (gst_filing is null or gst_filing in ('monthly', 'qrmp'));
  end if;
end $$;

comment on column public.tenants.business_type is
  'R-262: proprietor | partnership | llp | pvt_ltd. Decides which ROC / income-tax filings the Compliance Calendar shows. NULL = not set (treated as pvt_ltd).';
comment on column public.tenants.gst_filing is
  'R-262: monthly | qrmp. QRMP = GSTR-1 / GSTR-3B quarterly + PMT-06 monthly payment. NULL = not set (treated as monthly).';

notify pgrst, 'reload schema';
