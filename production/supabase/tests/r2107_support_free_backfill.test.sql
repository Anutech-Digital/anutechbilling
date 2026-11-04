-- R-2107 (29 Oct 2026) — existing buyers get the Free support desk account too.
--
-- queue_support_free_backfill(p_dry_run): one go-live staff action, dry run first, queues a
-- Free support_sync_outbox row for every active customer with an active non-support
-- subscription, no paid support and no outbox row yet. Migration 20261029145126_r2107_support_free_backfill.sql.
--
-- CASES (self-asserting; every one raises on failure)
--   1. Dry run counts (1 with email — incl. one whose email is only on the primary contact —
--      and 1 without) and queues nothing.
--   2. The real run queues Free rows only for customers without paid support, with the
--      customer_primary_email (R-2108) and plan_key 'free'; none for the paid Enterprise
--      customer, the archived one, the one with only a cancelled licence, the one already on
--      the desk, the one without an email, or another company's customer.
--   3. A second run queues nothing new.
--   4. A sales user is refused; anon cannot call it.
--
-- SAFETY: synthetic tenants, one transaction, ends in ROLLBACK.

begin;

select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

insert into public.tenants (id, name, email, doc_code, tier) values
  ('21070000-0000-4000-8000-0000000000a1', 'ZZ R2107 A', 'zz-r2107-a@example.invalid', 'ZZ2107A', 'reseller'),
  ('21070000-0000-4000-8000-0000000000b1', 'ZZ R2107 B', 'zz-r2107-b@example.invalid', 'ZZ2107B', 'reseller');

insert into public.customers (id, tenant_id, name, contact_email, customer_number, is_active) values
  ('21070000-0000-4000-8000-0000000000c1', '21070000-0000-4000-8000-0000000000a1', 'ZZ R2107 Licence Only', 'lic@r2107.invalid', 'C-21071', true),
  ('21070000-0000-4000-8000-0000000000c2', '21070000-0000-4000-8000-0000000000a1', 'ZZ R2107 Contact Email', null, 'C-21072', true),
  ('21070000-0000-4000-8000-0000000000c3', '21070000-0000-4000-8000-0000000000a1', 'ZZ R2107 Paid Enterprise', 'paid@r2107.invalid', 'C-21073', true),
  ('21070000-0000-4000-8000-0000000000c4', '21070000-0000-4000-8000-0000000000a1', 'ZZ R2107 Archived', 'arch@r2107.invalid', 'C-21074', false),
  ('21070000-0000-4000-8000-0000000000c5', '21070000-0000-4000-8000-0000000000a1', 'ZZ R2107 Cancelled Licence', 'cxl@r2107.invalid', 'C-21075', true),
  ('21070000-0000-4000-8000-0000000000c6', '21070000-0000-4000-8000-0000000000a1', 'ZZ R2107 Already On Desk', 'desk@r2107.invalid', 'C-21076', true),
  ('21070000-0000-4000-8000-0000000000c7', '21070000-0000-4000-8000-0000000000a1', 'ZZ R2107 No Email', null, 'C-21077', true),
  ('21070000-0000-4000-8000-0000000000c8', '21070000-0000-4000-8000-0000000000b1', 'ZZ R2107 Other Company', 'other@r2107.invalid', 'C-21078', true);

insert into public.contacts (id, tenant_id, full_name, email) values
  ('ZZ2107-P2', '21070000-0000-4000-8000-0000000000a1', 'Primary Two', 'Two@R2107.invalid');
insert into public.customer_contacts (tenant_id, customer_id, contact_id, is_primary) values
  ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000c2', 'ZZ2107-P2', true);

insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale, is_active, item_type, kind, prices, sku, term_months, fulfilment)
values ('SUP-ENTERPRISE-MO-21070000000040008000000000000a1', '21070000-0000-4000-8000-0000000000a1', 'Support Enterprise (Monthly)',
        'support', '998313', 4999, 0, true, 'subscription', 'main', '{}'::jsonb, 'SUP-ENTERPRISE-MO', 1, 'support_panel');

-- The licences exist BEFORE go-live: insert them, then drop the rows R-2102's trigger queued
-- (on the real data they never existed — the licences predate R-2102).
insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, status, start_date, renewal_date, domain) values
  ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000c1', 'x', 'Business Starter', 'google', null, 1, 100, 'active', current_date, (current_date + 365), 'lic.example'),
  ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000c2', 'x', 'Business Standard', 'google', null, 1, 100, 'active', current_date, (current_date + 365), null),
  ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000c3', 'x', 'Microsoft 365 Business Basic', 'microsoft', null, 1, 100, 'active', current_date, (current_date + 365), null),
  ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000c3', 'x', 'ZZ Enterprise Support', 'support', 'SUP-ENTERPRISE-MO-21070000000040008000000000000a1', 1, 4999, 'active', current_date, (current_date + 30), null),
  ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000c4', 'x', 'Business Starter', 'google', null, 1, 100, 'active', current_date, (current_date + 365), null),
  ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000c5', 'x', 'Business Starter', 'google', null, 1, 100, 'cancelled', current_date, (current_date + 365), null),
  ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000c6', 'x', 'Business Starter', 'google', null, 1, 100, 'active', current_date, (current_date + 365), null),
  ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000c7', 'x', 'Business Starter', 'google', null, 1, 100, 'active', current_date, (current_date + 365), null),
  ('21070000-0000-4000-8000-0000000000b1', '21070000-0000-4000-8000-0000000000c8', 'x', 'Business Starter', 'google', null, 1, 100, 'active', current_date, (current_date + 365), null);

