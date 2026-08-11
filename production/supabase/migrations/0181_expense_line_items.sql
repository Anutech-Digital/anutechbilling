-- 0181_expense_line_items.sql
-- Expenses can carry the same itemised detail as COGS bills — an Anthropic /
-- software / stationery invoice often lists several line items. Storing them
-- lets the operator verify the entry against the paper bill (items → subtotal
-- → GST → total), exactly like vendor bills. Amounts are kept in the bill's
-- OWN currency (faithful to the document); the ₹ books use `amount`/`fx_rate`.
--   line item shape: { name, qty?, rate?, amount }  (matches VendorBillLine)

alter table public.expenses
  add column if not exists line_items jsonb not null default '[]'::jsonb;

comment on column public.expenses.line_items is 'Itemised bill lines [{name, qty?, rate?, amount}] in the bill''s own currency; for verifying the entry against the paper bill.';
