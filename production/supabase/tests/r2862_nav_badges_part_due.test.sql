\set ON_ERROR_STOP on
-- R-2862 (leftovers of R-2858): the sidebar Renewals badge = the /renewals Overdue + ≤7 days tabs (less Won't renew, R-2225)
-- also for a row whose PART is late / due soon while its renewal date is 8+ days out. Migration: *_r2862_nav_badges_part_due.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2862_nav_badges_part_due.test.sql
--
-- Expect "PASS r2862_nav_badges_part_due". The same rows as src/app/(app)/renewals/part-leftovers-r2862.test.ts:
--
--   part-late    renews in 20 days, its part proforma (sent, unpaid) fell due 9 days ago → Overdue  (counted — NEW)
--   part-soon    renews in 20 days, part proforma due in 3 days                          → ≤7 days  (counted — NEW)
--   part-far     renews in 40 days, part proforma due in 15 days                         → 8–30     (not counted)
--   part-paid    renews in 20 days, its part proforma is paid                            → 8–30     (not counted)
--   part-draft   renews in 20 days, a draft part quote (not sent)                        → 8–30     (not counted)
--   part-first   renews in 20 days, the part is the FIRST term's (the sale)              → 8–30     (not counted)
--   inv-soon     renews in 20 days, next term's part invoiced, unpaid, due in 3 days     → ≤7 days  (counted — NEW)
--   wont-late    Won't renew, part proforma 9 days late                                  → Overdue tab, NOT the badge (R-2225)
--   plain-soon   renews in 5 days                                                        → ≤7 days  (counted)
--   plain-far    renews in 8 days                                                        → 8–30     (not counted)
--   annual-part  annual paid quarterly, renews in 60 days, part proforma 9 days late     → Overdue  (counted — NEW)
--   ravi         renewal date 15 days ago, its part proforma unpaid                      → Overdue  (counted)
--   member       renews in 20 days; its part is a LINE of annual-part's "Bill together" proforma, due 9 days ago → Overdue (counted — NEW)
--   So the badge = 7 (the TS fixture has the first 12 rows = 6). Before this migration it was 2 (plain-soon, ravi).

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2862000-0000-4000-8000-0000000000a1', 'r2862-owner@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2862000-0000-0000-0000-0000000000a0', 'R2862 A', 'r2862a@example.in', '07', 'R62A');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2862000-0000-4000-8000-0000000000a1', 'e2862000-0000-0000-0000-0000000000a0', 'r2862-owner@example.in', 'R2862 Owner', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2862000-0000-4000-8000-0000000000c1', 'e2862000-0000-0000-0000-0000000000a0', 'R2862 Co', '07', 'India');

create temp table r2862_today on commit drop as select (now() at time zone 'Asia/Kolkata')::date as d;

insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date, term_months, billing_cycle, auto_renew, renewal_state)
select 'e2862000-0000-0000-0000-0000000000a0', 'e2862000-0000-4000-8000-0000000000c1', 'R2862 Co', v.plan, 'google', 1, 1000, 'active',
       t.d + v.start_days, t.d + v.days, v.term, v.cycle::public.billing_cycle, v.auto, 'pending'
  from r2862_today t, (values
    ('part-late',   -200, 20, 1,  'monthly',   true),
    ('part-soon',   -200, 20, 1,  'monthly',   true),
    ('part-far',    -200, 40, 1,  'monthly',   true),
    ('part-paid',   -200, 20, 1,  'monthly',   true),
    ('part-draft',  -200, 20, 1,  'monthly',   true),
    ('part-first',   -10, 20, 1,  'monthly',   true),
    ('inv-soon',    -200, 20, 1,  'monthly',   true),
    ('wont-late',   -200, 20, 1,  'monthly',   false),
    ('plain-soon',  -200,  5, 12, 'yearly',    true),
    ('plain-far',   -200,  8, 12, 'yearly',    true),
    ('annual-part', -400, 60, 12, 'quarterly', true),
    ('ravi',        -200, -15, 1, 'monthly',   true),
    ('member',      -200, 20, 1,  'monthly',   true)
  ) as v(plan, start_days, days, term, cycle, auto);

-- one billed part per row that has one: (plan, part start, part end, due, value before GST)
insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, due_on)
select s.tenant_id, s.id, t.d + v.st, 1, t.d + v.st, t.d + v.st, t.d + v.en, v.taxable, t.d + v.due
  from r2862_today t, (values
    ('part-late',   -10, 20, -9, 1000),
    ('part-soon',   -10, 20,  3, 1000),
    ('part-far',     10, 40, 15, 1000),
    ('part-paid',   -10, 20, -9, 1000),
    ('part-draft',  -10, 20, -9, 1000),
    ('part-first',  -10, 20, -9, 1000),
    ('inv-soon',     25, 55,  3, 1000),
    ('wont-late',   -10, 20, -9, 1000),
    ('annual-part', -10, 80, -9, 3000),
    ('ravi',        -46, -15, -46, 1000),
    ('member',      -10, 20, -9, 1000)
  ) as v(plan, st, en, due, taxable)
  join public.subscriptions s on s.plan = v.plan and s.tenant_id = 'e2862000-0000-0000-0000-0000000000a0';

