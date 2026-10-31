-- deploy-peek: to_regprocedure('public.quote_one_time_lines(text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)') and prosrc like '%quote_one_time_lines%')
-- deploy-key: r2095splitsaleonetimelines
-- 20261030153513_r2095_split_sale_one_time_lines.sql
--
-- R-2095 (30 Oct 2026, September reconcile on staging): a sale billed in parts (quarterly /
-- half-yearly / monthly on a 1-year commitment) with a ONE-TIME line (setup, migration) never
-- invoiced that line: the parts are laid from the subscriptions (one-time lines make none), and the
-- whole-quote invoice is refused for a split-billed quote (reject_full_term_invoice_when_split_billed).
-- The reconcile drawer meanwhile spread the setup across the parts. Rule now: a one-time line is
-- billed ONCE, on the sale's first part.
--   quote_one_time_lines(quote)   the quote's non-subscription lines as invoice lines + their taxable
--                                 (after the quote's discount), tagged one_time_of = the quote; empty
--                                 when a live (not fully credited) invoice already carries them.
--   raise_subscription_billing    part 1 of the first term adds them (one tax figure on the total).
-- Body of raise_subscription_billing from 20261030054246 (R-2095 invoice date), the latest.
-- Test: supabase/tests/r2095_split_sale_one_time_lines.test.sql

begin;

create or replace function public.quote_one_time_lines(p_quote_id text)
returns table(lines jsonb, taxable integer)
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2095: a sale quote's one-time lines, once. */
declare
  v_q record;
begin
  select q.id, q.tenant_id, q.line_items, coalesce(q.discount_pct, 0) as discount_pct into v_q
    from public.quotes q where q.id = p_quote_id;
  if not found or jsonb_typeof(v_q.line_items) is distinct from 'array' then
    return query select '[]'::jsonb, 0; return;
  end if;
  /* Already on a live invoice (one not cancelled in full by credit notes). */
  if exists (select 1 from public.invoices i
              where i.tenant_id = v_q.tenant_id
                and i.line_items @> jsonb_build_array(jsonb_build_object('one_time_of', p_quote_id))
                and not exists (select 1 from public.subscription_billings b
                                 where b.tenant_id = i.tenant_id and i.id = any(b.credited_invoice_ids))) then
    return query select '[]'::jsonb, 0; return;
  end if;
  return query
  with li as (
    select l, ord,
           round(coalesce((l->>'qty')::numeric, 1) * coalesce((l->>'rate')::numeric, 0) * (100 - v_q.discount_pct) / 100.0)::int as amt
      from jsonb_array_elements(v_q.line_items) with ordinality t(l, ord)
     where jsonb_typeof(l) = 'object'
       and not public.quote_line_is_subscription(l, v_q.tenant_id, false)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'once-' || li.ord::text, 'name', coalesce(li.l->>'name', 'One-time'),
           'description', 'One-time · billed once',
           'qty', 1, 'rate', li.amt, 'cost', 0, 'one_time_of', p_quote_id) order by li.ord), '[]'::jsonb),
         coalesce(sum(li.amt), 0)::int
    from li where li.amt > 0;
end;
$$;
revoke all on function public.quote_one_time_lines(text) from public, anon, authenticated;
grant execute on function public.quote_one_time_lines(text) to service_role;

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
begin
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

  /* R-2092: ONE line per part of the group. A group of one is exactly the old single line.
     R-2101: qty = seats, rate = the part's taxable ÷ seats (57 × ₹800, 13 × ₹2,750) — only when
     that is exact in whole rupees; else qty 1 × the taxable with the seats in the description
     (₹2,000 over 3 seats is ₹666.67 each, and a tax invoice whose qty × rate does not equal its
     amount is wrong on its face). Either way qty × rate = the line's taxable. */
  v_lines := '[]'::jsonb;
  v_taxable := 0;
  v_parts := 0;
  for v_group in select * from public.billing_part_group(p_billing_id) loop
    v_parts := v_parts + 1;
    v_taxable := v_taxable + v_group.taxable;
    v_lines := v_lines || public.r2101_part_line(
      'instalment-' || v_b.period_index::text || case when v_parts > 1 then '-' || v_parts::text else '' end,
      v_group.plan, v_group.seats, v_group.taxable, v_b.period_start, v_b.period_end);
  end loop;
  if v_parts = 0 then
    v_taxable := v_b.taxable_amount;
    v_lines := public.r2101_part_line('instalment-' || v_b.period_index::text, v_sub.plan, v_sub.seats,
                                      v_b.taxable_amount, v_b.period_start, v_b.period_end);
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
  v_credit := least(public.instalment_credit(v_b.subscription_id), v_gross);
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
    case when v_status = 'paid' then v_inv_date else null end,
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
