-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.create_renewal_quote_together(uuid,jsonb)') and prosrc like '%renew it with Review renewal quote on its row%')
-- deploy-key: r2852togetherrefusesdomainhosting
--
-- R-2852 (15 Nov 2026, p1 money; rev-r2849 H1 follow-up). create_renewal_quote_together refuses a DOMAIN or HOSTING
-- subscription, in plain words: "<plan> is a domain renewal — renew it with Review renewal quote on its row."
--
-- Why: a domain renews at ResellerClub's LIVE renewal price (createDomainRenewalQuote), and a paid domain / hosting
-- renewal must queue the registrar renewal / DMS extension for THAT subscription. A together quote prices every part
-- from the stored mrr and renews by link rows, so a domain on it could be under-billed and the real domain could
-- lapse while the app shows it renewed. R-2849 keeps them out of Bill together's box; a money role can still call
-- this RPC directly, so the database refuses too (also on the same-set relink path: an old quote is never handed back
-- for them).
--
-- CREATE OR REPLACE with the SAME signature (uuid, jsonb), from the LATEST body (R-2848,
-- 20261115134526_r2848_renewal_together_payment.sql §10) — never an overload (gen-deploy-db matches by name).
-- Only change: the vendor check after the row locks / customer re-check. Grants unchanged (R-401 / R-2389 / R-1560).

