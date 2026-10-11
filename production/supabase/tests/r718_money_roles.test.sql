\set ON_ERROR_STOP on
-- R-718 (P1 SECURITY): money SECURITY DEFINER functions check the caller's ROLE, not only
-- the company. Migration 20261011120000_r718_money_roles. Pardeep's role table (11 Oct 2026):
--   (1) record payment, credit/debit note, direct invoice, bank match/booking, vendor bill /
--       referral payout, transfer, credit redeem: owner, manager, accountant, billing
--   (2) delete payment / invoice / subscription (and "undo the sale" from a bank line):
--       owner, accountant only
--   (3) sales, support (and everyone else): no money action
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r718_money_roles.test.sql
--
-- Expect "PASS r718_money_roles". Every check is collected first and the failures listed
-- together, so on the old bodies the run names EVERY open function.
--
--   GATE     each refused caller on each of the 20 functions → SQLSTATE 42501 "Only … user can …"
--   GATE     each allowed caller (and service_role) gets PAST the gate (any other outcome)
--   REAL     sales records a payment, deletes a payment, issues a credit note, makes a direct
--            invoice, redeems credit; billing / manager delete a payment / subscription —
--            all refused and nothing changes
--   REAL     owner, manager, accountant, billing, service_role record a payment; accountant
--            deletes a payment; owner deletes a subscription — all succeed
--   TENANT   owner of company B on company A's quote / payment — refused, nothing changes

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e7180000-0000-4000-8000-0000000000a1', 'r718-owner@example.test'),
  ('e7180000-0000-4000-8000-0000000000a2', 'r718-manager@example.test'),
  ('e7180000-0000-4000-8000-0000000000a3', 'r718-accountant@example.test'),
  ('e7180000-0000-4000-8000-0000000000a4', 'r718-sales@example.test'),
  ('e7180000-0000-4000-8000-0000000000a5', 'r718-support@example.test'),
  ('e7180000-0000-4000-8000-0000000000a6', 'r718-billing@example.test'),
  ('e7180000-0000-4000-8000-0000000000a7', 'r718-delivery@example.test'),
  ('e7180000-0000-4000-8000-0000000000b1', 'r718-owner-b@example.test'),
  ('e7180000-0000-4000-8000-0000000000ff', 'r718-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e7180000-0000-0000-0000-0000000000a0', 'R718 A', 'r718a@example.in', '07', 'R78A'),
  ('e7180000-0000-0000-0000-0000000000b0', 'R718 B', 'r718b@example.in', '07', 'R78B');

-- The no-company caller has NO public.users row.
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e7180000-0000-4000-8000-0000000000a1', 'e7180000-0000-0000-0000-0000000000a0', 'r718-owner@example.in',      'R718 Owner',      'owner',      true),
  ('e7180000-0000-4000-8000-0000000000a2', 'e7180000-0000-0000-0000-0000000000a0', 'r718-manager@example.in',    'R718 Manager',    'manager',    true),
  ('e7180000-0000-4000-8000-0000000000a3', 'e7180000-0000-0000-0000-0000000000a0', 'r718-accountant@example.in', 'R718 Accountant', 'accountant', true),
  ('e7180000-0000-4000-8000-0000000000a4', 'e7180000-0000-0000-0000-0000000000a0', 'r718-sales@example.in',      'R718 Sales',      'sales',      true),
  ('e7180000-0000-4000-8000-0000000000a5', 'e7180000-0000-0000-0000-0000000000a0', 'r718-support@example.in',    'R718 Support',    'support',    true),
  ('e7180000-0000-4000-8000-0000000000a6', 'e7180000-0000-0000-0000-0000000000a0', 'r718-billing@example.in',    'R718 Billing',    'billing',    true),
  ('e7180000-0000-4000-8000-0000000000a7', 'e7180000-0000-0000-0000-0000000000a0', 'r718-delivery@example.in',   'R718 Delivery',   'delivery',   true),
  ('e7180000-0000-4000-8000-0000000000b1', 'e7180000-0000-0000-0000-0000000000b0', 'r718-owner-b@example.in',    'R718 Owner B',    'owner',      true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e7180000-0000-4000-8000-0000000000c1', 'e7180000-0000-0000-0000-0000000000a0', 'R718 Cust', '07', 'India');

-- One quote per caller that records a payment for real (one-off line, no subscription).
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
select 'Q-R718-' || k, 'e7180000-0000-0000-0000-0000000000a0', null, 'e7180000-0000-4000-8000-0000000000c1',
       'R718 Cust', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb
  from unnest(array['VICTIM', 'OWNER', 'MANAGER', 'ACCOUNTANT', 'BILLING', 'SERVICE', 'PAID']) k;

-- Subscriptions: one victim (refused deletes), one the owner deletes.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle) values
  ('e7180000-0000-4000-8000-0000000005b0', 'e7180000-0000-0000-0000-0000000000a0', 'e7180000-0000-4000-8000-0000000000c1',
   'R718 Cust', 'Workspace Starter', 'google'::vendor, 2, 1000, 'monthly'::billing_cycle),
  ('e7180000-0000-4000-8000-0000000005b1', 'e7180000-0000-0000-0000-0000000000a0', 'e7180000-0000-4000-8000-0000000000c1',
   'R718 Cust', 'Workspace Starter', 'google'::vendor, 2, 1000, 'monthly'::billing_cycle);

