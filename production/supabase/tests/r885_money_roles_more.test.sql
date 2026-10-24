\set ON_ERROR_STOP on
-- R-885 (R-718b, P1 SECURITY): the remaining money SECURITY DEFINER functions check the
-- caller's ROLE, not only the company. Migration *_r885_money_roles_more. Pardeep's role table
-- (R-718, 11 Oct 2026):
--   rec  record / book / reconcile / issue / raise: owner, manager, accountant, billing
--   pay  salary / loan / expense claim / statutory (R-717 rule) + the payroll salary Undo
--        (delete_salary_payment, also used by Edit salary): owner, manager, accountant
--   del  deletes: owner, accountant
--   sales, sales_senior, support, delivery, a no-company login: none
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r885_money_roles_more.test.sql
--
-- Expect "PASS r885_money_roles_more". Every check is collected first and the failures listed
-- together, so on the old bodies the run names EVERY open function.
--
--   GATE    each refused caller × each of the 22 functions → SQLSTATE 42501 "Only … can …"
--   GATE    each allowed caller (and service_role) gets PAST the gate (any other outcome)
--   REAL    sales / manager delete a customer, sales / billing / support move money from a bank
--           account (staff loan, statutory dues, business loan), sales deletes a bank account —
--           refused, nothing changes
--   REAL    owner deletes a customer, accountant deletes a bank account, manager gives a staff
--           loan, accountant pays statutory dues, billing records a business loan — succeed
--   TENANT  owner of company B on company A's customer / bank account — refused, untouched
--   NESTED  sales "Activate now, pay later" (activate_quote_on_credit → generate_invoice) still
--           issues the invoice; a pg_temp function with the same name does NOT unlock the gate

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address (supplier_invoice_problem).
-- Every company this test creates gets both unless the test sets them itself (an unregistered
-- one gets only the address). Rolled back with the test.
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

insert into auth.users (id, email) values
  ('e8850000-0000-4000-8000-0000000000a1', 'r885-owner@example.test'),
  ('e8850000-0000-4000-8000-0000000000a2', 'r885-manager@example.test'),
  ('e8850000-0000-4000-8000-0000000000a3', 'r885-accountant@example.test'),
  ('e8850000-0000-4000-8000-0000000000a4', 'r885-sales@example.test'),
  ('e8850000-0000-4000-8000-0000000000a5', 'r885-support@example.test'),
  ('e8850000-0000-4000-8000-0000000000a6', 'r885-billing@example.test'),
  ('e8850000-0000-4000-8000-0000000000a7', 'r885-delivery@example.test'),
  ('e8850000-0000-4000-8000-0000000000a8', 'r885-sales-senior@example.test'),
  ('e8850000-0000-4000-8000-0000000000b1', 'r885-owner-b@example.test'),
  ('e8850000-0000-4000-8000-0000000000ff', 'r885-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e8850000-0000-0000-0000-0000000000a0', 'R885 A', 'r885a@example.in', '07', 'R85A'),
  ('e8850000-0000-0000-0000-0000000000b0', 'R885 B', 'r885b@example.in', '07', 'R85B');

