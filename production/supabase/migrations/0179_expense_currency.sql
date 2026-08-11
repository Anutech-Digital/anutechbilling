-- 0179_expense_currency.sql
-- Foreign (non-INR) expenses — same treatment as COGS bills: remember the
-- original currency + exchange rate so we can show the supplier's own-currency
-- amount (e.g. $265.50) next to the ₹ books figure. ₹ (amount/gst_paid) stays
-- the source of truth for P&L; currency/fx_rate are display + auditability.
--   fx_rate = ₹ per 1 unit of `currency`  (1 for domestic INR expenses)

alter table public.expenses add column if not exists currency text    not null default 'INR';
alter table public.expenses add column if not exists fx_rate  numeric  not null default 1;

comment on column public.expenses.currency is 'Currency printed on the bill (ISO): INR, USD, … . INR = domestic.';
comment on column public.expenses.fx_rate  is 'INR per 1 unit of currency at bill time (1 for INR). Foreign amount = amount / fx_rate.';

-- Backfill expenses moved from COGS bills that carry the FX basis in their note
-- ("Moved from Vendor Bills · G06GABHR-0015 · USD @ ₹91.5/USD · …").
update public.expenses
set currency = coalesce(nullif(substring(description from '·\s*([A-Za-z]{3})\s*@'), ''), currency),
    fx_rate  = coalesce(nullif(substring(description from '@\s*₹?\s*([0-9]+(?:\.[0-9]+)?)'), '')::numeric, fx_rate)
where description like '%@ ₹%';
