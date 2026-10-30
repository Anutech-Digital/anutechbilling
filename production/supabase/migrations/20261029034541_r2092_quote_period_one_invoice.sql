-- deploy-peek: to_regprocedure('public.billing_part_group(uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)') and prosrc like '%R-2092%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)') and prosrc like '%R-2092%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.instalment_credit(uuid)') and prosrc like '%R-2092%')
-- deploy-key: r2092quoteperiodoneinvoice
-- 20261029034541_r2092_quote_period_one_invoice.sql
--
-- R-2092 (29 Oct 2026, p0 money/GST, found on staging): ONE quote with TWO subscriptions billed
-- in parts (Business Starter 57 × ₹3,200/yr + Business Standard 13 × ₹11,000/yr, annual
-- commitment billed quarterly, ₹3,83,972 = 4 × ₹95,993), paid ₹95,933 for Q1 (a ₹60 typo):
--   · TWO Q1 tax invoices were raised — one per subscription (₹53,808 + ₹42,186);
--   · together ₹95,994 — ₹1 more than the quote's Q1 (₹95,993): each part was rounded on its own
--     (Standard 11,917 mrr × 3 = 35,751 taxable; the quote's share is 35,750);
--   · BOTH were issued PAID, the second with no receipt behind it, though ₹95,933 < ₹95,994 —
--     and R-2048 ("no tax invoice for a part that is not fully paid") was bypassed;
--   · each subscription showed ₹60 due (₹120 on the customer) for one ₹60 shortfall.
--
-- ─── ROOT CAUSES ──────────────────────────────────────────────────────────────────────────
--   1. instalment_credit(subscription) counted the SALE QUOTE's receipts once PER SUBSCRIPTION:
--      every subscription of the quote saw the whole ₹95,933 as its own credit. Starter (₹53,808)
--      and Standard (₹42,186) each looked covered → R-2048's credit test passed for both, and
--      raise_subscription_billing issued both 'paid' (paid_amount = least(credit, gross)).
--   2. bill_subscription_instalment / raise_subscription_billing work on ONE subscription_billings
--      row = one subscription — so one invoice (and one payment request) per subscription.
--   3. The taxable of each part comes from that subscription's integer mrr (plannedInstalments),
--      never reconciled with the quote's own period amount (quote_split_due: the quote subtotal
--      ÷ parts, tax rounded once).
--   4. tg_subscriptions_split_outstanding capped EVERY subscription of the quote at the quote's
--      owed figure (₹60 each); sync_split_outstanding keeps it only on the quote's first
--      subscription and never cleared the others.
--
-- ─── WHAT CHANGES ─────────────────────────────────────────────────────────────────────────
--   billing_part_group(billing)   the parts billed together with this one: the not-yet-invoiced
--                                 parts of the SAME quote for the SAME period (period_start,
--                                 period_end, tax rate) of its active subscriptions, ordered by
--                                 subscription (created_at, id) — with each part's taxable. When
--                                 the group is every split-billed subscription of the quote and
--                                 the parts add up to within ₹(parts) of the quote's own period
--                                 taxable (quote_split_due's split), the rupee difference goes on
--                                 one line (the line the quote line says was rounded the other
--                                 way, else the last) — so the invoice total = the quote's period
--                                 amount (₹81,350 + ₹14,643 = ₹95,993). Once a payment request
--                                 exists for the group, the group and its taxables are the
--                                 request's own lines (what the customer was asked to pay).
--                                 A part with its own (pre-R-2092, one-subscription) request,
--                                 and a quote with one subscription, stay a group of one = the
--                                 old behaviour exactly.
--   instalment_credit(sub)        ONE pool per QUOTE: the sale quote's receipts once + receipts
--                                 on the quote's part requests (capped) − what the quote's
--                                 instalment invoices absorbed (each invoice once). A subscription
--                                 without a quote: as before.
--   raise_subscription_billing    raises ONE invoice for the whole group: one line per
--                                 subscription, tax rounded once on the total, every part of the
--                                 group linked to it; paid_amount = what the pool really covers
--                                 (short → pending with the balance due, never 'paid').
--   bill_subscription_instalment  decides on the GROUP's gross (R-2048 / R-2044 rules unchanged,
--                                 now applied to the money that is really there); an unpaid group
--                                 gets ONE payment request (one line per subscription, linked to
--                                 the group's first part); a part whose group already has a
--                                 request answers 'request_open' with it.
--   tg_payments_part_request_invoice  a paid group request turns back on every subscription of
--                                 the group the billing job paused for it.
--   stop_part_payment_request     "Customer stopped" on a group request cancels / pauses every
--                                 subscription of the group.
--   tg_subscriptions_split_outstanding / sync_split_outstanding  the quote's owed figure lives on
--                                 its FIRST subscription only; the others carry 0 (₹60 once).
--
-- Not changed: yearly subscriptions; single-subscription quotes; parts already invoiced
-- (frozen); invoices already raised (no data repair — Pardeep's call); record_payment.
-- Bodies: raise_subscription_billing, instalment_credit, tg_payments_part_request_invoice,
-- stop_part_payment_request from 20261028025317 (R-2044); bill_subscription_instalment from
-- 20261028043325 (R-2048); sync_split_outstanding from 20261011072600 (R-715);
-- tg_subscriptions_split_outstanding from 20261009235800 — each the latest definition.
-- Test: supabase/tests/r2092_quote_period_one_invoice.test.sql

begin;

-- ── 1. The parts billed together ───────────────────────────────────────────────────────────
create or replace function public.billing_part_group(p_billing_id uuid)
returns table(billing_id uuid, subscription_id uuid, taxable integer, plan text, seats integer)
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2092: the not-yet-invoiced parts of one quote for one period — one tax invoice, one request. */
declare
  v_b       record;
  v_sub     record;
  v_req     record;
  v_ids     uuid[];
  v_tax     integer[];
  v_plans   text[];
  v_seats   integer[];
  v_subs    uuid[];
  v_q       record;
  v_months  integer;
  v_count   integer;
  v_qtax    integer;
  v_per     integer;
  v_target  integer;
  v_sum     integer;
  v_diff    integer;
  v_pick    integer;
  v_all     integer;
  v_exact   numeric;
  v_line    jsonb;
  i         integer;
begin
  select b.* into v_b from public.subscription_billings b where b.id = p_billing_id;
  if not found then return; end if;
  select s.id, s.tenant_id, s.quote_id, s.plan, s.seats, s.billing_cycle::text as cycle
    into v_sub from public.subscriptions s where s.id = v_b.subscription_id;
  if not found then return; end if;

  /* Invoiced, or not sold on a quote: itself only (as before). */
  if v_b.invoice_id is not null or v_sub.quote_id is null then
    return query select v_b.id, v_b.subscription_id, v_b.taxable_amount, v_sub.plan, v_sub.seats;
    return;
  end if;

  /* A payment request already made for this part's group fixes the group: its lines name their
     parts (billing_id). A request without such lines (one subscription, before R-2092) keeps its
     part alone. */
  select q.id, q.line_items into v_req
    from public.quotes q
   where q.subscription_billing_id in (
           select b2.id from public.subscription_billings b2
             join public.subscriptions s2 on s2.id = b2.subscription_id
            where s2.tenant_id = v_sub.tenant_id and s2.quote_id = v_sub.quote_id
              and b2.period_start = v_b.period_start and b2.period_end = v_b.period_end)
     and (q.subscription_billing_id = v_b.id
          or q.line_items @> jsonb_build_array(jsonb_build_object('billing_id', v_b.id::text)))
   order by (q.subscription_billing_id = v_b.id) desc
   limit 1;
  if found then
    if not (v_req.line_items @> jsonb_build_array(jsonb_build_object('billing_id', v_b.id::text))) then
      return query select v_b.id, v_b.subscription_id, v_b.taxable_amount, v_sub.plan, v_sub.seats;
      return;
    end if;
    return query
      select b2.id, b2.subscription_id, (l->>'rate')::integer, s2.plan, s2.seats
        from jsonb_array_elements(v_req.line_items) with ordinality as x(l, n)
        join public.subscription_billings b2 on b2.id = (l->>'billing_id')::uuid
        join public.subscriptions s2 on s2.id = b2.subscription_id
       where b2.invoice_id is null
       order by x.n;
    return;
  end if;

  /* The quote's other parts for the same period, not invoiced and without a request of their own. */
  select array_agg(g.id order by g.created_at, g.sid), array_agg(g.taxable_amount order by g.created_at, g.sid),
         array_agg(g.plan order by g.created_at, g.sid), array_agg(g.seats order by g.created_at, g.sid),
         array_agg(g.sid order by g.created_at, g.sid)
    into v_ids, v_tax, v_plans, v_seats, v_subs
    from (select b2.id, b2.taxable_amount, s2.plan, s2.seats, s2.id as sid, s2.created_at
            from public.subscription_billings b2
            join public.subscriptions s2 on s2.id = b2.subscription_id
           where s2.tenant_id = v_sub.tenant_id
             and s2.quote_id = v_sub.quote_id
             and s2.billing_cycle::text = v_sub.cycle
             and (s2.id = v_sub.id or s2.status = 'active')
             and b2.period_start = v_b.period_start
             and b2.period_end = v_b.period_end
             and b2.tax_rate is not distinct from v_b.tax_rate
             and b2.invoice_id is null
             and not exists (select 1 from public.quotes r where r.subscription_billing_id = b2.id)) g;

  if v_ids is null or array_length(v_ids, 1) <= 1 then
    return query select v_b.id, v_b.subscription_id, v_b.taxable_amount, v_sub.plan, v_sub.seats;
    return;
  end if;

  /* Rounding at quote-period level: the quote's own period taxable (quote_split_due's split),
     only when the group is every split-billed subscription of the quote and the difference is
     rounding (≤ ₹1 a line), never a seat or price change. */
  select q.subtotal, q.discount_pct, q.billing_cycle::text as cycle, q.line_items into v_q
    from public.quotes q where q.id = v_sub.quote_id;
  v_months := case v_q.cycle when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6 else null end;
  select count(*) into v_all from public.subscriptions s2
   where s2.tenant_id = v_sub.tenant_id and s2.quote_id = v_sub.quote_id and s2.status = 'active'
     and s2.billing_cycle is distinct from 'yearly'::billing_cycle;
  if v_months is not null and v_q.cycle = v_sub.cycle and v_all = array_length(v_ids, 1) then
    v_qtax := round(coalesce(v_q.subtotal, 0))::int;
    v_qtax := v_qtax - round(v_qtax * coalesce(v_q.discount_pct, 0) / 100.0)::int;
    v_count := ceil(12.0 / v_months)::int;
    if v_qtax > 0 and v_count > 1 and v_b.period_index between 1 and v_count then
      v_per := floor(v_qtax::numeric / v_count)::int;
      v_target := v_per + case when v_b.period_index = v_count then v_qtax - v_per * v_count else 0 end;
      select sum(x) into v_sum from unnest(v_tax) x;
      v_diff := v_target - v_sum;
      if v_diff <> 0 and abs(v_diff) <= array_length(v_ids, 1) then
        /* The line whose own share (quote line qty × rate ÷ parts) lies on the side of the
           difference; else the last line. */
        v_pick := null;
        if coalesce(v_q.discount_pct, 0) = 0 and jsonb_typeof(v_q.line_items) = 'array' then
          for i in 1 .. array_length(v_ids, 1) loop
            select l into v_line from jsonb_array_elements(v_q.line_items) l
             where l->>'name' = v_plans[i]
               and (l->>'qty') ~ '^[0-9]+(\.0+)?$' and (l->>'qty')::numeric = v_seats[i]
             limit 1;
            if v_line is not null and (v_line->>'rate') ~ '^[0-9]+(\.[0-9]+)?$' then
              v_exact := (v_line->>'qty')::numeric * (v_line->>'rate')::numeric / v_count;
              if sign(v_exact - v_tax[i]) = sign(v_diff) then v_pick := i; exit; end if;
            end if;
          end loop;
        end if;
        v_pick := coalesce(v_pick, array_length(v_ids, 1));
        v_tax[v_pick] := v_tax[v_pick] + v_diff;
      end if;
    end if;
  end if;

  return query
    select v_ids[k], v_subs[k], v_tax[k], v_plans[k], v_seats[k]
      from generate_subscripts(v_ids, 1) k order by k;
end;
$$;
revoke all on function public.billing_part_group(uuid) from public, anon, authenticated;
grant execute on function public.billing_part_group(uuid) to service_role;
comment on function public.billing_part_group(uuid) is
  'R-2092: the parts of one quote for one period that are billed together (one tax invoice, one payment request), with each part''s taxable after quote-period rounding.';

-- ── 2. One credit pool per quote ───────────────────────────────────────────────────────────
create or replace function public.instalment_credit(p_subscription_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  /* R-2044; R-2092: ONE pool per quote — the sale quote's receipts counted once (not once per
     subscription), each instalment invoice absorbed once. */
  with me as (
    select s.id, s.tenant_id, s.quote_id from public.subscriptions s where s.id = p_subscription_id
  ), subs as (
    select s2.id from public.subscriptions s2, me
     where s2.id = me.id
        or (me.quote_id is not null and s2.tenant_id = me.tenant_id and s2.quote_id = me.quote_id)
  ), parts as (
    select b.id, b.invoice_id from public.subscription_billings b where b.subscription_id in (select id from subs)
  )
  select greatest(0,
           coalesce((select sum(p.amount)::int from public.payments p, me
                      where me.quote_id is not null and p.quote_id = me.quote_id and p.status = 'received'), 0)
         + coalesce((select sum(least(coalesce(q.amount, 0), coalesce(pr.received, 0)))::int
                       from public.quotes q
                       cross join lateral (select sum(p.amount) as received from public.payments p
                                            where p.quote_id = q.id and p.status = 'received') pr
                      where q.subscription_billing_id in (select id from parts)), 0)
         - coalesce((select sum(i.paid_amount)::int from public.invoices i
                      where i.id in (select invoice_id from parts where invoice_id is not null)), 0))::int;
$$;
revoke all on function public.instalment_credit(uuid) from public, anon, authenticated;
grant execute on function public.instalment_credit(uuid) to service_role;

-- ── 3. raise_subscription_billing — body of 20261028025317 (R-2044), one invoice per group ──
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
  v_group    record;
  v_taxable  integer;
  v_parts    integer;
begin
  /* R-2044: credit = public.instalment_credit (part payment requests count too).
     R-2092: one invoice for the quote's period — every part of billing_part_group, one line per
     subscription, tax rounded once on the total; the pool is the quote's. */
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

  /* R-2092: the group's parts are locked (id order) before anything is read from them. */
  perform 1 from public.subscription_billings b
   where b.id in (select g.billing_id from public.billing_part_group(p_billing_id) g)
   order by b.id
   for update;

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

  /* R-2092: ONE line per part of the group (qty 1, rate = that part's taxable). A group of one is
     exactly the old single line. The seat count and service period go in the description, where
     CGST Rule 46 wants them. Not qty = seats with a per-seat rate: an instalment of ₹2,000 over 3
     seats is ₹666.67 each, and a tax invoice whose qty × rate does not equal its amount is wrong
     on its face. */
  v_lines := '[]'::jsonb;
  v_taxable := 0;
  v_parts := 0;
  for v_group in select * from public.billing_part_group(p_billing_id) loop
    v_parts := v_parts + 1;
    v_taxable := v_taxable + v_group.taxable;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id',          'instalment-' || v_b.period_index::text || case when v_parts > 1 then '-' || v_parts::text else '' end,
      'name',        v_group.plan,
      'description', coalesce(v_group.seats, 0)::text || ' seats · '
                     || to_char(v_b.period_start, 'DD Mon YYYY') || ' to '
                     || to_char(v_b.period_end,   'DD Mon YYYY'),
      'qty',         1,
      'rate',        v_group.taxable,
      'cost',        0
    ));
  end loop;
  if v_parts = 0 then
    v_taxable := v_b.taxable_amount;
    v_lines := jsonb_build_array(jsonb_build_object(
      'id', 'instalment-' || v_b.period_index::text, 'name', v_sub.plan,
      'description', coalesce(v_sub.seats, 0)::text || ' seats · '
                     || to_char(v_b.period_start, 'DD Mon YYYY') || ' to '
                     || to_char(v_b.period_end,   'DD Mon YYYY'),
      'qty', 1, 'rate', v_b.taxable_amount, 'cost', 0));
  end if;

  v_tax   := round(v_taxable * v_rate / 100.0);
  v_gross := v_taxable + v_tax;

  -- ── What has already been paid towards this subscription ──────────────────
  /* R-2044: one rule, public.instalment_credit — the sale quote's receipts PLUS what was paid
     on this subscription's part payment requests, less what earlier instalment invoices of it
     already absorbed. Before R-2044 only the sale quote's receipts counted.
     R-2092: the pool is the QUOTE's (receipts once, not once per subscription) — an invoice is
     paid only by money really there; short → pending with the balance due. */
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
    v_taxable, v_tax, v_rate, v_inter,
    v_lines
  );

  /* R-2092: every part of the group points at this one invoice; a part whose taxable took the
     quote-period rounding carries the figure its line shows. */
  update public.subscription_billings b
     set invoice_id = v_id,
         taxable_amount = g.taxable,
         updated_at = now()
    from public.billing_part_group(p_billing_id) g
   where b.id = g.billing_id;
  update public.subscription_billings b
     set invoice_id = v_id, updated_at = now()
   where b.id = p_billing_id and b.invoice_id is null;

  return query select v_id, v_gross, false;
