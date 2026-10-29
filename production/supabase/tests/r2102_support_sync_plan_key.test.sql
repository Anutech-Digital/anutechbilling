-- R-2102 (29 Oct 2026) — the support desk gets the plan by KEY, and every buyer gets Free.
--
-- Migration 20261029124808_r2102_support_sync_plan_key.
--
-- CASES (self-asserting; every one raises on failure)
--   1. support_plan_key: SKU first; add-on SKU = standard; name fallback without a Free guess.
--   2. A support plan whose seller name says "Standard" but whose SKU is Enterprise →
--      plan_key 'enterprise' (the name alone would have read Standard).
--   3. A customer with no support buys Google Workspace Business Standard → ONE row,
--      plan 'free', plan_key 'free' (never Standard paid support).
--   4. Workspace Enterprise for another customer → plan_key 'free' (never Enterprise).
--   5. The paid Enterprise customer buys Microsoft 365 Business Standard → NO row
--      (a licence never downgrades paid support).
--   6. ... and cancels it → NO row.
--   7. A licence's renewal date moves → NO row.
--   8. Enterprise customer adds a Standard support plan → row says enterprise (the best).
--   9. Enterprise cancelled, Standard still live → row says standard.
--  10. Standard cancelled too → row says free.
--  11. The Workspace-only customer cancels the licence → NO row (keeps Free).
--  12. An archived customer's new licence → NO row.
--  13. Archiving the Enterprise customer → plan_key 'free' on the archive row.
--
-- SAFETY: synthetic tenant and rows, one transaction, ends in ROLLBACK.

begin;

select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

insert into public.tenants (id, name, email, doc_code, tier) values
  ('21020000-0000-4000-8000-0000000000a1', 'ZZ R2102 Standard Traders', 'zz-r2102@example.invalid', 'ZZ2102', 'reseller');

insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale, is_active, item_type, kind, prices, sku, term_months, fulfilment)
values
  ('SUP-ENTERPRISE-MO-21020000000040008000000000000a1', '21020000-0000-4000-8000-0000000000a1', 'Support Enterprise (Monthly)',
   'support', '998313', 4999, 0, true, 'subscription', 'main', '{}'::jsonb, 'SUP-ENTERPRISE-MO', 1, 'support_panel'),
  ('SUP-STANDARD-YR-21020000000040008000000000000a1', '21020000-0000-4000-8000-0000000000a1', 'Support Standard (Yearly)',
   'support', '998313', 0, 0, true, 'subscription', 'main', '{"annual_total":{"msrp":9996,"wholesale":0}}'::jsonb, 'SUP-STANDARD-YR', 12, 'support_panel');

insert into public.customers (id, tenant_id, name, contact_email, is_active) values
  ('21020000-0000-4000-8000-0000000000c1', '21020000-0000-4000-8000-0000000000a1', 'ZZ R2102 Paid', 'paid@r2102.invalid', true),
  ('21020000-0000-4000-8000-0000000000c2', '21020000-0000-4000-8000-0000000000a1', 'ZZ R2102 Licence', 'licence@r2102.invalid', true),
  ('21020000-0000-4000-8000-0000000000c3', '21020000-0000-4000-8000-0000000000a1', 'ZZ R2102 Ent Licence', 'entlic@r2102.invalid', true),
  ('21020000-0000-4000-8000-0000000000c4', '21020000-0000-4000-8000-0000000000a1', 'ZZ R2102 Archived', 'archived@r2102.invalid', false);

do $$
declare
  v_t  uuid := '21020000-0000-4000-8000-0000000000a1';
  v_c1 uuid := '21020000-0000-4000-8000-0000000000c1';
  v_c2 uuid := '21020000-0000-4000-8000-0000000000c2';
  v_c3 uuid := '21020000-0000-4000-8000-0000000000c3';
  v_c4 uuid := '21020000-0000-4000-8000-0000000000c4';
  o    record;
  n    integer;
  before integer;
