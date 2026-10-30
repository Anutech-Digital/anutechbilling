-- R-2165 (30 Oct 2026, G-ADS-AI AI-09): Neo's allowlisted read-only metrics query.
-- Migration 20261030120849_r2165_marketing_metrics_query.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves, on one seeded company (range 1–7 Oct 2026, to = 8 Oct exclusive):
--   A. Owner: totals equal the "Sales by campaign" rules (R-1980) — spend = platform rows
--      (matched by utm code AND by campaign name) + booked non-platform cost, a booked
--      platform invoice dropped when platform rows exist; revenue ex GST; a refund nets out;
--      the quote's own invoice gives the taxable share; ROAS counts
--      only campaign money; CAC = spend ÷ campaign-paid orders.
--   B. Dimensions: by campaign, by day, by platform, by ad (top ads), filters.
--   C. Tenant isolation: the other company's spend and payments (same utm code) never count.
--   D. Marketing role: spend yes, money NULL + revenue_visible false.
--   E. Manager, sales, deactivated owner and anon are refused.
--   F. The allowlist: unknown metric / dimension, injection text, bad combos, range,
--      sort, limit — all refused with 22023; the function cannot write (STABLE, invoker).

begin;

do $$ begin
  if to_regprocedure('public.marketing_metrics_query(text[],text[],date,date,text,text,text,boolean,integer)') is null then
    raise exception 'FAIL 0: public.marketing_metrics_query does not exist (migration 20261030120849 not applied)';
  end if;