end;
$function$;

revoke all on function public.raise_subscription_billing(uuid) from public;
grant execute on function public.raise_subscription_billing(uuid) to authenticated, service_role;

-- ── 4. bill_subscription_instalment — body of 20261028043325 (R-2048), on the group ─────────
create or replace function public.bill_subscription_instalment(p_billing_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: invoice a paid part or make its payment request — once. R-2048: the sale quote's first part only when money covers it; an open unpaid sale quote IS its request. R-2092: the quote's parts for one period are ONE group — one invoice, one request, the quote's money pool. */
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

  select q.id, q.amount, q.status::text as status, q.invoice_id into v_q
    from public.quotes q where q.subscription_billing_id = any(v_ids)
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
  v_first := v_sub.quote_id is not null
             and v_b.period_index = 1
             and v_b.term_start = (select min(b2.term_start) from public.subscription_billings b2
                                    where b2.subscription_id = v_b.subscription_id);
  v_paid_up := public.instalment_credit(v_b.subscription_id) >= v_gross;

  /* v_on_due: the customer's "Invoice on due date" switch — the old path, a tax invoice on the
     bill date even if unpaid (chased by invoice-dunning). */
  if v_req_paid or v_on_due or v_paid_up then
    if coalesce(p_dry_run, false) then
      return jsonb_build_object('action', 'invoice', 'gross', v_gross, 'dry_run', true, 'parts', v_parts,
        'reason', case when v_req_paid then 'request_paid' when v_on_due then 'invoice_on_due_date'
                       when v_first then 'first_part_of_sale' else 'already_paid' end);
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
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name,
    case when v_parts > 1 then (select string_agg(x->>'plan', ' + ' order by n) from jsonb_array_elements(v_lines) with ordinality t(x, n))
         else v_sub.plan end,
    case when v_parts > 1 then v_seats else v_sub.seats end,
    v_gross, 'sent', 'awaiting',
    /* Prepaid: sent on the bill date (the period's first day) and due that day. No expiry — it
       stays open until it is paid or "Customer stopped". */
    v_sub.domain, public.ist_today(), null,
    /* R-2092: one line per subscription of the group, each naming its part (billing_id) — the
       group is then fixed by the request (billing_part_group). A group of one: the old line. */
    case when v_parts > 1 then
      (select jsonb_agg(jsonb_build_object(
                'id',          'part-' || v_b.period_index::text || '-' || n::text,
                'name',        v_label,
                'description', coalesce(x->>'plan', 'Subscription') || ' · ' || coalesce(x->>'seats', '0') || ' seats',
                'qty',         1,
                'rate',        (x->>'taxable')::integer,
                'cost',        0,
                'one_time',    true,
                'billing_id',  x->>'billing_id') order by n)
         from jsonb_array_elements(v_lines) with ordinality t(x, n))
    else
      jsonb_build_array(jsonb_build_object(
        'id',          'part-' || v_b.period_index::text,
        'name',        v_label,
        'description', coalesce(v_sub.plan, 'Subscription') || ' · ' || coalesce(v_sub.seats, 0)::text || ' seats',
        'qty',         1,
        'rate',        v_b.taxable_amount,
        'cost',        0,
        'one_time',    true))
    end,
    v_taxable, 0, 0, v_rate,
    true, 'yearly', 0,
    v_label || '. Due on ' || to_char(v_b.bill_on, 'FMDD Mon YYYY') || '. The tax invoice is issued when this is paid.',
    v_lead
  );
  return jsonb_build_object('action', 'request', 'quote_id', v_id, 'created', true, 'gross', v_gross, 'label', v_label, 'parts', v_parts);
