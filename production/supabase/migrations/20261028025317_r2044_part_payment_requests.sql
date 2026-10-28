-- deploy-peek: to_regprocedure('public.bill_subscription_instalment(uuid,boolean)') is not null and to_regprocedure('public.stop_part_payment_request(text,text,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)') and prosrc like '%R-2044%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_to_item(uuid,text,text,integer,numeric,text,boolean,date,date)') and prosrc like '%R-2044%')
-- deploy-key: r2044partpaymentrequests
-- 20261028025317_r2044_part_payment_requests.sql
--
-- R-2044 (28 Oct 2026, Pardeep): a subscription billed in parts (annual commitment, paid
-- monthly / quarterly / half-yearly) no longer gets a TAX INVOICE for each part on its date.
-- "Customer kai baar commitment break kar deta hai aur payment nahi karta — invoice hamari
-- liability ban jayega." An unpaid tax invoice is GST owed and a receivable for money that may
-- never come. Now each part starts as a PAYMENT REQUEST (a quote); the part's tax invoice is
-- raised when that request is paid.
--
-- ─── WHAT CHANGES ────────────────────────────────────────────────────────────────────────
--   quotes.subscription_billing_id   the part (subscription_billings row) a payment request is
--                                    for. Unique: one request per (subscription, term_start,
--                                    period_index) — the billing row's own key — so the daily
--                                    cron can run twice and still make one.
--   customers.invoice_parts_on_due_date  per-customer switch, default OFF (see §1).
--   subscription_billings.request_reminder_step / request_reminded_at
--                                    where the reminder ladder for its payment request stands.
--   instalment_credit(sub)           the ONE credit rule: sale quote receipts + receipts on the
--                                    subscription's part requests (each capped at its amount —
--                                    the excess is already customer credit) − what earlier
--                                    instalment invoices absorbed. raise_subscription_billing
--                                    now reads it (before: sale quote receipts only).
--   bill_subscription_instalment(billing, dry)
--                                    what the billing cron does with a part whose date came:
--                                      · already invoiced                         → nothing
--                                      · the FIRST part of the first term of a sale quote, or
--                                        a part the money already received covers (paid up
--                                        front, R-375), or its request is paid → its tax invoice
--                                        through raise_subscription_billing (the ONLY instalment
--                                        invoice path — no second one), issued PAID
--                                      · the customer's "Invoice on due date" switch is ON →
--                                        its tax invoice on the bill date, as before R-2044
--                                      · otherwise → its payment request (made once):
--                                        "Advance payment for Q2 · 28 Jan–27 Apr 2027", sent on
--                                        the bill date and due that day (prepaid), no expiry.
--   tg_payments_part_request_invoice  a receipt that completes a part request raises that part's
--                                    tax invoice in the same transaction (online checkout, the
--                                    Record payment sheet and bank reconcile all record through
--                                    record_payment → payments), links it on the request
--                                    (quotes.invoice_id) and turns back on a subscription the
--                                    billing cron paused for that request. A refusal (no state on
--                                    the customer, no GSTIN on the company) never undoes the
--                                    payment: it is a warning, and the next billing run raises it.
--   reject_full_term_invoice_when_split_billed  also refuses a whole invoice from a part
--                                    request (generate_invoice / create_direct_invoice).
--   reconcile_bank_credit_to_item    does not call generate_invoice for a part request.
--   split_outstanding_for            a sale quote's subscription owes only the parts BEFORE its
--                                    first part request — from then on each part is owed on its
--                                    own request, and an unpaid request is not a receivable.
--   stop_part_payment_request(q, end, reason)  "Customer stopped": the unpaid request is closed
--                                    (rejected) and the subscription is cancelled
--                                    (cancel_subscription) or paused (suspend_subscription).
--                                    Nothing is invoiced, so nothing is in GST or receivables.
--
-- Not changed: yearly subscriptions; the R-806/807/808 guards; already-invoiced instalments
-- stay frozen; invoices already raised stay as they are (no data repair — Pardeep's call).
-- Test: supabase/tests/r2044_part_payment_requests.test.sql

begin;

-- ── 1. The link and the reminder state ─────────────────────────────────────────────────
alter table public.quotes
  add column if not exists subscription_billing_id uuid
    references public.subscription_billings(id) on delete set null;
create unique index if not exists quotes_subscription_billing_once
  on public.quotes (subscription_billing_id) where subscription_billing_id is not null;
comment on column public.quotes.subscription_billing_id is
  'R-2044: this quote is the payment request for ONE part of a subscription billed in parts. Paying it raises that part''s tax invoice (tg_payments_part_request_invoice).';

alter table public.subscription_billings
  add column if not exists request_reminder_step text,
  add column if not exists request_reminded_at timestamptz;
comment on column public.subscription_billings.request_reminder_step is
  'R-2044: last reminder step sent for this part''s payment request (lib/invoices/dunning ladder), set by /api/cron/billing.';

-- Per customer: customers.invoice_parts_on_due_date (default false). ON = the old path for that
-- customer — each part's tax invoice on its bill date even if unpaid (GST is owed on it),
-- chased by invoice-dunning. Shown on the customer page.
alter table public.customers
  add column if not exists invoice_parts_on_due_date boolean not null default false;
comment on column public.customers.invoice_parts_on_due_date is
  'R-2044: ON = each part of a subscription billed in parts is tax-invoiced on its bill date even if unpaid (GST owed). OFF (default) = a payment request first, the invoice when paid.';

-- ── 2. The one credit rule ──────────────────────────────────────────────────────────────
create or replace function public.instalment_credit(p_subscription_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  /* R-2044 */
  select greatest(0,
           coalesce((select sum(p.amount)::int from public.payments p
                      join public.subscriptions s on s.quote_id = p.quote_id
                     where s.id = p_subscription_id and p.status = 'received'), 0)
         + coalesce((select sum(least(coalesce(q.amount, 0), coalesce(pr.received, 0)))::int
                       from public.subscription_billings b
                       join public.quotes q on q.subscription_billing_id = b.id
                       cross join lateral (select sum(p.amount) as received from public.payments p
                                            where p.quote_id = q.id and p.status = 'received') pr
                      where b.subscription_id = p_subscription_id), 0)
         - coalesce((select sum(i.paid_amount)::int from public.subscription_billings b
                       join public.invoices i on i.id = b.invoice_id
                      where b.subscription_id = p_subscription_id), 0));
$$;
revoke all on function public.instalment_credit(uuid) from public, anon, authenticated;
grant execute on function public.instalment_credit(uuid) to service_role;

-- ── 3. raise_subscription_billing — body of 20261023202157 (R-1803), credit from §2 ──────
CREATE OR REPLACE FUNCTION public.raise_subscription_billing(p_billing_id uuid)
 RETURNS TABLE(invoice_id text, gross integer, already_raised boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_b        record;
  v_sub      record;
  v_id       text;
  v_gross    integer;
  v_tax      integer;
  v_rate     integer;
  v_cust_st  text;
  v_sell_st  text;
  v_cust_gstin   text;
  v_sell_gstin   text;
  v_cust_country text;
  v_is_export    boolean;
  v_inter    boolean;
  v_lines    jsonb;
  v_terms    integer := 30;
  v_today    date := public.ist_today();
  v_existing integer;
  v_received integer := 0;
  v_applied  integer := 0;
  v_credit   integer := 0;
  v_status   invoice_status;
  v_caller   uuid;
  v_trusted  boolean;
  v_r1803_problem text;
begin
  /* R-2044: credit = public.instalment_credit (part payment requests count too). */
  /* R-454: who may act WITHOUT a company of their own. Only trusted server paths: the
     service_role key (public quote-accept, cron, webhooks) or a direct database session
     (psql, scripts) that carries no request role at all. A signed-in user with no company
     (customer-portal login, apprentice, mid-signup) is NOT trusted — before R-454 a NULL
     current_tenant_id() skipped the tenant check entirely (fail-open). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can raise its invoice'
      using errcode = '28000';
  end if;
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  /* activate_quote_on_credit ("Activate now, pay later") calls this with the SAME caller and
     has its own rules (any active member of the company; over-limit / annual = owner), so a
     call nested inside it is left to that function's guard. PG_CONTEXT is the real call stack —
     a browser cannot fake it, and nobody but the migration owner can create functions. */
  declare
    v_r885_ctx text;
  begin
    get diagnostics v_r885_ctx = pg_context;
    if not (coalesce(auth.role(), '') = 'service_role'
            or (auth.role() is null
                and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
       and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing')
       and v_r885_ctx !~ 'function (public\.)?activate_quote_on_credit\(' then
      raise exception 'Only an owner, manager, accountant or billing user can raise an instalment invoice' using errcode = '42501';
    end if;
  end;

  select b.* into v_b
    from public.subscription_billings b
   where b.id = p_billing_id
   for update;

  if not found then
    raise exception 'Billing instalment % not found', p_billing_id
      using errcode = 'no_data_found';
  end if;

  if v_caller is not null
     and v_b.tenant_id is distinct from v_caller then
    raise exception 'Billing instalment % is not in the caller''s tenant', p_billing_id
      using errcode = 'insufficient_privilege';
  end if;

  /* Already billed. Ordinary answer, not an error — the cron retries. */
  if v_b.invoice_id is not null then
    select i.amount into v_existing from public.invoices i where i.id = v_b.invoice_id;
    return query select v_b.invoice_id, coalesce(v_existing, 0), true;
    return;
  end if;

  /* R-1803 (R-1643 follow-up): the company's own GSTIN + address (Bill of Supply: address)
     before any number is taken — the same rule generate_invoice reads. The billing cron
     calls this once per instalment and records a refusal per subscription (errors[] in
     /api/cron/billing, the [cron/billing] log line, "errors N" in the run history), then
     carries on with the next one; the instalment stays unbilled and the next run issues it
     once the company's details are on record. */
  v_r1803_problem := public.supplier_invoice_problem(v_b.tenant_id, v_today);
  if v_r1803_problem is not null then
    raise exception '% The next billing run issues this instalment once that is done.', v_r1803_problem
      using errcode = 'check_violation';
  end if;

  select s.id, s.tenant_id, s.customer_id, s.customer_name, s.plan, s.seats, s.quote_id
    into v_sub
    from public.subscriptions s
   where s.id = v_b.subscription_id;

  if not found then
    raise exception 'Subscription % behind instalment % no longer exists',
      v_b.subscription_id, p_billing_id using errcode = 'no_data_found';
  end if;

  /* ── R-372: place of supply, same rules as generate_invoice (R-041) ──────────────
     This read `(v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st)`,
     so a NULL state on either side resolved to FALSE = intra-state = CGST+SGST: a missing
     fact turned into a confident tax head (AGENTS.md §2) on every instalment invoice.

     State = the entered state_code, else the first two digits of the GSTIN (a registered
     party has already told us their state) — the same fallback invoice_party_snapshot
     uses to freeze pos_state_code, so the head and the printed place of supply agree.

     EXPORT (country set and not India) is the one case where no Indian state is correct:
     zero-rated under IGST Section 16, so no tax and no CGST/SGST/IGST split.

     Anything else still unknown REFUSES. The billing cron reports it per subscription and
     the instalment stays unbilled until the state is set. */
  select c.state_code, c.gstin, c.country into v_cust_st, v_cust_gstin, v_cust_country
    from public.customers c where c.id = v_sub.customer_id;
  select t.state_code, t.gstin into v_sell_st, v_sell_gstin
    from public.tenants t where t.id = v_b.tenant_id;

  v_cust_st := case
    when nullif(btrim(coalesce(v_cust_st, '')), '') is not null then lpad(btrim(v_cust_st), 2, '0')
    when btrim(coalesce(v_cust_gstin, '')) ~ '^[0-9]{2}' then substring(btrim(v_cust_gstin) from 1 for 2)
    else null
  end;
  v_sell_st := case
    when nullif(btrim(coalesce(v_sell_st, '')), '') is not null then lpad(btrim(v_sell_st), 2, '0')
    when btrim(coalesce(v_sell_gstin, '')) ~ '^[0-9]{2}' then substring(btrim(v_sell_gstin) from 1 for 2)
    else null
  end;

  v_is_export := v_cust_country is not null
                 and lower(btrim(v_cust_country)) not in ('', 'in', 'ind', 'india', 'bharat');

  if v_is_export then
    v_inter := false;   -- no Indian place of supply
    v_rate  := 0;       -- zero-rated export (IGST s16)
  elsif v_cust_st is null then
    raise exception
      'Cannot issue the instalment invoice: % has no state (or GSTIN) on record, so GST cannot decide between CGST+SGST and IGST. Add the state on the customer (Customers → % → Edit); the next billing run will issue it.',
      v_sub.customer_name, v_sub.customer_name
      using errcode = 'check_violation';
  elsif v_sell_st is null then
    raise exception
      'Cannot issue the instalment invoice: your own company has no state on record, so GST cannot decide between CGST+SGST and IGST. Set it in Settings → Company; the next billing run will issue it.'
      using errcode = 'check_violation';
  else
    v_inter := (v_cust_st <> v_sell_st);   -- both lpad-ed to 2 digits above
    v_rate  := v_b.tax_rate;
  end if;

  v_tax   := round(v_b.taxable_amount * v_rate / 100.0);
  v_gross := v_b.taxable_amount + v_tax;

  -- ── What has already been paid towards this subscription ──────────────────
  /* R-2044: one rule, public.instalment_credit — the sale quote's receipts PLUS what was paid
     on this subscription's part payment requests, less what earlier instalment invoices of it
     already absorbed. Before R-2044 only the sale quote's receipts counted. */
  v_received := 0;
  v_applied  := 0;
  v_credit := least(public.instalment_credit(v_b.subscription_id), v_gross);
  v_status := case when v_credit >= v_gross then 'paid' else 'pending' end::invoice_status;

  /* R-372: the fallback was 0, which made every termless instalment due on issue.
     30 matches generate_invoice. */
  if v_sub.quote_id is not null then
    select coalesce(q.payment_terms_days, 30) into v_terms
      from public.quotes q where q.id = v_sub.quote_id;
  end if;
  v_terms := coalesce(v_terms, 30);

  /* ONE line, qty 1, rate = the whole instalment. Not qty = seats with a per-seat
     rate: an instalment of ₹2,000 over 3 seats is ₹666.67 each, and a tax invoice
     whose qty × rate does not equal its amount is wrong on its face. The seat count
     and service period go in the description, where CGST Rule 46 wants them. */
  v_lines := jsonb_build_array(jsonb_build_object(
    'id',          'instalment-' || v_b.period_index::text,
    'name',        v_sub.plan,
    'description', coalesce(v_sub.seats, 0)::text || ' seats · '
                   || to_char(v_b.period_start, 'DD Mon YYYY') || ' to '
                   || to_char(v_b.period_end,   'DD Mon YYYY'),
    'qty',         1,
    'rate',        v_b.taxable_amount,
    'cost',        0
  ));

  v_id := public.next_document_number('invoice', v_b.tenant_id, public.ist_today());
  if v_id is null then
    raise exception 'Could not allocate an invoice number for instalment %', p_billing_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date,
    /* quote_id STAYS NULL — build-props.ts:69-71 prefers the quote for every amount
       it prints, so linking a ₹2,360 instalment to its ₹28,320 quote would print
       ₹28,320 on it. The link lives on subscription_billings. */
    quote_id,
    net_payable, paid_amount, taxable_value, tax_amount, tax_rate, inter_state,
    line_items
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name, v_gross, v_status,
    v_today, v_today + v_terms,
    case when v_status = 'paid' then v_today else null end,
    null,
    /* R-1561: net_payable = the FULL instalment; the money already received is recorded
       ONCE, in paid_amount. Every reader computes due = net_payable − paid_amount, so the
       old `greatest(0, v_gross - v_credit)` here subtracted the credit a second time
       (₹2,360 with ₹1,000 received showed ₹360 due, not ₹1,360). paid_amount must stay
       = credit: v_applied above sums it to stop one receipt paying every instalment. */
    v_gross, v_credit,
    v_b.taxable_amount, v_tax, v_rate, v_inter,
    v_lines
  );

  update public.subscription_billings
     set invoice_id = v_id, updated_at = now()
   where id = p_billing_id;

  return query select v_id, v_gross, false;
end;
$function$;

revoke all on function public.raise_subscription_billing(uuid) from public;
grant execute on function public.raise_subscription_billing(uuid) to authenticated, service_role;

-- ── 4. What the billing cron does with a part whose date has come ───────────────────────
create or replace function public.bill_subscription_instalment(p_billing_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: invoice it (paid / sale quote's first part) or make its payment request — once. */
declare
  v_trusted  boolean;
  v_caller   uuid;
  v_b        record;
  v_sub      record;
  v_q        record;
  v_has_q    boolean := false;
  v_first    boolean;
  v_rate     integer;
  v_tax      integer;
  v_gross    integer;
  v_country  text;
  v_req_paid boolean := false;
  v_raised   record;
  v_id       text;
  v_period   text;
  v_on_due   boolean := false;
  v_label    text;
  v_cycle    text;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can bill its part'
      using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can bill a subscription part' using errcode = '42501';
  end if;

  if coalesce(p_dry_run, false) then
    select b.* into v_b from public.subscription_billings b where b.id = p_billing_id;
  else
    select b.* into v_b from public.subscription_billings b where b.id = p_billing_id for update;
  end if;
  if not found then
    raise exception 'Billing part % not found', p_billing_id using errcode = 'no_data_found';
  end if;
  if v_caller is not null and v_b.tenant_id is distinct from v_caller then
    raise exception 'Billing part % is not in the caller''s company', p_billing_id using errcode = 'insufficient_privilege';
  end if;

  if v_b.invoice_id is not null then
    return jsonb_build_object('action', 'already_invoiced', 'invoice_id', v_b.invoice_id);
  end if;

  select s.id, s.tenant_id, s.quote_id, s.customer_id, s.customer_name, s.plan, s.seats, s.domain,
         s.billing_cycle::text as cycle
    into v_sub from public.subscriptions s where s.id = v_b.subscription_id;
  if not found then
    raise exception 'Subscription behind billing part % no longer exists', p_billing_id using errcode = 'no_data_found';
  end if;

  /* The part's gross, the same figure raise_subscription_billing will invoice: export → 0%. */
  select c.country, coalesce(c.invoice_parts_on_due_date, false) into v_country, v_on_due
    from public.customers c where c.id = v_sub.customer_id;
  v_rate := case when v_country is not null
                  and lower(btrim(v_country)) not in ('', 'in', 'ind', 'india', 'bharat') then 0
                 else v_b.tax_rate end;
  v_tax   := round(v_b.taxable_amount * v_rate / 100.0);
  v_gross := v_b.taxable_amount + v_tax;

  select q.id, q.amount, q.status::text as status, q.invoice_id into v_q
    from public.quotes q where q.subscription_billing_id = v_b.id;
  v_has_q := found;
  if v_has_q then
    v_req_paid := coalesce((select sum(p.amount) from public.payments p
                             where p.quote_id = v_q.id and p.status = 'received'), 0) >= coalesce(v_q.amount, 0);
  end if;

  /* The sale quote IS the payment request of the first part of the first term (R-527: paid at
     the sale, invoiced at once). */
  v_first := v_sub.quote_id is not null
             and v_b.period_index = 1
             and v_b.term_start = (select min(b2.term_start) from public.subscription_billings b2
                                    where b2.subscription_id = v_b.subscription_id);

  /* v_on_due: the customer's "Invoice on due date" switch — the old path, a tax invoice on the
     bill date even if unpaid (chased by invoice-dunning). */
  if v_first or v_req_paid or v_on_due or public.instalment_credit(v_b.subscription_id) >= v_gross then
    if coalesce(p_dry_run, false) then
      return jsonb_build_object('action', 'invoice', 'gross', v_gross, 'dry_run', true,
        'reason', case when v_first then 'first_part_of_sale' when v_req_paid then 'request_paid'
                       when v_on_due then 'invoice_on_due_date' else 'already_paid' end);
    end if;
    select r.* into v_raised from public.raise_subscription_billing(v_b.id) r;
    if v_has_q and v_q.invoice_id is null then
      update public.quotes
         set invoice_id = case when v_req_paid then v_raised.invoice_id else invoice_id end,
             status = case when v_req_paid then status else 'expired'::public.quote_status end,
             notes = case when v_req_paid then notes
                          else concat_ws(E'\n', nullif(notes, ''),
                                 case when v_on_due
                                      then 'Closed: the customer is invoiced on the due date — tax invoice ' || v_raised.invoice_id || '.'
                                      else 'Closed: this part was already paid another way — tax invoice ' || v_raised.invoice_id || '.' end) end
       where id = v_q.id;
    end if;
    return jsonb_build_object('action', 'invoice', 'invoice_id', v_raised.invoice_id,
      'gross', v_raised.gross, 'already_raised', v_raised.already_raised);
  end if;

  if v_has_q then
    return jsonb_build_object('action', 'request_open', 'quote_id', v_q.id, 'status', v_q.status, 'gross', v_gross);
  end if;
  if coalesce(p_dry_run, false) then
    return jsonb_build_object('action', 'request', 'gross', v_gross, 'dry_run', true);
  end if;

  v_id := public.next_document_number('quote', v_b.tenant_id);
  if v_id is null then
    raise exception 'No quote number could be issued for the payment request of billing part %. Check Settings → Document numbering.', p_billing_id;
  end if;
  /* "Advance payment for Q2 · 28 Jan–27 Apr 2027" — period_end is exclusive (schedule.ts). */
  v_period := to_char(v_b.period_start, 'FMDD Mon') || '–' || to_char(v_b.period_end - 1, 'FMDD Mon YYYY');
  v_label := 'Advance payment for '
             || case v_sub.cycle when 'quarterly' then 'Q' || v_b.period_index::text
                                 when 'half_yearly' then 'H' || v_b.period_index::text
                                 else 'month ' || v_b.period_index::text end
             || ' · ' || v_period;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    domain, created_date, expires_date, line_items, subtotal, total_cost, discount_pct, tax_rate,
    is_one_off, billing_cycle, payment_terms_days, notes, subscription_billing_id
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name, v_sub.plan, v_sub.seats,
    v_gross, 'sent', 'awaiting',
    /* Prepaid: sent on the bill date (the period's first day) and due that day. No expiry — it
       stays open until it is paid or "Customer stopped". */
    v_sub.domain, public.ist_today(), null,
    jsonb_build_array(jsonb_build_object(
      'id',          'part-' || v_b.period_index::text,
      'name',        v_label,
      'description', coalesce(v_sub.plan, 'Subscription') || ' · ' || coalesce(v_sub.seats, 0)::text || ' seats',
      'qty',         1,
      'rate',        v_b.taxable_amount,
      'cost',        0,
      'one_time',    true)),
    v_b.taxable_amount, 0, 0, v_rate,
    true, 'yearly', 0,
    v_label || '. Due on ' || to_char(v_b.bill_on, 'FMDD Mon YYYY') || '. The tax invoice is issued when this is paid.',
    v_b.id
  );
  return jsonb_build_object('action', 'request', 'quote_id', v_id, 'created', true, 'gross', v_gross, 'label', v_label);
end;
$$;
revoke all on function public.bill_subscription_instalment(uuid, boolean) from public, anon;
grant execute on function public.bill_subscription_instalment(uuid, boolean) to authenticated, service_role;

-- ── 5. A receipt that completes a part request raises that part's tax invoice ───────────
create or replace function public.tg_payments_part_request_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2044 */
declare
  v_q   record;
  v_res jsonb;
begin
  if new.status is distinct from 'received' or new.quote_id is null then
    return new;
  end if;
  select q.id, q.amount, q.invoice_id, q.subscription_billing_id, b.subscription_id
    into v_q
    from public.quotes q
    join public.subscription_billings b on b.id = q.subscription_billing_id
   where q.id = new.quote_id;
  if not found or v_q.invoice_id is not null then
    return new;
  end if;
  if coalesce((select sum(p.amount) from public.payments p
                where p.quote_id = v_q.id and p.status = 'received'), 0) < coalesce(v_q.amount, 0) then
    return new;   -- part paid in part: no invoice yet
  end if;
  begin
    v_res := public.bill_subscription_instalment(v_q.subscription_billing_id, false);
  exception when others then
    /* The money stays recorded; the next billing run raises the invoice once the reason is fixed. */
    raise warning 'R-2044: payment request % is paid but its tax invoice was not raised now: %', v_q.id, sqlerrm;
    return new;
  end;
  /* The billing cron paused this subscription for this unpaid request → on again. */
  update public.subscriptions s
     set status = 'active'
   where s.id = v_q.subscription_id
     and s.status = 'paused'
     and s.suspended_by = 'automation'
     and s.suspended_invoice_id is null
     and s.suspend_reason like '%' || v_q.id || '%';
  return new;
end;
$$;
revoke all on function public.tg_payments_part_request_invoice() from public, anon;

drop trigger if exists trg_payments_part_request_invoice on public.payments;
create trigger trg_payments_part_request_invoice
  after insert or update of status on public.payments
  for each row execute function public.tg_payments_part_request_invoice();

-- ── 6. No whole invoice from a part request ─────────────────────────────────────────────
create or replace function public.reject_full_term_invoice_when_split_billed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cycle text;
begin
  /* An instalment invoice has no quote behind it — nothing to collide with. */
  if new.quote_id is null then
    return new;
  end if;

  /* R-2044: a part's payment request — its tax invoice is that part's instalment invoice. */
  if exists (select 1 from public.quotes q where q.id = new.quote_id and q.subscription_billing_id is not null) then
    raise exception
      'Quote % is the payment request for one part of a subscription billed in parts. Its tax invoice is issued automatically when it is paid — record the payment on it.',
      new.quote_id
      using errcode = 'check_violation';
  end if;

  select s.billing_cycle::text into v_cycle
    from public.subscriptions s
   where s.quote_id = new.quote_id
     and s.billing_cycle is distinct from 'yearly'::billing_cycle
   limit 1;

  if v_cycle is not null then
    raise exception
      'This subscription is billed %, so it is invoiced one period at a time — not once for the whole term. Each period is invoiced automatically on its own date; open the subscription to see the billing schedule.',
      replace(v_cycle, '_', '-')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

-- ── 7. Bank reconcile — body of 20261024131600 (R-1838), part request excluded ─────────
create or replace function public.reconcile_bank_credit_to_item(
  p_txn_id              uuid,
  p_quote_id            text    default null,
  p_invoice_id          text    default null,
  p_tds_amount          integer default 0,
  p_tds_rate_pct        numeric default null,
  p_tds_section         text    default null,
  p_create_subscription boolean default null,
  p_sub_start           date    default null,
  p_sub_renewal         date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     uuid;
  v_trusted    boolean;
  v_txn        record;
  v_inv        record;
  v_quote      record;
  v_quote_id   text;
  v_kind       text;
  v_sub_id     uuid;
  v_new_sale   boolean := false;
  v_skip_sub   boolean := false;
  v_ref        text;
  v_res        jsonb;
  v_pay_id     uuid;
  v_replay     boolean;
  v_tds        integer := greatest(0, coalesce(p_tds_amount, 0));
  v_gross      integer;
  v_inv_issued text := null;
  v_inv_now    text;
  v_subs       jsonb := '[]'::jsonb;
  v_lines      jsonb;
  v_inv_taxable integer := null;
  v_note       text;
begin
  /* §17c fail-closed + R-718 money roles. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;
  if (p_quote_id is null) = (p_invoice_id is null) then
    raise exception 'Pick one quote or one invoice this money is for.' using errcode = '22023';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay a quote or invoice.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  /* What the money is for. */
  if p_invoice_id is not null then
    select i.id, i.tenant_id, i.quote_id, i.taxable_value, i.status into v_inv
      from public.invoices i where i.id = p_invoice_id;
    if not found or v_inv.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Invoice % not found in your company', p_invoice_id using errcode = 'no_data_found';
    end if;
    if v_inv.status not in ('pending', 'overdue') then
      raise exception 'Invoice % is %, so there is nothing left to pay on it.', p_invoice_id, v_inv.status using errcode = 'check_violation';
    end if;
    v_quote_id := v_inv.quote_id;
    v_inv_taxable := nullif(v_inv.taxable_value, 0);
    if v_quote_id is null then
      select b.subscription_id into v_sub_id from public.subscription_billings b
       where b.tenant_id = v_txn.tenant_id and b.invoice_id = p_invoice_id limit 1;
      if v_sub_id is null then
        raise exception 'Invoice % has no quote or subscription behind it — record its payment from the invoice page.', p_invoice_id
          using errcode = 'check_violation';
      end if;
      v_kind := 'instalment';
    end if;
  else
    v_quote_id := p_quote_id;
  end if;

  if v_quote_id is not null then
    select q.* into v_quote from public.quotes q where q.id = v_quote_id for update;
    if not found or v_quote.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Quote % not found in your company', v_quote_id using errcode = 'no_data_found';
    end if;
    v_sub_id := coalesce(
      (select s.id from public.subscriptions s where s.tenant_id = v_quote.tenant_id and s.renewal_quote_id = v_quote.id limit 1),
      v_quote.renewal_subscription_id, v_quote.add_seats_subscription_id);
    v_kind := case
                when v_quote.is_add_seats then 'add_seats'
                when v_sub_id is not null or v_quote.is_renewal or v_quote.is_extension then 'renewal'
                when v_quote.is_one_off then 'one_off'
                else 'new' end;
    v_gross := coalesce(v_inv_taxable, nullif(v_quote.subtotal, 0), round(coalesce(v_quote.amount, 0) * 100.0 / (100 + coalesce(v_quote.tax_rate, 18)))::int);

    /* A new subscription sale that has filed nothing yet: the operator's subscription choice. */
    v_new_sale := v_kind = 'new'
      and not exists (select 1 from public.subscriptions s where s.tenant_id = v_quote.tenant_id and s.quote_id = v_quote.id)
      and not exists (select 1 from public.payments p where p.quote_id = v_quote.id and p.status = 'received')
      and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
                   where jsonb_typeof(li) = 'object' and public.quote_line_is_subscription(li, v_quote.tenant_id, false));
    if v_new_sale and p_create_subscription is false then
      /* record_payment's own 0157 guard: a one-off quote files no subscription. */
      update public.quotes set is_one_off = true where id = v_quote.id;
      v_skip_sub := true;
    elsif v_new_sale and (p_sub_start is not null or p_sub_renewal is not null) then
      if p_sub_start is not null and p_sub_renewal is not null and p_sub_renewal <= p_sub_start then
        raise exception 'The renewal date (%) must be after the start date (%).', p_sub_renewal, p_sub_start using errcode = '22023';
      end if;
      select jsonb_agg(
               case when jsonb_typeof(li) = 'object' and public.quote_line_is_subscription(li, v_quote.tenant_id, false)
                    then li
                         || case when p_sub_start   is not null then jsonb_build_object('start_date',   p_sub_start::text)   else '{}'::jsonb end
                         || case when p_sub_renewal is not null then jsonb_build_object('renewal_date', p_sub_renewal::text) else '{}'::jsonb end
                    else li end
               order by ord)
        into v_lines
        from jsonb_array_elements(v_quote.line_items) with ordinality as t(li, ord);
      update public.quotes set line_items = v_lines where id = v_quote.id;
    end if;
  else
    v_gross := coalesce(v_inv_taxable, 0);
  end if;

  /* The line's UTR is the payment reference (record_payment replays on quote + reference). */
  v_ref := coalesce(nullif(btrim(v_txn.reference), ''), 'BANK-' || v_txn.id::text);
  /* NOT 'Reconciled from bank receipt': that note marks a throw-away one-off sale which
     unreconcile_bank_receipt may delete ("undo the sale"). A renewal / add-seats / subscription
     payment must never be deleted from the bank page — un-reconciling only frees the line. */
  v_note := 'Bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' matched to ' || coalesce(p_invoice_id, v_quote_id);

  if v_kind = 'instalment' then
    v_res := public.record_instalment_payment(
      p_invoice_id, v_txn.credit + v_tds, 'bank_transfer', v_ref, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then v_txn.credit else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, case when v_tds > 0 then p_tds_rate_pct end,
      null, case when v_tds > 0 then public.indian_fiscal_year(v_txn.txn_date) end);
  else
    v_res := public.record_desk_payment(
      v_quote_id, v_txn.credit + v_tds, 'bank_transfer', v_ref, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then v_txn.credit else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, case when v_tds > 0 then p_tds_rate_pct end,
      null, p_invoice_id, case when v_tds > 0 then public.indian_fiscal_year(v_txn.txn_date) end);
  end if;

  v_pay_id := nullif(v_res->>'payment_id', '')::uuid;
  if v_pay_id is null then
    raise exception 'The payment was not recorded.' using errcode = 'P0001';
  end if;
  v_replay := coalesce((v_res->>'already_recorded')::boolean, false)
           or coalesce((v_res->>'idempotent_replay')::boolean, false);
  /* Already recorded by hand with this UTR: reconcile this line to THAT payment, never a second
     one — unless another bank line already carries it. */
  if v_replay and exists (select 1 from public.bank_transactions t
                           where t.tenant_id = v_txn.tenant_id and t.id <> v_txn.id
                             and t.matched_to_type = 'payment' and t.matched_to_id = v_pay_id::text) then
    raise exception 'A payment with reference % is already recorded on % and reconciled to another bank line. Nothing was changed.', v_ref, v_quote_id
      using errcode = 'unique_violation';
  end if;

  /* Invoice once fully paid, when the quote has none (record_payment never issues one). */
  if v_quote_id is not null and not v_replay then
    select q.invoice_id into v_inv_now from public.quotes q where q.id = v_quote_id;
    if v_inv_now is null
       and coalesce((v_res->>'is_fully_paid')::boolean, false)
       and not exists (select 1 from public.subscriptions s
                        where s.tenant_id = v_txn.tenant_id and s.quote_id = v_quote_id
                          and s.billing_cycle is distinct from 'yearly'::public.billing_cycle)
       /* R-2044: a part payment request is never invoiced whole — its part's tax invoice is
          raised by tg_payments_part_quote_invoice when it is paid (raise_subscription_billing). */
       and not exists (select 1 from public.quotes pq
                        where pq.id = v_quote_id and pq.subscription_billing_id is not null) then
      select gi.invoice_id into v_inv_issued from public.generate_invoice(v_quote_id) gi;
      /* R-015's rule (record_desk_payment): a settled invoice is paid on the RECEIPT date. */
      update public.invoices set paid_date = v_txn.txn_date
       where id = v_inv_issued and tenant_id = v_txn.tenant_id and status = 'paid';
    end if;
  end if;

  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_pay_id::text, 'manual');

  /* What happened, for the result panel. */
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'plan', s.plan, 'seats', s.seats, 'start_date', s.start_date,
           'renewal_date', s.renewal_date, 'billing_cycle', s.billing_cycle) order by s.created_at), '[]'::jsonb)
    into v_subs
    from public.subscriptions s
   where s.tenant_id = v_txn.tenant_id
     and (s.id = v_sub_id or (v_kind in ('new', 'one_off') and v_quote_id is not null and s.quote_id = v_quote_id));

  return jsonb_build_object(
    'kind',                 v_kind,
    'quote_id',             v_quote_id,
    'invoice_id',           coalesce(p_invoice_id, v_inv_issued, (select q.invoice_id from public.quotes q where q.id = v_quote_id)),
    'invoice_issued',       v_inv_issued,
    'payment_id',           v_pay_id,
    'receipt_voucher_no',   v_res->>'receipt_voucher_no',
    'amount',               v_txn.credit,
    'tds_amount',           v_tds,
    'outstanding',          coalesce((v_res->>'outstanding')::int, 0),
    'is_fully_paid',        coalesce((v_res->>'is_fully_paid')::boolean, false),
    'overpaid_credit',      coalesce((v_res->>'overpaid_credit')::int, 0),
    'renewal_rolled_forward', coalesce((v_res->>'renewal_rolled_forward')::boolean, false),
    'subscription_skipped', v_skip_sub,
    'already_recorded',     v_replay,
    'subscriptions',        v_subs
  );
end;
$$;

revoke all on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) from public, anon;
grant execute on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) to authenticated, service_role;

