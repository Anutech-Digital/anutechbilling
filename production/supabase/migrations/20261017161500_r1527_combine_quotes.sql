-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.combine_quotes(text[])') and prosrc like '%R-1527%')
-- deploy-key: r1527combinequotes
-- 20261017161500_r1527_combine_quotes.sql
--
-- R-1527 (P2, Pardeep 17 Oct 2026 — R-1524 3/3, decision "option A"): a customer wants ONE
-- tax invoice for several accepted quotes. Combining is lawful only BEFORE an invoice is
-- issued (R-1524: an issued GST invoice is never merged or altered). So the quotes are first
-- merged into ONE NEW QUOTE, and today's generate_invoice runs on that quote unchanged.
--
-- ══ WHY A NEW QUOTE, NOT ONE INVOICE OVER MANY QUOTES ══════════════════════════════
--   The money spine is one invoice ↔ one quote: record_payment writes invoices.paid_amount
--   and 'paid' from ONE quote's payments (20261011120000_r718_money_roles.sql:1574, 1872-1907)
--   and books anything over that quote's amount as advance credit (:1930); invoices.quote_id
--   holds one quote (generate_invoice); R-1525's record_multi_invoice_payment and the invoice
--   PDF read lines through that one quote. A combined QUOTE keeps every one of those rules
--   exactly as it is — no new money semantics.
--
-- ══ WHAT combine_quotes(p_quote_ids) DOES — all or nothing ═════════════════════════
--   1. Locks the quotes (for update, id order) and refuses unless EVERY one is:
--        in the caller's company · this one customer · status 'accepted' · not invoiced ·
--        not replaced already · payment_status none/awaiting · approval not pending/rejected ·
--        not a renewal / extension / add-seats quote · not activated on credit ·
--        and has NO money or activation attached: payments (any status — advances and
--        receipt vouchers live there), customer_credits.source_quote_id, coupon_redemptions,
--        subscriptions (quote_id or renewal_quote_id), provisioning requests/tasks, seat
--        requests, referral agreements.
--      and ALL of them share: currency + exchange rate, GST rate (same customer = same place
--      of supply; the rate carries the export/zero-rated treatment), billing cycle, one-off
--      vs recurring, payment terms.
--      Each quote's SAVED total must equal its lines by the builder's own formula
--      (quote-builder.tsx: subtotal = Σ qty×rate − Σ round(qty×rate×line disc%);
--      tax = round(subtotal × rate%); amount = subtotal + tax; quote-level discount 0), or the
--      quote is refused — a total that does not match its lines cannot be summed honestly.
--   2. ACTIVATION (record_payment files one subscription + draft PO per line on the first
--      payment). Lines are copied untouched, so per-line activation is the same. What a merge
--      WOULD change, and is therefore refused:
--        · different quote-level domains among quotes with subscription lines — the PO and
--          any line without its own domain take the QUOTE's domain;
--        · lines without their own domain in MORE than one quote — record_payment gives the
--          borrowed domain to the first such line only, so the others would lose it;
--        · the same domain + plan on lines from two different quotes — the subscription
--          unique key is (quote, domain, plan), so the second would be dropped;
--        · a monthly-flex line next to an annual line (R-381 one billing term).
--   3. New quote: number from next_document_number('quote') (§17a); all line_items copied
--      in order (item_id, commitment, start_date, domain, bulk domains… preserved; a repeated
--      line id gets a fresh one); totals by the builder formula on the combined lines;
--      status 'accepted', payment_status 'awaiting'; notes "Combined from …".
--   4. Originals: status 'expired' + superseded_by = new quote + superseded_at (the R-482
--      "Replaced by" mechanism — trg_quote_superseded_guard stops them being accepted
--      again) and an audit line appended to notes. trg_activity_quotes logs every change.
--
-- ══ GUARDS (§17c fail-closed) ═══════════════════════════════════════════════════════
--   Role: owner / manager / accountant / billing (the generate_invoice group); service_role /
--   direct DB trusted. current_tenant_id() must be set — NULL is refused even for a trusted
--   caller: a combine always acts for one company.
--
-- Test: supabase/tests/r1527_combine_quotes.test.sql (rolled back).