end;
$$;
revoke all on function public.bill_subscription_instalment(uuid, boolean) from public, anon;
grant execute on function public.bill_subscription_instalment(uuid, boolean) to authenticated, service_role;

-- ── 5. A paid group request turns back on every subscription paused for it ──────────────────
create or replace function public.tg_payments_part_request_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2044; R-2092: every subscription of the request's group. */
declare
  v_q   record;
  v_res jsonb;
begin
  if new.status is distinct from 'received' or new.quote_id is null then
    return new;
  end if;
  select q.id, q.amount, q.invoice_id, q.subscription_billing_id, b.subscription_id, q.line_items
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
  /* The billing cron paused this subscription (R-2092: these subscriptions) for this unpaid
     request → on again. */
  update public.subscriptions s
     set status = 'active'
   where (s.id = v_q.subscription_id
          or s.id in (select b2.subscription_id
                        from jsonb_array_elements(coalesce(v_q.line_items, '[]'::jsonb)) l
                        join public.subscription_billings b2 on b2.id::text = l->>'billing_id'))
     and s.status = 'paused'
     and s.suspended_by = 'automation'
     and s.suspended_invoice_id is null
     and s.suspend_reason like '%' || v_q.id || '%';
  return new;
end;
$$;
revoke all on function public.tg_payments_part_request_invoice() from public, anon;

