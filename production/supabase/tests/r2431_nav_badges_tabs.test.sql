\set ON_ERROR_STOP on
-- R-2431 (after R-2422 — Pardeep, 3 Nov 2026: "monthly commitment to renewal hi hoga"): the sidebar Renewals badge
-- = the /renewals Overdue + ≤7 days tab counts, less the Won't renew rows (R-2225 keeps them out). Migration: 20261103204658_r2431_nav_badges_renewals_tabs.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2431_nav_badges_tabs.test.sql
--
-- Expect "PASS r2431_nav_badges_tabs". The same rows as src/app/(app)/renewals/flex-everywhere-r2431.test.ts:
--
--   flex-soon    flex (1-month term, billed monthly), part in 3 days    → ≤7 days  (counted — flex is a renewal, R-2422)
--   flex-today   flex, part today                                       → ≤7 days  (counted)
--   flex-late    flex, part 2 days ago, unbilled                        → Overdue  (counted)
--   annual-soon  annual, in 5 days                                      → ≤7 days  (counted)
--   annual-late  annual, 4 days ago                                     → Overdue  (counted)
--   wont-soon    Won't renew, in 4 days (still running)                 → ≤7 days  (NOT counted — Won't renew, R-2225)
--   wont-late    Won't renew, 1 day ago                                 → no tab   (not counted)
--   paid-late    3 days ago, its renewal quote paid (received)          → not Overdue (not counted — R-2403)
--   stopped      10 days ago, service stopped, quote paid               → Overdue  (counted)
--   far          in 8 days                                              → 8–30     (not counted)
--   So the badge = 6. Before this migration it was 5 (flex-soon and flex-today left out, paid-late counted).

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2431000-0000-4000-8000-0000000000a1', 'r2431-owner@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2431000-0000-0000-0000-0000000000a0', 'R2431 A', 'r2431a@example.in', '07', 'R31A');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2431000-0000-4000-8000-0000000000a1', 'e2431000-0000-0000-0000-0000000000a0', 'r2431-owner@example.in', 'R2431 Owner', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2431000-0000-4000-8000-0000000000c1', 'e2431000-0000-0000-0000-0000000000a0', 'R2431 Co', '07', 'India');

insert into public.quotes (id, tenant_id, customer_name, payment_status) values
  ('R2431-Q-PAID', 'e2431000-0000-0000-0000-0000000000a0', 'R2431 Co', 'received');

insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date, term_months, billing_cycle, auto_renew, renewal_state, renewal_quote_id)
select 'e2431000-0000-0000-0000-0000000000a0', 'e2431000-0000-4000-8000-0000000000c1', 'R2431 Co', v.plan, 'google', 1, 1000, 'active',
       (now() at time zone 'Asia/Kolkata')::date + v.days, v.term, v.cycle::public.billing_cycle, v.auto, v.state::public.renewal_state, v.quote
  from (values
    ('flex-soon',    3, 1,  'monthly', true,  'pending',   null::text),
    ('flex-today',   0, 1,  'monthly', true,  'pending',   null),
    ('flex-late',   -2, 1,  'monthly', true,  'pending',   null),
    ('annual-soon',  5, 12, 'yearly',  true,  'pending',   null),
    ('annual-late', -4, 12, 'yearly',  true,  'pending',   null),
    ('wont-soon',    4, 12, 'yearly',  false, 'pending',   null),
    ('wont-late',   -1, 12, 'yearly',  false, 'pending',   null),
    ('paid-late',   -3, 12, 'yearly',  true,  'pending',   'R2431-Q-PAID'),
    ('stopped',    -10, 12, 'yearly',  true,  'suspended', 'R2431-Q-PAID'),
    ('far',          8, 12, 'yearly',  true,  'pending',   null)
  ) as v(plan, days, term, cycle, auto, state, quote);

create temp table r2431_fail (msg text) on commit drop;
grant all on r2431_fail to authenticated, service_role;

do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2431000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_n := (public.nav_badges('{}')->>'renewals')::int;
  if v_n <> 6 then
    insert into r2431_fail values ('owner badge = ' || v_n || ' (want 6 = Overdue 3 (flex-late, annual-late, stopped) + ≤7 days 3 (flex-soon, flex-today, annual-soon); not wont-soon, paid-late)');
  end if;
  reset role;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n') into v_msgs from r2431_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2431_nav_badges_tabs:\n%', v_msgs;
  end if;
  raise notice 'PASS r2431_nav_badges_tabs';
end $$;

rollback;
