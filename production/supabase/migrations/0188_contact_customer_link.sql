-- 0188 — Link a contact (address-book person) to a customer company.
--
-- Contacts started as a standalone people list with only a free-text `company`
-- string. When that person actually belongs to one of the tenant's customer
-- companies, we now store a real FK so the contact detail page can surface the
-- company's full records (invoices, subscriptions, projects, outstanding/MRR)
-- and stay in sync with the customer.
--
-- One contact → one primary company (the common case for a solo reseller). The
-- free-text `company` column stays for prospects whose company isn't a customer
-- yet. ON DELETE SET NULL so removing a customer never deletes the contact — it
-- just unlinks. Tenant-scoped RLS on `contacts` already covers this column.

alter table public.contacts
  add column if not exists customer_id uuid null references public.customers(id) on delete set null;

create index if not exists contacts_customer_id_idx
  on public.contacts (customer_id)
  where customer_id is not null;

comment on column public.contacts.customer_id is 'Optional link to the customer company this person belongs to; ON DELETE SET NULL (unlink, never cascade-delete the contact).';
