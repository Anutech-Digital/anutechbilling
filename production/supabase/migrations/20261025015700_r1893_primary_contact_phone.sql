-- deploy-peek: to_regprocedure('public.r1893_sync_primary_contact_phone()') is not null and to_regprocedure('public.r1893_backfill_primary_contact_phones()') is not null
-- R-1893 (25 Oct 2026, Pardeep, staging): "iska mobile number dala hua hai phir bhi show nahi kar raha hai".
--
-- The customer form writes the phone / mobile to customers.contact_phone / contact_mobile.
-- The company profile (header contact card + Contacts card) shows the PRIMARY CONTACT's
-- phone (contacts.phone via customer_contacts). Two homes for one fact: the mobile typed in
-- the form never reached the contact, so the profile showed name + email and no phone.
--
-- The primary contact is the one home of the phone. This migration:
--   1. keeps it in step: when a customer's phone or mobile is CHANGED, the number just typed
--      (mobile first, else phone) is written to the primary contact's phone — so the form and
--      the profile can never show two different numbers;
--   2. backfills once: a primary contact whose phone is BLANK gets the customer record's
--      mobile (else phone). A phone already on the contact is never overwritten.
-- A masked value (R-1009, "••••3210") is never copied.

create or replace function public.r1893_sync_primary_contact_phone()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new text;
begin
  -- The number the operator just typed: a changed, non-blank mobile wins, else a changed phone.
  if new.contact_mobile is distinct from old.contact_mobile
     and nullif(trim(coalesce(new.contact_mobile, '')), '') is not null then
    v_new := trim(new.contact_mobile);
  elsif new.contact_phone is distinct from old.contact_phone
     and nullif(trim(coalesce(new.contact_phone, '')), '') is not null then
    v_new := trim(new.contact_phone);
  end if;

  -- Cleared, or a masked value: leave the contact's number alone.
  if v_new is null or v_new like '%•%' then
    return new;
  end if;

  -- Scoped to this customer's own tenant and its one primary link (customer_contacts_one_primary).
  update public.contacts p
     set phone = v_new
    from public.customer_contacts cc
   where cc.customer_id = new.id
     and cc.tenant_id   = new.tenant_id
     and cc.is_primary
     and p.id        = cc.contact_id
     and p.tenant_id = new.tenant_id
     and p.phone is distinct from v_new;

  return new;
end;
$$;

revoke all on function public.r1893_sync_primary_contact_phone() from public, anon, authenticated;
grant execute on function public.r1893_sync_primary_contact_phone() to service_role;

drop trigger if exists trg_r1893_sync_primary_contact_phone on public.customers;
create trigger trg_r1893_sync_primary_contact_phone
  after update of contact_phone, contact_mobile on public.customers
  for each row
  when (new.contact_phone is distinct from old.contact_phone
        or new.contact_mobile is distinct from old.contact_mobile)
  execute function public.r1893_sync_primary_contact_phone();

comment on function public.r1893_sync_primary_contact_phone() is
  'R-1893: a changed customers.contact_mobile / contact_phone is copied to the PRIMARY contact''s '
  'phone (customer_contacts.is_primary), so the customer form and the profile never show two '
  'different numbers. Blank and masked values are not copied.';

-- ── One-time backfill: fill ONLY blank primary-contact phones from the customer record ────
-- A function (not a bare UPDATE) so the SQL test can run it against its own rows.
-- A person can be primary for several customers; the oldest customer's number is used
-- (distinct on), so the result does not depend on row order. Returns how many were filled.
create or replace function public.r1893_backfill_primary_contact_phones()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  with src as (
    select distinct on (cc.contact_id)
           cc.contact_id,
           cc.tenant_id,
           coalesce(nullif(trim(coalesce(c.contact_mobile, '')), ''),
                    nullif(trim(coalesce(c.contact_phone, '')), '')) as phone
      from public.customer_contacts cc
      join public.customers c
        on c.id = cc.customer_id and c.tenant_id = cc.tenant_id
     where cc.is_primary
       and coalesce(nullif(trim(coalesce(c.contact_mobile, '')), ''),
                    nullif(trim(coalesce(c.contact_phone, '')), '')) is not null
     order by cc.contact_id, c.created_at, c.id
  )
  update public.contacts p
     set phone = src.phone
    from src
   where p.id = src.contact_id
     and p.tenant_id = src.tenant_id
     and nullif(trim(coalesce(p.phone, '')), '') is null
     and src.phone not like '%•%';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.r1893_backfill_primary_contact_phones() from public, anon, authenticated;
grant execute on function public.r1893_backfill_primary_contact_phones() to service_role;

select public.r1893_backfill_primary_contact_phones();
