-- R-2810 (14 Nov 2026, p1 money) — part 2 of R-2805 "Bill together". Migration 20261114165044_r2810_bill_parts_together
-- (on top of R-2806's 20261114161903_r2806_bill_group_pool). Self-asserting, ONE transaction, rolled back. Local DB only.
-- RED without the migration (no bill_parts_together; F4 / F6 repros pass through).
--
--   A. 2 subs of one customer (no common sale quote) → ONE proforma, 2 lines (billing_id, seats × rate, own period,
--      R-2423 name), one bill_group_id; paid → ONE invoice 2 lines each its own period, both renew once, pools 0
--   B. Same parts again → the same proforma (alreadyExisted), before and after paying
--   C. rev-r2806 F4: a part with its own live proforma → refused "cancel PI-x first"; a second live request naming a
--      part (hand insert by server code) → refused by the DB guard; cancel the own one → bill together works
--   D. Parts of two customers → refused       E. Different GST rates → refused
--   F. Not begun mixed with begun → refused; all not begun → proforma (no tax invoice ahead)
--   G. First part of a sale → refused        H. Invoiced part / same sub twice / one part / unknown id → refused
--   I. R-2092 sibling of the same sale quote + period left out → refused; ticked → OK, group covers both
--   J. Cancel the together proforma → both parts free, billable together again; F6: cancel refused when a NON-lead
--      member's later period is billed (names it)
--   K. Other company's login → refused; sales role → refused; owner login → works (sets bill_group_id)
--   L. Already-grouped subs merge into one group     M. Export customer → 0% GST, INR
--   N. Money already in the merged pool covers a started group → its tax invoice at once, proforma closed
--   Z. Grants: RPC not for anon; the guard function not callable by a browser role

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
  ('b2810000-0000-0000-0000-0000000000f1', 'R2810 Together Co', 'r2810@example.test', '07', 'R810'),
  ('b2810000-0000-0000-0000-0000000000f2', 'R2810 Other Co', 'r2810o@example.test', '07', 'R81O');
update public.tenants set books_start_date = '2025-04-01' where id in ('b2810000-0000-0000-0000-0000000000f1', 'b2810000-0000-0000-0000-0000000000f2');

create function pg_temp.cust(p_n int, p_country text default 'India') returns uuid language plpgsql as $f$
declare v_c uuid := ('b2810000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'b2810000-0000-0000-0000-0000000000f1', 'R2810 C' || p_n, '07', p_country);
  return v_c;
end $f$;

create function pg_temp.sub(p_n int, p_c uuid, p_plan text, p_seats int, p_start date, p_renewal date)
returns uuid language plpgsql as $f$
declare v_s uuid := ('b2810000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status, domain)
  values (v_s, 'b2810000-0000-0000-0000-0000000000f1', p_c, (select name from public.customers where id = p_c), p_plan,
          'google'::vendor, p_seats, 1000, 'monthly'::billing_cycle, 12, p_start, p_renewal, 'grace_period', 2, 'active',
          'r2810-' || p_n || '.example.test');
  return v_s;
end $f$;

create function pg_temp.part(p_s uuid, p_k int, p_start date, p_taxable int, p_from date default null, p_to date default null,
                             p_index int default 2, p_rate int default 18)
returns uuid language plpgsql as $f$
declare v_b uuid := ('b2810000-0000-0000-0000-0000000003' || lpad(p_k::text, 2, '0'))::uuid;
begin
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                            period_end, taxable_amount, tax_rate, renews_from, renews_to)
  values (v_b, 'b2810000-0000-0000-0000-0000000000f1', p_s, (p_start - interval '1 month')::date, p_index, p_start, p_start,
          (p_start + interval '1 month')::date, p_taxable, p_rate, p_from, p_to);
  return v_b;
end $f$;

create function pg_temp.pay(p_q text, p_amt int, p_ref text) returns void language sql as $f$
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2810000-0000-0000-0000-0000000000f1', p_q, p_amt, 'bank_transfer', p_ref, 'received', now());
$f$;

create function pg_temp.st(p_s uuid) returns text language sql as $f$
  select s.renewal_date::text || ' ' || s.renewal_state::text from public.subscriptions s where s.id = p_s;
$f$;

/* The refusal text of a call, or 'OK'. */
create function pg_temp.try(p_ids uuid[]) returns text language plpgsql as $f$
begin
  perform public.bill_parts_together(p_ids);
  return 'OK';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $f$;

-- ── A B — the happy path ──────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_c uuid; v_a uuid; v_b uuid; pa uuid; pb uuid; r jsonb; r2 jsonb; v_q record; v_inv record; la jsonb; lb jsonb;
begin
  v_c := pg_temp.cust(1);
  v_a := pg_temp.sub(1, v_c, 'Google Workspace Business Standard', 161, '2025-10-01', '2026-10-01');
  v_b := pg_temp.sub(2, v_c, 'Google Workspace Business Starter', 49, '2025-10-15', '2026-10-15');
  pa := pg_temp.part(v_a, 1, '2026-10-01', 161 * 1585, '2026-10-01', '2027-10-01');
  pb := pg_temp.part(v_b, 2, '2026-10-15', 49 * 450, '2026-10-15', '2027-10-15');

  r := public.bill_parts_together(array[pa, pb]);
  if r->>'action' <> 'request' or (r->>'already_existed')::boolean or r->>'currency' <> 'INR' then
    raise exception 'FAIL A: first call → %', r; end if;
  select * into v_q from public.quotes where id = r->>'quote_id';
  if v_q.id not like 'PI-%' or v_q.subscription_billing_id <> pa or v_q.customer_id <> v_c or jsonb_array_length(v_q.line_items) <> 2
     or v_q.subtotal <> 161 * 1585 + 49 * 450 or v_q.amount <> v_q.subtotal + round(v_q.subtotal * 18 / 100.0)::int
     or v_q.status::text <> 'sent' or v_q.tax_rate <> 18 then
    raise exception 'FAIL A: proforma % sbid % lines % subtotal % amount % status %', v_q.id, v_q.subscription_billing_id,
      jsonb_array_length(v_q.line_items), v_q.subtotal, v_q.amount, v_q.status; end if;
  la := v_q.line_items->0; lb := v_q.line_items->1;
  if la->>'billing_id' <> pa::text or lb->>'billing_id' <> pb::text
     or (la->>'qty')::int <> 161 or (la->>'rate')::int <> 1585 or (lb->>'qty')::int <> 49 or (lb->>'rate')::int <> 450
     or la->>'period_start' <> '2026-10-01' or lb->>'period_start' <> '2026-10-15'
     or la->>'name' not like 'Google Workspace Business Standard · r2810-1.example.test · 161 seats · 1 Oct–31 Oct 2026%'
     or lb->>'name' not like 'Google Workspace Business Starter · r2810-2.example.test · 49 seats · 15 Oct–14 Nov 2026%' then
    raise exception 'FAIL A: lines % / %', la, lb; end if;
  if (select count(distinct bill_group_id) from public.subscriptions where id in (v_a, v_b) and bill_group_id is not null) <> 1
     or (select bill_group_id from public.subscriptions where id = v_a) is distinct from (r->>'bill_group_id')::uuid then
    raise exception 'FAIL A: bill_group_id not one id on both: %', (select array_agg(bill_group_id) from public.subscriptions where id in (v_a, v_b)); end if;
  if (select count(*) from public.subscription_billings where id in (pa, pb) and due_on is not null) <> 2 then
    raise exception 'FAIL A: due_on not set on both parts'; end if;
  raise notice 'PASS A: one proforma % with two lines, one bill group', v_q.id;

  -- B. same parts again (also in the other order) → the same proforma
  r2 := public.bill_parts_together(array[pb, pa]);
  if r2->>'quote_id' <> v_q.id or not (r2->>'already_existed')::boolean then raise exception 'FAIL B: second call → %', r2; end if;
  if (select count(*) from public.quotes where customer_id = v_c) <> 1 then raise exception 'FAIL B: a second proforma was made'; end if;
  raise notice 'PASS B: same parts again → the same proforma, alreadyExisted';

  -- Bill next part on either sub → the together proforma (R-2806 H)
  if public.bill_subscription_instalment(pb, false)->>'quote_id' <> v_q.id then raise exception 'FAIL A: Bill next part on B does not find the together proforma'; end if;

  -- paid → ONE invoice, two lines, each its own period; both renew once; pools 0
  perform pg_temp.pay(v_q.id, v_q.amount, 'R2810-A');
  if (select count(*) from public.invoices where customer_id = v_c) <> 1
     or (select count(distinct invoice_id) from public.subscription_billings where id in (pa, pb) and invoice_id is not null) <> 1
     or exists (select 1 from public.subscription_billings where id in (pa, pb) and invoice_id is null) then
    raise exception 'FAIL A: paid → % invoices', (select count(*) from public.invoices where customer_id = v_c); end if;
  select * into v_inv from public.invoices where customer_id = v_c;
  if v_inv.amount <> v_q.amount or v_inv.status::text <> 'paid' or jsonb_array_length(v_inv.line_items) <> 2
     or v_inv.line_items->1->>'description' not like '%15 Oct 2026 to 15 Nov 2026%' then
    raise exception 'FAIL A: invoice % amount % status % lines %', v_inv.id, v_inv.amount, v_inv.status, v_inv.line_items; end if;
  if pg_temp.st(v_a) <> '2027-10-01 renewed' or pg_temp.st(v_b) <> '2027-10-15 renewed'
     or (select count(*) from public.subscription_renewal_moves where subscription_id in (v_a, v_b) and direction = 'forward') <> 2 then
    raise exception 'FAIL A: renew A % / B %', pg_temp.st(v_a), pg_temp.st(v_b); end if;
  if public.instalment_credit(v_a) <> 0 or public.instalment_credit(v_b) <> 0 then
    raise exception 'FAIL A: pools % / %', public.instalment_credit(v_a), public.instalment_credit(v_b); end if;
  raise notice 'PASS A: paid → one tax invoice % (2 lines, own periods), both renewed once, pools 0', v_inv.id;

  r2 := public.bill_parts_together(array[pa, pb]);
  if r2->>'quote_id' <> v_q.id or not (r2->>'already_existed')::boolean then raise exception 'FAIL B: after paying → %', r2; end if;
  raise notice 'PASS B: after paying, same parts → the same (paid) proforma';
end $$;

-- ── C — rev-r2806 F4: one live request per part ───────────────────────────────────────────────────────────────
do $$
declare v_c uuid; v_a uuid; v_b uuid; pa uuid; pb uuid; r jsonb; v_own text; v_msg text; v_t jsonb; v_inv text;
begin
  v_c := pg_temp.cust(2);
  v_a := pg_temp.sub(3, v_c, 'Google Workspace Business Standard', 10, '2025-10-01', '2026-10-01');
  v_b := pg_temp.sub(4, v_c, 'Google Workspace Business Starter', 5, '2025-10-01', '2026-10-01');
  pa := pg_temp.part(v_a, 11, '2026-10-01', 10 * 2000, '2026-10-01', '2027-10-01');
  pb := pg_temp.part(v_b, 12, '2026-10-01', 5 * 450, '2026-10-01', '2027-10-01');
  r := public.bill_subscription_instalment(pb, false);           -- B's own proforma (₹2,655)
  v_own := r->>'quote_id';
  if r->>'action' <> 'request' or (select amount from public.quotes where id = v_own) <> 2655 then raise exception 'FAIL C setup: %', r; end if;

  v_msg := pg_temp.try(array[pa, pb]);
  if v_msg not like '22023 %already on proforma ' || v_own || ' — cancel ' || v_own || ' first%' then
    raise exception 'FAIL C: together with B on its own proforma → %', v_msg; end if;
  raise notice 'PASS C: refused — %', v_msg;

  -- the DB guard: server code naming B on a second live request is refused too (F4 repro can never be built)
  begin
    perform set_config('app.r2519_write', 'on', true);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, subtotal, tax_rate,
                               line_items, subscription_billing_id, created_date)
    values ('TESTQ-R2810-F4', 'b2810000-0000-0000-0000-0000000000f1', v_c, 'R2810 C2', 'sent', 'none', 26254, 22250, 18,
            jsonb_build_array(jsonb_build_object('billing_id', pa::text, 'qty', 10, 'rate', 2000),
                              jsonb_build_object('billing_id', pb::text, 'qty', 5, 'rate', 450)), pa, public.ist_today());
    raise exception 'FAIL C: a together request naming B (already on %) was inserted', v_own;
  exception when unique_violation then
    if sqlerrm not like '%already on proforma ' || v_own || '%' then raise exception 'FAIL C: guard said %', sqlerrm; end if;
    raise notice 'PASS C: DB guard refused a second live request naming B: %', sqlerrm;
  end;
  begin
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, subtotal, tax_rate,
                               line_items, subscription_billing_id, created_date)
    values ('TESTQ-R2810-F4b', 'b2810000-0000-0000-0000-0000000000f1', v_c, 'R2810 C2', 'sent', 'none', 2655, 2250, 18,
            '[]'::jsonb, pb, public.ist_today());
    raise exception 'FAIL C: a second own request for B was inserted';
  exception when unique_violation then
    raise notice 'PASS C: DB guard refused a second own request for B';
  end;
  perform set_config('app.r2519_write', '', true);
  if (select count(*) from public.quotes where subscription_billing_id = pb or line_items @> jsonb_build_array(jsonb_build_object('billing_id', pb::text))) <> 1 then
    raise exception 'FAIL C: B is named by % requests', (select count(*) from public.quotes where subscription_billing_id = pb); end if;

  -- cancel B's own → together works; paid → one invoice for both, both renew
  perform public.cancel_quote(v_own, 'R2810 test: bill together instead');
  v_t := public.bill_parts_together(array[pa, pb]);
  if v_t->>'action' <> 'request' then raise exception 'FAIL C: after cancel → %', v_t; end if;
  perform pg_temp.pay(v_t->>'quote_id', (v_t->>'gross')::int, 'R2810-C');
  select invoice_id into v_inv from public.subscription_billings where id = pa;
  if v_inv is null or (select invoice_id from public.subscription_billings where id = pb) is distinct from v_inv
     or (select status::text from public.invoices where id = v_inv) <> 'paid'
     or pg_temp.st(v_a) <> '2027-10-01 renewed' or pg_temp.st(v_b) <> '2027-10-01 renewed' then
    raise exception 'FAIL C: after cancel + together + pay: inv % status % A % B %', v_inv,
      (select status from public.invoices where id = v_inv), pg_temp.st(v_a), pg_temp.st(v_b); end if;
  raise notice 'PASS C: own proforma cancelled → together proforma → one paid invoice, both renewed';
