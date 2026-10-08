-- deploy-key: custrls
-- deploy-peek: (not exists(select 1 from pg_policy where polname in ('tenants_select_own_customer','quotes_select_own_customer','subscriptions_select_own_customer')) and exists(select 1 from pg_proc where proname='portal_my_tenant' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='current_customer_id' and pronamespace='public'::regnamespace and prosrc like '%R-395%'))
-- 20261007233000_customer_rls_leaks.sql
--
-- R-395 (P1 security, 7 Oct 2026 — docs/CUSTOMER-PORTAL-SCOPE.md Phase 0, S1–S3).
--
-- A signed-in portal CUSTOMER (auth user with a customer_users row, no public.users row) could
-- read more than their own display data, straight from PostgREST:
--
--   S1  tenants_select_own_customer      → the WHOLE tenants row: attendance_ingest_key (the
--                                          secret the attendance device posts with), remit bank
--                                          account, email/AI settings, books lock …
--   S2  quotes_select_own_customer       → total_cost (our margin), line_items[].cost, notes,
--                                          payment_notes, approval/credit internals
--       subscriptions_select_own_customer→ write_off_reason, is_urgent, reminder_count,
--                                          vendor_cost_per_seat_month (our cost) …
--   S3  current_customer_id()            → `limit 1`: a contact linked to two customers got an
--                                          arbitrary one.
--
-- Postgres column privileges are per ROLE, and staff and customers are both `authenticated`, so
-- a column REVOKE would hide total_cost from staff too. The fix is therefore: drop the three broad
-- customer SELECT policies (staff policies are untouched — a customer has no public.users row, so
-- current_tenant_id() is null for them and every staff policy already gives them nothing) and give
-- the portal three column-limited SECURITY DEFINER readers instead:
--
--   portal_my_tenant()         name, logo, GSTIN, address, support email/phone, UPI — nothing else
--   portal_my_quotes()         display fields + line items without cost/list_rate; never drafts
--   portal_my_subscriptions()  plan, seats bought/used, dates, status, auto-renew, amount due
--
-- Each one filters on current_customer_id() inside the function, so the caller can never widen it.
-- Invoices, payments, customers(self) and support tickets keep their row policies (out of scope —
-- see the R-395 card for the follow-up on payments.notes / customers internal fields).
--
-- current_customer_id(): one link → that customer (unchanged). More than one link → the customer
-- named by the server-signed JWT claim (app_metadata.customer_id, or a top-level customer_id claim
-- minted by the Auth.js gateway) ONLY IF it is one of the caller's own links; otherwise NULL, which
-- every customer policy and portal RPC treats as "no access". The claim can never select a
-- customer the user is not linked to, so a forged or stale claim cannot widen access.
-- portal_list_products / portal_request_quote used their own `limit 1` guess; they now go through
-- current_customer_id() too.
--
-- Re-runnable: drop policy if exists, create or replace, grants restated.

begin;

-- ── S3: current_customer_id() — refuse when ambiguous ───────────────────────────────────────
-- create or replace keeps the existing grants (authenticated + service_role); RLS policies call it.
create or replace function public.current_customer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  /* R-395: no `limit 1` guess. One link → it. Several → only the server-selected one. */
  with links as (
    select cu.customer_id
      from public.customer_users cu
     where cu.auth_user_id = auth.uid()
  ),
  claims as (
    select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c
  ),
  picked as (
    select coalesce(
             nullif(c #>> '{app_metadata,customer_id}', ''),
             nullif(c ->> 'customer_id', '')
           ) as v
      from claims
  )
  select case
           when (select count(*) from links) = 1 then (select customer_id from links)
           else (select l.customer_id
                   from links l, picked p
                  where p.v is not null
                    and l.customer_id::text = p.v
                  limit 1)
         end
$$;

-- ── S1: tenants — drop the whole-row policy, add a display-only reader ──────────────────────
drop policy if exists tenants_select_own_customer on public.tenants;

create or replace function public.portal_my_tenant()
returns table (
  name           text,
  logo_url       text,
  gstin          text,
  address        text,
  state          text,
  state_code     text,
  pin_code       text,
  email          text,
  phone          text,
  upi_vpa        text,
  upi_payee_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select t.name, t.logo_url, t.gstin, t.address, t.state, t.state_code, t.pin_code,
         t.email, t.phone, t.upi_vpa, t.upi_payee_name
    from public.customers c
    join public.tenants t on t.id = c.tenant_id
   where c.id = public.current_customer_id()
$$;

-- ── S2: quotes — drop the whole-row policy, add a cost-free reader ──────────────────────────
drop policy if exists quotes_select_own_customer on public.quotes;

create or replace function public.portal_my_quotes()
returns table (
  id               text,
  customer_name    text,
  plan             text,
  seats            integer,
  status           text,
  created_date     date,
  expires_date     date,
  subtotal         integer,
  discount_pct     smallint,
  tax_rate         smallint,
  amount           integer,
  currency         text,
  billing_cycle    text,
  terms_conditions text,
  payment_status   text,
  invoice_id       text,
  line_items       jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select q.id, q.customer_name, q.plan, q.seats, q.status::text, q.created_date, q.expires_date,
         q.subtotal, q.discount_pct, q.tax_rate, q.amount, q.currency, q.billing_cycle,
         q.terms_conditions, q.payment_status::text, q.invoice_id,
         /* Same projection as the public accept page: display fields only, cost/list_rate dropped. */
         coalesce((
           select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'id', li->'id', 'name', li->'name', 'qty', li->'qty', 'rate', li->'rate',
                    'months', li->'months', 'start_date', li->'start_date',
                    'commitment', li->'commitment', 'optional', li->'optional',
                    'included_by_default', li->'included_by_default',
                    'seats_adjustable', li->'seats_adjustable',
                    'min_seats', li->'min_seats', 'max_seats', li->'max_seats'))
                  order by ord)
             from jsonb_array_elements(
                    case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end
                  ) with ordinality as e(li, ord)
         ), '[]'::jsonb) as line_items
    from public.quotes q
    join public.customers c on c.id = q.customer_id and c.tenant_id = q.tenant_id
   where q.customer_id = public.current_customer_id()
     and q.status <> 'draft'
   order by q.created_at desc
