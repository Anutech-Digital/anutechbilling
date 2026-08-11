-- 0182_expense_bill_no.sql
-- Store the supplier's invoice / bill number on an expense so we can catch
-- DUPLICATES — the same bill uploaded twice, or re-entered later. Combined with
-- the vendor, (vendor + bill_no) is the natural key for a purchase document;
-- when a bill carries no number we fall back to (vendor + date + amount).
-- A partial index keeps the lookup fast without forcing uniqueness (some real
-- bills legitimately share a blank number, and we warn rather than hard-block).

alter table public.expenses
  add column if not exists bill_no text;

comment on column public.expenses.bill_no is 'Supplier invoice/bill number — used to detect duplicate expense entries (vendor + bill_no).';

create index if not exists expenses_tenant_billno_idx
  on public.expenses (tenant_id, bill_no)
  where bill_no is not null;