end $$;

-- ── C2 — rows written before the guard never stop an ordinary update; a part named anew is still refused ──────
alter table public.quotes disable trigger trg_quotes_one_live_request_per_part;
do $$
declare v_c uuid; v_s uuid; p uuid;
begin
  v_c := pg_temp.cust(11);
  v_s := pg_temp.sub(26, v_c, 'C2 Old Double', 2, '2025-10-01', '2026-10-01');
  p := pg_temp.part(v_s, 71, '2026-10-01', 2000);
  perform set_config('app.r2519_write', 'on', true);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, subtotal, tax_rate, line_items, subscription_billing_id, created_date)
  values ('TESTQ-R2810-OLD1', 'b2810000-0000-0000-0000-0000000000f1', v_c, 'R2810 C11', 'sent', 'none', 2360, 2000, 18, '[]'::jsonb, p, public.ist_today()),
         ('TESTQ-R2810-OLD2', 'b2810000-0000-0000-0000-0000000000f1', v_c, 'R2810 C11', 'sent', 'none', 2360, 2000, 18,
          jsonb_build_array(jsonb_build_object('billing_id', p::text, 'qty', 2, 'rate', 1000)), null, public.ist_today());
  perform set_config('app.r2519_write', '', true);
end $$;
alter table public.quotes enable trigger trg_quotes_one_live_request_per_part;
do $$
begin
  update public.quotes set status = 'viewed' where id = 'TESTQ-R2810-OLD1';
  update public.quotes set payment_status = 'awaiting', notes = 'C2' where id = 'TESTQ-R2810-OLD1';
  raise notice 'PASS C2: an old double (written before the guard) still takes an ordinary status update';
  begin
    perform set_config('app.r2519_write', 'on', true);
    update public.quotes set subscription_billing_id = 'b2810000-0000-0000-0000-000000000371' where id = 'TESTQ-R2810-OLD2';
    raise exception 'FAIL C2: OLD2 became a live request naming a part already on OLD1';
  exception when unique_violation then
    raise notice 'PASS C2: a request that becomes live naming a part already on another is refused';
  end;
  perform set_config('app.r2519_write', '', true);
