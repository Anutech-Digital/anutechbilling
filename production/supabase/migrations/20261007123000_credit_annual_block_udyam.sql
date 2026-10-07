-- R-368 (7 Oct 2026): pay-later customers who do not pay — the parts that need the database.
--
-- Pardeep's decisions (7 Oct):
--   1. ANNUAL plans need payment first. activate_quote_on_credit (R-346) now refuses a quote
--      with an annual line (annual_yearly, or a legacy multi-month term) unless the OWNER
--      overrides it with a written reason (5+ characters). The reason and who gave it are kept
--      on the quote. Monthly-only quotes behave exactly as before.
--   2. The company's Udyam (MSME) registration number lives on the tenant (Settings → Company
--      → Compliance profile) and is printed on quote and invoice PDFs when set.
--
-- Late interest (18% p.a. simple) needs NO schema: it is charged, on an explicit owner/billing
-- click, as a debit note through the existing issue_debit_note RPC (lib/credit/late-interest.ts).
--
-- The function below = 20261007073000_activate_on_credit.sql's body with the lines marked
-- "R-368". The old 3-argument signature is DROPPED so nobody can call around the check; the
-- app sends p_annual_override_reason only when the owner wrote one, so a monthly quote calls
-- the 4-argument function by its 3 named arguments and still works.
--
-- Needs 20261007073000_activate_on_credit.sql applied FIRST.
-- NOT APPLIED by the worker — the manager applies it (staging first).
-- Test (rolled back): supabase/tests/credit_annual_block.test.sql
-- Note: supabase/tests/activate_on_credit.test.sql (R-346) activates annual quotes without a
-- reason; run it against R-346's migration alone, before this one.

-- ── 1. Columns ───────────────────────────────────────────────────────────────
alter table public.quotes
  add column if not exists credit_annual_override_reason text,
  add column if not exists credit_annual_override_by uuid references public.users(id) on delete set null;

comment on column public.quotes.credit_annual_override_reason is
  'R-368: why the owner activated a quote with an annual line on credit (annual plans need payment first by default).';

alter table public.tenants
  add column if not exists udyam_number text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_udyam_number_format') then
    alter table public.tenants add constraint tenants_udyam_number_format
      check (udyam_number is null or udyam_number ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$');
  end if;
end $$;

comment on column public.tenants.udyam_number is
  'R-368: the company''s own Udyam (MSME) registration, UDYAM-SS-00-0000000. Printed on quote and invoice PDFs when set. Writes go through the owner-only tenant update policy.';

-- ── 2. activate_quote_on_credit with the annual check ────────────────────────
drop function if exists public.activate_quote_on_credit(text, integer, boolean);

create or replace function public.activate_quote_on_credit(
  p_quote_id text,
  p_credit_days integer,
  p_approve_over_limit boolean default false,
  p_annual_override_reason text default null   -- R-368
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
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
         q.credit_activated_at, q.credit_due_date
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
    from public.customers c where c.id = v_customer_id and c.tenant_id = v_tenant_id;
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
  -- An invoice already raised on this quote is inside v_owed; do not count it twice.
  v_this     := case when v_quote.invoice_id is null then v_expected else 0 end;
  v_exposure := v_owed + v_this;
  v_over     := v_exposure > v_limit;
  if v_over and not v_is_owner then
    raise exception 'Over the credit limit: % already owes Rs %, this invoice is Rs %, total Rs % against a limit of Rs %. Only the owner can approve this.',
      v_cust.name, v_owed, v_this, v_exposure, v_limit
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
  if v_quote.invoice_id is null then
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

  -- ── Subscriptions: record_payment's rules, line by line ──
  v_domain := v_quote.domain;
  for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
    v_first_line := v_quote.line_items -> v_line_idx;
    v_commitment := v_first_line->>'commitment';
    v_plan_name  := coalesce(v_first_line->>'name',
                      case when v_commitment = 'monthly' then 'Monthly subscription'
                           else 'Annual subscription' end);
    v_is_annual  := v_commitment is distinct from 'monthly' and v_commitment is not null;
    v_is_monthly := v_commitment = 'monthly';
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

    v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, current_date);
    v_line_amount := round(
      coalesce((v_first_line->>'qty')::numeric, 0) * coalesce((v_first_line->>'rate')::numeric, 0)
        * (1 - coalesce((v_first_line->>'discount_pct')::numeric, 0) / 100)
    )::int;
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

        insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
          start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months)
        values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
          v_start,
          (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
          'active', 0, v_dom, p_quote_id,
          case when v_is_monthly then 1 else 12 end)
        on conflict (tenant_id, quote_id, lower(domain)) where quote_id is not null and domain is not null
          do nothing
        returning id into v_new_sub_id;
        if v_new_sub_id is not null then v_subs_created := v_subs_created + 1; end if;

        insert into public.customer_domains (tenant_id, customer_id, domain)
        values (v_tenant_id, v_customer_id, v_dom)
        on conflict (tenant_id, lower(domain)) do nothing;

        v_bulk_count := v_bulk_count + 1;
        v_used_domains := array_append(v_used_domains, v_dom);
      end loop;
      v_po_seats := v_bulk_total_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    else
      v_seats := coalesce((v_first_line->>'qty')::int, 0);
      v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
      if v_sub_domain is null then
        if v_domain is null then v_domain := v_cust.domain; end if;
        v_sub_domain := v_domain;
      end if;
      if v_sub_domain is not null and lower(v_sub_domain) = any(v_used_domains) then
        v_sub_domain := null;
      end if;
      insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
        start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months)
      values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
        greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,
        (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
        -- Nothing is paid yet: the whole quote is outstanding, carried on the first subscription
        -- exactly as record_payment does for a part payment.
        case when v_first_sub then v_expected else 0 end,
        v_sub_domain, p_quote_id,
        case when v_is_monthly then 1 else 12 end)
      returning id into v_new_sub_id;
      v_subs_created := v_subs_created + 1;
      if v_sub_domain is not null then
        v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
      end if;
      v_po_seats := v_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    end if;
    v_first_sub := false;

    -- Draft PO for the vendor seats, same as record_payment (the seats go live now).
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
        'Auto-created from quote ' || p_quote_id || ' (activated on credit)',
        v_uid
      );
      v_pos := array_append(v_pos, v_po_id);
    end if;
  end loop;

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
    'tasks_created', 3,
    'over_limit', v_over,
    'owed_before', v_owed,
    'credit_limit', v_limit
  );
end;
$function$;


revoke all on function public.activate_quote_on_credit(text, integer, boolean, text) from public, anon;
grant execute on function public.activate_quote_on_credit(text, integer, boolean, text) to authenticated, service_role;

notify pgrst, 'reload schema';