begin
  -- ── 1 ─────────────────────────────────────────────────────────────────────
  if public.support_plan_key('SUP-ENTERPRISE-MO-abc', 'X Standard Support') <> 'enterprise' then raise exception 'CASE 1 FAIL: SKU must win over the name'; end if;
  if public.support_plan_key('sup-standard-yr', null) <> 'standard' then raise exception 'CASE 1 FAIL: lower-case SKU'; end if;
  if public.support_plan_key('SUP-GWS-STARTER-YR', 'Starter Support') <> 'standard' then raise exception 'CASE 1 FAIL: add-on SKU is standard'; end if;
  if public.support_plan_key(null, 'Support Enterprise (Yearly)') <> 'enterprise' then raise exception 'CASE 1 FAIL: name fallback'; end if;
  if public.support_plan_key(null, 'Something else') is not null then raise exception 'CASE 1 FAIL: unknown must be null, not Free'; end if;

  -- ── 2 ─────────────────────────────────────────────────────────────────────
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, start_date, renewal_date)
  values ('21020000-0000-4000-8000-0000000000d1', v_t, v_c1, 'ZZ R2102 Paid', 'ZZ R2102 Standard Traders Enterprise Support',
          'support', 'SUP-ENTERPRISE-MO-21020000000040008000000000000a1', 1, 4999, 'active', current_date, (current_date + interval '1 month')::date);
  select count(*) into n from public.support_sync_outbox where customer_id = v_c1;
  if n <> 1 then raise exception 'CASE 2 FAIL: % rows, expected 1', n; end if;
  select * into o from public.support_sync_outbox where customer_id = v_c1;
  if o.payload->'data'->>'plan_key' is distinct from 'enterprise'
     or o.payload->'data'->>'sku' is distinct from 'SUP-ENTERPRISE-MO-21020000000040008000000000000a1'
     or o.payload->'data'->>'plan' is distinct from 'ZZ R2102 Standard Traders Enterprise Support'
     or o.payload->'data'->>'plan_status' is distinct from 'active' then
    raise exception 'CASE 2 FAIL: payload %', o.payload;
  end if;

  -- ── 3 ─────────────────────────────────────────────────────────────────────
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date)
  values ('21020000-0000-4000-8000-0000000000e1', v_t, v_c2, 'ZZ R2102 Licence', 'Google Workspace Business Standard',
          'google', 5, 4000, 'active', current_date, (current_date + interval '1 year')::date);
  select count(*) into n from public.support_sync_outbox where customer_id = v_c2;
  if n <> 1 then raise exception 'CASE 3 FAIL: % rows for a Workspace buyer, expected 1', n; end if;
  select * into o from public.support_sync_outbox where customer_id = v_c2;
  if o.payload->'data'->>'plan_key' is distinct from 'free' or o.payload->'data'->>'plan' is distinct from 'free'
     or o.payload->'data'->>'email' is distinct from 'licence@r2102.invalid'
     or o.payload->'data'->>'plan_status' is distinct from 'active' then
    raise exception 'CASE 3 FAIL: payload % — a licence must give Free, never paid support', o.payload;
  end if;

  -- ── 4 ─────────────────────────────────────────────────────────────────────
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status)
  values ('21020000-0000-4000-8000-0000000000e3', v_t, v_c3, 'ZZ R2102 Ent Licence', 'Google Workspace Enterprise Plus', 'google', 5, 9000, 'active');
  select * into o from public.support_sync_outbox where customer_id = v_c3;
  if o.payload->'data'->>'plan_key' is distinct from 'free' then raise exception 'CASE 4 FAIL: payload %', o.payload; end if;

  -- ── 5 ─────────────────────────────────────────────────────────────────────
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status)
  values ('21020000-0000-4000-8000-0000000000e2', v_t, v_c1, 'ZZ R2102 Paid', 'Microsoft 365 Business Standard', 'microsoft', 3, 2000, 'active');
  select count(*) into n from public.support_sync_outbox where customer_id = v_c1;
  if n <> 1 then raise exception 'CASE 5 FAIL: % rows — a licence must not touch a paid support customer', n; end if;

  -- ── 6 ─────────────────────────────────────────────────────────────────────
  update public.subscriptions set status = 'cancelled' where id = '21020000-0000-4000-8000-0000000000e2';
  select count(*) into n from public.support_sync_outbox where customer_id = v_c1;
  if n <> 1 then raise exception 'CASE 6 FAIL: % rows — cancelling a licence must not downgrade paid support', n; end if;

  -- ── 7 ─────────────────────────────────────────────────────────────────────
  update public.subscriptions set renewal_date = renewal_date + 30 where id = '21020000-0000-4000-8000-0000000000e1';
  select count(*) into n from public.support_sync_outbox where customer_id = v_c2;
  if n <> 1 then raise exception 'CASE 7 FAIL: % rows — a licence renewal-date move must send nothing', n; end if;

  -- ── 8 ─────────────────────────────────────────────────────────────────────
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, start_date, renewal_date)
  values ('21020000-0000-4000-8000-0000000000d2', v_t, v_c1, 'ZZ R2102 Paid', 'ZZ R2102 Standard Traders Standard Support (Yearly)',
          'support', 'SUP-STANDARD-YR-21020000000040008000000000000a1', 1, 833, 'active', current_date, (current_date + interval '1 year')::date);
  select * into o from public.support_sync_outbox where customer_id = v_c1 order by created_at desc, id desc limit 1;
  select count(*) into n from public.support_sync_outbox where customer_id = v_c1;
  if n <> 2 or o.payload->'data'->>'plan_key' is distinct from 'enterprise' then
    raise exception 'CASE 8 FAIL: % rows, last %', n, o.payload;
  end if;

  -- ── 9 ─────────────────────────────────────────────────────────────────────
  update public.subscriptions set status = 'cancelled' where id = '21020000-0000-4000-8000-0000000000d1';
  select count(*) into n from public.support_sync_outbox where customer_id = v_c1;
  select * into o from public.support_sync_outbox where customer_id = v_c1
     and payload->'data'->>'plan_key' = 'standard';
  if n <> 3 or o.id is null or o.payload->'data'->>'sku' not like 'SUP-STANDARD-YR-%' then
    raise exception 'CASE 9 FAIL: % rows; expected a standard row after Enterprise was cancelled', n;
  end if;

  -- ── 10 ────────────────────────────────────────────────────────────────────
  update public.subscriptions set status = 'cancelled' where id = '21020000-0000-4000-8000-0000000000d2';
  select count(*) into n from public.support_sync_outbox where customer_id = v_c1;
  select * into o from public.support_sync_outbox where customer_id = v_c1
     and payload->'data'->>'plan_key' = 'free' and payload->'data'->>'plan_status' = 'cancelled';
  if n <> 4 or o.id is null then raise exception 'CASE 10 FAIL: % rows; expected a free row', n; end if;

  -- ── 11 ────────────────────────────────────────────────────────────────────
  update public.subscriptions set status = 'cancelled' where id = '21020000-0000-4000-8000-0000000000e1';
  select count(*) into n from public.support_sync_outbox where customer_id = v_c2;
  if n <> 1 then raise exception 'CASE 11 FAIL: % rows — cancelling a licence sends nothing', n; end if;

  -- ── 12 ────────────────────────────────────────────────────────────────────
  insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status)
  values (v_t, v_c4, 'ZZ R2102 Archived', 'Web Hosting', 'hosting', 1, 300, 'active');
  select count(*) into n from public.support_sync_outbox where customer_id = v_c4;
  if n <> 0 then raise exception 'CASE 12 FAIL: % rows for an archived customer', n; end if;

  -- ── 13 ────────────────────────────────────────────────────────────────────
  select count(*) into before from public.support_sync_outbox where customer_id = v_c1;
  update public.customers set is_active = false where id = v_c1;
  select count(*) into n from public.support_sync_outbox where customer_id = v_c1
     and payload->'data'->>'plan_key' = 'free' and payload->'data'->>'plan_status' = 'cancelled';
  if (select count(*) from public.support_sync_outbox where customer_id = v_c1) <> before + 2 or n < 2 then
    raise exception 'CASE 13 FAIL: archive rows must carry plan_key free';
  end if;
end $$;

select 'PASS' as result;

rollback;