$$;

-- ── S2: subscriptions — drop the whole-row policy, add a basic-fields reader ────────────────
drop policy if exists subscriptions_select_own_customer on public.subscriptions;

create or replace function public.portal_my_subscriptions()
returns table (
  id                 uuid,
  domain             text,
  plan               text,
  vendor             text,
  seats              integer,
  used               integer,
  start_date         date,
  renewal_date       date,
  status             text,
  auto_renew         boolean,
  billing_cycle      text,
  term_months        integer,
  outstanding_amount integer,
  payment_due_date   date
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.domain, s.plan, s.vendor::text, s.seats, s.used, s.start_date, s.renewal_date,
         s.status::text, s.auto_renew, s.billing_cycle::text, s.term_months,
         s.outstanding_amount, s.payment_due_date
    from public.subscriptions s
    join public.customers c on c.id = s.customer_id and c.tenant_id = s.tenant_id
   where s.customer_id = public.current_customer_id()
   order by s.renewal_date nulls last, s.plan
$$;

revoke all on function public.portal_my_tenant()        from public, anon;
revoke all on function public.portal_my_quotes()        from public, anon;
revoke all on function public.portal_my_subscriptions() from public, anon;
grant execute on function public.portal_my_tenant()        to authenticated, service_role;
grant execute on function public.portal_my_quotes()        to authenticated, service_role;
grant execute on function public.portal_my_subscriptions() to authenticated, service_role;

-- ── S3 follow-through: the two portal RPCs that guessed with their own `limit 1` ────────────
create or replace function public.portal_list_products()
returns table (id text, name text, vendor text, price_per_seat_month integer, hsn text)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id,
    i.name,
    i.vendor::text,
    coalesce(
      nullif((i.prices->'annual'->>'msrp'), '')::int,
      i.msrp
    ) as price_per_seat_month,
    i.hsn
  from public.items i
  where i.is_active = true
    and i.kind = 'main'
    and i.tenant_id = (
      select c.tenant_id from public.customers c
      where c.id = public.current_customer_id()
    )
  order by coalesce(nullif((i.prices->'annual'->>'msrp'),'')::int, i.msrp) asc, i.name asc;
$$;

create or replace function public.portal_request_quote(p_item_id text, p_seats integer, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_customer  record;
  v_item      record;
  v_seats     int;
  v_rate      int;
  v_value     int;
  v_lead_id   text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  /* R-395: the customer comes from current_customer_id() (ambiguous link → null → refused),
     not from a `limit 1` guess over customer_users. */
  select c.id as customer_id, c.tenant_id, c.name, c.contact_email,
         c.contact_phone, c.gstin, c.state, c.state_code
    into v_customer
  from public.customers c
  where c.id = public.current_customer_id();

  if v_customer.customer_id is null then
    raise exception 'no customer account' using errcode = 'no_data_found';
  end if;

  select i.id, i.name,
         coalesce(nullif((i.prices->'annual'->>'msrp'),'')::int, i.msrp) as rate
    into v_item
  from public.items i
  where i.id = p_item_id
    and i.tenant_id = v_customer.tenant_id
    and i.is_active = true
    and i.kind = 'main'
  limit 1;

  if v_item.id is null then
    raise exception 'product not available' using errcode = 'no_data_found';
  end if;

  v_seats := greatest(1, least(coalesce(p_seats, 1), 100000));
  v_rate  := coalesce(v_item.rate, 0);
  v_value := v_seats * v_rate * 12;

  v_lead_id := 'L-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));

  insert into public.leads (
    id, tenant_id, company, contact_name, contact_email, contact_phone,
    plan, seats, value, stage, source, priority, gstin, state, state_code, notes
  ) values (
    v_lead_id,
    v_customer.tenant_id,
    v_customer.name,
    v_customer.name,
    v_customer.contact_email,
    v_customer.contact_phone,
    v_item.name,
    v_seats,
    v_value,
    'new',
    'Customer Portal',
    'high',
    v_customer.gstin,
    v_customer.state,
    v_customer.state_code,
    'Portal upsell request from existing customer "' || v_customer.name ||
      '" for ' || v_item.name || ' × ' || v_seats || ' seats.' ||
      case when p_note is not null and length(trim(p_note)) > 0
           then ' Note: ' || left(trim(p_note), 500) else '' end
  );

  return v_lead_id;
end;
$$;

commit;

notify pgrst, 'reload schema';
