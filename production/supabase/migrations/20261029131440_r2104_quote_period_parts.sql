-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.billing_part_group(uuid)') and prosrc like '%R-2104%')
-- deploy-key: r2104quoteperiodparts
-- 20261029131440_r2104_quote_period_parts.sql
--
-- R-2104 (29 Oct 2026, p0 money/GST, found by checker-2101 on localhost cb774a574): a quote with
-- ONE subscription, 3 seats × ₹1,002 a year billed quarterly. The Record payment sheet asked ₹886
-- for Q1 (the quote's ₹3,006 ÷ 4 = ₹751 + GST); the part was laid from the whole-rupee MRR,
-- ₹251 × 3 = ₹753 → ₹889. The customer paid exactly ₹886, the part looked ₹3 short and no tax
-- invoice was raised; the quote read 'Paid to date' + 'No invoice yet'.
--
-- One figure: the quote's period amount (planForQuote / quote_split_due's split).
--   · ONE subscription: the parts are now LAID with the quote's period taxables (app side,
--     lib/billing/instalments.ts quotePeriodTaxables, called by sync-instalments) — the
--     subscription_billings row, the payment request and the invoice all carry ₹751.
--   · SEVERAL subscriptions: billing_part_group already moved the group to the quote's period
--     taxable at billing time (R-2092), but only when the parts were off by ≤ ₹1 a line. Parts laid
--     from MRR are off by up to ₹1.5 a line a quarter plus the split's remainder, so 2 × (3 × ₹1,002)
--     quarterly stayed ₹3 over what the sheet asked. Now the guard is the deal itself: the group's
--     MRR × 12 within ₹6 a subscription of the quote's term taxable.
--
-- Not changed: the rest of billing_part_group (body of 20261029034541, R-2092 — its latest
-- definition); parts already invoiced (frozen); invoices already raised (no data repair).
-- Test: supabase/tests/r2104_quote_period_parts.test.sql

begin;

create or replace function public.billing_part_group(p_billing_id uuid)
returns table(billing_id uuid, subscription_id uuid, taxable integer, plan text, seats integer)
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2092: the not-yet-invoiced parts of one quote for one period — one tax invoice, one request.
   R-2104: the quote-period rounding applies when the subscriptions are the quote's deal (MRR × 12
   within ₹6 a subscription of the quote's term taxable), however many rupees the parts are off. */
declare
  v_b       record;
  v_sub     record;
  v_req     record;
  v_ids     uuid[];
  v_tax     integer[];
  v_plans   text[];
  v_seats   integer[];
  v_subs    uuid[];
  v_mrr     integer;
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
         array_agg(g.sid order by g.created_at, g.sid), sum(g.mrr)::int
    into v_ids, v_tax, v_plans, v_seats, v_subs, v_mrr
    from (select b2.id, b2.taxable_amount, s2.plan, s2.seats, s2.id as sid, s2.created_at,
                 round(coalesce(s2.mrr, 0))::int as mrr
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
     rounding, never a seat or price change. R-2104: "rounding" was ≤ ₹1 a line — but a part laid
     from a whole-rupee MRR is off by up to ₹0.5 a MONTH (₹1.5 a quarter) plus the quote split's
     remainder on the last part: 2 × (3 seats × ₹1,002) quarterly = ₹1,506 laid vs ₹1,503 asked,
     the sheet's ₹1,774 paid, the group's ₹1,777 "short" — no tax invoice. The test is now the
     DEAL: the group's MRR × 12 within ₹6 a subscription (an MRR's own rounding) of the quote's
     term taxable. A seat or price change moves the MRR by far more and keeps the parts as laid. */
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
      if v_diff <> 0 and abs(v_mrr * 12 - v_qtax) <= 6 * array_length(v_ids, 1) then
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
  'R-2092/R-2104: the parts of one quote for one period that are billed together (one tax invoice, one payment request), with each part''s taxable after quote-period rounding.';

commit;
