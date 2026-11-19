-- R-2923 (18 Nov 2026, R-2922 follow-up): the tax invoice raised when a part (month / quarter / half-year) of a
-- subscription is billed carries our COST on each part line — by the same rule the part's payment request uses
-- since R-2922 (r2922_part_seat_cost: the renewal quote's catalogue rule × the part's months). A per-seat line
-- (qty = seats) carries the cost of ONE seat, a lump line (qty 1) the whole line's cost; unknown stays 0.
-- Amounts, GST, totals, qty, rate, names, descriptions, dates and links do not change.
-- Migration 20261118182808_r2923_part_invoice_cost.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
--   L.  r2101_part_line with a seat cost               → per-seat line: the seat cost; lump line: seat cost × seats;
--                                                        the 6-argument form is unchanged (cost 0)
--   A.  Monthly, 49 seats × ₹450, request paid         → invoice ₹26,019 (22,050 + 3,969) as before; line 49 × ₹450, cost ₹300
--   T.  Seats changed on the request (12 → 8), paid    → invoice 8 × ₹200 = ₹1,888; cost ₹110 a seat (the new seats' slab)
--   Q.  Quarterly, 3 seats, ₹1,000 (does not divide)   → 1 × ₹1,000, ₹1,180; cost ₹2,700 on the one line
--   N.  A subscription with no catalogue item          → cost 0 (unknown), amounts as before
--   W.  A part that is not a whole billing cycle       → cost 0 (never a guess)
--   D.  A part invoiced with no request (billing run)  → the same cost on its line
--   B.  Bill together (two subscriptions), paid        → ONE invoice ₹3,27,137, two lines, each its own cost
--   M.  The body carries R-2923 and every earlier mark

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
  ('b2923000-0000-0000-0000-0000000000f1', 'R2923 Parts Co', 'r2923@example.test', '07', 'R923');
update public.tenants set books_start_date = '2025-04-01' where id = 'b2923000-0000-0000-0000-0000000000f1';

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices, item_type) values
  /* annual tier ₹450 / ₹300, monthly (Flexible) tier ₹540 / ₹360 */
  ('R2923-STR', 'b2923000-0000-0000-0000-0000000000f1', 'Google Workspace Business Starter', 'google', 450, 290,
   '{"annual":{"msrp":450,"wholesale":300},"monthly":{"msrp":540,"wholesale":360}}'::jsonb, 'subscription'),
  /* volume slabs: 1–10 seats ₹110, 11+ ₹100 */
  ('R2923-SLAB', 'b2923000-0000-0000-0000-0000000000f1', 'Google Workspace Business Standard', 'google', 200, 120,
   '{"slabs":[{"minSeats":1,"maxSeats":10,"msrp":200,"wholesale":110},{"minSeats":11,"maxSeats":null,"msrp":180,"wholesale":100}]}'::jsonb, 'subscription');