-- ── 6. "Customer stopped" on a group request: every subscription of the group ───────────────
create or replace function public.stop_part_payment_request(p_quote_id text, p_end text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: close an unpaid part request; cancel or pause its subscription. Nothing invoiced.
   R-2092: a request for a quote's period covers every subscription of that group. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note    text;
  v_sid     uuid;
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

  select q.id, q.tenant_id, q.status::text as status, q.invoice_id, q.amount, q.line_items,
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

  for v_sid in
    select v_q.subscription_id
    union
    select b2.subscription_id
      from jsonb_array_elements(coalesce(v_q.line_items, '[]'::jsonb)) l
      join public.subscription_billings b2 on b2.id::text = l->>'billing_id'
     where b2.tenant_id = v_q.tenant_id
  loop
    if p_end = 'cancel' and (select s.status::text from public.subscriptions s where s.id = v_sid) <> 'cancelled' then
      perform public.cancel_subscription(v_sid, public.ist_today(),
        v_note || ' (payment request ' || v_q.id || ' cancelled)', false);
    elsif p_end = 'pause' and (select s.status::text from public.subscriptions s where s.id = v_sid) = 'active' then
      perform public.suspend_subscription(v_sid,
        v_note || ' (payment request ' || v_q.id || ' cancelled)', false);
    end if;
  end loop;

  return jsonb_build_object('quote_id', v_q.id, 'subscription_id', v_q.subscription_id, 'end', p_end,
    'subscription_status', (select s.status::text from public.subscriptions s where s.id = v_q.subscription_id));
end;
$$;
revoke all on function public.stop_part_payment_request(text, text, text) from public, anon;
grant execute on function public.stop_part_payment_request(text, text, text) to authenticated, service_role;

-- ── 7. The quote's owed figure once: on its first subscription ─────────────────────────────
create or replace function public.tg_subscriptions_split_outstanding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2092: a split-billed quote's owed figure is carried by its FIRST subscription (the one
   sync_split_outstanding keeps); another subscription of the same quote carries 0 — before, each
   was capped at the quote's whole figure and the customer owed it twice (₹60 → ₹120). */