begin;

create or replace function public.combine_quotes(p_quote_ids text[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1527: several accepted, unpaid, un-invoiced quotes of ONE customer → ONE new quote. */
declare
  v_tenant     uuid := public.current_tenant_id();
  v_trusted    boolean;
  v_ids        text[];
  v_n          integer;
  v_q          record;
  v_first      record;
  v_started    boolean := false;
  v_lines      jsonb := '[]'::jsonb;
  v_line       jsonb;
  v_line_ids   text[] := array[]::text[];
  v_keys       text[] := array[]::text[];
  v_keys_q     text[] := array[]::text[];
  v_key        text;
  v_dom        text;
  v_borrow_q   text := null;
  v_sub_dom    text := null;
  v_sub_dom_q  text := null;
  v_has_sub    boolean;
  v_gross      bigint;
  v_ldisc      bigint;
  v_sub        bigint;
  v_tax        bigint;
  v_cost       bigint;
  v_seats      integer := 0;
  v_sum_amt    bigint := 0;
  v_sum_sub    bigint := 0;
  v_new_id     text;
  v_today      date := public.ist_today();
  v_lead       text;
  v_lead_mixed boolean := false;
  v_terms      text := null;
  v_expires    date;
  v_appr_any   boolean := false;
  v_appr_tier  public.quote_approval_tier := null;
  v_appr_by    uuid := null;
  v_appr_at    timestamptz := null;
  v_appr_disc  integer := null;
  v_appr_marg  integer := null;
  v_domain     text := null;
begin
  /* Role gate — same group as generate_invoice (R-885). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can combine quotes. Ask one of them to do it.'
      using errcode = '42501';
  end if;
  /* §17c fail-closed: no company → nothing. */
  if v_tenant is null then
    raise exception 'No company context — sign in again, then combine the quotes.' using errcode = '28000';
  end if;

  if p_quote_ids is null or array_position(p_quote_ids, null) is not null then
    raise exception 'Choose the quotes to combine.';
  end if;
  select array_agg(distinct btrim(x) order by btrim(x)) into v_ids
    from unnest(p_quote_ids) x where btrim(x) <> '';
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n <> cardinality(p_quote_ids) then
    raise exception 'A quote is listed twice (or blank). Choose each quote once.';
  end if;
  if v_n < 2 then
    raise exception 'Choose at least two quotes to combine into one.';
  end if;
  if v_n > 50 then
    raise exception 'Too many quotes in one go (% — at most 50).', v_n;
  end if;

  /* Lock in id order (no deadlock between two combines), refuse any outside the company. */
  perform 1 from public.quotes q where q.id = any(v_ids) and q.tenant_id = v_tenant order by q.id for update;
  for v_q in select unnest(v_ids) as id loop
    if not exists (select 1 from public.quotes q where q.id = v_q.id and q.tenant_id = v_tenant) then
      raise exception 'Quote % was not found in your company. Refresh the list and try again.', v_q.id
        using errcode = '42501';
    end if;
  end loop;

  for v_q in
    select q.*,
           coalesce(nullif(lower(btrim(q.domain)), ''), '') as qdom
      from public.quotes q
     where q.id = any(v_ids) and q.tenant_id = v_tenant
     order by q.created_at nulls last, q.id
  loop
    if not v_started then
      v_started := true;
      v_first := v_q;
      if v_q.customer_id is null then
        raise exception 'Quote % has no customer yet (prospect quote). Accept it into a customer first, then combine.', v_q.id;
      end if;
      if not exists (select 1 from public.customers c where c.id = v_q.customer_id and c.tenant_id = v_tenant) then
        raise exception 'The customer of quote % is not in your company.', v_q.id using errcode = '42501';
      end if;
      v_lead := v_q.lead_id;
      v_expires := v_q.expires_date;
    end if;

    /* ── one customer, one place of supply / GST treatment, one currency, one billing ── */
    if v_q.customer_id is distinct from v_first.customer_id then
      raise exception 'Quote % is for % and quote % for %. Only quotes of ONE customer can be combined.',
        v_q.id, coalesce(v_q.customer_name, 'another customer'), v_first.id, coalesce(v_first.customer_name, 'another customer');
    end if;
    if coalesce(upper(v_q.currency), 'INR') <> coalesce(upper(v_first.currency), 'INR')
       or coalesce(v_q.exchange_rate, 1) <> coalesce(v_first.exchange_rate, 1) then
      raise exception 'Quote % is in % at rate %, quote % in % at rate %. Only quotes in the same currency and rate can be combined.',
        v_q.id, coalesce(v_q.currency, 'INR'), coalesce(v_q.exchange_rate, 1),
        v_first.id, coalesce(v_first.currency, 'INR'), coalesce(v_first.exchange_rate, 1);
    end if;
    if coalesce(v_q.tax_rate, 18) <> coalesce(v_first.tax_rate, 18) then
      raise exception 'Quote % has GST % %% and quote % has % %%. Different GST treatment cannot go on one tax invoice.',
        v_q.id, coalesce(v_q.tax_rate, 18), v_first.id, coalesce(v_first.tax_rate, 18);
    end if;
    if coalesce(v_q.billing_cycle, 'yearly') <> coalesce(v_first.billing_cycle, 'yearly') then
      raise exception 'Quote % is billed % and quote % %. Only quotes with the same billing cycle can be combined.',
        v_q.id, coalesce(v_q.billing_cycle, 'yearly'), v_first.id, coalesce(v_first.billing_cycle, 'yearly');
    end if;
    if coalesce(v_q.is_one_off, false) <> coalesce(v_first.is_one_off, false) then
      raise exception 'Quote % is a one-time sale and quote % is recurring (or the other way round). They cannot be combined.',
        case when coalesce(v_q.is_one_off, false) then v_q.id else v_first.id end,
        case when coalesce(v_q.is_one_off, false) then v_first.id else v_q.id end;
    end if;
    if v_q.payment_terms_days is distinct from v_first.payment_terms_days then
      raise exception 'Quote % has payment terms of % days and quote % of % days. Make them the same (Edit quote), then combine.',
        v_q.id, coalesce(v_q.payment_terms_days::text, 'default'), v_first.id, coalesce(v_first.payment_terms_days::text, 'default');
    end if;

    /* ── state of the quote ── */
    if v_q.invoice_id is not null then
      raise exception 'Quote % already has invoice %. An issued invoice is never combined.', v_q.id, v_q.invoice_id;
    end if;
    if v_q.superseded_by is not null then
      raise exception 'Quote % was already replaced by %. Use % instead.', v_q.id, v_q.superseded_by, v_q.superseded_by;
    end if;
    if v_q.status::text <> 'accepted' then
      raise exception 'Quote % is % — only accepted quotes can be combined. Mark it accepted first.', v_q.id, v_q.status;
    end if;
    if coalesce(v_q.payment_status::text, 'none') not in ('none', 'awaiting') then
      raise exception 'Quote % already has money recorded (%). Only quotes with no payment can be combined.', v_q.id, v_q.payment_status;
    end if;
    if coalesce(v_q.approval_status::text, 'not_required') in ('pending', 'rejected') then
      raise exception 'Quote % is % approval. Get it approved first, then combine.', v_q.id,
        case when v_q.approval_status::text = 'pending' then 'waiting for' else 'refused' end;
    end if;
    if coalesce(v_q.is_renewal, false) or coalesce(v_q.is_extension, false) or coalesce(v_q.is_add_seats, false) then
      raise exception 'Quote % is a renewal / extension / add-seats quote — it updates an existing subscription and must be invoiced on its own.', v_q.id;
    end if;
    if v_q.credit_activated_at is not null then
      raise exception 'Quote % was activated on credit — its subscriptions already exist. Invoice it on its own.', v_q.id;
    end if;
    if coalesce(v_q.discount_pct, 0) <> 0 then
      raise exception 'Quote % has a quote-level discount. Open it, Edit and Save once (the discount moves into the line rates), then combine.', v_q.id;
    end if;

    /* ── no money / activation attached anywhere ── */
    if exists (select 1 from public.payments p where p.quote_id = v_q.id) then
      raise exception 'Quote % has a payment or advance (receipt voucher) recorded. Only quotes with no money against them can be combined.', v_q.id;
    end if;
    if exists (select 1 from public.customer_credits cc where cc.source_quote_id = v_q.id) then
      raise exception 'Quote % has advance credit linked to it. Only quotes with no money against them can be combined.', v_q.id;
    end if;
    if exists (select 1 from public.coupon_redemptions cr where cr.quote_id = v_q.id) then
      raise exception 'Quote % used a coupon. It must be invoiced on its own.', v_q.id;
    end if;
    if exists (select 1 from public.subscriptions s where s.quote_id = v_q.id or s.renewal_quote_id = v_q.id) then
      raise exception 'Quote % already has subscriptions linked. It must be invoiced on its own.', v_q.id;
    end if;
    if exists (select 1 from public.provisioning_requests pr where pr.quote_id = v_q.id)
       or exists (select 1 from public.provisioning_tasks pt where pt.quote_id = v_q.id)
       or exists (select 1 from public.seat_requests sr where sr.quote_id = v_q.id) then
      raise exception 'Quote % already has provisioning / seat work started. It must be invoiced on its own.', v_q.id;
    end if;
    if exists (select 1 from public.referral_agreements ra where ra.quote_id = v_q.id) then
      raise exception 'Quote % has a referral agreement on it. It must be invoiced on its own.', v_q.id;
    end if;

    /* ── lines: shape, saved total = builder formula ── */
    if v_q.line_items is null or jsonb_typeof(v_q.line_items) <> 'array' or jsonb_array_length(v_q.line_items) = 0 then
      raise exception 'Quote % has no line items. Only quotes with lines can be combined.', v_q.id;
    end if;
    if exists (select 1 from jsonb_array_elements(v_q.line_items) e where jsonb_typeof(e) <> 'object') then
      raise exception 'Quote % has a damaged line. Open it, Edit and Save once, then combine.', v_q.id;
    end if;
    select coalesce(sum(round(coalesce((e->>'qty')::numeric, 0) * coalesce((e->>'rate')::numeric, 0))), 0),
           coalesce(sum(round(coalesce((e->>'qty')::numeric, 0) * coalesce((e->>'rate')::numeric, 0)
                              * coalesce((e->>'discount_pct')::numeric, 0) / 100)), 0)
      into v_gross, v_ldisc
      from jsonb_array_elements(v_q.line_items) e;
    v_sub := v_gross - v_ldisc;
    v_tax := round(v_sub * coalesce(v_q.tax_rate, 18) / 100.0);
    if v_q.subtotal is distinct from v_sub::int or v_q.amount is distinct from (v_sub + v_tax)::int then
      raise exception 'Quote %''s saved total (₹%) does not match its lines (₹%). Open it, Edit and Save once, then combine.',
        v_q.id, coalesce(v_q.amount, 0), (v_sub + v_tax);
    end if;
    v_sum_amt := v_sum_amt + v_q.amount;
    v_sum_sub := v_sum_sub + v_q.subtotal;

    /* ── activation: what record_payment would do differently on one merged quote ── */
    v_has_sub := false;
    for v_line in select e from jsonb_array_elements(v_q.line_items) e loop
      if v_line ? 'commitment' and v_line->>'commitment' is not null then
        v_has_sub := true;
        if coalesce((v_line->>'bulk')::boolean, false)
           and jsonb_typeof(v_line->'domains') = 'array' then
          for v_dom in select lower(btrim(d->>'domain')) from jsonb_array_elements(v_line->'domains') d loop
            continue when coalesce(v_dom, '') = '';
            v_key := v_dom || '|' || lower(coalesce(v_line->>'name', ''));
            if v_key = any(v_keys) and v_keys_q[array_position(v_keys, v_key)] <> v_q.id then
              raise exception 'Quote % and quote % both have % for %. One quote can hold a plan for a domain only once — invoice them separately.',
                v_keys_q[array_position(v_keys, v_key)], v_q.id, coalesce(v_line->>'name', 'a plan'), v_dom;
            end if;
            v_keys := v_keys || v_key; v_keys_q := v_keys_q || v_q.id::text;
          end loop;
        elsif nullif(lower(btrim(coalesce(v_line->>'domain', ''))), '') is not null then
          v_key := lower(btrim(v_line->>'domain')) || '|' || lower(coalesce(v_line->>'name', ''));
          if v_key = any(v_keys) and v_keys_q[array_position(v_keys, v_key)] <> v_q.id then
            raise exception 'Quote % and quote % both have % for %. One quote can hold a plan for a domain only once — invoice them separately.',
              v_keys_q[array_position(v_keys, v_key)], v_q.id, coalesce(v_line->>'name', 'a plan'), lower(btrim(v_line->>'domain'));
          end if;
          v_keys := v_keys || v_key; v_keys_q := v_keys_q || v_q.id::text;
        else
          /* borrows the quote's (or customer's) domain on payment */
          if v_borrow_q is not null and v_borrow_q <> v_q.id then
            raise exception 'Quotes % and % both have products with no domain on the line. Add the domain on each line (Edit quote), then combine.',
              v_borrow_q, v_q.id;
          end if;
          v_borrow_q := v_q.id;
        end if;
      end if;
    end loop;
    if v_has_sub then
      if v_sub_dom_q is null then
        v_sub_dom := v_q.qdom; v_sub_dom_q := v_q.id;
      elsif v_sub_dom <> v_q.qdom then
        raise exception 'Quote % is for domain % and quote % for %. Quotes for different domains cannot be combined — the order would go to one domain.',
          v_sub_dom_q, coalesce(nullif(v_sub_dom, ''), '(none)'), v_q.id, coalesce(nullif(v_q.qdom, ''), '(none)');
      end if;
    end if;

    /* ── gather lines (fresh id for a repeated line id) ── */
    for v_line in select e from jsonb_array_elements(v_q.line_items) e loop
      if coalesce(v_line->>'id', '') = '' or (v_line->>'id') = any(v_line_ids) then
        v_line := v_line || jsonb_build_object('id', gen_random_uuid()::text);
      end if;
      v_line_ids := v_line_ids || (v_line->>'id');
      v_lines := v_lines || jsonb_build_array(v_line);
    end loop;

    v_seats := v_seats + coalesce(v_q.seats, 0);
    if v_q.lead_id is distinct from v_lead then v_lead_mixed := true; end if;
    if v_terms is null then v_terms := nullif(btrim(coalesce(v_q.terms_conditions, '')), ''); end if;
    if v_q.expires_date is not null and (v_expires is null or v_q.expires_date > v_expires) then
      v_expires := v_q.expires_date;
    end if;
    if v_domain is null then v_domain := nullif(btrim(coalesce(v_q.domain, '')), ''); end if;
    if v_q.approval_status::text = 'approved' then
      v_appr_any := true;
      if v_q.approval_tier::text = 'owner' or v_appr_tier is null then v_appr_tier := v_q.approval_tier; end if;
      if v_appr_at is null or v_q.approved_at > v_appr_at then
        v_appr_at := v_q.approved_at; v_appr_by := v_q.approved_by;
      end if;
      v_appr_disc := greatest(v_appr_disc, v_q.approved_discount_bps);
      v_appr_marg := least(v_appr_marg, v_q.approved_margin_bps);
    end if;
  end loop;

  if public.quote_line_terms_mixed(v_lines) then
    raise exception 'One quote = one billing term: these quotes mix a monthly flex line with annual lines. Invoice the monthly quote on its own.'
      using errcode = 'check_violation';
  end if;

  /* Totals of the combined lines — the builder's formula (quote-builder.tsx). */
  select coalesce(sum(round(coalesce((e->>'qty')::numeric, 0) * coalesce((e->>'rate')::numeric, 0))), 0),
         coalesce(sum(round(coalesce((e->>'qty')::numeric, 0) * coalesce((e->>'rate')::numeric, 0)
                            * coalesce((e->>'discount_pct')::numeric, 0) / 100)), 0),
         coalesce(sum(round(coalesce((e->>'qty')::numeric, 0) * coalesce((e->>'cost')::numeric, 0))), 0)
    into v_gross, v_ldisc, v_cost
    from jsonb_array_elements(v_lines) e;
  v_sub := v_gross - v_ldisc;
  v_tax := round(v_sub * coalesce(v_first.tax_rate, 18) / 100.0);
  if v_sub <> v_sum_sub then
    raise exception 'Combined lines (₹%) do not add up to the quotes (₹%). Nothing was changed.', v_sub, v_sum_sub;
  end if;
  if v_sub + v_tax <= 0 then
    raise exception 'The combined quote would be ₹0 — nothing to invoice.';
  end if;

  v_new_id := public.next_document_number('quote', v_tenant, v_today);
  if v_new_id is null then
    raise exception 'Could not allocate a quote number. Nothing was changed — try again.';
  end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, lead_id, owner_id, plan, seats,
    amount, subtotal, total_cost, discount_pct, tax_rate, line_items,
    status, payment_status, created_date, expires_date, notes,
    domain, currency, exchange_rate, fx_source, fx_date, is_one_off, billing_cycle,
    payment_terms_days, terms_conditions,
    approval_status, approval_tier, approved_by, approved_at, approved_discount_bps, approved_margin_bps
  ) values (
    v_new_id, v_tenant, v_first.customer_id, v_first.customer_name,
    case when v_lead_mixed then null else v_lead end, v_first.owner_id,
    v_lines->0->>'name', v_seats,
    (v_sub + v_tax)::int, v_sub::int, v_cost::int, 0, v_first.tax_rate, v_lines,
    'accepted', 'awaiting', v_today, greatest(coalesce(v_expires, v_today), v_today),
    'Combined from ' || array_to_string(v_ids, ', ') || ' (R-1527).',
    v_domain, coalesce(v_first.currency, 'INR'), coalesce(v_first.exchange_rate, 1),
    v_first.fx_source, v_first.fx_date, coalesce(v_first.is_one_off, false), v_first.billing_cycle,
    v_first.payment_terms_days, v_terms,
    case when v_appr_any then 'approved' else 'not_required' end::public.quote_approval_status,
    case when v_appr_any then v_appr_tier else null end,
    case when v_appr_any then v_appr_by else null end,
    case when v_appr_any then v_appr_at else null end,
    case when v_appr_any then v_appr_disc else null end,
    case when v_appr_any then v_appr_marg else null end
  );

  update public.quotes q
     set status        = 'expired',
         superseded_by = v_new_id,
         superseded_at = now(),
         notes         = concat_ws(E'\n', nullif(btrim(coalesce(q.notes, '')), ''),
                           'Combined into ' || v_new_id || ' on ' || to_char(v_today, 'DD Mon YYYY') || ' (R-1527) — invoice that quote.')
   where q.id = any(v_ids) and q.tenant_id = v_tenant;

  return jsonb_build_object(
    'quote_id', v_new_id,
    'combined', to_jsonb(v_ids),
    'subtotal', v_sub::int,
    'tax', v_tax::int,
    'amount', (v_sub + v_tax)::int,
    'sum_of_quotes', v_sum_amt::int);
end;
$function$;

comment on function public.combine_quotes(text[]) is
  'R-1527: several accepted, unpaid, un-invoiced quotes of one customer → ONE new accepted quote (next_document_number quote); originals expired + superseded_by. Then generate_invoice runs on the new quote unchanged. Owner/manager/accountant/billing; tenant-guarded, fail-closed; all or nothing.';

revoke all on function public.combine_quotes(text[]) from public, anon;
grant execute on function public.combine_quotes(text[]) to authenticated, service_role;

commit;