delete from public.support_sync_outbox
 where tenant_id in ('21070000-0000-4000-8000-0000000000a1', '21070000-0000-4000-8000-0000000000b1')
   and customer_id <> '21070000-0000-4000-8000-0000000000c6';

-- staff: an owner of tenant A
insert into auth.users (id, email, instance_id, aud, role)
values ('21070000-0000-4000-8000-0000000000e1', 'zz-r2107-owner@example.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.users (id, tenant_id, email, role, is_active)
values ('21070000-0000-4000-8000-0000000000e1', '21070000-0000-4000-8000-0000000000a1', 'zz-r2107-owner@example.invalid', 'owner', true);

select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', '21070000-0000-4000-8000-0000000000e1')::text, true);
set local role authenticated;

do $$
declare
  v_j jsonb;
begin
  -- ── 1 ─────────────────────────────────────────────────────────────────────
  v_j := public.queue_support_free_backfill(true);
  if (v_j->>'with_email')::int <> 2 or (v_j->>'without_email')::int <> 1 or (v_j->>'queued')::int <> 0 then
    raise exception 'CASE 1 FAIL: dry run should count 2 with email + 1 without and queue 0, got %', v_j;
  end if;

  -- ── 2 ─────────────────────────────────────────────────────────────────────
  v_j := public.queue_support_free_backfill(false);
  if (v_j->>'queued')::int <> 2 then raise exception 'CASE 2 FAIL: real run queued %', v_j; end if;

  -- ── 3 ─────────────────────────────────────────────────────────────────────
  v_j := public.queue_support_free_backfill(false);
  if (v_j->>'queued')::int <> 0 or (v_j->>'with_email')::int <> 0 then
    raise exception 'CASE 3 FAIL: second run should queue nothing new, got %', v_j;
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

do $$
declare
  v_n integer;
  v_p jsonb;
begin
  -- ── 2 (rows) ──────────────────────────────────────────────────────────────
  select payload into v_p from public.support_sync_outbox where customer_id = '21070000-0000-4000-8000-0000000000c1';
  if v_p is null or v_p->'data'->>'plan_key' <> 'free' or v_p->'data'->>'email' <> 'lic@r2107.invalid'
     or v_p->'data'->>'billing_customer_id' <> 'C-21071' or v_p->'data'->>'domain' <> 'lic.example' then
    raise exception 'CASE 2 FAIL: licence-only customer row wrong: %', v_p;
  end if;
  select payload into v_p from public.support_sync_outbox where customer_id = '21070000-0000-4000-8000-0000000000c2';
  if v_p is null or v_p->'data'->>'email' <> 'Two@R2107.invalid' then
    raise exception 'CASE 2 FAIL: primary-contact-email customer row wrong: %', v_p;
  end if;
  select count(*) into v_n from public.support_sync_outbox
   where customer_id in ('21070000-0000-4000-8000-0000000000c3', '21070000-0000-4000-8000-0000000000c4',
                         '21070000-0000-4000-8000-0000000000c5', '21070000-0000-4000-8000-0000000000c7',
                         '21070000-0000-4000-8000-0000000000c8');
  if v_n <> 0 then raise exception 'CASE 2 FAIL: % rows for customers that must not get one', v_n; end if;
  select count(*) into v_n from public.support_sync_outbox where customer_id = '21070000-0000-4000-8000-0000000000c6';
  if v_n <> 1 then raise exception 'CASE 2 FAIL: the customer already on the desk got another row (% rows)', v_n; end if;
end $$;

-- ── 4 ───────────────────────────────────────────────────────────────────────
update public.users set role = 'sales' where id = '21070000-0000-4000-8000-0000000000e1';
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', '21070000-0000-4000-8000-0000000000e1')::text, true);
set local role authenticated;
do $$
begin
  begin
    perform public.queue_support_free_backfill(true);
    raise exception 'CASE 4 FAIL: a sales user could run the backfill';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
begin
  if has_function_privilege('anon', 'public.queue_support_free_backfill(boolean)', 'execute') then
    raise exception 'CASE 4 FAIL: anon may execute queue_support_free_backfill';
  end if;
end $$;

select 'R-2107 queue_support_free_backfill: all cases passed' as result;

rollback;