end $$;

-- ── D E F G H — refusals ──────────────────────────────────────────────────────────────────────────────────────
do $$
declare v_c uuid; v_c2 uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid;
        v_msg text; r jsonb;
begin
  v_c := pg_temp.cust(3); v_c2 := pg_temp.cust(4);
  s1 := pg_temp.sub(5, v_c, 'Plan D1', 2, '2025-10-01', '2026-10-01');
  s2 := pg_temp.sub(6, v_c2, 'Plan D2', 2, '2025-10-01', '2026-10-01');
  p1 := pg_temp.part(s1, 21, '2026-10-01', 2000);
  p2 := pg_temp.part(s2, 22, '2026-10-01', 2000);
  v_msg := pg_temp.try(array[p1, p2]);
  if v_msg not like '22023 Parts of different customers cannot be on one bill%' then raise exception 'FAIL D: %', v_msg; end if;
  raise notice 'PASS D: %', v_msg;

  s3 := pg_temp.sub(7, v_c, 'Plan E 5pct', 2, '2025-10-01', '2026-10-01');
  p3 := pg_temp.part(s3, 23, '2026-10-01', 2000, null, null, 2, 5);
  v_msg := pg_temp.try(array[p1, p3]);
  if v_msg not like '22023 Parts with different GST rates cannot be on one bill (18% and 5%)%'
     and v_msg not like '22023 Parts with different GST rates cannot be on one bill (5% and 18%)%' then raise exception 'FAIL E: %', v_msg; end if;
  raise notice 'PASS E: %', v_msg;

  -- D2 (R-2806 re-review): a subscription with no customer is never grouped
  declare s0 uuid; p0 uuid; begin
    s0 := pg_temp.sub(25, v_c, 'Plan No Customer', 2, '2025-10-01', '2026-10-01');
    update public.subscriptions set customer_id = null where id = s0;
    p0 := pg_temp.part(s0, 27, '2026-10-01', 2000);
    v_msg := pg_temp.try(array[p1, p0]);
    if v_msg not like '22023 Plan No Customer is not linked to a customer — link this subscription to a customer first%' then
      raise exception 'FAIL D2: %', v_msg; end if;
    if (select bill_group_id from public.subscriptions where id = s0) is not null then raise exception 'FAIL D2: grouped'; end if;
    raise notice 'PASS D2: %', v_msg;
  end;

  s4 := pg_temp.sub(8, v_c, 'Plan F ahead', 2, '2025-12-01', '2026-12-01');
  p4 := pg_temp.part(s4, 24, '2026-12-01', 2000);
  v_msg := pg_temp.try(array[p1, p4]);
  if v_msg not like '22023 Plan F ahead (from 1 Dec 2026) has not started yet%' then raise exception 'FAIL F: %', v_msg; end if;
  raise notice 'PASS F: %', v_msg;
  s5 := pg_temp.sub(9, v_c, 'Plan F ahead 2', 2, '2025-12-15', '2026-12-15');
  p5 := pg_temp.part(s5, 25, '2026-12-15', 2000);
  r := public.bill_parts_together(array[p4, p5]);
  if r->>'action' <> 'request' or exists (select 1 from public.invoices where customer_id = v_c) then raise exception 'FAIL F: all ahead → %', r; end if;
  raise notice 'PASS F: parts that have not started → a proforma only (no tax invoice ahead)';

  -- G. first part of a sale
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, amount, subtotal, tax_rate, line_items)
  values ('TESTQ-R2810-GSALE', 'b2810000-0000-0000-0000-0000000000f1', v_c, 'R2810 C3', 'sent', 2360, 2000, 18, '[]'::jsonb);
  update public.subscriptions set quote_id = 'TESTQ-R2810-GSALE' where id = s3;
  update public.subscription_billings set period_index = 1, tax_rate = 18 where id = p3;
  v_msg := pg_temp.try(array[p1, p3]);
  if v_msg not like '22023 The first part of Plan E 5pct is billed by its sale quote TESTQ-R2810-GSALE%' then raise exception 'FAIL G: %', v_msg; end if;
  raise notice 'PASS G: %', v_msg;

  -- H. invoiced part / same sub twice / one part / unknown
  update public.subscription_billings set invoice_id = (select invoice_id from public.subscription_billings where id = 'b2810000-0000-0000-0000-000000000301') where id = p2;
  p6 := pg_temp.part(s1, 26, '2026-11-01', 2000);
  v_msg := pg_temp.try(array[p1, p6]);
  if v_msg not like '22023 Two parts of Plan D1 were picked%' then raise exception 'FAIL H same sub: %', v_msg; end if;
  v_msg := pg_temp.try(array[p1]);
  if v_msg not like '22023 Pick at least two subscriptions%' then raise exception 'FAIL H one: %', v_msg; end if;
  v_msg := pg_temp.try(array[p1, p1]);
  if v_msg not like '22023 Pick at least two subscriptions%' then raise exception 'FAIL H dup: %', v_msg; end if;
  v_msg := pg_temp.try(array[p1, 'b2810000-0000-0000-0000-00000000ffff'::uuid]);
  if v_msg not like 'P0002 A part to bill was not found%' then raise exception 'FAIL H unknown: %', v_msg; end if;
  update public.subscriptions set customer_id = v_c where id = s2;
  v_msg := pg_temp.try(array[p1, p2]);
  if v_msg not like '22023 The Plan D2 part for 1 Oct–31 Oct 2026 already has tax invoice INV-%' then raise exception 'FAIL H invoiced: %', v_msg; end if;
  raise notice 'PASS H: invoiced / same sub twice / one part / unknown id refused';
end $$;