end $$;

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
  ('dddddddd-0000-0000-0000-000000216501','R2165 Co','r2165@example.in','07','R2165'),
  ('dddddddd-0000-0000-0000-000000216502','R2165 Other','r2165b@example.in','07','R2165B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000216501','owner2165@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216502','mkt2165@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216503','mgr2165@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216504','sales2165@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216505','owner2165b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216506','exowner2165@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000216501','dddddddd-0000-0000-0000-000000216501','owner2165@example.in','Owner 2165','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000216502','dddddddd-0000-0000-0000-000000216501','mkt2165@example.in','Mkt 2165','marketing', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000216503','dddddddd-0000-0000-0000-000000216501','mgr2165@example.in','Mgr 2165','manager', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000216504','dddddddd-0000-0000-0000-000000216501','sales2165@example.in','Sales 2165','sales', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000216505','dddddddd-0000-0000-0000-000000216502','owner2165b@example.in','Owner 2165B','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000216506','dddddddd-0000-0000-0000-000000216501','exowner2165@example.in','Ex 2165','owner', false, now() - interval '1 day');

-- ── seed (as the server) ────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.marketing_campaigns (id, tenant_id, name, code, start_date, end_date) values
  ('cccccccc-0000-0000-0000-000000216501','dddddddd-0000-0000-0000-000000216501','Workspace Delhi','gw-delhi','2026-10-01','2026-10-31'),
  ('cccccccc-0000-0000-0000-000000216502','dddddddd-0000-0000-0000-000000216501','M365 Promo','m365','2026-10-01','2026-10-31'),
  ('cccccccc-0000-0000-0000-000000216503','dddddddd-0000-0000-0000-000000216502','Other GW','gw-delhi','2026-10-01','2026-10-31');
insert into public.ad_accounts (id, tenant_id, platform, account_id, name) values
  ('bbbbbbbb-0000-0000-0000-000000216501','dddddddd-0000-0000-0000-000000216501','meta-ads','act_2165','Meta 2165'),
  ('bbbbbbbb-0000-0000-0000-000000216502','dddddddd-0000-0000-0000-000000216501','google-ads','g_2165','Google 2165'),
  ('bbbbbbbb-0000-0000-0000-000000216503','dddddddd-0000-0000-0000-000000216502','meta-ads','act_2165b','Meta 2165B');
insert into public.ad_spend_daily (tenant_id, ad_account_id, day, campaign_id, campaign_name, spend, clicks, impressions) values
  -- matched by utm code (campaign name = code)
  ('dddddddd-0000-0000-0000-000000216501','bbbbbbbb-0000-0000-0000-000000216501','2026-10-02','111','gw-delhi', 1000, 100, 10000),
  -- matched by campaign NAME
  ('dddddddd-0000-0000-0000-000000216501','bbbbbbbb-0000-0000-0000-000000216502','2026-10-03','g-22','M365 Promo', 500, 50, 5000),
  -- outside the range
  ('dddddddd-0000-0000-0000-000000216501','bbbbbbbb-0000-0000-0000-000000216501','2026-09-30','111','gw-delhi', 9999, 999, 99999),
  -- the other company, same code
  ('dddddddd-0000-0000-0000-000000216502','bbbbbbbb-0000-0000-0000-000000216503','2026-10-02','999','gw-delhi', 7777, 777, 77777);
insert into public.expenses (id, tenant_id, category, expense_date, amount, channel, campaign_id) values
  -- Meta's own invoice for gw-delhi: the platform rows exist, so this is the same money again → dropped
  ('EXP-R2165-1','dddddddd-0000-0000-0000-000000216501','marketing','2026-10-04', 1180, 'meta-ads', 'cccccccc-0000-0000-0000-000000216501'),
  -- design cost booked against m365 → counted
  ('EXP-R2165-2','dddddddd-0000-0000-0000-000000216501','marketing','2026-10-04', 200, 'design', 'cccccccc-0000-0000-0000-000000216502'),
  ('EXP-R2165-3','dddddddd-0000-0000-0000-000000216502','marketing','2026-10-04', 5555, 'design', 'cccccccc-0000-0000-0000-000000216503');
insert into public.customers (id, tenant_id, name) values
  ('cccccccc-0000-0000-0000-0000002165c1','dddddddd-0000-0000-0000-000000216501','Buyer 2165'),
  ('cccccccc-0000-0000-0000-0000002165c2','dddddddd-0000-0000-0000-000000216502','Buyer 2165B');
insert into public.leads (id, tenant_id, company, utm_campaign, utm_content, created_at) values
  ('L-R2165-1','dddddddd-0000-0000-0000-000000216501','Lead One','GW-Delhi','ad-a','2026-10-02T06:00:00Z'),
  ('L-R2165-2','dddddddd-0000-0000-0000-000000216501','Lead Two','m365','ad-b','2026-10-03T06:00:00Z'),
  ('L-R2165-3','dddddddd-0000-0000-0000-000000216501','Lead Three', null, null,'2026-10-05T06:00:00Z'),
  ('L-R2165-9','dddddddd-0000-0000-0000-000000216502','Lead Other','gw-delhi','ad-a','2026-10-02T06:00:00Z');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, lead_id) values
  ('Q-R2165-1','dddddddd-0000-0000-0000-000000216501','cccccccc-0000-0000-0000-0000002165c1','Buyer 2165', 11800, 10000, 18, 'accepted','L-R2165-1'),
  ('Q-R2165-2','dddddddd-0000-0000-0000-000000216501','cccccccc-0000-0000-0000-0000002165c1','Buyer 2165',  5900,  5000, 18, 'accepted','L-R2165-2'),
  ('Q-R2165-3','dddddddd-0000-0000-0000-000000216501','cccccccc-0000-0000-0000-0000002165c1','Buyer 2165',  2360,  2000, 18, 'accepted', null),
  ('Q-R2165-9','dddddddd-0000-0000-0000-000000216502','cccccccc-0000-0000-0000-0000002165c2','Buyer 2165B', 118000, 100000, 18, 'accepted','L-R2165-9');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, taxable_value, quote_id) values
  ('INV-R2165-1','dddddddd-0000-0000-0000-000000216501','cccccccc-0000-0000-0000-0000002165c1','Buyer 2165', 11800, 10000, 'Q-R2165-1');
