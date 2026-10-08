-- deploy-key: renewrate
-- deploy-peek: exists(select 1 from pg_proc where proname='record_payment' and pronamespace='public'::regnamespace and prosrc like '%renewal_rate%')
-- R-329 (7 Oct 2026): a cart coupon is for the FIRST payment only; the subscription renews
-- at list price.
--
-- record_payment files each new subscription's mrr from its quote line's CHARGED amount
-- (qty x rate x (1 - line discount_pct)), and the renewals cron bills from that mrr. Since
-- R-225 (cc3b5b26) a cart with a paid domain next to hosting takes the coupon off the
-- hosting line's RATE (a quote-level discount_pct would also hit the domain), so the
-- hosting subscription was filed at the discounted price and every renewal was discounted
-- too. Before R-225 the coupon was a quote-level discount_pct, which record_payment never
-- applied to mrr — renewals were at list. That is Pardeep's decision, restored here.
--
-- The cart checkout now writes `renewal_rate` (= the list rate) on each line a coupon
-- discounted (lib/checkout/cart-coupon.ts). This version reads it:
--   mrr basis = qty x renewal_rate, when the line has one; otherwise exactly as before.
-- Only the mrr (single and bulk) changes. The payment, outstanding, invoice and the PO's
-- wholesale fallback still use what was charged. No other caller writes renewal_rate (the
-- quote builder's own discounts are meant to renew discounted, and keep doing so), so
-- every quote without it is filed exactly as before.
--
-- Body = 20261003130000_customer_match_needs_name.sql's record_payment, with the edits
-- marked "R-329". Safe in either order with the app deploy: without this migration the
-- line's renewal_rate is ignored (the R-225 behaviour); without the app change no line
-- carries it.
--
-- NOT APPLIED by the worker — manager applies (staging first). Test:
-- supabase/tests/record_payment_renewal_rate.test.sql

CREATE OR REPLACE FUNCTION public.record_payment(p_quote_id text, p_amount integer, p_method text, p_reference text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote                 record;
  v_tenant_id             uuid;
  v_caller_tenant         uuid;
  v_is_service_role       boolean;
  v_has_existing_invoice  boolean;
  v_receipt_voucher_no    text := null;
  v_payment_id            uuid;
  v_prior_received        integer;
  v_total_received        integer;
  v_expected              integer;
  v_outstanding           integer;
  v_overpaid_credit       integer := 0;
  v_is_first_payment      boolean;
  v_is_fully_paid         boolean;
  v_new_payment_status    public.payment_status;
  v_customer_id           uuid;
  v_converted_now         boolean := false;
  v_lead                  record;
  v_domain                text;
  v_subscription_created  boolean := false;
  v_new_sub_id            uuid;
  v_first_line            jsonb;
  v_commitment            text;
  v_is_annual             boolean;
  v_is_monthly            boolean;
  v_plan_name             text;
  v_plan_lower            text;
  v_vendor                public.vendor;
  v_seats                 integer;
  v_is_renewal_quote      boolean := false;
  v_renewal_sub           record;
  v_renewal_rolled_forward boolean := false;
  v_extension_months      integer;
  v_new_mrr               integer;
  v_invoice               record;
  v_already_adjusted      integer;
  v_post_invoice_received integer;
  v_net_due               integer;
  v_invoice_paid          boolean := false;
  v_po_id                 text := null;
  v_po_created            boolean := false;
  v_unit_wholesale_pm     integer;
  v_total_wholesale       integer;
  v_po_seats              integer;
  v_po_months             integer;
  v_po_plan               text;
  v_po_vendor             public.vendor;
  v_po_sub_id             uuid;
  v_was_trial             boolean := false;
  v_existing_payment      record;
  v_is_add_seats          boolean := false;
  v_has_bulk              boolean := false;
  v_bulk_total_seats      integer;
  v_bulk_pool             integer;
  v_running_mrr           integer;
  v_dom_mrr               integer;
  v_dom_seats             integer;
  v_dom                   text;
  v_idx                   integer;
  v_n                     integer;
  v_d                     jsonb;
  v_bulk_count            integer := 0;
  v_start                 date;
  -- 0172: multi-line-item support
  v_line_idx              integer;
  v_line_amount           integer;
  -- R-329: what the line's subscription renews at (qty x renewal_rate), else v_line_amount.
  v_renew_amount          integer;
  v_first_sub_in_quote    boolean := true;
  -- Only domain/Workspace-type products are meaningfully tied to a single
  -- domain; a quote mixing e.g. a support plan + a hosting plan has no
  -- per-line domain of its own, so both would otherwise fall back to the
  -- SAME customer domain and collide against
  -- subscriptions_tenant_quote_domain_unique (tenant_id, quote_id,
  -- lower(domain)). Track domains already used THIS call and null out any
  -- repeat instead of erroring or silently dropping the subscription.
  v_used_domains          text[] := array[]::text[];
  v_sub_domain            text;
begin
  v_is_service_role := auth.role() = 'service_role';
  if not v_is_service_role then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then
      raise exception 'No tenant context';
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'amount must be > 0'; end if;
  if p_method is null or p_method not in ('upi','razorpay','bank_transfer','cheque','cash','other')
    then raise exception 'invalid payment method: %', p_method; end if;
  if p_reference is null or length(trim(p_reference)) = 0 then raise exception 'reference required'; end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id,
         q.amount, q.line_items, q.invoice_id, q.payment_status,
         q.domain, q.extension_months, q.is_add_seats, q.subtotal, q.is_one_off,
         q.prospect_state_code, q.prospect_state, q.prospect_country
    into v_quote
    from public.quotes q
   where q.id = p_quote_id for update;
  if not found then raise exception 'quote % not found', p_quote_id; end if;
  if not v_is_service_role and v_quote.tenant_id <> v_caller_tenant then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;

  select p.id, p.receipt_voucher_no, p.customer_id
    into v_existing_payment
    from public.payments p
   where p.tenant_id = v_quote.tenant_id
     and p.quote_id  = p_quote_id
     and p.reference = p_reference
     and p.status    = 'received'
   limit 1;
  if found then
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_expected    := coalesce(v_quote.amount, 0);
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end if;

  v_tenant_id            := v_quote.tenant_id;
  v_has_existing_invoice := v_quote.invoice_id is not null;
  v_expected             := coalesce(v_quote.amount, 0);
  v_domain               := v_quote.domain;
  /* Default to the TERM of the subscription being renewed, not a hard 12. A monthly
     subscription renewed with a plain renewal quote was being pushed a YEAR forward, so
     it would never be chased again and its MRR would keep counting for twelve months of
     service nobody had sold. Falls back to 12 when there is no subscription in hand
     (a new sale), which is where the old constant was right. */
  /* Left deliberately NULL when the quote does not say. The term of the subscription
     being renewed is not known yet — v_renewal_sub is selected below — and reading an
     unassigned RECORD raises 55000 for every payment, renewal or not. Resolved right
     after that select. */
  v_extension_months     := v_quote.extension_months;
  v_is_add_seats         := coalesce(v_quote.is_add_seats, false);
  v_has_bulk := exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where coalesce((li->>'bulk')::boolean, false)
  );

  select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.renewal_state, s.vendor, s.customer_id, s.customer_name, s.domain as sub_domain, s.term_months
    into v_renewal_sub
    from public.subscriptions s
   where s.tenant_id = v_tenant_id
     and s.renewal_quote_id = p_quote_id
   for update limit 1;
  v_is_renewal_quote := found;

  /* Now the term IS known. Default to the term of the subscription being renewed rather
     than a hard 12: renewing a MONTHLY subscription used to push its renewal date twelve
     months out, so it was never chased again and its MRR counted for a year of service
     nobody had sold. Falls back to 12 for a new sale, where no subscription exists and the
     old constant was right. */
  if v_extension_months is null then
    v_extension_months := coalesce(case when v_is_renewal_quote then v_renewal_sub.term_months end, 12);
  end if;

  select coalesce(sum(amount), 0) into v_prior_received
    from public.payments where quote_id = p_quote_id and status = 'received';
  v_is_first_payment := (v_prior_received = 0);

  /* #27 (migrations 0060/0061), lost from this function and re-added 22 Aug 2026.
     A quote with no amount has nothing to pay. Without this, paying ₹5,000 against a
     ₹0 quote recorded the payment, marked the quote received, and created an mrr=0
     subscription — a live customer with a subscription worth nothing, which then
     enters the renewal cadence and is invoiced for ₹0.

     Placed AFTER the idempotency replay above, deliberately: a quote that WAS priced,
     was paid, and was later edited to 0 must still replay idempotently rather than
     start throwing at a webhook that already succeeded. Only a NEW payment is refused. */
  if coalesce(v_quote.amount, 0) <= 0 then
    raise exception 'Quote % has no amount, so a payment cannot be recorded against it. Set the quote total first, then record the payment.', p_quote_id;
  end if;

  v_customer_id := v_quote.customer_id;
  if v_is_first_payment and v_quote.lead_id is not null and v_quote.customer_id is null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes, l.domain, l.stage,
           l.state_code, l.state, l.gstin
      into v_lead from public.leads l
     where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if not found then raise exception 'lead % not found', v_quote.lead_id; end if;
    if v_domain is null then v_domain := v_lead.domain; end if;
    v_was_trial := (v_lead.stage = 'trial');

    /* Dedup (migrations 0064/0065), lost from this function and re-added 22 Aug 2026.
       The lead is a fresh row but the company may already be a customer — the same
       business enquiring a second time, or a renewal that came in as a new lead. This
       used to insert unconditionally, so that company got a SECOND customer row, and
       then a second subscription and a second invoice series against the same buyer.

       Matched on contact_email, case-insensitively and tenant-scoped. Email only:
       company NAME is not an identity ("Excel Tech" vs "Excel Technologies Pvt Ltd")
       and matching on it would merge two genuinely different customers, which is the
       worse error of the two — a wrongly-merged customer is far harder to unpick than
       a duplicate. No email on the lead means no match, and a new customer is created. */
    /* R-137 (3 Oct 2026): email alone merged different businesses that shared one
       inbox — every test quote on the owner's own address landed on one customer
       ("Sri Ganga Technologies": 64 quotes, Rs 3.9L of payments). Now: same GSTIN, or
       same email AND a matching name (match_existing_customer). The rule above still
       holds — when unsure, a duplicate is the lesser error. */
    v_customer_id := public.match_existing_customer(v_tenant_id, v_lead.contact_email, v_lead.gstin, v_lead.company);

    if v_customer_id is null then
      insert into public.customers (tenant_id, name, contact_name, contact_email, contact_phone, domain, since, health, notes, state_code, state, gstin)
      values (v_tenant_id, v_lead.company, v_lead.contact_name, v_lead.contact_email, v_lead.contact_phone, v_domain, current_date,
              case when p_amount >= v_expected then 85 else 75 end, v_lead.notes, v_lead.state_code, v_lead.state, v_lead.gstin)
      returning id into v_customer_id;
    else
      /* Reused. The quote must point at the customer that actually exists, or the
         invoice and the subscription below hang off a different row than the payment. */
      update public.quotes set customer_id = v_customer_id
       where id = p_quote_id and tenant_id = v_tenant_id;
    end if;

    update public.leads
       set stage              = 'won',
           trial_converted_at = case when v_was_trial then now() else trial_converted_at end
     where id = v_quote.lead_id and tenant_id = v_tenant_id;
    v_converted_now := true;
  elsif v_is_first_payment and v_quote.customer_id is null and v_quote.lead_id is null then
    insert into public.customers (tenant_id, name, domain, since, health, state_code, state, country)
    values (v_tenant_id, coalesce(nullif(trim(v_quote.customer_name), ''), 'Customer'),
            v_domain, current_date, case when p_amount >= v_expected then 85 else 75 end,
            v_quote.prospect_state_code, v_quote.prospect_state,
            coalesce(nullif(trim(v_quote.prospect_country), ''), 'India'))
    returning id into v_customer_id;
    v_converted_now := true;
  elsif v_quote.lead_id is not null then
    select l.stage into v_lead from public.leads l where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if v_is_first_payment then
      update public.leads
         set trial_converted_at = case when stage = 'won' and trial_started_at is not null and trial_converted_at is null then now() else trial_converted_at end
       where id = v_quote.lead_id and tenant_id = v_tenant_id;
    end if;
  end if;

  if not v_has_existing_invoice then
    v_receipt_voucher_no := public.next_document_number('receipt_voucher', v_tenant_id, public.ist_today());
  end if;

  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
      status, received_at, receipt_voucher_no, recorded_by)
    values (v_tenant_id, p_quote_id, v_customer_id, p_amount, p_method, p_reference,
            nullif(trim(coalesce(p_notes, '')), ''), 'received', now(), v_receipt_voucher_no, auth.uid())
    returning id into v_payment_id;
  exception when unique_violation then
    select p.id, p.receipt_voucher_no, p.customer_id into v_existing_payment
      from public.payments p
     where p.tenant_id = v_tenant_id and p.quote_id = p_quote_id
       and p.reference = p_reference and p.status = 'received' limit 1;
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end;

  v_total_received := v_prior_received + p_amount;
  v_outstanding    := greatest(0, v_expected - v_total_received);
  v_is_fully_paid  := v_total_received >= v_expected;
  v_new_payment_status := case
    when v_has_existing_invoice then 'invoiced'
    when v_is_fully_paid        then 'received'
    else                             'partial' end::public.payment_status;

  /* 0157: a ONE-OFF sale creates no subscription. Lost from this function and re-added
     22 Aug 2026 — and this is the costliest of the three, because it does not just
     record something wrong, it goes on to CHARGE for it. A direct invoice (is_one_off)
     is a single sale; the guard's absence gave it a recurring subscription, which the
     renewal cron then bills again on its next cycle. The customer is invoiced for a
     subscription nobody sold them. */
  if v_is_first_payment and not v_is_renewal_quote and not v_is_add_seats
     and not coalesce(v_quote.is_one_off, false) then
    if jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0 then
      for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
        v_first_line := v_quote.line_items -> v_line_idx;
        v_commitment := v_first_line->>'commitment';
        v_plan_name  := coalesce(v_first_line->>'name',
                          case when v_commitment = 'monthly' then 'Monthly subscription'
                               else 'Annual subscription' end);
        v_is_annual  := v_commitment is distinct from 'monthly' and v_commitment is not null;
        v_is_monthly := v_commitment = 'monthly';
        v_po_sub_id  := null;

        if (v_is_annual or v_is_monthly) and v_customer_id is not null then
          -- 0172: exact vendor via the catalog item itself; name-guess only
          -- for lines with no item_id (hand-typed, no catalog link).
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

          v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, current_date);
          v_line_amount := round(
            coalesce((v_first_line->>'qty')::numeric, 0) * coalesce((v_first_line->>'rate')::numeric, 0)
              * (1 - coalesce((v_first_line->>'discount_pct')::numeric, 0) / 100)
          )::int;
          /* R-329: a cart coupon discounts the first payment only. The line then says what it
             renews at; the subscription's mrr (and so every renewal) is filed from that. */
          v_renew_amount := case
            when nullif(v_first_line->>'renewal_rate', '') is not null
              then round(coalesce((v_first_line->>'qty')::numeric, 0) * (v_first_line->>'renewal_rate')::numeric)::int
            else v_line_amount end;

          if coalesce((v_first_line->>'bulk')::boolean, false)
             and jsonb_typeof(v_first_line->'domains') = 'array'
             and jsonb_array_length(v_first_line->'domains') > 0 then
            select coalesce(sum((e->>'seats')::int), 0) into v_bulk_total_seats
              from jsonb_array_elements(v_first_line->'domains') e;
            if v_bulk_total_seats <= 0 then
              raise exception 'bulk line has zero total seats (quote %)', p_quote_id;
            end if;
            v_bulk_pool := greatest(0, round(
                             coalesce(v_renew_amount, v_expected) / case when v_is_monthly then 1.0 else 12.0 end  -- R-329
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

              insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                start_date, renewal_date, status, outstanding_amount, domain, quote_id,
                term_months)
              values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
                v_start,
                (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
                'active', 0, v_dom, p_quote_id,
                case when v_is_monthly then 1 else 12 end)
              on conflict (tenant_id, quote_id, lower(domain)) where quote_id is not null and domain is not null
                do nothing
              returning id into v_new_sub_id;

              insert into public.customer_domains (tenant_id, customer_id, domain)
              values (v_tenant_id, v_customer_id, v_dom)
              on conflict (tenant_id, lower(domain)) do nothing;

              v_bulk_count := v_bulk_count + 1;
              v_used_domains := array_append(v_used_domains, v_dom);
            end loop;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_bulk_total_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          else
            v_seats := coalesce((v_first_line->>'qty')::int, 0);
            -- 0172: prefer THIS line's own domain (the quote builder now lets
            -- staff type a distinct domain per product line) over the
            -- whole-quote/customer fallback below, which was the only source
            -- before per-line domains existed.
            v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
            if v_sub_domain is null then
              if v_domain is null and v_customer_id is not null then
                select domain into v_domain from public.customers where id = v_customer_id;
              end if;
              v_sub_domain := v_domain;
            end if;
            if v_sub_domain is not null and lower(v_sub_domain) = any(v_used_domains) then
              v_sub_domain := null;
            end if;
            insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
              start_date, renewal_date, status, outstanding_amount, domain, quote_id,
              term_months)
            values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
              greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,  -- R-329
              (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
              case when v_first_sub_in_quote then v_outstanding else 0 end,
              v_sub_domain, p_quote_id,
              case when v_is_monthly then 1 else 12 end)
            returning id into v_new_sub_id;
            if v_sub_domain is not null then
              v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
            end if;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          end if;

          if v_po_sub_id is not null then
            select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
              into v_unit_wholesale_pm from public.items
             where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
            if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
              v_unit_wholesale_pm := greatest(0, round(coalesce(v_line_amount, v_expected)::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
            end if;
            v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
            v_po_id := public.next_document_number('purchase_order', v_tenant_id);
            insert into public.purchase_orders (
              id, tenant_id, subscription_id, customer_id, customer_name, domain,
              vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
            ) values (
              v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
              v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
              'Auto-created from quote ' || p_quote_id ||
              case when coalesce((v_first_line->>'bulk')::boolean, false) then ' (bulk order - ' || v_bulk_count || ' domains)'
                   else ' (new sub)' end,
              auth.uid()
            );
            v_po_created := true;
          end if;
        end if;
      end loop;
    end if;
    v_po_sub_id := null;
  elsif v_customer_id is not null and not v_is_renewal_quote and not v_is_add_seats and not v_has_bulk then
    update public.subscriptions set outstanding_amount = v_outstanding
     where tenant_id = v_tenant_id and customer_id = v_customer_id and quote_id = p_quote_id and outstanding_amount > 0;
  end if;

  if v_is_renewal_quote and v_is_fully_paid then
    v_first_line := case
      when jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0
        then v_quote.line_items->0 else null end;
    if v_first_line is not null then
      v_plan_name := coalesce(v_first_line->>'name', v_renewal_sub.plan);
      v_seats     := coalesce((v_first_line->>'qty')::int, v_renewal_sub.seats);
    else
      v_plan_name := v_renewal_sub.plan; v_seats := v_renewal_sub.seats;
    end if;
    v_new_mrr := greatest(0, round(coalesce(v_quote.subtotal, v_expected)::numeric / greatest(v_extension_months, 1)))::int;
    update public.subscriptions
       /* A full TERM, not a fixed twelve months. On a monthly subscription one month IS
          the whole term, and the old test left renewal_state stuck at whatever step the
          cadence had reached — so the ladder never re-armed and the next month went
          unchased. */
       set renewal_state = case when v_extension_months >= coalesce(v_renewal_sub.term_months, 12)
                                then 'renewed' else renewal_state end,
           renewal_date  = (v_renewal_sub.renewal_date + (v_extension_months || ' months')::interval)::date,
           seats = v_seats, plan = v_plan_name,
           mrr   = case when v_new_mrr > 0 then v_new_mrr else mrr end,
           outstanding_amount = 0, renewal_quote_id = null,
           reminder_count = 0, last_reminder_sent_at_v2 = null, status = 'active'
     where id = v_renewal_sub.id and tenant_id = v_tenant_id;
    v_renewal_rolled_forward := true;
    v_po_seats := v_seats; v_po_months := v_extension_months;
    v_po_plan := v_plan_name; v_po_vendor := v_renewal_sub.vendor; v_po_sub_id := v_renewal_sub.id;
  end if;

  if v_po_sub_id is not null then
    select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
      into v_unit_wholesale_pm from public.items
     where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
    if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
      v_unit_wholesale_pm := greatest(0, round(v_expected::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
    end if;
    v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
    v_po_id := public.next_document_number('purchase_order', v_tenant_id);
    insert into public.purchase_orders (
      id, tenant_id, subscription_id, customer_id, customer_name, domain,
      vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
    ) values (
      v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
      v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
      'Auto-created from quote ' || p_quote_id ||
      case when v_is_renewal_quote then ' (renewal/extension)'
           when v_bulk_count > 0    then ' (bulk order - ' || v_bulk_count || ' domains)'
           else ' (new sub)' end,
      auth.uid()
    );
    v_po_created := true;
  end if;

  update public.quotes
     set payment_status = v_new_payment_status,
         payment_amount = v_total_received,
         payment_method = p_method,
         payment_reference = p_reference,
         payment_received_at = now(),
         payment_notes = nullif(trim(coalesce(p_notes, '')), ''),
         customer_id = v_customer_id,
         status = case
           when status in ('draft', 'sent', 'viewed') then 'accepted'::public.quote_status
           else status
         end
   where id = p_quote_id and tenant_id = v_tenant_id;

  if v_has_existing_invoice then
    select i.amount, i.net_payable, i.status, i.adjusted_advances into v_invoice
      from public.invoices i where i.id = v_quote.invoice_id and i.tenant_id = v_tenant_id;
    if found and v_invoice.status <> 'paid' then
      v_already_adjusted := coalesce((select sum((adv->>'amount')::int) from jsonb_array_elements(v_invoice.adjusted_advances) adv), 0);
      v_post_invoice_received := v_total_received - v_already_adjusted;
      v_net_due := coalesce(v_invoice.net_payable, v_invoice.amount);
      /* R-015 (Pardeep, 29 Sep 2026). This wrote NOTHING unless the invoice was settled
         in full, so `invoices.paid_amount` stayed 0 on every part-paid invoice — and
         Aging and the Balance Sheet both count the whole `net_payable`. A Rs 1,00,000
         invoice with Rs 40,000 received showed Rs 1,00,000 outstanding while the same
         Rs 40,000 was also counted as cash: wrong on both sides of the books at once.
         (Only `sync_project_invoice_paid`, on the project side, ever filled the column,
         which is why it looks populated to anybody who checks a project invoice.)

         paid_amount is written on EVERY payment now. `greatest(0, ...)` because
         v_post_invoice_received is net of advances already adjusted onto the invoice and
         can legitimately go negative; a negative paid_amount would flatter the aging
         rather than merely be wrong.

         status and paid_date still move only on full settlement. invoice_status has no
         'partial' value, and adding one reaches every screen that switches on status —
         that is a change to ask for, not to take. Aging reads net_payable - paid_amount,
         which needs no new status.

         paid_date uses ist_today(): current_date is the UTC day on this server (R-015
         part 1), so an invoice settled at 01:00 IST was stamped yesterday. It is still
         the SETTLEMENT day and not the payment's own received date — record_payment has
         no received-date parameter to read, so the dialog patches that in afterwards. */
      update public.invoices
         set paid_amount = greatest(0, v_post_invoice_received),
             status      = case when v_post_invoice_received >= v_net_due
                                then 'paid'::invoice_status else status end,
             paid_date   = case when v_post_invoice_received >= v_net_due
                                then public.ist_today() else paid_date end
       where id = v_quote.invoice_id and tenant_id = v_tenant_id;
      v_invoice_paid := v_post_invoice_received >= v_net_due;
    end if;
  end if;

  /* ─── Overpayment → customer credit, ISI transaction me (audit A5, 1 Sep 2026) ───
     Outstanding upar 0 par floor hota hai, to expected se zyada aaya paisa yahan
     record na ho to KAHIN record nahi hota. Ye insert pehle client-side tha
     (record-payment-dialog.tsx), RPC ke commit ke BAAD — network/RLS ki ek hichki
     aur customer ka extra rupaya hamesha ke liye be-hisaab. Incremental hi jodta
     hai (is payment ne jitna naya excess banaya), taki kai kishton me double na gine —
     wahi ganit jo client me tha. */
  v_overpaid_credit := greatest(0, v_total_received - v_expected)
                     - greatest(0, v_prior_received - v_expected);
  if v_overpaid_credit > 0 and v_customer_id is not null then
    insert into public.customer_credits
      (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
    values
      (v_tenant_id, v_customer_id, v_overpaid_credit, 'overpayment', v_payment_id, p_quote_id,
       'Excess over quote ' || p_quote_id, 'open');
  end if;

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_voucher_no', v_receipt_voucher_no,
    'customer_id', v_customer_id,
    'total_received', v_total_received,
    'expected', v_expected,
    'outstanding', v_outstanding,
    'is_first_payment', v_is_first_payment,
    'is_fully_paid', v_is_fully_paid,
    'converted_now', v_converted_now,
    'subscription_created', v_subscription_created,
    'bulk_domains_created', v_bulk_count,
    'invoice_paid', v_invoice_paid,
    'has_existing_invoice', v_has_existing_invoice,
    'is_renewal_quote', v_is_renewal_quote,
    'renewal_rolled_forward', v_renewal_rolled_forward,
    'extension_months', v_extension_months,
    'domain', v_domain,
    'po_id', v_po_id,
    'po_created', v_po_created,
    'was_trial', v_was_trial,
    'is_add_seats', v_is_add_seats,
    'overpaid_credit', v_overpaid_credit,
    'idempotent_replay', false
  );
end;
$function$;
