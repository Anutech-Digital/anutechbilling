\set ON_ERROR_STOP on
-- R-2847 (15 Nov 2026, p1 money) — R-2809a: ONE renewal quote for 2+ yearly subscriptions of one customer.
-- Migration 20261115125834_r2847_renewal_quote_together. Self-asserting, ONE transaction, rolled back. Local DB only.
-- RED without the migration (no create_renewal_quote_together / renewal_quote_subscriptions).
--
--   K  not-ready gate: while record_payment does not renew every linked subscription (R-2848) → refused 0A000
--      (the rest of this file opens the gate inside the rolled-back transaction)
--   A  2 yearly subs (31 Oct + 15 Nov) → ONE quote, 2 lines each its own subscription / term / period, subtotal sum,
--      GST on the total, both linked, 2 link rows, renewal_subscription_id null
--   B  same set again (and in another order) → same quote, created false, no 2nd quote number
--   D  a sub with its own open renewal quote → refused; D2 a sub already on another together quote → refused
--   E  two customers / no customer → refused     F split-billed / 1-month term → refused; F2 Won't renew / not active
--   G  mixed GST rates → refused                 H no price / no line / one sub / same sub twice / 24 months → refused
--   I  seat cut scheduled: the part must be at the cut's seats; the link guard checks THAT sub's seats, not the total
--   J  another company's ids read like unknown ids; sales role → 42501; owner login → works
--   L  link lost → create_renewal_quote relinks the together quote (no 2nd quote); together call relinks too
--   M  a cancelled together quote (no money) frees the terms → a new together quote can be made
--   N  browser login: edit lines / amount / Revise a together quote → refused; server code may
--   Z  grants: helper functions not callable by browser roles; table read-only to authenticated

begin;

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
  ('c2847000-0000-0000-0000-0000000000f1', 'R2847 Together Co', 'r2847@example.test', '07', 'R847'),
  ('c2847000-0000-0000-0000-0000000000f2', 'R2847 Other Co', 'r2847o@example.test', '07', 'R84O');