create or replace function public.create_renewal_quote_together(
  p_tenant_id uuid,
  p_parts     jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2847: ONE renewal quote for 2+ yearly subscriptions of one customer — see the migration header.
   R-2848 (rev-r2847): tax_rate one of 0/5/12/18/28 (MED-1); each line qty > 0, rate >= 0, item_id empty or this
   company's own item (LOW-4); one customer re-checked after the row locks (LOW-6).
   R-2852: a domain or hosting subscription is refused (it renews on its own quote). */
declare
  v_trusted  boolean;
  v_caller   uuid := public.current_tenant_id();
  v_tenant   uuid;
  v_ids      uuid[];
  v_sorted   uuid[];
  v_n        integer;
  v_ncust    integer;
  v_customer uuid;
  v_names    text;
  v_p        record;
  v_s        record;
  v_q        jsonb;
  v_lines    jsonb := '[]'::jsonb;
  v_l        jsonb;
  v_i        integer;
  v_rates    integer[] := '{}'::integer[];
  v_rate     integer;
  v_subtotal integer := 0;
  v_part_sub integer;
  v_part_amt integer;
  v_seats    integer := 0;
  v_pseats   integer;
  v_cost     integer := 0;
  v_months   integer;
  v_cut      public.subscription_seat_reductions%rowtype;
  v_plans    text[] := '{}'::text[];
  v_expires  date;
  v_lead     record;
  v_has_lead boolean := false;
  v_found    text;
  v_other    text;
  v_relinked boolean := false;
  v_tax      integer;
  v_amount   integer;
  v_id       text;
  v_today    date := public.ist_today();
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can make a renewal quote.' using errcode = '42501';
  end if;
  if p_tenant_id is null or (v_caller is not null and p_tenant_id is distinct from v_caller) then
    raise exception 'A subscription to renew was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end if;
  v_tenant := p_tenant_id;

  /* Not ready gate (see the header). */
  if not public.r2847_together_payment_ready() then
    raise exception 'One renewal quote for several yearly subscriptions is not ready on this server yet — make each renewal quote on its own for now.'
      using errcode = '0A000';
  end if;

  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then
    raise exception 'Pick at least two subscriptions to renew together.' using errcode = '22023';
  end if;
  /* The subscriptions, each once, in the order asked (the first leads the quote's name and domain). */
  begin
    select array_agg(t.id order by t.n) into v_ids
      from (select (e->>'subscription_id')::uuid as id, min(o) as n
              from jsonb_array_elements(p_parts) with ordinality x(e, o)
             where jsonb_typeof(e) = 'object' and nullif(e->>'subscription_id', '') is not null
             group by 1) t;
  exception when invalid_text_representation then
    raise exception 'A subscription to renew was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end;
  if coalesce(cardinality(v_ids), 0) < 2 then
    raise exception 'Pick at least two subscriptions to renew together.' using errcode = '22023';
  end if;
  if cardinality(v_ids) <> jsonb_array_length(p_parts) then
    raise exception 'Each subscription can be on the quote only once — pick each one once.' using errcode = '22023';
  end if;
  /* Another company's subscription reads exactly like one that does not exist (no "is this id real?" oracle). */
  select count(*) into v_n from public.subscriptions s where s.id = any(v_ids) and s.tenant_id = v_tenant;
  if v_n < cardinality(v_ids) then
    raise exception 'A subscription to renew was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end if;
  select string_agg(s.plan, ', ' order by s.plan) into v_names
    from public.subscriptions s where s.id = any(v_ids) and s.customer_id is null;
  if v_names is not null then
    raise exception '% is not linked to a customer — link it to a customer first, then renew together.', v_names using errcode = '22023';
  end if;
  select count(distinct s.customer_id), min(s.customer_id::text)::uuid, string_agg(distinct coalesce(s.customer_name, '?'), ', ')
    into v_ncust, v_customer, v_names
    from public.subscriptions s where s.id = any(v_ids);
  if v_ncust <> 1 then
    raise exception 'Subscriptions of different customers cannot be on one renewal quote (%) — renew together only one customer''s subscriptions.', v_names
      using errcode = '22023';
  end if;

  /* Two calls at once: one at a time per customer, then the subscriptions' rows in id order. */
  perform pg_advisory_xact_lock(hashtextextended('r2847:renewal-together:' || v_tenant::text || ':' || v_customer::text, 0));
  perform 1 from public.subscriptions s where s.id = any(v_ids) order by s.id for update;
  select array_agg(x order by x) into v_sorted from unnest(v_ids) x;
  /* R-2848 (rev-r2847 LOW-6): the customer read above was before the row locks — a subscription moved to another
     customer meanwhile is caught here. */
  if exists (select 1 from public.subscriptions s where s.id = any(v_ids) and s.customer_id is distinct from v_customer) then
    raise exception 'A subscription changed customer while this renewal quote was being made — refresh Renewals and try again.' using errcode = '22023';
  end if;
  /* R-2852 (rev-r2849 H1): a domain renews at the registrar's live price and a paid domain / hosting renewal queues
     the registrar renewal / DMS extension for that subscription — neither is done for a part of a together quote.
     Read under the row locks; before the same-set relink below, so an old together quote is never handed back. */
  select string_agg(s.plan || ' is a ' || s.vendor::text || ' renewal', '; ' order by s.plan) into v_names
    from public.subscriptions s where s.id = any(v_ids) and s.vendor::text in ('domain', 'hosting');
  if v_names is not null then
    raise exception '% — renew it with Review renewal quote on its row, not on one quote with other subscriptions.', v_names
      using errcode = '22023';
  end if;

  /* The same set again → that quote (a retry, a second click, a second tab); a lost link is put back. Only while EVERY
     subscription on it is still at the term it was quoted for, active and renewing (rev: one member moved or Won't
     renew → never relinked to an old term). */
  select l.quote_id into v_found
    from public.renewal_quote_subscriptions l
   where l.tenant_id = v_tenant and l.subscription_id = any(v_ids) and l.released_at is null
     /* an OPEN quote only — a closed one that took money still holds the terms (refused below), it is never handed
        back as "the quote" */
     and exists (select 1 from public.quotes qo where qo.id = l.quote_id and qo.cancelled_at is null
                   and qo.superseded_by is null and qo.status::text not in ('rejected', 'expired'))
     and v_sorted = (select array_agg(l2.subscription_id order by l2.subscription_id)
                       from public.renewal_quote_subscriptions l2 where l2.quote_id = l.quote_id and l2.released_at is null)
     and not exists (select 1 from public.renewal_quote_subscriptions l3
                       join public.subscriptions s3 on s3.id = l3.subscription_id
                      where l3.quote_id = l.quote_id and l3.released_at is null
                        and (s3.renewal_date is distinct from l3.renewal_term_date or s3.status::text <> 'active'
                             or s3.auto_renew is false))
   limit 1;
  if v_found is not null then
    select string_agg(s.plan || ' (' || s.renewal_quote_id || ')', ', ' order by s.plan) into v_other
      from public.subscriptions s
     where s.id = any(v_ids) and s.renewal_quote_id is not null and s.renewal_quote_id <> v_found
       and public.r2847_quote_live(s.renewal_quote_id);
    if v_other is not null then
      raise exception 'Another renewal quote is open for % — cancel it first; renewal quote % already renews these subscriptions together.', v_other, v_found
        using errcode = '22023';
    end if;
    update public.subscriptions s set renewal_quote_id = v_found
     where s.id = any(v_ids) and s.tenant_id = v_tenant
       and (s.renewal_quote_id is null or (s.renewal_quote_id <> v_found and not public.r2847_quote_live(s.renewal_quote_id)));
    v_relinked := found;
    select to_jsonb(q.*) into v_q from public.quotes q where q.id = v_found;
    return jsonb_build_object('quote_id', v_found, 'created', false, 'relinked', v_relinked, 'already_existed', true,
      'amount', v_q->'amount', 'subtotal', v_q->'subtotal', 'tax_rate', v_q->'tax_rate', 'discount_pct', v_q->'discount_pct',
      'line_items', v_q->'line_items', 'subscription_ids', to_jsonb(v_ids));
  end if;

  /* Each subscription, as asked. */
  for v_p in
    select (e->>'subscription_id')::uuid as sub_id, e->'quote' as q, o::int as n
      from jsonb_array_elements(p_parts) with ordinality x(e, o)
     order by o
  loop
    select s.id, s.plan, s.seats, s.status::text as status, s.billing_cycle::text as cycle, s.term_months, s.renewal_date,
           s.auto_renew, s.renewal_quote_id, s.customer_name, s.domain
      into v_s
      from public.subscriptions s where s.id = v_p.sub_id;
    if v_s.status <> 'active' then
      raise exception '% is % — only an active subscription can be renewed together.', v_s.plan, v_s.status using errcode = '22023';
    end if;
    if v_s.cycle is distinct from 'yearly' or coalesce(v_s.term_months, 12) <> 12 then
      raise exception '% is not a yearly subscription billed once a year — subscriptions billed in parts are billed together with Bill together on their parts.', v_s.plan
        using errcode = '22023';
    end if;
    if v_s.auto_renew is false then
      raise exception '% is marked Won''t renew — press Undo Won''t renew on the subscription first.', v_s.plan using errcode = '22023';
    end if;
    if v_s.renewal_date is null then
      raise exception '% has no renewal date — set it on the subscription first.', v_s.plan using errcode = '22023';
    end if;
    if v_s.renewal_quote_id is not null and public.r2847_quote_live(v_s.renewal_quote_id) then
      raise exception 'Renewal quote % is still open (or has money received on it) for % — cancel it or record the rest of the payment on it first, then renew together.', v_s.renewal_quote_id, v_s.plan
        using errcode = '22023';
    end if;
    select l.quote_id into v_other
      from public.renewal_quote_subscriptions l
     where l.subscription_id = v_s.id and l.renewal_term_date = v_s.renewal_date and l.released_at is null
       and public.r2847_quote_live(l.quote_id)
     limit 1;
    if v_other is not null then
      raise exception '% is already on renewal quote % (billed together with other subscriptions) — cancel % first, then renew together.', v_s.plan, v_other, v_other
        using errcode = '22023';
    end if;
    select q.id into v_other
      from public.quotes q
     where q.tenant_id = v_tenant and q.renewal_subscription_id = v_s.id and q.renewal_term_date = v_s.renewal_date
       and public.r2847_quote_live(q.id)
     limit 1;
    if v_other is not null then
      raise exception 'Renewal quote % was already made for % (due %) — cancel it first, then renew together.', v_other, v_s.plan, to_char(v_s.renewal_date, 'DD Mon YYYY')
        using errcode = '22023';
    end if;

    /* The app's price for this subscription's renewal (create_renewal_quote's rules). */
    v_q := v_p.q;
    if v_q is null or jsonb_typeof(v_q) <> 'object' then
      raise exception 'The renewal of % has no price, so no quote was made. Check the plan price in Items, then try again.', v_s.plan using errcode = '22023';
    end if;
    v_part_sub := nullif(v_q->>'subtotal', '')::integer;
    v_part_amt := nullif(v_q->>'amount', '')::integer;
    if v_part_sub is null or v_part_sub <= 0 or v_part_amt is null or v_part_amt <= 0 then
      raise exception 'The renewal of % has no price, so no quote was made. Check the plan price in Items, then try again.', v_s.plan using errcode = '22023';
    end if;
    if jsonb_typeof(v_q->'line_items') is distinct from 'array' or jsonb_array_length(v_q->'line_items') = 0 then
      raise exception 'The renewal of % has no line, so no quote was made. Try again from Renewals.', v_s.plan using errcode = '22023';
    end if;
    v_months := coalesce(nullif(v_q->>'extension_months', '')::integer, 12);
    if v_months <> 12 then
      raise exception 'The renewal of % is for % months — only one-year renewals can be on one quote together.', v_s.plan, v_months using errcode = '22023';
    end if;
    v_pseats := nullif(v_q->>'seats', '')::integer;
    /* R-2613 (rule N5), read under the row lock: a cut scheduled for this renewal → priced at the cut's seats. */
    v_cut := public.r2613_applying_seat_cut(v_tenant, v_s.id, v_s.seats, v_s.renewal_date);
    /* Coordinator decision (15 Nov): never trust the caller's seats — with no cut the part is for the subscription's
       own seats (createRenewalQuote's quoteSeats), and its lines' qty add up to them. */
    if v_cut.id is null and v_pseats is distinct from v_s.seats
       and not public.r2613_removed_seat_cut(v_tenant, v_s.id, v_s.seats, v_s.renewal_date, v_pseats) then
      raise exception 'The renewal of % was priced for % seats, but the subscription has % seats, so no quote was made. Try again from Renewals.',
        v_s.plan, coalesce(v_pseats::text, 'unknown'), v_s.seats using errcode = '22023';
    end if;
    if (select sum(coalesce(nullif(e->>'qty', '')::numeric, 1)) from jsonb_array_elements(v_q->'line_items') e
         where jsonb_typeof(e) = 'object') is distinct from v_pseats::numeric then
      raise exception 'The renewal of % does not add up (its lines are not for % seats), so no quote was made. Try again from Renewals.',
        v_s.plan, coalesce(v_pseats::text, 'unknown') using errcode = '22023';
    end if;
    if v_cut.id is not null and v_pseats is distinct from v_cut.seats_after then
      raise exception 'A seat cut to % seats is scheduled for % on % while its renewal was priced for % seats, so no quote was made. Try again — it is priced with the cut.',
        v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY'), v_s.plan, coalesce(v_pseats::text, 'unknown')
        using errcode = 'check_violation';
    end if;
    if v_cut.id is null and public.r2613_removed_seat_cut(v_tenant, v_s.id, v_s.seats, v_s.renewal_date, v_pseats) then
      raise exception 'The seat cut to % seats on % was removed while its renewal was being priced, so no quote was made. Try again — it is priced for % seats.',
        v_pseats, v_s.plan, v_s.seats
        using errcode = 'check_violation';
    end if;

    /* R-2848 (rev-r2847 MED-1): only an Indian GST rate. */
    if coalesce(nullif(v_q->>'tax_rate', '')::integer, 18) not in (0, 5, 12, 18, 28) then
      raise exception 'The renewal of % has GST at % — only 0, 5, 12, 18 or 28%% can be on a quote. Check the plan''s GST in Items, then try again.',
        v_s.plan, (v_q->>'tax_rate') || '%' using errcode = '22023';
    end if;
    /* R-2848 (rev-r2847 LOW-4): every line for at least one seat at a price of 0 or more, and an item of this company. */
    if exists (select 1 from jsonb_array_elements(v_q->'line_items') e
                where jsonb_typeof(e) = 'object'
                  and (coalesce(nullif(e->>'qty', '')::numeric, 1) <= 0
                       or coalesce(nullif(e->>'rate', '')::numeric, 0) < 0
                       or (nullif(e->>'item_id', '') is not null
                           and not exists (select 1 from public.items i where i.id = e->>'item_id' and i.tenant_id = v_tenant)))) then
      raise exception 'The renewal of % has a line with no seats, a price below 0 or an item that is not in your Items, so no quote was made. Try again from Renewals.',
        v_s.plan using errcode = '22023';
    end if;
    v_rates := v_rates || coalesce(nullif(v_q->>'tax_rate', '')::integer, 18);
    v_subtotal := v_subtotal + v_part_sub;
    v_seats := v_seats + coalesce(v_pseats, 0);
    v_cost := v_cost + coalesce(nullif(v_q->>'total_cost', '')::integer, 0);
    v_plans := v_plans || coalesce(nullif(v_q->>'plan', ''), v_s.plan);
    v_expires := least(coalesce(v_expires, nullif(v_q->>'expires_date', '')::date), nullif(v_q->>'expires_date', '')::date);
    if not v_has_lead then
      v_lead := v_s;
      v_has_lead := true;
    end if;
    /* rev: the lines must add up to the part's subtotal (qty × rate, as createRenewalQuote builds them), and the part's
       amount must be that subtotal + its GST (±₹1 rounding) — a quote whose lines show another price than it charges
       is refused. */
    if exists (select 1 from jsonb_array_elements(v_q->'line_items') e where jsonb_typeof(e) <> 'object') then
      raise exception 'The renewal of % has a broken line, so no quote was made. Try again from Renewals.', v_s.plan using errcode = '22023';
    end if;
    begin
      if (select round(sum(coalesce(nullif(e->>'qty', '')::numeric, 1) * coalesce(nullif(e->>'rate', '')::numeric, 0)))
            from jsonb_array_elements(v_q->'line_items') e) is distinct from v_part_sub
         or abs(v_part_amt - (v_part_sub + round(v_part_sub * coalesce(nullif(v_q->>'tax_rate', '')::integer, 18) / 100.0))) > 1 then
        raise exception 'The renewal of % does not add up (its lines, subtotal ₹% and amount ₹% differ), so no quote was made. Try again from Renewals.',
          v_s.plan, v_part_sub, v_part_amt using errcode = '22023';
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'The renewal of % has a broken line, so no quote was made. Try again from Renewals.', v_s.plan using errcode = '22023';
    end;
    v_i := 0;
    for v_l in select e from jsonb_array_elements(v_q->'line_items') e loop
      v_i := v_i + 1;
      /* security review: only the keys createRenewalQuote builds are kept — a caller-sent billing_id / plan_change /
         bulk / one_time / years key would make other money code (part-request guards, record_payment's plan-change
         and bulk paths, R-2710 years) read this quote as something it is not. */
      v_l := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(v_l) x(k, v)
               where k in ('name', 'description', 'item_id', 'qty', 'rate', 'cost', 'commitment', 'hsn', 'sac', 'unit'));
      v_lines := v_lines || jsonb_build_array(v_l || jsonb_build_object(
        'id',                'renewal-' || v_p.n::text || '-' || v_i::text,
        'subscription_id',   v_s.id::text,
        'renewal_term_date', v_s.renewal_date,
        'period_start',      v_s.renewal_date,
        'period_end',        ((v_s.renewal_date + make_interval(months => v_months))::date - 1)));
    end loop;
  end loop;

  if (select count(distinct r) from unnest(v_rates) r) > 1 then
    raise exception 'Subscriptions with different GST rates cannot be on one renewal quote (%) — make their renewal quotes separately.',
      (select string_agg(distinct r::text || '%', ' and ') from unnest(v_rates) r) using errcode = '22023';
  end if;
  v_rate   := v_rates[1];
  v_tax    := round(v_subtotal * v_rate / 100.0);
  v_amount := v_subtotal + v_tax;

  /* A closed together quote (no money on it) no longer holds its subscriptions' terms: ALL its rows are released
     together (kept as history, never deleted). */
  update public.renewal_quote_subscriptions l
     set released_at = now()
   where l.tenant_id = v_tenant and l.released_at is null
     and l.quote_id in (select l2.quote_id from public.renewal_quote_subscriptions l2
                         where l2.tenant_id = v_tenant and l2.subscription_id = any(v_ids) and l2.released_at is null)
     and not public.r2847_quote_live(l.quote_id);

  v_id := public.next_document_number('quote', v_tenant);
  if v_id is null then
    raise exception 'No quote number could be issued, so no renewal quote was made. Check Settings → Document numbering, then try again.' using errcode = 'P0001';
  end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    owner_id, domain, created_date, expires_date, line_items, subtotal, total_cost,
    discount_pct, tax_rate, is_renewal, extension_months, notes,
    renewal_subscription_id, renewal_term_date
  ) values (
    v_id, v_tenant, v_customer, v_lead.customer_name, array_to_string(v_plans, ' + '), v_seats, v_amount, 'sent', 'awaiting',
    null, v_lead.domain, v_today, v_expires, v_lines, v_subtotal, v_cost,
    0, v_rate, true, 12,
    'Renewal of ' || array_to_string(v_plans, ' + ') || ' — billed together on one quote.',
    null, null
  );

  insert into public.renewal_quote_subscriptions
    (tenant_id, quote_id, subscription_id, renewal_term_date, extension_months, subtotal, seats, line_no)
  select v_tenant, v_id, s.id, s.renewal_date, 12, nullif(e->'quote'->>'subtotal', '')::integer,
         nullif(e->'quote'->>'seats', '')::integer, o::int
    from jsonb_array_elements(p_parts) with ordinality x(e, o)
    join public.subscriptions s on s.id = (e->>'subscription_id')::uuid;

  update public.subscriptions s set renewal_quote_id = v_id
   where s.id = any(v_ids) and s.tenant_id = v_tenant;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, public.current_user_id(), 'quote.renewal_together', 'quote', v_id,
          left(format('Renewal quote %s for %s together', v_id, array_to_string(v_plans, ' + ')), 120),
          jsonb_build_object('subscription_ids', to_jsonb(v_ids), 'subtotal', v_subtotal, 'tax_rate', v_rate, 'amount', v_amount));

  return jsonb_build_object('quote_id', v_id, 'created', true, 'relinked', false, 'already_existed', false,
    'amount', v_amount, 'subtotal', v_subtotal, 'tax_rate', v_rate, 'tax', v_tax, 'discount_pct', 0,
    'line_items', v_lines, 'subscription_ids', to_jsonb(v_ids));
end;
$$;
revoke all on function public.create_renewal_quote_together(uuid, jsonb) from public, anon;
grant execute on function public.create_renewal_quote_together(uuid, jsonb) to authenticated, service_role;