-- the part proformas (lead part); annual-part's also bills `member`'s part on a line ("Bill together", R-2830)
insert into public.quotes (id, tenant_id, customer_name, status, payment_status, subscription_billing_id, line_items)
select 'R2862-PI-' || v.plan, s.tenant_id, 'R2862 Co', v.status::public.quote_status, v.pay::public.payment_status, b.id,
       case when v.plan = 'annual-part'
            then jsonb_build_array(jsonb_build_object('name', 'lead', 'billing_id', b.id::text),
                                   jsonb_build_object('name', 'member', 'billing_id', (select mb.id::text from public.subscription_billings mb join public.subscriptions ms on ms.id = mb.subscription_id where ms.plan = 'member' and ms.tenant_id = s.tenant_id)))
            else null end
  from (values
    ('part-late',   'sent',  'awaiting'),
    ('part-soon',   'sent',  'awaiting'),
    ('part-far',    'sent',  'awaiting'),
    ('part-paid',   'sent',  'received'),
    ('part-draft',  'draft', 'none'),
    ('part-first',  'sent',  'awaiting'),
    ('wont-late',   'sent',  'awaiting'),
    ('annual-part', 'sent',  'awaiting'),
    ('ravi',        'sent',  'awaiting')
  ) as v(plan, status, pay)
  join public.subscriptions s on s.plan = v.plan and s.tenant_id = 'e2862000-0000-0000-0000-0000000000a0'
  join public.subscription_billings b on b.subscription_id = s.id;

-- inv-soon: its next-term part is invoiced, unpaid, due in 3 days
insert into public.invoices (id, tenant_id, customer_name, amount, status, due_date)
select 'INV-R2862-SOON', 'e2862000-0000-0000-0000-0000000000a0', 'R2862 Co', 1180, 'pending', t.d + 3 from r2862_today t;
update public.subscription_billings b set invoice_id = 'INV-R2862-SOON'
  from public.subscriptions s where s.id = b.subscription_id and s.plan = 'inv-soon' and s.tenant_id = 'e2862000-0000-0000-0000-0000000000a0';

-- another workspace with the same late part: never counted in tenant A's badge (SECURITY INVOKER — RLS decides)
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2862000-0000-0000-0000-0000000000b0', 'R2862 B', 'r2862b@example.in', '07', 'R62B');
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2862000-0000-4000-8000-0000000000c2', 'e2862000-0000-0000-0000-0000000000b0', 'R2862 Other Co', '07', 'India');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date, term_months, billing_cycle, auto_renew, renewal_state)
select 'e2862000-0000-4000-8000-0000000000d2', 'e2862000-0000-0000-0000-0000000000b0', 'e2862000-0000-4000-8000-0000000000c2', 'R2862 Other Co', 'other-late', 'google', 1, 1000, 'active',
       t.d - 200, t.d + 20, 1, 'monthly', true, 'pending' from r2862_today t;
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, due_on)
select 'e2862000-0000-4000-8000-0000000000e2', 'e2862000-0000-0000-0000-0000000000b0', 'e2862000-0000-4000-8000-0000000000d2', t.d - 10, 1, t.d - 10, t.d - 10, t.d + 20, 1000, t.d - 9 from r2862_today t;
insert into public.quotes (id, tenant_id, customer_name, status, payment_status, subscription_billing_id) values
  ('R2862-PI-other', 'e2862000-0000-0000-0000-0000000000b0', 'R2862 Other Co', 'sent', 'awaiting', 'e2862000-0000-4000-8000-0000000000e2');

create temp table r2862_fail (msg text) on commit drop;
grant all on r2862_fail to authenticated, service_role;

do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2862000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_n := (public.nav_badges('{}')->>'renewals')::int;
  if v_n <> 7 then
    insert into r2862_fail values ('owner badge = ' || v_n || ' (want 7 = Overdue 4 (part-late, annual-part, member, ravi) + ≤7 days 3 (part-soon, inv-soon, plain-soon); not wont-late, part-far, part-paid, part-draft, part-first, plain-far)');
  end if;
  reset role;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- a paid part invoice no longer counts; a linked open renewal quote is the row's document, not the part
update public.invoices set status = 'paid' where id = 'INV-R2862-SOON';
insert into public.quotes (id, tenant_id, customer_name, status, payment_status) values
  ('R2862-Q-REN', 'e2862000-0000-0000-0000-0000000000a0', 'R2862 Co', 'sent', 'awaiting');
update public.subscriptions set renewal_quote_id = 'R2862-Q-REN' where plan = 'part-late' and tenant_id = 'e2862000-0000-0000-0000-0000000000a0';

do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2862000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_n := (public.nav_badges('{}')->>'renewals')::int;
  if v_n <> 5 then
    insert into r2862_fail values ('after paying inv-soon and linking an open renewal quote to part-late: badge = ' || v_n || ' (want 5)');
  end if;
  reset role;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n') into v_msgs from r2862_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2862_nav_badges_part_due:\n%', v_msgs;
  end if;
  raise notice 'PASS r2862_nav_badges_part_due';
end $$;

rollback;