create function pg_temp.cust(p_n int, p_tenant uuid default 'c2847000-0000-0000-0000-0000000000f1') returns uuid
language plpgsql as $f$
declare v_c uuid := ('c2847000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, p_tenant, 'R2847 C' || p_n, '07', 'India');
  return v_c;
end $f$;

create function pg_temp.sub(p_n int, p_c uuid, p_plan text, p_seats int, p_renewal date,
                            p_cycle text default 'yearly', p_term int default 12,
                            p_tenant uuid default 'c2847000-0000-0000-0000-0000000000f1') returns uuid
language plpgsql as $f$
declare v_s uuid := ('c2847000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status, domain)
  values (v_s, p_tenant, p_c, (select name from public.customers where id = p_c), p_plan,
          'google'::vendor, p_seats, 1000, p_cycle::billing_cycle, p_term, p_renewal - 365, p_renewal, 'grace_period', 1,
          'active', 'r2847-' || p_n || '.example.test');
  return v_s;
end $f$;

/* The app's price for one subscription (createRenewalQuote's p_quote shape). */
create function pg_temp.q(p_plan text, p_seats int, p_subtotal int, p_rate int default 18) returns jsonb
language sql immutable as $f$
  select jsonb_build_object(
    'customer_name', 'R2847', 'plan', p_plan, 'seats', p_seats,
    'amount', p_subtotal + round(p_subtotal * p_rate / 100.0)::int, 'subtotal', p_subtotal,
    'total_cost', (p_subtotal * 0.8)::int, 'tax_rate', p_rate,
    'created_date', '2026-10-20', 'expires_date', '2026-11-30', 'extension_months', 12,
    'notes', 'R-2847 test',
    'line_items', jsonb_build_array(jsonb_build_object('id', 'renewal-1', 'name', p_plan, 'qty', p_seats,
                                    'rate', p_subtotal / p_seats, 'cost', 0, 'commitment', 'annual_yearly')))
$f$;

create function pg_temp.part(p_s uuid, p_q jsonb) returns jsonb language sql immutable as $f$
  select jsonb_build_object('subscription_id', p_s, 'quote', p_q)
$f$;

/* The error a call raises, as 'SQLSTATE message', or 'OK <quote>'. */
create function pg_temp.try(p_tenant uuid, p_parts jsonb) returns text language plpgsql as $f$
declare r jsonb;
begin
  r := public.create_renewal_quote_together(p_tenant, p_parts);
  return 'OK ' || (r->>'quote_id');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $f$;

-- ── K — not-ready gate ───────────────────────────────────────────────────────────────────────────────────────
do $$
declare v_c uuid; a uuid; b uuid; v_msg text;
begin
  v_c := pg_temp.cust(1);
  a := pg_temp.sub(1, v_c, 'Business Standard', 20, '2026-10-31');
  b := pg_temp.sub(2, v_c, 'Business Starter', 10, '2026-11-15');
  if public.r2847_together_payment_ready() then
    raise notice 'SKIP K: record_payment already renews every linked subscription (R-2848 is in) — gate open';
  else
    v_msg := pg_temp.try('c2847000-0000-0000-0000-0000000000f1',
               jsonb_build_array(pg_temp.part(a, pg_temp.q('Business Standard', 20, 264000)),
                                 pg_temp.part(b, pg_temp.q('Business Starter', 10, 84000))));
    if v_msg not like '0A000 One renewal quote for several yearly subscriptions is not ready%' then
      raise exception 'FAIL K: expected the not-ready refusal, got %', v_msg;
    end if;
    if exists (select 1 from public.quotes where customer_id = v_c) then raise exception 'FAIL K: a quote was made'; end if;
    raise notice 'PASS K: refused while record_payment cannot renew every linked subscription: %', v_msg;
  end if;
end $$;

/* Open the gate for the rest of this rolled-back file (R-2848 opens it for real). */
create or replace function public.r2847_together_payment_ready() returns boolean language sql stable as $$ select true $$;

-- ── A — one quote, two lines ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  a uuid := 'c2847000-0000-0000-0000-000000000201'; b uuid := 'c2847000-0000-0000-0000-000000000202';
  r jsonb; v_q record; v_l jsonb; v_n int;
begin
  r := public.create_renewal_quote_together('c2847000-0000-0000-0000-0000000000f1',
         jsonb_build_array(pg_temp.part(a, pg_temp.q('Business Standard', 20, 264000)),
                           pg_temp.part(b, pg_temp.q('Business Starter', 10, 84000))));
  if (r->>'created')::boolean is not true then raise exception 'FAIL A: created should be true: %', r; end if;
  select * into v_q from public.quotes where id = r->>'quote_id';
  if v_q.subtotal <> 348000 then raise exception 'FAIL A: subtotal % (expected 348000)', v_q.subtotal; end if;
  if v_q.tax_rate <> 18 or v_q.amount <> 348000 + 62640 then raise exception 'FAIL A: amount % at % (expected 410640 at 18)', v_q.amount, v_q.tax_rate; end if;
  if not v_q.is_renewal or v_q.extension_months <> 12 or v_q.status::text <> 'sent' or v_q.payment_status::text <> 'awaiting' then
    raise exception 'FAIL A: quote flags renewal=% months=% status=% pay=%', v_q.is_renewal, v_q.extension_months, v_q.status, v_q.payment_status; end if;
  if v_q.renewal_subscription_id is not null or v_q.renewal_term_date is not null then
    raise exception 'FAIL A: renewal_subscription_id/term should stay null on a together quote'; end if;
  if v_q.seats <> 30 or v_q.customer_id <> 'c2847000-0000-0000-0000-000000000101' then raise exception 'FAIL A: seats % customer %', v_q.seats, v_q.customer_id; end if;
  if jsonb_array_length(v_q.line_items) <> 2 then raise exception 'FAIL A: % lines', jsonb_array_length(v_q.line_items); end if;
  v_l := v_q.line_items->0;
  if v_l->>'subscription_id' <> a::text or v_l->>'renewal_term_date' <> '2026-10-31'
     or v_l->>'period_start' <> '2026-10-31' or v_l->>'period_end' <> '2027-10-30' or (v_l->>'qty')::int <> 20 then
    raise exception 'FAIL A: line 1 %', v_l; end if;
  v_l := v_q.line_items->1;
  if v_l->>'subscription_id' <> b::text or v_l->>'period_start' <> '2026-11-15' or v_l->>'period_end' <> '2027-11-14' then
    raise exception 'FAIL A: line 2 %', v_l; end if;
  if v_l->>'id' = (v_q.line_items->0->>'id') then raise exception 'FAIL A: line ids not unique'; end if;
  select count(*) into v_n from public.subscriptions where id in (a, b) and renewal_quote_id = v_q.id;
  if v_n <> 2 then raise exception 'FAIL A: % subscriptions linked', v_n; end if;
  select count(*) into v_n from public.renewal_quote_subscriptions
   where quote_id = v_q.id and ((subscription_id = a and renewal_term_date = '2026-10-31' and subtotal = 264000 and seats = 20)
                             or (subscription_id = b and renewal_term_date = '2026-11-15' and subtotal = 84000 and seats = 10));
  if v_n <> 2 then raise exception 'FAIL A: link rows wrong (% right)', v_n; end if;
  perform set_config('r2847.a', v_q.id, false);
  raise notice 'PASS A: one renewal quote % — 2 lines, own periods, ₹348000 + 18%% = ₹410640, both linked', v_q.id;
end $$;

-- ── B — same set again ───────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  a uuid := 'c2847000-0000-0000-0000-000000000201'; b uuid := 'c2847000-0000-0000-0000-000000000202';
  r jsonb; v_n int;
begin
  r := public.create_renewal_quote_together('c2847000-0000-0000-0000-0000000000f1',
         jsonb_build_array(pg_temp.part(b, pg_temp.q('Business Starter', 10, 84000)),
                           pg_temp.part(a, pg_temp.q('Business Standard', 20, 264000))));
  if r->>'quote_id' <> current_setting('r2847.a') or (r->>'created')::boolean then raise exception 'FAIL B: %', r; end if;
  if (r->>'amount')::int <> 410640 then raise exception 'FAIL B: amount %', r->>'amount'; end if;
  select count(*) into v_n from public.quotes where customer_id = 'c2847000-0000-0000-0000-000000000101';
  if v_n <> 1 then raise exception 'FAIL B: % quotes for the customer', v_n; end if;
  raise notice 'PASS B: same set (other order) → same quote, created false';
end $$;

-- ── D — open renewal quotes ──────────────────────────────────────────────────────────────────────────────────
do $$
declare v_c uuid; a uuid; b uuid; x uuid; r jsonb; v_msg text;
begin
  v_c := pg_temp.cust(2);
  a := pg_temp.sub(3, v_c, 'D One', 5, '2026-12-01');
  b := pg_temp.sub(4, v_c, 'D Two', 5, '2026-12-05');
  r := public.create_renewal_quote(a, 'c2847000-0000-0000-0000-0000000000f1', pg_temp.q('D One', 5, 60000));
  v_msg := pg_temp.try('c2847000-0000-0000-0000-0000000000f1',
             jsonb_build_array(pg_temp.part(a, pg_temp.q('D One', 5, 60000)), pg_temp.part(b, pg_temp.q('D Two', 5, 60000))));
  if v_msg not like '22023 Renewal quote ' || (r->>'quote_id') || ' is still open%for D One%' then raise exception 'FAIL D: %', v_msg; end if;
  raise notice 'PASS D: own open renewal quote → %', v_msg;
  -- D2: b + x together, then a (freed) + b → b is on another together quote
  x := pg_temp.sub(5, v_c, 'D Three', 5, '2026-12-09');
  r := public.create_renewal_quote_together('c2847000-0000-0000-0000-0000000000f1',
         jsonb_build_array(pg_temp.part(b, pg_temp.q('D Two', 5, 60000)), pg_temp.part(x, pg_temp.q('D Three', 5, 60000))));
  perform public.cancel_quote((select id from public.quotes where renewal_subscription_id = a), 'R2847 test: D own quote cancelled');
  update public.subscriptions set renewal_quote_id = null where id = a;   -- its own quote is dealt with
  v_msg := pg_temp.try('c2847000-0000-0000-0000-0000000000f1',
             jsonb_build_array(pg_temp.part(a, pg_temp.q('D One', 5, 60000)), pg_temp.part(b, pg_temp.q('D Two', 5, 60000))));
  if v_msg not like '22023 Renewal quote ' || (r->>'quote_id') || ' is still open%for D Two%' then raise exception 'FAIL D2 linked: %', v_msg; end if;
  -- b's link lost: the link row still holds its term
  update public.subscriptions set renewal_quote_id = null where id = b;
  v_msg := pg_temp.try('c2847000-0000-0000-0000-0000000000f1',
             jsonb_build_array(pg_temp.part(a, pg_temp.q('D One', 5, 60000)), pg_temp.part(b, pg_temp.q('D Two', 5, 60000))));
  if v_msg not like '22023 D Two is already on renewal quote ' || (r->>'quote_id') || '%' then raise exception 'FAIL D2 link row: %', v_msg; end if;
  raise notice 'PASS D2: a sub on another together quote → refused (linked, and by its link row when the link is lost)';
end $$;

-- ── E / F / F2 / G / H — refusals ────────────────────────────────────────────────────────────────────────────
do $$
declare c1 uuid; c2 uuid; a uuid; b uuid; s uuid; m uuid; w uuid; p uuid; v_msg text;
        t uuid := 'c2847000-0000-0000-0000-0000000000f1';
begin
  c1 := pg_temp.cust(3); c2 := pg_temp.cust(4);
  a := pg_temp.sub(6, c1, 'E One', 5, '2026-12-01');
  b := pg_temp.sub(7, c2, 'E Two', 5, '2026-12-01');
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(b, pg_temp.q('E Two', 5, 60000))));
  if v_msg not like '22023 Subscriptions of different customers%' then raise exception 'FAIL E: %', v_msg; end if;
  update public.subscriptions set customer_id = null where id = b;
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(b, pg_temp.q('E Two', 5, 60000))));
  if v_msg not like '22023 E Two is not linked to a customer%' then raise exception 'FAIL E no customer: %', v_msg; end if;
  raise notice 'PASS E: two customers / no customer refused';

  s := pg_temp.sub(8, c1, 'F Quarterly', 5, '2026-12-01', 'quarterly', 12);
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(s, pg_temp.q('F Quarterly', 5, 60000))));
  if v_msg not like '22023 F Quarterly is not a yearly subscription%' then raise exception 'FAIL F: %', v_msg; end if;
  m := pg_temp.sub(9, c1, 'F Monthly term', 5, '2026-12-01', 'yearly', 1);
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(m, pg_temp.q('F Monthly term', 5, 5000))));
  if v_msg not like '22023 F Monthly term is not a yearly subscription%' then raise exception 'FAIL F 1-month: %', v_msg; end if;
  raise notice 'PASS F: split-billed / 1-month term refused';

  w := pg_temp.sub(10, c1, 'F2 Wont', 5, '2026-12-01');
  update public.subscriptions set auto_renew = false where id = w;
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(w, pg_temp.q('F2 Wont', 5, 60000))));
  if v_msg not like '22023 F2 Wont is marked Won''t renew%' then raise exception 'FAIL F2 wont: %', v_msg; end if;
  p := pg_temp.sub(11, c1, 'F2 Paused', 5, '2026-12-01');
  update public.subscriptions set status = 'cancelled' where id = p;
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(p, pg_temp.q('F2 Paused', 5, 60000))));
  if v_msg not like '22023 F2 Paused is cancelled%' then raise exception 'FAIL F2 status: %', v_msg; end if;
  raise notice 'PASS F2: Won''t renew / not active refused';

  b := pg_temp.sub(12, c1, 'G Export', 5, '2026-12-01');
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(b, pg_temp.q('G Export', 5, 60000, 0))));
  if v_msg not like '22023 Subscriptions with different GST rates%' then raise exception 'FAIL G: %', v_msg; end if;
  raise notice 'PASS G: mixed GST refused';

  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(b, pg_temp.q('G Export', 5, 60000) || '{"subtotal":0}')));
  if v_msg not like '22023 The renewal of G Export has no price%' then raise exception 'FAIL H price: %', v_msg; end if;
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(b, pg_temp.q('G Export', 5, 60000) || '{"line_items":[]}')));
  if v_msg not like '22023 The renewal of G Export has no line%' then raise exception 'FAIL H line: %', v_msg; end if;
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000))));
  if v_msg not like '22023 Pick at least two%' then raise exception 'FAIL H one: %', v_msg; end if;
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(a, pg_temp.q('E One', 5, 60000))));
  if v_msg not like '22023 Pick at least two%' then raise exception 'FAIL H twice: %', v_msg; end if;
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)), pg_temp.part(b, pg_temp.q('G Export', 5, 120000) || '{"extension_months":24}')));
  if v_msg not like '22023 The renewal of G Export is for 24 months%' then raise exception 'FAIL H 24: %', v_msg; end if;
  -- lines that do not add up to the part's subtotal / amount (client-priced input)
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)),
             pg_temp.part(b, pg_temp.q('G Export', 5, 60000) || '{"line_items":[{"name":"x","qty":5,"rate":10}]}')));
  if v_msg not like '22023 The renewal of G Export does not add up%' then raise exception 'FAIL H lines: %', v_msg; end if;
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)),
             pg_temp.part(b, pg_temp.q('G Export', 5, 60000) || '{"amount":1}')));
  if v_msg not like '22023 The renewal of G Export does not add up%' then raise exception 'FAIL H amount: %', v_msg; end if;
  -- seats the subscription does not have (no seat cut) → refused, never trusted
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('E One', 5, 60000)),
             pg_temp.part(b, pg_temp.q('G Export', 3, 36000))));
  if v_msg not like '22023 The renewal of G Export was priced for 3 seats, but the subscription has 5%' then raise exception 'FAIL H seats: %', v_msg; end if;
  v_msg := pg_temp.try(t, '{"x":1}'::jsonb);
  if v_msg not like '22023 Pick at least two%' then raise exception 'FAIL H not array: %', v_msg; end if;
  if exists (select 1 from public.quotes where customer_id in (c1, c2)) then raise exception 'FAIL E-H: a refused call left a quote'; end if;
  raise notice 'PASS H: no price / no line / one / twice / 24 months / bad input refused, nothing left behind';
