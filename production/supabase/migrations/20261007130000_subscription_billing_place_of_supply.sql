-- deploy-key: subbillpos
-- deploy-peek: exists(select 1 from pg_proc where proname='raise_subscription_billing' and prosrc like '%has no state (or GSTIN) on record%')
-- 20261007130000_subscription_billing_place_of_supply.sql
--
-- R-372 (P0 money/GST, 7 Oct 2026). Money-flow audit finding 4.
--
-- raise_subscription_billing — the cron that issues every instalment (monthly /
-- quarterly / half-yearly) tax invoice — still carried the place-of-supply rule that
-- R-041 (20260930174000) removed from generate_invoice:
--
--   v_inter := (v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st);
--
-- so a NULL state on either side silently became intra-state = CGST+SGST. That is the
-- expensive direction: an inter-state supply billed as CGST+SGST is tax paid to the wrong
-- government, GSTR-1 will not reconcile it, and the customer cannot claim the credit.
-- It also had no export check (a customer outside India was charged 18% domestic GST) and
-- no GSTIN fallback, and due date = issue day (v_terms 0) where generate_invoice defaults
-- to +30 days.
--
-- Changes, and ONLY these (body otherwise = the live definition from 20260930172000):
--   1. Place of supply, same rules as generate_invoice (R-041) and
--      invoice_party_snapshot (R-043):
--        · export (country set and not India)  → zero-rated: tax 0, rate 0, not inter-state
--        · state = state_code, else the GSTIN's ^[0-9]{2} prefix, for BOTH sides
--          (the snapshot trigger freezes pos_state_code with the same fallback, so the
--          tax head and the printed place of supply now agree)
--        · still unknown → REFUSE with a message naming the screen that fixes it.
--          The billing cron catches the error per subscription and reports it, and the
--          instalment stays unbilled, so the next run raises it once the state is set.
--   2. This block runs BEFORE tax/credit is computed, because an export changes v_tax and
--      v_gross, and the credit applied must be measured against the real gross.
--   3. Due date: quote payment_terms_days, else 30 (was: else 0 = due on issue).
--   4. invoices.tax_rate gets v_rate (0 for export) instead of v_b.tax_rate.


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
begin
  select b.* into v_b
    from public.subscription_billings b
   where b.id = p_billing_id
   for update;

  if not found then
    raise exception 'Billing instalment % not found', p_billing_id
      using errcode = 'no_data_found';
  end if;

  if public.current_tenant_id() is not null
     and v_b.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Billing instalment % is not in the caller''s tenant', p_billing_id
      using errcode = 'insufficient_privilege';
  end if;

  /* Already billed. Ordinary answer, not an error — the cron retries. */
  if v_b.invoice_id is not null then
    select i.amount into v_existing from public.invoices i where i.id = v_b.invoice_id;
    return query select v_b.invoice_id, coalesce(v_existing, 0), true;
    return;
  end if;

  select s.id, s.tenant_id, s.customer_id, s.customer_name, s.plan, s.seats, s.quote_id
    into v_sub
    from public.subscriptions s
   where s.id = v_b.subscription_id;

  if not found then
    raise exception 'Subscription % behind instalment % no longer exists',
      v_b.subscription_id, p_billing_id using errcode = 'no_data_found';
  end if;

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

  v_tax   := round(v_b.taxable_amount * v_rate / 100.0);
  v_gross := v_b.taxable_amount + v_tax;

  -- ── What has already been paid towards this subscription ──────────────────
  if v_sub.quote_id is not null then
    select coalesce(sum(p.amount), 0) into v_received
      from public.payments p
     where p.quote_id = v_sub.quote_id
       and p.status   = 'received';
  end if;

  select coalesce(sum(i.paid_amount), 0) into v_applied
    from public.subscription_billings b
    join public.invoices i on i.id = b.invoice_id
   where b.subscription_id = v_b.subscription_id;

  v_credit := least(greatest(0, v_received - v_applied), v_gross);
  v_status := case when v_credit >= v_gross then 'paid' else 'pending' end::invoice_status;

  /* R-372: the fallback was 0, which made every termless instalment due on issue.
     30 matches generate_invoice. */
  if v_sub.quote_id is not null then
    select coalesce(q.payment_terms_days, 30) into v_terms
      from public.quotes q where q.id = v_sub.quote_id;
  end if;
  v_terms := coalesce(v_terms, 30);

  /* ONE line, qty 1, rate = the whole instalment. Not qty = seats with a per-seat
     rate: an instalment of ₹2,000 over 3 seats is ₹666.67 each, and a tax invoice
     whose qty × rate does not equal its amount is wrong on its face. The seat count
     and service period go in the description, where CGST Rule 46 wants them. */
  v_lines := jsonb_build_array(jsonb_build_object(
    'id',          'instalment-' || v_b.period_index::text,
    'name',        v_sub.plan,
    'description', coalesce(v_sub.seats, 0)::text || ' seats · '
                   || to_char(v_b.period_start, 'DD Mon YYYY') || ' to '
                   || to_char(v_b.period_end,   'DD Mon YYYY'),
    'qty',         1,
    'rate',        v_b.taxable_amount,
    'cost',        0
  ));

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
    greatest(0, v_gross - v_credit), v_credit,
    v_b.taxable_amount, v_tax, v_rate, v_inter,
    v_lines
  );

  update public.subscription_billings
     set invoice_id = v_id, updated_at = now()
   where id = p_billing_id;

  return query select v_id, v_gross, false;
end;
$function$;

comment on function public.raise_subscription_billing(uuid) is
  'Issues the tax invoice for one subscription instalment (idempotent). R-372: place of supply as generate_invoice — state_code else GSTIN prefix; export zero-rated; unknown state refuses; due = quote terms else +30 days.';

revoke all on function public.raise_subscription_billing(uuid) from public;
grant execute on function public.raise_subscription_billing(uuid) to authenticated, service_role;