-- The no-company caller has NO public.users row.
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('e8850000-0000-4000-8000-0000000000a1', 'e8850000-0000-0000-0000-0000000000a0', 'r885-owner@example.in',        'R885 Owner',        'owner',        true, now() - interval '1 day'),
  ('e8850000-0000-4000-8000-0000000000a2', 'e8850000-0000-0000-0000-0000000000a0', 'r885-manager@example.in',      'R885 Manager',      'manager',      true, now()),
  ('e8850000-0000-4000-8000-0000000000a3', 'e8850000-0000-0000-0000-0000000000a0', 'r885-accountant@example.in',   'R885 Accountant',   'accountant',   true, now()),
  ('e8850000-0000-4000-8000-0000000000a4', 'e8850000-0000-0000-0000-0000000000a0', 'r885-sales@example.in',        'R885 Sales',        'sales',        true, now()),
  ('e8850000-0000-4000-8000-0000000000a5', 'e8850000-0000-0000-0000-0000000000a0', 'r885-support@example.in',      'R885 Support',      'support',      true, now()),
  ('e8850000-0000-4000-8000-0000000000a6', 'e8850000-0000-0000-0000-0000000000a0', 'r885-billing@example.in',      'R885 Billing',      'billing',      true, now()),
  ('e8850000-0000-4000-8000-0000000000a7', 'e8850000-0000-0000-0000-0000000000a0', 'r885-delivery@example.in',     'R885 Delivery',     'delivery',     true, now()),
  ('e8850000-0000-4000-8000-0000000000a8', 'e8850000-0000-0000-0000-0000000000a0', 'r885-sales-senior@example.in', 'R885 Sales Senior', 'sales_senior', true, now()),
  ('e8850000-0000-4000-8000-0000000000b1', 'e8850000-0000-0000-0000-0000000000b0', 'r885-owner-b@example.in',      'R885 Owner B',      'owner',        true, now());

-- Customers with no financial records (deletable): C1 = victim, C2 = the owner deletes it.
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('e8850000-0000-4000-8000-0000000000c1', 'e8850000-0000-0000-0000-0000000000a0', 'R885 Victim', '07', 'India', null),
  ('e8850000-0000-4000-8000-0000000000c2', 'e8850000-0000-0000-0000-0000000000a0', 'R885 Gone',   '07', 'India', null),
  ('e8850000-0000-4000-8000-0000000000c3', 'e8850000-0000-0000-0000-0000000000a0', 'R885 Credit', '07', 'India', 'credit885.in');

-- Bank accounts: BA1 = the money source, BA2 = the accountant deletes it.
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e8850000-0000-4000-8000-0000000000d1', 'e8850000-0000-0000-0000-0000000000a0', 'R885 Current', 'R885 Bank'),
  ('e8850000-0000-4000-8000-0000000000d2', 'e8850000-0000-0000-0000-0000000000a0', 'R885 Old',     'R885 Bank');

-- A monthly-only quote that sales may activate on credit (credit_annual_block.test.sql, R-368).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
values ('Q-R885-M', 'e8850000-0000-0000-0000-0000000000a0', 'e8850000-0000-4000-8000-0000000000c3', 'R885 Credit',
        590, 500, 0, 18, 'accepted', 'awaiting',
        '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"m.credit885.in"}]'::jsonb),
       ('Q-R885-S', 'e8850000-0000-0000-0000-0000000000a0', 'e8850000-0000-4000-8000-0000000000c3', 'R885 Credit',
        1180, 1000, 0, 18, 'accepted', 'received',
        '[]'::jsonb);

create temp table r885_fail (n serial, label text, detail text);
grant all on r885_fail to authenticated, service_role;
grant usage on sequence r885_fail_n_seq to authenticated, service_role;

/* Runs one call as the CURRENT role/claims and records how it ended.
   want: 'gate' = refused by a role gate (42501 "Only … can …");
         'pass' = NOT refused by a role gate (any other error or success);
         'ok'   = succeeded;  'any' = any error. Failures are collected, not raised. */
create function pg_temp.r885_expect(label text, call text, want text) returns void
language plpgsql as $f$
declare v_state text; v_msg text; v_gate boolean;
begin
  begin
    execute call;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_gate := v_state = '42501' and v_msg like 'Only %can %';
    if want = 'gate' and not v_gate then
      insert into r885_fail(label, detail) values (label, format('expected the role gate, got %s (%s)', v_state, left(v_msg, 90)));
    elsif want = 'pass' and v_gate then
      insert into r885_fail(label, detail) values (label, format('allowed caller refused by the role gate (%s)', v_msg));
    elsif want = 'ok' then
      insert into r885_fail(label, detail) values (label, format('expected success, got %s (%s)', v_state, left(v_msg, 90)));
    else
      raise notice 'ok   %: % (%)', label, v_state, left(v_msg, 70);
    end if;
    return;
  end;
  if want in ('gate', 'any') then
    insert into r885_fail(label, detail) values (label, format('expected %s, call SUCCEEDED', want));
    return;
  end if;
  raise notice 'ok   %: succeeded', label;
