-- deploy-peek: to_regprocedure('public.r2101_part_line(text,text,integer,integer,date,date,integer)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)') and prosrc like '%R-2923%')
-- deploy-key: r2923partinvoicecost
-- 20261118182808_r2923_part_invoice_cost.sql
--
-- R-2923 (18 Nov 2026, found by the R-2922 review): the tax invoice of a part carries its cost.
--
-- ─── BEFORE ───────────────────────────────────────────────────────────────────────────────────────
-- Since R-2922 a part (month / quarter / half-year) payment request's line carries our cost
-- (r2922_part_line_cost). The tax invoice raised for that part — when the request is paid, or by the billing
-- run — builds its own lines (raise_subscription_billing → r2101_part_line) and wrote cost 0 on every one, so
-- the invoice of a month-wise subscription showed no cost.
--
-- ─── AFTER (NEW invoices only — this migration rewrites no stored row) ────────────────────────────
-- * Each part line of a new instalment invoice carries `cost`, per unit of its qty (as a quote line's cost):
--     per-seat line (qty = seats)   our cost of ONE seat for the part
--     lump line (qty 1)             the whole line's cost = a seat's cost × the seats
--   The seat cost is r2922_part_seat_cost — the SAME rule and function the part's request line uses since
--   R-2922 (the renewal quote's catalogue rule: Flexible → the monthly tier; else the volume slab for the
--   seats, else the annual tier, else the row's wholesale; × the part's months), read for the line's own
--   subscription (its catalogue item and term), the seats the line bills (after a request's changed seats were
--   put on the subscription — apply_part_request_terms, R-2519) and the part's months when it is exactly one
--   whole billing cycle. Unknown (no catalogue item, a row priced per year, a short / co-termed part, no
--   wholesale) stays 0 — never a guess. So the invoice line and its request line carry the same cost; it is
--   worked out when the invoice is raised, so a part invoiced with no request (billing run) or from a request
--   made before R-2922 (cost 0 on the request) gets it too.
-- * NOT changed: taxable, GST, rounding, totals, paid_amount / status / dates, the invoice number, qty and
--   rate (R-2101), the line's id / name / description, the one-time lines of a sale's first part
--   (quote_one_time_lines — they keep the cost the sale quote gave them), locks, guards and refusals. The
--   line gets no item_id: an invoice line's catalogue item is read by other paths (HSN, filing) and this card
--   is about cost only.
-- * r2101_part_line gets a 7-argument form (… , p_seat_cost) that holds the line rule; the 6-argument form
--   (R-2101) now calls it with cost 0 — the same line as before, so the rule lives in one place.
-- Body: raise_subscription_billing from 20261114161903 (R-2806) — the latest definition; every earlier mark
-- (R-2806, R-2642, R-2631, R-2101, R-2095, R-2092, R-2044, R-1803, R-1561, R-885, R-454, R-372) is kept.
-- Signature unchanged, grants restated. Still SECURITY DEFINER: the cost read (items) is by the instalment's
-- own tenant_id, which the function has already matched to the caller's company.
-- Test: supabase/tests/r2923_part_invoice_cost.test.sql (one transaction, rolled back).

begin;

-- ── 1. One invoice line of a part, with its cost ───────────────────────────────────────────────────
create or replace function public.r2101_part_line(
  p_id text, p_plan text, p_seats integer, p_taxable integer, p_start date, p_end date, p_seat_cost integer)
returns jsonb
language sql
immutable
set search_path = public
as $$
  /* R-2923: r2101_part_line's line (R-2101: qty = seats and a whole-rupee per-seat rate when the taxable
     divides exactly; else qty 1 × the taxable, seats in the description) with our cost per unit of its qty:
     one seat's cost on the per-seat line, a seat's cost × the seats on the lump line. Missing / negative → 0. */
  select jsonb_build_array(case
    when coalesce(p_seats, 0) > 0 and p_taxable is not null and p_taxable % p_seats = 0 then
      jsonb_build_object(
        'id', p_id, 'name', p_plan,
        'description', 'Per seat · ' || to_char(p_start, 'DD Mon YYYY') || ' to ' || to_char(p_end, 'DD Mon YYYY'),
        'qty', p_seats, 'rate', p_taxable / p_seats, 'cost', greatest(coalesce(p_seat_cost, 0), 0))
    else
      jsonb_build_object(
        'id', p_id, 'name', p_plan,
        'description', coalesce(p_seats, 0)::text || ' seats · '
                       || to_char(p_start, 'DD Mon YYYY') || ' to ' || to_char(p_end, 'DD Mon YYYY'),
        'qty', 1, 'rate', p_taxable, 'cost', greatest(coalesce(p_seat_cost, 0), 0) * greatest(coalesce(p_seats, 0), 0))
  end);
$$;
revoke all on function public.r2101_part_line(text, text, integer, integer, date, date, integer) from public, anon;
grant execute on function public.r2101_part_line(text, text, integer, integer, date, date, integer) to authenticated, service_role;   -- pure: no table read

/* R-2101's 6-argument form: the same line with no cost — it calls the form above (R-2923), so the per-seat /
   lump rule and the wording are written once. Signature and grants unchanged. */
create or replace function public.r2101_part_line(
  p_id text, p_plan text, p_seats integer, p_taxable integer, p_start date, p_end date)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select public.r2101_part_line(p_id, p_plan, p_seats, p_taxable, p_start, p_end, 0);
$$;
revoke all on function public.r2101_part_line(text, text, integer, integer, date, date) from public, anon;
grant execute on function public.r2101_part_line(text, text, integer, integer, date, date) to authenticated, service_role;   -- pure: no table read

-- ── 2. raise_subscription_billing — body of 20261114161903 (R-2806), part lines with their cost ────
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
  v_inv_date date;   -- R-2095
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
  v_once     record;   -- R-2095
  v_pre      date;     -- R-2642: the part's day before R-2631's GST shift
  v_rcpt     date;     -- R-2642: the day the receipts behind it covered it
  v_pool     integer;  -- R-2806: the pool's credit, read once
begin
  /* R-2923: each part line carries our cost — r2922_part_seat_cost, the rule the part's payment request uses
     since R-2922 (the renewal quote's catalogue rule × the part's months), for the seats and the catalogue item
     of the line's own subscription: one seat's cost on a per-seat line, the whole line's on a lump line
     (r2101_part_line), 0 = unknown. Only the lines' cost: no amount, tax, total, qty, rate, name or date moves. */
  /* R-2095 (Sept): the FIRST part of a sale billed in parts also carries the sale quote's one-time
     lines (setup, migration …) — billed once, never spread and never lost (quote_one_time_lines).
     R-2044: credit = public.instalment_credit (part payment requests count too).
     R-2092: one invoice for the quote's period — every part of billing_part_group, one line per
     subscription, tax rounded once on the total; the pool is the quote's.
     R-2101: each line is qty = seats × a per-seat rate when exact (r2101_part_line). */
  /* R-454: who may act WITHOUT a company of their own. Only trusted server paths: the
     service_role key (public quote-accept, cron, webhooks) or a direct database session
     (psql, scripts) that carries no request role at all. A signed-in user with no company
     (customer-portal login, apprentice, mid-signup) is NOT trusted — before R-454 a NULL
     current_tenant_id() skipped the tenant check entirely (fail-open). */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
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
    if not (coalesce(public.current_request_role(), '') = 'service_role'
            or (public.current_request_role() is null
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

  select s.id, s.tenant_id, s.customer_id, s.customer_name, s.plan, s.seats, s.quote_id,
         s.item_id, s.term_months, s.billing_cycle::text as cycle   -- R-2923: for the line's cost
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

  /* R-2092: ONE line per part of the group. A group of one is exactly the old single line.
     R-2101: qty = seats, rate = the part's taxable ÷ seats (57 × ₹800, 13 × ₹2,750) — only when
     that is exact in whole rupees; else qty 1 × the taxable with the seats in the description
     (₹2,000 over 3 seats is ₹666.67 each, and a tax invoice whose qty × rate does not equal its
     amount is wrong on its face). Either way qty × rate = the line's taxable. */
  v_lines := '[]'::jsonb;
  v_taxable := 0;
  v_parts := 0;
  /* R-2806: each line carries ITS part's own period — a Bill together group can hold subscriptions whose
     periods differ (an R-2092 group is one period, so its lines read exactly as before). */
  for v_group in
    select g.billing_id, g.subscription_id, g.taxable, g.plan, g.seats,
           coalesce(bp.period_start, v_b.period_start) as part_start, coalesce(bp.period_end, v_b.period_end) as part_end,
           /* R-2923: our cost of ONE seat for this part (0 = unknown) — its own subscription's catalogue item and
              term, the seats this line bills, and the part's months when it is one whole billing cycle. */
           public.r2922_part_seat_cost(v_b.tenant_id, sg.item_id, coalesce(g.seats, 0), sg.term_months,
             public.r2922_part_whole_months(bp.term_start, bp.period_index, bp.period_start, bp.period_end, sg.billing_cycle::text)) as seat_cost
      from public.billing_part_group(p_billing_id) with ordinality as g(billing_id, subscription_id, taxable, plan, seats, n)
      left join public.subscription_billings bp on bp.id = g.billing_id
      left join public.subscriptions sg on sg.id = g.subscription_id and sg.tenant_id = v_b.tenant_id
     order by g.n
  loop
    v_parts := v_parts + 1;
    v_taxable := v_taxable + v_group.taxable;
    v_lines := v_lines || public.r2101_part_line(
      'instalment-' || v_b.period_index::text || case when v_parts > 1 then '-' || v_parts::text else '' end,
      v_group.plan, v_group.seats, v_group.taxable, v_group.part_start, v_group.part_end, v_group.seat_cost);
  end loop;
  if v_parts = 0 then
    v_taxable := v_b.taxable_amount;
    v_lines := public.r2101_part_line('instalment-' || v_b.period_index::text, v_sub.plan, v_sub.seats,
                                      v_b.taxable_amount, v_b.period_start, v_b.period_end,
                                      /* R-2923: the same cost rule for a part that has no group */
                                      public.r2922_part_seat_cost(v_b.tenant_id, v_sub.item_id, coalesce(v_sub.seats, 0), v_sub.term_months,
                                        public.r2922_part_whole_months(v_b.term_start, v_b.period_index, v_b.period_start, v_b.period_end, v_sub.cycle)));
  end if;

  /* R-2095: the sale's one-time lines go on its first part's invoice, once. */
  if v_sub.quote_id is not null and v_b.period_index = 1
     and v_b.term_start = (select min(b2.term_start) from public.subscription_billings b2 where b2.subscription_id = v_b.subscription_id) then
    select * into v_once from public.quote_one_time_lines(v_sub.quote_id);
    if coalesce(v_once.taxable, 0) > 0 then
      v_lines := v_lines || v_once.lines;
      v_taxable := v_taxable + v_once.taxable;
    end if;
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
  v_pool := public.instalment_credit(v_b.subscription_id);   -- R-2806: once (it reads the whole bill group's pool)
  v_credit := least(v_pool, v_gross);
  v_status := case when v_credit >= v_gross then 'paid' else 'pending' end::invoice_status;

  /* R-372: the fallback was 0, which made every termless instalment due on issue.
     30 matches generate_invoice. */
  if v_sub.quote_id is not null then
    select coalesce(q.payment_terms_days, 30) into v_terms
      from public.quotes q where q.id = v_sub.quote_id;
  end if;
  v_terms := coalesce(v_terms, 30);

  /* R-2095: a part is dated its period's bill date (the quote period start) when that has passed —
     a part invoiced late for an earlier period was dated today. Never before the books lock. */
  v_inv_date := public.invoice_date_for_receipt(v_b.tenant_id, v_b.bill_on);
  /* R-2642: a settled part is paid on the day the money that pays it came in (R-015; generate_invoice since
     R-2631) — not on the invoice date R-2631 may have moved to the first open day. The quote's pool
     (instalment_credit) is spent oldest money first, so the money left over after this part (pool − gross) is
     the NEWEST receipts: this part was covered on the day the receipts, in order, first reach (all receipts −
     that surplus). Receipts = the same ones the pool counts: the sale quote's and the part requests of every
     part of the quote's subscriptions. Never before the part's own day (invoice_receipt_day of its bill date
     — money paid ahead is used on that day); none at all (a credit-note credit) → that day. */
  if v_status = 'paid' then
    v_pre := public.invoice_receipt_day(v_b.tenant_id, v_b.bill_on);
    with subs as (
      /* R-2806: the bill group's pool (no group = this subscription + its quote's, as before). */
      select bp.subscription_id as id from public.billing_pool_subscriptions(v_b.subscription_id) bp
    ), rc as (
      select p.id, p.received_at, p.amount from public.payments p
       where p.tenant_id = v_b.tenant_id and p.status = 'received'
         and (p.quote_id in (select s3.quote_id from public.subscriptions s3
                              where s3.id in (select id from subs) and s3.quote_id is not null)
              or p.quote_id in (select q.id from public.quotes q
                                 where q.tenant_id = v_b.tenant_id
                                   and q.subscription_billing_id in (select b2.id from public.subscription_billings b2
                                                                      where b2.subscription_id in (select id from subs))))
    ), cum as (
      select rc.received_at, sum(rc.amount) over (order by rc.received_at, rc.id) as c,
             sum(rc.amount) over () as total
        from rc
    )
    select (min(cum.received_at) at time zone 'Asia/Kolkata')::date into v_rcpt
      from cum
     where cum.c >= cum.total - greatest(v_pool - v_gross, 0)
       and cum.total - greatest(v_pool - v_gross, 0) > 0;
  end if;
  v_id := public.next_document_number('invoice', v_b.tenant_id, v_inv_date);
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
    v_inv_date, v_inv_date + v_terms,
    case when v_status = 'paid' then greatest(v_rcpt, v_pre) else null end,   -- R-2642
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

commit;
