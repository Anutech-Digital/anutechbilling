\set ON_ERROR_STOP on
-- R-1525 (P1): one receipt spread over several invoices of ONE customer, oldest first; the
-- rest becomes advance credit; all or nothing.
-- Migration: 20261017152833_r1525_multi_invoice_payment (record_multi_invoice_payment).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1525_multi_invoice_payment.test.sql
--
-- Expect "PASS r1525_multi_invoice_payment". Every check is collected and failures listed together.
--
--   FIFO      3 invoices: first two paid in full (status paid, paid_date = receipt date),
--             third part-paid (paid_amount), one payment row each, dated + bank-tagged,
--             no receipt voucher (post-invoice), no credit
--   EXCESS    rest → ONE open customer_credits row on the last fully-paid invoice's payment;
--             TDS on a line → tds_receivable row dated on the receipt date
--   REFUSED   (each leaves NOTHING behind) over-allocation; other company's invoice; other
--             customer's invoice; a valid line + a bad line; lines > received; excess not
--             wanted as credit; excess while every line is part-paid; invoice without its
--             own quote; other company's customer; sales role; NULL company (service_role
--             with no user → 28000); signed-in user with no company
--   REPLAY    the same receipt again → idempotent, no new rows; a half-replay is refused

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1525000-0000-4000-8000-0000000000a2', 'r1525-billing@example.test'),
  ('e1525000-0000-4000-8000-0000000000a3', 'r1525-sales@example.test'),
  ('e1525000-0000-4000-8000-0000000000b1', 'r1525-owner-b@example.test'),
  ('e1525000-0000-4000-8000-0000000000d9', 'r1525-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1525000-0000-0000-0000-0000000000a0', 'R1525 A', 'r1525a@example.in', '07', 'R15A'),
  ('e1525000-0000-0000-0000-0000000000b0', 'R1525 B', 'r1525b@example.in', '07', 'R15B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1525000-0000-4000-8000-0000000000a2', 'e1525000-0000-0000-0000-0000000000a0', 'r1525-billing@example.in', 'R1525 Billing', 'billing', true),
  ('e1525000-0000-4000-8000-0000000000a3', 'e1525000-0000-0000-0000-0000000000a0', 'r1525-sales@example.in',   'R1525 Sales',   'sales',   true),
  ('e1525000-0000-4000-8000-0000000000b1', 'e1525000-0000-0000-0000-0000000000b0', 'r1525-owner-b@example.in', 'R1525 Owner B', 'owner',   true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1525000-0000-4000-8000-0000000000c1', 'e1525000-0000-0000-0000-0000000000a0', 'R1525 Cust',  '07', 'India'),
  ('e1525000-0000-4000-8000-0000000000c2', 'e1525000-0000-0000-0000-0000000000a0', 'R1525 Other', '07', 'India'),
  ('e1525000-0000-4000-8000-0000000000cb', 'e1525000-0000-0000-0000-0000000000b0', 'R1525 B Cust','07', 'India');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e1525000-0000-4000-8000-0000000000ba', 'e1525000-0000-0000-0000-0000000000a0', 'R1525 Current', 'R1525 Bank');

-- (invoice id, tenant, customer, amount, taxable, date)
insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id)
select v.id, v.t::uuid, 'R1525', v.c::uuid, v.amt, v.amt, v.tx, v.d::date, null
  from (values
    ('R15-I1',  'e1525000-0000-0000-0000-0000000000a0', 'e1525000-0000-4000-8000-0000000000c1', 1180, 1000, '2026-07-01'),
    ('R15-I2',  'e1525000-0000-0000-0000-0000000000a0', 'e1525000-0000-4000-8000-0000000000c1', 2360, 2000, '2026-08-01'),
    ('R15-I3',  'e1525000-0000-0000-0000-0000000000a0', 'e1525000-0000-4000-8000-0000000000c1', 1180, 1000, '2026-09-01'),
    ('R15-I4',  'e1525000-0000-0000-0000-0000000000a0', 'e1525000-0000-4000-8000-0000000000c1', 1180, 1000, '2026-09-10'),
    ('R15-I5',  'e1525000-0000-0000-0000-0000000000a0', 'e1525000-0000-4000-8000-0000000000c1', 1180, 1000, '2026-09-20'),
    ('R15-I6',  'e1525000-0000-0000-0000-0000000000a0', 'e1525000-0000-4000-8000-0000000000c1', 1180, 1000, '2026-09-25'),
    ('R15-OC',  'e1525000-0000-0000-0000-0000000000a0', 'e1525000-0000-4000-8000-0000000000c2', 1180, 1000, '2026-09-01'),
    ('R15-BI',  'e1525000-0000-0000-0000-0000000000b0', 'e1525000-0000-4000-8000-0000000000cb', 1180, 1000, '2026-09-01'),
    ('R15-NOQ', 'e1525000-0000-0000-0000-0000000000a0', 'e1525000-0000-4000-8000-0000000000c1', 1180, 1000, '2026-09-01')
  ) v(id, t, c, amt, tx, d);

