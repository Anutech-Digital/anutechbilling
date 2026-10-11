\set ON_ERROR_STOP on
-- R-715 (P1 SECURITY, audit 10 Oct 2026): the remaining SECURITY DEFINER functions that take a
-- tenant / record id must not act on another company's rows, and must not serve a
-- "null-caller" (signed-in login with no public.users row → current_tenant_id() NULL).
-- Migration 20261011045500_r715_definers_tenant.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r715_definers_tenant.test.sql
--
-- Expect "PASS r715_definers_tenant". On the old bodies it stops at the first hole
-- ("FAIL null-caller redeem_coupon: expected 42501, call succeeded", proved 11 Oct 2026).
--
-- Server-only functions (revoked from authenticated/anon): redeem_coupon, _employee_advance_cash_leg,
--   quote_split_due, split_outstanding_for, invoice_party_snapshot, payment_run_outstanding,
--   get_active_site_promo → any signed-in caller is refused (42501); service_role / other
--   definers still use them.
-- Guarded (still callable by signed-in users of the right company):
--   suggest_bank_transaction_matches, sync_split_outstanding, create_project_quote,
--   create_project_sale, create_project_direct_invoice, get_subordinate_user_ids.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e7150000-0000-4000-8000-00000000000a', 'r715-owner-a@example.test'),
  ('e7150000-0000-4000-8000-00000000000b', 'r715-owner-b@example.test'),
  ('e7150000-0000-4000-8000-00000000000f', 'r715-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code, gstin) values
  ('e7150000-0000-0000-0000-0000000000a1', 'R715 A', 'r715a@example.in', '07', 'R75A', '07AAAAA7150A1Z5'),
  ('e7150000-0000-0000-0000-0000000000b1', 'R715 B', 'r715b@example.in', '07', 'R75B', null);

-- The null-caller has NO public.users row.
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e7150000-0000-4000-8000-00000000000a', 'e7150000-0000-0000-0000-0000000000a1', 'r715-owner-a@example.in', 'R715 Owner A', 'owner', true),
  ('e7150000-0000-4000-8000-00000000000b', 'e7150000-0000-0000-0000-0000000000b1', 'r715-owner-b@example.in', 'R715 Owner B', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country, gstin, address) values
  ('e7150000-0000-4000-8000-0000000000c1', 'e7150000-0000-0000-0000-0000000000a1', 'R715 Cust A', '07', 'India', '07BBBBB7150B1Z5', 'R715 secret street'),
  ('e7150000-0000-4000-8000-0000000000c2', 'e7150000-0000-0000-0000-0000000000b1', 'R715 Cust B', '07', 'India', null, null);

insert into public.coupons (code, tenant_id, discount_type, discount_value, is_active) values
  ('R715SECRET', 'e7150000-0000-0000-0000-0000000000a1', 'flat', 100, true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type) values
  ('e7150000-0000-4000-8000-0000000000ba', 'e7150000-0000-0000-0000-0000000000a1', 'R715 Bank', 'R715 Bank', 'current'),
  ('e7150000-0000-4000-8000-0000000000ca', 'e7150000-0000-0000-0000-0000000000a1', 'R715 Cash', 'Cash', 'cash');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit) values
  ('e7150000-0000-4000-8000-0000000000b7', 'e7150000-0000-0000-0000-0000000000a1', 'e7150000-0000-4000-8000-0000000000ba',
   date '2026-10-01', 'R715 debit', 4321, 0);

insert into public.expenses (id, tenant_id, category, expense_date, amount, vendor_name, paid) values
  ('EXP-R715-1', 'e7150000-0000-0000-0000-0000000000a1', 'Software', date '2026-10-01', 4321, 'R715 Secret Vendor', false);

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status,
                           payment_status, line_items, billing_cycle) values
  ('Q-R715-QTR', 'e7150000-0000-0000-0000-0000000000a1', null, 'e7150000-0000-4000-8000-0000000000c1', 'R715 Cust A',
   30586, 25920, 18, 'accepted', 'awaiting', '[]'::jsonb, 'quarterly');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id) values
  ('e7150000-0000-4000-8000-0000000000e1', 'e7150000-0000-0000-0000-0000000000a1', 'e7150000-0000-4000-8000-0000000000c1',
   'R715 Cust A', 'Workspace Starter', 'google'::vendor, 8, 2160, 'quarterly'::billing_cycle, 'Q-R715-QTR');

