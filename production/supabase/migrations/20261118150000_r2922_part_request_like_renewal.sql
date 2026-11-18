-- deploy-peek: to_regprocedure('public.r2922_part_seat_cost(uuid,text,integer,integer,integer)') is not null and to_regprocedure('public.r2922_part_line_cost(uuid,text,integer,integer,integer,integer)') is not null and to_regprocedure('public.r2922_part_whole_months(date,integer,date,date,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)') and prosrc like '%R-2922%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_parts_together(uuid[])') and prosrc like '%R-2922%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.set_part_request_terms(text,integer,integer)') and prosrc like '%R-2922%')
-- deploy-key: r2922partrequestlikerenewal
-- 20261118150000_r2922_part_request_like_renewal.sql
--
-- R-2922 (18 Nov 2026, Pardeep — staging Q-A378-27-0124 Ravi Shankar: "ye renewal quotation ki tarah jaye").
--
-- ─── BEFORE ───────────────────────────────────────────────────────────────────────────────────────
-- A month-wise (part) payment request and a normal renewal quotation are built differently:
--   renewal quote Q-A378-27-0958   line {name: product, item_id: catalogue item, qty: seats, rate: a seat, cost: a seat}
--   part proforma PI-A378-27-0007  line {name: product · domain · seats · period (part n of N), qty: seats, rate: a seat
--                                        (R-2519), cost: 0, no item_id} and total_cost 0
-- So a part request's margin read "unknown" in the stored figures (the quote page worked a cost out on screen,
-- R-2423 (4)) and the line did not name its catalogue item.
--
-- ─── AFTER (NEW requests only — no stored row is rewritten) ───────────────────────────────────────
-- * Each line of a new part request carries
--     item_id  the subscription's catalogue item (subscriptions.item_id), when it has one — as the renewal
--              quote's line does (create-renewal-quote.ts: only the subscription's own item_id, never a name match);
--     cost     our cost by the renewal quote's catalogue rule (lib/renewals/renewal-catalog-cost.ts
--              renewalCatalogCost): the item's wholesale a seat a month — the monthly tier for a Flexible
--              (1-month) term, else the volume slab for these seats, else the annual tier / the row's wholesale —
--              × the part's months. On a per-seat line (qty = seats) it is the cost of ONE seat; on a lump line
--              (qty 1, the amount does not divide by the seats — R-2519) it is the whole line's cost.
--              0 = unknown, never a guess: no catalogue item, a row not priced per month (per year / one-time /
--              a yearly total), no ₹ wholesale, or a part that is not one whole billing cycle of its term.
--   and the request's total_cost = Σ cost × qty.
-- * set_part_request_terms (seats / rate changed on an unpaid proforma): the line takes the cost for the NEW
--   seats (the slab can change) and total_cost follows.
-- * NOT changed: amounts, GST, rounding, the line's name (R-2423), description / notes label (R-2865), qty and
--   rate (R-2519), periods, due dates, links, locks, guards, refusals, and the payment → tax invoice path. The
--   line stays one_time (it never files a subscription — quote_line_is_subscription rule 1) and carries no
--   commitment.
-- * NOT set: quotes.is_renewal. That flag is read by the whole-term renewal money paths — the invoice line's
--   service period (R-2744: extension_months from the renewal date), the P&L revenue matching (R-2624) and
--   file_invoiced_quote_subscriptions — and a part request is one part of a term, not a whole-term renewal.
--   The screens already call it a renewal from the part itself (quote-kind.ts partKind: "Renewal · Part 2 of
--   12 · Oct 2026").
-- * NOT changed: the part's tax invoice lines (raise_subscription_billing → r2101_part_line) — they do not copy
--   the request's lines and still carry cost 0.
-- Bodies: bill_subscription_instalment and bill_parts_together from 20261116140831 (R-2865, the latest);
-- set_part_request_terms from 20261106074318 (R-2519b, the latest). Signatures unchanged, grants restated.
-- Test: supabase/tests/r2922_part_request_like_renewal.test.sql (one transaction, rolled back).

begin;

-- ── 1. The cost of a part, by the renewal quote's catalogue rule ───────────────────────────────────

/* Months a part covers — only when it is exactly ONE whole billing cycle on its term's anchor
   (lib/quotes/part-cost.ts partWholeMonths); else null (a short / co-termed part: cost unknown). */
create or replace function public.r2922_part_whole_months(
  p_term_start date, p_index integer, p_start date, p_end date, p_cycle text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case when c.step is not null and p_term_start is not null and coalesce(p_index, 0) >= 1
                   and (p_term_start + make_interval(months => (p_index - 1) * c.step))::date = p_start
                   and (p_term_start + make_interval(months => p_index * c.step))::date = p_end
              then c.step end
    from (select case p_cycle when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6 when 'yearly' then 12 end as step) c;
$$;
revoke all on function public.r2922_part_whole_months(date, integer, date, date, text) from public, anon;
grant execute on function public.r2922_part_whole_months(date, integer, date, date, text) to authenticated, service_role;   -- pure: no table read

/* ₹ one seat costs us for p_part_months of this catalogue item — 0 = unknown. The renewal quote's rule
   (renewalCatalogCost) for a row priced per month: the monthly tier for a Flexible (1-month) term; else the
   volume slab covering these seats (a broken slab table = no slabs, as validateSlabs), else the annual tier
   (the monthly one when there is no annual), else the row's own wholesale. Whole rupees. */
create or replace function public.r2922_part_seat_cost(
  p_tenant uuid, p_item_id text, p_seats integer, p_term_months integer, p_part_months integer)
returns integer
language plpgsql
stable
set search_path = public
as $$
declare
  v_i       record;
  v_pr      jsonb;
  v_unit    text;
  v_yearly  boolean;
  v_slabs   jsonb;
  v_tier    jsonb;
  v_rate    numeric;
begin
  if p_tenant is null or nullif(btrim(coalesce(p_item_id, '')), '') is null
     or coalesce(p_seats, 0) <= 0 or coalesce(p_part_months, 0) <= 0 then
    return 0;
  end if;
  select i.msrp, i.wholesale, i.prices, i.item_type, i.vendor::text as vendor into v_i
    from public.items i where i.tenant_id = p_tenant and i.id = p_item_id;
  if not found then return 0; end if;
  v_pr := case when jsonb_typeof(v_i.prices) = 'object' then v_i.prices else '{}'::jsonb end;

  /* The row's billing unit (lib/catalog/billing-unit.ts billingUnitOf) — only a per-month row is priced here. */
  v_yearly := jsonb_typeof(v_pr->'annual_total'->'msrp') = 'number' and (v_pr->'annual_total'->>'msrp')::numeric > 0
              and not coalesce(v_i.msrp, 0) > 0;
  v_unit := case when v_pr->>'billing_unit' in ('seat_month', 'unit_month', 'unit_year', 'one_time') then v_pr->>'billing_unit'
                 when v_i.item_type = 'one_time' then 'one_time'
                 when v_yearly then 'unit_year'
                 when v_i.vendor in ('hosting', 'support') then 'unit_month'
                 else 'seat_month' end;
  if v_unit not in ('seat_month', 'unit_month') or v_yearly then
    return 0;
  end if;

  if coalesce(p_term_months, 12) <= 1 then
    /* Flexible: the monthly tier, else the row's wholesale. */
    v_rate := case when jsonb_typeof(v_pr->'monthly'->'wholesale') = 'number' then (v_pr->'monthly'->>'wholesale')::numeric
                   else v_i.wholesale end;
  else
    /* flat: the annual tier (else the monthly) when it has a price, else the row's own */
    v_tier := case when jsonb_typeof(v_pr->'annual') = 'object' then v_pr->'annual'
                   when jsonb_typeof(v_pr->'monthly') = 'object' then v_pr->'monthly' end;
    v_rate := case when v_tier is not null and jsonb_typeof(v_tier->'msrp') = 'number' and (v_tier->>'msrp')::numeric > 0
                        and jsonb_typeof(v_tier->'wholesale') = 'number'
                   then (v_tier->>'wholesale')::numeric else v_i.wholesale end;
    /* the volume slab for these seats — only from a clean table (starts at 1, no gap, no overlap, no negative) */
    v_slabs := case when jsonb_typeof(v_pr->'slabs') = 'array' and jsonb_array_length(v_pr->'slabs') > 0 then v_pr->'slabs' end;
    if v_slabs is not null
       and not exists (select 1 from jsonb_array_elements(v_slabs) e
                        where jsonb_typeof(e) <> 'object'
                           or jsonb_typeof(e->'minSeats') is distinct from 'number'
                           or jsonb_typeof(e->'msrp') is distinct from 'number'
                           or jsonb_typeof(e->'wholesale') is distinct from 'number'
                           or coalesce(jsonb_typeof(e->'maxSeats'), 'missing') not in ('number', 'null'))
       and not exists (
             select 1 from (
               select (e->>'minSeats')::numeric as mn,
                      case when jsonb_typeof(e->'maxSeats') = 'number' then (e->>'maxSeats')::numeric end as mx,
                      (e->>'msrp')::numeric as msrp, (e->>'wholesale')::numeric as wh,
                      row_number() over (order by (e->>'minSeats')::numeric) as rn,
                      lead((e->>'minSeats')::numeric) over (order by (e->>'minSeats')::numeric) as next_mn,
                      count(*) over () as n
                 from jsonb_array_elements(v_slabs) e) s
              where (s.rn = 1 and s.mn <> 1) or s.mn < 1 or (s.mx is not null and s.mx < s.mn) or s.msrp < 0 or s.wh < 0
                 or (s.rn < s.n and (s.mx is null or s.next_mn > s.mx + 1 or s.next_mn <= s.mx))) then
      select (e->>'wholesale')::numeric into v_rate
        from jsonb_array_elements(v_slabs) with ordinality t(e, k)
       where p_seats >= (e->>'minSeats')::numeric
         and (jsonb_typeof(e->'maxSeats') = 'null' or p_seats <= (e->>'maxSeats')::numeric)
       order by k limit 1;
      if not found then
        /* no band covers these seats → the flat price (slabPricing) */
        v_rate := case when v_tier is not null and jsonb_typeof(v_tier->'msrp') = 'number' and (v_tier->>'msrp')::numeric > 0
                            and jsonb_typeof(v_tier->'wholesale') = 'number'
                       then (v_tier->>'wholesale')::numeric else v_i.wholesale end;
      end if;
    end if;
  end if;

  if v_rate is null or v_rate <= 0 then return 0; end if;
  return round(v_rate * p_part_months)::integer;
end;
$$;
revoke all on function public.r2922_part_seat_cost(uuid, text, integer, integer, integer) from public, anon;
grant execute on function public.r2922_part_seat_cost(uuid, text, integer, integer, integer) to authenticated, service_role;   -- invoker: reads items under the caller's own RLS

/* The `cost` a part request's line stores (a quote line's cost is per unit of its qty): one seat's cost on a
   per-seat line (qty = seats — r2519_per_seat), the whole line's cost on a lump line (qty 1). 0 = unknown. */
create or replace function public.r2922_part_line_cost(
  p_tenant uuid, p_item_id text, p_seats integer, p_taxable integer, p_term_months integer, p_part_months integer)
returns integer
language sql
stable
set search_path = public
as $$
  select case when public.r2519_per_seat(coalesce(p_seats, 0), p_taxable) then c.seat else c.seat * coalesce(p_seats, 0) end
    from (select public.r2922_part_seat_cost(p_tenant, p_item_id, p_seats, p_term_months, p_part_months) as seat) c;
$$;
revoke all on function public.r2922_part_line_cost(uuid, text, integer, integer, integer, integer) from public, anon;
grant execute on function public.r2922_part_line_cost(uuid, text, integer, integer, integer, integer) to authenticated, service_role;   -- invoker: reads items under the caller's own RLS

-- ── 2. Bill next part — body of 20261116140831 (R-2865), lines with item_id + cost ─────────────────
create or replace function public.bill_subscription_instalment(p_billing_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2922: a new request's line is built like a renewal quotation's line — it carries the subscription's catalogue item (item_id) and our cost (r2922_part_line_cost: the renewal quote's catalogue rule for the part's months; 0 = unknown), and the request its total_cost. Amounts, GST, names, labels, periods and links are unchanged; the request is still not an is_renewal quote. R-2527: trusts only the login, never a role claim. R-2044: invoice a paid part or make its payment request — once. R-2048: the sale quote's first part only when money covers it; an open unpaid sale quote IS its request. R-2092: the quote's parts for one period are ONE group — one invoice, one request, the quote's money pool; none billed while a sibling's parts are not laid (R-2092 siblings laid). R-2095: a part freed by credit notes is billed afresh. R-2095 (Sept): the first part of a sale booked from a bank receipt (invoice_on_receipt) is invoiced once any money came in. R-2230: a new request is due on the part start + the payment terms (customer, else the sale quote, else 0 — prepaid, R-2044), stored on its parts (subscription_billings.due_on). R-2423: a new request's line names the product, domain, seats and period, and which part of the term it is — part_request_line_name; the old short label stays in the line's description and the notes. R-2519b: a part not begun yet is billed as a proforma only (no tax invoice ahead); the request insert sets the guard flag. R-2519: a new request is a Proforma Invoice — its number comes from the PI series (next_document_number('proforma')), each line is seats × a per-seat rate when exact (as R-2101's invoice lines), it is due on the LATER of the part start and today + the terms (a part billed late is not 'due' on a past day), and paying a request whose seats / per-seat rate were changed (set_part_request_terms) puts those terms on the subscription and the part first (apply_part_request_terms), so its tax invoice bills what the proforma asked. */
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
  v_paid_up  boolean := false;
  v_sale     record;
  v_ids      uuid[];
  v_lead     uuid;
  v_taxable  integer;
  v_parts    integer;
  v_lines    jsonb;
  v_g        record;
  v_seats    integer;
  v_unlaid   uuid[];
  v_on_rcpt  boolean := false;
  v_terms    integer;
  v_due      date;
  v_nparts   integer;
  v_items    jsonb;
begin
  /* R-2527: trust only the login, never a JWT role claim (R-2519c's rule for the guard). Before, a
     direct client login claiming service_role with no sub was trusted and skipped the company check.
     The service key through PostgREST runs as role service_role; the Cloud SQL admin client logs in
     as app_service and psql / scripts as their owner — none of them a request login. */
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
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

  /* R-2092 siblings laid: the quote's parts of one period are billed together — so a part is
     not billed (no invoice, no request) while another active subscription of the SAME quote,
     billed in the same cycle, has no parts laid yet. Its own billing run lays them and bills the
     whole group then. Before: the billing code laid one subscription's parts and billed them
     before the next subscription's were there (a lay that failed was swallowed), and the quote's
     Q1 went out as the Starter alone (localhost, 29 Oct). A subscription whose parts can never be
     laid here (no start date, billed elsewhere for the period) does not hold the others back. */
  select array_agg(s2.id order by s2.created_at, s2.id) into v_unlaid
    from public.subscriptions s2
    join public.subscriptions me on me.id = v_b.subscription_id
   where me.quote_id is not null
     and s2.tenant_id = me.tenant_id and s2.quote_id = me.quote_id and s2.id <> me.id
     and s2.status = 'active'
     and s2.billing_cycle = me.billing_cycle
     and s2.billing_cycle is distinct from 'yearly'::billing_cycle
     and s2.start_date is not null
     and coalesce(s2.mrr, 0) > 0
     and (s2.billed_externally_until is null or s2.billed_externally_until < v_b.period_start)
     and not exists (select 1 from public.subscription_billings b3 where b3.subscription_id = s2.id);
  if v_unlaid is not null then
    return jsonb_build_object('action', 'waiting', 'reason', 'siblings_not_laid',
                              'subscription_ids', to_jsonb(v_unlaid));
  end if;

  select s.id, s.tenant_id, s.quote_id, s.customer_id, s.customer_name, s.plan, s.seats, s.domain,
         s.billing_cycle::text as cycle, s.term_months, s.item_id
    into v_sub from public.subscriptions s where s.id = v_b.subscription_id;
  if not found then
    raise exception 'Subscription behind billing part % no longer exists', p_billing_id using errcode = 'no_data_found';
  end if;

  /* R-2092: the group (a single part = the old behaviour). Its first part leads: a request is
     linked to it. */
  v_lines := '[]'::jsonb; v_taxable := 0; v_parts := 0; v_seats := 0;
  for v_g in select * from public.billing_part_group(p_billing_id) loop
    v_parts := v_parts + 1;
    v_ids := coalesce(v_ids, '{}'::uuid[]) || v_g.billing_id;
    v_taxable := v_taxable + v_g.taxable;
    v_seats := v_seats + coalesce(v_g.seats, 0);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'billing_id', v_g.billing_id::text, 'plan', v_g.plan, 'seats', coalesce(v_g.seats, 0), 'taxable', v_g.taxable));
  end loop;
  if v_parts = 0 then
    v_ids := array[v_b.id]; v_taxable := v_b.taxable_amount; v_parts := 1; v_seats := coalesce(v_sub.seats, 0);
  end if;
  v_lead := v_ids[1];

  /* The group's gross, the same figure raise_subscription_billing will invoice: export → 0%. */
  select c.country, coalesce(c.invoice_parts_on_due_date, false) into v_country, v_on_due
    from public.customers c where c.id = v_sub.customer_id;
  v_rate := case when v_country is not null
                  and lower(btrim(v_country)) not in ('', 'in', 'ind', 'india', 'bharat') then 0
                 else v_b.tax_rate end;
  v_tax   := round(v_taxable * v_rate / 100.0);
  v_gross := v_taxable + v_tax;

  /* R-2095: a request already spent on an invoice that credit notes cancelled is not this period's
     request any more — its money stays in the quote's pool (instalment_credit). */
  select q.id, q.amount, q.status::text as status, q.invoice_id into v_q
    from public.quotes q where q.subscription_billing_id = any(v_ids)
     and not (q.invoice_id is not null and exists (
               select 1 from public.subscription_billings bx
                where bx.id = any(v_ids) and q.invoice_id = any(bx.credited_invoice_ids)))
   order by (q.subscription_billing_id = v_b.id) desc
   limit 1;
  v_has_q := found;
  if v_has_q then
    v_req_paid := coalesce((select sum(p.amount) from public.payments p
                             where p.quote_id = v_q.id and p.status = 'received'), 0) >= coalesce(v_q.amount, 0);
  end if;

  /* The sale quote IS the payment request of the first part of the first term. R-2048: it is
     invoiced only when money covers it (instalment_credit counts the sale quote's receipts) —
     no longer "paid by definition"; an accepted-but-unpaid sale got an unpaid tax invoice.
     R-2092: "money covers it" = the QUOTE's pool covers the GROUP — before, each subscription
     counted the sale quote's whole receipt as its own, so a short payment covered both. */
  /* R-2095: a first part whose invoice credit notes cancelled is not covered by the sale quote
     any more (that quote was spent on the cancelled invoice) — it gets its own request. */
  v_first := v_sub.quote_id is not null
             and cardinality(v_b.credited_invoice_ids) = 0
             and v_b.period_index = 1
             and v_b.term_start = (select min(b2.term_start) from public.subscription_billings b2
                                    where b2.subscription_id = v_b.subscription_id);
  v_paid_up := public.instalment_credit(v_b.subscription_id) >= v_gross;
  /* R-2519: a proforma whose seats / rate were changed asks its OWN amount — credit covers the part
     only when it covers that (the part's laid amount is the old seats until it is paid). */
  if v_has_q and exists (select 1 from public.quotes pq where pq.id = v_q.id and pq.proforma_seats is not null) then
    v_paid_up := public.instalment_credit(v_b.subscription_id) >= coalesce(v_q.amount, 0);
  end if;
  /* R-2095 (Sept reconcile): a sale booked from a bank receipt — its first part is invoiced on the
     first receipt even when part-paid (balance due on the invoice), like the whole-quote rule in
     bank_credit_pay_item. Staging: Suresh's half-yearly sale had money and no GST invoice. */
  v_on_rcpt := v_first and exists (
                 select 1 from public.quotes sq
                  where sq.id = v_sub.quote_id and sq.invoice_on_receipt
                    and exists (select 1 from public.payments p where p.quote_id = sq.id and p.status = 'received' and p.amount > 0));

  /* v_on_due: the customer's "Invoice on due date" switch — the old path, a tax invoice on the
     bill date even if unpaid (chased by invoice-dunning). */
  /* R-2519b (coordinator): a period that has not begun is billed AHEAD — only a proforma, never a tax
     invoice (not for an 'invoice on due date' customer, not from credit). Its tax invoice comes when
     the proforma is paid, or on its real date (the billing job). */
  if v_b.period_start > public.ist_today() and not v_req_paid then
    /* Already covered by the customer's money: no proforma asking for it again and no invoice ahead —
       the billing job invoices it on its date. */
    if v_paid_up and not v_has_q then
      return jsonb_build_object('action', 'waiting', 'reason', 'paid_ahead', 'subscription_ids', '[]'::jsonb,
                                'gross', v_gross, 'bill_on', v_b.bill_on);
    end if;
    v_on_due := false; v_paid_up := false; v_on_rcpt := false;
  end if;

  if v_req_paid or v_on_due or v_paid_up or v_on_rcpt then
    if coalesce(p_dry_run, false) then
      return jsonb_build_object('action', 'invoice', 'gross', v_gross, 'dry_run', true, 'parts', v_parts,
        'reason', case when v_req_paid then 'request_paid' when v_on_due then 'invoice_on_due_date'
                       when v_on_rcpt and not v_paid_up then 'first_receipt_of_sale' when v_first then 'first_part_of_sale' else 'already_paid' end);
    end if;
    /* R-2519: the proforma's own seats / rate (changed before it was paid) go on the subscription
       and the part first, so the tax invoice bills what the customer paid. */
    if v_has_q and (v_req_paid or v_paid_up) then
      perform public.apply_part_request_terms(v_q.id);
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
      'gross', v_raised.gross, 'already_raised', v_raised.already_raised, 'parts', v_parts);
  end if;

  if v_has_q then
    return jsonb_build_object('action', 'request_open', 'quote_id', v_q.id, 'status', v_q.status, 'gross', v_gross);
  end if;
  /* R-2048: the first part of an unpaid sale — the open sale quote is what the customer pays; no
     invoice and no second request. Paying it raises this part's invoice (credit rule above). A
     closed (rejected / expired) sale quote is not a request any more → this part gets its own. */
  if v_first then
    select q.id, q.status::text as status into v_sale
      from public.quotes q where q.id = v_sub.quote_id;
    if found and v_sale.status in ('draft', 'sent', 'viewed', 'accepted') then
      return jsonb_build_object('action', 'request_open', 'quote_id', v_sale.id, 'status', v_sale.status,
                                'gross', v_gross, 'sale_quote', true);
    end if;
  end if;
  if coalesce(p_dry_run, false) then
    return jsonb_build_object('action', 'request', 'gross', v_gross, 'dry_run', true, 'parts', v_parts);
  end if;

  /* R-2230: the request's due date — the part start + the payment terms (part_request_terms_days). */
  v_terms := public.part_request_terms_days(v_b.subscription_id);
  /* R-2519: billed late (after the part began) → due from today, never a day already past. */
  v_due   := greatest(v_b.period_start, public.ist_today()) + v_terms;

  /* R-2519: a renewal part's request is a Proforma Invoice — its own PI series per financial year. */
  v_id := public.next_document_number('proforma', v_b.tenant_id);
  if v_id is null then
    raise exception 'No proforma number could be issued for the payment request of billing part %. Check Settings → Document numbering.', p_billing_id;
  end if;
  /* R-2865: "Payment for Q2 · 28 Jan–27 Apr 2027" — a part proforma asks payment for its service period; it is not an advance (the text said "Advance payment for …" before). period_end is exclusive (schedule.ts). */
  v_period := to_char(v_b.period_start, 'FMDD Mon') || '–' || to_char(v_b.period_end - 1, 'FMDD Mon YYYY');
  v_label := 'Payment for '
             || case v_sub.cycle when 'quarterly' then 'Q' || v_b.period_index::text
                                 when 'half_yearly' then 'H' || v_b.period_index::text
                                 else 'month ' || v_b.period_index::text end
             || ' · ' || v_period;
  /* R-2423: parts in one term (12-month term billed monthly → 12); null when it does not divide. */
  v_nparts := public.part_request_parts_in_term(v_sub.term_months, v_sub.cycle);

  /* R-2092: one line per subscription of the group, each naming its part (billing_id) — the
     group is then fixed by the request (billing_part_group). A group of one: the old line. */
  v_items :=
    case when v_parts > 1 then
      (select jsonb_agg(jsonb_build_object(
                'id',          'part-' || v_b.period_index::text || '-' || n::text,
                'name',        public.part_request_line_name(
                                 x->>'plan',
                                 s3.domain,
                                 coalesce((x->>'seats')::integer, 0), v_period, v_b.period_index,
                                 /* each sibling's own term (an Annual and a Flexible line differ) */
                                 public.part_request_parts_in_term(s3.term_months, s3.billing_cycle::text)),
                'description', v_label,
                /* R-2519: seats × per-seat rate when exact (r2101_part_line's rule). */
                'qty',         case when public.r2519_per_seat(coalesce((x->>'seats')::integer, 0), (x->>'taxable')::integer)
                                    then (x->>'seats')::integer else 1 end,
                'rate',        case when public.r2519_per_seat(coalesce((x->>'seats')::integer, 0), (x->>'taxable')::integer)
                                    then (x->>'taxable')::integer / (x->>'seats')::integer else (x->>'taxable')::integer end,
                'per_seat',    public.r2519_per_seat(coalesce((x->>'seats')::integer, 0), (x->>'taxable')::integer),
                'period_start', b4.period_start,
                'period_end',   b4.period_end - 1,
                /* R-2922: our cost for this part — a seat on a per-seat line, the whole line on a lump line. */
                'cost',        public.r2922_part_line_cost(v_b.tenant_id, s3.item_id, coalesce((x->>'seats')::integer, 0), (x->>'taxable')::integer, s3.term_months,
                                 public.r2922_part_whole_months(b4.term_start, b4.period_index, b4.period_start, b4.period_end, s3.billing_cycle::text)),
                'one_time',    true,
                'billing_id',  x->>'billing_id')
                /* R-2922: the subscription's catalogue item, as a renewal quote's line names it. */
                || case when s3.item_id is not null then jsonb_build_object('item_id', s3.item_id) else '{}'::jsonb end order by n)
         from jsonb_array_elements(v_lines) with ordinality t(x, n)
         left join public.subscription_billings b4 on b4.id = (x->>'billing_id')::uuid
         left join public.subscriptions s3 on s3.id = b4.subscription_id)
    else
      jsonb_build_array(jsonb_build_object(
        'id',          'part-' || v_b.period_index::text,
        'name',        public.part_request_line_name(v_sub.plan, v_sub.domain, coalesce(v_sub.seats, 0), v_period, v_b.period_index, v_nparts),
        'description', v_label,
        'qty',         case when public.r2519_per_seat(coalesce(v_sub.seats, 0), v_b.taxable_amount) then v_sub.seats else 1 end,
        'rate',        case when public.r2519_per_seat(coalesce(v_sub.seats, 0), v_b.taxable_amount)
                            then v_b.taxable_amount / v_sub.seats else v_b.taxable_amount end,
        'per_seat',    public.r2519_per_seat(coalesce(v_sub.seats, 0), v_b.taxable_amount),
        'period_start', v_b.period_start,
        'period_end',   v_b.period_end - 1,
        'cost',        public.r2922_part_line_cost(v_b.tenant_id, v_sub.item_id, coalesce(v_sub.seats, 0), v_b.taxable_amount, v_sub.term_months,
                         public.r2922_part_whole_months(v_b.term_start, v_b.period_index, v_b.period_start, v_b.period_end, v_sub.cycle)),
        'one_time',    true) || case when v_sub.item_id is not null then jsonb_build_object('item_id', v_sub.item_id) else '{}'::jsonb end)
    end;

  /* R-2519b: the guard (trg_quotes_proforma_columns_guarded) lets only server code make a part request. */
  perform set_config('app.r2519_write', 'on', true);
  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    domain, created_date, expires_date, line_items, subtotal, total_cost, discount_pct, tax_rate,
    is_one_off, billing_cycle, payment_terms_days, notes, subscription_billing_id
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name,
    case when v_parts > 1 then (select string_agg(x->>'plan', ' + ' order by n) from jsonb_array_elements(v_lines) with ordinality t(x, n))
         else v_sub.plan end,
    case when v_parts > 1 then v_seats else v_sub.seats end,
    v_gross, 'sent', 'awaiting',
    /* Sent on the bill date (the period's first day); due on v_due (R-2230: part start + terms, 0 =
       that day). No expiry — it stays open until it is paid or "Customer stopped". */
    v_sub.domain, public.ist_today(), null,
    /* R-2922: the lines (v_items, built above) and their cost — sum of cost × qty. */
    v_items,
    v_taxable,
    (select coalesce(sum(coalesce((li->>'cost')::integer, 0) * coalesce((li->>'qty')::integer, 0)), 0)::integer from jsonb_array_elements(v_items) li),
    0, v_rate,
    true, 'yearly', v_terms,
    v_label || '. Due on ' || to_char(v_due, 'FMDD Mon YYYY') || '. The tax invoice is issued when this is paid.',
    v_lead
  );
  perform set_config('app.r2519_write', '', true);
  /* R-2230: every part of the request carries its due date. */
  update public.subscription_billings set due_on = v_due, updated_at = now()
   where id = any(v_ids) and due_on is null;
  return jsonb_build_object('action', 'request', 'quote_id', v_id, 'created', true, 'gross', v_gross, 'label', v_label, 'parts', v_parts, 'due_on', v_due);