-- ── I — R-2092 sale-quote siblings stay together ──────────────────────────────────────────────────────────────
do $$
declare v_c uuid; q1 uuid; q2 uuid; t uuid; pq1 uuid; pq2 uuid; pt uuid; v_msg text; r jsonb;
begin
  v_c := pg_temp.cust(5);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, amount, subtotal, tax_rate, line_items)
  values ('TESTQ-R2810-ISALE', 'b2810000-0000-0000-0000-0000000000f1', v_c, 'R2810 C5', 'accepted', 0, 0, 18, '[]'::jsonb);
  q1 := pg_temp.sub(10, v_c, 'Sale Plan One', 3, '2025-10-01', '2026-10-01');
  q2 := pg_temp.sub(11, v_c, 'Sale Plan Two', 4, '2025-10-01', '2026-10-01');
  t  := pg_temp.sub(12, v_c, 'Other Plan', 5, '2025-10-01', '2026-10-01');
  update public.subscriptions set quote_id = 'TESTQ-R2810-ISALE' where id in (q1, q2);
  pq1 := pg_temp.part(q1, 31, '2026-10-01', 3000);
  pq2 := pg_temp.part(q2, 32, '2026-10-01', 4000);
  pt  := pg_temp.part(t, 33, '2026-10-01', 5000);
  v_msg := pg_temp.try(array[pq1, pt]);
  if v_msg not like '22023 Sale Plan One is billed with Sale Plan Two (same sale quote, same period) — tick Sale Plan Two too.%' then
    raise exception 'FAIL I: %', v_msg; end if;
  r := public.bill_parts_together(array[pt, pq1, pq2]);
  if r->>'action' <> 'request' or jsonb_array_length((select line_items from public.quotes where id = r->>'quote_id')) <> 3
     or (select count(distinct bill_group_id) from public.subscriptions where id in (q1, q2, t)) <> 1
     or exists (select 1 from public.subscriptions where id in (q1, q2, t) and bill_group_id is null) then
    raise exception 'FAIL I: all three → %', r; end if;
  raise notice 'PASS I: a sale-quote sibling left out is refused; all ticked → one proforma, one group';
end $$;

-- ── J — cancel frees both; F6 ────────────────────────────────────────────────────────────────────────────────
do $$
declare v_c uuid; v_a uuid; v_b uuid; pa uuid; pb uuid; pb2 uuid; r jsonb; r2 jsonb; v_later text; v_msg text;
begin
  v_c := pg_temp.cust(6);
  v_a := pg_temp.sub(13, v_c, 'J Lead', 2, '2025-10-01', '2026-10-01');
  v_b := pg_temp.sub(14, v_c, 'J Member', 3, '2025-10-01', '2026-10-01');
  pa := pg_temp.part(v_a, 41, '2026-10-01', 2000);
  pb := pg_temp.part(v_b, 42, '2026-10-01', 3000);
  r := public.bill_parts_together(array[pa, pb]);
  perform public.cancel_quote(r->>'quote_id', 'R2810 test: cancel together');
  if (select count(*) from public.subscription_billings where id in (pa, pb) and due_on is null) <> 2
     or (select status::text from public.quotes where id = r->>'quote_id') <> 'rejected' then
    raise exception 'FAIL J: cancel did not free both parts'; end if;
  r2 := public.bill_parts_together(array[pa, pb]);
  if r2->>'action' <> 'request' or r2->>'quote_id' = r->>'quote_id' then raise exception 'FAIL J: after cancel → %', r2; end if;
  raise notice 'PASS J: cancel frees both parts; a new together proforma % can be made', r2->>'quote_id';

  -- F6: the member B (not the lead) has its NEXT period billed on its own proforma → cancel refused, naming it
  pb2 := pg_temp.part(v_b, 43, '2026-11-01', 3000);
  update public.subscription_billings set period_index = 3 where id = pb2;
  v_later := public.bill_subscription_instalment(pb2, false)->>'quote_id';
  if v_later is null then raise exception 'FAIL J setup: B next part has no proforma'; end if;
  begin
    perform public.cancel_quote(r2->>'quote_id', 'R2810 test: F6 cancel');
    raise exception 'FAIL J F6: cancel allowed although member B''s later period is on %', v_later;
  exception when sqlstate '22023' then
    if sqlerrm not like 'A later period of this subscription is already billed (%' || v_later || '%' then raise exception 'FAIL J F6: %', sqlerrm; end if;
    raise notice 'PASS J F6: %', sqlerrm;
  end;
end $$;

-- ── L M N — merge, export, paid from the pool ─────────────────────────────────────────────────────────────────
do $$
declare v_c uuid; x uuid; y uuid; z uuid; w uuid; px uuid; pz uuid; pw uuid; r jsonb; v_e uuid; e1 uuid; e2 uuid;
        pe1 uuid; pe2 uuid; v_n uuid; n1 uuid; n2 uuid; pn1 uuid; pn2 uuid; v_q record;
begin
  -- L. x+y already in group g1, w in g2, z none → bill x, z, w together → all four one id
  v_c := pg_temp.cust(7);
  x := pg_temp.sub(15, v_c, 'L X', 1, '2025-10-01', '2026-10-01');
  y := pg_temp.sub(16, v_c, 'L Y', 1, '2025-10-01', '2026-10-01');
  z := pg_temp.sub(17, v_c, 'L Z', 1, '2025-10-01', '2026-10-01');
  w := pg_temp.sub(18, v_c, 'L W', 1, '2025-10-01', '2026-10-01');
  update public.subscriptions set bill_group_id = 'b2810000-0000-0000-0000-0000000009a1' where id in (x, y);
  update public.subscriptions set bill_group_id = 'b2810000-0000-0000-0000-0000000009a2' where id = w;
  px := pg_temp.part(x, 51, '2026-10-01', 1000);
  pz := pg_temp.part(z, 52, '2026-10-01', 1000);
  pw := pg_temp.part(w, 53, '2026-10-01', 1000);
  r := public.bill_parts_together(array[px, pz, pw]);
  if (select count(distinct bill_group_id) from public.subscriptions where id in (x, y, z, w)) <> 1
     or exists (select 1 from public.subscriptions where id in (x, y, z, w) and bill_group_id is null) then
    raise exception 'FAIL L: groups %', (select array_agg(bill_group_id) from public.subscriptions where id in (x, y, z, w)); end if;
  raise notice 'PASS L: already-grouped subs merged into one group';

  -- M. export customer → 0% GST, INR
  v_e := pg_temp.cust(8, 'United States');
  e1 := pg_temp.sub(19, v_e, 'M One', 2, '2025-10-01', '2026-10-01');
  e2 := pg_temp.sub(20, v_e, 'M Two', 2, '2025-10-01', '2026-10-01');
  pe1 := pg_temp.part(e1, 54, '2026-10-01', 2000);
  pe2 := pg_temp.part(e2, 55, '2026-10-01', 3000);
  r := public.bill_parts_together(array[pe1, pe2]);
  select * into v_q from public.quotes where id = r->>'quote_id';
  if v_q.tax_rate <> 0 or v_q.amount <> 5000 or upper(coalesce(v_q.currency, 'INR')) <> 'INR' or r->>'currency' <> 'INR' or (r->>'gross')::int <> 5000 then
    raise exception 'FAIL M: export proforma rate % amount % currency % / %', v_q.tax_rate, v_q.amount, v_q.currency, r; end if;
  raise notice 'PASS M: export customer → 0%% GST, amounts in INR (currency returned)';

  -- N. money already in the merged pool covers a started group → its invoice at once
  v_n := pg_temp.cust(9);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, amount, subtotal, tax_rate, line_items)
  values ('TESTQ-R2810-NSALE', 'b2810000-0000-0000-0000-0000000000f1', v_n, 'R2810 C9', 'accepted', 59000, 50000, 18, '[]'::jsonb);
  perform pg_temp.pay('TESTQ-R2810-NSALE', 59000, 'R2810-N-SALE');
  n1 := pg_temp.sub(21, v_n, 'N One', 2, '2025-10-01', '2026-10-01');
  n2 := pg_temp.sub(22, v_n, 'N Two', 2, '2025-10-01', '2026-10-01');
  update public.subscriptions set quote_id = 'TESTQ-R2810-NSALE' where id = n1;
  pn1 := pg_temp.part(n1, 56, '2026-10-01', 2000, '2026-10-01', '2027-10-01');
  pn2 := pg_temp.part(n2, 57, '2026-10-01', 3000, '2026-10-01', '2027-10-01');
  r := public.bill_parts_together(array[pn1, pn2]);
  if r->>'action' <> 'invoice' or r->>'invoice_id' is null
     or (select status::text from public.invoices where id = r->>'invoice_id') <> 'paid'
     or (select invoice_id from public.subscription_billings where id = pn2) is distinct from r->>'invoice_id'
     or (select status::text from public.quotes where id = r->>'quote_id') <> 'expired' then
    raise exception 'FAIL N: covered by the pool → %', r; end if;
  raise notice 'PASS N: money already in the pool → one paid tax invoice %, proforma closed', r->>'invoice_id';