end $f$;
grant execute on function pg_temp.r885_expect(text, text, text) to authenticated, service_role;

/* One harmless call per function (ids that do not exist / invalid amounts) — reaches the gate,
   changes nothing. grp: 'rec' / 'pay' / 'del' as in the header. */
create function pg_temp.r885_calls() returns table(fn text, grp text, call text)
language sql as $f$
  select * from (values
    ('generate_invoice',                'rec', $c$select public.generate_invoice('Q-R885-NONE')$c$),
    ('raise_subscription_billing',      'rec', $c$select public.raise_subscription_billing('00000000-0000-4000-8000-000000000885')$c$),
    ('record_project_payment',          'rec', $c$select public.record_project_payment('00000000-0000-4000-8000-000000000885', 100, 'bank_transfer', 'x', '2026-10-05', null)$c$),
    ('record_project_receipt_with_tds', 'rec', $c$select public.record_project_receipt_with_tds('00000000-0000-4000-8000-000000000885', 90, 10, '194J', 10, 100, '2026-10-05', null, 'x', false)$c$),
    ('reconcile_expenses_to_bank_txn',  'rec', $c$select public.reconcile_expenses_to_bank_txn('00000000-0000-4000-8000-000000000885', array['EXP-R885-NONE'])$c$),
    ('record_business_loan',            'rec', $c$select public.record_business_loan('x', 'x', 0, 0, 1, 0, '2026-10-05', null)$c$),
    ('record_loan_emi',                 'rec', $c$select public.record_loan_emi('00000000-0000-4000-8000-000000000885', 100, 0, '2026-10-05', null, null)$c$),
    ('record_emi_purchase',             'rec', $c$select public.record_emi_purchase('x', 'x', 0, 0, 1, 0, '2026-10-05', null, null, null)$c$),
    ('record_emi_payment',              'rec', $c$select public.record_emi_payment('00000000-0000-4000-8000-000000000885', 100, 0, '2026-10-05', null, null)$c$),
    ('disburse_employee_loan',          'pay', $c$select public.disburse_employee_loan('x', 0, '2026-10-05', '00000000-0000-4000-8000-000000000885', 'loan', null)$c$),
    ('edit_employee_loan',              'pay', $c$select public.edit_employee_loan('00000000-0000-4000-8000-000000000885', 'x', 0, '2026-10-05', null, 'loan', null)$c$),
    ('record_employee_loan_repayment',  'pay', $c$select public.record_employee_loan_repayment('00000000-0000-4000-8000-000000000885', 0, '2026-10-05', 'cash', null, null)$c$),
    ('pay_statutory_dues',              'pay', $c$select public.pay_statutory_dues(0, 'pf', '2026-10-05', '00000000-0000-4000-8000-000000000885', null, null, null)$c$),
    ('reconcile_salaries_to_bank_txn',  'pay', $c$select public.reconcile_salaries_to_bank_txn('00000000-0000-4000-8000-000000000885', array['00000000-0000-4000-8000-000000000885'::uuid])$c$),
    ('reject_expense_claim',            'pay', $c$select public.reject_expense_claim('00000000-0000-4000-8000-000000000885', null)$c$),
    ('edit_expense_claim',              'pay', $c$select public.edit_expense_claim('00000000-0000-4000-8000-000000000885', 0, 'x', null, null)$c$),
    ('delete_salary_payment',           'pay', $c$select public.delete_salary_payment('00000000-0000-4000-8000-000000000885')$c$),
    ('delete_customer',                 'del', $c$select public.delete_customer('00000000-0000-4000-8000-000000000885')$c$),
    ('delete_bank_account',             'del', $c$select public.delete_bank_account('00000000-0000-4000-8000-000000000885')$c$),
    ('delete_employee_loan',            'del', $c$select public.delete_employee_loan('00000000-0000-4000-8000-000000000885')$c$),
    ('delete_expense_claim',            'del', $c$select public.delete_expense_claim('00000000-0000-4000-8000-000000000885')$c$),
    ('delete_business_loan',            'del', $c$select public.delete_business_loan('00000000-0000-4000-8000-000000000885')$c$)
  ) v(fn, grp, call)