-- Customer credit the refused callers try to spend.
insert into public.customer_credits (tenant_id, customer_id, amount, source)
values ('e7180000-0000-0000-0000-0000000000a0', 'e7180000-0000-4000-8000-0000000000c1', 500, 'manual');

-- Two receipts recorded as postgres (trusted): the victim payment and the one the accountant deletes.
select public.record_payment('Q-R718-PAID', 1180, 'bank_transfer', 'R718-PAID', null);

-- An issued invoice the refused callers try to credit (made through the admin-client path).
create temp table r718_ctx (k text primary key, v text);
grant all on r718_ctx to authenticated, service_role;
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
insert into r718_ctx
select 'victim_invoice', invoice_id
  from public.create_direct_invoice('e7180000-0000-4000-8000-0000000000c1', '[{"description":"R718 victim","qty":1,"rate":1000}]'::jsonb, 'R718 victim', false);
reset role;
insert into r718_ctx select 'victim_payment', id::text from public.payments where quote_id = 'Q-R718-PAID';
select set_config('request.jwt.claims', '', true);

create temp table r718_fail (n serial, label text, detail text);
grant all on r718_fail to authenticated, service_role;
grant usage on sequence r718_fail_n_seq to authenticated, service_role;

/* Runs one call as the CURRENT role/claims and records how it ended.
   want: 'gate' = refused by the R-718 role gate (42501 "Only … user can …");
         'pass' = NOT refused by the gate (any other error or success);
         'ok'   = succeeded;  'any' = any error. Failures are collected, not raised. */
create function pg_temp.r718_expect(label text, call text, want text) returns void
language plpgsql as $f$
declare v_state text; v_msg text; v_gate boolean;
begin
  begin
    execute call;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_gate := v_state = '42501' and v_msg like 'Only %user can %';
    if want = 'gate' and not v_gate then
      insert into r718_fail(label, detail) values (label, format('expected the role gate, got %s (%s)', v_state, left(v_msg, 90)));
    elsif want = 'pass' and v_gate then
      insert into r718_fail(label, detail) values (label, format('allowed caller refused by the role gate (%s)', v_msg));
    elsif want = 'ok' then
      insert into r718_fail(label, detail) values (label, format('expected success, got %s (%s)', v_state, left(v_msg, 90)));
    else
      raise notice 'ok   %: % (%)', label, v_state, left(v_msg, 70);
    end if;
    return;
  end;
  if want in ('gate', 'any') then
    insert into r718_fail(label, detail) values (label, format('expected %s, call SUCCEEDED', want));
    return;
  end if;
  raise notice 'ok   %: succeeded', label;
end $f$;
grant execute on function pg_temp.r718_expect(text, text, text) to authenticated, service_role;

/* One harmless call per function (ids that do not exist) — reaches the gate, changes nothing.
   grp: 'record' = Pardeep's group (1), 'delete' = group (2). */
