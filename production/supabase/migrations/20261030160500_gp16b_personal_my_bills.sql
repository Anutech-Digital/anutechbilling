-- deploy-peek: to_regprocedure('public.personal_my_invoices()') is not null and to_regprocedure('public.personal_my_quotes()') is not null and to_regprocedure('public.personal_my_payments()') is not null and to_regprocedure('public.personal_my_subscriptions()') is not null
-- 20261030160500_gp16b_personal_my_bills.sql
--
-- R-2132 (GP-16b, goal G-PERSONAL measures 4/5, 30 Oct 2026): a personal login reads the bills
-- of the Anutech customer its login is linked to — invoices, quotes, payments, subscriptions.
--
-- THE GAP: GP-16a (R-2118) links a personal login to ONE individual customer of the website
-- company (personal_identity_link.anutech_customer_id, in seller_tenant_id). Nothing let that
-- login read the customer's documents: those rows live in the SELLER's tenant, which RLS never
-- shows a personal workspace, and the customer-portal readers (portal_my_*,
-- 20261007233000_customer_rls_leaks.sql) key on current_customer_id() — a customer_users login,
-- which a personal login is not. There was also never a portal_my_invoices at all.
--
-- WHAT IS HERE — four read-only SECURITY DEFINER functions, same shape as portal_my_*:
--   personal_my_invoices()       no drafts; amount, tax, paid, balance due, dates, status
--   personal_my_quotes()         no drafts; line items WITHOUT cost/list_rate (as portal_my_quotes)
--   personal_my_payments()       received/refunded; no gateway fee, bank account, notes, recorded_by
--   personal_my_subscriptions()  same columns as portal_my_subscriptions
-- Every one resolves the customer ONLY through personal_identity_link where
-- auth_user_id = auth.uid() and link_status = 'linked' — never a parameter from the browser.
-- No link, a gated link (needs_decision, no customer) or a business login → 0 rows, not an error.
-- Each row must match the link's customer AND seller tenant (customer_id + tenant_id), so a
-- customer id reused in another tenant cannot leak.
--
-- GP-10 (R-2125, data-gateway allowlist for personal sessions) is not built yet. Its ratchet
-- scans migrations for `function public.personal_*`, so these four are picked up by it and
-- must be on its list — named personal_my_* for exactly that reason. -- personal-rpc
--
-- Grants: authenticated + service_role only (anon revoked). Test:
-- supabase/tests/gp16b_personal_my_bills.test.sql

begin;

-- the one customer a personal login is linked to (internal helper; not callable from the browser)
create or replace function public.gp16b_linked_customer()
returns table (customer_id uuid, tenant_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  /* R-2132 GP-16b */
  select l.anutech_customer_id, l.seller_tenant_id
    from public.personal_identity_link l
    join public.customers c on c.id = l.anutech_customer_id and c.tenant_id = l.seller_tenant_id
   where l.auth_user_id = auth.uid()
     and l.link_status = 'linked'
     and l.anutech_customer_id is not null
     and l.seller_tenant_id is not null
$$;

create or replace function public.personal_my_invoices()
returns table (
  id               text,
  invoice_date     date,
  due_date         date,
  paid_date        date,
  status           text,
  document_kind    text,
  currency         text,
  taxable_value    integer,
  tax_amount       integer,
  amount           integer,
  paid_amount      integer,
  balance_due      integer,
  quote_id         text
)
language sql
stable
security definer
set search_path = public
as $$
  /* R-2132 GP-16b */
  select i.id, i.invoice_date, i.due_date, i.paid_date, i.status::text, i.document_kind,
         i.currency, i.taxable_value, i.tax_amount, i.amount, coalesce(i.paid_amount, 0),
         case when i.status::text in ('paid', 'void') then 0
              else greatest(coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0), 0) end,
         i.quote_id
    from public.gp16b_linked_customer() me
    join public.invoices i on i.customer_id = me.customer_id and i.tenant_id = me.tenant_id
   where i.status::text <> 'draft'
   order by i.invoice_date desc nulls last, i.created_at desc
$$;

create or replace function public.personal_my_quotes()
returns table (
  id               text,
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
  payment_status   text,
  invoice_id       text,
  line_items       jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  /* R-2132 GP-16b — projection as portal_my_quotes: display fields only, cost/list_rate dropped */
  select q.id, q.plan, q.seats, q.status::text, q.created_date, q.expires_date,
         q.subtotal, q.discount_pct, q.tax_rate, q.amount, q.currency, q.billing_cycle,
         q.payment_status::text, q.invoice_id,
         coalesce((
           select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'id', li->'id', 'name', li->'name', 'qty', li->'qty', 'rate', li->'rate',
                    'months', li->'months', 'start_date', li->'start_date',
                    'commitment', li->'commitment', 'optional', li->'optional'))
                  order by ord)
             from jsonb_array_elements(
                    case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end
                  ) with ordinality as e(li, ord)
         ), '[]'::jsonb)
    from public.gp16b_linked_customer() me
    join public.quotes q on q.customer_id = me.customer_id and q.tenant_id = me.tenant_id
   where q.status::text <> 'draft'
   order by q.created_at desc
$$;

create or replace function public.personal_my_payments()
returns table (
  id                 uuid,
  received_at        timestamptz,
  amount             integer,
  method             text,
  reference          text,
  status             text,
  receipt_voucher_no text,
  invoice_id         text,
  quote_id           text,
  refunded_at        timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  /* R-2132 GP-16b */
  select p.id, p.received_at, p.amount, p.method, p.reference, p.status, p.receipt_voucher_no,
         p.invoice_id, p.quote_id, p.refunded_at
    from public.gp16b_linked_customer() me
    join public.payments p on p.customer_id = me.customer_id and p.tenant_id = me.tenant_id
   order by p.received_at desc nulls last, p.created_at desc
$$;

create or replace function public.personal_my_subscriptions()
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
  /* R-2132 GP-16b — same columns as portal_my_subscriptions */
  select s.id, s.domain, s.plan, s.vendor::text, s.seats, s.used, s.start_date, s.renewal_date,
         s.status::text, s.auto_renew, s.billing_cycle::text, s.term_months,
         s.outstanding_amount, s.payment_due_date
    from public.gp16b_linked_customer() me
    join public.subscriptions s on s.customer_id = me.customer_id and s.tenant_id = me.tenant_id
   order by s.renewal_date nulls last, s.plan
$$;

revoke all on function public.gp16b_linked_customer()   from public, anon, authenticated;
revoke all on function public.personal_my_invoices()       from public, anon;
revoke all on function public.personal_my_quotes()         from public, anon;
revoke all on function public.personal_my_payments()       from public, anon;
revoke all on function public.personal_my_subscriptions()  from public, anon;
grant execute on function public.gp16b_linked_customer()  to service_role;
grant execute on function public.personal_my_invoices()      to authenticated, service_role;
grant execute on function public.personal_my_quotes()        to authenticated, service_role;
grant execute on function public.personal_my_payments()      to authenticated, service_role;
grant execute on function public.personal_my_subscriptions() to authenticated, service_role;

commit;