update public.quotes set invoice_id = 'INV-R2165-1' where id = 'Q-R2165-1';
insert into public.payments (id, tenant_id, customer_id, quote_id, invoice_id, amount, method, status, received_at, refunded_at) values
  -- gw-delhi: 11800 on the quote whose invoice has taxable 10000 → 10000
  ('77777777-0000-0000-0000-000000216501','dddddddd-0000-0000-0000-000000216501','cccccccc-0000-0000-0000-0000002165c1','Q-R2165-1', null, 11800,'upi','received','2026-10-03T06:00:00Z', null),
  -- m365: 5900 received 4 Oct, refunded 6 Oct → nets 0, not a paid order
  ('77777777-0000-0000-0000-000000216502','dddddddd-0000-0000-0000-000000216501','cccccccc-0000-0000-0000-0000002165c1','Q-R2165-2', null, 5900,'upi','refunded','2026-10-04T06:00:00Z','2026-10-06T06:00:00Z'),
  -- no campaign: 2360 → 2000
  ('77777777-0000-0000-0000-000000216503','dddddddd-0000-0000-0000-000000216501','cccccccc-0000-0000-0000-0000002165c1','Q-R2165-3', null, 2360,'upi','received','2026-10-05T06:00:00Z', null),
  -- the other company
  ('77777777-0000-0000-0000-000000216509','dddddddd-0000-0000-0000-000000216502','cccccccc-0000-0000-0000-0000002165c2','Q-R2165-9', null, 118000,'upi','received','2026-10-03T06:00:00Z', null);

-- ── A. OWNER: the totals ────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000216501","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r jsonb; t jsonb;
begin
  r := public.marketing_metrics_query(array['spend','revenue','roas','cac','paid_orders','leads'], '{}', '2026-10-01', '2026-10-08');
  t := r -> 'total';
  if (r ->> 'revenue_visible')::boolean is not true then raise exception 'FAIL A0: owner revenue_visible = %', r ->> 'revenue_visible'; end if;
  -- 1000 (meta, by code) + 500 (google, by name) + 200 (design cost); Meta's booked invoice dropped; 30 Sep out of range
  if (t ->> 'spend')::numeric <> 1700 then raise exception 'FAIL A1: spend % (want 1700)', t ->> 'spend'; end if;
  -- 10000 + (5000 − 5000) + 2000
  if (t ->> 'revenue')::numeric <> 12000 then raise exception 'FAIL A2: revenue % (want 12000)', t ->> 'revenue'; end if;
  -- campaign money only: 10000 / 1700
  if (t ->> 'roas')::numeric <> 5.88 then raise exception 'FAIL A3: roas % (want 5.88)', t ->> 'roas'; end if;
  -- paid orders: lead L1 and quote Q3 (L2 refunded to 0); campaign-paid = 1 → CAC 1700
  if (t ->> 'paid_orders')::int <> 2 then raise exception 'FAIL A4: paid_orders % (want 2)', t ->> 'paid_orders'; end if;
  if (t ->> 'cac')::numeric <> 1700 then raise exception 'FAIL A5: cac % (want 1700)', t ->> 'cac'; end if;
  if (t ->> 'leads')::int <> 3 then raise exception 'FAIL A6: leads % (want 3)', t ->> 'leads'; end if;
  if jsonb_array_length(r -> 'rows') <> 1 then raise exception 'FAIL A7: no dimension must give one row, got %', r -> 'rows'; end if;
  raise notice 'PASS A: owner totals follow the Sales-by-campaign rules';
end $$;

