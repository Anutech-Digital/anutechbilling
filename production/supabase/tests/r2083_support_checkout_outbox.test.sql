-- R-2083 (29 Oct 2026): a support plan bought on /buy/support reaches the support desk.
--
-- POST /api/public/checkout/support writes a lead (buyer's email + state) and a quote whose
-- one line is { item_id: <the company's SUP-…-YR/MO catalogue row>, name, qty 1, rate,
-- commitment annual_yearly | monthly }. After payment, settleCapturedPayment calls
-- record_payment. This file proves, on the real functions and triggers:
--
--   1. yearly: record_payment files ONE subscription with vendor 'support' (read from the
--      line's item_id), plan = the line name, term 12, mrr 9996/12 = 833 — and
--      trg_queue_support_sync writes ONE support_sync_outbox row carrying the buyer's email
--      and that plan (what R-2067's cron sends to DSP);
--   2. a second record_payment with the same reference (verify + webhook) files nothing more:
--      still one subscription and one outbox row;
--   3. monthly: a monthly line on a billing_cycle 'monthly' quote → term 1, mrr 999, outbox row;
--   4. WHY the route links the item: the same line WITHOUT item_id is name-guessed to
--      vendor 'other' and the desk gets at most Free (R-2102) — the paid plan would never reach it.
--
-- SAFETY: synthetic tenant and rows, one transaction, ends in ROLLBACK.

begin;

select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

insert into public.tenants (id, name, email, doc_code, tier)
values ('20830000-0000-4000-8000-000000002083', 'ZZ R2083 SELLER', 'zz-r2083@example.invalid', 'ZZ283', 'distributor');

insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale, is_active, item_type, kind, prices, sku, term_months, fulfilment)
values
  ('SUP-STANDARD-YR-20830000000040008000000000002083', '20830000-0000-4000-8000-000000002083', 'Support Standard (Yearly)',
   'support', '998313', 0, 0, true, 'subscription', 'main', '{"annual_total":{"msrp":9996,"wholesale":0}}'::jsonb, 'SUP-STANDARD-YR', 12, 'support_panel'),
  ('SUP-STANDARD-MO-20830000000040008000000000002083', '20830000-0000-4000-8000-000000002083', 'Support Standard (Monthly)',
   'support', '998313', 999, 0, true, 'subscription', 'main', '{}'::jsonb, 'SUP-STANDARD-MO', 1, 'support_panel');

insert into public.leads (id, tenant_id, company, contact_name, contact_email, contact_phone, plan, seats, value, stage, source, state_code, state)
values
  ('L-ZZ2083Y', '20830000-0000-4000-8000-000000002083', 'ZZ Yearly Buyer', 'ZZ Yearly', 'zz-yearly-2083@example.invalid', '9876543210', 'support-standard', 1, 9996, 'quote', 'buy-support-direct', '07', 'Delhi'),
  ('L-ZZ2083M', '20830000-0000-4000-8000-000000002083', 'ZZ Monthly Buyer', 'ZZ Monthly', 'zz-monthly-2083@example.invalid', '9876543210', 'support-standard', 1, 999, 'quote', 'buy-support-direct', '27', 'Maharashtra'),
  ('L-ZZ2083N', '20830000-0000-4000-8000-000000002083', 'ZZ Unlinked Buyer', 'ZZ Unlinked', 'zz-unlinked-2083@example.invalid', '9876543210', 'support-standard', 1, 9996, 'quote', 'buy-support-direct', '07', 'Delhi');

insert into public.quotes (id, tenant_id, customer_id, customer_name, lead_id, plan, seats, amount, subtotal, tax_rate, status, payment_status, discount_pct, billing_cycle, line_items)
values
  ('ZZ-2083-YR', '20830000-0000-4000-8000-000000002083', null, 'ZZ Yearly Buyer', 'L-ZZ2083Y', 'support-standard', 1, 11795, 9996, 18, 'sent', 'awaiting', 0, 'yearly',
   '[{"id":"l1","item_id":"SUP-STANDARD-YR-20830000000040008000000000002083","name":"Support Standard (Yearly)","qty":1,"rate":9996,"cost":0,"commitment":"annual_yearly"}]'::jsonb),
  ('ZZ-2083-MO', '20830000-0000-4000-8000-000000002083', null, 'ZZ Monthly Buyer', 'L-ZZ2083M', 'support-standard', 1, 1179, 999, 18, 'sent', 'awaiting', 0, 'monthly',
   '[{"id":"l2","item_id":"SUP-STANDARD-MO-20830000000040008000000000002083","name":"Support Standard (Monthly)","qty":1,"rate":999,"cost":0,"commitment":"monthly"}]'::jsonb),
  ('ZZ-2083-NO', '20830000-0000-4000-8000-000000002083', null, 'ZZ Unlinked Buyer', 'L-ZZ2083N', 'support-standard', 1, 11795, 9996, 18, 'sent', 'awaiting', 0, 'yearly',
   '[{"id":"l3","name":"Support Standard (Yearly)","qty":1,"rate":9996,"cost":0,"commitment":"annual_yearly"}]'::jsonb);

do $$
declare
  s record;
  o record;
  n integer;
begin
  -- ── 1: yearly ───────────────────────────────────────────────────────────────
  perform public.record_payment('ZZ-2083-YR', 11795, 'razorpay', 'pay_ZZ2083YR');

  select count(*) into n from public.subscriptions where quote_id = 'ZZ-2083-YR';
  if n <> 1 then raise exception 'CASE 1 FAIL: % subscriptions for the paid yearly support quote, expected 1', n; end if;
  select * into s from public.subscriptions where quote_id = 'ZZ-2083-YR';
  if s.vendor::text <> 'support' then
    raise exception 'CASE 1 FAIL: vendor is "%" — the SUP item_id on the line must make it support', s.vendor;
  end if;
  if s.plan <> 'Support Standard (Yearly)' or s.term_months <> 12 or s.mrr <> 833 then
    raise exception 'CASE 1 FAIL: plan "%", term %, mrr % (expected Support Standard (Yearly), 12, 833)', s.plan, s.term_months, s.mrr;
  end if;

  select count(*) into n from public.support_sync_outbox where subscription_id = s.id;
  if n <> 1 then raise exception 'CASE 1 FAIL: % outbox rows for the new support subscription, expected 1', n; end if;
  select * into o from public.support_sync_outbox where subscription_id = s.id;
  if o.status <> 'pending'
     or o.payload->>'event_type' <> 'subscription.updated'
     or o.payload->'data'->>'email' <> 'zz-yearly-2083@example.invalid'
     or o.payload->'data'->>'plan' <> 'Support Standard (Yearly)'
     or o.payload->'data'->>'plan_status' <> 'active' then
    raise exception 'CASE 1 FAIL: outbox row is %/% — expected pending, the buyer''s email and the plan', o.status, o.payload;
  end if;

  -- ── 2: verify + webhook — the same payment again ───────────────────────────
  perform public.record_payment('ZZ-2083-YR', 11795, 'razorpay', 'pay_ZZ2083YR');
  select count(*) into n from public.subscriptions where quote_id = 'ZZ-2083-YR';
  if n <> 1 then raise exception 'CASE 2 FAIL: a repeated payment made % subscriptions', n; end if;
  select count(*) into n from public.support_sync_outbox o2
    join public.subscriptions s2 on s2.id = o2.subscription_id where s2.quote_id = 'ZZ-2083-YR';
  if n <> 1 then raise exception 'CASE 2 FAIL: a repeated payment queued % outbox rows', n; end if;
  select count(*) into n from public.payments where quote_id = 'ZZ-2083-YR' and status = 'received';
  if n <> 1 then raise exception 'CASE 2 FAIL: % payments recorded for one Razorpay payment', n; end if;

  -- ── 3: monthly ──────────────────────────────────────────────────────────────
  perform public.record_payment('ZZ-2083-MO', 1179, 'razorpay', 'pay_ZZ2083MO');
  select * into s from public.subscriptions where quote_id = 'ZZ-2083-MO';
  if s is null or s.vendor::text <> 'support' or s.term_months <> 1 or s.mrr <> 999 then
    raise exception 'CASE 3 FAIL: monthly subscription vendor %, term %, mrr % (expected support, 1, 999)', s.vendor, s.term_months, s.mrr;
  end if;
  if not exists (select 1 from public.support_sync_outbox where subscription_id = s.id
                  and payload->'data'->>'email' = 'zz-monthly-2083@example.invalid') then
    raise exception 'CASE 3 FAIL: no outbox row for the monthly support subscription';
  end if;

  -- ── 4: the same line with no item_id never reaches the desk ─────────────────
  perform public.record_payment('ZZ-2083-NO', 11795, 'razorpay', 'pay_ZZ2083NO');
  select * into s from public.subscriptions where quote_id = 'ZZ-2083-NO';
  if s is null or s.vendor::text = 'support' then
    raise exception 'CASE 4 FAIL: expected a non-support subscription for the unlinked line, got %', s.vendor;
  end if;
  -- R-2102: every buyer now gets Free on the desk, so a row may be queued — but never a paid plan.
  if exists (select 1 from public.support_sync_outbox where subscription_id = s.id
              and payload->'data'->>'plan_key' is distinct from 'free') then
    raise exception 'CASE 4 FAIL: an unlinked line queued a PAID plan for the desk — this case no longer shows why the route links the item';
  end if;

  raise notice 'R-2083 support checkout → subscription → outbox: all 4 cases pass';
end $$;

rollback;