$f$;
grant execute on function pg_temp.r885_calls() to authenticated, service_role;

create function pg_temp.r885_as(sub text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', sub)::text, true);
end $f$;
grant execute on function pg_temp.r885_as(text) to authenticated;

-- ── 1. GATE: every caller × every function ─────────────────────────────────────────
set local role authenticated;
do $$
declare r record; who record; v_want text;
begin
  for who in select * from (values
      ('owner',        'e8850000-0000-4000-8000-0000000000a1', array['rec', 'pay', 'del']),
      ('manager',      'e8850000-0000-4000-8000-0000000000a2', array['rec', 'pay']),
      ('accountant',   'e8850000-0000-4000-8000-0000000000a3', array['rec', 'pay', 'del']),
      ('billing',      'e8850000-0000-4000-8000-0000000000a6', array['rec']),
      ('sales',        'e8850000-0000-4000-8000-0000000000a4', array[]::text[]),
      ('sales_senior', 'e8850000-0000-4000-8000-0000000000a8', array[]::text[]),
      ('support',      'e8850000-0000-4000-8000-0000000000a5', array[]::text[]),
      ('delivery',     'e8850000-0000-4000-8000-0000000000a7', array[]::text[]),
      ('no-company',   'e8850000-0000-4000-8000-0000000000ff', array[]::text[])) w(label, sub, may) loop
    perform pg_temp.r885_as(who.sub);
    for r in select * from pg_temp.r885_calls() loop
      v_want := case when r.grp = any(who.may) then 'pass'
                     /* R-454 refuses a no-company login first (28000) on these two */
                     when who.label = 'no-company' and r.fn in ('generate_invoice', 'raise_subscription_billing') then 'any'
                     else 'gate' end;
      perform pg_temp.r885_expect(who.label || ' ' || r.fn, r.call, v_want);
    end loop;
  end loop;
end $$;
reset role;

-- service_role (admin client: billing cron, raise-instalments, online checkout, webhooks) passes.
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
do $$
declare r record;
begin
  for r in select * from pg_temp.r885_calls() loop
    perform pg_temp.r885_expect('service_role ' || r.fn, r.call, 'pass');
  end loop;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ── 2. REAL: refused callers on company A's real rows — nothing may change ─────────
set local role authenticated;
do $$
begin
  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a4');   -- sales
  perform pg_temp.r885_expect('real sales delete_customer', $c$select public.delete_customer('e8850000-0000-4000-8000-0000000000c1')$c$, 'gate');
  perform pg_temp.r885_expect('real sales delete_bank_account', $c$select public.delete_bank_account('e8850000-0000-4000-8000-0000000000d1')$c$, 'gate');
  perform pg_temp.r885_expect('real sales disburse_employee_loan',
    $c$select public.disburse_employee_loan('R885 Sales Self', 50000, '2026-10-05', 'e8850000-0000-4000-8000-0000000000d1', 'loan', 'r885')$c$, 'gate');
  perform pg_temp.r885_expect('real sales record_business_loan',
    $c$select public.record_business_loan('R885 Sales Lender', 'x', 100000, 10, 12, 9000, '2026-10-05', 'e8850000-0000-4000-8000-0000000000d1')$c$, 'gate');
  perform pg_temp.r885_expect('real sales generate_invoice', $c$select public.generate_invoice('Q-R885-S')$c$, 'gate');

  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a5');   -- support
  perform pg_temp.r885_expect('real support pay_statutory_dues',
    $c$select public.pay_statutory_dues(5000, 'pf', '2026-10-05', 'e8850000-0000-4000-8000-0000000000d1', 'r885 support', null, null)$c$, 'gate');

  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a6');   -- billing (payroll is not billing's)
  perform pg_temp.r885_expect('real billing disburse_employee_loan',
    $c$select public.disburse_employee_loan('R885 Billing Self', 50000, '2026-10-05', 'e8850000-0000-4000-8000-0000000000d1', 'loan', 'r885')$c$, 'gate');
  perform pg_temp.r885_expect('real billing delete_customer', $c$select public.delete_customer('e8850000-0000-4000-8000-0000000000c1')$c$, 'gate');

  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a2');   -- manager (no deletes)
  perform pg_temp.r885_expect('real manager delete_customer', $c$select public.delete_customer('e8850000-0000-4000-8000-0000000000c1')$c$, 'gate');
  perform pg_temp.r885_expect('real manager delete_bank_account', $c$select public.delete_bank_account('e8850000-0000-4000-8000-0000000000d1')$c$, 'gate');

  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000ff');   -- no company
  perform pg_temp.r885_expect('real no-company delete_customer', $c$select public.delete_customer('e8850000-0000-4000-8000-0000000000c1')$c$, 'gate');

  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000b1');   -- owner of company B
  perform pg_temp.r885_expect('real other-company delete_customer', $c$select public.delete_customer('e8850000-0000-4000-8000-0000000000c1')$c$, 'any');
  perform pg_temp.r885_expect('real other-company delete_bank_account', $c$select public.delete_bank_account('e8850000-0000-4000-8000-0000000000d1')$c$, 'any');
  perform pg_temp.r885_expect('real other-company disburse_employee_loan',
    $c$select public.disburse_employee_loan('R885 B', 50000, '2026-10-05', 'e8850000-0000-4000-8000-0000000000d1', 'loan', 'r885')$c$, 'any');
  perform pg_temp.r885_expect('real other-company generate_invoice', $c$select public.generate_invoice('Q-R885-S')$c$, 'any');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if not exists(select 1 from public.customers where id = 'e8850000-0000-4000-8000-0000000000c1') then
    insert into r885_fail(label, detail) values ('untouched', 'a refused caller deleted the victim customer');
  end if;
  if not exists(select 1 from public.bank_accounts where id = 'e8850000-0000-4000-8000-0000000000d1') then
    insert into r885_fail(label, detail) values ('untouched', 'a refused caller deleted the bank account');
  end if;
  if exists(select 1 from public.employee_loans where tenant_id = 'e8850000-0000-0000-0000-0000000000a0') then
    insert into r885_fail(label, detail) values ('untouched', 'a refused caller gave a staff loan');
  end if;
  if exists(select 1 from public.business_loans where tenant_id = 'e8850000-0000-0000-0000-0000000000a0') then
    insert into r885_fail(label, detail) values ('untouched', 'a refused caller recorded a business loan');
  end if;
  if exists(select 1 from public.statutory_dues_payments where tenant_id = 'e8850000-0000-0000-0000-0000000000a0') then
    insert into r885_fail(label, detail) values ('untouched', 'a refused caller paid statutory dues');
  end if;
  if exists(select 1 from public.bank_transactions where tenant_id = 'e8850000-0000-0000-0000-0000000000a0') then
    insert into r885_fail(label, detail) values ('untouched', 'a refused caller wrote a bank line');
  end if;
  if exists(select 1 from public.invoices where tenant_id = 'e8850000-0000-0000-0000-0000000000a0') then
    insert into r885_fail(label, detail) values ('untouched', 'a refused caller issued an invoice');
  end if;
