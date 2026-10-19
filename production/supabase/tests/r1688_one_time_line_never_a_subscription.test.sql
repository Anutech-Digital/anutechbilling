-- R-1688 + R-1686 follow-up (19 Oct 2026): a ONE-TIME quote line never becomes a subscription,
-- on every filing path. Migration 20261019164713_r1688_one_time_line_never_a_subscription.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Found on localhost (5b0cffbd): Q-F588-27-0024 = annual Workspace + a custom line
-- "T-M5 Email migration (one-time)" saved with NO commitment (the builder's One-time). "Invoice now"
-- filed TWO subscriptions — the migration as "Annual · ₹5,000", MRR ₹417. Cause: the filing loops in
-- file_invoiced_quote_subscriptions and activate_quote_on_credit compute
-- `v_is_monthly := v_commitment = 'monthly'` = NULL for a missing commitment, so
-- `continue when not (false or NULL)` is `continue when NULL` — which does NOT continue.
--
-- Proves (each on a quote of annual Workspace 10 x 3,000 + a one-time line 1 x 5,000):
--   A. Invoice now (generate_invoice), one-time line marked {"one_time": true}      → 1 subscription
--   B. Paid first (record_payment in full), same marker                              → 1 subscription
--   C. Pay later (activate_quote_on_credit), same marker                             → 1 subscription
--   D. commitment "one_time" (any older writer) on all three paths                   → 1 subscription each
--      (old record_payment / activate_quote_on_credit filed it as Annual)
--   E. a CATALOGUE one-time item (items billing unit one_time) with no commitment and no marker
--      (lines the R-1668 builder saved before the marker) → Invoice now and pay later file none
--   F. NO REGRESSION — a legacy line with no commitment, no marker and no one-time catalogue item
--      keeps today's meaning on each path: filed by Invoice now and pay later, not by paid-first.
--   G. the helper itself: marker / commitment / catalogue / legacy flag, and an annual line
--      marked one-time by mistake is NOT filed (the marker wins).

begin;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000168801','R1688 Co','r1688@example.in','07','R1688');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000168801','owner1688@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000168801','dddddddd-0000-0000-0000-000000168801','owner1688@example.in','Owner 1688','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain, allow_pay_later, credit_limit)
  values ('cccccccc-0000-0000-0000-000000168801','dddddddd-0000-0000-0000-000000168801','Acme 1688','07','acme1688.in', true, 10000000);

-- Catalogue: one item whose billing unit is one-time, one whose item_type says one-time (pre-R-526),
-- one per-seat Workspace row.
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, item_type, prices) values
  ('R1688-MIG', 'dddddddd-0000-0000-0000-000000168801', 'R1688 Email migration', 'other', 5000, 2000, 'subscription', '{"billing_unit":"one_time"}'),
  ('R1688-SET', 'dddddddd-0000-0000-0000-000000168801', 'R1688 Setup',           'other', 5000, 2000, 'one_time',     '{}'),
  ('R1688-GW',  'dddddddd-0000-0000-0000-000000168801', 'R1688 Workspace',       'google', 250,  200, 'subscription', '{}');

-- 10 x 3,000 + 1 x 5,000 = 35,000 + 18% = 41,300.
create temp table r1688_q (id text, one_time_line jsonb) on commit drop;
insert into r1688_q values
  ('Q-R1688-A',  '{"name":"T-M5 Email migration (one-time)","qty":1,"rate":5000,"one_time":true}'),
  ('Q-R1688-B',  '{"name":"T-M5 Email migration (one-time)","qty":1,"rate":5000,"one_time":true}'),
  ('Q-R1688-C',  '{"name":"T-M5 Email migration (one-time)","qty":1,"rate":5000,"one_time":true}'),
  ('Q-R1688-DA', '{"name":"Setup and migration","qty":1,"rate":5000,"commitment":"one_time"}'),
  ('Q-R1688-DB', '{"name":"Setup and migration","qty":1,"rate":5000,"commitment":"one_time"}'),
  ('Q-R1688-DC', '{"name":"Setup and migration","qty":1,"rate":5000,"commitment":"one_time"}'),
  ('Q-R1688-EA', '{"name":"R1688 Email migration","item_id":"R1688-MIG","qty":1,"rate":5000}'),
  ('Q-R1688-EC', '{"name":"R1688 Setup","item_id":"R1688-SET","qty":1,"rate":5000}'),
  ('Q-R1688-FA', '{"name":"Legacy support plan","qty":1,"rate":5000}'),
  ('Q-R1688-FB', '{"name":"Legacy support plan","qty":1,"rate":5000}'),
  ('Q-R1688-FC', '{"name":"Legacy support plan","qty":1,"rate":5000}');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items)
select q.id, 'dddddddd-0000-0000-0000-000000168801', 'cccccccc-0000-0000-0000-000000168801', 'Acme 1688',
       41300, 35000, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(
         jsonb_build_object('name','Google Workspace Business Starter','item_id','R1688-GW','qty',10,'rate',3000,
                            'commitment','annual_yearly','domain', lower(q.id) || '.acme1688.in'),
         q.one_time_line)
  from r1688_q q;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000168801","role":"authenticated"}', true);

create temp table r1688_result (step text, quote_id text, subs int, plans text) on commit drop;
grant all on r1688_result to authenticated;