end $$;

-- ── O I2 J2 — review fixes ────────────────────────────────────────────────────────────────────────────────────
do $$
declare v_c uuid; a uuid; b uuid; pa uuid; pb uuid; r jsonb; v_msg text; s1 uuid; s2 uuid; t uuid; ps1 uuid; pt uuid;
        a1 uuid; a2 uuid; b2 uuid; v_pi text; v_x text;
begin
  -- O. "Invoice on due date" customer, started group → its tax invoice at once (unpaid, chased as an invoice)
  v_c := pg_temp.cust(12);
  update public.customers set invoice_parts_on_due_date = true where id = v_c;
  a := pg_temp.sub(27, v_c, 'O One', 2, '2025-10-01', '2026-10-01');
  b := pg_temp.sub(28, v_c, 'O Two', 3, '2025-10-01', '2026-10-01');
  pa := pg_temp.part(a, 72, '2026-10-01', 2000);
  pb := pg_temp.part(b, 73, '2026-10-01', 3000);
  r := public.bill_parts_together(array[pa, pb]);
  if r->>'action' <> 'invoice' or (select invoice_id from public.subscription_billings where id = pb) is distinct from r->>'invoice_id'
     or (select status::text from public.invoices where id = r->>'invoice_id') = 'paid'
     or public.part_live_request('b2810000-0000-0000-0000-0000000000f1', pa) is not null then
    raise exception 'FAIL O: invoice-on-due-date customer → %', r; end if;
  raise notice 'PASS O: invoice-on-due-date customer → one tax invoice % at once, no open proforma', r->>'invoice_id';

  -- I2. a sale-quote sibling whose parts are not laid yet → refused (Bill next part waits for it too)
  v_c := pg_temp.cust(13);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, amount, subtotal, tax_rate, line_items)
  values ('TESTQ-R2810-I2SALE', 'b2810000-0000-0000-0000-0000000000f1', v_c, 'R2810 C13', 'accepted', 0, 0, 18, '[]'::jsonb);
  s1 := pg_temp.sub(29, v_c, 'I2 Laid', 2, '2025-10-01', '2026-10-01');
  s2 := pg_temp.sub(30, v_c, 'I2 Not Laid', 2, '2025-10-01', '2026-10-01');
  t  := pg_temp.sub(31, v_c, 'I2 Other', 2, '2025-10-01', '2026-10-01');
  update public.subscriptions set quote_id = 'TESTQ-R2810-I2SALE' where id in (s1, s2);
  ps1 := pg_temp.part(s1, 74, '2026-10-01', 2000);
  pt  := pg_temp.part(t, 75, '2026-10-01', 2000);
  v_msg := pg_temp.try(array[ps1, pt]);
  if v_msg not like '22023 I2 Laid is sold with I2 Not Laid on one sale quote, whose parts are not laid yet%' then raise exception 'FAIL I2: %', v_msg; end if;
  raise notice 'PASS I2: %', v_msg;

  -- J2. a DEAD together request (rejected, still linked) naming A's later part never blocks cancelling A's earlier one
  v_c := pg_temp.cust(14);
  a := pg_temp.sub(32, v_c, 'J2 A', 2, '2025-10-01', '2026-10-01');
  b := pg_temp.sub(33, v_c, 'J2 B', 2, '2025-10-01', '2026-10-01');
  a1 := pg_temp.part(a, 76, '2026-10-01', 2000);
  a2 := pg_temp.part(a, 77, '2026-11-01', 2000);
  update public.subscription_billings set period_index = 3 where id = a2;
  b2 := pg_temp.part(b, 78, '2026-11-01', 2000);
  v_pi := public.bill_subscription_instalment(a1, false)->>'quote_id';
  v_x := public.bill_parts_together(array[b2, a2])->>'quote_id';
  begin
    perform public.cancel_quote(v_pi, 'R2810 test: J2 live later');
    raise exception 'FAIL J2: cancel allowed while A''s later part is on live %', v_x;
  exception when sqlstate '22023' then
    if sqlerrm not like '%' || v_x || '%' then raise exception 'FAIL J2 live: %', sqlerrm; end if;
  end;
  update public.quotes set status = 'rejected' where id = v_x;   -- dead, still linked (subscription_billing_id kept)
  perform public.cancel_quote(v_pi, 'R2810 test: J2 dead later');
  if (select status::text from public.quotes where id = v_pi) <> 'rejected' then raise exception 'FAIL J2: cancel did not go through'; end if;
  raise notice 'PASS J2: a live together PI naming the later part blocks the cancel; a dead one does not';
end $$;

-- ── K — company + role ────────────────────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('b2810000-0000-0000-0000-0000000000a1', 'owner2810@example.test'),
  ('b2810000-0000-0000-0000-0000000000a2', 'sales2810@example.test'),
  ('b2810000-0000-0000-0000-0000000000a3', 'other2810@example.test');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('b2810000-0000-0000-0000-0000000000a1', 'b2810000-0000-0000-0000-0000000000f1', 'owner2810@example.test', 'Owner 2810', 'owner', now() - interval '1 day'),
  ('b2810000-0000-0000-0000-0000000000a2', 'b2810000-0000-0000-0000-0000000000f1', 'sales2810@example.test', 'Sales 2810', 'sales', now() - interval '1 day'),
  ('b2810000-0000-0000-0000-0000000000a3', 'b2810000-0000-0000-0000-0000000000f2', 'other2810@example.test', 'Other 2810', 'owner', now() - interval '1 day');
do $$
declare v_c uuid; begin
  v_c := pg_temp.cust(10);
  perform pg_temp.part(pg_temp.sub(23, v_c, 'K One', 2, '2025-10-01', '2026-10-01'), 61, '2026-10-01', 2000);
  perform pg_temp.part(pg_temp.sub(24, v_c, 'K Two', 2, '2025-10-01', '2026-10-01'), 62, '2026-10-01', 2000);
end $$;
grant execute on function pg_temp.try(uuid[]) to authenticated;