end $$;

-- ── 3. REAL: allowed callers ───────────────────────────────────────────────────────
set local role authenticated;
do $$
begin
  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a1');   -- owner deletes a customer
  perform pg_temp.r885_expect('real owner delete_customer', $c$select public.delete_customer('e8850000-0000-4000-8000-0000000000c2')$c$, 'ok');
  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a3');   -- accountant
  perform pg_temp.r885_expect('real accountant delete_bank_account', $c$select public.delete_bank_account('e8850000-0000-4000-8000-0000000000d2')$c$, 'ok');
  perform pg_temp.r885_expect('real accountant pay_statutory_dues',
    $c$select public.pay_statutory_dues(5000, 'pf', '2026-10-05', 'e8850000-0000-4000-8000-0000000000d1', 'r885 accountant', null, null)$c$, 'ok');
  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a2');   -- manager gives a staff loan
  perform pg_temp.r885_expect('real manager disburse_employee_loan',
    $c$select public.disburse_employee_loan('R885 Staff', 20000, '2026-10-05', 'e8850000-0000-4000-8000-0000000000d1', 'loan', 'r885')$c$, 'ok');
  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a6');   -- billing records a business loan
  perform pg_temp.r885_expect('real billing record_business_loan',
    $c$select public.record_business_loan('R885 Lender', 'x', 100000, 10, 12, 9000, '2026-10-05', 'e8850000-0000-4000-8000-0000000000d1')$c$, 'ok');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if exists(select 1 from public.customers where id = 'e8850000-0000-4000-8000-0000000000c2') then
    insert into r885_fail(label, detail) values ('allowed', 'owner''s delete_customer left the customer');
  end if;
  if exists(select 1 from public.bank_accounts where id = 'e8850000-0000-4000-8000-0000000000d2') then
    insert into r885_fail(label, detail) values ('allowed', 'accountant''s delete_bank_account left the account');
  end if;
  if (select count(*) from public.employee_loans where tenant_id = 'e8850000-0000-0000-0000-0000000000a0' and employee_name = 'R885 Staff') <> 1 then
    insert into r885_fail(label, detail) values ('allowed', 'manager''s staff loan missing');
  end if;
  if (select count(*) from public.statutory_dues_payments where tenant_id = 'e8850000-0000-0000-0000-0000000000a0') <> 1 then
    insert into r885_fail(label, detail) values ('allowed', 'accountant''s statutory payment missing');
  end if;
  if (select count(*) from public.business_loans where tenant_id = 'e8850000-0000-0000-0000-0000000000a0') <> 1 then
    insert into r885_fail(label, detail) values ('allowed', 'billing''s business loan missing');
  end if;