-- ── 8. A sale quote's subscription owes only the parts before its first payment request ──
create or replace function public.split_outstanding_for(p_quote_id text, p_term_start date)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_due      integer;
  v_received integer;
  v_as_of    date := public.ist_today();
  v_req_from date;
begin
  if p_quote_id is null then return null; end if;
  if exists (select 1 from public.quotes q where q.id = p_quote_id and q.invoice_id is not null)
     or exists (select 1 from public.invoices i where i.quote_id = p_quote_id and i.status <> 'void') then
    return null;
  end if;
  /* R-2044: from the first part that has its own payment request, each part is owed on that
     request — and an unpaid request is not a receivable. */
  select min(b.bill_on) into v_req_from
    from public.subscription_billings b
    join public.subscriptions s on s.id = b.subscription_id
    join public.quotes q on q.subscription_billing_id = b.id
   where s.quote_id = p_quote_id;
  if v_req_from is not null then
    v_as_of := least(v_as_of, v_req_from - 1);
  end if;
  v_due := public.quote_split_due(p_quote_id, coalesce(p_term_start, public.ist_today()), v_as_of);
  if v_due is null then return null; end if;
  select coalesce(sum(p.amount), 0) into v_received
    from public.payments p where p.quote_id = p_quote_id and p.status = 'received';
  return greatest(0, v_due - v_received);