select set_config('request.jwt.claims', '{"sub":"b2810000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$ declare v_msg text; begin
  v_msg := pg_temp.try(array['b2810000-0000-0000-0000-000000000361'::uuid, 'b2810000-0000-0000-0000-000000000362'::uuid]);
  /* rev-r2810 LOW: one answer for another company's real ids and for random ids (no existence oracle) */
  if v_msg not like 'P0002 A part to bill was not found%' then raise exception 'FAIL K other company: %', v_msg; end if;
  if pg_temp.try(array['b2810000-0000-0000-0000-0000000003aa'::uuid, 'b2810000-0000-0000-0000-0000000003ab'::uuid]) <> v_msg then
    raise exception 'FAIL K oracle: random ids answer differently from another company''s ids'; end if;
  raise notice 'PASS K: other company refused, same answer as random ids: %', v_msg;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"b2810000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$ declare v_msg text; begin
  v_msg := pg_temp.try(array['b2810000-0000-0000-0000-000000000361'::uuid, 'b2810000-0000-0000-0000-000000000362'::uuid]);
  if v_msg not like '42501 Only an owner, manager, accountant or billing user%' then raise exception 'FAIL K sales: %', v_msg; end if;
  raise notice 'PASS K: sales role refused';
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"b2810000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$ declare r jsonb; begin
  r := public.bill_parts_together(array['b2810000-0000-0000-0000-000000000361'::uuid, 'b2810000-0000-0000-0000-000000000362'::uuid]);
  if r->>'action' <> 'request' or r->>'bill_group_id' is null then raise exception 'FAIL K owner: %', r; end if;
  raise notice 'PASS K: owner login bills together (bill_group_id set through the RPC)';
  /* (b) un-group: there is no un-group path (bill_parts_together only sets / merges); a member on a live together
     request cannot be taken out of the group by hand either (R-2806's guard). */
  begin
    update public.subscriptions set bill_group_id = null where id = 'b2810000-0000-0000-0000-000000000223';
    raise exception 'FAIL K: owner login un-grouped a member of a live together request';
  exception when insufficient_privilege then
    if sqlerrm not like '%Bill together%' then raise exception 'FAIL K un-group: %', sqlerrm; end if;
    raise notice 'PASS K: un-grouping a member by hand refused: %', sqlerrm;
  end;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ── R — rev-r2810 MEDIUM: no way round the one-live-request guard by editing a part request's lines ─────────
-- Setup (server): together PI for P+Q; R's part px has no request yet.
do $$
declare v_c uuid; p uuid; q uuid; x uuid; pp uuid; pq uuid; px uuid; r jsonb;
begin
  v_c := pg_temp.cust(15);
  p := pg_temp.sub(34, v_c, 'R P', 2, '2025-10-01', '2026-10-01');
  q := pg_temp.sub(35, v_c, 'R Q', 2, '2025-10-01', '2026-10-01');
  x := pg_temp.sub(36, v_c, 'R X', 2, '2025-10-01', '2026-10-01');
  pp := pg_temp.part(p, 81, '2026-10-01', 2000);
  pq := pg_temp.part(q, 82, '2026-10-01', 2000);
  px := pg_temp.part(x, 83, '2026-10-01', 2000);
  r := public.bill_parts_together(array[pp, pq]);
  perform set_config('r2810.test_r_quote', r->>'quote_id', false);
end $$;
-- R1. an owner login cannot change a part request's lines / amount by hand (UPPERCASE billing_id = the bypass)
select set_config('request.jwt.claims', '{"sub":"b2810000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_q text := current_setting('r2810.test_r_quote'); n int;
begin
  begin
    update public.quotes
       set line_items = line_items || jsonb_build_array(jsonb_build_object('billing_id', upper('b2810000-0000-0000-0000-000000000383'), 'qty', 2, 'rate', 1000))
     where id = v_q;
    get diagnostics n = row_count;
    raise exception 'FAIL R1: owner login added a line to part request % (% rows)', v_q, n;
  exception when insufficient_privilege then
    if sqlerrm not like '%cannot be edited by hand%' then raise exception 'FAIL R1: refused for another reason: %', sqlerrm; end if;
  end;
  begin
    update public.quotes set amount = 1 where id = v_q;
    raise exception 'FAIL R1: owner login changed the amount of part request %', v_q;
  exception when insufficient_privilege then null;
  end;
  update public.quotes set notes = 'R1 note' where id = v_q;   -- other columns still fine
  raise notice 'PASS R1: owner login cannot edit a part request''s lines or amount (notes still editable)';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
-- R2. server code: an UPPERCASE billing_id is the same part — stored lowercase, and refused while the part is on another live request
do $$
declare v_q text := current_setting('r2810.test_r_quote'); v_own text; v_lines jsonb;
begin
  -- the reviewer's order: an UPPERCASE line for X lands on the together request first …
  perform set_config('app.r2519_write', 'on', true);
  update public.quotes
     set line_items = line_items || jsonb_build_array(jsonb_build_object('billing_id', upper('b2810000-0000-0000-0000-000000000383'), 'qty', 2, 'rate', 1000))
   where id = v_q;
  perform set_config('app.r2519_write', '', true);
  select line_items into v_lines from public.quotes where id = v_q;
  if not (v_lines @> jsonb_build_array(jsonb_build_object('billing_id', 'b2810000-0000-0000-0000-000000000383'))) then
    raise exception 'FAIL R2: billing_id not stored in canonical form: %', v_lines; end if;
  -- … then Bill next part on X must not make a SECOND live request naming X (the F4 money-stuck case)
  begin
    v_own := public.bill_subscription_instalment('b2810000-0000-0000-0000-000000000383', false)->>'quote_id';
    raise exception 'FAIL R2: Bill next part on X made % although X is on % (UPPERCASE line)', v_own, v_q;
  exception when unique_violation then
    if sqlerrm not like '%' || v_q || '%' then raise exception 'FAIL R2: %', sqlerrm; end if;
  end;
  if (select count(*) from public.quotes where subscription_billing_id = 'b2810000-0000-0000-0000-000000000383') <> 0 then
    raise exception 'FAIL R2: X got its own request'; end if;
  raise notice 'PASS R2: an UPPERCASE billing_id is stored lowercase and still blocks a second live request for X (on %)', v_q;
end $$;

-- ── Y — rev-r2810 LOW: a yearly subscription is not billed in parts ───────────────────────────────────────────
do $$
declare v_c uuid; y uuid; m uuid; py uuid; pm uuid; v_msg text;
begin
  v_c := pg_temp.cust(16);
  y := pg_temp.sub(37, v_c, 'Y Yearly', 2, '2025-10-01', '2026-10-01');
  m := pg_temp.sub(38, v_c, 'Y Monthly', 2, '2025-10-01', '2026-10-01');
  update public.subscriptions set billing_cycle = 'yearly' where id = y;
  py := pg_temp.part(y, 84, '2026-10-01', 2000);
  pm := pg_temp.part(m, 85, '2026-10-01', 2000);
  v_msg := pg_temp.try(array[pm, py]);
  if v_msg not like '22023 Y Yearly is billed yearly%' then raise exception 'FAIL Y: %', v_msg; end if;
  raise notice 'PASS Y: %', v_msg;
end $$;

-- ── U — decision (coordinator, 15 Nov): Cancel NEVER un-groups (reviews rev2–rev4 found money used twice) ─────
do $$
declare v_c uuid; a uuid; b uuid; pa uuid; pb uuid; pa2 uuid; pb2 uuid; r jsonb;
begin
  -- U1. nothing invoiced from the group → Cancel still keeps the group (one pool; never split by Cancel)
  v_c := pg_temp.cust(17);
  a := pg_temp.sub(39, v_c, 'U A', 2, '2025-10-01', '2026-10-01');
  b := pg_temp.sub(40, v_c, 'U B', 2, '2025-10-01', '2026-10-01');
  pa := pg_temp.part(a, 86, '2026-10-01', 2000);
  pb := pg_temp.part(b, 87, '2026-10-01', 2000);
  r := public.bill_parts_together(array[pa, pb]);
  perform public.cancel_quote(r->>'quote_id', 'R2810 test: picked by mistake');
  if exists (select 1 from public.subscriptions where id in (a, b) and bill_group_id is null)
     or (select count(distinct bill_group_id) from public.subscriptions where id in (a, b)) <> 1
     or (select count(*) from public.billing_pool_subscriptions(a)) <> 2 then
    raise exception 'FAIL U1: after cancel groups % pool(a) %', (select array_agg(bill_group_id) from public.subscriptions where id in (a, b)),
      (select array_agg(subscription_id) from public.billing_pool_subscriptions(a)); end if;
  raise notice 'PASS U1: cancelling a together proforma keeps the bill group (Cancel never un-groups)';

  -- U2. a group that already shares an issued invoice stays grouped when a later together proforma is cancelled
  r := public.bill_parts_together(array[pa, pb]);
  perform pg_temp.pay(r->>'quote_id', (r->>'gross')::int, 'R2810-U2');
  if (select invoice_id from public.subscription_billings where id = pb) is null then raise exception 'FAIL U2 setup: not invoiced'; end if;
  pa2 := pg_temp.part(a, 88, '2026-11-01', 2000);
  pb2 := pg_temp.part(b, 89, '2026-11-01', 2000);
  update public.subscription_billings set period_index = 3 where id in (pa2, pb2);
  r := public.bill_parts_together(array[pa2, pb2]);
  perform public.cancel_quote(r->>'quote_id', 'R2810 test: cancel later together');
  if (select count(distinct bill_group_id) from public.subscriptions where id in (a, b) and bill_group_id is not null) <> 1
     or exists (select 1 from public.subscriptions where id in (a, b) and bill_group_id is null) then
    raise exception 'FAIL U2: a group with an issued shared invoice was ungrouped'; end if;
  raise notice 'PASS U2: a group sharing an issued invoice stays grouped after a later cancel';
end $$;

-- ── U3 U4 L3 — rev2-r2810 ────────────────────────────────────────────────────────────────────────────────────
do $$
declare v_c uuid; a uuid; b uuid; c uuid; pa uuid; pb uuid; pc uuid; r jsonb; v_inv text; g uuid;
        d uuid; e uuid; pd uuid; pe uuid; v_key bigint;
begin
  -- U3 (reviewer's repro): A+B paid → full credit note → mistaken Bill together C+A → Cancel → the group STAYS
  v_c := pg_temp.cust(18);
  a := pg_temp.sub(41, v_c, 'U3 A', 2, '2025-10-01', '2026-10-01');
  b := pg_temp.sub(42, v_c, 'U3 B', 2, '2025-10-01', '2026-10-01');
  c := pg_temp.sub(43, v_c, 'U3 C', 2, '2025-10-01', '2026-10-01');
  pa := pg_temp.part(a, 91, '2026-10-01', 2000);
  pb := pg_temp.part(b, 92, '2026-10-01', 2000);
  pc := pg_temp.part(c, 93, '2026-10-01', 9000);   -- more than the note's credit: a real proforma, not paid from the pool
  r := public.bill_parts_together(array[pa, pb]);
  perform pg_temp.pay(r->>'quote_id', (r->>'gross')::int, 'R2810-U3');
  select invoice_id into v_inv from public.subscription_billings where id = pa;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.issue_credit_note(v_inv, (select amount from public.invoices where id = v_inv), 'cancellation', 'R2810 U3 full CN', null);
  perform set_config('request.jwt.claims', '', true);
  if (select count(*) from public.subscription_billings where id in (pa, pb) and invoice_id is null and v_inv = any(credited_invoice_ids)) <> 2 then
    raise exception 'FAIL U3 setup: credit note did not free both parts'; end if;
  r := public.bill_parts_together(array[pc, pa]);
  perform public.cancel_quote(r->>'quote_id', 'R2810 test: U3 mistaken together');
  select bill_group_id into g from public.subscriptions where id = a;
  if g is null or (select count(*) from public.subscriptions where id in (a, b, c) and bill_group_id = g) <> 3 then
    raise exception 'FAIL U3: group with a credited shared invoice was split: %',
      (select array_agg(bill_group_id) from public.subscriptions where id in (a, b, c)); end if;
  raise notice 'PASS U3: a group whose shared invoice was credit-noted stays grouped after a cancelled Bill together';

  -- L3: the first ticked part still holds its old (spent) proforma link → the request leads with the next part
  r := public.bill_parts_together(array[pa, pc]);
  if r->>'action' <> 'request' or (select subscription_billing_id from public.quotes where id = r->>'quote_id') <> pc then
    raise exception 'FAIL L3: credit-noted first part → % (lead %)', r, (select subscription_billing_id from public.quotes where id = r->>'quote_id'); end if;
  raise notice 'PASS L3: a credit-noted first part does not break Bill together (lead = the next part)';

  -- U4: cancel takes Bill together's per-customer lock (hand-made request: the RPC never ran for this customer)
  v_c := pg_temp.cust(19);
  d := pg_temp.sub(44, v_c, 'U4 D', 2, '2025-10-01', '2026-10-01');
  e := pg_temp.sub(45, v_c, 'U4 E', 2, '2025-10-01', '2026-10-01');
  update public.subscriptions set bill_group_id = 'b2810000-0000-0000-0000-0000000009b4' where id in (d, e);
  pd := pg_temp.part(d, 94, '2026-10-01', 2000);
  pe := pg_temp.part(e, 95, '2026-10-01', 2000);
  perform set_config('app.r2519_write', 'on', true);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, subtotal, tax_rate, line_items, subscription_billing_id, created_date)
  values ('TESTQ-R2810-U4', 'b2810000-0000-0000-0000-0000000000f1', v_c, 'R2810 C19', 'sent', 'none', 4720, 4000, 18,
          jsonb_build_array(jsonb_build_object('billing_id', pd::text, 'qty', 2, 'rate', 1000), jsonb_build_object('billing_id', pe::text, 'qty', 2, 'rate', 1000)),
          pd, public.ist_today());
  perform set_config('app.r2519_write', '', true);
  v_key := hashtextextended('r2810:bill-together:b2810000-0000-0000-0000-0000000000f1:' || v_c::text, 0);
  if exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and ((classid::bigint << 32) | objid::bigint) = v_key) then
    raise exception 'FAIL U4 setup: lock already held'; end if;
  perform public.cancel_quote('TESTQ-R2810-U4', 'R2810 test: U4 lock');
  if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and ((classid::bigint << 32) | objid::bigint) = v_key) then
    raise exception 'FAIL U4: cancel_quote did not take the per-customer Bill together lock'; end if;
  if exists (select 1 from public.subscriptions where id in (d, e) and bill_group_id is distinct from 'b2810000-0000-0000-0000-0000000009b4') then
    raise exception 'FAIL U4: cancel changed the group'; end if;
  raise notice 'PASS U4: cancel takes the per-customer lock and keeps the group';