-- Invoice now / paid first / pay later on each quote.
do $$
begin
  perform public.generate_invoice('Q-R1688-A');
  perform public.record_payment('Q-R1688-B', 41300, 'upi', 'r1688-pay-b');
  perform public.activate_quote_on_credit('Q-R1688-C', 15, false, 'Old customer, pays on time');
  perform public.generate_invoice('Q-R1688-DA');
  perform public.record_payment('Q-R1688-DB', 41300, 'upi', 'r1688-pay-db');
  perform public.activate_quote_on_credit('Q-R1688-DC', 15, false, 'Old customer, pays on time');
  perform public.generate_invoice('Q-R1688-EA');
  perform public.activate_quote_on_credit('Q-R1688-EC', 15, false, 'Old customer, pays on time');
  perform public.generate_invoice('Q-R1688-FA');
  perform public.record_payment('Q-R1688-FB', 41300, 'upi', 'r1688-pay-fb');
  perform public.activate_quote_on_credit('Q-R1688-FC', 15, false, 'Old customer, pays on time');
end $$;

do $$
declare
  r record;
  v_want int;
  v_fail text := '';
begin
  for r in
    select q.id,
           (select count(*) from public.subscriptions s where s.quote_id = q.id)::int as n,
           (select string_agg(s.plan || ' mrr ' || s.mrr, ', ' order by s.plan) from public.subscriptions s where s.quote_id = q.id) as plans
      from r1688_q q order by q.id
  loop
    -- F: today's legacy meaning — Invoice now and pay later file a no-commitment line, paid first does not.
    v_want := case when r.id in ('Q-R1688-FA', 'Q-R1688-FC') then 2 else 1 end;
    if r.n <> v_want then
      v_fail := v_fail || format(' %s: %s subscription(s) [%s], want %s;', r.id, r.n, r.plans, v_want);
    else
      raise notice 'ok % → % subscription(s): %', r.id, r.n, r.plans;
    end if;
  end loop;
  if v_fail <> '' then raise exception 'FAIL A-F:%', v_fail; end if;
  -- The one subscription is the annual Workspace line, MRR 30,000 / 12 = 2,500.
  if exists (select 1 from public.subscriptions s join r1688_q q on q.id = s.quote_id
              where s.plan <> 'Google Workspace Business Starter' and q.id not like 'Q-R1688-F%') then
    raise exception 'FAIL A-E: a one-time line became a subscription';
  end if;
  if exists (select 1 from public.subscriptions s where s.quote_id = 'Q-R1688-A' and (s.mrr <> 2500 or s.outstanding_amount <> 41300)) then
    raise exception 'FAIL A: annual subscription mrr/dues wrong';
  end if;
  raise notice 'PASS A-F: one-time lines filed no subscription on Invoice now, paid first, pay later; legacy lines unchanged';
end $$;

-- G. The helper, line by line.
do $$
declare t uuid := 'dddddddd-0000-0000-0000-000000168801';
begin
  if public.quote_line_is_subscription('{"name":"x","one_time":true}', t, true) then raise exception 'FAIL G1: marker'; end if;
  if public.quote_line_is_subscription('{"name":"x","one_time":"true"}', t, true) then raise exception 'FAIL G1b: marker as text'; end if;
  if public.quote_line_is_subscription('{"name":"x","commitment":"annual_yearly","one_time":true}', t, true) then raise exception 'FAIL G2: marker must win'; end if;
  if public.quote_line_is_subscription('{"name":"x","commitment":"one_time"}', t, true) then raise exception 'FAIL G3: commitment one_time'; end if;
  if public.quote_line_is_subscription('{"name":"x","item_id":"R1688-MIG"}', t, true) then raise exception 'FAIL G4: catalogue billing unit'; end if;
  if public.quote_line_is_subscription('{"name":"x","item_id":"R1688-SET"}', t, true) then raise exception 'FAIL G5: catalogue item_type'; end if;
  if not public.quote_line_is_subscription('{"name":"x","commitment":"annual_yearly","item_id":"R1688-MIG"}', t, false) then
    raise exception 'FAIL G6: a line the owner set to Annual stays a subscription'; end if;
  if not public.quote_line_is_subscription('{"name":"x","commitment":"monthly"}', t, false) then raise exception 'FAIL G7: monthly'; end if;
  if not public.quote_line_is_subscription('{"name":"x","commitment":"annual_quarterly","one_time":false}', t, false) then raise exception 'FAIL G8: legacy annual tier'; end if;
  if not public.quote_line_is_subscription('{"name":"x"}', t, true) then raise exception 'FAIL G9: legacy missing, path files'; end if;
  if public.quote_line_is_subscription('{"name":"x"}', t, false) then raise exception 'FAIL G10: legacy missing, path skips'; end if;
  if not public.quote_line_is_subscription('{"name":"x","item_id":"R1688-GW"}', t, true) then raise exception 'FAIL G11: per-seat catalogue row'; end if;
  -- Another company's one-time item does not decide this tenant's line.
  if not public.quote_line_is_subscription('{"name":"x","item_id":"R1688-MIG"}', '00000000-0000-0000-0000-000000000000', true) then
    raise exception 'FAIL G12: catalogue lookup crossed tenants'; end if;
  raise notice 'PASS G: quote_line_is_subscription';
end $$;

select 'PASS' as r1688_one_time_line_never_a_subscription;

rollback;
