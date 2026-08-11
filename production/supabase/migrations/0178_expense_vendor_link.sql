-- 0178_expense_vendor_link.sql
-- A "vendor" is anyone who invoices us — their invoices split into COGS Bills
-- (resale) and Expenses (overhead). To manage every supplier's full detail in
-- ONE master and roll up all their bills, link expenses to the vendors master.
--
-- Backfill links ONLY to vendors that already exist (exact, case-insensitive
-- name, same tenant). We deliberately do NOT create vendors from expense names
-- here — salary/reimbursement expenses carry employee / person names, which
-- must not pollute the supplier master. New expense vendors are added
-- explicitly via the Add Expense vendor picker.

alter table public.expenses
  add column if not exists vendor_id uuid references public.vendors(id) on delete set null;

create index if not exists expenses_vendor_id_idx on public.expenses(vendor_id);

comment on column public.expenses.vendor_id is 'Optional link to the vendors master (the supplier who invoiced this expense).';

update public.expenses e
set vendor_id = v.id
from public.vendors v
where e.vendor_id is null
  and e.vendor_name is not null
  and v.tenant_id = e.tenant_id
  and lower(btrim(v.name)) = lower(btrim(e.vendor_name));
