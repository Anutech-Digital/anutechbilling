-- deploy-peek: to_regprocedure('public.file_invoiced_quote_subscriptions(text,integer)') is not null and to_regprocedure('public.quote_open_balance(text)') is not null
-- deploy-key: r1686invoicenowsubs
-- 20261019162652_r1686_invoice_now_files_subscriptions.sql
--
-- R-1686 (P1 money, 19 Oct 2026) — "Invoice now (before payment)" on an annual quote raised the
-- GST invoice but NO subscription, so the unpaid invoice was in no dues list.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Localhost release check (ee0d066d): Q-F588-27-0019 / -0020 (annual, accepted, unpaid) →
--   "Invoice now (before payment)" → generate_invoice issued INV-F588-27-0003, marked the quote
--   'invoiced', and filed nothing. Subscriptions were only ever filed by record_payment (money in)
--   or activate_quote_on_credit (pay later). So:
--     · Payments → Subscription dues reads subscriptions.outstanding_amount > 0 — no subscription,
--       no row; the unpaid ₹38,232 was chased by nobody;
--     · the quote page called it "paid but has no subscription" (orphan-quote.ts read 'invoiced'
--       as paid — fixed there);
--     · "Re-create subscription from quote" wrote outstanding_amount 0 although the invoice was
--       unpaid (fixed in the route, using quote_open_balance below).
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   file_invoiced_quote_subscriptions(quote, outstanding): files the quote's subscriptions with
--   activate_quote_on_credit's / record_payment's line rules (same vendor, MRR, term, domain,
--   R-829 domain rule, R-378 cost, draft PO) — status ACTIVE, the same as pay later: the GST
--   invoice says the service is supplied, and R-116's overdue pause (which only looks at active
--   subscriptions with an overdue invoice) is what acts on non-payment. The first subscription
--   carries the unpaid invoice balance, exactly as activate_quote_on_credit does, so it shows in
--   Payments → Subscription dues. When the money arrives record_payment sees the quote's
--   subscriptions exist (R-346) and only brings that outstanding down — no second set.
--   Files NOTHING (returns 0) when: a subscription for this quote already exists (paid first,
--   activated on credit, rebuilt), the quote is not accepted, one-off, add-seats, a renewal /
--   extension, split-billed (R-370: the instalments are the bills), has no customer, or is on a
--   running trial. One-time lines (commitment 'one_time', R-1668) never become a subscription.
--   Internal: called only by generate_invoice (no grant to app roles).
--
--   generate_invoice calls it after the invoice is written, except when nested inside
--   activate_quote_on_credit (which files its own, with tasks) or create_direct_invoice
--   (its recurring option is filed on payment, unchanged).
--
--   quote_open_balance(quote): what is still owed on a quote — the unpaid balance of its
--   pending/overdue invoices when it has any non-void invoice, else amount − money received.
--   The rebuild route ("Re-create subscription from quote") uses it.
--
-- Test: supabase/tests/r1686_invoice_now_files_subscription.test.sql

begin;

-- ── quote_open_balance ──────────────────────────────────────────────────────
create or replace function public.quote_open_balance(p_quote_id text)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q        record;
  v_caller   uuid;
  v_trusted  boolean;
  v_received integer;