end $$;

-- ── I — seat cut per subscription ────────────────────────────────────────────────────────────────────────────
do $$
declare c uuid; a uuid; b uuid; r jsonb; v_msg text; t uuid := 'c2847000-0000-0000-0000-0000000000f1';
begin
  c := pg_temp.cust(5);
  a := pg_temp.sub(13, c, 'I Big', 20, current_date + 5);
  b := pg_temp.sub(14, c, 'I Small', 10, current_date + 9);
  insert into public.subscription_seat_reductions
    (tenant_id, subscription_id, idempotency_key, timing, status, seats_before, seats_removed, seats_after, effective_date, mrr_before)
  values (t, b, 'r2847-cut-i', 'end_of_term', 'scheduled', 10, 3, 7, current_date + 9, 1000);
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('I Big', 20, 240000)), pg_temp.part(b, pg_temp.q('I Small', 10, 120000))));
  if v_msg not like 'check_violation%' and v_msg not like '23514 A seat cut to 7 seats%' then raise exception 'FAIL I old seats: %', v_msg; end if;
  /* priced at the cut: the quote total is 27 seats, the link guard must compare THIS sub's 7 */
  r := public.create_renewal_quote_together(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('I Big', 20, 240000)),
                                                                 pg_temp.part(b, pg_temp.q('I Small', 7, 84000))));
  if (select seats from public.quotes where id = r->>'quote_id') <> 27 then raise exception 'FAIL I: quote seats'; end if;
  if (select renewal_quote_id from public.subscriptions where id = b) is distinct from r->>'quote_id' then raise exception 'FAIL I: b not linked'; end if;
  raise notice 'PASS I: part at old seats refused (%); at the cut''s seats linked (guard reads the sub''s own 7 seats)', v_msg;
