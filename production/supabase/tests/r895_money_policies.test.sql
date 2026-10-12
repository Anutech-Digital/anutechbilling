\set ON_ERROR_STOP on
-- R-895 (P1): sales / sales_senior / support / delivery write no money rows (Pardeep's R-718
-- table), and a payment that fails never consumes a customer's advance credit.
-- Migration: 20261012031823_r895_money_policies (record_desk_payment + payments / invoices / vendor_bills
-- policies). Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r895_money_policies.test.sql
--
-- Expect "PASS r895_money_policies". Every check is collected and the failures listed together.
--
--   ROLES    sales, sales_senior, support, delivery: payments insert / date+bank update,
--            invoices paid_date, vendor_bills insert, record_desk_payment — all refused,
--            nothing changes, credit untouched
--   BILLING  the same writes succeed
--   CREDIT   record_desk_payment applies credit + records amount + credit + tags date/bank
--            in one go; a payment that FAILS after the credit is applied leaves the credit
--            balance unchanged; a replay (reference already recorded) leaves it unchanged
--            and does not re-tag the earlier payment; another company's bank account is
--            refused and leaves the credit unchanged
--   INVOICE  the payment that settles an invoice moves paid_date to the receipt date

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e8950000-0000-4000-8000-0000000000a1', 'r895-owner@example.test'),
  ('e8950000-0000-4000-8000-0000000000a2', 'r895-billing@example.test'),
  ('e8950000-0000-4000-8000-0000000000a3', 'r895-sales@example.test'),
  ('e8950000-0000-4000-8000-0000000000a4', 'r895-sales-senior@example.test'),
  ('e8950000-0000-4000-8000-0000000000a5', 'r895-support@example.test'),
  ('e8950000-0000-4000-8000-0000000000a6', 'r895-delivery@example.test'),
  ('e8950000-0000-4000-8000-0000000000b1', 'r895-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e8950000-0000-0000-0000-0000000000a0', 'R895 A', 'r895a@example.in', '07', 'R95A'),
  ('e8950000-0000-0000-0000-0000000000b0', 'R895 B', 'r895b@example.in', '07', 'R95B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e8950000-0000-4000-8000-0000000000a1', 'e8950000-0000-0000-0000-0000000000a0', 'r895-owner@example.in',        'R895 Owner',        'owner',        true),
  ('e8950000-0000-4000-8000-0000000000a2', 'e8950000-0000-0000-0000-0000000000a0', 'r895-billing@example.in',      'R895 Billing',      'billing',      true),
  ('e8950000-0000-4000-8000-0000000000a3', 'e8950000-0000-0000-0000-0000000000a0', 'r895-sales@example.in',        'R895 Sales',        'sales',        true),
  ('e8950000-0000-4000-8000-0000000000a4', 'e8950000-0000-0000-0000-0000000000a0', 'r895-sales-senior@example.in', 'R895 Sales Senior', 'sales_senior', true),
  ('e8950000-0000-4000-8000-0000000000a5', 'e8950000-0000-0000-0000-0000000000a0', 'r895-support@example.in',      'R895 Support',      'support',      true),
  ('e8950000-0000-4000-8000-0000000000a6', 'e8950000-0000-0000-0000-0000000000a0', 'r895-delivery@example.in',     'R895 Delivery',     'delivery',     true),
  ('e8950000-0000-4000-8000-0000000000b1', 'e8950000-0000-0000-0000-0000000000b0', 'r895-owner-b@example.in',      'R895 Owner B',      'owner',        true);

-- The sales login manages this customer (R-1004: sales reads only its own customers).
insert into public.customers (id, tenant_id, name, state_code, country, account_manager_id) values
  ('e8950000-0000-4000-8000-0000000000c1', 'e8950000-0000-0000-0000-0000000000a0', 'R895 Cust', '07', 'India',
   'e8950000-0000-4000-8000-0000000000a3');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e8950000-0000-4000-8000-0000000000ba', 'e8950000-0000-0000-0000-0000000000a0', 'R895 Current', 'R895 Bank'),
  ('e8950000-0000-4000-8000-0000000000bb', 'e8950000-0000-0000-0000-0000000000b0', 'R895 B Current', 'R895 B Bank');

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable) values
  ('R895-INV-EDIT', 'e8950000-0000-0000-0000-0000000000a0', 'R895 Cust', 'e8950000-0000-4000-8000-0000000000c1', 1180, 1180),
  ('R895-INV-PAY',  'e8950000-0000-0000-0000-0000000000a0', 'R895 Cust', 'e8950000-0000-4000-8000-0000000000c1', 1180, 1180);

