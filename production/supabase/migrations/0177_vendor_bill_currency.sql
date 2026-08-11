-- 0177_vendor_bill_currency.sql
-- International (foreign) vendor bills: remember the original currency + the
-- exchange rate used, so we can show the supplier's own-currency amount (e.g.
-- $265.50) alongside the ₹ books figure. The ₹ columns stay the source of
-- truth for P&L; currency/fx_rate are for display + auditability.
--   fx_rate = ₹ per 1 unit of `currency`  (1 for domestic INR bills)

alter table public.vendor_bills add column if not exists currency text    not null default 'INR';
alter table public.vendor_bills add column if not exists fx_rate  numeric  not null default 1;

comment on column public.vendor_bills.currency is 'Currency printed on the bill (ISO): INR, USD, … . INR = domestic.';
comment on column public.vendor_bills.fx_rate  is '₹ per 1 unit of currency at bill time (1 for INR). Foreign amount = total / fx_rate.';

-- Backfill bills already saved with the FX basis recorded in notes
-- ("Foreign bill: USD 265.5 @ ₹91.5/USD = ₹24,293.").
update public.vendor_bills
set currency = coalesce(nullif(substring(notes from 'Foreign bill:\s*([A-Za-z]{3})'), ''), currency),
    fx_rate  = coalesce(nullif(substring(notes from '@\s*₹?\s*([0-9]+(?:\.[0-9]+)?)\s*/'), '')::numeric, fx_rate)
where notes like 'Foreign bill:%';