-- ── B. Dimensions and filters ───────────────────────────────────────────────
do $$
declare r jsonb; x jsonb;
begin
  -- by campaign, sorted by revenue
  r := public.marketing_metrics_query(array['spend','revenue','roas','leads'], array['campaign'], '2026-10-01', '2026-10-08', null, null, 'revenue', true, 10);
  x := r -> 'rows' -> 0;
  if x ->> 'campaign' <> 'gw-delhi' or x ->> 'campaign_name' <> 'Workspace Delhi' or (x ->> 'spend')::numeric <> 1000
     or (x ->> 'revenue')::numeric <> 10000 or (x ->> 'roas')::numeric <> 10 or (x ->> 'leads')::int <> 1 then
    raise exception 'FAIL B1: gw-delhi row %', x; end if;
  x := (select e from jsonb_array_elements(r -> 'rows') e where e ->> 'campaign' = 'm365');
  if (x ->> 'spend')::numeric <> 700 or (x ->> 'revenue')::numeric <> 0 or (x ->> 'roas')::numeric <> 0 then
    raise exception 'FAIL B2: m365 row %', x; end if;
  x := (select e from jsonb_array_elements(r -> 'rows') e where e ->> 'campaign' = '__none__');
  if x ->> 'campaign_name' <> 'Not from an ad campaign' or (x ->> 'revenue')::numeric <> 2000 or x -> 'roas' <> 'null'::jsonb then
    raise exception 'FAIL B3: no-campaign row %', x; end if;
  if (r -> 'total' ->> 'spend')::numeric <> 1700 then raise exception 'FAIL B4: total with dimension %', r -> 'total'; end if;

  -- by day: oldest first
  r := public.marketing_metrics_query(array['spend'], array['day'], '2026-10-01', '2026-10-08');
  if r -> 'rows' -> 0 ->> 'day' <> '2026-10-02' or (r -> 'rows' -> 0 ->> 'spend')::numeric <> 1000
     or r -> 'rows' -> 2 ->> 'day' <> '2026-10-04' or (r -> 'rows' -> 2 ->> 'spend')::numeric <> 200 then
    raise exception 'FAIL B5: by day %', r -> 'rows'; end if;

  -- by platform: meta 1000, google 500, booked cost (no platform) 200
  r := public.marketing_metrics_query(array['spend','clicks','ctr','cpc'], array['platform'], '2026-10-01', '2026-10-08');
  x := (select e from jsonb_array_elements(r -> 'rows') e where e ->> 'platform' = 'meta-ads');
  if (x ->> 'spend')::numeric <> 1000 or (x ->> 'clicks')::int <> 100 or (x ->> 'ctr')::numeric <> 1 or (x ->> 'cpc')::numeric <> 10 then
    raise exception 'FAIL B6: meta row %', x; end if;
  if jsonb_array_length(r -> 'rows') <> 3 then raise exception 'FAIL B7: platform rows %', r -> 'rows'; end if;

  -- platform filter
  r := public.marketing_metrics_query(array['spend'], '{}', '2026-10-01', '2026-10-08', null, 'google-ads');
  if (r -> 'total' ->> 'spend')::numeric <> 500 then raise exception 'FAIL B8: google filter %', r -> 'total'; end if;

  -- campaign filter by NAME and by code
  r := public.marketing_metrics_query(array['spend','revenue'], '{}', '2026-10-01', '2026-10-08', 'Workspace Delhi');
  if (r -> 'total' ->> 'spend')::numeric <> 1000 or (r -> 'total' ->> 'revenue')::numeric <> 10000 then
    raise exception 'FAIL B9: campaign filter by name %', r -> 'total'; end if;
  r := public.marketing_metrics_query(array['spend'], '{}', '2026-10-01', '2026-10-08', 'M365');
  if (r -> 'total' ->> 'spend')::numeric <> 700 then raise exception 'FAIL B10: campaign filter by code %', r -> 'total'; end if;

  -- top ads by revenue, limit 2 → ad-a (10000), then the no-ad orders (2000)
  r := public.marketing_metrics_query(array['revenue','paid_orders'], array['ad'], '2026-10-01', '2026-10-08', null, null, 'revenue', true, 2);
  if r -> 'rows' -> 0 ->> 'ad' <> 'ad-a' or (r -> 'rows' -> 0 ->> 'revenue')::numeric <> 10000
     or (r -> 'rows' -> 1 ->> 'revenue')::numeric <> 2000 or (r ->> 'truncated')::boolean is not true then
    raise exception 'FAIL B11: top ads %', r; end if;
  raise notice 'PASS B: campaign / day / platform / ad dimensions and filters';
end $$;

-- ── C. The other company's numbers never count (its owner sees only its own) ─
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000216505","role":"authenticated"}', true);
do $$
declare r jsonb;
begin
  r := public.marketing_metrics_query(array['spend','revenue','leads'], '{}', '2026-10-01', '2026-10-08');
  if (r -> 'total' ->> 'spend')::numeric <> 7777 + 5555 or (r -> 'total' ->> 'revenue')::numeric <> 100000
     or (r -> 'total' ->> 'leads')::int <> 1 then
    raise exception 'FAIL C: other owner sees %', r -> 'total'; end if;
  raise notice 'PASS C: each company sees only its own numbers';
end $$;