declare
  v_owed integer;
begin
  if new.quote_id is null or coalesce(new.outstanding_amount, 0) <= 0 then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.outstanding_amount is not distinct from old.outstanding_amount then
    return new;
  end if;
  v_owed := public.split_outstanding_for(new.quote_id, new.start_date);
  if v_owed is null then return new; end if;
  if exists (select 1 from public.subscriptions s
              where s.tenant_id = new.tenant_id and s.quote_id = new.quote_id and s.id <> new.id
                and (s.created_at, s.id) < (new.created_at, new.id)) then
    v_owed := 0;
  end if;
  if tg_op = 'INSERT' then
    new.outstanding_amount := v_owed;
  else
    new.outstanding_amount := least(new.outstanding_amount, v_owed);
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.sync_split_outstanding(p_subscription_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sub   record;
  v_first uuid;
  v_owed  integer;
  v_caller  uuid;
  v_trusted boolean;
begin
  /* R-715: same trust rule as R-454 — a signed-in login with no company is refused. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '42501';
  end if;
  select s.id, s.tenant_id, s.quote_id, s.start_date, s.status, s.written_off_at, s.outstanding_amount
    into v_sub
    from public.subscriptions s where s.id = p_subscription_id
   for update;
  if not found then return null; end if;
  if not v_trusted and v_sub.tenant_id is distinct from v_caller then
    raise exception 'subscription % is not in the caller''s tenant', p_subscription_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_sub.quote_id is null or v_sub.status <> 'active' or v_sub.written_off_at is not null then
    return null;
  end if;
  select s.id into v_first from public.subscriptions s
   where s.tenant_id = v_sub.tenant_id and s.quote_id = v_sub.quote_id
   order by s.created_at, s.id limit 1;
  if v_first is distinct from v_sub.id then
    /* R-2092: not the quote's first subscription — the quote's owed figure lives on the first;
       a copy here counted the same shortfall twice. */
    if coalesce(v_sub.outstanding_amount, 0) > 0
       and public.split_outstanding_for(v_sub.quote_id, v_sub.start_date) is not null then
      update public.subscriptions set outstanding_amount = 0 where id = v_sub.id;
      return 0;
    end if;
    return null;
  end if;

  v_owed := public.split_outstanding_for(v_sub.quote_id, v_sub.start_date);
  if v_owed is null then return null; end if;
  if v_owed is distinct from coalesce(v_sub.outstanding_amount, 0) then
    -- a raise is a plain write; the trigger only acts on a positive new value and
    -- caps it at the same figure, so this lands as computed
    update public.subscriptions set outstanding_amount = v_owed where id = v_sub.id;
  end if;
  return v_owed;
end; $function$;

commit;