-- One-off quotes (no subscription side effects). INV: invoiced first, paid by billing below.
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id)
select 'Q-R895-' || k, 'e8950000-0000-0000-0000-0000000000a0', null, 'e8950000-0000-4000-8000-0000000000c1',
       'R895 Cust', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb,
       case when k = 'INV' then 'R895-INV-PAY' end
  from unnest(array['ROLE', 'BILL', 'FAIL', 'REPLAY', 'INV', 'BANKB']) k;

insert into public.customer_credits (tenant_id, customer_id, amount, source, status)
values ('e8950000-0000-0000-0000-0000000000a0', 'e8950000-0000-4000-8000-0000000000c1', 500, 'manual', 'open');

insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at) values
  ('e8950000-0000-4000-8000-0000000000f1', 'e8950000-0000-0000-0000-0000000000a0', 'Q-R895-ROLE',   'e8950000-0000-4000-8000-0000000000c1', 100, 'upi', 'R895-EDIT', 'received', '2026-09-01T00:00:00Z'),
  ('e8950000-0000-4000-8000-0000000000f2', 'e8950000-0000-0000-0000-0000000000a0', 'Q-R895-REPLAY', 'e8950000-0000-4000-8000-0000000000c1', 400, 'upi', 'R895-DUP',  'received', '2026-09-02T00:00:00Z');

create temp table r895_fail (msg text) on commit drop;
grant all on r895_fail to authenticated;

create function pg_temp.r895_credit() returns integer language sql as $$
  select coalesce(sum(amount), 0)::int from public.customer_credits
   where customer_id = 'e8950000-0000-4000-8000-0000000000c1' and status = 'open' $$;

do $$
declare
  who record;
  v_n int; v_code text; v_r jsonb; v_c int;