-- ── D. MARKETING: spend yes, money hidden (payments RLS) ────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000216502","role":"authenticated"}', true);
do $$
declare r jsonb;
begin
  r := public.marketing_metrics_query(array['spend','revenue','roas'], array['campaign'], '2026-10-01', '2026-10-08');
  if (r ->> 'revenue_visible')::boolean is not false then raise exception 'FAIL D1: marketing revenue_visible %', r ->> 'revenue_visible'; end if;
  if (r -> 'total' ->> 'spend')::numeric <> 1700 then raise exception 'FAIL D2: marketing spend %', r -> 'total'; end if;
  if r -> 'total' -> 'revenue' <> 'null'::jsonb or r -> 'total' -> 'roas' <> 'null'::jsonb then
    raise exception 'FAIL D3: marketing sees money %', r -> 'total'; end if;
  raise notice 'PASS D: marketing gets spend, money comes back hidden';
end $$;

-- ── E. Refused: manager, sales, deactivated owner, anon ────────────────────
do $$
declare u text;
begin
  foreach u in array array['aaaaaaaa-0000-0000-0000-000000216503','aaaaaaaa-0000-0000-0000-000000216504','aaaaaaaa-0000-0000-0000-000000216506'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    begin
      perform public.marketing_metrics_query(array['spend'], '{}', '2026-10-01', '2026-10-08');
      raise exception 'FAIL E1: % was allowed', u;
    exception when insufficient_privilege then null;
    end;
  end loop;
  raise notice 'PASS E1: manager, sales and a deactivated owner are refused';
end $$;
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  begin
    perform public.marketing_metrics_query(array['spend'], '{}', '2026-10-01', '2026-10-08');
    raise exception 'FAIL E2: anon ran it';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS E2: anon cannot run it';
end $$;
reset role;

-- ── F. The allowlist ────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000216501","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  bad record;
  n int := 0;
begin
  for bad in
    select * from (values
      (array['secret_column'], '{}'::text[], date '2026-10-01', date '2026-10-08', null::text, null::text, null::text, 50),
      (array['spend; drop table payments'], '{}', '2026-10-01', '2026-10-08', null, null, null, 50),
      (array['spend'], array['customer'], '2026-10-01', '2026-10-08', null, null, null, 50),
      (array['spend'], array['day','month'], '2026-10-01', '2026-10-08', null, null, null, 50),
      (array['spend'], array['campaign','platform','day'], '2026-10-01', '2026-10-08', null, null, null, 50),
      (array['spend'], array['ad'], '2026-10-01', '2026-10-08', null, null, null, 50),
      (array['revenue'], array['platform'], '2026-10-01', '2026-10-08', null, null, null, 50),
      (array['roas'], '{}', '2026-10-01', '2026-10-08', null, 'meta-ads', null, 50),
      (array['spend'], '{}', '2026-10-01', '2026-10-08', null, 'tiktok', null, 50),
      (array['spend'], '{}', '2025-01-01', '2026-10-08', null, null, null, 50),
      (array['spend'], '{}', '2026-10-08', '2026-10-01', null, null, null, 50),
      (array['spend'], '{}', '2026-10-01', '2026-10-08', null, null, 'revenue', 50),
      (array['spend'], '{}', '2026-10-01', '2026-10-08', null, null, null, 500),
      (array['spend','spend'], '{}', '2026-10-01', '2026-10-08', null, null, null, 50),
      ('{}'::text[], '{}', '2026-10-01', '2026-10-08', null, null, null, 50)
    ) v(m, d, f, t, c, p, s, l)
  loop
    begin
      perform public.marketing_metrics_query(bad.m, bad.d, bad.f, bad.t, bad.c, bad.p, bad.s, true, bad.l);
      raise exception 'FAIL F1: accepted metrics % dims % platform % sort % limit %', bad.m, bad.d, bad.p, bad.s, bad.l;
    exception when invalid_parameter_value then n := n + 1;
    end;
  end loop;
  if n <> 15 then raise exception 'FAIL F2: % of 15 bad plans refused', n; end if;

  if (select provolatile from pg_proc where proname = 'marketing_metrics_query') <> 's'
     or (select prosecdef from pg_proc where proname = 'marketing_metrics_query') then
    raise exception 'FAIL F3: must be STABLE and SECURITY INVOKER'; end if;
  raise notice 'PASS F: unknown names, bad combos, ranges and limits are refused; STABLE + invoker';
  raise notice 'r2165_marketing_metrics_query: all checks passed';
end $$;

rollback;