create function pg_temp.r718_calls() returns table(fn text, grp text, call text)
language sql as $f$
  select * from (values
    ('record_payment',                       'record', $c$select public.record_payment('Q-R718-NONE', 100, 'bank_transfer', 'x', null)$c$),
    ('issue_credit_note',                    'record', $c$select public.issue_credit_note('INV-R718-NONE', 100, 'other', null, null)$c$),
    ('issue_debit_note',                     'record', $c$select public.issue_debit_note('INV-R718-NONE', 100, 'other', null, null)$c$),
    ('create_direct_invoice',                'record', $c$select public.create_direct_invoice('00000000-0000-4000-8000-000000000718', '[]'::jsonb, null, false)$c$),
    ('pay_vendor_bill',                      'record', $c$select public.pay_vendor_bill('BILL-R718-NONE', 100, '2026-10-05', '00000000-0000-4000-8000-000000000718', null)$c$),
    ('pay_referral_commission',              'record', $c$select public.pay_referral_commission('00000000-0000-4000-8000-000000000718', '00000000-0000-4000-8000-000000000718', null, null)$c$),
    ('record_account_transfer',              'record', $c$select public.record_account_transfer('00000000-0000-4000-8000-000000000718', '00000000-0000-4000-8000-000000000719', 100, '2026-10-05', null)$c$),
    ('reconcile_bank_txn',                   'record', $c$select public.reconcile_bank_txn('00000000-0000-4000-8000-000000000718', null, null, 'manual')$c$),
    ('book_bank_txn_as_expense',             'record', $c$select public.book_bank_txn_as_expense('00000000-0000-4000-8000-000000000718', 'Rent', 'x', 0, null)$c$),
    ('book_bank_txn_as_prepaid',             'record', $c$select public.book_bank_txn_as_prepaid('00000000-0000-4000-8000-000000000718', 'x', 'Advertising', null)$c$),
    ('book_bank_txn_as_referral_commission', 'record', $c$select public.book_bank_txn_as_referral_commission('00000000-0000-4000-8000-000000000718', '00000000-0000-4000-8000-000000000718')$c$),
    ('book_bank_txn_as_statutory',           'record', $c$select public.book_bank_txn_as_statutory('00000000-0000-4000-8000-000000000718', 'pf', null, null, null)$c$),
    ('book_bank_txn_as_tax',                 'record', $c$select public.book_bank_txn_as_tax('00000000-0000-4000-8000-000000000718', 'gst', null, null, 0, 0, null)$c$),
    ('book_bank_txn_as_vendor_bill',         'record', $c$select public.book_bank_txn_as_vendor_bill('00000000-0000-4000-8000-000000000718', 'BILL-R718-NONE', null)$c$),
    ('redeem_customer_credits',              'record', $c$select public.redeem_customer_credits('00000000-0000-4000-8000-000000000718', 100, null)$c$),
    ('unreconcile_bank_receipt',             'record', $c$select public.unreconcile_bank_receipt('00000000-0000-4000-8000-000000000718', false)$c$),
    ('unreconcile_bank_receipt undo_sale',   'delete', $c$select public.unreconcile_bank_receipt('00000000-0000-4000-8000-000000000718', true)$c$),
    ('delete_payment',                       'delete', $c$select public.delete_payment('00000000-0000-4000-8000-000000000718')$c$),
    ('delete_subscription',                  'delete', $c$select public.delete_subscription('00000000-0000-4000-8000-000000000718')$c$),
    ('delete_project_invoice',               'delete', $c$select public.delete_project_invoice('INV-R718-NONE')$c$),
    ('delete_subscription_invoice',          'delete', $c$select public.delete_subscription_invoice('INV-R718-NONE')$c$)
  ) v(fn, grp, call)
$f$;
grant execute on function pg_temp.r718_calls() to authenticated, service_role;

