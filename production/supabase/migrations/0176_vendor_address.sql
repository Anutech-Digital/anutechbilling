-- 0176_vendor_address.sql
-- Vendors need a supplier address (for POs, bills, and GST place-of-supply).
-- Structured so `state` can drive inter/intra-state GST later. All nullable
-- and idempotent — no backfill needed; existing vendors just stay blank.

alter table public.vendors add column if not exists address text;
alter table public.vendors add column if not exists city    text;
alter table public.vendors add column if not exists state   text;
alter table public.vendors add column if not exists pincode text;

comment on column public.vendors.address is 'Street / building address of the supplier (free text).';
comment on column public.vendors.city    is 'City / town of the supplier.';
comment on column public.vendors.state   is 'State (GST place-of-supply) of the supplier.';
comment on column public.vendors.pincode is '6-digit PIN code of the supplier.';