end $$;

-- ── L — lost link comes back ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  a uuid := 'c2847000-0000-0000-0000-000000000201'; b uuid := 'c2847000-0000-0000-0000-000000000202';
  r jsonb; v_n int;
begin
  update public.subscriptions set renewal_quote_id = null where id = a;
  r := public.create_renewal_quote(a, 'c2847000-0000-0000-0000-0000000000f1', pg_temp.q('Business Standard', 20, 264000));
  if r->>'quote_id' <> current_setting('r2847.a') or (r->>'created')::boolean or not (r->>'relinked')::boolean then
    raise exception 'FAIL L single: %', r; end if;
  update public.subscriptions set renewal_quote_id = null where id = b;
  r := public.create_renewal_quote_together('c2847000-0000-0000-0000-0000000000f1',
         jsonb_build_array(pg_temp.part(a, pg_temp.q('Business Standard', 20, 264000)),
                           pg_temp.part(b, pg_temp.q('Business Starter', 10, 84000))));
  if r->>'quote_id' <> current_setting('r2847.a') or not (r->>'relinked')::boolean then raise exception 'FAIL L together: %', r; end if;
  select count(*) into v_n from public.subscriptions where id in (a, b) and renewal_quote_id = current_setting('r2847.a');
  if v_n <> 2 then raise exception 'FAIL L: % linked', v_n; end if;
  select count(*) into v_n from public.quotes where customer_id = 'c2847000-0000-0000-0000-000000000101';
  if v_n <> 1 then raise exception 'FAIL L: % quotes', v_n; end if;
  raise notice 'PASS L: a lost link is put back (single and together calls), no 2nd quote';