begin
  /* R-454 / §17c: fail closed for a login with no company. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '28000';
  end if;

  select q.id, q.tenant_id, q.amount into v_q from public.quotes q where q.id = p_quote_id;
  if not found then return null; end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.invoices i
              where i.tenant_id = v_q.tenant_id and i.quote_id = p_quote_id and i.status <> 'void') then
    -- Same sum as activate_quote_on_credit's credit exposure and lib/credit owedOnInvoices.
    return (select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))), 0)::int
              from public.invoices i
             where i.tenant_id = v_q.tenant_id and i.quote_id = p_quote_id
               and i.status in ('pending', 'overdue'));
  end if;

  select coalesce(sum(p.amount), 0) into v_received
    from public.payments p
   where p.tenant_id = v_q.tenant_id and p.quote_id = p_quote_id and p.status = 'received';
  return greatest(0, coalesce(v_q.amount, 0) - v_received)::int;
end;
$$;

revoke all on function public.quote_open_balance(text) from public, anon;
grant execute on function public.quote_open_balance(text) to authenticated, service_role;

-- ── file_invoiced_quote_subscriptions ───────────────────────────────────────
create or replace function public.file_invoiced_quote_subscriptions(p_quote_id text, p_outstanding integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote            record;
  v_cust             record;
  v_tenant_id        uuid;
  v_customer_id      uuid;
  v_expected         integer;
  v_outstanding      integer := greatest(0, coalesce(p_outstanding, 0));
  v_domain           text;
  v_subs_created     integer := 0;
  v_line_idx         integer;
  v_first_line       jsonb;
  v_commitment       text;
  v_plan_name        text;
  v_plan_lower       text;
  v_is_annual        boolean;
  v_is_monthly       boolean;
  v_vendor           public.vendor;
  v_start            date;
  v_line_amount      integer;
  v_renew_amount     integer;
  v_bulk_total_seats integer;
  v_bulk_pool        integer;
  v_running_mrr      integer;
  v_idx              integer;
  v_n                integer;
  v_d                jsonb;
  v_dom              text;
  v_dom_seats        integer;
  v_dom_mrr          integer;
  v_seats            integer;
  v_sub_domain       text;
  v_used_domains     text[] := array[]::text[];
  v_own_domain       boolean;
  v_used_domain_plans text[] := array[]::text[];
  v_new_sub_id       uuid;
  v_po_sub_id        uuid;
  v_po_seats         integer;
  v_po_plan          text;
  v_po_vendor        public.vendor;
  v_unit_wholesale_pm integer;
  v_total_wholesale  integer;
  v_po_id            text;
  v_first_sub        boolean := true;
  v_cost_pm          integer;
begin
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id, q.status, q.amount,
         q.line_items, q.domain, q.is_add_seats, q.is_one_off, q.is_renewal, q.is_extension,
         q.renewal_subscription_id, q.billing_cycle
    into v_quote
    from public.quotes q
   where q.id = p_quote_id;
  if not found then return 0; end if;

  v_tenant_id   := v_quote.tenant_id;
  v_customer_id := v_quote.customer_id;
  v_expected    := coalesce(v_quote.amount, 0);

  if v_quote.status <> 'accepted' or v_customer_id is null then return 0; end if;
  if coalesce(v_quote.is_one_off, false) or coalesce(v_quote.is_add_seats, false)
     or coalesce(v_quote.is_renewal, false) or coalesce(v_quote.is_extension, false)
     or v_quote.renewal_subscription_id is not null then
    return 0;
  end if;
  -- R-370: split billing is invoiced period by period; never a whole-term filing here.
  if v_quote.billing_cycle is not null and v_quote.billing_cycle::text <> 'yearly' then return 0; end if;
  if jsonb_typeof(v_quote.line_items) is distinct from 'array' or jsonb_array_length(v_quote.line_items) = 0 then
    return 0;
  end if;
  -- Already filed (paid first, activated on credit, rebuilt) — or this quote renews one.
  if exists (select 1 from public.subscriptions s
              where s.tenant_id = v_tenant_id
                and (s.quote_id = p_quote_id or s.renewal_quote_id = p_quote_id)) then
    return 0;
  end if;
  -- A running trial converts on payment, as before.
  if v_quote.lead_id is not null and exists (
       select 1 from public.leads l
        where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id
          and l.trial_started_at is not null and l.trial_converted_at is null) then
    return 0;
  end if;

  select c.id, c.domain into v_cust
    from public.customers c where c.id = v_customer_id and c.tenant_id = v_tenant_id;
  if not found then return 0; end if;

  -- ── activate_quote_on_credit's loop (record_payment's rules), line by line ──
  v_domain := v_quote.domain;
  for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
    v_first_line := v_quote.line_items -> v_line_idx;
    v_commitment := nullif(btrim(coalesce(v_first_line->>'commitment', '')), '');
    v_plan_name  := coalesce(v_first_line->>'name',
                      case when v_commitment = 'monthly' then 'Monthly subscription'
                           else 'Annual subscription' end);
    -- R-1668: a one-time line is a one-off charge, never a subscription.
    v_is_monthly := v_commitment = 'monthly';
    v_is_annual  := v_commitment is not null and v_commitment not in ('monthly', 'one_time');
    v_po_sub_id  := null;
    continue when not (v_is_annual or v_is_monthly);

    v_vendor := null;
    if v_first_line->>'item_id' is not null then
      select i.vendor into v_vendor from public.items i
       where i.id = v_first_line->>'item_id' and i.tenant_id = v_tenant_id;
    end if;
    if v_vendor is null then
      v_plan_lower := lower(v_plan_name);
      v_vendor := case
        when v_plan_lower like '%google%'    then 'google'::public.vendor
        when v_plan_lower like '%m365%'      then 'microsoft'::public.vendor
        when v_plan_lower like '%microsoft%' then 'microsoft'::public.vendor
        when v_plan_lower like '%365%'       then 'microsoft'::public.vendor
        when v_plan_lower like '%zoho%'      then 'zoho'::public.vendor
        else 'other'::public.vendor end;
    end if;

    v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, public.ist_today());
    v_line_amount := round(
      coalesce((v_first_line->>'qty')::numeric, 0) * coalesce((v_first_line->>'rate')::numeric, 0)
        * (1 - coalesce((v_first_line->>'discount_pct')::numeric, 0) / 100)
    )::int;
    v_renew_amount := case
      when nullif(v_first_line->>'renewal_rate', '') is not null
        then round(coalesce((v_first_line->>'qty')::numeric, 0) * (v_first_line->>'renewal_rate')::numeric)::int
      else v_line_amount end;

    /* R-378: the line's cost per seat, as ₹/seat/MONTH (monthly line = as is, annual = /12). */
    v_cost_pm := case
      when jsonb_typeof(v_first_line->'cost') = 'number' and (v_first_line->>'cost')::numeric > 0
        then round((v_first_line->>'cost')::numeric / case when v_is_monthly then 1.0 else 12.0 end)::int
      else null end;

    if coalesce((v_first_line->>'bulk')::boolean, false)
       and jsonb_typeof(v_first_line->'domains') = 'array'
       and jsonb_array_length(v_first_line->'domains') > 0 then
      select coalesce(sum((e->>'seats')::int), 0) into v_bulk_total_seats
        from jsonb_array_elements(v_first_line->'domains') e;
      if v_bulk_total_seats <= 0 then
        raise exception 'bulk line has zero total seats (quote %)', p_quote_id;
      end if;
      v_bulk_pool := greatest(0, round(
                       coalesce(v_renew_amount, v_expected) / case when v_is_monthly then 1.0 else 12.0 end
                     ))::int;
      v_running_mrr := 0;
      v_idx := 0;
      v_n := jsonb_array_length(v_first_line->'domains');
      for v_d in select e from jsonb_array_elements(v_first_line->'domains') e loop
        v_idx := v_idx + 1;
        v_dom := lower(trim(v_d->>'domain'));
        v_dom_seats := coalesce((v_d->>'seats')::int, 0);
        if v_dom = '' then continue; end if;
        if v_idx < v_n then
          v_dom_mrr := floor(v_bulk_pool::numeric * v_dom_seats / v_bulk_total_seats)::int;
        else
          v_dom_mrr := v_bulk_pool - v_running_mrr;
        end if;
        v_running_mrr := v_running_mrr + v_dom_mrr;

        -- Bulk rows carry 0 outstanding, as in activate_quote_on_credit / record_payment.
        insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
          start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
          vendor_cost_per_seat_month)
        values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
          v_start,
          (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
          'active', 0, v_dom, p_quote_id,
          case when v_is_monthly then 1 else 12 end,
          v_cost_pm)
        on conflict (tenant_id, quote_id, lower(domain), lower(plan)) where quote_id is not null and domain is not null
          do nothing
        returning id into v_new_sub_id;
        if v_new_sub_id is not null then v_subs_created := v_subs_created + 1; end if;

        insert into public.customer_domains (tenant_id, customer_id, domain)
        values (v_tenant_id, v_customer_id, v_dom)
        on conflict (tenant_id, lower(domain)) do nothing;

        v_used_domains := array_append(v_used_domains, v_dom);
        v_used_domain_plans := array_append(v_used_domain_plans, v_dom || '|' || lower(v_plan_name));
      end loop;
      v_po_seats := v_bulk_total_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    else
      v_seats := coalesce((v_first_line->>'qty')::int, 0);
      v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
      v_own_domain := v_sub_domain is not null;
      if v_sub_domain is null then
        if v_domain is null then v_domain := v_cust.domain; end if;
        v_sub_domain := lower(nullif(trim(v_domain), ''));
      end if;
      -- R-829: own domain kept unless this plan already has it.
      if v_sub_domain is not null then
        if v_own_domain then
          if (v_sub_domain || '|' || lower(v_plan_name)) = any(v_used_domain_plans) then
            v_sub_domain := null;
          end if;
        elsif v_sub_domain = any(v_used_domains) then
          v_sub_domain := null;
        end if;
      end if;
      insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
        start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
        vendor_cost_per_seat_month)
      values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
        greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,
        (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
        -- The unpaid invoice balance rides on the first subscription (as activate_quote_on_credit
        -- and record_payment's part payment do) → Payments → Subscription dues.
        case when v_first_sub then v_outstanding else 0 end,
        v_sub_domain, p_quote_id,
        case when v_is_monthly then 1 else 12 end,
        v_cost_pm)
      returning id into v_new_sub_id;
      v_subs_created := v_subs_created + 1;
      v_first_sub := false;
      if v_sub_domain is not null then
        v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
        v_used_domain_plans := array_append(v_used_domain_plans, lower(v_sub_domain) || '|' || lower(v_plan_name));
      end if;
      v_po_seats := v_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    end if;

    -- Draft PO for the vendor seats, same as record_payment / activate_quote_on_credit.
    if v_po_sub_id is not null then
      select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
        into v_unit_wholesale_pm from public.items
       where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
      if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
        v_unit_wholesale_pm := greatest(0, round(coalesce(v_line_amount, v_expected)::numeric * 0.83 / greatest(v_po_seats * 12, 1)))::int;
      end if;
      v_total_wholesale := v_unit_wholesale_pm * v_po_seats * 12;
      v_po_id := public.next_document_number('purchase_order', v_tenant_id);
      insert into public.purchase_orders (
        id, tenant_id, subscription_id, customer_id, customer_name, domain,
        vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
      ) values (
        v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
        v_po_vendor, v_po_plan, v_po_seats, 12, v_unit_wholesale_pm, v_total_wholesale, 'draft',
        'Auto-created from quote ' || p_quote_id || ' (invoiced before payment)',
        auth.uid()
      );
    end if;
  end loop;

  return v_subs_created;
end;
$$;

revoke all on function public.file_invoiced_quote_subscriptions(text, integer) from public, anon, authenticated;
grant execute on function public.file_invoiced_quote_subscriptions(text, integer) to service_role;

-- ── generate_invoice: unchanged (body = 20261012025800_r885_money_roles_more.sql) except the
--    R-1686 block at the end, which files the subscriptions. ──
CREATE OR REPLACE FUNCTION public.generate_invoice(p_quote_id text)
 RETURNS TABLE(invoice_id text, net_payable integer, total_advances integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote     record;
  v_adv       jsonb;
  v_total     integer;
  v_first     timestamptz;
  v_id        text;
  v_gross     integer;
  v_net       integer;
  v_status    invoice_status;
  v_today     date := public.ist_today();
  v_taxable   integer;
  v_tax       integer;
  v_rate      integer;
  v_cust_st   text;
  v_sell_st   text;
  v_cust_country text;
  v_is_export boolean;
  v_inter     boolean;
  v_cust_gstin text;
  v_caller    uuid;
  v_trusted   boolean;
  v_r1686_ctx text;
begin
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
    raise exception 'No company on this login — only a user of the quote''s company can issue its invoice'
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
      raise exception 'Only an owner, manager, accountant or billing user can issue an invoice' using errcode = '42501';
    end if;
  end;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.amount,
         q.payment_method, q.payment_reference, q.invoice_id,
         q.subtotal, q.discount_pct, q.tax_rate, q.payment_terms_days
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;

  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  if v_caller is not null
     and v_quote.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_quote.invoice_id is not null then
    raise exception 'Invoice % already exists for quote %', v_quote.invoice_id, p_quote_id
      using errcode = 'unique_violation';
  end if;

  v_gross := coalesce(v_quote.amount, 0);
  if v_gross <= 0 then
    raise exception 'Quote % has no amount — cannot generate a zero-value tax invoice', p_quote_id
      using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_quote.tax_rate, 18);
  if v_quote.subtotal is not null then
    v_taxable := v_quote.subtotal - round(v_quote.subtotal * coalesce(v_quote.discount_pct, 0) / 100.0);
  else
    v_taxable := round(v_gross * 100.0 / (100 + v_rate));
  end if;
  v_tax := v_gross - v_taxable;

  select c.state_code, c.country, c.gstin into v_cust_st, v_cust_country, v_cust_gstin
    from public.customers c where c.id = v_quote.customer_id;

  /* R-373 (7 Oct 2026): a GSTIN's first two digits ARE the GST state code. A customer
     with a GSTIN but no state_code was refused below, although invoice_party_snapshot
     (R-043) already takes the place of supply from the same GSTIN prefix. Fall back to
     it only when state_code is blank and the GSTIN starts with two digits. */
  if nullif(btrim(coalesce(v_cust_st, '')), '') is null
     and btrim(coalesce(v_cust_gstin, '')) ~ '^[0-9]{2}' then
    v_cust_st := substring(btrim(v_cust_gstin) from 1 for 2);
  end if;
  select t.state_code into v_sell_st from public.tenants t where t.id = v_quote.tenant_id;

  /* ── R-041 (Pardeep, 30 Sep 2026): an unknown place of supply used to mean CGST+SGST ──
     This read `(v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st)`,
     so a NULL state_code on either side resolved to FALSE = intra-state = CGST+SGST. That
     is a missing fact turned into a confident tax head (AGENTS.md §2), and it is the
     expensive direction: an inter-state supply billed as CGST+SGST is tax paid to the wrong
     government, which GSTR-1 will not reconcile and which the customer cannot claim.
     23 of this tenant's customers have no state_code.

     EXPORT is the one case where no state is correct rather than missing: a recipient
     outside India has no Indian place of supply, and the supply is zero-rated under IGST
     Section 16 (LUT or with payment of tax). Those quotes already carry tax_rate 0, set by
     the same `isExportSupply` the app uses, so there is no split to get wrong.

     Everything else stops. §24: the message names the screen that fixes it. */
  v_is_export := v_cust_country is not null
                 and lower(btrim(v_cust_country)) not in ('', 'in', 'ind', 'india');

  if v_is_export then
    v_inter := false;   -- no Indian place of supply; the zero rate on the quote governs
  elsif v_cust_st is null or btrim(v_cust_st) = '' then
    raise exception
      'Cannot issue this invoice: % has no state on record, so GST cannot decide between CGST+SGST and IGST. Add the state on the customer (Customers → % → Edit), then issue the invoice.',
      v_quote.customer_name, v_quote.customer_name
      using errcode = 'check_violation';
  elsif v_sell_st is null or btrim(v_sell_st) = '' then
    raise exception
      'Cannot issue this invoice: your own company has no state on record, so GST cannot decide between CGST+SGST and IGST. Set it in Settings → Company, then issue the invoice.'
      using errcode = 'check_violation';
  else
    v_inter := (v_cust_st <> v_sell_st);
  end if;

  select a.advances, coalesce(a.total_paid, 0), a.first_at
    into v_adv, v_total, v_first
    from public.compute_advance_adjustment(p_quote_id) a;
  v_adv   := coalesce(v_adv, '[]'::jsonb);
  v_total := coalesce(v_total, 0);

  v_net    := greatest(0, v_gross - v_total);
  v_status := case when v_net = 0 then 'paid' else 'pending' end::invoice_status;

  v_id := public.next_document_number('invoice', v_quote.tenant_id, public.ist_today());
  if v_id is null then
    raise exception 'Could not allocate invoice number for quote %', p_quote_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date, razorpay_id,
    adjusted_advances, net_payable, first_advance_at, quote_id,
    taxable_value, tax_amount, tax_rate, inter_state
  ) values (
    v_id, v_quote.tenant_id, v_quote.customer_id, v_quote.customer_name, v_gross, v_status,
    -- THE ONE CHANGE: the fallback was 0, which made every termless invoice due on issue.
    v_today, v_today + coalesce(v_quote.payment_terms_days, 30), case when v_status = 'paid' then v_today else null end,
    case when v_quote.payment_method = 'razorpay' then v_quote.payment_reference else null end,
    v_adv, v_net, v_first, v_quote.id,
    v_taxable, v_tax, v_rate, v_inter
  );

  update public.quotes
     set payment_status = 'invoiced'::payment_status,
         invoice_id     = v_id
   where id = p_quote_id;

  /* R-1686: "Invoice now (before payment)" files the quote's subscriptions, with the unpaid
     balance as their dues. A no-op when they already exist (paid first) or the quote is not a
     new subscription sale — see file_invoiced_quote_subscriptions. Not when nested inside
     activate_quote_on_credit (it files its own, with tasks) or create_direct_invoice. */
  get diagnostics v_r1686_ctx = pg_context;
  if v_r1686_ctx !~ 'function (public\.)?(activate_quote_on_credit|create_direct_invoice)\(' then
    perform public.file_invoiced_quote_subscriptions(p_quote_id, v_net);
  end if;

  return query select v_id, v_net, v_total;
end;
$function$;

commit;
