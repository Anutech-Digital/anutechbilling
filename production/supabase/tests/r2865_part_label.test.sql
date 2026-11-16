-- R-2865 (Pardeep, 16 Nov 2026 — staging Q-A378-27-0124): a renewal part proforma is a payment request for
-- its service period, not an advance. New part proformas say "Payment for month 2 · 15 Oct–14 Nov 2026" where
-- they said "Advance payment for month 2 · …" (line description, notes, the RPC's returned label).
-- Migration 20261116112013_r2865_part_label_payment — ONLY that text changes.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
--   A.  Bill next part, monthly, 49 seats × ₹450      → PI, ₹22,050 + 18% = ₹26,019; line 49 × 450, its period,
--                                                        linked to the part, due date on the part; the line NAME as
--                                                        before (R-2423); description / notes / label "Payment for
--                                                        month 2 · 15 Oct–14 Nov 2026"; nothing says "Advance"
--   A2. Bill next part again                           → the same proforma (request_open), still one
--   Q.  Quarterly, 3 seats, ₹1,000 (does not divide)   → 1 × ₹1,000 (never a rounded per-seat rate), ₹1,180;
--                                                        "Payment for Q2 · 1 Oct–31 Dec 2026"
--   H.  Half-yearly                                    → "Payment for H2 · …"
--   B.  Bill together, 161 × ₹1,585 + 49 × ₹450        → ONE PI, subtotal ₹2,77,235, GST 18% ₹49,902, two lines each
--                                                        its own qty × rate, period and part; each line's description
--                                                        "Payment for month 2 · <its period>"; nothing says "Advance"
--   P.  Pay the together proforma                      → ONE paid tax invoice of the same amount (the label is not
--                                                        read by the payment path)
--   M.  Both function bodies carry the R-2865 mark and no 'Advance payment for' string

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
  ('b2865000-0000-0000-0000-0000000000f1', 'R2865 Label Co', 'r2865@example.test', '07', 'R865');
update public.tenants set books_start_date = '2025-04-01' where id = 'b2865000-0000-0000-0000-0000000000f1';

create function pg_temp.cust(p_n int) returns uuid language plpgsql as $f$
declare v_c uuid := ('b2865000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'b2865000-0000-0000-0000-0000000000f1', 'R2865 C' || p_n, '07', 'India');
  return v_c;
end $f$;

create function pg_temp.sub(p_n int, p_c uuid, p_plan text, p_seats int, p_cycle text, p_start date, p_renewal date)
returns uuid language plpgsql as $f$
declare v_s uuid := ('b2865000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status, domain)
  values (v_s, 'b2865000-0000-0000-0000-0000000000f1', p_c, (select name from public.customers where id = p_c), p_plan,
          'google'::vendor, p_seats, 1000, p_cycle::billing_cycle, 12, p_start, p_renewal, 'grace_period', 2, 'active',
          'r2865-' || p_n || '.example.test');
  return v_s;
end $f$;

/* A part of index 2 that began on p_start and runs p_months. */
create function pg_temp.part(p_s uuid, p_k int, p_start date, p_months int, p_taxable int)
returns uuid language plpgsql as $f$
declare v_b uuid := ('b2865000-0000-0000-0000-0000000003' || lpad(p_k::text, 2, '0'))::uuid;
begin
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                            period_end, taxable_amount, tax_rate)
  values (v_b, 'b2865000-0000-0000-0000-0000000000f1', p_s, (p_start - make_interval(months => p_months))::date, 2, p_start, p_start,
          (p_start + make_interval(months => p_months))::date, p_taxable, 18);
  return v_b;
end $f$;

/* True when no text of the request (lines, notes, plan) says "advance" in any case. */
create function pg_temp.no_advance(p_q text) returns boolean language sql as $f$
  select not exists (select 1 from public.quotes q
                      where q.id = p_q
                        and (q.line_items::text ilike '%advance%' or coalesce(q.notes, '') ilike '%advance%'
                             or coalesce(q.plan, '') ilike '%advance%'));
$f$;

do $$
declare
  v_c uuid; v_s uuid; p uuid; r jsonb; r2 jsonb; v_q record; l jsonb; v_due date;
  v_label constant text := 'Payment for month 2 · 15 Oct–14 Nov 2026';
begin
  -- ── A. Bill next part — monthly, per-seat exact ─────────────────────────────────────────────────
  v_c := pg_temp.cust(1);
  v_s := pg_temp.sub(1, v_c, 'Google Workspace Business Starter', 49, 'monthly', '2025-10-15', '2026-10-15');
  p := pg_temp.part(v_s, 1, '2026-10-15', 1, 49 * 450);

  r := public.bill_subscription_instalment(p, true);
  if r->>'action' <> 'request' or (r->>'gross')::int <> 26019 then raise exception 'FAIL A: dry run → %', r; end if;
  if exists (select 1 from public.quotes where subscription_billing_id = p) then raise exception 'FAIL A: dry run wrote a request'; end if;

  r := public.bill_subscription_instalment(p, false);
  if r->>'action' <> 'request' or (r->>'created')::boolean is not true or (r->>'gross')::int <> 26019 or (r->>'parts')::int <> 1 then
    raise exception 'FAIL A: → %', r; end if;
  if r->>'label' is distinct from v_label then raise exception 'FAIL A: returned label %', r->>'label'; end if;
  select * into v_q from public.quotes where id = r->>'quote_id';
  select due_on into v_due from public.subscription_billings where id = p;
  if v_q.id not like 'PI-%' or v_q.subscription_billing_id <> p or v_q.customer_id <> v_c
     or v_q.amount <> 26019 or v_q.subtotal <> 22050 or v_q.tax_rate <> 18 or v_q.total_cost <> 0 or v_q.discount_pct <> 0
     or v_q.status::text <> 'sent' or v_q.payment_status::text <> 'awaiting' or not v_q.is_one_off
     or v_q.plan <> 'Google Workspace Business Starter' or v_q.seats <> 49 or v_q.expires_date is not null
     or v_q.payment_terms_days is distinct from (v_due - public.ist_today())
     or v_due is distinct from (r->>'due_on')::date or jsonb_array_length(v_q.line_items) <> 1 then
    raise exception 'FAIL A: proforma % amount % subtotal % rate % status % terms % due %', v_q.id, v_q.amount, v_q.subtotal,
      v_q.tax_rate, v_q.status, v_q.payment_terms_days, v_due; end if;
  l := v_q.line_items->0;
  if (l->>'qty')::int <> 49 or (l->>'rate')::int <> 450 or (l->>'per_seat')::boolean is not true
     or l->>'period_start' <> '2026-10-15' or l->>'period_end' <> '2026-11-14'
     or (l->>'cost')::int <> 0 or (l->>'one_time')::boolean is not true or l->>'id' <> 'part-2' then
    raise exception 'FAIL A: line figures %', l; end if;
  if l->>'name' is distinct from 'Google Workspace Business Starter · r2865-1.example.test · 49 seats · 15 Oct–14 Nov 2026 (part 2 of 12)' then
    raise exception 'FAIL A: line name %', l->>'name'; end if;
  if l->>'description' is distinct from v_label then raise exception 'FAIL A: line description %', l->>'description'; end if;
  if v_q.notes is distinct from v_label || '. Due on ' || to_char(v_due, 'FMDD Mon YYYY') || '. The tax invoice is issued when this is paid.' then
    raise exception 'FAIL A: notes %', v_q.notes; end if;
  if not pg_temp.no_advance(v_q.id) then raise exception 'FAIL A: the proforma still says advance: % / %', v_q.line_items, v_q.notes; end if;
  raise notice 'PASS A: % — ₹26,019, 49 × ₹450, "%"', v_q.id, l->>'description';

  -- ── A2. again → the same proforma ───────────────────────────────────────────────────────────────
  r2 := public.bill_subscription_instalment(p, false);
  if r2->>'action' <> 'request_open' or r2->>'quote_id' <> v_q.id or (r2->>'gross')::int <> 26019 then raise exception 'FAIL A2: %', r2; end if;
  if (select count(*) from public.quotes where customer_id = v_c) <> 1 then raise exception 'FAIL A2: a second proforma'; end if;
  raise notice 'PASS A2: again → the same proforma';

  -- ── Q. quarterly, amount that does not divide by the seats ──────────────────────────────────────
  v_c := pg_temp.cust(2);
  v_s := pg_temp.sub(2, v_c, 'Google Workspace Business Plus', 3, 'quarterly', '2025-07-01', '2026-07-01');
  p := pg_temp.part(v_s, 2, '2026-10-01', 3, 1000);
  r := public.bill_subscription_instalment(p, false);
  select * into v_q from public.quotes where id = r->>'quote_id';
  l := v_q.line_items->0;
  if r->>'action' <> 'request' or v_q.amount <> 1180 or v_q.subtotal <> 1000 or (l->>'qty')::int <> 1 or (l->>'rate')::int <> 1000
     or (l->>'per_seat')::boolean is not false or l->>'period_start' <> '2026-10-01' or l->>'period_end' <> '2026-12-31' then
    raise exception 'FAIL Q: % / %', r, l; end if;
  if l->>'description' is distinct from 'Payment for Q2 · 1 Oct–31 Dec 2026' or r->>'label' is distinct from 'Payment for Q2 · 1 Oct–31 Dec 2026'
     or l->>'name' is distinct from 'Google Workspace Business Plus · r2865-2.example.test · 3 seats · 1 Oct–31 Dec 2026 (part 2 of 4)'
     or not pg_temp.no_advance(v_q.id) then
    raise exception 'FAIL Q: text % / % / %', l->>'name', l->>'description', v_q.notes; end if;
  raise notice 'PASS Q: quarterly → 1 × ₹1,000, "%"', l->>'description';

  -- ── H. half-yearly ──────────────────────────────────────────────────────────────────────────────
  v_c := pg_temp.cust(3);
  v_s := pg_temp.sub(3, v_c, 'Google Workspace Enterprise', 2, 'half_yearly', '2026-04-01', '2027-04-01');
  p := pg_temp.part(v_s, 3, '2026-10-01', 6, 6000);
  r := public.bill_subscription_instalment(p, false);
  select * into v_q from public.quotes where id = r->>'quote_id';
  l := v_q.line_items->0;
  if v_q.amount <> 7080 or (l->>'qty')::int <> 2 or (l->>'rate')::int <> 3000
     or l->>'description' is distinct from 'Payment for H2 · 1 Oct–31 Mar 2027' or not pg_temp.no_advance(v_q.id) then
    raise exception 'FAIL H: % / % / %', v_q.amount, l, v_q.notes; end if;
  raise notice 'PASS H: half-yearly → "%"', l->>'description';
end $$;

-- ── B P — Bill together ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_c uuid; v_a uuid; v_b uuid; pa uuid; pb uuid; r jsonb; v_q record; la jsonb; lb jsonb; v_inv record;
begin
  v_c := pg_temp.cust(4);
  v_a := pg_temp.sub(4, v_c, 'Google Workspace Business Standard', 161, 'monthly', '2025-10-01', '2026-10-01');
  v_b := pg_temp.sub(5, v_c, 'Google Workspace Business Starter', 49, 'monthly', '2025-10-15', '2026-10-15');
  pa := pg_temp.part(v_a, 4, '2026-10-01', 1, 161 * 1585);
  pb := pg_temp.part(v_b, 5, '2026-10-15', 1, 49 * 450);

  r := public.bill_parts_together(array[pa, pb]);
  if r->>'action' <> 'request' or (r->>'already_existed')::boolean or (r->>'taxable')::int <> 277235 or (r->>'tax')::int <> 49902
     or (r->>'gross')::int <> 327137 or (r->>'tax_rate')::int <> 18 or r->>'currency' <> 'INR' then
    raise exception 'FAIL B: → %', r; end if;
  select * into v_q from public.quotes where id = r->>'quote_id';
  if v_q.id not like 'PI-%' or v_q.subscription_billing_id <> pa or v_q.amount <> 327137 or v_q.subtotal <> 277235 or v_q.tax_rate <> 18
     or v_q.seats <> 210 or v_q.plan <> 'Google Workspace Business Standard + Google Workspace Business Starter'
     or jsonb_array_length(v_q.line_items) <> 2 or v_q.status::text <> 'sent' then
    raise exception 'FAIL B: proforma % amount % subtotal % seats % plan %', v_q.id, v_q.amount, v_q.subtotal, v_q.seats, v_q.plan; end if;
  la := v_q.line_items->0; lb := v_q.line_items->1;
  if la->>'billing_id' <> pa::text or lb->>'billing_id' <> pb::text
     or (la->>'qty')::int <> 161 or (la->>'rate')::int <> 1585 or (lb->>'qty')::int <> 49 or (lb->>'rate')::int <> 450
     or la->>'period_start' <> '2026-10-01' or la->>'period_end' <> '2026-10-31'
     or lb->>'period_start' <> '2026-10-15' or lb->>'period_end' <> '2026-11-14'
     or la->>'id' <> 'part-2-1' or lb->>'id' <> 'part-2-2' then
    raise exception 'FAIL B: line figures % / %', la, lb; end if;
  if la->>'name' is distinct from 'Google Workspace Business Standard · r2865-4.example.test · 161 seats · 1 Oct–31 Oct 2026 (part 2 of 12)'
     or lb->>'name' is distinct from 'Google Workspace Business Starter · r2865-5.example.test · 49 seats · 15 Oct–14 Nov 2026 (part 2 of 12)' then
    raise exception 'FAIL B: line names % / %', la->>'name', lb->>'name'; end if;
  if la->>'description' is distinct from 'Payment for month 2 · 1 Oct–31 Oct 2026'
     or lb->>'description' is distinct from 'Payment for month 2 · 15 Oct–14 Nov 2026' then
    raise exception 'FAIL B: descriptions % / %', la->>'description', lb->>'description'; end if;
  if v_q.notes not like 'Billed together: Google Workspace Business Standard + Google Workspace Business Starter. Due on %. The tax invoice is issued when this is paid.'
     or not pg_temp.no_advance(v_q.id) then
    raise exception 'FAIL B: notes / advance wording: % / %', v_q.notes, v_q.line_items; end if;
  if (select count(*) from public.subscription_billings where id in (pa, pb) and due_on = (r->>'due_on')::date) <> 2 then
    raise exception 'FAIL B: due_on not on both parts'; end if;
  raise notice 'PASS B: together % — ₹3,27,137, "%" + "%"', v_q.id, la->>'description', lb->>'description';

  -- ── P. paid → one tax invoice of the same amount ────────────────────────────────────────────────
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2865000-0000-0000-0000-0000000000f1', v_q.id, v_q.amount, 'bank_transfer', 'R2865-B', 'received', now());
  if (select count(*) from public.invoices where customer_id = v_c) <> 1
     or (select count(distinct invoice_id) from public.subscription_billings where id in (pa, pb) and invoice_id is not null) <> 1
     or exists (select 1 from public.subscription_billings where id in (pa, pb) and invoice_id is null) then
    raise exception 'FAIL P: paid → % invoice(s)', (select count(*) from public.invoices where customer_id = v_c); end if;
  select * into v_inv from public.invoices where customer_id = v_c;
  if v_inv.amount <> 327137 or v_inv.status::text <> 'paid' or jsonb_array_length(v_inv.line_items) <> 2 then
    raise exception 'FAIL P: invoice % amount % status %', v_inv.id, v_inv.amount, v_inv.status; end if;
  raise notice 'PASS P: paid → one tax invoice % ₹3,27,137', v_inv.id;
end $$;

-- ── M. the bodies ─────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from pg_proc
       where oid in (to_regprocedure('public.bill_subscription_instalment(uuid,boolean)'), to_regprocedure('public.bill_parts_together(uuid[])'))
         and prosrc like '%R-2865%' and prosrc like '%v_label := ''Payment for ''%' and prosrc not like '%''Advance payment for ''%') <> 2 then
    raise exception 'FAIL M: a part-request function still writes ''Advance payment for'' (or lost its R-2865 mark)'; end if;
  /* nothing newer was dropped: R-2527 login trust, R-2519b guard flag, R-2810 pool rule */
  if not exists (select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)')
                  and prosrc like '%R-2527%' and prosrc like '%app.r2519_write%' and prosrc like '%part_request_line_name%')
     or not exists (select 1 from pg_proc where oid = to_regprocedure('public.bill_parts_together(uuid[])')
                  and prosrc like '%R-2810%' and prosrc like '%billing_pool_subscriptions%') then
    raise exception 'FAIL M: a newer rule is missing from a body'; end if;
  raise notice 'PASS M';
end $$;

select 'R-2865 part label: ALL PASS' as result;

rollback;