insert into public.site_promos (id, tenant_id, headline, discount_type, discount_value, is_active) values
  ('SP-R715', 'e7150000-0000-0000-0000-0000000000a1', 'R715 internal promo', 'flat', 50, true);

/* Runs one call and checks how it ended. want = SQLSTATE expected, 'any', 'ok', or 'empty'
   ('empty' = succeeded and returned no row / a NULL). */
create function pg_temp.r715_expect(label text, call text, want text) returns void
language plpgsql as $f$
declare v_state text; v_msg text; v_n bigint;
begin
  begin
    execute 'select count(*) from (' || call || ') r715_q where r715_q is not null' into v_n;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if want in ('ok', 'empty') then
      raise exception 'FAIL %: expected %, got % (%)', label, want, v_state, v_msg;
    elsif want = 'any' or v_state = want then
      raise notice 'ok   %: refused % (%)', label, v_state, left(v_msg, 70);
      return;
    else
      raise exception 'FAIL %: expected %, got % (%)', label, want, v_state, v_msg;
    end if;
  end;
  if want = 'empty' then
    if v_n > 0 then raise exception 'FAIL %: expected nothing, got % row(s)', label, v_n; end if;
    raise notice 'ok   %: nothing returned', label;
    return;
  end if;
  if want <> 'ok' then
    raise exception 'FAIL %: expected %, call succeeded (% row(s))', label, want, v_n;
  end if;
  if v_n = 0 then raise exception 'FAIL %: expected a result, got nothing', label; end if;
  raise notice 'ok   %: succeeded', label;
end $f$;
grant execute on function pg_temp.r715_expect(text, text, text) to authenticated, service_role;

