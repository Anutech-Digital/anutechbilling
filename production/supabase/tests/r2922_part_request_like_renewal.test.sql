-- R-2922 (Pardeep, 18 Nov 2026 — staging Q-A378-27-0124 / PI-A378-27-0007 beside renewal quote Q-A378-27-0958):
-- "ye renewal quotation ki tarah jaye". A NEW part (month / quarter / half-year) payment request is built like a
-- renewal quotation's line: the subscription's catalogue item (item_id), qty = seats × a per-seat rate (R-2519,
-- unchanged), our COST a seat for the part's months (the renewal quote's catalogue rule) and the request's
-- total_cost. Amounts, GST, names, labels, periods, links and the payment → tax invoice path do not change.
-- Migration 20261118150000_r2922_part_request_like_renewal.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
--   A.  Monthly, 49 seats × ₹450, annual tier wholesale ₹300   → line: item_id, 49 × ₹450, cost ₹300 a seat;
--                                                                 total_cost ₹14,700; ₹22,050 + 18% = ₹26,019 as before;
--                                                                 name / description / notes as before; not is_renewal
--   S.  Volume slabs (1–10 ₹110, 11+ ₹100), 12 seats            → cost ₹100 a seat (the slab for these seats)
--   F.  Flexible (1-month term)                                  → the monthly tier's wholesale
--   Q.  Quarterly, 3 seats, ₹1,000 (does not divide)             → 1 × ₹1,000; cost = 3 seats × 3 months × wholesale
--   N.  A subscription with no catalogue item                    → no item_id on the line, cost 0 (unknown), total 0
--   Y.  A catalogue item priced per YEAR                         → item_id, cost 0 (never a guess)
--   W.  A part that is not a whole billing cycle                 → cost 0 (never a guess)
--   T.  Change the proforma's seats (set_part_request_terms)     → cost for the new seats' slab, total_cost follows
--   B.  Bill together (two subscriptions)                        → each line its own item_id and cost; total_cost the sum
--   P.  Pay the together proforma                                → ONE paid tax invoice of the same amount
--   M.  The bodies carry R-2922 and every earlier mark

begin;

-- R-1643 / R-1803: issuing a Tax Invoice needs the company's own GSTIN + address.
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
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b2922000-0000-0000-0000-0000000000f1', 'R2922 Parts Co', 'r2922@example.test', '07', 'R922');
update public.tenants set books_start_date = '2025-04-01' where id = 'b2922000-0000-0000-0000-0000000000f1';

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices, item_type) values
  /* annual tier ₹450 / ₹300, monthly (Flexible) tier ₹540 / ₹360 */
  ('R2922-STR', 'b2922000-0000-0000-0000-0000000000f1', 'Google Workspace Business Starter', 'google', 450, 290,
   '{"annual":{"msrp":450,"wholesale":300},"monthly":{"msrp":540,"wholesale":360}}'::jsonb, 'subscription'),
  /* volume slabs: 1–10 seats ₹110, 11+ ₹100; flat (no slab) would be ₹120 */
  ('R2922-SLAB', 'b2922000-0000-0000-0000-0000000000f1', 'Google Workspace Business Standard', 'google', 200, 120,
   '{"slabs":[{"minSeats":1,"maxSeats":10,"msrp":200,"wholesale":110},{"minSeats":11,"maxSeats":null,"msrp":180,"wholesale":100}]}'::jsonb, 'subscription'),
  /* a row priced per year: its cost for a month is not worked out here */
  ('R2922-YEAR', 'b2922000-0000-0000-0000-0000000000f1', 'Yearly support', 'support', 12000, 6000,
   '{"billing_unit":"unit_year"}'::jsonb, 'subscription');

