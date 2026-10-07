-- Regression test: R-398 — a portal customer cannot read payments.notes / recorded_by /
-- bank_account_id or the internal customers columns (migration 20261007235000_customer_rls_payments_self).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/customer_portal_rls_payments_self.test.sql
--
-- Proves, as a signed-in CUSTOMER (customer_users row, no public.users row):
--   0. payments_select_own_customer / customers_select_self_customer are gone; the two readers
--      exist and return no internal column.
--   1. payments: no direct row (notes / recorded_by / bank_account_id unreachable);
--      portal_my_payments() returns own receipts only, with the display fields.
--   2. customers: no direct row (notes / health / credit_limit unreachable); portal_my_customer()
--      returns own profile only.
--   3. Own invoices are still readable (positive control for the impersonation).
-- And for everyone else:
--   4. Staff (public.users owner) still read the full payments/customers rows incl. internals;
--      the portal readers give staff nothing.
--   5. anon cannot execute the readers; authenticated + service_role can.
--
-- Ids are captured BEFORE every role switch and carried in GUCs (see
-- portal_customer_users_no_self_update.test.sql: a SELECT after `set role` is filtered).

begin;

-- ── fixtures (as postgres) ──────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('ffffffff-0000-0000-0000-000000398a01', 'R398 Reseller', 'r398@example.in', '07', 'R398');

insert into auth.users (id, instance_id, aud, role, email) values
  ('dddddddd-0000-0000-0000-000000398d0a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r398-cust@example.test'),
  ('dddddddd-0000-0000-0000-000000398d05', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r398-staff@example.test');

insert into public.users (id, tenant_id, email, role)
  values ('dddddddd-0000-0000-0000-000000398d05', 'ffffffff-0000-0000-0000-000000398a01', 'r398-staff@example.test', 'owner');

insert into public.bank_accounts (id, tenant_id, name, bank_name)
  values ('bbbbbbbb-0000-0000-0000-000000398b01', 'ffffffff-0000-0000-0000-000000398a01', 'R398 HDFC current', 'HDFC');

insert into public.customers (id, tenant_id, name, gstin, address, contact_email, notes, health, credit_limit, account_manager_id)
  values ('cccccccc-0000-0000-0000-000000398c0a', 'ffffffff-0000-0000-0000-000000398a01', 'Cust A', '07BBBBB0000B1Z5',
          '1 Main Rd', 'a@cust.test', 'INTERNAL customer note', 12, 50000, 'dddddddd-0000-0000-0000-000000398d05'),
         ('cccccccc-0000-0000-0000-000000398c0b', 'ffffffff-0000-0000-0000-000000398a01', 'Cust B', null,
          null, null, 'INTERNAL B', 90, null, null);

insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role)
  values ('dddddddd-0000-0000-0000-000000398d0a', 'cccccccc-0000-0000-0000-000000398c0a',
          'ffffffff-0000-0000-0000-000000398a01', 'r398-cust@example.test', 'admin');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, status)
  values ('Q-R398-A', 'ffffffff-0000-0000-0000-000000398a01', 'cccccccc-0000-0000-0000-000000398c0a', 'Cust A', 'GW', 5, 11800, 10000, 'sent'),
         ('Q-R398-B', 'ffffffff-0000-0000-0000-000000398a01', 'cccccccc-0000-0000-0000-000000398c0b', 'Cust B', 'GW', 2, 2000, 2000, 'sent');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount)
  values ('INV-R398-A', 'ffffffff-0000-0000-0000-000000398a01', 'cccccccc-0000-0000-0000-000000398c0a', 'Cust A', 11800);