/* Nothing of company A changed. */
create function pg_temp.r715_untouched(label text) returns void language plpgsql as $f$
begin
  if (select redemption_count from public.coupons where code = 'R715SECRET') <> 0
     or exists(select 1 from public.coupon_redemptions where coupon_code = 'R715SECRET') then
    raise exception 'FAIL %: coupon R715SECRET was burnt', label;
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'e7150000-0000-0000-0000-0000000000a1') <> 1 then
    raise exception 'FAIL %: an entry was written into company A''s cash book', label;
  end if;
  if exists(select 1 from public.project_sales where customer_id = 'e7150000-0000-4000-8000-0000000000c1'
              and tenant_id <> 'e7150000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL %: a project of another company points at company A''s customer', label;
  end if;
end $f$;

/* The calls every untrusted caller is refused / gets nothing from. :who = label. */
create function pg_temp.r715_attack(who text, want_guard text) returns void language plpgsql as $f$
begin
  -- server-only: refused outright
  perform pg_temp.r715_expect(who || ' redeem_coupon',
    $$select public.redeem_coupon('R715SECRET', 'e7150000-0000-0000-0000-0000000000a1', null, 1, 1000)$$, '42501');
  perform pg_temp.r715_expect(who || ' _employee_advance_cash_leg',
    $$select public._employee_advance_cash_leg('e7150000-0000-0000-0000-0000000000a1', 'e7150000-0000-4000-8000-0000000000ca',
        date '2026-10-01', 999, 0, 'R715 attack', gen_random_uuid())$$, '42501');
  perform pg_temp.r715_expect(who || ' quote_split_due',
    $$select public.quote_split_due('Q-R715-QTR', date '2026-10-01', date '2026-10-01')$$, '42501');
  perform pg_temp.r715_expect(who || ' split_outstanding_for',
    $$select public.split_outstanding_for('Q-R715-QTR', date '2026-10-01')$$, '42501');
  perform pg_temp.r715_expect(who || ' invoice_party_snapshot',
    $$select * from public.invoice_party_snapshot('e7150000-0000-0000-0000-0000000000a1', 'e7150000-0000-4000-8000-0000000000c1')$$, '42501');
  perform pg_temp.r715_expect(who || ' payment_run_outstanding',
    $$select public.payment_run_outstanding('e7150000-0000-0000-0000-0000000000a1', 'expense', 'EXP-R715-1')$$, '42501');
  perform pg_temp.r715_expect(who || ' get_active_site_promo',
    $$select (public.get_active_site_promo('e7150000-0000-0000-0000-0000000000a1')).id$$, '42501');
  -- guarded: refused (null-caller) or nothing (other company)
  perform pg_temp.r715_expect(who || ' suggest_bank_transaction_matches',
    $$select * from public.suggest_bank_transaction_matches('e7150000-0000-4000-8000-0000000000b7')$$, want_guard);
  perform pg_temp.r715_expect(who || ' sync_split_outstanding',
    $$select public.sync_split_outstanding('e7150000-0000-4000-8000-0000000000e1')$$, '42501');
  perform pg_temp.r715_expect(who || ' get_subordinate_user_ids',
    $$select * from public.get_subordinate_user_ids('e7150000-0000-4000-8000-00000000000a')$$, 'empty');
end $f$;
grant execute on function pg_temp.r715_attack(text, text) to authenticated;

-- ── 1. Null-caller (signed in, no company) ───────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e7150000-0000-4000-8000-00000000000f"}', true);
select pg_temp.r715_attack('null-caller', '42501');
select pg_temp.r715_expect('null-caller create_project_quote',
  $$select public.create_project_quote('e7150000-0000-4000-8000-0000000000c1', 'x', 'R715 t', null, '[{"amount":100}]', 18, false, '[]')$$, 'any');
select pg_temp.r715_expect('null-caller create_project_sale',
  $$select public.create_project_sale('e7150000-0000-4000-8000-0000000000c1', 'x', 'R715 t', null, 100, 18, false, '[]')$$, 'any');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.r715_untouched('null-caller');
do $$ begin raise notice 'PASS 1 null-caller: all refused, nothing changed'; end $$;

-- ── 2. Other company (owner of B on A's rows) ────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e7150000-0000-4000-8000-00000000000b"}', true);
select pg_temp.r715_attack('other-company', 'empty');
select pg_temp.r715_expect('other-company create_project_quote (A''s customer)',
  $$select public.create_project_quote('e7150000-0000-4000-8000-0000000000c1', 'R715 Cust A', 'R715 t', null, '[{"amount":100}]', 18, false, '[]')$$, '42501');
select pg_temp.r715_expect('other-company create_project_sale (A''s customer)',
  $$select public.create_project_sale('e7150000-0000-4000-8000-0000000000c1', 'R715 Cust A', 'R715 t', null, 100, 18, false, '[]')$$, '42501');
select pg_temp.r715_expect('other-company create_project_direct_invoice (A''s customer)',
  $$select * from public.create_project_direct_invoice('e7150000-0000-4000-8000-0000000000c1', 'R715 Cust A', 'R715 t', null, '[{"amount":100}]', 18, false)$$, '42501');
-- their own customer still works
select pg_temp.r715_expect('company B create_project_quote (own customer)',
  $$select public.create_project_quote('e7150000-0000-4000-8000-0000000000c2', 'R715 Cust B', 'R715 own', null, '[{"amount":100}]', 18, false, '[]')$$, 'ok');
select pg_temp.r715_expect('company B create_project_sale (no customer id)',
  $$select public.create_project_sale(null, 'R715 New Cust B', 'R715 own', null, 100, 18, false, '[]')$$, 'ok');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.r715_untouched('other-company');
do $$ begin raise notice 'PASS 2 other company: all refused / nothing returned, nothing changed'; end $$;

-- ── 3. Own company (owner of A) ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e7150000-0000-4000-8000-00000000000a"}', true);
select pg_temp.r715_expect('own suggest_bank_transaction_matches',
  $$select * from public.suggest_bank_transaction_matches('e7150000-0000-4000-8000-0000000000b7')$$, 'ok');
select pg_temp.r715_expect('own sync_split_outstanding',
  $$select public.sync_split_outstanding('e7150000-0000-4000-8000-0000000000e1')$$, 'ok');
select pg_temp.r715_expect('own get_subordinate_user_ids',
  $$select * from public.get_subordinate_user_ids('e7150000-0000-4000-8000-00000000000a')$$, 'ok');
select pg_temp.r715_expect('own create_project_quote',
  $$select public.create_project_quote('e7150000-0000-4000-8000-0000000000c1', 'R715 Cust A', 'R715 own', null, '[{"amount":100}]', 18, false, '[]')$$, 'ok');
select pg_temp.r715_expect('own create_project_sale',
  $$select public.create_project_sale('e7150000-0000-4000-8000-0000000000c1', 'R715 Cust A', 'R715 own', null, 100, 18, false, '[]')$$, 'ok');
select pg_temp.r715_expect('own create_project_direct_invoice',
  $$select * from public.create_project_direct_invoice('e7150000-0000-4000-8000-0000000000c1', 'R715 Cust A', 'R715 own', null, '[{"amount":100}]', 18, false)$$, 'ok');
-- server-only functions are server-only for the own company too (no app code calls them)
select pg_temp.r715_expect('own redeem_coupon (server-only)',
  $$select public.redeem_coupon('R715SECRET', 'e7150000-0000-0000-0000-0000000000a1', null, 1, 1000)$$, '42501');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select count(*) from public.project_sales where tenant_id = 'e7150000-0000-0000-0000-0000000000a1'
        and customer_id = 'e7150000-0000-4000-8000-0000000000c1') <> 3 then
    raise exception 'FAIL own: expected 3 projects for own customer';
  end if;
  if not exists(select 1 from public.invoices where tenant_id = 'e7150000-0000-0000-0000-0000000000a1'
                  and customer_id = 'e7150000-0000-4000-8000-0000000000c1'
                  and customer_gstin = '07BBBBB7150B1Z5') then
    raise exception 'FAIL own: direct invoice missing or party snapshot (trigger → invoice_party_snapshot) not filled';
  end if;
  raise notice 'PASS 3 own company: guarded functions work; invoice party snapshot still filled by the trigger';