end;
$$;
revoke all on function public.split_outstanding_for(text, date) from public, anon, authenticated;
grant execute on function public.split_outstanding_for(text, date) to service_role;

-- ── 9. "Customer stopped" ───────────────────────────────────────────────────────────────
create or replace function public.stop_part_payment_request(p_quote_id text, p_end text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: close an unpaid part request; cancel or pause its subscription. Nothing invoiced. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note    text;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can stop a subscription — it takes it out of MRR and renewals.'
      using errcode = '42501';
  end if;
  if p_end is null or p_end not in ('cancel', 'pause') then
    raise exception 'Choose what happens to the subscription: cancel or pause.' using errcode = '22023';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'Write why the customer stopped (at least 5 characters) — it is kept on the record.' using errcode = '22023';
  end if;

  select q.id, q.tenant_id, q.status::text as status, q.invoice_id, q.amount,
         b.subscription_id, b.period_index, b.invoice_id as part_invoice_id, s.status::text as sub_status
    into v_q
    from public.quotes q
    join public.subscription_billings b on b.id = q.subscription_billing_id
    join public.subscriptions s on s.id = b.subscription_id
   where q.id = p_quote_id
   for update of q;
  if not found then
    raise exception 'Quote % is not a payment request for a part of a subscription.', p_quote_id using errcode = '22023';
  end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in your company.', p_quote_id using errcode = '42501';
  end if;
  if v_q.invoice_id is not null or v_q.part_invoice_id is not null then
    raise exception 'This part already has its tax invoice, so it cannot be stopped here. Use a credit note on the invoice instead.'
      using errcode = '22023';
  end if;
  if exists (select 1 from public.payments p where p.quote_id = v_q.id and p.status = 'received') then
    raise exception 'Money was already received on %, so it cannot be marked as stopped. Record the rest, or refund the payment first.', v_q.id
      using errcode = '22023';
  end if;
  if v_q.status in ('rejected', 'expired') then
    raise exception 'Quote % is already closed.', v_q.id using errcode = '22023';
  end if;

  v_note := 'Customer stopped — ' || v_reason;
  update public.quotes
     set status = 'rejected',
         notes = concat_ws(E'\n', nullif(notes, ''), v_note || ' (' || to_char(public.ist_today(), 'DD Mon YYYY') || ').')
   where id = v_q.id;

  if p_end = 'cancel' and v_q.sub_status <> 'cancelled' then
    perform public.cancel_subscription(v_q.subscription_id, public.ist_today(),
      v_note || ' (payment request ' || v_q.id || ' cancelled)', false);
  elsif p_end = 'pause' and v_q.sub_status = 'active' then
    perform public.suspend_subscription(v_q.subscription_id,
      v_note || ' (payment request ' || v_q.id || ' cancelled)', false);
  end if;

  return jsonb_build_object('quote_id', v_q.id, 'subscription_id', v_q.subscription_id, 'end', p_end,
    'subscription_status', (select s.status::text from public.subscriptions s where s.id = v_q.subscription_id));
end;
$$;
revoke all on function public.stop_part_payment_request(text, text, text) from public, anon;
grant execute on function public.stop_part_payment_request(text, text, text) to authenticated, service_role;

commit;
