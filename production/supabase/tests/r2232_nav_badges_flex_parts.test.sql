\set ON_ERROR_STOP on
-- R-2232 (Zoho Billing audit A8): Renewals = end of commitment only — the sidebar Renewals badge.
-- Migration: 20261101165305_r2232_nav_badges_flex_parts.
-- R-2431 (3 Nov 2026): the owner reversed R-2232 on R-2422 ("monthly commitment to renewal hi hoga") — a flex part IS a
-- renewal and counts in the badge (20261104000444_r2431_nav_badges_renewals_tabs). The same rows now give 6.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2232_nav_badges_flex_parts.test.sql
--
-- Expect "PASS r2232_nav_badges_flex_parts".
--
--   f1  flex (1-month term, billed monthly), next part in 3 days   → counted since R-2431 (flex is a renewal)
--   f2  flex, part date today                                       → counted since R-2431
--   f3  flex, part date 2 days ago (unbilled — listed as Expired)  → counted
--   a1  annual term billed monthly, ends in 4 days                  → counted (end of commitment)
--   a2  annual term billed yearly, ends in 5 days                   → counted
--   m1  1-month term billed yearly (one bill, renewal quote), in 2 days → counted
--   So the owner's badge = 6 (all of them) — it was 4 under R-2232 alone.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2232000-0000-4000-8000-0000000000a1', 'r2232-owner@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2232000-0000-0000-0000-0000000000a0', 'R2232 A', 'r2232a@example.in', '07', 'R32A');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2232000-0000-4000-8000-0000000000a1', 'e2232000-0000-0000-0000-0000000000a0', 'r2232-owner@example.in', 'R2232 Owner', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2232000-0000-4000-8000-0000000000c1', 'e2232000-0000-0000-0000-0000000000a0', 'R2232 Flex Co', '07', 'India');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date, term_months, billing_cycle) values
  ('e2232000-0000-4000-8000-0000000000f1', 'e2232000-0000-0000-0000-0000000000a0', 'e2232000-0000-4000-8000-0000000000c1', 'R2232 Flex Co', 'Business Starter', 'google', 5, 1350, 'active',
   (now() at time zone 'Asia/Kolkata')::date + 3, 1, 'monthly'),
  ('e2232000-0000-4000-8000-0000000000f2', 'e2232000-0000-0000-0000-0000000000a0', 'e2232000-0000-4000-8000-0000000000c1', 'R2232 Flex Co', 'Business Starter', 'google', 2, 540, 'active',
   (now() at time zone 'Asia/Kolkata')::date, 1, 'monthly'),
  ('e2232000-0000-4000-8000-0000000000f3', 'e2232000-0000-0000-0000-0000000000a0', 'e2232000-0000-4000-8000-0000000000c1', 'R2232 Flex Co', 'Business Plus', 'google', 1, 850, 'active',
   (now() at time zone 'Asia/Kolkata')::date - 2, 1, 'monthly'),
  ('e2232000-0000-4000-8000-0000000000a1', 'e2232000-0000-0000-0000-0000000000a0', 'e2232000-0000-4000-8000-0000000000c1', 'R2232 Flex Co', 'Business Standard', 'google', 3, 2000, 'active',
   (now() at time zone 'Asia/Kolkata')::date + 4, 12, 'monthly'),
  ('e2232000-0000-4000-8000-0000000000a2', 'e2232000-0000-0000-0000-0000000000a0', 'e2232000-0000-4000-8000-0000000000c1', 'R2232 Flex Co', 'Business Standard', 'google', 3, 2000, 'active',
   (now() at time zone 'Asia/Kolkata')::date + 5, 12, 'yearly'),
  ('e2232000-0000-4000-8000-0000000000b1', 'e2232000-0000-0000-0000-0000000000a0', 'e2232000-0000-4000-8000-0000000000c1', 'R2232 Flex Co', 'Vault', 'google', 1, 300, 'active',
   (now() at time zone 'Asia/Kolkata')::date + 2, 1, 'yearly');

create temp table r2232_fail (msg text) on commit drop;
grant all on r2232_fail to authenticated, service_role;

do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2232000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_n := (public.nav_badges('{}')->>'renewals')::int;
  if v_n <> 6 then
    insert into r2232_fail values ('owner badge = ' || v_n || ' (want 6 since R-2431: flex parts f1, f2 count too, with f3, a1, a2, m1)');
  end if;
  reset role;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n') into v_msgs from r2232_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2232_nav_badges_flex_parts:\n%', v_msgs;
  end if;
  raise notice 'PASS r2232_nav_badges_flex_parts';
end $$;

rollback;