end $$;

-- ── 4. Service role (admin client: checkout coupon, billing cron) ─────────────
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.r715_expect('service redeem_coupon',
  $$select public.redeem_coupon('R715SECRET', 'e7150000-0000-0000-0000-0000000000a1', null, 1, 1000)$$, 'ok');
select pg_temp.r715_expect('service sync_split_outstanding',
  $$select public.sync_split_outstanding('e7150000-0000-4000-8000-0000000000e1')$$, 'ok');
select pg_temp.r715_expect('service quote_split_due',
  $$select public.quote_split_due('Q-R715-QTR', date '2026-10-01', date '2026-10-01')$$, 'ok');
select pg_temp.r715_expect('service payment_run_outstanding',
  $$select public.payment_run_outstanding('e7150000-0000-0000-0000-0000000000a1', 'expense', 'EXP-R715-1')$$, 'ok');
select pg_temp.r715_expect('service get_active_site_promo',
  $$select (public.get_active_site_promo('e7150000-0000-0000-0000-0000000000a1')).id$$, 'ok');
select pg_temp.r715_expect('service suggest_bank_transaction_matches',
  $$select * from public.suggest_bank_transaction_matches('e7150000-0000-4000-8000-0000000000b7')$$, 'ok');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select redemption_count from public.coupons where code = 'R715SECRET') <> 1 then
    raise exception 'FAIL service: coupon redemption not counted once';
  end if;
  if (select pg_get_functiondef('public.redeem_coupon(text,uuid,text,integer,integer,text,text,text,text)'::regprocedure))
       !~ 'where code = v_coupon\.code\s+and tenant_id = p_tenant_id' then
    raise exception 'FAIL redeem_coupon: redemption_count UPDATE does not filter tenant_id';
  end if;
  raise notice 'PASS 4 service role: coupon redeem, split sync/due, payment-run amount, site promo, bank match work';
end $$;

do $$ begin raise notice 'PASS r715_definers_tenant'; end $$;

rollback;