-- ── L. one invoice line of a part, with its cost ───────────────────────────────────────────────────
do $$
declare l jsonb;
begin
  if to_regprocedure('public.r2101_part_line(text,text,integer,integer,date,date,integer)') is null then
    raise exception 'FAIL L: r2101_part_line has no form that takes a seat cost'; end if;
  /* per-seat line: qty = seats, cost = one seat */
  l := public.r2101_part_line('instalment-2', 'Plan', 49, 22050, '2026-10-15', '2026-11-15', 300)->0;
  if (l->>'qty')::int <> 49 or (l->>'rate')::int <> 450 or (l->>'cost')::int <> 300
     or l->>'description' is distinct from 'Per seat · 15 Oct 2026 to 15 Nov 2026' or l->>'name' <> 'Plan' or l->>'id' <> 'instalment-2' then
    raise exception 'FAIL L: per-seat line %', l; end if;
  /* lump line: qty 1, cost = the whole line (seat cost × seats) */
  l := public.r2101_part_line('instalment-2', 'Plan', 3, 1000, '2026-10-01', '2027-01-01', 900)->0;
  if (l->>'qty')::int <> 1 or (l->>'rate')::int <> 1000 or (l->>'cost')::int <> 2700
     or l->>'description' is distinct from '3 seats · 01 Oct 2026 to 01 Jan 2027' then
    raise exception 'FAIL L: lump line %', l; end if;
  /* unknown / missing / negative cost → 0; no seats → 0 */
  if (public.r2101_part_line('x', 'Plan', 5, 500, '2026-10-01', '2026-11-01', 0)->0->>'cost')::int <> 0
     or (public.r2101_part_line('x', 'Plan', 5, 500, '2026-10-01', '2026-11-01', null)->0->>'cost')::int <> 0
     or (public.r2101_part_line('x', 'Plan', 5, 500, '2026-10-01', '2026-11-01', -4)->0->>'cost')::int <> 0
     or (public.r2101_part_line('x', 'Plan', 0, 500, '2026-10-01', '2026-11-01', 300)->0->>'cost')::int <> 0
     or (public.r2101_part_line('x', 'Plan', null, 500, '2026-10-01', '2026-11-01', 300)->0->>'cost')::int <> 0 then
    raise exception 'FAIL L: an unknown cost must be 0'; end if;
  /* with the same inputs the line is the 6-argument line, plus the cost */
  if (public.r2101_part_line('i', 'P', 7, 700, '2026-10-01', '2026-11-01', 0)) is distinct from (public.r2101_part_line('i', 'P', 7, 700, '2026-10-01', '2026-11-01'))
     or (public.r2101_part_line('i', 'P', 3, 1000, '2026-10-01', '2026-11-01', 0)) is distinct from (public.r2101_part_line('i', 'P', 3, 1000, '2026-10-01', '2026-11-01'))
     or (public.r2101_part_line('i', 'P', 7, 700, '2026-10-01', '2026-11-01')->0->>'cost')::int <> 0 then
    raise exception 'FAIL L: the 6-argument line moved'; end if;
  raise notice 'PASS L: r2101_part_line — a seat on a per-seat line, the whole line on a lump line, unknown 0';
end $$;