end $$;

-- ── 4. NESTED: "Activate now, pay later" by sales still issues its invoice ─────────
-- (activate_quote_on_credit has its own rules — any active member; annual / over limit =
--  owner — and calls generate_invoice with the same caller.)
do $$
declare r jsonb;
begin
  perform pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a4');
  begin
    r := public.activate_quote_on_credit('Q-R885-M', 15);
    if r->>'invoice_id' is null or not exists(select 1 from public.invoices where id = r->>'invoice_id') then
      insert into r885_fail(label, detail) values ('nested', 'sales activation on credit made no invoice');
    end if;
  exception when others then
    insert into r885_fail(label, detail) values ('nested', 'sales activation on credit failed: ' || sqlerrm);
  end;
end $$;
select set_config('request.jwt.claims', '', true);

-- A function of the same name in pg_temp does not unlock the gate (shown as pg_temp_N.…).
create function pg_temp.activate_quote_on_credit(q text) returns void language plpgsql as $f$
begin perform public.generate_invoice(q); end $f$;
grant execute on function pg_temp.activate_quote_on_credit(text) to authenticated;
set local role authenticated;
select pg_temp.r885_as('e8850000-0000-4000-8000-0000000000a4');
select pg_temp.r885_expect('spoof pg_temp.activate_quote_on_credit → generate_invoice',
  $c$select pg_temp.activate_quote_on_credit('Q-R885-S')$c$, 'gate');
reset role;
select set_config('request.jwt.claims', '', true);

-- ── Verdict ───────────────────────────────────────────────────────────────────────
do $$
declare v text;
begin
  select string_agg(format('  FAIL %s: %s', label, detail), E'\n' order by n) into v from r885_fail;
  if v is not null then
    raise exception E'r885_money_roles_more — % failure(s):\n%', (select count(*) from r885_fail), v;
  end if;
  raise notice 'PASS r885_money_roles_more';
end $$;

rollback;