-- One-off quotes (no subscription side effects), each pointing at its own invoice.
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id)
select 'Q-' || i.id, i.tenant_id, null, i.customer_id, 'R1525', i.amount, i.taxable_value, 18, 'accepted', 'invoiced', '[]'::jsonb, i.id
  from public.invoices i where i.id like 'R15-%' and i.id <> 'R15-NOQ';
update public.invoices set quote_id = 'Q-' || id where id like 'R15-%' and id <> 'R15-NOQ';

create temp table r1525_fail (msg text) on commit drop;
grant all on r1525_fail to authenticated;

-- Calls the RPC as the current claims; returns null on success, else 'SQLSTATE: message'.
create function pg_temp.r1525_try(p_customer uuid, p_received integer, p_alloc jsonb, p_ref text,
                                  p_excess boolean default true) returns text language plpgsql as $$
begin
  perform public.record_multi_invoice_payment(p_customer, '2026-10-05', 'bank_transfer',
            'e1525000-0000-4000-8000-0000000000ba', p_ref, p_received, p_alloc, p_excess, null);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;

create function pg_temp.r1525_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r1525_try(uuid, integer, jsonb, text, boolean) to authenticated;
grant execute on function pg_temp.r1525_as(text) to authenticated;

do $$
declare
  c1 constant uuid := 'e1525000-0000-4000-8000-0000000000c1';
  v_r jsonb; v_e text; v_n int; v_pay_before int; v_cred_before int;
