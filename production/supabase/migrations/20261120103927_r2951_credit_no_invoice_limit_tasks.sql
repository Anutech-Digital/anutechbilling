-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.activate_quote_on_credit(text,integer,boolean,text,boolean)') and prosrc like '%v_r2951_uninvoiced%') and exists(select 1 from pg_trigger where tgname = 'quotes_r2951_credit_closes_tasks' and tgrelid = to_regclass('public.quotes')) and coalesce(has_function_privilege('authenticated', to_regprocedure('public.activate_quote_on_credit(text,integer,boolean,text,boolean)')::oid, 'execute') and has_function_privilege('service_role', to_regprocedure('public.activate_quote_on_credit(text,integer,boolean,text,boolean)')::oid, 'execute') and not has_function_privilege('anon', to_regprocedure('public.activate_quote_on_credit(text,integer,boolean,text,boolean)')::oid, 'execute'), false)
-- deploy-key: r2951creditnoinvoice
-- R-2951 (owner, 20 Nov 2026): "Activate now, pay later" WITHOUT a GST invoice (R-2950) —
-- card 2 of 5 (R-2950..R-2954). Three things:
--
--   1. The credit limit counts it. activate_quote_on_credit added up unpaid invoices + open part
--      requests only, so a quote activated with no invoice counted for nothing and the next
--      activation could pass the limit with no owner approval (R-2950 independent review). Now the
--      sum also takes what the customer's quotes activated without an invoice still owe (their
--      subscriptions' outstanding amount; invoice_id NULL; part requests excluded — they are in
--      open_part_requests). An invoice raised on such a quote later counts instead, never both.
--      Over the limit: non-owner refused, owner approves — the refusal says "this quote" on the
--      no-invoice path (no word "invoice"), "this invoice" as before otherwise.
--   2. Four owner tasks on the no-invoice path (final wording, no invoice number): set up seats
--      (today), "Credit: send payment link" (due − 3), "Credit: payment not in — stop service?"
--      (due + 15) and NEW "Credit: due date reached — issue the GST invoice" on the EARLIER of the
--      due date and activation + 30 days (= the due date while credit is capped at 30 days).
--      Nothing is issued or sent automatically. tasks_created = 4 on this path, 3 otherwise.
--   3. Trigger quotes_r2951_credit_closes_tasks (AFTER UPDATE OF payment_status, invoice_id on
--      quotes, only rows with credit_activated_at): every path that marks the quote fully paid or
--      gives it its invoice goes through this row, so it cannot be skipped —
--        payment_status → received (fully paid, no invoice): the two payment reminders are
--          cancelled (as record_payment does on the invoice path, R-346). The issue-invoice task
--          STAYS open: the GST invoice is still owed after the money came in.
--        any payment_status write (every payment): the pay-by date is cleared on the quote's
--          subscriptions that owe nothing now — also when the invoice came before the money.
--        invoice_id set: the issue-invoice task is done.
--      The invoice path itself is unchanged: there, record_payment closes the reminders when the
--      invoice is paid (payment_status stays 'invoiced', so this trigger's payment branch never runs).
--
-- The 5-argument function is re-created from the LATEST body (20261120084500_r2950_activate_without_invoice.sql,
-- copied whole; every R-2951 line is marked). The 4-argument wrapper is NOT touched. No argument
-- gets a default. Grants unchanged: authenticated + service_role, never PUBLIC or anon. The
-- trigger function is executable by nobody but its owner (a trigger needs no grant).
-- No data is changed. Safe to re-run. Tests: supabase/tests/r2951_activate_no_invoice_credit.test.sql.
begin;

-- Body of 20261120084500_r2950_activate_without_invoice.sql (its latest) + the R-2951 lines.
create or replace function public.activate_quote_on_credit(
  p_quote_id text,
  p_credit_days integer,
  p_approve_over_limit boolean,
  p_annual_override_reason text,   -- R-368
  p_issue_invoice boolean          -- R-2950: false = subscriptions only, no GST invoice now. No default (see the header).
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  /* R-2097: a yearly price not divisible by 12 stores a fractional monthly tier; read it as numeric */
  v_uid              uuid := auth.uid();
  v_caller_tenant    uuid;
  v_is_owner         boolean;
  v_quote            record;
  v_cust             record;
  v_lead             record;
  v_tenant_id        uuid;
  v_customer_id      uuid;
  v_received         integer;
  v_limit            integer;
  v_owed             integer;
  v_this             integer;
  v_exposure         integer;
  v_over             boolean;
  v_today            date := public.ist_today();
  v_due              date;
  v_invoice_id       text;
  v_balance          integer;
  v_owner            uuid;
  v_who              text;
  v_t1               timestamptz;
  v_t2               timestamptz;
  v_t3               timestamptz;
  v_expected         integer;
  v_domain           text;
  v_subs_created     integer := 0;
  v_pos              text[] := array[]::text[];
  -- subscription loop (same names/rules as record_payment)
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
  v_bulk_count       integer := 0;
  v_seats            integer;
  v_sub_domain       text;
  v_used_domains     text[] := array[]::text[];
  v_own_domain       boolean;                       -- R-829
  v_used_domain_plans text[] := array[]::text[];    -- R-829
  v_domain_conflicts jsonb := '[]'::jsonb;          -- R-829
  v_new_sub_id       uuid;
  v_po_sub_id        uuid;
  v_po_seats         integer;
  v_po_plan          text;
  v_po_vendor        public.vendor;
  v_unit_wholesale_pm integer;
  v_total_wholesale  integer;
  v_po_id            text;
  v_first_sub        boolean := true;
  v_annual_reason    text := nullif(btrim(coalesce(p_annual_override_reason, '')), '');  -- R-368
  v_has_annual       boolean;                                                              -- R-368
  v_cost_pm          integer;                                                              -- R-378
  v_no_invoice       boolean := false;   -- R-2950: this call raises no GST invoice
  v_r2950_carried    boolean := false;   -- R-2950: a subscription already carries the quote's due
  v_r2951_uninvoiced integer := 0;       -- R-2951: still owed on this customer's quotes activated without an invoice
  v_t4               timestamptz;        -- R-2951: "issue the GST invoice" task
begin
  if v_uid is null then
    raise exception 'Sign in to activate a quote on credit.' using errcode = 'insufficient_privilege';
  end if;
  v_caller_tenant := public.current_tenant_id();
  if v_caller_tenant is null then
    raise exception 'No tenant context';
  end if;
  if not exists (select 1 from public.users u where u.id = v_uid and u.is_active) then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;
  v_is_owner := public.current_user_is_owner();

  if p_credit_days is null or p_credit_days < 1 or p_credit_days > 180 then
    raise exception 'Credit days must be 1 to 180.' using errcode = 'check_violation';
  end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id, q.status, q.payment_status,
         q.amount, q.line_items, q.invoice_id, q.domain, q.is_add_seats, q.is_one_off,
         q.credit_activated_at, q.credit_due_date,
         q.billing_cycle   -- R-370
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;
  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;
  if v_quote.tenant_id <> v_caller_tenant then
    raise exception 'Quote % does not belong to your tenant', p_quote_id using errcode = 'insufficient_privilege';
  end if;
  v_tenant_id   := v_quote.tenant_id;
  v_customer_id := v_quote.customer_id;
  v_expected    := coalesce(v_quote.amount, 0);

  -- Double click / second tab: report what is already there instead of a second invoice.
  if v_quote.credit_activated_at is not null then
    return jsonb_build_object(
      'already_active', true,
      'invoice_id', v_quote.invoice_id,
      'due_date', v_quote.credit_due_date,
      'subscriptions_created', 0,
      'tasks_created', 0
    );
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Only an accepted quote can be activated on credit. Mark % accepted first.', p_quote_id
      using errcode = 'check_violation';
  end if;
  -- ── R-370: split billing is invoiced one period at a time by raise_subscription_billing.
  -- A whole-term credit invoice here would be billed a second time by the instalments.
  -- Same test as lib/payments/record-payment-invoice.ts isSplitBilled.
  if v_quote.billing_cycle is not null and v_quote.billing_cycle::text <> 'yearly' then
    raise exception 'This quote is billed in instalments (%) — record the first instalment instead, or switch billing to yearly.',
      replace(v_quote.billing_cycle::text, '_', '-')
      using errcode = 'check_violation';
  end if;
  if coalesce(v_quote.is_one_off, false) then
    raise exception 'Quote % is a one-off sale: there is no subscription to activate. Issue the invoice instead.', p_quote_id
      using errcode = 'check_violation';
  end if;
  if coalesce(v_quote.is_add_seats, false) then
    raise exception 'Quote % adds seats to an existing subscription. Record the payment instead.', p_quote_id
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.subscriptions s where s.tenant_id = v_tenant_id and s.renewal_quote_id = p_quote_id) then
    raise exception 'Quote % renews an existing subscription, which is already active. Record the payment instead.', p_quote_id
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.subscriptions s where s.tenant_id = v_tenant_id and s.quote_id = p_quote_id) then
    raise exception 'Quote % already has subscriptions.', p_quote_id using errcode = 'check_violation';
  end if;

  select coalesce(sum(p.amount), 0) into v_received
    from public.payments p where p.quote_id = p_quote_id and p.status = 'received';
  if v_received > 0 or v_quote.payment_status in ('received', 'partial') then
    raise exception 'Payment is already recorded on quote %, so it is not a credit sale.', p_quote_id
      using errcode = 'check_violation';
  end if;

  if v_quote.lead_id is not null then
    select l.trial_started_at, l.trial_converted_at into v_lead
      from public.leads l where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if found and v_lead.trial_started_at is not null and v_lead.trial_converted_at is null then
      raise exception 'Quote % is on a trial. Convert or stop the trial first.', p_quote_id
        using errcode = 'check_violation';
    end if;
  end if;

  if v_customer_id is null then
    raise exception 'Quote % has no customer yet. Accept it from the quote page so the customer is created.', p_quote_id
      using errcode = 'check_violation';
  end if;
  select c.id, c.name, c.domain, c.allow_pay_later, c.credit_limit into v_cust
    from public.customers c where c.id = v_customer_id and c.tenant_id = v_tenant_id
     for update;  -- R-2951: one activation per customer at a time, so two cannot both pass the credit limit
  if not found then
    raise exception 'Customer of quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;
  if not v_cust.allow_pay_later then
    raise exception 'Pay later is off for %. Turn it on in the customer''s Pay later settings, or record the payment first.', v_cust.name
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where li->>'commitment' is not null
  ) then
    raise exception 'Quote % has no subscription line (monthly or annual), so there is nothing to activate.', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- ── Credit limit ──
  v_limit := coalesce(v_cust.credit_limit, 50000);
  select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))), 0)::int
    into v_owed
    from public.invoices i
   where i.tenant_id = v_tenant_id and i.customer_id = v_customer_id
     and i.status in ('pending', 'overdue');
  /* R-2230: what the customer's open part payment requests still owe counts too — the same rule
     as the customer page's "Unpaid now" (public.open_part_requests, one row per request = is_lead). */
  v_owed := v_owed + coalesce((select sum(r.still_due) from public.open_part_requests(v_customer_id, null) r
                                where r.is_lead), 0)::int;
  /* R-2951: a quote activated WITHOUT a GST invoice (R-2950) is in no invoice, so count what it
     still owes: the outstanding amount on its subscriptions (the first one filed carries the whole
     quote; a payment lowers it). Once the quote has its invoice (invoice_id set) the invoice above
     counts instead — never both. A part request (subscription_billing_id) is already in
     open_part_requests. Same sum as lib/credit/activate-on-credit.ts uninvoicedCreditDues. */
  select coalesce(sum(greatest(0, coalesce(s.outstanding_amount, 0))), 0)::int
    into v_r2951_uninvoiced
    from public.quotes q2
    join public.subscriptions s on s.tenant_id = q2.tenant_id and s.quote_id = q2.id
   where q2.tenant_id = v_tenant_id and q2.customer_id = v_customer_id
     and q2.credit_activated_at is not null and q2.invoice_id is null
     and q2.subscription_billing_id is null
     and q2.id <> p_quote_id;
  v_owed := v_owed + v_r2951_uninvoiced;
  -- An invoice already raised on this quote is inside v_owed; do not count it twice.
  v_this     := case when v_quote.invoice_id is null then v_expected else 0 end;
  v_exposure := v_owed + v_this;
  v_over     := v_exposure > v_limit;
  if v_over and not v_is_owner then
    raise exception 'Over the credit limit: % already owes Rs %, this % is Rs %, total Rs % against a limit of Rs %. Only the owner can approve this.',
      v_cust.name, v_owed,
      case when not coalesce(p_issue_invoice, true) and v_quote.invoice_id is null then 'quote' else 'invoice' end,  -- R-2951
      v_this, v_exposure, v_limit
      using errcode = 'insufficient_privilege';
  end if;
  if v_over and not coalesce(p_approve_over_limit, false) then
    raise exception 'Over the credit limit: total Rs % against a limit of Rs %. Tick "Approve over limit" to go ahead.',
      v_exposure, v_limit
      using errcode = 'check_violation';
  end if;

  -- ── R-368: annual plans need payment first; only the owner overrides, with a reason ──
  -- After the credit-limit checks so their messages stay as they were. Same test as the app
  -- (lib/credit/activate-on-credit.ts annualLineNames): a commitment that is not monthly and
  -- not one_time.
  select exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where coalesce(li->>'commitment', '') not in ('', 'monthly', 'one_time')
  ) into v_has_annual;
  if v_has_annual and not v_is_owner then
    raise exception 'Annual plans need payment first. Only the owner can activate an annual plan on credit (quote %).', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_has_annual and (v_annual_reason is null or length(v_annual_reason) < 5) then
    raise exception 'Annual plans need payment first. To activate quote % on credit anyway, write the reason for the override.', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- ── Invoice (tax maths untouched: generate_invoice) ──
  -- An issued invoice is frozen (tg_invoices_freeze_issued: no due_date edits), so the due
  -- date goes in through generate_invoice's own rule: due = today + quotes.payment_terms_days.
  -- The credit days ARE the agreed terms of this sale, so the quote carries them.
  /* R-2950 (owner, 20 Nov 2026): p_issue_invoice = false → the subscriptions go live and NO GST
     invoice is raised now — generate_invoice is not called, so no invoices row, no invoice
     number, no revenue / GST / receivable, and payment_status stays as it is ('awaiting'). The
     accepted quote is the payment request; its due date is today + credit days. NULL = true
     (today's behaviour). A quote that already has an invoice keeps the branch below. */
  v_no_invoice := not coalesce(p_issue_invoice, true) and v_quote.invoice_id is null;
  if v_no_invoice then
    /* Owner decision 3 (card R-2950): without an invoice at most 30 credit days — the tax
       invoice is due within 30 days of the supply anyway. Longer credit = issue the invoice now. */
    if p_credit_days > 30 then
      raise exception 'Without a GST invoice, credit days can be 1 to 30. For longer credit, issue the GST invoice now.'
        using errcode = 'check_violation';
    end if;
    -- generate_invoice refuses a quote with no amount; without it this path says so itself.
    if v_expected <= 0 then
      raise exception 'Quote % has no amount — there is nothing to give credit on.', p_quote_id
        using errcode = 'check_violation';
    end if;
    -- The credit days are the agreed terms of this sale either way (the invoice raised later reads them).
    update public.quotes set payment_terms_days = p_credit_days
     where id = p_quote_id and tenant_id = v_tenant_id;
    v_invoice_id := null;
  elsif v_quote.invoice_id is null then
    update public.quotes set payment_terms_days = p_credit_days
     where id = p_quote_id and tenant_id = v_tenant_id;
    select g.invoice_id into v_invoice_id from public.generate_invoice(p_quote_id) g;
  else
    -- Invoice raised before this: its due date stands (an issued invoice cannot be edited).
    v_invoice_id := v_quote.invoice_id;
    if exists (select 1 from public.invoices i where i.id = v_invoice_id and i.status in ('paid', 'void')) then
      raise exception 'Invoice % on quote % is % — nothing to give credit on.', v_invoice_id, p_quote_id,
        (select i.status from public.invoices i where i.id = v_invoice_id)
        using errcode = 'check_violation';
    end if;
  end if;
  select coalesce(i.due_date, v_today + p_credit_days) into v_due
    from public.invoices i where i.id = v_invoice_id;
  select greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))::int into v_balance
    from public.invoices i where i.id = v_invoice_id;
  if v_no_invoice then  -- R-2950: no invoice to read them from
    v_due     := v_today + p_credit_days;
    v_balance := v_expected;
  end if;

  -- ── Subscriptions: record_payment's rules, line by line ──
  v_domain := v_quote.domain;
  for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
    v_first_line := v_quote.line_items -> v_line_idx;
    perform set_config('app.r2723_quote_line', p_quote_id || '|' || v_line_idx, true);  -- R-2723: this row's quote line, for subscription_term_follows_line
    v_commitment := v_first_line->>'commitment';
    v_plan_name  := coalesce(v_first_line->>'name',
                      case when v_commitment = 'monthly' then 'Monthly subscription'
                           else 'Annual subscription' end);
    /* R-1688: the one rule (quote_line_is_subscription). This read
       `v_is_monthly := v_commitment = 'monthly'`, which is NULL for a line with no commitment, so
       `continue when not (false or NULL)` did NOT continue and a One-time line was filed as an
       Annual subscription (and a commitment 'one_time' line was filed as annual outright). A line
       marked one-time, commitment 'one_time' or a one-time catalogue item is never filed; a line
       with no commitment keeps this path's old meaning (filed: true) so legacy quotes do not change. */
    v_is_monthly := coalesce(v_commitment = 'monthly', false)
                    and public.quote_line_is_subscription(v_first_line, v_tenant_id, true);
    v_is_annual  := not v_is_monthly
                    and public.quote_line_is_subscription(v_first_line, v_tenant_id, true);
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

        /* R-2950: with no invoice the subscription is the only place the due lives (Payments →
           dues, Collections, the pay-by chip), so the FIRST row filed carries the whole quote and
           its due date — also when that row comes from a bulk line. With an invoice the bulk rows
           stay at 0 as before (the invoice carries the due). */
        insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
          start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
          vendor_cost_per_seat_month,  -- R-378
          payment_due_date)            -- R-2950
        values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
          v_start,
          (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
          'active', case when v_no_invoice and not v_r2950_carried then v_expected else 0 end, v_dom, p_quote_id,
          case when v_is_monthly then 1 else 12 end,
          v_cost_pm,  -- R-378
          case when v_no_invoice and not v_r2950_carried then v_due end)  -- R-2950
        on conflict (tenant_id, quote_id, lower(domain), lower(plan)) where quote_id is not null and domain is not null  -- R-829
          do nothing
        returning id into v_new_sub_id;
        if v_new_sub_id is not null then v_subs_created := v_subs_created + 1; end if;
        if v_no_invoice and v_new_sub_id is not null then v_r2950_carried := true; end if;  -- R-2950

        insert into public.customer_domains (tenant_id, customer_id, domain)
        values (v_tenant_id, v_customer_id, v_dom)
        on conflict (tenant_id, lower(domain)) do nothing;

        v_bulk_count := v_bulk_count + 1;
        v_used_domains := array_append(v_used_domains, v_dom);
        v_used_domain_plans := array_append(v_used_domain_plans, v_dom || '|' || lower(v_plan_name));  -- R-829
      end loop;
      v_po_seats := v_bulk_total_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    else
      v_seats := coalesce((v_first_line->>'qty')::int, 0);
      v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
      v_own_domain := v_sub_domain is not null;  -- R-829
      if v_sub_domain is null then
        if v_domain is null then v_domain := v_cust.domain; end if;
        v_sub_domain := lower(nullif(trim(v_domain), ''));
      end if;
      -- R-829: same rule as record_payment — own domain kept unless this plan already has it.
      if v_sub_domain is not null then
        if v_own_domain then
          if (v_sub_domain || '|' || lower(v_plan_name)) = any(v_used_domain_plans) then
            v_domain_conflicts := v_domain_conflicts || jsonb_build_object(
              'line', v_line_idx + 1, 'plan', v_plan_name, 'domain', v_sub_domain);
            v_sub_domain := null;
          end if;
        elsif v_sub_domain = any(v_used_domains) then
          v_sub_domain := null;
        end if;
      end if;
      insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
        start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
          vendor_cost_per_seat_month,  -- R-378
          payment_due_date)            -- R-2950
      values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
        greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,
        (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
        -- Nothing is paid yet: the whole quote is outstanding, carried on the first subscription
        -- exactly as record_payment does for a part payment.
        -- R-2950: with no invoice, on the first row FILED (a bulk row before this one may already carry it).
        case when v_no_invoice then (case when not v_r2950_carried then v_expected else 0 end)
             when v_first_sub then v_expected else 0 end,
        v_sub_domain, p_quote_id,
        case when v_is_monthly then 1 else 12 end,
        v_cost_pm,  -- R-378
        case when v_no_invoice and not v_r2950_carried then v_due end)  -- R-2950: the agreed credit date
      returning id into v_new_sub_id;
      v_subs_created := v_subs_created + 1;
      if v_no_invoice then v_r2950_carried := true; end if;  -- R-2950
      if v_sub_domain is not null then
        v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
        v_used_domain_plans := array_append(v_used_domain_plans, lower(v_sub_domain) || '|' || lower(v_plan_name));  -- R-829
      end if;
      v_po_seats := v_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    end if;
    v_first_sub := false;

    -- Draft PO for the vendor seats, same as record_payment (the seats go live now).
    if v_po_sub_id is not null then
      select coalesce(nullif(round((prices->'annual'->>'wholesale')::numeric)::int, 0), nullif(wholesale, 0))
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
        'Auto-created from quote ' || p_quote_id || ' (activated on credit)',
        v_uid
      );
      v_pos := array_append(v_pos, v_po_id);
    end if;
  end loop;
  perform set_config('app.r2723_quote_line', '', true);  -- R-2723

  if v_subs_created = 0 then
    raise exception 'No subscription could be created from quote % — check its lines.', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- ── Tasks for the owner. Tasks only: nothing is sent, nothing is suspended. ──
  select u.id into v_owner from public.users u
   where u.tenant_id = v_tenant_id and u.role = 'owner' and u.is_active
   order by u.created_at limit 1;
  v_owner := coalesce(v_owner, v_uid);
  v_who := coalesce(nullif(trim(v_quote.customer_name), ''), p_quote_id);

  -- 10:00 IST on the day; never in the past.
  v_t1 := greatest(now(), (v_today + time '10:00') at time zone 'Asia/Kolkata');
  v_t2 := greatest(v_t1, ((v_due - 3) + time '10:00') at time zone 'Asia/Kolkata');
  v_t3 := ((v_due + 15) + time '10:00') at time zone 'Asia/Kolkata';

  if v_no_invoice then
    /* R-2951 (owner, 20 Nov 2026): four tasks, no invoice number anywhere. The first three on the
       same days as with an invoice; the fourth reminds the owner to issue the GST invoice on the
       EARLIER of the credit due date and activation + 30 days (a tax invoice for a continuous supply
       is due by the payment date, and within 30 days of the supply anyway — the decision on the card,
       to be confirmed by the CA). With credit capped at 30 days here, that is the due date. Nothing
       is issued automatically. The trigger quotes_r2951_credit_closes_tasks closes them: full payment
       → the two payment reminders; the invoice raised → the issue-invoice task. */
    v_t4 := greatest(now(), (least(v_due, v_today + 30) + time '10:00') at time zone 'Asia/Kolkata');
    insert into public.tasks (tenant_id, owner_id, title, notes, kind, due_at, quote_id) values
      (v_tenant_id, v_owner,
       'Set up seats (DNS, users) · ' || v_who,
       'Quote ' || p_quote_id || ' is active on credit, without a GST invoice yet. Verify the domain (DNS) and create the users. Rs '
         || v_balance || ' due ' || to_char(v_due, 'DD Mon YYYY') || '.',
       'custom', v_t1, p_quote_id),
      (v_tenant_id, v_owner,
       'Credit: send payment link · ' || v_who,
       'Quote ' || p_quote_id || ' (Rs ' || v_balance || ') is due ' || to_char(v_due, 'DD Mon YYYY')
         || '. Send the payment link for the quote. Reminder only — nothing is sent to the customer automatically.',
       'followup', v_t2, p_quote_id),
      (v_tenant_id, v_owner,
       'Credit: payment not in — stop service? · ' || v_who,
       'Quote ' || p_quote_id || ' was due ' || to_char(v_due, 'DD Mon YYYY')
         || ' and is 15 days late. Decide: wait, chase or stop the service. Nothing is suspended automatically.',
       'followup', v_t3, p_quote_id),
      (v_tenant_id, v_owner,
       'Credit: due date reached — issue the GST invoice · ' || v_who,
       'Quote ' || p_quote_id || ' (Rs ' || v_balance || ') went live on ' || to_char(v_today, 'DD Mon YYYY')
         || ' without a GST invoice. Issue the GST invoice by ' || to_char(least(v_due, v_today + 30), 'DD Mon YYYY')
         || ', paid or not. Nothing is issued automatically.',
       'custom', v_t4, p_quote_id);

    /* R-2950: the provisioning obligation. trg_quotes_raise_provisioning raises it when
       payment_status moves to received / invoiced — which does not happen here, while the seats
       ARE going live now. One row per quote, as the trigger's own rule; the trigger then finds
       it and adds nothing when the payment or the invoice comes. */
    if not exists (select 1 from public.provisioning_tasks pt where pt.quote_id = p_quote_id) then
      insert into public.provisioning_tasks (tenant_id, quote_id, status)
      values (v_tenant_id, p_quote_id, 'pending');
    end if;
  else
  insert into public.tasks (tenant_id, owner_id, title, notes, kind, due_at, quote_id) values
    (v_tenant_id, v_owner,
     'Set up seats (DNS, users) · ' || v_who,
     'Quote ' || p_quote_id || ' is active on credit. Verify the domain (DNS) and create the users. Invoice '
       || v_invoice_id || ', Rs ' || v_balance || ' due ' || to_char(v_due, 'DD Mon YYYY') || '.',
     'custom', v_t1, p_quote_id),
    (v_tenant_id, v_owner,
     'Credit: send payment link · ' || v_who,
     'Invoice ' || v_invoice_id || ' (Rs ' || v_balance || ') is due ' || to_char(v_due, 'DD Mon YYYY')
       || '. Send the payment link. Reminder only — nothing is sent to the customer automatically.',
     'followup', v_t2, p_quote_id),
    (v_tenant_id, v_owner,
     'Credit: payment not in — stop service? · ' || v_who,
     'Invoice ' || v_invoice_id || ' was due ' || to_char(v_due, 'DD Mon YYYY')
       || ' and is 15 days late. Decide: wait, chase or stop the service. Nothing is suspended automatically.',
     'followup', v_t3, p_quote_id);
  end if;  -- R-2950

  update public.quotes
     set credit_activated_at = now(),
         credit_activated_by = v_uid,
         credit_due_date     = v_due,
         credit_over_limit_approved_by = case when v_over then v_uid else null end,
         credit_annual_override_reason = case when v_has_annual then v_annual_reason else null end,  -- R-368
         credit_annual_override_by     = case when v_has_annual then v_uid else null end             -- R-368
   where id = p_quote_id and tenant_id = v_tenant_id;

  return jsonb_build_object(
    'already_active', false,
    'invoice_id', v_invoice_id,
    'due_date', v_due,
    'amount_due', v_balance,
    'subscriptions_created', v_subs_created,
    'purchase_orders', to_jsonb(v_pos),
    'tasks_created', case when v_no_invoice then 4 else 3 end,  -- R-2951
    'over_limit', v_over,
    'owed_before', v_owed,
    'credit_limit', v_limit,
    'domain_conflicts', v_domain_conflicts  -- R-829
  );