create function pg_temp.r718_as(sub text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', sub)::text, true);
end $f$;
grant execute on function pg_temp.r718_as(text) to authenticated;

-- ── 1. GATE: every caller × every function ─────────────────────────────────────────
set local role authenticated;
do $$
declare r record; who record; v_want text;
begin
  for who in select * from (values
      ('owner',       'e7180000-0000-4000-8000-0000000000a1', true,  true),
      ('manager',     'e7180000-0000-4000-8000-0000000000a2', true,  false),
      ('accountant',  'e7180000-0000-4000-8000-0000000000a3', true,  true),
      ('billing',     'e7180000-0000-4000-8000-0000000000a6', true,  false),
      ('sales',       'e7180000-0000-4000-8000-0000000000a4', false, false),
      ('support',     'e7180000-0000-4000-8000-0000000000a5', false, false),
      ('delivery',    'e7180000-0000-4000-8000-0000000000a7', false, false),
      ('no-company',  'e7180000-0000-4000-8000-0000000000ff', false, false)) w(label, sub, may_record, may_delete) loop
    perform pg_temp.r718_as(who.sub);
    for r in select * from pg_temp.r718_calls() loop
      v_want := case when (r.grp = 'record' and who.may_record) or (r.grp = 'delete' and who.may_delete)
                     then 'pass' else 'gate' end;
      perform pg_temp.r718_expect(who.label || ' ' || r.fn, r.call, v_want);
    end loop;
  end loop;
end $$;
reset role;

-- service_role (admin client: Razorpay webhook, public checkout / quote pay) passes the gate.
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
do $$
declare r record;
begin
  for r in select * from pg_temp.r718_calls() loop
    perform pg_temp.r718_expect('service_role ' || r.fn, r.call, 'pass');
  end loop;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ── 2. REAL: refused callers on company A's real rows — nothing may change ─────────
set local role authenticated;
do $$
declare v_pay uuid := (select v::uuid from r718_ctx where k = 'victim_payment');
        v_inv text := (select v from r718_ctx where k = 'victim_invoice');
begin
  perform pg_temp.r718_as('e7180000-0000-4000-8000-0000000000a4');   -- sales
  perform pg_temp.r718_expect('real sales record_payment', $c$select public.record_payment('Q-R718-VICTIM', 1180, 'cash', 'R718-SALES', null)$c$, 'gate');
  perform pg_temp.r718_expect('real sales delete_payment', format('select public.delete_payment(%L)', v_pay), 'gate');
  perform pg_temp.r718_expect('real sales issue_credit_note', format($c$select public.issue_credit_note(%L, 100, 'other', 'r718', null)$c$, v_inv), 'gate');
  perform pg_temp.r718_expect('real sales create_direct_invoice',
    $c$select public.create_direct_invoice('e7180000-0000-4000-8000-0000000000c1', '[{"description":"R718","qty":1,"rate":1000}]'::jsonb, 'R718 sales', false)$c$, 'gate');
  perform pg_temp.r718_expect('real sales redeem_customer_credits', $c$select public.redeem_customer_credits('e7180000-0000-4000-8000-0000000000c1', 100, 'r718')$c$, 'gate');
  perform pg_temp.r718_expect('real sales delete_subscription', $c$select public.delete_subscription('e7180000-0000-4000-8000-0000000005b0')$c$, 'gate');

  perform pg_temp.r718_as('e7180000-0000-4000-8000-0000000000a5');   -- support
  perform pg_temp.r718_expect('real support record_payment', $c$select public.record_payment('Q-R718-VICTIM', 1180, 'cash', 'R718-SUPPORT', null)$c$, 'gate');
  perform pg_temp.r718_expect('real support delete_payment', format('select public.delete_payment(%L)', v_pay), 'gate');

  perform pg_temp.r718_as('e7180000-0000-4000-8000-0000000000a6');   -- billing
  perform pg_temp.r718_expect('real billing delete_payment', format('select public.delete_payment(%L)', v_pay), 'gate');
  perform pg_temp.r718_expect('real billing delete_subscription', $c$select public.delete_subscription('e7180000-0000-4000-8000-0000000005b0')$c$, 'gate');

  perform pg_temp.r718_as('e7180000-0000-4000-8000-0000000000a2');   -- manager
  perform pg_temp.r718_expect('real manager delete_payment', format('select public.delete_payment(%L)', v_pay), 'gate');
  perform pg_temp.r718_expect('real manager delete_subscription', $c$select public.delete_subscription('e7180000-0000-4000-8000-0000000005b0')$c$, 'gate');

  perform pg_temp.r718_as('e7180000-0000-4000-8000-0000000000ff');   -- no company
  perform pg_temp.r718_expect('real no-company record_payment', $c$select public.record_payment('Q-R718-VICTIM', 1180, 'cash', 'R718-NULL', null)$c$, 'gate');

  perform pg_temp.r718_as('e7180000-0000-4000-8000-0000000000b1');   -- owner of company B
  perform pg_temp.r718_expect('real other-company record_payment', $c$select public.record_payment('Q-R718-VICTIM', 1180, 'cash', 'R718-B', null)$c$, 'any');
  perform pg_temp.r718_expect('real other-company delete_payment', format('select public.delete_payment(%L)', v_pay), 'any');
  perform pg_temp.r718_expect('real other-company delete_subscription', $c$select public.delete_subscription('e7180000-0000-4000-8000-0000000005b0')$c$, 'any');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if exists(select 1 from public.payments where quote_id = 'Q-R718-VICTIM') then
    insert into r718_fail(label, detail) values ('untouched', 'a refused caller recorded a payment on the victim quote');
  end if;
  if not exists(select 1 from public.payments where quote_id = 'Q-R718-PAID') then
    insert into r718_fail(label, detail) values ('untouched', 'a refused caller deleted the victim payment');
  end if;
  if not exists(select 1 from public.subscriptions where id = 'e7180000-0000-4000-8000-0000000005b0') then
    insert into r718_fail(label, detail) values ('untouched', 'a refused caller deleted the victim subscription');
  end if;
  if exists(select 1 from public.credit_notes where tenant_id = 'e7180000-0000-0000-0000-0000000000a0') then
    insert into r718_fail(label, detail) values ('untouched', 'a refused caller issued a credit note');
  end if;
  if exists(select 1 from public.quotes where tenant_id = 'e7180000-0000-0000-0000-0000000000a0' and notes = 'R718 sales') then
    insert into r718_fail(label, detail) values ('untouched', 'a refused caller created a direct invoice');
  end if;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = 'e7180000-0000-4000-8000-0000000000c1') <> 500 then
    insert into r718_fail(label, detail) values ('untouched', 'a refused caller spent customer credit');
  end if;
