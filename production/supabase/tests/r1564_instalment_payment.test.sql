\set ON_ERROR_STOP on
-- R-1564 (P1 money): a payment on a subscription INSTALMENT invoice is recorded against THAT
-- invoice, and nothing spills to the next instalment.
-- Migration: 20261018033137_r1564_instalment_payment (record_instalment_payment +
-- record_multi_invoice_payment taking instalment lines).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1564_instalment_payment.test.sql
--
-- Expect "PASS r1564_instalment_payment". Every check is collected and failures listed together.
--
-- Quarterly subscription, ₹2,000 + 18% = ₹2,360 per instalment, sold on a ₹9,440 quote.
--   PART      ₹1,000 on instalment 1 → its due ₹1,360 (paid_amount 1000, still pending);
--             instalment 2 (already raised) untouched; instalment 3 raised AFTER it gets
--             no credit (the ₹1,000 counts as applied); one payment row on the quote,
--             dated + bank-tagged; no customer credit
--   FULL      ₹1,360 more → instalment 1 paid, paid_date = receipt date
--   REPLAY    the same reference again → already_recorded, nothing new
--   OVERPAY   ₹3,000 on instalment 2 (due ₹2,360) → it is paid, the ₹640 goes to the
--             subscription's next open instalment (3); ₹2,000 on 3 (due ₹1,720) → paid and
--             ₹280 stays on the subscription: instalment 4, raised after, takes it as credit
--   OVER YEAR a payment past the quote's year total → no customer_credits row (the money
--             is applied to the instalment; record_payment's credit would count it twice)
--   MULTI     an instalment line in record_multi_invoice_payment is applied to that invoice;
--             two instalments of one subscription in one receipt → refused
--   REFUSED   (each leaves nothing behind) sales role; another company's user; signed-in user
--             with no company; an invoice that is not an instalment; an instalment already paid

begin;

-- R-1643 / R-1803: issuing a Tax Invoice (also instalment + project invoices) needs the company's own GSTIN + address (supplier_invoice_problem).
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
  ('e1564000-0000-4000-8000-0000000000a2', 'r1564-billing@example.test'),
  ('e1564000-0000-4000-8000-0000000000a3', 'r1564-sales@example.test'),
  ('e1564000-0000-4000-8000-0000000000b1', 'r1564-owner-b@example.test'),
  ('e1564000-0000-4000-8000-0000000000d9', 'r1564-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1564000-0000-0000-0000-0000000000a0', 'R1564 A', 'r1564a@example.in', '07', 'R16A'),
  ('e1564000-0000-0000-0000-0000000000b0', 'R1564 B', 'r1564b@example.in', '07', 'R16B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1564000-0000-4000-8000-0000000000a2', 'e1564000-0000-0000-0000-0000000000a0', 'r1564-billing@example.in', 'R1564 Billing', 'billing', true),
  ('e1564000-0000-4000-8000-0000000000a3', 'e1564000-0000-0000-0000-0000000000a0', 'r1564-sales@example.in',   'R1564 Sales',   'sales',   true),
  ('e1564000-0000-4000-8000-0000000000b1', 'e1564000-0000-0000-0000-0000000000b0', 'r1564-owner-b@example.in', 'R1564 Owner B', 'owner',   true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1564000-0000-4000-8000-0000000000c1', 'e1564000-0000-0000-0000-0000000000a0', 'R1564 Cust', '07', 'India');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e1564000-0000-4000-8000-0000000000ba', 'e1564000-0000-0000-0000-0000000000a0', 'R1564 Current', 'R1564 Bank');

-- Q1: the quarterly subscription's quote (no invoice of its own — split-billed).
-- Q2: a quote already paid for its year (₹2,360) — its next instalment is "over the year".
-- QO: a one-off quote with its own invoice (not an instalment).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id) values
  ('Q-R1564-1', 'e1564000-0000-0000-0000-0000000000a0', 'e1564000-0000-4000-8000-0000000000c1', 'R1564 Cust', 9440, 8000, 18, 'accepted', 'none', '[]'::jsonb, null),
  ('Q-R1564-2', 'e1564000-0000-0000-0000-0000000000a0', 'e1564000-0000-4000-8000-0000000000c1', 'R1564 Cust', 2360, 2000, 18, 'accepted', 'none', '[]'::jsonb, null);
insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, status, received_at) values
  ('e1564000-0000-0000-0000-0000000000a0', 'Q-R1564-2', 'e1564000-0000-4000-8000-0000000000c1', 2360, 'upi', 'R1564-Y1', 'received', now());

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id) values
  ('R16-ONE', 'e1564000-0000-0000-0000-0000000000a0', 'R1564 Cust', 'e1564000-0000-4000-8000-0000000000c1', 1180, 1180, 1000, '2026-09-01', null);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id) values
  ('Q-R1564-O', 'e1564000-0000-0000-0000-0000000000a0', 'e1564000-0000-4000-8000-0000000000c1', 'R1564 Cust', 1180, 1000, 18, 'accepted', 'invoiced', '[]'::jsonb, 'R16-ONE');
update public.invoices set quote_id = 'Q-R1564-O' where id = 'R16-ONE';
insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id) values
  ('R16-NOLINK', 'e1564000-0000-0000-0000-0000000000a0', 'R1564 Cust', 'e1564000-0000-4000-8000-0000000000c1', 1180, 1180, 1000, '2026-09-01', null);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id) values
  ('e1564000-0000-4000-8000-0000000000e1', 'e1564000-0000-0000-0000-0000000000a0', 'e1564000-0000-4000-8000-0000000000c1', 'R1564 Cust', 'Workspace Starter', 'google'::vendor, 2, 667, 'quarterly'::billing_cycle, 'Q-R1564-1'),
  ('e1564000-0000-4000-8000-0000000000e2', 'e1564000-0000-0000-0000-0000000000a0', 'e1564000-0000-4000-8000-0000000000c1', 'R1564 Cust', 'Workspace Starter', 'google'::vendor, 2, 667, 'quarterly'::billing_cycle, 'Q-R1564-2');

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
select ('e1564000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid, 'e1564000-0000-0000-0000-0000000000a0',
       'e1564000-0000-4000-8000-0000000000e1', date '2026-07-01', n, date '2026-07-01' + (n - 1) * 90,
       date '2026-07-01' + (n - 1) * 90, date '2026-07-01' + n * 90 - 1, 2000, 18
  from generate_series(1, 4) n;
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
select ('e1564000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid, 'e1564000-0000-0000-0000-0000000000a0',
       'e1564000-0000-4000-8000-0000000000e2', date '2026-07-01', n, date '2026-07-01' + (n - 1) * 90,
       date '2026-07-01' + (n - 1) * 90, date '2026-07-01' + n * 90 - 1, 2000, 18
  from generate_series(1, 2) n;

create temp table r1564_inv (k text primary key, id text) on commit drop;
create temp table r1564_fail (msg text) on commit drop;
grant all on r1564_inv, r1564_fail to authenticated;

-- Instalments 1 and 2 of sub 1 raised now (nothing received yet → both ₹2,360 due);
-- sub 2's first instalment takes the year's ₹2,360 (paid), its second is due.
insert into r1564_inv select 'S1-1', invoice_id from public.raise_subscription_billing('e1564000-0000-4000-8000-000000000101');
insert into r1564_inv select 'S1-2', invoice_id from public.raise_subscription_billing('e1564000-0000-4000-8000-000000000102');
insert into r1564_inv select 'S2-1', invoice_id from public.raise_subscription_billing('e1564000-0000-4000-8000-000000000201');
insert into r1564_inv select 'S2-2', invoice_id from public.raise_subscription_billing('e1564000-0000-4000-8000-000000000202');

create function pg_temp.r1564_id(p_k text) returns text language sql stable as $$ select id from r1564_inv where k = p_k $$;
grant execute on function pg_temp.r1564_id(text) to authenticated;

create function pg_temp.r1564_pay(p_inv text, p_amount integer, p_ref text) returns jsonb language plpgsql as $$
begin
  return public.record_instalment_payment(p_inv, p_amount, 'bank_transfer', p_ref, 'R1564 note',
           null, 0, date '2026-10-05', 'e1564000-0000-4000-8000-0000000000ba');
end $$;
-- returns null on success, else 'SQLSTATE: message'
create function pg_temp.r1564_try(p_inv text, p_amount integer, p_ref text) returns text language plpgsql as $$
begin
  perform pg_temp.r1564_pay(p_inv, p_amount, p_ref);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r1564_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r1564_pay(text, integer, text) to authenticated;
grant execute on function pg_temp.r1564_try(text, integer, text) to authenticated;
grant execute on function pg_temp.r1564_as(text) to authenticated;

-- (invoice) → 'status|paid_amount|due'
create function pg_temp.r1564_state(p_inv text) returns text language sql stable as $$
  select i.status::text || '|' || coalesce(i.paid_amount, 0) || '|'
         || case when i.status::text in ('paid', 'void') then 0
                 else greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0)) end
    from public.invoices i where i.id = p_inv