create function pg_temp.cust(p_n int) returns uuid language plpgsql as $f$
declare v_c uuid := ('b2922000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'b2922000-0000-0000-0000-0000000000f1', 'R2922 C' || p_n, '07', 'India');
  return v_c;
end $f$;

create function pg_temp.sub(p_n int, p_c uuid, p_plan text, p_item text, p_seats int, p_cycle text, p_term int, p_start date, p_renewal date)
returns uuid language plpgsql as $f$
declare v_s uuid := ('b2922000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, item_id, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status, domain)
  values (v_s, 'b2922000-0000-0000-0000-0000000000f1', p_c, (select name from public.customers where id = p_c), p_plan, p_item,
          'google'::vendor, p_seats, 1000, p_cycle::billing_cycle, p_term, p_start, p_renewal, 'grace_period', 2, 'active',
          'r2922-' || p_n || '.example.test');
  return v_s;
end $f$;

/* A part of index 2 that began on p_start and runs p_months (a whole cycle on its term's anchor). */
create function pg_temp.part(p_s uuid, p_k int, p_start date, p_months int, p_taxable int)
returns uuid language plpgsql as $f$
declare v_b uuid := ('b2922000-0000-0000-0000-0000000003' || lpad(p_k::text, 2, '0'))::uuid;
begin
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                            period_end, taxable_amount, tax_rate)
  values (v_b, 'b2922000-0000-0000-0000-0000000000f1', p_s, (p_start - make_interval(months => p_months))::date, 2, p_start, p_start,
          (p_start + make_interval(months => p_months))::date, p_taxable, 18);
  return v_b;
end $f$;

do $$
declare
  v_c uuid; v_s uuid; p uuid; r jsonb; v_q record; l jsonb; v_due date;
begin
  -- ── A. monthly, per-seat exact, annual tier ─────────────────────────────────────────────────────
  v_c := pg_temp.cust(1);
  v_s := pg_temp.sub(1, v_c, 'Google Workspace Business Starter', 'R2922-STR', 49, 'monthly', 12, '2025-10-15', '2026-10-15');
  p := pg_temp.part(v_s, 1, '2026-10-15', 1, 49 * 450);
  r := public.bill_subscription_instalment(p, false);
  if r->>'action' <> 'request' or (r->>'created')::boolean is not true or (r->>'gross')::int <> 26019 or (r->>'parts')::int <> 1
     or r->>'label' is distinct from 'Payment for month 2 · 15 Oct–14 Nov 2026' then
    raise exception 'FAIL A: → %', r; end if;
  select * into v_q from public.quotes where id = r->>'quote_id';
  select due_on into v_due from public.subscription_billings where id = p;
  if v_q.id not like 'PI-%' or v_q.subscription_billing_id <> p or v_q.amount <> 26019 or v_q.subtotal <> 22050 or v_q.tax_rate <> 18
     or v_q.discount_pct <> 0 or v_q.status::text <> 'sent' or v_q.payment_status::text <> 'awaiting' or not v_q.is_one_off
     or v_q.plan <> 'Google Workspace Business Starter' or v_q.seats <> 49 or jsonb_array_length(v_q.line_items) <> 1 then
    raise exception 'FAIL A: the proforma''s own figures moved: % amount % subtotal % rate %', v_q.id, v_q.amount, v_q.subtotal, v_q.tax_rate; end if;
  /* not flagged a renewal QUOTE: is_renewal drives the whole-term renewal money paths (see the migration header) */
  if coalesce(v_q.is_renewal, false) or v_q.renewal_subscription_id is not null or coalesce(v_q.below_cost, false) then
    raise exception 'FAIL A: a part request must not be flagged is_renewal / below_cost (% / % / %)', v_q.is_renewal, v_q.renewal_subscription_id, v_q.below_cost; end if;
  l := v_q.line_items->0;
  if l->>'item_id' is distinct from 'R2922-STR' then raise exception 'FAIL A: line item_id % (want R2922-STR)', l->>'item_id'; end if;
  if (l->>'qty')::int <> 49 or (l->>'rate')::int <> 450 or (l->>'per_seat')::boolean is not true
     or l->>'period_start' <> '2026-10-15' or l->>'period_end' <> '2026-11-14'
     or (l->>'one_time')::boolean is not true or l->>'id' <> 'part-2' or l ? 'commitment' then
    raise exception 'FAIL A: line figures %', l; end if;
  if (l->>'cost')::int <> 300 then raise exception 'FAIL A: line cost % (want ₹300 a seat — annual tier × 1 month)', l->>'cost'; end if;
  if v_q.total_cost <> 14700 then raise exception 'FAIL A: total_cost % (want 49 × ₹300 = ₹14,700)', v_q.total_cost; end if;
  if l->>'name' is distinct from 'Google Workspace Business Starter · r2922-1.example.test · 49 seats · 15 Oct–14 Nov 2026 (part 2 of 12)'
     or l->>'description' is distinct from 'Payment for month 2 · 15 Oct–14 Nov 2026'
     or v_q.notes is distinct from 'Payment for month 2 · 15 Oct–14 Nov 2026. Due on ' || to_char(v_due, 'FMDD Mon YYYY') || '. The tax invoice is issued when this is paid.' then
    raise exception 'FAIL A: wording moved: % / % / %', l->>'name', l->>'description', v_q.notes; end if;
  raise notice 'PASS A: % — ₹26,019, 49 × ₹450, item %, cost ₹300 a seat, total cost ₹14,700', v_q.id, l->>'item_id';

  -- ── S. volume slab for the seats ────────────────────────────────────────────────────────────────
  v_c := pg_temp.cust(2);
  v_s := pg_temp.sub(2, v_c, 'Google Workspace Business Standard', 'R2922-SLAB', 12, 'monthly', 12, '2025-10-01', '2026-10-01');
  p := pg_temp.part(v_s, 2, '2026-10-01', 1, 12 * 180);
  r := public.bill_subscription_instalment(p, false);
  select * into v_q from public.quotes where id = r->>'quote_id';
  l := v_q.line_items->0;
  if (l->>'qty')::int <> 12 or (l->>'rate')::int <> 180 or (l->>'cost')::int <> 100 or v_q.total_cost <> 1200
     or l->>'item_id' <> 'R2922-SLAB' or v_q.subtotal <> 2160 or v_q.amount <> 2549 then
    raise exception 'FAIL S: % / total_cost % amount %', l, v_q.total_cost, v_q.amount; end if;
  raise notice 'PASS S: 12 seats → the 11+ slab, cost ₹100 a seat';

  -- ── T. the proforma's seats change → cost of the new seats' slab ────────────────────────────────
  r := public.set_part_request_terms(v_q.id, 8, 200);
  select * into v_q from public.quotes where id = v_q.id;
  l := v_q.line_items->0;
  if (r->>'taxable')::int <> 1600 or v_q.subtotal <> 1600 or v_q.amount <> 1888 or (l->>'qty')::int <> 8 or (l->>'rate')::int <> 200
     or (l->>'cost')::int <> 110 or v_q.total_cost <> 880 or l->>'item_id' <> 'R2922-SLAB' or (l->>'one_time')::boolean is not true
     or l->>'description' is distinct from 'Payment for month 2 · 1 Oct–31 Oct 2026' then
    raise exception 'FAIL T: % / subtotal % amount % total_cost %', l, v_q.subtotal, v_q.amount, v_q.total_cost; end if;
  raise notice 'PASS T: 8 seats → the 1–10 slab, cost ₹110 a seat, total cost ₹880';

  -- ── F. Flexible (1-month term) → the monthly tier ───────────────────────────────────────────────
  v_c := pg_temp.cust(3);
  v_s := pg_temp.sub(3, v_c, 'Google Workspace Business Starter', 'R2922-STR', 5, 'monthly', 1, '2026-09-01', '2026-10-01');
  p := pg_temp.part(v_s, 3, '2026-10-01', 1, 5 * 540);
  r := public.bill_subscription_instalment(p, false);
  select * into v_q from public.quotes where id = r->>'quote_id';
  l := v_q.line_items->0;
  if (l->>'qty')::int <> 5 or (l->>'rate')::int <> 540 or (l->>'cost')::int <> 360 or v_q.total_cost <> 1800 then
    raise exception 'FAIL F: % / total_cost %', l, v_q.total_cost; end if;
  raise notice 'PASS F: Flexible → the monthly tier, cost ₹360 a seat';

  -- ── Q. quarterly, amount that does not divide by the seats → one lump line ──────────────────────
  v_c := pg_temp.cust(4);
  v_s := pg_temp.sub(4, v_c, 'Google Workspace Business Starter', 'R2922-STR', 3, 'quarterly', 12, '2025-07-01', '2026-07-01');
  p := pg_temp.part(v_s, 4, '2026-10-01', 3, 1000);
  r := public.bill_subscription_instalment(p, false);
  select * into v_q from public.quotes where id = r->>'quote_id';
  l := v_q.line_items->0;
  if v_q.amount <> 1180 or v_q.subtotal <> 1000 or (l->>'qty')::int <> 1 or (l->>'rate')::int <> 1000 or (l->>'per_seat')::boolean is not false
     or l->>'item_id' <> 'R2922-STR' then
    raise exception 'FAIL Q: figures % / %', v_q.amount, l; end if;
  /* ₹300 a seat a month × 3 months × 3 seats, on the one line */
  if (l->>'cost')::int <> 2700 or v_q.total_cost <> 2700 then raise exception 'FAIL Q: cost % total %', l->>'cost', v_q.total_cost; end if;
  raise notice 'PASS Q: quarterly lump line → cost ₹2,700 (3 seats × 3 months × ₹300)';

  -- ── N. no catalogue item on the subscription ────────────────────────────────────────────────────
  v_c := pg_temp.cust(5);
  v_s := pg_temp.sub(5, v_c, 'Bespoke plan', null, 4, 'monthly', 12, '2025-10-01', '2026-10-01');
  p := pg_temp.part(v_s, 5, '2026-10-01', 1, 4 * 500);
  r := public.bill_subscription_instalment(p, false);
  select * into v_q from public.quotes where id = r->>'quote_id';
  l := v_q.line_items->0;
  if l ? 'item_id' or (l->>'cost')::int <> 0 or v_q.total_cost <> 0 or (l->>'qty')::int <> 4 or (l->>'rate')::int <> 500 or v_q.amount <> 2360 then
    raise exception 'FAIL N: % / total_cost %', l, v_q.total_cost; end if;
  raise notice 'PASS N: no catalogue item → no item_id, cost unknown (0)';

  -- ── Y. a row priced per year ────────────────────────────────────────────────────────────────────
  v_c := pg_temp.cust(6);
  v_s := pg_temp.sub(6, v_c, 'Yearly support', 'R2922-YEAR', 1, 'monthly', 12, '2025-10-01', '2026-10-01');
  p := pg_temp.part(v_s, 6, '2026-10-01', 1, 1000);
  r := public.bill_subscription_instalment(p, false);
  select * into v_q from public.quotes where id = r->>'quote_id';
  l := v_q.line_items->0;
  if l->>'item_id' <> 'R2922-YEAR' or (l->>'cost')::int <> 0 or v_q.total_cost <> 0 then
    raise exception 'FAIL Y: % / total_cost %', l, v_q.total_cost; end if;
  raise notice 'PASS Y: a per-year row → cost unknown (0), never a guess';

  -- ── W. a part that is not a whole cycle on its term''s anchor ────────────────────────────────────
  v_c := pg_temp.cust(7);
  v_s := pg_temp.sub(7, v_c, 'Google Workspace Business Starter', 'R2922-STR', 2, 'monthly', 12, '2025-10-01', '2026-10-01');
  p := pg_temp.part(v_s, 7, '2026-10-01', 1, 2 * 450);
  update public.subscription_billings set period_end = '2026-10-20' where id = p;
  r := public.bill_subscription_instalment(p, false);
  select * into v_q from public.quotes where id = r->>'quote_id';
  l := v_q.line_items->0;
  if l->>'item_id' <> 'R2922-STR' or (l->>'cost')::int <> 0 or v_q.total_cost <> 0 or v_q.subtotal <> 900 then
    raise exception 'FAIL W: % / total_cost %', l, v_q.total_cost; end if;
  raise notice 'PASS W: a short part → cost unknown (0)';
end $$;

-- ── B P — Bill together ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_c uuid; v_a uuid; v_b uuid; pa uuid; pb uuid; r jsonb; v_q record; la jsonb; lb jsonb; v_inv record;
begin
  v_c := pg_temp.cust(8);
  v_a := pg_temp.sub(8, v_c, 'Google Workspace Business Standard', 'R2922-SLAB', 161, 'monthly', 12, '2025-10-01', '2026-10-01');
  v_b := pg_temp.sub(9, v_c, 'Google Workspace Business Starter', 'R2922-STR', 49, 'monthly', 12, '2025-10-15', '2026-10-15');
  pa := pg_temp.part(v_a, 8, '2026-10-01', 1, 161 * 1585);
  pb := pg_temp.part(v_b, 9, '2026-10-15', 1, 49 * 450);

  r := public.bill_parts_together(array[pa, pb]);
  if r->>'action' <> 'request' or (r->>'taxable')::int <> 277235 or (r->>'tax')::int <> 49902 or (r->>'gross')::int <> 327137 then
    raise exception 'FAIL B: → %', r; end if;
  select * into v_q from public.quotes where id = r->>'quote_id';
  if v_q.amount <> 327137 or v_q.subtotal <> 277235 or v_q.tax_rate <> 18 or v_q.seats <> 210 or jsonb_array_length(v_q.line_items) <> 2
     or coalesce(v_q.is_renewal, false) then
    raise exception 'FAIL B: proforma % amount % subtotal %', v_q.id, v_q.amount, v_q.subtotal; end if;
  la := v_q.line_items->0; lb := v_q.line_items->1;
  if la->>'billing_id' <> pa::text or lb->>'billing_id' <> pb::text
     or (la->>'qty')::int <> 161 or (la->>'rate')::int <> 1585 or (lb->>'qty')::int <> 49 or (lb->>'rate')::int <> 450
     or la->>'id' <> 'part-2-1' or lb->>'id' <> 'part-2-2'
     or la->>'name' is distinct from 'Google Workspace Business Standard · r2922-8.example.test · 161 seats · 1 Oct–31 Oct 2026 (part 2 of 12)'
     or lb->>'description' is distinct from 'Payment for month 2 · 15 Oct–14 Nov 2026' then
    raise exception 'FAIL B: line figures / wording moved % / %', la, lb; end if;
  if la->>'item_id' is distinct from 'R2922-SLAB' or lb->>'item_id' is distinct from 'R2922-STR'
     or (la->>'cost')::int <> 100 or (lb->>'cost')::int <> 300 then
    raise exception 'FAIL B: item / cost % / %', la, lb; end if;
  if v_q.total_cost <> 161 * 100 + 49 * 300 then raise exception 'FAIL B: total_cost % (want ₹30,800)', v_q.total_cost; end if;
  raise notice 'PASS B: together % — two lines, each its item and cost; total cost ₹30,800', v_q.id;

  -- ── P. paid → one tax invoice of the same amount ────────────────────────────────────────────────
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2922000-0000-0000-0000-0000000000f1', v_q.id, v_q.amount, 'bank_transfer', 'R2922-B', 'received', now());
  if (select count(*) from public.invoices where customer_id = v_c) <> 1
     or exists (select 1 from public.subscription_billings where id in (pa, pb) and invoice_id is null) then
    raise exception 'FAIL P: paid → % invoice(s)', (select count(*) from public.invoices where customer_id = v_c); end if;
  select * into v_inv from public.invoices where customer_id = v_c;
  if v_inv.amount <> 327137 or v_inv.status::text <> 'paid' or jsonb_array_length(v_inv.line_items) <> 2 then
    raise exception 'FAIL P: invoice % amount % status %', v_inv.id, v_inv.amount, v_inv.status; end if;
  /* nothing new was filed from the request's catalogue lines */
  if (select count(*) from public.subscriptions where customer_id = v_c) <> 2 then
    raise exception 'FAIL P: paying the request filed a subscription (% now)', (select count(*) from public.subscriptions where customer_id = v_c); end if;
  if (select seats from public.subscriptions where id = v_a) <> 161 or (select renewal_date from public.subscriptions where id = v_b) <> '2026-10-15' then
    raise exception 'FAIL P: paying the request changed a subscription'; end if;
  raise notice 'PASS P: paid → one tax invoice % ₹3,27,137; subscriptions untouched', v_inv.id;
end $$;

-- ── M. the bodies ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from pg_proc
       where oid in (to_regprocedure('public.bill_subscription_instalment(uuid,boolean)'), to_regprocedure('public.bill_parts_together(uuid[])'),
                     to_regprocedure('public.set_part_request_terms(text,integer,integer)'))
         and prosrc like '%R-2922%' and prosrc like '%r2922_part_%') <> 3 then
    raise exception 'FAIL M: a part-request function does not carry R-2922'; end if;
  /* nothing newer was dropped */
  if not exists (select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)')
                  and prosrc like '%R-2865%' and prosrc like '%R-2527%' and prosrc like '%R-2230%' and prosrc like '%app.r2519_write%'
                  and prosrc like '%part_request_line_name%' and prosrc like '%v_label := ''Payment for ''%')
     or not exists (select 1 from pg_proc where oid = to_regprocedure('public.bill_parts_together(uuid[])')
                  and prosrc like '%R-2865%' and prosrc like '%R-2810%' and prosrc like '%billing_pool_subscriptions%')
     or not exists (select 1 from pg_proc where oid = to_regprocedure('public.set_part_request_terms(text,integer,integer)')
                  and prosrc like '%R-2519b%' and prosrc like '%proforma_terms_set_at%') then
    raise exception 'FAIL M: a newer rule is missing from a body'; end if;
  raise notice 'PASS M';
end $$;

select 'R-2922 part request like a renewal quotation: ALL PASS' as result;

rollback;