end $$;

-- ── 3. REAL: allowed callers ───────────────────────────────────────────────────────
set local role authenticated;
do $$
declare who record;
begin
  for who in select * from (values
      ('OWNER',      'e7180000-0000-4000-8000-0000000000a1'),
      ('MANAGER',    'e7180000-0000-4000-8000-0000000000a2'),
      ('ACCOUNTANT', 'e7180000-0000-4000-8000-0000000000a3'),
      ('BILLING',    'e7180000-0000-4000-8000-0000000000a6')) w(k, sub) loop
    perform pg_temp.r718_as(who.sub);
    perform pg_temp.r718_expect('real ' || lower(who.k) || ' record_payment',
      format($c$select public.record_payment('Q-R718-%s', 1180, 'bank_transfer', 'R718-%s', null)$c$, who.k, who.k), 'ok');
  end loop;

  perform pg_temp.r718_as('e7180000-0000-4000-8000-0000000000a3');   -- accountant deletes
  perform pg_temp.r718_expect('real accountant delete_payment',
    format('select public.delete_payment(%L)', (select id from public.payments where quote_id = 'Q-R718-ACCOUNTANT')), 'ok');
  perform pg_temp.r718_as('e7180000-0000-4000-8000-0000000000a1');   -- owner deletes
  perform pg_temp.r718_expect('real owner delete_subscription', $c$select public.delete_subscription('e7180000-0000-4000-8000-0000000005b1')$c$, 'ok');
end $$;
reset role;

set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select pg_temp.r718_expect('real service_role record_payment',
  $c$select public.record_payment('Q-R718-SERVICE', 1180, 'razorpay', 'R718-SERVICE', null)$c$, 'ok');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select count(*) from public.payments where quote_id in ('Q-R718-OWNER', 'Q-R718-MANAGER', 'Q-R718-BILLING', 'Q-R718-SERVICE')) <> 4 then
    insert into r718_fail(label, detail) values ('allowed', 'expected 4 receipts (owner, manager, billing, service_role)');
  end if;
  if exists(select 1 from public.payments where quote_id = 'Q-R718-ACCOUNTANT') then
    insert into r718_fail(label, detail) values ('allowed', 'accountant''s delete_payment left the receipt');
  end if;
  if exists(select 1 from public.subscriptions where id = 'e7180000-0000-4000-8000-0000000005b1') then
    insert into r718_fail(label, detail) values ('allowed', 'owner''s delete_subscription left the subscription');
  end if;
end $$;

-- ── Verdict ───────────────────────────────────────────────────────────────────────
do $$
declare v text;
begin
  select string_agg(format('  FAIL %s: %s', label, detail), E'\n' order by n) into v from r718_fail;
  if v is not null then
    raise exception E'r718_money_roles — % failure(s):\n%', (select count(*) from r718_fail), v;
  end if;
  raise notice 'PASS r718_money_roles';
end $$;

rollback;