$$;
grant execute on function pg_temp.r1564_state(text) to authenticated;

do $$
declare
  v_r jsonb; v_e text; v_s text; v_n int; v_pay int; v_inv1 text; v_inv2 text; v_inv3 text; v_inv4 text;
begin
  v_inv1 := pg_temp.r1564_id('S1-1');
  v_inv2 := pg_temp.r1564_id('S1-2');
  if pg_temp.r1564_state(v_inv1) <> 'pending|0|2360' or pg_temp.r1564_state(v_inv2) <> 'pending|0|2360' then
    insert into r1564_fail values ('setup: instalments not 2360 due: ' || pg_temp.r1564_state(v_inv1) || ' / ' || pg_temp.r1564_state(v_inv2));
  end if;

  set local role authenticated;
  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000a2');

  -- ════ PART: ₹1,000 on a ₹2,360 instalment ═══════════════════════════════════════════
  begin
    v_r := pg_temp.r1564_pay(v_inv1, 1000, 'UTR-R1564-1');
    if (v_r->>'applied')::int <> 1000 or (v_r->>'invoice_paid')::boolean or (v_r->>'advance_left')::int <> 0 then
      insert into r1564_fail values ('PART result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1564_fail values ('PART failed: ' || sqlerrm);
  end;

  set local role postgres;
  v_s := pg_temp.r1564_state(v_inv1);
  if v_s <> 'pending|1000|1360' then insert into r1564_fail values ('PART: instalment 1 should be pending|1000|1360, is ' || v_s); end if;
  v_s := pg_temp.r1564_state(v_inv2);
  if v_s <> 'pending|0|2360' then insert into r1564_fail values ('PART: instalment 2 must be untouched, is ' || v_s); end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_pay from public.payments where quote_id = 'Q-R1564-1' and status = 'received';
  if v_n <> 1 or v_pay <> 1000 then insert into r1564_fail values ('PART: want one ₹1000 payment on the quote, got ' || v_n || ' / ' || v_pay); end if;
  if not exists (select 1 from public.payments where quote_id = 'Q-R1564-1' and reference = 'UTR-R1564-1'
                   and bank_account_id = 'e1564000-0000-4000-8000-0000000000ba'
                   and (received_at at time zone 'UTC')::date = date '2026-10-05') then
    insert into r1564_fail values ('PART: payment not dated 2026-10-05 / bank-tagged');
  end if;
  if exists (select 1 from public.customer_credits where customer_id = 'e1564000-0000-4000-8000-0000000000c1') then
    insert into r1564_fail values ('PART: a customer credit was created');
  end if;
  -- the NEXT instalment raised now must not see the ₹1,000 as unapplied
  insert into r1564_inv select 'S1-3', invoice_id from public.raise_subscription_billing('e1564000-0000-4000-8000-000000000103');
  v_inv3 := pg_temp.r1564_id('S1-3');
  v_s := pg_temp.r1564_state(v_inv3);
  if v_s <> 'pending|0|2360' then insert into r1564_fail values ('PART: instalment 3 raised after must get no credit, is ' || v_s); end if;

  -- ════ FULL: the remaining ₹1,360 ══════════════════════════════════════════════════
  set local role authenticated;
  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000a2');
  begin
    v_r := pg_temp.r1564_pay(v_inv1, 1360, 'UTR-R1564-2');
    if not (v_r->>'invoice_paid')::boolean then insert into r1564_fail values ('FULL result wrong: ' || v_r::text); end if;
  exception when others then insert into r1564_fail values ('FULL failed: ' || sqlerrm);
  end;
  set local role postgres;
  if (select status::text || '|' || paid_amount || '|' || coalesce(paid_date::text, '-') from public.invoices where id = v_inv1) <> 'paid|2360|2026-10-05' then
    insert into r1564_fail values ('FULL: instalment 1 not paid 2360 on 2026-10-05: '
      || (select status::text || '|' || paid_amount || '|' || coalesce(paid_date::text, '-') from public.invoices where id = v_inv1));
  end if;

  -- ════ REPLAY: same reference → nothing new ════════════════════════════════════════
  set local role authenticated;
  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000a2');
  begin
    v_r := pg_temp.r1564_pay(v_inv1, 1360, 'UTR-R1564-2');
    if not coalesce((v_r->>'already_recorded')::boolean, false) or (v_r->>'applied')::int <> 0 then
      insert into r1564_fail values ('REPLAY result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1564_fail values ('REPLAY failed: ' || sqlerrm);
  end;
  set local role postgres;
  select count(*) into v_n from public.payments where quote_id = 'Q-R1564-1';
  if v_n <> 2 then insert into r1564_fail values ('REPLAY: want 2 payments, got ' || v_n); end if;

  -- ════ OVERPAY: ₹3,000 on instalment 2 → ₹640 to instalment 3 ════════════════════════
  set local role authenticated;
  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000a2');
  begin
    v_r := pg_temp.r1564_pay(v_inv2, 3000, 'UTR-R1564-3');
    if (v_r->>'applied')::int <> 2360 or (v_r->>'advance_left')::int <> 0
       or jsonb_array_length(v_r->'also_applied') <> 1 or (v_r->'also_applied'->0->>'applied')::int <> 640 then
      insert into r1564_fail values ('OVERPAY result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1564_fail values ('OVERPAY failed: ' || sqlerrm);
  end;
  set local role postgres;
  v_s := pg_temp.r1564_state(v_inv2);
  if v_s <> 'paid|2360|0' then insert into r1564_fail values ('OVERPAY: instalment 2 should be paid|2360|0, is ' || v_s); end if;
  v_s := pg_temp.r1564_state(v_inv3);
  if v_s <> 'pending|640|1720' then insert into r1564_fail values ('OVERPAY: instalment 3 should be pending|640|1720, is ' || v_s); end if;

  set local role authenticated;
  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000a2');
  begin
    v_r := pg_temp.r1564_pay(v_inv3, 2000, 'UTR-R1564-4');
    if (v_r->>'applied')::int <> 1720 or (v_r->>'advance_left')::int <> 280 then
      insert into r1564_fail values ('OVERPAY-2 result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1564_fail values ('OVERPAY-2 failed: ' || sqlerrm);
  end;
  set local role postgres;
  if exists (select 1 from public.customer_credits where customer_id = 'e1564000-0000-4000-8000-0000000000c1') then
    insert into r1564_fail values ('OVERPAY: no customer credit expected within the year total');
  end if;
  insert into r1564_inv select 'S1-4', invoice_id from public.raise_subscription_billing('e1564000-0000-4000-8000-000000000104');
  v_inv4 := pg_temp.r1564_id('S1-4');
  v_s := pg_temp.r1564_state(v_inv4);
  if v_s <> 'pending|280|2080' then insert into r1564_fail values ('OVERPAY: instalment 4 should take the ₹280 left (pending|280|2080), is ' || v_s); end if;

  -- ════ OVER YEAR: sub 2's quote is already paid for its year ═══════════════════════
  if pg_temp.r1564_state(pg_temp.r1564_id('S2-1')) <> 'paid|2360|0' or pg_temp.r1564_state(pg_temp.r1564_id('S2-2')) <> 'pending|0|2360' then
    insert into r1564_fail values ('OVER YEAR setup wrong: ' || pg_temp.r1564_state(pg_temp.r1564_id('S2-1')) || ' / ' || pg_temp.r1564_state(pg_temp.r1564_id('S2-2')));
  end if;
  set local role authenticated;
  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000a2');
  begin
    v_r := pg_temp.r1564_pay(pg_temp.r1564_id('S2-2'), 2360, 'UTR-R1564-5');
    if not (v_r->>'invoice_paid')::boolean or (v_r->>'overpaid_credit')::int <> 0 then
      insert into r1564_fail values ('OVER YEAR result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1564_fail values ('OVER YEAR failed: ' || sqlerrm);
  end;
  set local role postgres;
  if exists (select 1 from public.customer_credits where customer_id = 'e1564000-0000-4000-8000-0000000000c1') then
    insert into r1564_fail values ('OVER YEAR: the instalment payment also became customer credit (counted twice)');
  end if;

  -- ════ REFUSED — each leaves nothing behind ════════════════════════════════════════
  select count(*) into v_n from public.payments where tenant_id = 'e1564000-0000-0000-0000-0000000000a0';
  set local role authenticated;

  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000a3');   -- sales
  v_e := pg_temp.r1564_try(v_inv4, 100, 'UTR-R1564-X1');
  if v_e is null or v_e not like '42501:%' then insert into r1564_fail values ('sales role not refused: ' || coalesce(v_e, 'accepted')); end if;

  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000b1');   -- other company's owner
  v_e := pg_temp.r1564_try(v_inv4, 100, 'UTR-R1564-X2');
  if v_e is null or v_e not like '%not found in your company%' then insert into r1564_fail values ('other company not refused: ' || coalesce(v_e, 'accepted')); end if;

  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000d9');   -- no company
  v_e := pg_temp.r1564_try(v_inv4, 100, 'UTR-R1564-X3');
  if v_e is null or v_e not like '42501:%' and v_e not like '28000:%' then insert into r1564_fail values ('no-company user not refused: ' || coalesce(v_e, 'accepted')); end if;

  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000a2');
  v_e := pg_temp.r1564_try('R16-ONE', 100, 'UTR-R1564-X4');
  if v_e is null or v_e not like '%not a subscription instalment invoice%' then insert into r1564_fail values ('non-instalment invoice not refused: ' || coalesce(v_e, 'accepted')); end if;
  v_e := pg_temp.r1564_try('R16-NOLINK', 100, 'UTR-R1564-X5');
  if v_e is null or v_e not like '%not a subscription instalment invoice%' then insert into r1564_fail values ('unlinked invoice not refused: ' || coalesce(v_e, 'accepted')); end if;
  v_e := pg_temp.r1564_try(v_inv1, 100, 'UTR-R1564-X6');
  if v_e is null or v_e not like '%already paid in full%' then insert into r1564_fail values ('paid instalment not refused: ' || coalesce(v_e, 'accepted')); end if;

  set local role postgres;
  if (select count(*) from public.payments where tenant_id = 'e1564000-0000-0000-0000-0000000000a0') <> v_n then
    insert into r1564_fail values ('REFUSED: a refused call left a payment behind');
  end if;
  if pg_temp.r1564_state(v_inv4) <> 'pending|280|2080' then
    insert into r1564_fail values ('REFUSED: instalment 4 changed: ' || pg_temp.r1564_state(v_inv4));
  end if;

  -- ════ MULTI: an instalment line in one receipt over several invoices ══════════════
  insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id) values
    ('R16-REG', 'e1564000-0000-0000-0000-0000000000a0', 'R1564 Cust', 'e1564000-0000-4000-8000-0000000000c1', 1180, 1180, 1000, '2026-08-01', null);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id) values
    ('Q-R1564-R', 'e1564000-0000-0000-0000-0000000000a0', 'e1564000-0000-4000-8000-0000000000c1', 'R1564 Cust', 1180, 1000, 18, 'accepted', 'invoiced', '[]'::jsonb, 'R16-REG');
  update public.invoices set quote_id = 'Q-R1564-R' where id = 'R16-REG';

  set local role authenticated;
  perform pg_temp.r1564_as('e1564000-0000-4000-8000-0000000000a2');
  begin
    v_r := public.record_multi_invoice_payment('e1564000-0000-4000-8000-0000000000c1', '2026-10-06', 'bank_transfer',
             'e1564000-0000-4000-8000-0000000000ba', 'UTR-R1564-M1', 2180,
             jsonb_build_array(jsonb_build_object('invoice_id', 'R16-REG', 'amount', 1180),
                               jsonb_build_object('invoice_id', v_inv4, 'amount', 1000)),
             true, null);
    if (v_r->>'allocated')::int <> 2180 or (v_r->>'excess_credit')::int <> 0 then
      insert into r1564_fail values ('MULTI result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1564_fail values ('MULTI failed: ' || sqlerrm);
  end;
  begin
    v_r := public.record_multi_invoice_payment('e1564000-0000-4000-8000-0000000000c1', '2026-10-06', 'bank_transfer',
             'e1564000-0000-4000-8000-0000000000ba', 'UTR-R1564-M2', 200,
             jsonb_build_array(jsonb_build_object('invoice_id', v_inv4, 'amount', 100),
                               jsonb_build_object('invoice_id', v_inv3, 'amount', 100)),
             true, null);
    insert into r1564_fail values ('MULTI: two instalments of one subscription were accepted');
  exception when others then
    if sqlerrm not like '%same subscription%' then insert into r1564_fail values ('MULTI same-sub refused with the wrong reason: ' || sqlerrm); end if;
  end;
  set local role postgres;
  if pg_temp.r1564_state('R16-REG') <> 'paid|1180|0' then insert into r1564_fail values ('MULTI: regular invoice not paid: ' || pg_temp.r1564_state('R16-REG')); end if;
  if pg_temp.r1564_state(v_inv4) <> 'pending|1280|1080' then insert into r1564_fail values ('MULTI: instalment 4 should be pending|1280|1080, is ' || pg_temp.r1564_state(v_inv4)); end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r1564_fail;
  if v_list is not null then
    raise exception E'FAIL r1564_instalment_payment:\n  %', v_list;
  end if;
  raise notice 'PASS r1564_instalment_payment';
end $$;

rollback;