end;
$$;

-- ── 3. Bill together — body of 20261116140831 (R-2865) ─────────────────────────────────────────────
create or replace function public.bill_parts_together(p_billing_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2922: each line carries its subscription's catalogue item (item_id) and our cost (r2922_part_line_cost), the proforma its total_cost — like a renewal quotation; amounts unchanged.
   R-2810: ONE proforma (PI series) for the laid unpaid parts of 2+ subscriptions of ONE customer — a line per part,
   each its own seats × rate and period; the subscriptions get one bill_group_id (R-2806 pool). Same parts again →
   the same proforma. Refusals in plain words. */
declare
  v_trusted  boolean;
  v_caller   uuid := public.current_tenant_id();
  v_ids      uuid[];
  v_sorted   uuid[];
  v_tenant   uuid;
  v_ntenant  integer;
  v_customer uuid;
  v_ncust    integer;
  v_custname text;
  v_q        record;
  v_p        record;
  v_g        record;
  v_other    text;
  v_sib      text;
  v_today    date := public.ist_today();
  v_rates    integer[];
  v_rate     integer;
  v_country  text;
  v_taxable  integer := 0;
  v_tax      integer;
  v_gross    integer;
  v_seats    integer := 0;
  v_part_tax integer;
  v_subs     uuid[] := '{}'::uuid[];
  v_plans    text[] := '{}'::text[];
  v_lines    jsonb := '[]'::jsonb;
  v_begun    text;
  v_ahead    text;
  v_first_start date;
  v_lead     uuid;
  v_lead_sub record;
  v_group    uuid;
  v_terms    integer;
  v_due      date;
  v_id       text;
  v_period   text;
  v_label    text;
  v_n        integer := 0;
  v_credit   integer;
  v_on_due   boolean := false;
  v_inv      jsonb;
begin
  /* R-2527's rule: trust only the login, never a JWT role claim — the service key through PostgREST runs as role
     service_role; app_service / psql / scripts are not request logins. */
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can bill subscriptions together.' using errcode = '42501';
  end if;

  /* The parts, each once, in the order asked (the first leads). */
  select array_agg(t.id order by t.n) into v_ids
    from (select u.id, min(u.n) as n from unnest(p_billing_ids) with ordinality u(id, n) where u.id is not null group by u.id) t;
  if coalesce(cardinality(v_ids), 0) < 2 then
    raise exception 'Pick at least two subscriptions to bill together.' using errcode = '22023';
  end if;
  /* rev-r2810: ONE check and ONE answer — a part of another company reads exactly like an id that does not exist
     (no "is this id real?" oracle). A trusted server caller with no company: all parts in one company. */
  select count(*), count(distinct b.tenant_id), min(b.tenant_id::text)::uuid into v_n, v_ntenant, v_tenant
    from public.subscription_billings b
   where b.id = any(v_ids) and (v_caller is null or b.tenant_id = v_caller);
  if v_n < cardinality(v_ids) or v_ntenant <> 1 then
    raise exception 'A part to bill was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end if;
  v_n := 0;

  /* A subscription with no customer is never grouped (R-2806 re-review: its money would join nobody's pool). */
  select string_agg(s.plan, ', ' order by s.plan) into v_custname
    from public.subscription_billings b join public.subscriptions s on s.id = b.subscription_id
   where b.id = any(v_ids) and s.customer_id is null;
  if v_custname is not null then
    raise exception '% is not linked to a customer — link this subscription to a customer first, then bill together.', v_custname
      using errcode = '22023';
  end if;
  /* ONE customer (R-2806 keeps two customers' money apart; say so here). */
  select count(distinct coalesce(s.customer_id::text, '-')), min(s.customer_id::text)::uuid,
         string_agg(distinct coalesce(s.customer_name, 'no customer'), ', ')
    into v_ncust, v_customer, v_custname
    from public.subscription_billings b join public.subscriptions s on s.id = b.subscription_id
   where b.id = any(v_ids);
  if v_ncust <> 1 or v_customer is null then
    raise exception 'Parts of different customers cannot be on one bill (%) — bill together only one customer''s subscriptions.', v_custname
      using errcode = '22023';
  end if;

  /* Two calls at once: one at a time per customer, then the parts' rows (the lock Bill next part takes), id order. */
  perform pg_advisory_xact_lock(hashtextextended('r2810:bill-together:' || v_tenant::text || ':' || v_customer::text, 0));
  perform 1 from public.subscription_billings b where b.id = any(v_ids) order by b.id for update;
  select array_agg(x order by x) into v_sorted from unnest(v_ids) x;

  /* Same parts again → the same proforma (a retry, a second click, a second tab). */
  select q.id, q.amount, q.subscription_billing_id, q.currency, q.tax_rate, q.subtotal into v_q
    from public.quotes q
   where q.tenant_id = v_tenant and q.subscription_billing_id = any(v_ids)
     and q.cancelled_at is null and q.superseded_by is null and q.status::text not in ('rejected', 'expired')
     and (q.invoice_id is null
          or not exists (select 1 from public.subscription_billings bx where bx.id = any(v_ids) and bx.invoice_id is distinct from q.invoice_id))
     and v_sorted = (select array_agg(distinct n.id order by n.id) from (
                        select q.subscription_billing_id as id
                        union all
                        select (l->>'billing_id')::uuid
                          from jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) l
                         where l ? 'billing_id' and nullif(l->>'billing_id', '') is not null) n)
   order by q.created_at desc, q.id
   limit 1;
  if found then
    return jsonb_build_object('action', 'request_open', 'quote_id', v_q.id, 'already_existed', true,
      'subscription_ids', (select to_jsonb(array_agg(b.subscription_id order by u.n)) from unnest(v_ids) with ordinality u(id, n)
                             join public.subscription_billings b on b.id = u.id),
      'billing_ids', to_jsonb(v_ids),
      'bill_group_id', (select s.bill_group_id from public.subscription_billings b join public.subscriptions s on s.id = b.subscription_id
                         where b.id = v_q.subscription_billing_id),
      'taxable', v_q.subtotal, 'tax_rate', v_q.tax_rate, 'gross', v_q.amount, 'currency', upper(coalesce(v_q.currency, 'INR')));
  end if;

  /* Each part. */
  for v_p in
    select b.id, b.subscription_id, b.invoice_id, b.period_start, b.period_end, b.period_index, b.taxable_amount,
           b.tax_rate, b.term_start, b.credited_invoice_ids, s.plan, s.seats, s.domain, s.quote_id as sale_quote,
           s.status::text as sub_status, s.billing_cycle::text as cycle, s.term_months, u.n,
           s.auto_renew, s.renewal_quote_id, s.item_id
      from unnest(v_ids) with ordinality u(id, n)
      join public.subscription_billings b on b.id = u.id
      join public.subscriptions s on s.id = b.subscription_id
     order by u.n
     /* R-2807 review: the holds below are read under a row lock — a Won't renew / renewal quote set while this runs
        waits for it, and one set before is seen here (the route's own re-read can be a moment old). */
     for share of s
  loop
    v_period := to_char(v_p.period_start, 'FMDD Mon') || '–' || to_char(v_p.period_end - 1, 'FMDD Mon YYYY');
    if v_p.invoice_id is not null then
      raise exception 'The % part for % already has tax invoice % — it cannot be billed again.', v_p.plan, v_period, v_p.invoice_id
        using errcode = '22023';
    end if;
    if v_p.cycle = 'yearly' then
      raise exception '% is billed yearly — Bill together is only for subscriptions billed in parts (monthly, quarterly, half-yearly).', v_p.plan
        using errcode = '22023';
    end if;
    if v_p.sub_status <> 'active' then
      raise exception '% is % — only an active subscription can be billed together.', v_p.plan, v_p.sub_status using errcode = '22023';
    end if;
    /* R-2807 review: the same holds the Bill together screen checks (R-808) — Won't renew, an open renewal quote. */
    if v_p.auto_renew is false then
      raise exception '% is marked Won''t renew — press Undo Won''t renew on the subscription first.', v_p.plan using errcode = '22023';
    end if;
    if v_p.renewal_quote_id is not null then
      raise exception 'Renewal quote % is still open for % — paying it would bill the new term twice. Cancel it first.',
        v_p.renewal_quote_id, v_p.plan using errcode = '22023';
    end if;
    if v_p.subscription_id = any(v_subs) then
      raise exception 'Two parts of % were picked — pick one part of each subscription.', v_p.plan using errcode = '22023';
    end if;
    /* rev-r2806 F4: a part already on a live request (its own proforma, or a line of another one). */
    v_other := public.part_live_request(v_tenant, v_p.id);
    if v_other is not null then
      raise exception 'The % part for % is already on proforma % — cancel % first, then bill them together.',
        v_p.plan, v_period, v_other, v_other using errcode = '22023';
    end if;
    /* The first part of a sale: its sale quote bills it, with the sale's one-time lines and payment terms. */
    if v_p.sale_quote is not null and cardinality(coalesce(v_p.credited_invoice_ids, '{}'::text[])) = 0 and v_p.period_index = 1
       and v_p.term_start = (select min(b2.term_start) from public.subscription_billings b2 where b2.subscription_id = v_p.subscription_id) then
      raise exception 'The first part of % is billed by its sale quote % — bill it from there; later parts can be billed together.',
        v_p.plan, v_p.sale_quote using errcode = '22023';
    end if;
    /* R-2092: parts of one sale quote for one period are ONE bill — none may be left out, and none may be billed
       while a sibling of the sale (same cycle) has no parts laid yet (Bill next part's 'siblings_not_laid'). */
    select string_agg(s2.plan, ', ' order by s2.plan) into v_sib
      from public.subscriptions s2
      join public.subscriptions me on me.id = v_p.subscription_id
     where me.quote_id is not null
       and s2.tenant_id = me.tenant_id and s2.quote_id = me.quote_id and s2.id <> me.id
       and s2.status = 'active' and s2.billing_cycle = me.billing_cycle
       and s2.billing_cycle is distinct from 'yearly'::billing_cycle
       and s2.start_date is not null and coalesce(s2.mrr, 0) > 0
       and (s2.billed_externally_until is null or s2.billed_externally_until < v_p.period_start)
       and not exists (select 1 from public.subscription_billings b3 where b3.subscription_id = s2.id);
    if v_sib is not null then
      raise exception '% is sold with % on one sale quote, whose parts are not laid yet — wait for the next billing run, then bill them together.',
        v_p.plan, v_sib using errcode = '22023';
    end if;
    /* Only the R-2092 sale-quote group counts here (rows of the SAME sale quote): a request that is no longer live
       never decides a part's amount or which parts belong together. */
    v_part_tax := null;
    if v_p.sale_quote is not null then
      for v_g in select g.* from public.billing_part_group(v_p.id) g
                   join public.subscriptions sg on sg.id = g.subscription_id
                  where sg.quote_id = v_p.sale_quote loop
        if v_g.billing_id = v_p.id then
          v_part_tax := v_g.taxable;
        elsif not (v_g.billing_id = any(v_ids)) then
          select s.plan into v_sib from public.subscriptions s where s.id = v_g.subscription_id;
          raise exception '% is billed with % (same sale quote, same period) — tick % too.', v_p.plan, v_sib, v_sib
            using errcode = '22023';
        end if;
      end loop;
    end if;
    v_part_tax := coalesce(v_part_tax, v_p.taxable_amount);

    if v_p.period_start > v_today then
      v_ahead := coalesce(v_ahead, v_p.plan || ' (from ' || to_char(v_p.period_start, 'FMDD Mon YYYY') || ')');
    else
      v_begun := coalesce(v_begun, v_p.plan);
    end if;
    v_rates := v_rates || v_p.tax_rate;
    v_subs := v_subs || v_p.subscription_id;
    v_plans := v_plans || v_p.plan;
    v_taxable := v_taxable + v_part_tax;
    v_seats := v_seats + coalesce(v_p.seats, 0);
    v_first_start := least(coalesce(v_first_start, v_p.period_start), v_p.period_start);
    v_n := v_n + 1;
    /* R-2865: "Payment for month 2 · 1 Oct–31 Oct 2026" — payment for the service period, not an advance. */
    v_label := 'Payment for '
               || case v_p.cycle when 'quarterly' then 'Q' || v_p.period_index::text
                                 when 'half_yearly' then 'H' || v_p.period_index::text
                                 else 'month ' || v_p.period_index::text end
               || ' · ' || v_period;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id',           'part-' || v_p.period_index::text || '-' || v_n::text,
      'name',         public.part_request_line_name(v_p.plan, v_p.domain, coalesce(v_p.seats, 0), v_period, v_p.period_index,
                                                    public.part_request_parts_in_term(v_p.term_months, v_p.cycle)),
      'description',  v_label,
      'qty',          case when public.r2519_per_seat(coalesce(v_p.seats, 0), v_part_tax) then v_p.seats else 1 end,
      'rate',         case when public.r2519_per_seat(coalesce(v_p.seats, 0), v_part_tax) then v_part_tax / v_p.seats else v_part_tax end,
      'per_seat',     public.r2519_per_seat(coalesce(v_p.seats, 0), v_part_tax),
      'period_start', v_p.period_start,
      'period_end',   v_p.period_end - 1,
      /* R-2922: our cost for this part — a seat on a per-seat line, the whole line on a lump line. */
      'cost',         public.r2922_part_line_cost(v_tenant, v_p.item_id, coalesce(v_p.seats, 0), v_part_tax, v_p.term_months,
                        public.r2922_part_whole_months(v_p.term_start, v_p.period_index, v_p.period_start, v_p.period_end, v_p.cycle)),
      'one_time',     true,
      'billing_id',   v_p.id::text)
      || case when v_p.item_id is not null then jsonb_build_object('item_id', v_p.item_id) else '{}'::jsonb end);
  end loop;

  if (select count(distinct r) from unnest(v_rates) r) > 1 then
    raise exception 'Parts with different GST rates cannot be on one bill (%) — bill them separately.',
      (select string_agg(distinct coalesce(r::text, '?') || '%', ' and ') from unnest(v_rates) r) using errcode = '22023';
  end if;
  /* R-2519b: a part not begun is billed ahead only on a proforma — never mixed with a started part, whose pool
     credit could then put the not-begun part on a tax invoice ahead. */
  if v_begun is not null and v_ahead is not null then
    raise exception '% has not started yet — a part that has not started cannot be billed with a started one (%). Bill the started parts together now.',
      v_ahead, v_begun using errcode = '22023';
  end if;

  /* The request is linked to ONE part (subscription_billing_id, unique). rev2-r2810: a part freed by a credit note
     still holds its old, spent proforma's link — so the lead is the first ticked part with no old request. */
  select u.id into v_lead
    from unnest(v_ids) with ordinality u(id, n)
   where not exists (select 1 from public.quotes q where q.subscription_billing_id = u.id)
   order by u.n limit 1;
  if v_lead is null then
    raise exception 'Every one of these parts still carries an earlier proforma (%) — bill them with Bill next part one by one.',
      (select string_agg(q.id, ', ' order by q.id) from public.quotes q where q.subscription_billing_id = any(v_ids))
      using errcode = '22023';
  end if;
  select s.id, s.customer_id, s.customer_name, s.domain into v_lead_sub
    from public.subscription_billings b join public.subscriptions s on s.id = b.subscription_id where b.id = v_lead;

  /* GST: one rate; an export customer pays 0% (zero-rated, as Bill next part and the tax invoice). INR — the
     parts are laid in INR, like every part request. */
  select c.country, coalesce(c.invoice_parts_on_due_date, false) into v_country, v_on_due
    from public.customers c where c.id = v_customer;
  v_rate := case when v_country is not null and lower(btrim(v_country)) not in ('', 'in', 'ind', 'india', 'bharat') then 0
                 else v_rates[1] end;
  v_tax   := round(v_taxable * v_rate / 100.0);
  v_gross := v_taxable + v_tax;

  /* The bill group: one id for the members, their sale-quote siblings and any group one was in — of THIS customer. */
  select min(s.bill_group_id::text)::uuid into v_group from public.subscriptions s where s.id = any(v_subs) and s.bill_group_id is not null;
  v_group := coalesce(v_group, gen_random_uuid());
  update public.subscriptions s
     set bill_group_id = v_group, updated_at = now()
   where s.tenant_id = v_tenant and s.customer_id = v_customer
     and s.bill_group_id is distinct from v_group
     and (s.id in (select bp.subscription_id from unnest(v_subs) m(id) cross join lateral public.billing_pool_subscriptions(m.id) bp)
          or s.bill_group_id in (select s2.bill_group_id from public.subscriptions s2 where s2.id = any(v_subs) and s2.bill_group_id is not null));

  /* Money already in the (now merged) pool: a started group it covers is invoiced at once (as Bill next part);
     a not-started group already paid for is invoiced on its date — no proforma asking for paid money. */
  v_credit := public.instalment_credit(v_lead_sub.id);
  if v_credit >= v_gross and v_ahead is not null then
    raise exception 'Money already received covers these parts (₹%) — they are invoiced on their dates; no proforma is needed.', v_gross
      using errcode = '22023';
  end if;

  v_terms := public.part_request_terms_days(v_lead_sub.id);
  v_due   := greatest(v_first_start, v_today) + v_terms;
  v_id := public.next_document_number('proforma', v_tenant);
  if v_id is null then
    raise exception 'No proforma number could be issued. Check Settings → Document numbering.';
  end if;

  perform set_config('app.r2519_write', 'on', true);
  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    domain, created_date, expires_date, line_items, subtotal, total_cost, discount_pct, tax_rate,
    is_one_off, billing_cycle, payment_terms_days, notes, subscription_billing_id, currency, created_by
  ) values (
    v_id, v_tenant, v_customer, v_lead_sub.customer_name, array_to_string(v_plans, ' + '), v_seats, v_gross, 'sent', 'awaiting',
    v_lead_sub.domain, v_today, null, v_lines, v_taxable,
    /* R-2922: the lines' cost — sum of cost × qty */
    (select coalesce(sum(coalesce((li->>'cost')::integer, 0) * coalesce((li->>'qty')::integer, 0)), 0)::integer from jsonb_array_elements(v_lines) li),
    0, v_rate,
    true, 'yearly', v_terms,
    'Billed together: ' || array_to_string(v_plans, ' + ') || '. Due on ' || to_char(v_due, 'FMDD Mon YYYY')
      || '. The tax invoice is issued when this is paid.',
    v_lead, 'INR', (select u.id from public.users u where u.id = auth.uid())
  );
  perform set_config('app.r2519_write', '', true);
  update public.subscription_billings set due_on = v_due, updated_at = now() where id = any(v_ids) and due_on is null;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, (select u.id from public.users u where u.id = auth.uid()), 'quote.bill_together', 'quote', v_id,
          left(format('Billed together on %s: %s', v_id, array_to_string(v_plans, ' + ')), 120),
          jsonb_build_object('billing_ids', to_jsonb(v_ids), 'subscription_ids', to_jsonb(v_subs), 'bill_group_id', v_group, 'gross', v_gross));

  /* Already paid from the pool, or an "Invoice on due date" customer (a started group) → its tax invoice now
     (Bill next part's rule); Bill next part then closes this proforma itself. Anything else it answers is a
     contradiction — undo everything rather than leave a live proforma for invoiced or paid parts. */
  if (v_credit >= v_gross or v_on_due) and v_ahead is null then
    v_inv := public.bill_subscription_instalment(v_lead, false);
    if v_inv->>'action' is distinct from 'invoice' or v_inv->>'invoice_id' is null
       or exists (select 1 from public.subscription_billings b where b.id = any(v_ids) and b.invoice_id is distinct from v_inv->>'invoice_id')
       or exists (select 1 from public.quotes q where q.id = v_id and q.invoice_id is null and q.status::text not in ('expired', 'rejected')) then
      raise exception 'These parts could not be invoiced together right now (%) — nothing was changed; try Bill next part, or ask support.',
        coalesce(v_inv->>'action', '?') || coalesce(' ' || (v_inv->>'reason'), '') using errcode = '22023';
    end if;
    return jsonb_build_object('action', 'invoice', 'quote_id', v_id, 'already_existed', false, 'invoice_id', v_inv->>'invoice_id',
      'subscription_ids', to_jsonb(v_subs), 'billing_ids', to_jsonb(v_ids), 'bill_group_id', v_group,
      'taxable', v_taxable, 'tax_rate', v_rate, 'gross', v_gross, 'currency', 'INR');
  end if;

  return jsonb_build_object('action', 'request', 'quote_id', v_id, 'already_existed', false,
    'subscription_ids', to_jsonb(v_subs), 'billing_ids', to_jsonb(v_ids), 'bill_group_id', v_group,
    'taxable', v_taxable, 'tax_rate', v_rate, 'tax', v_tax, 'gross', v_gross, 'currency', 'INR', 'due_on', v_due);