end $$;
-- L2: a member moved to another term (or Won't renew) → the old quote is never relinked to it
do $$
declare c uuid; a uuid; b uuid; r jsonb; v_msg text; t uuid := 'c2847000-0000-0000-0000-0000000000f1';
begin
  c := pg_temp.cust(8);
  a := pg_temp.sub(19, c, 'L2 One', 5, '2026-12-01');
  b := pg_temp.sub(20, c, 'L2 Two', 5, '2026-12-03');
  r := public.create_renewal_quote_together(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('L2 One', 5, 60000)),
                                                                 pg_temp.part(b, pg_temp.q('L2 Two', 5, 60000))));
  update public.subscriptions set renewal_quote_id = null, renewal_date = '2027-12-03' where id = b;
  v_msg := pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('L2 One', 5, 60000)), pg_temp.part(b, pg_temp.q('L2 Two', 5, 60000))));
  if v_msg like 'OK ' || (r->>'quote_id') then raise exception 'FAIL L2: relinked b to its old term'; end if;
  if (select renewal_quote_id from public.subscriptions where id = b) is not null then raise exception 'FAIL L2: b linked'; end if;
  raise notice 'PASS L2: member moved → not relinked (%)', v_msg;
end $$;

-- ── M — a cancelled together quote frees the terms ───────────────────────────────────────────────────────────
do $$
declare c uuid; a uuid; b uuid; r1 jsonb; r2 jsonb; v_n int; t uuid := 'c2847000-0000-0000-0000-0000000000f1';
begin
  c := pg_temp.cust(6);
  a := pg_temp.sub(15, c, 'M One', 5, '2026-12-01');
  b := pg_temp.sub(16, c, 'M Two', 5, '2026-12-03');
  r1 := public.create_renewal_quote_together(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('M One', 5, 60000)),
                                                                  pg_temp.part(b, pg_temp.q('M Two', 5, 60000))));
  perform public.cancel_quote(r1->>'quote_id', 'R2847 test: M cancelled');
  r2 := public.create_renewal_quote_together(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('M One', 5, 60000)),
                                                                  pg_temp.part(b, jsonb_set(pg_temp.q('M Two', 5, 66000), '{line_items,0}',
                                                                    pg_temp.q('M Two', 5, 66000)->'line_items'->0
                                                                    || '{"billing_id":"c2847000-0000-0000-0000-00000000ffff","plan_change":{"seats":1},"bulk":true,"one_time":true,"years":3}'))));
  if r2->>'quote_id' = r1->>'quote_id' or not (r2->>'created')::boolean then raise exception 'FAIL M: %', r2; end if;
  if exists (select 1 from public.quotes q, jsonb_array_elements(q.line_items) l
              where q.id = r2->>'quote_id' and (l ? 'billing_id' or l ? 'plan_change' or l ? 'bulk' or l ? 'one_time' or l ? 'years')) then
    raise exception 'FAIL M: caller-sent billing_id / plan_change / bulk / one_time / years kept on a line'; end if;
  select count(*) into v_n from public.renewal_quote_subscriptions where subscription_id in (a, b) and released_at is null;
  if v_n <> 2 or (select count(*) from public.renewal_quote_subscriptions where quote_id = r1->>'quote_id' and released_at is not null) <> 2 then
    raise exception 'FAIL M: live link rows % / old rows not kept as released', v_n; end if;
  if (select count(*) from public.subscriptions where id in (a, b) and renewal_quote_id = r2->>'quote_id') <> 2 then
    raise exception 'FAIL M: not linked to the new quote'; end if;
  /* the closed quote with money on it still holds the terms */
  /* a part payment (renews nothing), then the quote expires: money on it → it still holds the terms */
  perform public.record_payment(r2->>'quote_id', 1000, 'other', 'r2847-m');
  if exists (select 1 from public.subscriptions where id in (a, b) and renewal_date <> date '2026-12-01' and renewal_date <> date '2026-12-03') then
    raise exception 'FAIL M: a part payment moved a renewal date'; end if;
  update public.quotes set status = 'expired' where id = r2->>'quote_id';
  if pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('M One', 5, 60000)), pg_temp.part(b, pg_temp.q('M Two', 5, 60000))))
     not like '22023 %' || (r2->>'quote_id') || '%' then
    raise exception 'FAIL M: a closed quote with money released its terms: %', pg_temp.try(t, jsonb_build_array(pg_temp.part(a, pg_temp.q('M One', 5, 60000)), pg_temp.part(b, pg_temp.q('M Two', 5, 60000)))); end if;
  raise notice 'PASS M: cancelled (no money) → new together quote; closed with money → still held';