create function pg_temp.cust(p_n int) returns uuid language plpgsql as $f$
declare v_c uuid := ('b2923000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'b2923000-0000-0000-0000-0000000000f1', 'R2923 C' || p_n, '07', 'India');
  return v_c;
end $f$;

create function pg_temp.sub(p_n int, p_c uuid, p_plan text, p_item text, p_seats int, p_cycle text, p_term int, p_start date, p_renewal date)
returns uuid language plpgsql as $f$
declare v_s uuid := ('b2923000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, item_id, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status, domain)
  values (v_s, 'b2923000-0000-0000-0000-0000000000f1', p_c, (select name from public.customers where id = p_c), p_plan, p_item,
          'google'::vendor, p_seats, 1000, p_cycle::billing_cycle, p_term, p_start, p_renewal, 'grace_period', 2, 'active',
          'r2923-' || p_n || '.example.test');
  return v_s;
end $f$;

/* A part of index 2 that began on p_start and runs p_months (a whole cycle on its term's anchor). */
create function pg_temp.part(p_s uuid, p_k int, p_start date, p_months int, p_taxable int)
returns uuid language plpgsql as $f$
declare v_b uuid := ('b2923000-0000-0000-0000-0000000003' || lpad(p_k::text, 2, '0'))::uuid;
begin
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                            period_end, taxable_amount, tax_rate)
  values (v_b, 'b2923000-0000-0000-0000-0000000000f1', p_s, (p_start - make_interval(months => p_months))::date, 2, p_start, p_start,
          (p_start + make_interval(months => p_months))::date, p_taxable, 18);
  return v_b;
end $f$;

/* Pay a request in full (as Record payment / Razorpay do): the payment itself raises the part's tax invoice. */
create function pg_temp.pay(p_quote text, p_ref text) returns void language plpgsql as $f$
begin
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  select q.tenant_id, q.id, q.amount, 'bank_transfer', p_ref, 'received', now() from public.quotes q where q.id = p_quote;
end $f$;

do $$
declare
  v_c uuid; v_s uuid; p uuid; r jsonb; v_q record; v_inv record; l jsonb; raised record;
begin
  -- ── A. monthly, per-seat exact: request → paid → tax invoice ────────────────────────────────────
  v_c := pg_temp.cust(1);
  v_s := pg_temp.sub(1, v_c, 'Google Workspace Business Starter', 'R2923-STR', 49, 'monthly', 12, '2025-10-15', '2026-10-15');
  p := pg_temp.part(v_s, 1, '2026-10-15', 1, 49 * 450);
  r := public.bill_subscription_instalment(p, false);
  select * into v_q from public.quotes where id = r->>'quote_id';
  if (v_q.line_items->0->>'cost')::int <> 300 then raise exception 'FAIL A: the request line cost % (R-2922: ₹300)', v_q.line_items->0->>'cost'; end if;
  perform pg_temp.pay(v_q.id, 'R2923-A');
  select i.* into v_inv from public.invoices i join public.subscription_billings b on b.invoice_id = i.id where b.id = p;
  if not found then raise exception 'FAIL A: paying the request raised no tax invoice'; end if;
  /* the money is exactly as before */
  if v_inv.amount <> 26019 or v_inv.taxable_value <> 22050 or v_inv.tax_amount <> 3969 or v_inv.tax_rate <> 18 or v_inv.status::text <> 'paid'
     or v_inv.net_payable <> 26019 or v_inv.paid_amount <> 26019 or v_inv.quote_id is not null or jsonb_array_length(v_inv.line_items) <> 1 then
    raise exception 'FAIL A: the invoice''s own figures moved: amount % taxable % tax % status %', v_inv.amount, v_inv.taxable_value, v_inv.tax_amount, v_inv.status; end if;
  l := v_inv.line_items->0;
  if (l->>'qty')::int <> 49 or (l->>'rate')::int <> 450 or l->>'id' <> 'instalment-2' or l->>'name' <> 'Google Workspace Business Starter'
     or l->>'description' is distinct from 'Per seat · 15 Oct 2026 to 15 Nov 2026' then
    raise exception 'FAIL A: the invoice line moved %', l; end if;
  if (l->>'cost')::int is distinct from 300 then
    raise exception 'FAIL A: invoice line cost % (want ₹300 a seat, as on the request)', l->>'cost'; end if;
  /* the line carries nothing new but the cost (no catalogue item: HSN / filing readers see it as before) */
  if l ? 'item_id' then raise exception 'FAIL A: the invoice line must not name a catalogue item %', l; end if;
  raise notice 'PASS A: % ₹26,019 — 49 × ₹450, cost ₹300 a seat (₹14,700)', v_inv.id;

  -- ── T. the request's seats changed (12 → 8) before it is paid ───────────────────────────────────
  v_c := pg_temp.cust(2);
  v_s := pg_temp.sub(2, v_c, 'Google Workspace Business Standard', 'R2923-SLAB', 12, 'monthly', 12, '2025-10-01', '2026-10-01');
  p := pg_temp.part(v_s, 2, '2026-10-01', 1, 12 * 180);
  r := public.bill_subscription_instalment(p, false);
  perform public.set_part_request_terms(r->>'quote_id', 8, 200);
  select * into v_q from public.quotes where id = r->>'quote_id';
  if v_q.amount <> 1888 or (v_q.line_items->0->>'cost')::int <> 110 then raise exception 'FAIL T: request % / %', v_q.amount, v_q.line_items->0; end if;
  perform pg_temp.pay(v_q.id, 'R2923-T');
  select i.* into v_inv from public.invoices i join public.subscription_billings b on b.invoice_id = i.id where b.id = p;
  if not found then raise exception 'FAIL T: no tax invoice'; end if;
  l := v_inv.line_items->0;
  if v_inv.amount <> 1888 or v_inv.taxable_value <> 1600 or v_inv.status::text <> 'paid' or (l->>'qty')::int <> 8 or (l->>'rate')::int <> 200 then
    raise exception 'FAIL T: invoice amount % / %', v_inv.amount, l; end if;
  if (l->>'cost')::int is distinct from 110 then
    raise exception 'FAIL T: invoice line cost % (want ₹110 — the 1–10 slab of the 8 seats billed, as on the request)', l->>'cost'; end if;
  raise notice 'PASS T: 8 × ₹200 — cost ₹110 a seat, the request''s';

  -- ── Q. quarterly, amount that does not divide by the seats → one lump line ──────────────────────
  v_c := pg_temp.cust(3);
  v_s := pg_temp.sub(3, v_c, 'Google Workspace Business Starter', 'R2923-STR', 3, 'quarterly', 12, '2025-07-01', '2026-07-01');
  p := pg_temp.part(v_s, 3, '2026-10-01', 3, 1000);
  r := public.bill_subscription_instalment(p, false);
  perform pg_temp.pay(r->>'quote_id', 'R2923-Q');
  select i.* into v_inv from public.invoices i join public.subscription_billings b on b.invoice_id = i.id where b.id = p;
  if not found then raise exception 'FAIL Q: no tax invoice'; end if;
  l := v_inv.line_items->0;
  if v_inv.amount <> 1180 or v_inv.taxable_value <> 1000 or (l->>'qty')::int <> 1 or (l->>'rate')::int <> 1000
     or l->>'description' is distinct from '3 seats · 01 Oct 2026 to 01 Jan 2027' then
    raise exception 'FAIL Q: figures % / %', v_inv.amount, l; end if;
  if (l->>'cost')::int is distinct from 2700 then
    raise exception 'FAIL Q: invoice line cost % (want ₹2,700 — 3 seats × 3 months × ₹300, on the one line)', l->>'cost'; end if;
  raise notice 'PASS Q: quarterly lump line — cost ₹2,700';

  -- ── N. no catalogue item on the subscription ────────────────────────────────────────────────────
  v_c := pg_temp.cust(4);
  v_s := pg_temp.sub(4, v_c, 'Bespoke plan', null, 4, 'monthly', 12, '2025-10-01', '2026-10-01');
  p := pg_temp.part(v_s, 4, '2026-10-01', 1, 4 * 500);
  r := public.bill_subscription_instalment(p, false);
  perform pg_temp.pay(r->>'quote_id', 'R2923-N');
  select i.* into v_inv from public.invoices i join public.subscription_billings b on b.invoice_id = i.id where b.id = p;
  if not found then raise exception 'FAIL N: no tax invoice'; end if;
  l := v_inv.line_items->0;
  if v_inv.amount <> 2360 or (l->>'qty')::int <> 4 or (l->>'rate')::int <> 500 or (l->>'cost')::int <> 0 then
    raise exception 'FAIL N: % / %', v_inv.amount, l; end if;
  raise notice 'PASS N: no catalogue item → cost unknown (0)';

  -- ── W. a part that is not a whole cycle on its term's anchor ─────────────────────────────────────
  v_c := pg_temp.cust(5);
  v_s := pg_temp.sub(5, v_c, 'Google Workspace Business Starter', 'R2923-STR', 2, 'monthly', 12, '2025-10-01', '2026-10-01');
  p := pg_temp.part(v_s, 5, '2026-10-01', 1, 2 * 450);
  update public.subscription_billings set period_end = '2026-10-20' where id = p;
  r := public.bill_subscription_instalment(p, false);
  perform pg_temp.pay(r->>'quote_id', 'R2923-W');
  select i.* into v_inv from public.invoices i join public.subscription_billings b on b.invoice_id = i.id where b.id = p;
  if not found then raise exception 'FAIL W: no tax invoice'; end if;
  l := v_inv.line_items->0;
  if v_inv.amount <> 1062 or (l->>'qty')::int <> 2 or (l->>'rate')::int <> 450 or (l->>'cost')::int <> 0 then
    raise exception 'FAIL W: % / %', v_inv.amount, l; end if;
  raise notice 'PASS W: a short part → cost unknown (0)';

  -- ── D. invoiced with no request (the billing run's call) ────────────────────────────────────────
  v_c := pg_temp.cust(6);
  v_s := pg_temp.sub(6, v_c, 'Google Workspace Business Standard', 'R2923-SLAB', 5, 'monthly', 12, '2025-10-01', '2026-10-01');
  p := pg_temp.part(v_s, 6, '2026-10-01', 1, 5 * 200);
  select * into raised from public.raise_subscription_billing(p);
  select * into v_inv from public.invoices where id = raised.invoice_id;
  l := v_inv.line_items->0;
  if raised.gross <> 1180 or raised.already_raised or v_inv.amount <> 1180 or v_inv.taxable_value <> 1000 or v_inv.status::text <> 'pending'
     or (l->>'qty')::int <> 5 or (l->>'rate')::int <> 200 then
    raise exception 'FAIL D: % / %', v_inv.amount, l; end if;
  if (l->>'cost')::int is distinct from 110 then raise exception 'FAIL D: invoice line cost % (want ₹110)', l->>'cost'; end if;
  /* asked again: the same invoice, nothing rewritten */
  select * into raised from public.raise_subscription_billing(p);
  if not raised.already_raised or raised.invoice_id <> v_inv.id then raise exception 'FAIL D: a second call must answer the same invoice'; end if;
  raise notice 'PASS D: invoiced without a request — cost ₹110 a seat';
end $$;

-- ── B. Bill together → one invoice, each line its own cost ─────────────────────────────────────────
do $$
declare
  v_c uuid; v_a uuid; v_b uuid; pa uuid; pb uuid; r jsonb; v_inv record; la jsonb; lb jsonb;
begin
  v_c := pg_temp.cust(8);
  v_a := pg_temp.sub(8, v_c, 'Google Workspace Business Standard', 'R2923-SLAB', 161, 'monthly', 12, '2025-10-01', '2026-10-01');
  v_b := pg_temp.sub(9, v_c, 'Google Workspace Business Starter', 'R2923-STR', 49, 'monthly', 12, '2025-10-15', '2026-10-15');
  pa := pg_temp.part(v_a, 8, '2026-10-01', 1, 161 * 1585);
  pb := pg_temp.part(v_b, 9, '2026-10-15', 1, 49 * 450);
  r := public.bill_parts_together(array[pa, pb]);
  if (r->>'gross')::int <> 327137 then raise exception 'FAIL B: → %', r; end if;
  perform pg_temp.pay(r->>'quote_id', 'R2923-B');
  if (select count(*) from public.invoices where customer_id = v_c) <> 1
     or exists (select 1 from public.subscription_billings where id in (pa, pb) and invoice_id is null) then
    raise exception 'FAIL B: paid → % invoice(s)', (select count(*) from public.invoices where customer_id = v_c); end if;
  select * into v_inv from public.invoices where customer_id = v_c;
  if v_inv.amount <> 327137 or v_inv.taxable_value <> 277235 or v_inv.tax_amount <> 49902 or v_inv.status::text <> 'paid'
     or jsonb_array_length(v_inv.line_items) <> 2 then
    raise exception 'FAIL B: invoice % amount % taxable % status %', v_inv.id, v_inv.amount, v_inv.taxable_value, v_inv.status; end if;
  select x into la from jsonb_array_elements(v_inv.line_items) x where x->>'name' = 'Google Workspace Business Standard';
  select x into lb from jsonb_array_elements(v_inv.line_items) x where x->>'name' = 'Google Workspace Business Starter';
  if (la->>'qty')::int <> 161 or (la->>'rate')::int <> 1585 or (lb->>'qty')::int <> 49 or (lb->>'rate')::int <> 450
     or la->>'description' is distinct from 'Per seat · 01 Oct 2026 to 01 Nov 2026'
     or lb->>'description' is distinct from 'Per seat · 15 Oct 2026 to 15 Nov 2026' then
    raise exception 'FAIL B: lines moved % / %', la, lb; end if;
  if (la->>'cost')::int is distinct from 100 or (lb->>'cost')::int is distinct from 300 then
    raise exception 'FAIL B: line costs % / % (want ₹100 and ₹300 a seat)', la->>'cost', lb->>'cost'; end if;
  raise notice 'PASS B: together % ₹3,27,137 — two lines, cost ₹100 and ₹300 a seat', v_inv.id;
end $$;

-- ── M. the bodies ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)')
                  and prosrc like '%R-2923%' and prosrc like '%r2922_part_seat_cost%') then
    raise exception 'FAIL M: raise_subscription_billing does not carry R-2923'; end if;
  /* nothing newer was dropped (body of 20261114161903, R-2806) */
  if not exists (select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)')
                  and prosrc like '%R-2806%' and prosrc like '%R-2642%' and prosrc like '%R-2631%' and prosrc like '%R-2101%'
                  and prosrc like '%R-2095%' and prosrc like '%R-2092%' and prosrc like '%R-2044%' and prosrc like '%R-1803%'
                  and prosrc like '%R-1561%' and prosrc like '%R-885%' and prosrc like '%R-454%' and prosrc like '%R-372%'
                  and prosrc like '%billing_pool_subscriptions%' and prosrc like '%invoice_date_for_receipt%'
                  and prosrc like '%invoice_receipt_day%' and prosrc like '%quote_one_time_lines%'
                  and prosrc like '%supplier_invoice_problem%' and prosrc like '%activate_quote_on_credit%') then
    raise exception 'FAIL M: a newer rule is missing from raise_subscription_billing'; end if;
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.raise_subscription_billing(uuid)') and p.prosecdef) then
    raise exception 'FAIL M: raise_subscription_billing must stay security definer'; end if;
  raise notice 'PASS M';
end $$;

select 'R-2923 part invoice carries its cost: ALL PASS' as result;

rollback;