begin
  set local role authenticated;

  -- ════ ROLES: no money writes for sales / sales_senior / support / delivery ═════════
  for who in select * from (values
      ('sales',        'e8950000-0000-4000-8000-0000000000a3'),
      ('sales_senior', 'e8950000-0000-4000-8000-0000000000a4'),
      ('support',      'e8950000-0000-4000-8000-0000000000a5'),
      ('delivery',     'e8950000-0000-4000-8000-0000000000a6')) t(k, u)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', who.u, 'role', 'authenticated')::text, true);

    v_code := null;
    begin
      insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference)
      values ('e8950000-0000-0000-0000-0000000000a0', 'Q-R895-ROLE', 'e8950000-0000-4000-8000-0000000000c1', 5000, 'cash', 'R895-' || who.k);
    exception when insufficient_privilege then v_code := 'refused'; end;
    if v_code is null then insert into r895_fail values (who.k || ' inserted a payment'); end if;

    v_n := 0;
    begin
      update public.payments set received_at = '2026-01-01T00:00:00Z', bank_account_id = 'e8950000-0000-4000-8000-0000000000ba'
       where id = 'e8950000-0000-4000-8000-0000000000f1';
      get diagnostics v_n = row_count;
    exception when insufficient_privilege then v_n := 0; end;
    if v_n <> 0 then insert into r895_fail values (who.k || ' changed a payment''s date / bank account'); end if;

    v_n := 0;
    begin
      update public.invoices set paid_date = '2026-01-01' where id = 'R895-INV-EDIT';
      get diagnostics v_n = row_count;
    exception when insufficient_privilege then v_n := 0; end;
    if v_n <> 0 then insert into r895_fail values (who.k || ' moved an invoice paid_date'); end if;

    v_code := null;
    begin
      insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, total)
      values ('R895-BILL-' || who.k, 'e8950000-0000-0000-0000-0000000000a0', 'R895 AI Entry', current_date, 100);
    exception when insufficient_privilege then v_code := 'refused'; end;
    if v_code is null then insert into r895_fail values (who.k || ' inserted a vendor bill'); end if;

    v_code := null;
    begin
      perform public.record_desk_payment('Q-R895-ROLE', 1000, 'cash', 'R895-RDP-' || who.k, null,
                                         'e8950000-0000-4000-8000-0000000000c1', 180);
      v_code := 'ran';
    exception
      when insufficient_privilege then v_code := 'refused';
      when others then v_code := 'error: ' || sqlerrm;
    end;
    if v_code is distinct from 'refused' then
      insert into r895_fail values (who.k || ' record_desk_payment was not refused (' || v_code || ')');
    end if;
  end loop;

  set local role postgres;
  if (select received_at from public.payments where id = 'e8950000-0000-4000-8000-0000000000f1') <> '2026-09-01T00:00:00Z'
     or (select bank_account_id from public.payments where id = 'e8950000-0000-4000-8000-0000000000f1') is not null then
    insert into r895_fail values ('a refused role still changed payment f1');
  end if;
  if (select paid_date from public.invoices where id = 'R895-INV-EDIT') is not null then
    insert into r895_fail values ('a refused role still moved R895-INV-EDIT paid_date');
  end if;
  if exists (select 1 from public.payments where quote_id = 'Q-R895-ROLE' and reference <> 'R895-EDIT') then
    insert into r895_fail values ('a refused role recorded a payment on Q-R895-ROLE');
  end if;
  if pg_temp.r895_credit() <> 500 then
    insert into r895_fail values ('refused roles changed the open credit: ' || pg_temp.r895_credit() || ' (want 500)');
  end if;
  set local role authenticated;

  -- ════ BILLING: the same writes work ════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', 'e8950000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  update public.payments set received_at = '2026-09-05T00:00:00Z', bank_account_id = 'e8950000-0000-4000-8000-0000000000ba'
   where id = 'e8950000-0000-4000-8000-0000000000f1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then insert into r895_fail values ('billing could not tag a payment date / bank (' || v_n || ' rows)'); end if;
  update public.invoices set paid_date = '2026-09-05' where id = 'R895-INV-EDIT';
  get diagnostics v_n = row_count;
  if v_n <> 1 then insert into r895_fail values ('billing could not move an invoice paid_date (' || v_n || ' rows)'); end if;
  begin
    insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, total)
    values ('R895-BILL-billing', 'e8950000-0000-0000-0000-0000000000a0', 'R895 Vendor', current_date, 100);
  exception when others then insert into r895_fail values ('billing could not insert a vendor bill: ' || sqlerrm); end;

  -- ════ CREDIT: applied, recorded and tagged in one go ═══════════════════════════════
  begin
    v_r := public.record_desk_payment('Q-R895-BILL', 980, 'bank_transfer', 'R895-BILL', 'R895 note',
                                      'e8950000-0000-4000-8000-0000000000c1', 200,
                                      '2026-10-01', 'e8950000-0000-4000-8000-0000000000ba');
    if (v_r->>'credit_applied')::int is distinct from 200 then
      insert into r895_fail values ('billing: credit_applied ' || coalesce(v_r->>'credit_applied', 'null') || ' (want 200)');
    end if;
    if not exists (select 1 from public.payments
                    where id = (v_r->>'payment_id')::uuid and amount = 1180
                      and received_at = '2026-10-01T00:00:00Z'
                      and bank_account_id = 'e8950000-0000-4000-8000-0000000000ba'
                      and notes like '%R895 note%Advance credit applied%200%') then
      insert into r895_fail values ('billing: payment not recorded as 1180 dated 1 Oct on R895 Current with the credit note');
    end if;
  exception when others then insert into r895_fail values ('billing record_desk_payment failed: ' || sqlerrm);
  end;
  set local role postgres;
  v_c := pg_temp.r895_credit();
  if v_c <> 300 then insert into r895_fail values ('after billing applied 200, open credit is ' || v_c || ' (want 300)'); end if;
  set local role authenticated;

  -- ════ CREDIT: a payment that FAILS after the credit is applied ═════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', 'e8950000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  v_code := null;
  begin
    perform public.record_desk_payment('Q-R895-FAIL', 1000, 'bogus-method', 'R895-FAIL', null,
                                       'e8950000-0000-4000-8000-0000000000c1', 180);
  exception when others then v_code := sqlerrm; end;
  if v_code is null then insert into r895_fail values ('a payment with a bad method was recorded'); end if;
  set local role postgres;
  v_c := pg_temp.r895_credit();
  if v_c <> 300 then insert into r895_fail values ('failed payment changed the open credit: ' || v_c || ' (want 300)'); end if;
  if exists (select 1 from public.payments where quote_id = 'Q-R895-FAIL') then
    insert into r895_fail values ('failed payment left a payment row');
  end if;
  set local role authenticated;

  -- ════ CREDIT: replay of an already-recorded reference ══════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', 'e8950000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  begin
    v_r := public.record_desk_payment('Q-R895-REPLAY', 600, 'upi', 'R895-DUP', null,
                                      'e8950000-0000-4000-8000-0000000000c1', 180,
                                      '2026-10-03', 'e8950000-0000-4000-8000-0000000000ba');
    if not coalesce((v_r->>'already_recorded')::boolean, false) then
      insert into r895_fail values ('replay was not reported as already_recorded');
    end if;
    if (v_r->>'credit_applied')::int is distinct from 0 then
      insert into r895_fail values ('replay reported credit_applied ' || coalesce(v_r->>'credit_applied', 'null'));
    end if;
  exception when others then insert into r895_fail values ('replay raised: ' || sqlerrm);
  end;
  set local role postgres;
  v_c := pg_temp.r895_credit();
  if v_c <> 300 then insert into r895_fail values ('replay changed the open credit: ' || v_c || ' (want 300)'); end if;
  if (select received_at from public.payments where id = 'e8950000-0000-4000-8000-0000000000f2') <> '2026-09-02T00:00:00Z'
     or (select bank_account_id from public.payments where id = 'e8950000-0000-4000-8000-0000000000f2') is not null then
    insert into r895_fail values ('replay re-tagged the earlier payment');
  end if;
  if (select count(*) from public.payments where quote_id = 'Q-R895-REPLAY') <> 1 then
    insert into r895_fail values ('replay added a payment row');
  end if;
  set local role authenticated;

  -- ════ Another company's bank account ═══════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', 'e8950000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  v_code := null;
  begin
    perform public.record_desk_payment('Q-R895-BANKB', 1000, 'upi', 'R895-BANKB', null,
                                       'e8950000-0000-4000-8000-0000000000c1', 180,
                                       '2026-10-03', 'e8950000-0000-4000-8000-0000000000bb');
  exception when others then v_code := sqlerrm; end;
  if v_code is null then insert into r895_fail values ('a payment was tagged with another company''s bank account'); end if;
  set local role postgres;
  v_c := pg_temp.r895_credit();
  if v_c <> 300 then insert into r895_fail values ('refused bank account changed the open credit: ' || v_c || ' (want 300)'); end if;
  if exists (select 1 from public.payments where quote_id = 'Q-R895-BANKB') then
    insert into r895_fail values ('refused bank account left a payment row');
  end if;
  set local role authenticated;

  -- ════ INVOICE: settled invoice paid on the receipt date ═════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', 'e8950000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  begin
    v_r := public.record_desk_payment('Q-R895-INV', 1180, 'bank_transfer', 'R895-INV', null,
                                      null, 0, '2026-10-02', null);
    if not coalesce((v_r->>'invoice_paid')::boolean, false) then
      insert into r895_fail values ('invoice payment did not settle the invoice');
    end if;
  exception when others then insert into r895_fail values ('invoice payment failed: ' || sqlerrm);
  end;
  set local role postgres;
  if (select paid_date from public.invoices where id = 'R895-INV-PAY') is distinct from '2026-10-02'::date then
    insert into r895_fail values ('settled invoice paid_date is ' || coalesce((select paid_date::text from public.invoices where id = 'R895-INV-PAY'), 'null') || ' (want 2026-10-02)');
  end if;

  -- ════ Another company's owner ══════════════════════════════════════════════════════
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e8950000-0000-4000-8000-0000000000b1', 'role', 'authenticated')::text, true);
  v_code := null;
  begin
    perform public.record_desk_payment('Q-R895-ROLE', 1000, 'cash', 'R895-OTHER', null,
                                       'e8950000-0000-4000-8000-0000000000c1', 180);
  exception when others then v_code := sqlerrm; end;
  if v_code is null then insert into r895_fail values ('another company''s owner recorded a payment on our quote'); end if;
  set local role postgres;
  v_c := pg_temp.r895_credit();
  if v_c <> 300 then insert into r895_fail values ('another company''s owner changed our open credit: ' || v_c || ' (want 300)'); end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg('  - ' || msg, E'\n') into v_list from r895_fail;
  if v_list is not null then
    raise exception E'FAIL r895_money_policies:\n%', v_list;
  end if;
  raise notice 'PASS r895_money_policies';
end $$;

rollback;
