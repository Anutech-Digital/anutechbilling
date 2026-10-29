-- R-2097 (29 Oct 2026, staging reconcile R-2094). Migration 20261029045403_r2097_opening_sub_fractional_tier.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. A product priced ₹1,000 / seat / YEAR (cost ₹800 / yr) stores a FRACTIONAL monthly tier
--      (83.333… / 66.666…). Selling 40 seats of it works on all three filing paths — Invoice now
--      (generate_invoice → file_invoiced_quote_subscriptions), paid first (record_payment) and
--      pay later (activate_quote_on_credit). Before the migration each one failed with
--      "invalid input syntax for type integer: 66.66…" on (prices->'annual'->>'wholesale')::int.
--      The vendor cost per seat-month is rounded once (₹67), and the quote line's ₹1,000 × 40 stays
--      ₹40,000 (amount 47,200 with GST) — nothing reprices the yearly rate.
--   B. An "Opening — billed outside this app" subscription: external_source = 'opening' is accepted,
--      it owes nothing (outstanding 0, no quote, no invoice), and its current term can never be laid
--      or invoiced here — the trigger refuses it and names "outside this app (opening)". The next
--      term (after billed_externally_until) is laid as usual.
--   C. Any other external_source is still refused by the check constraint.

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address.
create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000209701','R2097 Co','r2097@example.in','07','R2097');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000209701','owner2097@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000209701','dddddddd-0000-0000-0000-000000209701','owner2097@example.in','Owner 2097','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain, allow_pay_later, credit_limit)
  values ('cccccccc-0000-0000-0000-000000209701','dddddddd-0000-0000-0000-000000209701','Acme 2097','07','acme2097.in', true, 10000000);

-- The item form now stores yearly ₹1,000 / ₹800 as an exact (unrounded) monthly tier.
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, item_type, prices) values
  ('R2097-SEAT', 'dddddddd-0000-0000-0000-000000209701', 'R2097 Seat plan', 'google', 83, 67, 'subscription',
   '{"annual":{"msrp":83.33333333333333,"wholesale":66.66666666666667},"billing_unit":"seat_month"}');

-- 40 × ₹1,000 = ₹40,000 + 18% = ₹47,200.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items)
select q, 'dddddddd-0000-0000-0000-000000209701', 'cccccccc-0000-0000-0000-000000209701', 'Acme 2097',
       47200, 40000, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name','R2097 Seat plan','item_id','R2097-SEAT','qty',40,'rate',1000,'cost',800,
                         'commitment','annual_yearly','domain', lower(q) || '.acme2097.in'))
  from unnest(array['Q-R2097-A','Q-R2097-B','Q-R2097-C']) q;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000209701","role":"authenticated"}', true);

do $$
begin
  perform public.generate_invoice('Q-R2097-A');
  perform public.record_payment('Q-R2097-B', 47200, 'upi', 'r2097-pay-b');
  perform public.activate_quote_on_credit('Q-R2097-C', 15, false, 'Old customer, pays on time');
exception when others then
  raise exception 'FAIL A: filing a subscription for a ₹1,000/yr item failed: %', sqlerrm;
end $$;

do $$
declare r record; v_n int := 0;
begin
  for r in select s.quote_id, s.seats, s.vendor_cost_per_seat_month, q.amount, q.subtotal
             from public.subscriptions s join public.quotes q on q.id = s.quote_id
            where s.quote_id like 'Q-R2097-%' order by s.quote_id loop
    v_n := v_n + 1;
    if r.seats <> 40 then raise exception 'FAIL A: % seats %, want 40', r.quote_id, r.seats; end if;
    if r.vendor_cost_per_seat_month is distinct from 67 then
      raise exception 'FAIL A: % vendor cost %/seat-month, want 67 (66.67 rounded once)', r.quote_id, r.vendor_cost_per_seat_month; end if;
    if r.amount <> 47200 or r.subtotal <> 40000 then
      raise exception 'FAIL A: % quote repriced: amount % subtotal %', r.quote_id, r.amount, r.subtotal; end if;
  end loop;
  if v_n <> 3 then raise exception 'FAIL A: % subscriptions filed, want 3 (one per path)', v_n; end if;
  raise notice 'PASS A: ₹1,000/yr item (fractional monthly tier) files on Invoice now, paid first, pay later';
end $$;

-- B. Opening subscription.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, used, mrr,
                                  billing_cycle, term_months, start_date, renewal_date, status, domain,
                                  outstanding_amount, auto_renew, external_source, billed_externally_until)
values ('eeeeeeee-0000-4000-8000-000000209701', 'dddddddd-0000-0000-0000-000000209701', 'cccccccc-0000-0000-0000-000000209701',
        'Acme 2097', 'R2097 Seat plan', 'google'::vendor, 5, 0, 417, 'quarterly'::billing_cycle, 12,
        date '2026-04-01', date '2027-03-31', 'active', 'opening.acme2097.in', 0, true, 'opening', date '2027-03-31');

do $$
declare v_msg text;
begin
  if exists (select 1 from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000209701'
              and (outstanding_amount <> 0 or quote_id is not null)) then
    raise exception 'FAIL B: opening subscription owes money or carries a quote'; end if;
  begin
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                              period_start, period_end, taxable_amount, tax_rate)
    values ('eeeeeeee-0000-4000-8000-0000002097b1', 'dddddddd-0000-0000-0000-000000209701', 'eeeeeeee-0000-4000-8000-000000209701',
            date '2026-04-01', 2, date '2026-07-01', date '2026-07-01', date '2026-09-30', 1250, 18);
    raise exception 'FAIL B: an instalment of the opening term was laid';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%outside this app (opening)%' then raise exception 'FAIL B: wrong refusal: %', v_msg; end if;
  end;
  -- The next term bills here.
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                            period_start, period_end, taxable_amount, tax_rate)
  values ('eeeeeeee-0000-4000-8000-0000002097b2', 'dddddddd-0000-0000-0000-000000209701', 'eeeeeeee-0000-4000-8000-000000209701',
          date '2027-04-01', 1, date '2027-04-01', date '2027-04-01', date '2027-06-30', 1250, 18);
  raise notice 'PASS B: opening subscription owes nothing; its term is never invoiced here; next term is';
end $$;

-- C. Other sources are still refused.
do $$
begin
  begin
    update public.subscriptions set external_source = 'tally' where id = 'eeeeeeee-0000-4000-8000-000000209701';
    raise exception 'FAIL C: external_source tally accepted';
  exception when check_violation then null;
  end;
  raise notice 'PASS C: unknown external_source refused';
end $$;

select 'PASS' as r2097_opening_sub_fractional_tier;

rollback;