end $$;

-- ── J / N — logins ───────────────────────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2847000-0000-0000-0000-0000000000a1', 'owner2847@example.test'),
  ('c2847000-0000-0000-0000-0000000000a2', 'sales2847@example.test'),
  ('c2847000-0000-0000-0000-0000000000a3', 'other2847@example.test');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('c2847000-0000-0000-0000-0000000000a1', 'c2847000-0000-0000-0000-0000000000f1', 'owner2847@example.test', 'Owner 2847', 'owner', now() - interval '1 day'),
  ('c2847000-0000-0000-0000-0000000000a2', 'c2847000-0000-0000-0000-0000000000f1', 'sales2847@example.test', 'Sales 2847', 'sales', now() - interval '1 day'),
  ('c2847000-0000-0000-0000-0000000000a3', 'c2847000-0000-0000-0000-0000000000f2', 'other2847@example.test', 'Other 2847', 'owner', now() - interval '1 day');
do $$ declare c uuid; begin
  c := pg_temp.cust(7);
  perform pg_temp.sub(17, c, 'J One', 5, '2026-12-01');
  perform pg_temp.sub(18, c, 'J Two', 5, '2026-12-02');
end $$;
grant execute on function pg_temp.try(uuid, jsonb) to authenticated;
grant execute on function pg_temp.q(text, int, int, int) to authenticated;
grant execute on function pg_temp.part(uuid, jsonb) to authenticated;

