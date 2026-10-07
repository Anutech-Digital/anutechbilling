-- R-378 (7 Oct 2026): subscriptions filed by record_payment / activate_quote_on_credit carry
-- the quote line's cost as vendor_cost_per_seat_month. Migration
-- 20261007140000_subscription_vendor_cost_from_line (on top of 20261007073000 + 20261007123000).
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only:
--   begin; \i 20261007123000_credit_annual_block_udyam.sql; \i 20261007140000_subscription_vendor_cost_from_line.sql;
--          \i subscription_vendor_cost_from_line.test.sql; rollback;
--
-- Proves:
--   A. record_payment, annual line cost 1320/seat/yr → 110/month (Q-FBB9-27-0010 shape).
--   B. record_payment, monthly line cost 120/seat/month → 120 (as is).
--   C. record_payment, line with no cost / cost 0 → NULL (unknown, never 0).
--   D. record_payment, bulk line cost 1260/yr → 105 on every per-domain subscription.
--   E. activate_quote_on_credit (owner, annual with reason) → 110 too; monthly line → as is.

-- R-380: own begin/rollback so scripts/test-sql.mjs (CI) runs it after the migrations are applied.
begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000037801','R378 Co','r378@example.in','07','R378A');
insert into public.customers (id, tenant_id, name, state_code, domain)
  values ('cccccccc-0000-0000-0000-000000037801','dddddddd-0000-0000-0000-000000037801','Acme 378','07','acme378.in');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
  values
  ('Q-R378-A','dddddddd-0000-0000-0000-000000037801','cccccccc-0000-0000-0000-000000037801','Acme 378',
   38232, 32400, 0, 18, 'sent', 'awaiting',
   '[{"name":"Google Workspace Business Starter","qty":10,"rate":3240,"cost":1320,"commitment":"annual_yearly","domain":"a.acme378.in"}]'::jsonb),
  ('Q-R378-B','dddddddd-0000-0000-0000-000000037801','cccccccc-0000-0000-0000-000000037801','Acme 378',
   3186, 2700, 0, 18, 'sent', 'awaiting',
   '[{"name":"Google Workspace Business Starter (flex)","qty":10,"rate":270,"cost":120,"commitment":"monthly","domain":"b.acme378.in"}]'::jsonb),
  ('Q-R378-C','dddddddd-0000-0000-0000-000000037801','cccccccc-0000-0000-0000-000000037801','Acme 378',
   2360, 2000, 0, 18, 'sent', 'awaiting',
   '[{"name":"Custom support","qty":1,"rate":1000,"commitment":"annual_yearly","domain":"c1.acme378.in"},
     {"name":"Other plan","qty":1,"rate":1000,"cost":0,"commitment":"annual_yearly","domain":"c2.acme378.in"}]'::jsonb),
  ('Q-R378-D','dddddddd-0000-0000-0000-000000037801','cccccccc-0000-0000-0000-000000037801','Acme 378',
   38232, 32400, 0, 18, 'sent', 'awaiting',
   '[{"name":"Google Workspace Business Starter","qty":10,"rate":3240,"cost":1260,"commitment":"annual_yearly","bulk":true,
      "domains":[{"domain":"d1.acme378.in","seats":4},{"domain":"d2.acme378.in","seats":6}]}]'::jsonb);

do $$
declare v int; n int;
begin
  perform public.record_payment('Q-R378-A', 38232, 'upi', 'r378_a_ref');
  select vendor_cost_per_seat_month into v from public.subscriptions where quote_id = 'Q-R378-A';
  if v is distinct from 110 then raise exception 'FAIL A: annual cost 1320/yr should be 110/month, got %', v; end if;
  raise notice 'PASS A: annual line cost 1320/yr -> 110/month';

  perform public.record_payment('Q-R378-B', 3186, 'upi', 'r378_b_ref');
  select vendor_cost_per_seat_month into v from public.subscriptions where quote_id = 'Q-R378-B';
  if v is distinct from 120 then raise exception 'FAIL B: monthly cost 120 should stay 120, got %', v; end if;
  raise notice 'PASS B: monthly line cost kept as is';

  perform public.record_payment('Q-R378-C', 2360, 'upi', 'r378_c_ref');
  select count(*) into n from public.subscriptions where quote_id = 'Q-R378-C';
  if n <> 2 then raise exception 'FAIL C: expected 2 subscriptions, got %', n; end if;
  if exists (select 1 from public.subscriptions where quote_id = 'Q-R378-C' and vendor_cost_per_seat_month is not null) then
    raise exception 'FAIL C: missing / zero cost must stay NULL'; end if;
  raise notice 'PASS C: no cost / cost 0 -> NULL';

  perform public.record_payment('Q-R378-D', 38232, 'upi', 'r378_d_ref');
  select count(*) into n from public.subscriptions where quote_id = 'Q-R378-D' and vendor_cost_per_seat_month = 105;
  if n <> 2 then raise exception 'FAIL D: both bulk domain subscriptions should carry 105, got % rows', n; end if;
  raise notice 'PASS D: bulk line cost 1260/yr -> 105 on every domain';
end $$;

-- ── activate_quote_on_credit (owner; annual needs a reason since R-368) ──
select set_config('request.jwt.claims', '', true);
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000037801','owner378@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000037801','dddddddd-0000-0000-0000-000000037801','owner378@example.in','Owner 378','owner', now() - interval '1 day');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
  values
  ('Q-R378-E','dddddddd-0000-0000-0000-000000037801','cccccccc-0000-0000-0000-000000037801','Acme 378',
   41418, 35100, 0, 18, 'accepted', 'awaiting',
   '[{"name":"Google Workspace Business Starter","qty":10,"rate":3240,"cost":1320,"commitment":"annual_yearly","domain":"e1.acme378.in"},
     {"name":"Standard hosting (billed monthly)","qty":1,"rate":300,"cost":90,"commitment":"monthly","domain":"e2.acme378.in"}]'::jsonb);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000037801","role":"authenticated"}', true);
do $$
declare a int; m int;
begin
  perform public.activate_quote_on_credit('Q-R378-E', 15, false, 'Customer for 6 years, always pays');
  select vendor_cost_per_seat_month into a from public.subscriptions where quote_id = 'Q-R378-E' and domain = 'e1.acme378.in';
  select vendor_cost_per_seat_month into m from public.subscriptions where quote_id = 'Q-R378-E' and domain = 'e2.acme378.in';
  if a is distinct from 110 then raise exception 'FAIL E: credit annual line should be 110, got %', a; end if;
  if m is distinct from 90 then raise exception 'FAIL E: credit monthly line should be 90, got %', m; end if;
  raise notice 'PASS E: activate_quote_on_credit carries the line cost too';
end $$;

rollback;