insert into public.payments (id, tenant_id, customer_id, quote_id, amount, method, reference, notes, recorded_by,
                             bank_account_id, receipt_voucher_no, gateway_fee)
  values ('eeeeeeee-0000-0000-0000-000000398e0a', 'ffffffff-0000-0000-0000-000000398a01', 'cccccccc-0000-0000-0000-000000398c0a',
          'Q-R398-A', 11800, 'upi', 'UTR398A', 'INTERNAL payment note', 'dddddddd-0000-0000-0000-000000398d05',
          'bbbbbbbb-0000-0000-0000-000000398b01', 'RV-R398-1', 236),
         ('eeeeeeee-0000-0000-0000-000000398e0b', 'ffffffff-0000-0000-0000-000000398a01', 'cccccccc-0000-0000-0000-000000398c0b',
          'Q-R398-B', 2000, 'upi', 'UTR398B', null, null, null, null, null);

-- ── 0. the leaky policies are gone, the readers exist and expose no internal column ─────────
do $$
declare v_fn text; v_res text;
begin
  if exists (select 1 from pg_policy where polname in ('payments_select_own_customer', 'customers_select_self_customer')) then
    raise exception 'FAIL 0: a broad customer SELECT policy is still installed';
  end if;
  foreach v_fn in array array['portal_my_payments', 'portal_my_customer'] loop
    select pg_get_function_result(p.oid) into v_res
      from pg_proc p where p.proname = v_fn and p.pronamespace = 'public'::regnamespace;
    if v_res is null then raise exception 'FAIL 0: %() missing', v_fn; end if;
    if v_res ~* '(\mnotes\M|recorded_by|bank_account|gateway_|receipt_file|refund_reason|\mhealth\M|account_manager|credit_limit|allow_pay_later|group_id|gstin_verification|linked_tenant|contact_persons|tenant_id)' then
      raise exception 'FAIL 0: %() returns an internal column: %', v_fn, v_res;
    end if;
  end loop;
end $$;

-- ── 5. grants ──────────────────────────────────────────────────────────────────────────────
do $$
declare v_fn text;
begin
  foreach v_fn in array array['portal_my_payments()', 'portal_my_customer()'] loop
    if has_function_privilege('anon', 'public.' || v_fn, 'EXECUTE') then
      raise exception 'FAIL 5: anon can execute %', v_fn;
    end if;
    if not has_function_privilege('authenticated', 'public.' || v_fn, 'EXECUTE')
       or not has_function_privilege('service_role', 'public.' || v_fn, 'EXECUTE') then
      raise exception 'FAIL 5: authenticated/service_role cannot execute %', v_fn;
    end if;
  end loop;
end $$;

-- ── 1–3. as the customer ───────────────────────────────────────────────────────────────────
select set_config('r398.cust', 'dddddddd-0000-0000-0000-000000398d0a', true);
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('r398.cust'), 'role', 'authenticated')::text, true);