select set_config('request.jwt.claims', '{"sub":"c2847000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$ declare v_msg text; v_rand text; begin
  v_msg := pg_temp.try('c2847000-0000-0000-0000-0000000000f2',
             jsonb_build_array(pg_temp.part('c2847000-0000-0000-0000-000000000217', pg_temp.q('J One', 5, 60000)),
                               pg_temp.part('c2847000-0000-0000-0000-000000000218', pg_temp.q('J Two', 5, 60000))));
  v_rand := pg_temp.try('c2847000-0000-0000-0000-0000000000f2',
             jsonb_build_array(pg_temp.part('c2847000-0000-0000-0000-0000000002aa', pg_temp.q('J One', 5, 60000)),
                               pg_temp.part('c2847000-0000-0000-0000-0000000002ab', pg_temp.q('J Two', 5, 60000))));
  if v_msg not like 'P0002 A subscription to renew was not found%' or v_msg <> v_rand then
    raise exception 'FAIL J other company: % / random: %', v_msg, v_rand; end if;
  -- naming the other company's tenant id itself reads the same
  if pg_temp.try('c2847000-0000-0000-0000-0000000000f1',
       jsonb_build_array(pg_temp.part('c2847000-0000-0000-0000-000000000217', pg_temp.q('J One', 5, 60000)),
                         pg_temp.part('c2847000-0000-0000-0000-000000000218', pg_temp.q('J Two', 5, 60000)))) <> v_msg then
    raise exception 'FAIL J: other tenant id answered differently'; end if;
  raise notice 'PASS J: another company''s subscriptions read like unknown ids: %', v_msg;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"c2847000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$ declare v_msg text; begin
  v_msg := pg_temp.try('c2847000-0000-0000-0000-0000000000f1',
             jsonb_build_array(pg_temp.part('c2847000-0000-0000-0000-000000000217', pg_temp.q('J One', 5, 60000)),
                               pg_temp.part('c2847000-0000-0000-0000-000000000218', pg_temp.q('J Two', 5, 60000))));
  if v_msg not like '42501 Only an owner, manager, accountant or billing user%' then raise exception 'FAIL J sales: %', v_msg; end if;
  raise notice 'PASS J: sales role refused';
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"c2847000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$ declare r jsonb; v_q text; begin
  r := public.create_renewal_quote_together('c2847000-0000-0000-0000-0000000000f1',
         jsonb_build_array(pg_temp.part('c2847000-0000-0000-0000-000000000217', pg_temp.q('J One', 5, 60000)),
                           pg_temp.part('c2847000-0000-0000-0000-000000000218', pg_temp.q('J Two', 5, 60000))));
  v_q := r->>'quote_id';
  if not (r->>'created')::boolean then raise exception 'FAIL J owner: %', r; end if;
  raise notice 'PASS J: owner login makes the together quote %', v_q;
  -- N: the owner's browser login cannot edit / revise it
  begin
    update public.quotes set amount = amount - 1000 where id = v_q;
    raise exception 'FAIL N: amount edited by hand';
  exception when insufficient_privilege then
    if sqlerrm not like '%renews several subscriptions together%' then raise exception 'FAIL N amount: %', sqlerrm; end if;
  end;
  begin
    update public.quotes set line_items = line_items - 1 where id = v_q;
    raise exception 'FAIL N: line removed by hand';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.quotes set superseded_by = 'Q-R2847-REV' where id = v_q;
    raise exception 'FAIL N: revised by hand';
  exception when insufficient_privilege then null;
           when foreign_key_violation then raise exception 'FAIL N: revise reached the FK check (guard did not fire)';
  end;
  -- the link table is read-only to a browser login
  begin
    delete from public.renewal_quote_subscriptions where quote_id = v_q;
    if found then raise exception 'FAIL Z: browser deleted link rows'; end if;
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.renewal_quote_subscriptions where quote_id = v_q) <> 2 then
    raise exception 'FAIL Z: browser cannot read its own company''s link rows'; end if;
  raise notice 'PASS N: lines / amount / Revise refused for a browser login; link table read-only';
  perform set_config('r2847.j', v_q, false);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