end;
$function$;

revoke all on function public.activate_quote_on_credit(text, integer, boolean, text, boolean) from public, anon;
grant execute on function public.activate_quote_on_credit(text, integer, boolean, text, boolean) to authenticated, service_role;

comment on function public.activate_quote_on_credit(text, integer, boolean, text, boolean) is
  'R-346 + R-2950 + R-2951: Activate now, pay later. p_issue_invoice true = GST invoice + subscriptions in one save; false = subscriptions only, the quote stays the payment request (no invoice, payment_status awaiting, due on the first subscription with payment_due_date) and a fourth task to issue the GST invoice. The credit limit counts quotes activated without an invoice (R-2951). No argument has a default - the 4-argument function of the same name is the with-invoice wrapper.';

-- ── R-2951: tasks close by themselves ───────────────────────────────────────────────────────
create or replace function public.r2951_credit_quote_closes_tasks()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  /* Fully paid with no invoice (record_payment writes 'received' only when the money covers the
     quote; with an invoice it writes 'invoiced' and closes the reminders itself, R-346). */
  if new.payment_status = 'received' and old.payment_status is distinct from 'received' then
    update public.tasks
       set status = 'cancelled'
     where tenant_id = new.tenant_id
       and quote_id  = new.id
       and status in ('pending', 'snoozed')
       and title like 'Credit:%'
       and title not like 'Credit: due date reached%';   -- the GST invoice is still owed
  end if;

  /* Nothing owed any more → no pay-by date (Payments → dues, Collections, the pay-by chip).
     Every payment writes payment_status (record_payment sets it each time, also 'invoiced' →
     'invoiced' when an invoice raised before the money is paid), and the outstanding amount is
     lowered before that write — so this also covers "invoice first, payment later". Only rows
     that owe nothing; a part payment keeps its date. */
  update public.subscriptions
     set payment_due_date = null
   where tenant_id = new.tenant_id
     and quote_id  = new.id
     and payment_due_date is not null
     and coalesce(outstanding_amount, 0) <= 0;

  -- The GST invoice is raised (paid or not) → the reminder to raise it is done.
  if old.invoice_id is null and new.invoice_id is not null then
    update public.tasks
       set status = 'done'
     where tenant_id = new.tenant_id
       and quote_id  = new.id
       and status in ('pending', 'snoozed')
       and title like 'Credit: due date reached%';
  end if;
  return null;
end;
$function$;

revoke all on function public.r2951_credit_quote_closes_tasks() from public, anon, authenticated;

comment on function public.r2951_credit_quote_closes_tasks() is
  'R-2951: on a quote activated on credit - fully paid (received) cancels the two Credit: payment reminders and clears the pay-by date on subscriptions that owe nothing; invoice_id set marks the "issue the GST invoice" task done.';

drop trigger if exists quotes_r2951_credit_closes_tasks on public.quotes;
create trigger quotes_r2951_credit_closes_tasks
  after update of payment_status, invoice_id on public.quotes
  for each row
  when (new.credit_activated_at is not null)
  execute function public.r2951_credit_quote_closes_tasks();

commit;