begin
  set local role authenticated;
  perform pg_temp.r1525_as('e1525000-0000-4000-8000-0000000000a2');

  -- ════ FIFO: 3 invoices, last one part-paid ══════════════════════════════════════════
  begin
    v_r := public.record_multi_invoice_payment(c1, '2026-10-05', 'bank_transfer',
             'e1525000-0000-4000-8000-0000000000ba', 'UTR-R1525-A', 4040,
             '[{"invoice_id":"R15-I1","amount":1180},{"invoice_id":"R15-I2","amount":2360},{"invoice_id":"R15-I3","amount":500}]'::jsonb,
             true, 'R1525 note');
    if (v_r->>'excess_credit')::int <> 0 or (v_r->>'allocated')::int <> 4040 or jsonb_array_length(v_r->'lines') <> 3 then
      insert into r1525_fail values ('FIFO result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1525_fail values ('FIFO failed: ' || sqlerrm);
  end;

  set local role postgres;
  if (select status::text || '|' || coalesce(paid_date::text, '-') from public.invoices where id = 'R15-I1') <> 'paid|2026-10-05' then
    insert into r1525_fail values ('R15-I1 not paid on 2026-10-05: ' || (select status::text || '|' || coalesce(paid_date::text, '-') from public.invoices where id = 'R15-I1'));
  end if;
  if (select status::text || '|' || coalesce(paid_date::text, '-') from public.invoices where id = 'R15-I2') <> 'paid|2026-10-05' then
    insert into r1525_fail values ('R15-I2 not paid on 2026-10-05');
  end if;
  if (select status::text <> 'paid' and paid_amount = 500 from public.invoices where id = 'R15-I3') is not true then
    insert into r1525_fail values ('R15-I3 should be part-paid 500: ' || (select status::text || '|' || paid_amount from public.invoices where id = 'R15-I3'));
  end if;
  select count(*) into v_n from public.payments
   where reference = 'UTR-R1525-A' and tenant_id = 'e1525000-0000-0000-0000-0000000000a0'
     and received_at = '2026-10-05T00:00:00Z' and bank_account_id = 'e1525000-0000-4000-8000-0000000000ba'
     and receipt_voucher_no is null and notes like '%R1525 note%One payment of ₹4040 across 3 invoices%';
  if v_n <> 3 then insert into r1525_fail values ('FIFO: want 3 dated, bank-tagged, voucher-less payments, got ' || v_n); end if;
  if (select coalesce(sum(amount), 0) from public.payments where reference = 'UTR-R1525-A') <> 4040 then
    insert into r1525_fail values ('FIFO: payments do not add up to 4040');
  end if;
  if exists (select 1 from public.customer_credits where customer_id = c1) then
    insert into r1525_fail values ('FIFO with no excess created a credit');
  end if;

  -- ════ REPLAY: same receipt again → nothing new ═════════════════════════════════════
  set local role authenticated;
  begin
    v_r := public.record_multi_invoice_payment(c1, '2026-10-05', 'bank_transfer',
             'e1525000-0000-4000-8000-0000000000ba', 'UTR-R1525-A', 4040,
             '[{"invoice_id":"R15-I1","amount":1180},{"invoice_id":"R15-I2","amount":2360},{"invoice_id":"R15-I3","amount":500}]'::jsonb,
             true, 'R1525 note');
    if not coalesce((v_r->>'idempotent_replay')::boolean, false) then
      insert into r1525_fail values ('replay not reported as idempotent: ' || v_r::text);
    end if;
  exception when others then insert into r1525_fail values ('replay raised: ' || sqlerrm);
  end;
  set local role postgres;
  if (select count(*) from public.payments where reference = 'UTR-R1525-A') <> 3 then
    insert into r1525_fail values ('replay added payment rows');
  end if;
  select count(*) into v_pay_before from public.payments where tenant_id = 'e1525000-0000-0000-0000-0000000000a0';
  select count(*) into v_cred_before from public.customer_credits where tenant_id = 'e1525000-0000-0000-0000-0000000000a0';
  set local role authenticated;

  -- ════ REFUSED — each must leave nothing behind ═════════════════════════════════════
  -- half-replay: I3 already has UTR-R1525-A
  v_e := pg_temp.r1525_try(c1, 1180, '[{"invoice_id":"R15-I6","amount":500},{"invoice_id":"R15-I3","amount":680}]', 'UTR-R1525-A');
  if v_e is null or v_e not like '%already recorded on 1 of these invoices%' then
    insert into r1525_fail values ('half-replay not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- over-allocation: I3 has 680 due
  v_e := pg_temp.r1525_try(c1, 700, '[{"invoice_id":"R15-I3","amount":700}]', 'UTR-R1525-OVER');
  if v_e is null or v_e not like '%only ₹680 due%' then
    insert into r1525_fail values ('over-allocation not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- other company's invoice, after a valid line
  v_e := pg_temp.r1525_try(c1, 1860, '[{"invoice_id":"R15-I3","amount":680},{"invoice_id":"R15-BI","amount":1180}]', 'UTR-R1525-TB');
  if v_e is null or v_e not like '42501: Invoice R15-BI was not found in your company%' then
    insert into r1525_fail values ('other company''s invoice not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- other customer's invoice, after a valid line
  v_e := pg_temp.r1525_try(c1, 1860, '[{"invoice_id":"R15-I3","amount":680},{"invoice_id":"R15-OC","amount":1180}]', 'UTR-R1525-OC');
  if v_e is null or v_e not like '42501: Invoice R15-OC belongs to another customer%' then
    insert into r1525_fail values ('other customer''s invoice not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- lines add up to more than received
  v_e := pg_temp.r1525_try(c1, 1000, '[{"invoice_id":"R15-I3","amount":680},{"invoice_id":"R15-I4","amount":1180}]', 'UTR-R1525-SUM');
  if v_e is null or v_e not like '%add up to ₹1860 but only ₹1000 was received%' then
    insert into r1525_fail values ('lines > received not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- excess not wanted as credit
  v_e := pg_temp.r1525_try(c1, 1000, '[{"invoice_id":"R15-I3","amount":680}]', 'UTR-R1525-NOX', false);
  if v_e is null or v_e not like '%₹320 of the ₹1000 received is not applied%' then
    insert into r1525_fail values ('unwanted excess not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- excess while every line is part-paid
  v_e := pg_temp.r1525_try(c1, 1000, '[{"invoice_id":"R15-I3","amount":600}]', 'UTR-R1525-PX');
  if v_e is null or v_e not like '%every chosen invoice is still part-paid%' then
    insert into r1525_fail values ('excess on part-paid lines not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- invoice without its own quote
  v_e := pg_temp.r1525_try(c1, 1180, '[{"invoice_id":"R15-NOQ","amount":1180}]', 'UTR-R1525-NOQ');
  if v_e is null or v_e not like '%has no quote of its own%' then
    insert into r1525_fail values ('invoice without quote not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- other company's customer
  v_e := pg_temp.r1525_try('e1525000-0000-4000-8000-0000000000cb', 1180, '[{"invoice_id":"R15-BI","amount":1180}]', 'UTR-R1525-CB');
  if v_e is null or v_e not like '42501: That customer is not in your company%' then
    insert into r1525_fail values ('other company''s customer not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- sales role
  perform pg_temp.r1525_as('e1525000-0000-4000-8000-0000000000a3');
  v_e := pg_temp.r1525_try(c1, 680, '[{"invoice_id":"R15-I3","amount":680}]', 'UTR-R1525-SALES');
  if v_e is null or v_e not like '42501: Only an owner, manager, accountant or billing%' then
    insert into r1525_fail values ('sales role not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- signed-in user with no company
  perform pg_temp.r1525_as('e1525000-0000-4000-8000-0000000000d9');
  v_e := pg_temp.r1525_try(c1, 680, '[{"invoice_id":"R15-I3","amount":680}]', 'UTR-R1525-NOCO');
  if v_e is null or v_e not like '42501:%' then
    insert into r1525_fail values ('user with no company not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- other company's owner on our customer
  perform pg_temp.r1525_as('e1525000-0000-4000-8000-0000000000b1');
  v_e := pg_temp.r1525_try(c1, 680, '[{"invoice_id":"R15-I3","amount":680}]', 'UTR-R1525-OWNB');
  if v_e is null or v_e not like '42501: That customer is not in your company%' then
    insert into r1525_fail values ('other company''s owner not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- NULL company: trusted service_role with no user → this function's OWN guard (28000)
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  v_e := pg_temp.r1525_try(c1, 680, '[{"invoice_id":"R15-I3","amount":680}]', 'UTR-R1525-NULL');
  if v_e is null or v_e not like '28000: No company context%' then
    insert into r1525_fail values ('NULL company not refused with 28000: ' || coalesce(v_e, 'ran'));
  end if;

  set local role postgres;
  if (select count(*) from public.payments where tenant_id = 'e1525000-0000-0000-0000-0000000000a0') <> v_pay_before
     or (select count(*) from public.payments where tenant_id = 'e1525000-0000-0000-0000-0000000000b0') <> 0 then
    insert into r1525_fail values ('a refused receipt left payment rows behind');
  end if;
  if (select count(*) from public.customer_credits where tenant_id = 'e1525000-0000-0000-0000-0000000000a0') <> v_cred_before then
    insert into r1525_fail values ('a refused receipt left a credit behind');
  end if;
  if (select paid_amount from public.invoices where id = 'R15-I3') <> 500 then
    insert into r1525_fail values ('a refused receipt moved R15-I3 paid_amount');
  end if;

  -- ════ EXCESS → advance credit, TDS on a line ═══════════════════════════════════════
  set local role authenticated;
  perform pg_temp.r1525_as('e1525000-0000-4000-8000-0000000000a2');
  begin
    v_r := public.record_multi_invoice_payment(c1, '2026-10-06', 'upi',
             'e1525000-0000-4000-8000-0000000000ba', 'UTR-R1525-B', 3580,
             '[{"invoice_id":"R15-I3","amount":680},{"invoice_id":"R15-I4","amount":1080,"tds_amount":100,"tds_section":"194J","tds_rate_pct":10},{"invoice_id":"R15-I5","amount":1180}]'::jsonb,
             true, null);
    if (v_r->>'excess_credit')::int <> 640 or v_r->>'credit_invoice_id' <> 'R15-I5' then
      insert into r1525_fail values ('excess result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1525_fail values ('excess receipt failed: ' || sqlerrm);
  end;
  set local role postgres;
  if (select count(*) from public.invoices where id in ('R15-I3', 'R15-I4', 'R15-I5') and status = 'paid' and paid_date = '2026-10-06') <> 3 then
    insert into r1525_fail values ('excess receipt: I3, I4, I5 not all paid on 2026-10-06');
  end if;
  select count(*) into v_n from public.customer_credits cc
    join public.payments p on p.id = cc.source_payment_id
   where cc.customer_id = c1 and cc.status = 'open' and cc.amount = 640 and cc.source = 'overpayment'
     and p.quote_id = 'Q-R15-I5' and p.amount = 1820 and p.reference = 'UTR-R1525-B';
  if v_n <> 1 then insert into r1525_fail values ('excess: want one open 640 credit on the I5 payment (1820), got ' || v_n); end if;
  if (select count(*) from public.customer_credits where customer_id = c1) <> 1 then
    insert into r1525_fail values ('excess: more than one credit row');
  end if;
  if (select coalesce(sum(amount), 0) from public.payments where reference = 'UTR-R1525-B') <> 3580 + 100 then
    insert into r1525_fail values ('excess: payments should add to cash 3580 + TDS 100');
  end if;
  select count(*) into v_n from public.tds_receivable t
    join public.payments p on p.id = t.payment_id
   where p.quote_id = 'Q-R15-I4' and t.tds_amount = 100 and t.net_paid = 1080 and t.gross_amount = 1000
     and t.invoice_id = 'R15-I4' and t.payment_received_date = '2026-10-06' and t.fiscal_year = 'FY2627';
  if v_n <> 1 then insert into r1525_fail values ('TDS: want one receivable 100 on I4 dated 2026-10-06, got ' || v_n); end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg('  - ' || msg, E'\n') into v_list from r1525_fail;
  if v_list is not null then
    raise exception E'FAIL r1525_multi_invoice_payment:\n%', v_list;
  end if;
  raise notice 'PASS r1525_multi_invoice_payment';
end $$;

rollback;
