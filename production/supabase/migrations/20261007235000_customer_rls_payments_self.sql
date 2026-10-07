-- deploy-key: custrls2
-- deploy-peek: (not exists(select 1 from pg_policy where polname in ('payments_select_own_customer','customers_select_self_customer')) and exists(select 1 from pg_proc where proname='portal_my_payments' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='portal_my_customer' and pronamespace='public'::regnamespace))
-- 20261007235000_customer_rls_payments_self.sql
--
-- R-398 (P1 security, 7 Oct 2026) — follow-up to R-395 (20261007233000_customer_rls_leaks).
--
-- A signed-in portal CUSTOMER (auth user with a customer_users row, no public.users row) could
-- still read internal columns straight from PostgREST through two broad row policies:
--
--   payments_select_own_customer   → notes (staff's internal note), recorded_by (staff user id),
--                                    bank_account_id (which of our bank accounts), gateway_fee /
--                                    gateway_fee_gst (our cost), receipt_file_path, refund_reason …
--   customers_select_self_customer → the WHOLE customers row: notes, health, account_manager_id,
--                                    credit_limit, allow_pay_later, group_id, gstin_verification,
--                                    linked_tenant_id, contact_persons …
--
-- Same fix as R-395: Postgres column privileges are per ROLE and staff + customers are both
-- `authenticated`, so a column REVOKE would hide these from staff too. Drop the two customer
-- SELECT policies (staff policies untouched — a customer has no public.users row, so
-- current_tenant_id() is null for them and every staff policy already gives them nothing) and
-- give the portal two column-limited SECURITY DEFINER readers, each scoped by
-- current_customer_id() inside the function so the caller can never widen it:
--
--   portal_my_payments()  receipt display fields: amount, method, reference, status, dates,
--                         voucher numbers, quote id — no notes / recorded_by / bank / fees / file
--   portal_my_customer()  the customer's own profile: name, GSTIN, address, primary contact —
--                         no notes / health / manager / credit / group / verification internals
--
-- Nothing in src reads payments or customers as a customer (the portal UI was deleted 19 Sep;
-- every remaining read is a staff route) and every existing portal_* RPC is SECURITY DEFINER,
-- so none of them depended on these two policies.
--
-- Re-runnable: drop policy if exists, create or replace, grants restated.

begin;

-- ── payments: drop the whole-row customer policy, add a receipt-only reader ─────────────────
drop policy if exists payments_select_own_customer on public.payments;

create or replace function public.portal_my_payments()
returns table (
  id                 uuid,
  quote_id           text,
  amount             integer,
  method             text,
  reference          text,
  status             text,
  received_at        timestamptz,
  refunded_at        timestamptz,
  receipt_voucher_no text,
  refund_voucher_no  text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.quote_id, p.amount, p.method, p.reference, p.status, p.received_at,
         p.refunded_at, p.receipt_voucher_no, p.refund_voucher_no
    from public.payments p
    join public.customers c on c.id = p.customer_id and c.tenant_id = p.tenant_id
   where p.customer_id = public.current_customer_id()
   order by p.received_at desc
$$;

-- ── customers: drop the whole-row self policy, add a profile-only reader ────────────────────
drop policy if exists customers_select_self_customer on public.customers;

create or replace function public.portal_my_customer()
returns table (
  id                 uuid,
  customer_number    text,
  name               text,
  display_name       text,
  customer_type      text,
  domain             text,
  gstin              text,
  address            text,
  city               text,
  state              text,
  state_code         text,
  pin_code           text,
  country            text,
  shipping_address   jsonb,
  contact_salutation text,
  contact_name       text,
  contact_first_name text,
  contact_last_name  text,
  contact_title      text,
  contact_email      text,
  contact_phone      text,
  contact_mobile     text,
  since              date
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.customer_number, c.name, c.display_name, c.customer_type, c.domain, c.gstin,
         c.address, c.city, c.state, c.state_code, c.pin_code, c.country, c.shipping_address,
         c.contact_salutation, c.contact_name, c.contact_first_name, c.contact_last_name,
         c.contact_title, c.contact_email, c.contact_phone, c.contact_mobile, c.since
    from public.customers c
   where c.id = public.current_customer_id()
$$;

revoke all on function public.portal_my_payments() from public, anon;
revoke all on function public.portal_my_customer() from public, anon;
grant execute on function public.portal_my_payments() to authenticated, service_role;
grant execute on function public.portal_my_customer() to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