do $$
declare v_n int; v_p record; v_c record;
begin
  if auth.uid()::text is distinct from current_setting('r398.cust', true) then
    raise exception 'SETUP FAIL: impersonation did not take (auth.uid() = %)', auth.uid();
  end if;
  if public.current_customer_id() is distinct from 'cccccccc-0000-0000-0000-000000398c0a'::uuid then
    raise exception 'SETUP FAIL: current_customer_id() = %, expected Cust A', public.current_customer_id();
  end if;

  -- 3 first: positive control — if this reads 0, the "0 rows" checks below prove nothing.
  select count(*) into v_n from public.invoices where id = 'INV-R398-A';
  if v_n <> 1 then raise exception 'FAIL 3: customer cannot read their own invoice'; end if;

  -- 1. payments
  select count(*) into v_n from public.payments;
  if v_n <> 0 then raise exception 'FAIL 1: customer reads % payment row(s) directly (notes/recorded_by/bank exposed)', v_n; end if;
  select count(*) into v_n from public.payments where notes is not null or recorded_by is not null or bank_account_id is not null;
  if v_n <> 0 then raise exception 'FAIL 1: notes/recorded_by/bank_account_id reachable'; end if;
  select count(*) into v_n from public.portal_my_payments();
  if v_n <> 1 then raise exception 'FAIL 1: portal_my_payments() returned % rows, expected own 1', v_n; end if;
  select * into v_p from public.portal_my_payments();
  if v_p.id <> 'eeeeeeee-0000-0000-0000-000000398e0a' or v_p.amount <> 11800 or v_p.method <> 'upi'
     or v_p.reference is distinct from 'UTR398A' or v_p.receipt_voucher_no is distinct from 'RV-R398-1'
     or v_p.quote_id <> 'Q-R398-A' or v_p.status <> 'received' or v_p.received_at is null then
    raise exception 'FAIL 1: wrong payment fields: %', row_to_json(v_p);
  end if;
  if row_to_json(v_p)::text ~ '(INTERNAL|398d05|398b01)' then
    raise exception 'FAIL 1: internal value in portal_my_payments(): %', row_to_json(v_p);
  end if;

  -- 2. customers
  select count(*) into v_n from public.customers;
  if v_n <> 0 then raise exception 'FAIL 2: customer reads % customers row(s) directly (notes/health/credit exposed)', v_n; end if;
  select count(*) into v_n from public.portal_my_customer();
  if v_n <> 1 then raise exception 'FAIL 2: portal_my_customer() returned % rows, expected own 1', v_n; end if;
  select * into v_c from public.portal_my_customer();
  if v_c.id <> 'cccccccc-0000-0000-0000-000000398c0a' or v_c.name <> 'Cust A'
     or v_c.gstin is distinct from '07BBBBB0000B1Z5' or v_c.address is distinct from '1 Main Rd'
     or v_c.contact_email is distinct from 'a@cust.test' then
    raise exception 'FAIL 2: wrong customer fields: %', row_to_json(v_c);
  end if;
  if row_to_json(v_c)::text ~ '(INTERNAL|50000|398d05)' then
    raise exception 'FAIL 2: internal value in portal_my_customer(): %', row_to_json(v_c);
  end if;
end $$;

reset role;

-- ── 4. staff are unchanged ──────────────────────────────────────────────────────────────────
select set_config('r398.staff', 'dddddddd-0000-0000-0000-000000398d05', true);
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('r398.staff'), 'role', 'authenticated')::text, true);
do $$
declare v_n int; v_note text; v_bank uuid; v_rec uuid; v_cnote text; v_credit int;
begin
  select count(*) into v_n from public.payments where quote_id in ('Q-R398-A', 'Q-R398-B');
  if v_n <> 2 then raise exception 'FAIL 4: staff see % of 2 payments', v_n; end if;
  select notes, bank_account_id, recorded_by into v_note, v_bank, v_rec
    from public.payments where id = 'eeeeeeee-0000-0000-0000-000000398e0a';
  if v_note is distinct from 'INTERNAL payment note' or v_bank is distinct from 'bbbbbbbb-0000-0000-0000-000000398b01'
     or v_rec is distinct from 'dddddddd-0000-0000-0000-000000398d05' then
    raise exception 'FAIL 4: staff lost payment internals';
  end if;
  select count(*) into v_n from public.customers where id in ('cccccccc-0000-0000-0000-000000398c0a', 'cccccccc-0000-0000-0000-000000398c0b');
  if v_n <> 2 then raise exception 'FAIL 4: staff see % of 2 customers', v_n; end if;
  select notes, credit_limit into v_cnote, v_credit from public.customers where id = 'cccccccc-0000-0000-0000-000000398c0a';
  if v_cnote is distinct from 'INTERNAL customer note' or v_credit is distinct from 50000 then
    raise exception 'FAIL 4: staff lost customer internals';
  end if;
  if exists (select 1 from public.portal_my_payments()) or exists (select 1 from public.portal_my_customer()) then
    raise exception 'FAIL 4: the portal readers returned rows to a staff user';
  end if;
end $$;

reset role;

select 'PASS' as customer_portal_rls_payments_self;

rollback;