do $$ begin
  -- server code (not a browser login) is not stopped by the edit guard
  update public.quotes set notes = 'server note', amount = amount + 0 where id = current_setting('r2847.j');
  -- …but nobody revises a together quote: a revision row naming it, or superseded_by set (tg_quote_revision_sent path)
  begin
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, revision_of)
    values ('Q-R2847-REV', 'c2847000-0000-0000-0000-0000000000f1', 'c2847000-0000-0000-0000-000000000107', 'R2847 C7',
            1000, 'draft', 'none', '[{"name":"x","qty":1,"rate":1000,"commitment":"annual_yearly"}]'::jsonb, current_setting('r2847.j'));
    raise exception 'FAIL N: a revision of a together quote was inserted';
  exception when insufficient_privilege then
    if sqlerrm not like '%cannot be revised%' then raise exception 'FAIL N revise insert: %', sqlerrm; end if;
  end;
  begin
    update public.quotes set superseded_by = (select id from public.quotes where id <> current_setting('r2847.j')
                                                 and tenant_id = 'c2847000-0000-0000-0000-0000000000f1' limit 1)
     where id = current_setting('r2847.j');
    raise exception 'FAIL N: superseded_by set on a together quote by server code';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS N: server code still updates the quote; nobody can revise it';
end $$;

-- ── Z — grants ───────────────────────────────────────────────────────────────────────────────────────────────
do $$ begin
  if has_function_privilege('anon', 'public.create_renewal_quote_together(uuid, jsonb)', 'execute') then raise exception 'FAIL Z: anon can call the RPC'; end if;
  if not has_function_privilege('authenticated', 'public.create_renewal_quote_together(uuid, jsonb)', 'execute') then raise exception 'FAIL Z: authenticated cannot call the RPC'; end if;
  if has_function_privilege('authenticated', 'public.r2847_quote_live(text)', 'execute') then raise exception 'FAIL Z: r2847_quote_live open to browsers'; end if;
  if has_function_privilege('authenticated', 'public.tg_quotes_renewal_together_guarded()', 'execute') then raise exception 'FAIL Z: guard fn open'; end if;
  if (select prosecdef from pg_proc where oid = 'public.tg_quotes_renewal_together_guarded()'::regprocedure) then
    raise exception 'FAIL Z: edit guard is security definer (is_direct_request_login would always be false)'; end if;
  if has_table_privilege('authenticated', 'public.renewal_quote_subscriptions', 'insert')
     or has_table_privilege('authenticated', 'public.renewal_quote_subscriptions', 'update')
     or has_table_privilege('anon', 'public.renewal_quote_subscriptions', 'select') then raise exception 'FAIL Z: table writable / anon readable'; end if;
  raise notice 'PASS Z: grants';
end $$;

select 'PASS r2847_renewal_quote_together' as result;
rollback;