end $$;

-- ── U5 — rev3-r2810 (reviewer's repro1): while grouped, B's part was paid from A's credit-note credit with no
--    two-member document → Cancel of the together proforma must KEEP the group (else A's credit is claimed twice) ──
do $$
declare v_c uuid; a uuid; b uuid; pa0 uuid; pa1 uuid; pb0 uuid; pb1 uuid; r jsonb; v_inv text; x jsonb; pix text; g uuid;
begin
  v_c := pg_temp.cust(21);
  a := pg_temp.sub(48, v_c, 'U5 A', 2, '2025-09-01', '2026-09-01');
  b := pg_temp.sub(49, v_c, 'U5 B', 2, '2025-09-01', '2026-09-01');
  pa0 := pg_temp.part(a, 3, '2026-09-01', 2000, null, null, 2);
  pa1 := pg_temp.part(a, 4, '2026-10-01', 2000, null, null, 3);
  pb0 := pg_temp.part(b, 5, '2026-09-01', 2000, null, null, 2);
  pb1 := pg_temp.part(b, 6, '2026-10-01', 9000, null, null, 3);
  -- A0 billed alone, paid, full credit note → ₹2,360 credit for A only
  r := public.bill_subscription_instalment(pa0, false);
  perform pg_temp.pay(r->>'quote_id', (select amount from public.quotes where id = r->>'quote_id'), 'R2810-U5-A0');
  select invoice_id into v_inv from public.subscription_billings where id = pa0;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.issue_credit_note(v_inv, (select amount from public.invoices where id = v_inv), 'cancellation', 'R2810 U5 full CN', null);
  perform set_config('request.jwt.claims', '', true);
  -- Bill together A1 + B1 → PI-X; then B0 billed alone from the merged pool (A's credit)
  r := public.bill_parts_together(array[pa1, pb1]); pix := r->>'quote_id';
  x := public.bill_subscription_instalment(pb0, false);
  if x->>'action' <> 'invoice' then raise exception 'FAIL U5 setup: B0 not paid from the pool: %', x; end if;
  -- the mistaken together is cancelled → the group must stay (B0 was paid with A's money while grouped)
  perform public.cancel_quote(pix, 'R2810 test: U5 mistaken together');
  select bill_group_id into g from public.subscriptions where id = a;
  if g is null or (select bill_group_id from public.subscriptions where id = b) is distinct from g then
    raise exception 'FAIL U5: group split after B0 was paid from A''s credit: %',
      (select array_agg(bill_group_id) from public.subscriptions where id in (a, b)); end if;
  if public.instalment_credit(a) <> public.instalment_credit(b) then
    raise exception 'FAIL U5: pools differ A % / B % (credit claimable twice)', public.instalment_credit(a), public.instalment_credit(b); end if;
  raise notice 'PASS U5: money moved inside the group since it formed → Cancel keeps the group (one pool, credit counted once)';
end $$;

-- ── U6 — rev4-r2810 (reviewer's merge_attack): an older group with money history merged into a newer one, then
--    both together proformas cancelled → every member stays in ONE group (C's credit-note credit counted once) ──
do $$
declare v_c uuid; a uuid; b uuid; c uuid; d uuid; pa1 uuid; pa2 uuid; pb1 uuid; pc0 uuid; pc1 uuid; pc2 uuid; pd0 uuid; pd1 uuid;
        r jsonb; x jsonb; v_inv text; pi1 text; pia text; piz text; g uuid;
begin
  v_c := pg_temp.cust(22);
  a := pg_temp.sub(50, v_c, 'M A', 2, '2025-09-01', '2026-09-01');
  b := pg_temp.sub(51, v_c, 'M B', 2, '2025-09-01', '2026-09-01');
  c := pg_temp.sub(52, v_c, 'M C', 2, '2025-09-01', '2026-09-01');
  d := pg_temp.sub(53, v_c, 'M D', 2, '2025-09-01', '2026-09-01');
  pc0 := pg_temp.part(c, 7, '2026-09-01', 2000, null, null, 2);
  pc1 := pg_temp.part(c, 8, '2026-10-01', 2000, null, null, 3);
  pc2 := pg_temp.part(c, 9, '2026-11-01', 2000, null, null, 4);
  pd0 := pg_temp.part(d, 10, '2026-09-01', 2000, null, null, 2);
  pd1 := pg_temp.part(d, 13, '2026-10-01', 9000, null, null, 3);
  pa1 := pg_temp.part(a, 14, '2026-10-01', 2000, null, null, 3);
  pa2 := pg_temp.part(a, 15, '2026-11-01', 2000, null, null, 4);
  pb1 := pg_temp.part(b, 16, '2026-10-01', 2000, null, null, 3);
  -- {C,D}: C0 paid then full credit note; Bill together C1+D1; D0 paid from C's credit; cancel → kept
  r := public.bill_subscription_instalment(pc0, false);
  perform pg_temp.pay(r->>'quote_id', (select amount from public.quotes where id = r->>'quote_id'), 'R2810-U6-C0');
  select invoice_id into v_inv from public.subscription_billings where id = pc0;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.issue_credit_note(v_inv, (select amount from public.invoices where id = v_inv), 'cancellation', 'R2810 U6 full CN', null);
  perform set_config('request.jwt.claims', '', true);
  r := public.bill_parts_together(array[pc1, pd1]); pi1 := r->>'quote_id';
  x := public.bill_subscription_instalment(pd0, false);
  if x->>'action' <> 'invoice' then raise exception 'FAIL U6 setup: D0 not paid from the pool: %', x; end if;
  perform public.cancel_quote(pi1, 'R2810 test: U6 cancel PI-1');
  -- the older group gets an id that sorts LAST; a newer {A,B} group one that sorts FIRST
  update public.subscriptions set bill_group_id = 'ffffffff-0000-0000-0000-000000000022' where id in (c, d);
  r := public.bill_parts_together(array[pa1, pb1]); pia := r->>'quote_id';
  update public.subscriptions set bill_group_id = '00000000-0000-0000-0000-000000000022' where id in (a, b);
  -- merge: Bill together A2 + C2 → one group; then both together proformas are cancelled
  r := public.bill_parts_together(array[pa2, pc2]); piz := r->>'quote_id';
  perform public.cancel_quote(piz, 'R2810 test: U6 cancel PI-Z');
  perform public.cancel_quote(pia, 'R2810 test: U6 cancel PI-A');
  select bill_group_id into g from public.subscriptions where id = c;
  if g is null or (select count(*) from public.subscriptions where id in (a, b, c, d) and bill_group_id = g) <> 4 then
    raise exception 'FAIL U6: merged group split by cancel: %', (select array_agg(bill_group_id) from public.subscriptions where id in (a, b, c, d)); end if;
  if public.instalment_credit(c) <> public.instalment_credit(d) or public.instalment_credit(c) <> public.instalment_credit(a) then
    raise exception 'FAIL U6: pools differ C % D % A %', public.instalment_credit(c), public.instalment_credit(d), public.instalment_credit(a); end if;
  raise notice 'PASS U6: merged group with money history stays one group after both cancels (one pool, credit counted once)';
end $$;

-- ── HOLD — R-2807 review: Won't renew / an open renewal quote set after the screen read it → refused in the RPC ──
do $$
declare v_c uuid; a uuid; b uuid; pa uuid; pb uuid; v_msg text;
begin
  v_c := pg_temp.cust(20);
  a := pg_temp.sub(46, v_c, 'HOLD A', 2, '2025-10-01', '2026-10-01');
  b := pg_temp.sub(47, v_c, 'HOLD B', 2, '2025-10-01', '2026-10-01');
  pa := pg_temp.part(a, 96, '2026-10-01', 2000);
  pb := pg_temp.part(b, 97, '2026-10-01', 2000);
  update public.subscriptions set auto_renew = false where id = b;
  v_msg := pg_temp.try(array[pa, pb]);
  if v_msg not like '22023 HOLD B is marked Won''t renew — press Undo Won''t renew on the subscription first.%' then
    raise exception 'FAIL HOLD won''t renew: %', v_msg; end if;
  update public.subscriptions set auto_renew = true where id = b;
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, amount, subtotal, tax_rate, line_items)
  values ('TESTQ-R2810-RENEW', 'b2810000-0000-0000-0000-0000000000f1', v_c, 'R2810 C20', 'sent', 2360, 2000, 18, '[]'::jsonb);
  update public.subscriptions set renewal_quote_id = 'TESTQ-R2810-RENEW' where id = a;
  v_msg := pg_temp.try(array[pa, pb]);
  if v_msg not like '22023 Renewal quote TESTQ-R2810-RENEW is still open for HOLD A — paying it would bill the new term twice. Cancel it first.%' then
    raise exception 'FAIL HOLD renewal quote: %', v_msg; end if;
  if exists (select 1 from public.subscriptions where id in (a, b) and bill_group_id is not null)
     or exists (select 1 from public.quotes where customer_id = v_c and subscription_billing_id is not null) then
    raise exception 'FAIL HOLD: something was written'; end if;
  raise notice 'PASS HOLD: Won''t renew and an open renewal quote are refused inside the RPC, nothing written';
end $$;

-- ── Z — grants ────────────────────────────────────────────────────────────────────────────────────────────────
do $$ begin
  if has_function_privilege('anon', 'public.bill_parts_together(uuid[])', 'execute')
     or not has_function_privilege('authenticated', 'public.bill_parts_together(uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.tg_quotes_one_live_request_per_part()', 'execute')
     or has_function_privilege('anon', 'public.tg_quotes_one_live_request_per_part()', 'execute') then
    raise exception 'FAIL Z: grants'; end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.bill_parts_together(uuid[])'::regprocedure and p.prosecdef
                   and array_to_string(p.proconfig, ',') like '%search_path=public%') then
    raise exception 'FAIL Z: bill_parts_together must be SECURITY DEFINER with search_path'; end if;
  raise notice 'PASS Z: RPC for signed-in users (role + company checked inside), not anon; guard server-only';
end $$;

rollback;