end;
$$;

-- ── 4. Change a proforma's seats — body of 20261106074318 (R-2519b) ────────────────────────────────
create or replace function public.set_part_request_terms(p_quote_id text, p_seats integer, p_seat_rate integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2922: the changed line keeps its catalogue item and takes our cost a seat for the NEW seats (r2922_part_seat_cost — the volume slab can change with the seats); total_cost follows.
   R-2519b: writes the server marker (proforma_terms_set_at). R-2519: change an unpaid single-subscription proforma to p_seats × ₹p_seat_rate. The subscription
   is changed only when the proforma is paid / accepted (apply_part_request_terms). */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_b       record;
  v_s       record;
  v_taxable integer;
  v_tax     integer;
  v_period  text;
  v_line    jsonb;
  v_cost    integer;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can change a proforma.' using errcode = '42501';
  end if;
  if p_seats is null or p_seats < 1 or p_seats > 100000 then
    raise exception 'Seats must be a whole number from 1 to 100,000.' using errcode = '22023';
  end if;
  if p_seat_rate is null or p_seat_rate < 0 or p_seat_rate > 10000000 then
    raise exception 'The rate a seat must be ₹0 to ₹1,00,00,000.' using errcode = '22023';
  end if;

  select q.* into v_q from public.quotes q where q.id = p_quote_id for update;
  if not found or v_q.subscription_billing_id is null then
    raise exception 'Quote % is not a proforma for a part of a subscription.', p_quote_id using errcode = '22023';
  end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in your company.', p_quote_id using errcode = '42501';
  end if;
  if v_q.invoice_id is not null then
    raise exception 'Proforma % already has its tax invoice — it cannot be changed.', v_q.id using errcode = '22023';
  end if;
  if v_q.status::text in ('rejected', 'expired') then
    raise exception 'Proforma % is closed — it cannot be changed.', v_q.id using errcode = '22023';
  end if;
  if exists (select 1 from public.payments p where p.quote_id = v_q.id and p.status = 'received' and p.amount > 0) then
    raise exception 'Money was already received on % — its seats and rate cannot change now.', v_q.id using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(v_q.line_items, '[]'::jsonb)) <> 1 then
    raise exception 'Proforma % covers several subscriptions — change each subscription''s seats from Manage seats.', v_q.id
      using errcode = '22023';
  end if;
  select b.* into v_b from public.subscription_billings b where b.id = v_q.subscription_billing_id;
  if v_b.invoice_id is not null then
    raise exception 'This part already has its tax invoice — it cannot be changed.' using errcode = '22023';
  end if;
  /* A customer invoiced on the due date gets the part's tax invoice then, paid or not — a seat
     change on the proforma would be lost there. Change the seats from Manage seats instead. */
  if exists (select 1 from public.customers c where c.id = v_q.customer_id and coalesce(c.invoice_parts_on_due_date, false)) then
    raise exception 'This customer is invoiced on the due date, so the proforma''s seats cannot change here — use Manage seats.'
      using errcode = '22023';
  end if;
  select s.plan, s.domain, s.term_months, s.billing_cycle::text as cycle, s.item_id into v_s
    from public.subscriptions s where s.id = v_b.subscription_id;

  v_taxable := p_seats * p_seat_rate;
  v_tax     := round(v_taxable * coalesce(v_q.tax_rate, 0) / 100.0);
  v_period  := to_char(v_b.period_start, 'FMDD Mon') || '–' || to_char(v_b.period_end - 1, 'FMDD Mon YYYY');
  v_cost    := public.r2922_part_seat_cost(v_q.tenant_id, v_s.item_id, p_seats, v_s.term_months,
                 public.r2922_part_whole_months(v_b.term_start, v_b.period_index, v_b.period_start, v_b.period_end, v_s.cycle));
  v_line := (v_q.line_items->0)
            || jsonb_build_object(
                 'name', public.part_request_line_name(v_s.plan, v_s.domain, p_seats, v_period, v_b.period_index,
                                                       public.part_request_parts_in_term(v_s.term_months, v_s.cycle)),
                 'qty', p_seats, 'rate', p_seat_rate, 'per_seat', true,
                 'period_start', v_b.period_start, 'period_end', v_b.period_end - 1,
                 /* R-2922: a seat's cost for the new seats (qty = seats here, always) */
                 'cost', v_cost)
            || case when v_s.item_id is not null then jsonb_build_object('item_id', v_s.item_id) else '{}'::jsonb end;
  perform set_config('app.r2519_write', 'on', true);
  update public.quotes
     set line_items = jsonb_build_array(v_line),
         seats = p_seats,
         subtotal = v_taxable,
         total_cost = v_cost * p_seats,
         amount = v_taxable + v_tax,
         proforma_seats = p_seats,
         proforma_seat_rate = p_seat_rate,
         /* R-2519b: the marker apply_part_request_terms requires — only this function writes it. */
         proforma_terms_set_at = now(),
         proforma_terms_set_by = auth.uid()
   where id = v_q.id;
  perform set_config('app.r2519_write', '', true);
  return jsonb_build_object('quote_id', v_q.id, 'seats', p_seats, 'seat_rate', p_seat_rate,
                            'taxable', v_taxable, 'amount', v_taxable + v_tax);
end;
$$;

revoke all on function public.bill_subscription_instalment(uuid, boolean) from public, anon;
grant execute on function public.bill_subscription_instalment(uuid, boolean) to authenticated, service_role;
revoke all on function public.bill_parts_together(uuid[]) from public, anon;
grant execute on function public.bill_parts_together(uuid[]) to authenticated, service_role;
revoke all on function public.set_part_request_terms(text, integer, integer) from public, anon;
grant execute on function public.set_part_request_terms(text, integer, integer) to authenticated, service_role;

commit;
