\set ON_ERROR_STOP on
-- R-2595: settle a small shortfall on a received part of a quote billed in parts as bank charge.
-- Migration: 20261108092350_r2595_settle_quote_part_short.sql
-- Self-asserting, ONE transaction, rolled back — run on the LOCAL DB only:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2595_settle_quote_part_short.test.sql
--
-- Expect "PASS r2595_settle_quote_part_short". Every check is collected and failures listed together.
--
--   Quarterly quote, 4 parts of ₹81,350 + 18% = ₹95,993; the bank brought ₹95,933 for Part 1.
--   UNBANKED   receipt not matched to a bank line yet → refused, nothing written
--   ROLE       sales user → 42501; another company's owner → 42501
--   SETTLE     owner → ₹60 receipt BANKCHG-<line>, Part 1 invoice paid, quote received ₹95,993, both
--              receipts on the line, round-off +60, P&L settlement shortfall ₹60 (once)
--   NEXT PART  Part 2's invoice untouched (pending, ₹0 paid)
--   TWICE      a second settle → refused, nothing more written
--   OVER LIMIT ₹1,000 short on a ₹95,993 part (limit ₹500) → refused
--   TDS-LIKE   ₹50 short on a ₹5,900 part (1% of ₹5,000 taxable) → refused as TDS
--   NOT EXACT  ₹60 short, but the bank line is ₹1 less than the receipt → refused (the ₹1 stays in P&L)
--   LATER PART Part 1 ₹60 short, Part 2 already paid → refused (the latest receipt is not Part 1's)
--   CREDIT NOTE / WRITE-OFF on the part invoice → refused (refuses_credit_note)
--   SPLIT LINE the receipt already on a split line / its line already has a round-off → refused (refuses_split_line)
--   TDS        the receipt carries a TDS row → refused (refuses_when_tds_on_receipt)
--   every refused case writes nothing (no BANKCHG receipt, no round-off, no bank_txn_id change, invoice unchanged)

begin;
select set_config('request.jwt.claims', '', true);

create temp table r2595_fail (msg text) on commit drop;
grant all on r2595_fail to authenticated;

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

insert into auth.users (id, email) values
  ('e2595000-0000-4000-8000-0000000000a2', 'r2595-owner@example.test'),
  ('e2595000-0000-4000-8000-0000000000a3', 'r2595-sales@example.test'),
  ('e2595000-0000-4000-8000-0000000000b1', 'r2595-owner-b@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2595000-0000-0000-0000-0000000000a0', 'R2595 A', 'r2595a@example.in', '07', 'R25A'),
  ('e2595000-0000-0000-0000-0000000000b0', 'R2595 B', 'r2595b@example.in', '07', 'R25B');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('e2595000-0000-4000-8000-0000000000a2', 'e2595000-0000-0000-0000-0000000000a0', 'r2595-owner@example.in', 'R2595 Owner', 'owner', true, now() - interval '1 day'),
  ('e2595000-0000-4000-8000-0000000000a3', 'e2595000-0000-0000-0000-0000000000a0', 'r2595-sales@example.in', 'R2595 Sales', 'sales', true, now() - interval '1 day'),
  ('e2595000-0000-4000-8000-0000000000b1', 'e2595000-0000-0000-0000-0000000000b0', 'r2595-owner-b@example.in', 'R2595 Owner B', 'owner', true, now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2595000-0000-4000-8000-0000000000c1', 'e2595000-0000-0000-0000-0000000000a0', 'R2595 Cust', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e2595000-0000-4000-8000-0000000000ba', 'e2595000-0000-0000-0000-0000000000a0', 'R2595 Current', 'R2595 Bank');

-- Q1: ₹60 short. Q2: ₹1,000 short. Q3: small parts (₹5,000 + GST), ₹50 short (= 1% TDS).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, billing_cycle, line_items) values
  ('Q-R2595-1', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000c1', 'R2595 Cust', 383972, 325400, 18, 'accepted', 'none', 'quarterly', '[]'::jsonb),
  ('Q-R2595-2', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000c1', 'R2595 Cust', 383972, 325400, 18, 'accepted', 'none', 'quarterly', '[]'::jsonb),
  ('Q-R2595-3', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000c1', 'R2595 Cust', 23600, 20000, 18, 'accepted', 'none', 'quarterly', '[]'::jsonb),
  ('Q-R2595-4', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000c1', 'R2595 Cust', 383972, 325400, 18, 'accepted', 'none', 'quarterly', '[]'::jsonb),
  ('Q-R2595-5', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000c1', 'R2595 Cust', 383972, 325400, 18, 'accepted', 'none', 'quarterly', '[]'::jsonb);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, billing_cycle, line_items)
select 'Q-R2595-' || k, 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000c1', 'R2595 Cust', 383972, 325400, 18, 'accepted', 'none', 'quarterly', '[]'::jsonb
  from generate_series(6, 10) k;
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id)
select v.id::uuid, 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000c1', 'R2595 Cust',
       'Workspace Business', 'google'::vendor, 10, 1000, 'quarterly'::billing_cycle, v.q
  from (values ('e2595000-0000-4000-8000-0000000000e1', 'Q-R2595-1'),
               ('e2595000-0000-4000-8000-0000000000e2', 'Q-R2595-2'),
               ('e2595000-0000-4000-8000-0000000000e3', 'Q-R2595-3'),
               ('e2595000-0000-4000-8000-0000000000e4', 'Q-R2595-4'),
               ('e2595000-0000-4000-8000-0000000000e5', 'Q-R2595-5'),
               ('e2595000-0000-4000-8000-0000000000e6', 'Q-R2595-6'),
               ('e2595000-0000-4000-8000-0000000000e7', 'Q-R2595-7'),
               ('e2595000-0000-4000-8000-0000000000e8', 'Q-R2595-8'),
               ('e2595000-0000-4000-8000-0000000000e9', 'Q-R2595-9'),
               ('e2595000-0000-4000-8000-0000000000ea', 'Q-R2595-10')) v(id, q);
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
select ('e2595000-0000-4000-8000-00000000' || lpad(s::text, 2, '0') || lpad(n::text, 2, '0'))::uuid, 'e2595000-0000-0000-0000-0000000000a0',
       ('e2595000-0000-4000-8000-0000000000e' || case when s = 10 then 'a' else s::text end)::uuid, date '2026-08-01', n, date '2026-08-01' + (n - 1) * 90,
       date '2026-08-01' + (n - 1) * 90, date '2026-08-01' + n * 90 - 1, case when s = 3 then 5000 else 81350 end, 18
  from generate_series(1, 10) s, generate_series(1, 4) n;

create temp table r2595_inv (k text primary key, id text) on commit drop;
grant all on r2595_inv to authenticated;
select set_config('request.jwt.claims', '{"sub":"e2595000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
insert into r2595_inv select 'Q1-P1', invoice_id from public.raise_subscription_billing('e2595000-0000-4000-8000-000000000101');
insert into r2595_inv select 'Q1-P2', invoice_id from public.raise_subscription_billing('e2595000-0000-4000-8000-000000000102');
insert into r2595_inv select 'Q2-P1', invoice_id from public.raise_subscription_billing('e2595000-0000-4000-8000-000000000201');
insert into r2595_inv select 'Q3-P1', invoice_id from public.raise_subscription_billing('e2595000-0000-4000-8000-000000000301');
insert into r2595_inv select 'Q4-P1', invoice_id from public.raise_subscription_billing('e2595000-0000-4000-8000-000000000401');
insert into r2595_inv select 'Q5-P1', invoice_id from public.raise_subscription_billing('e2595000-0000-4000-8000-000000000501');
insert into r2595_inv select 'Q5-P2', invoice_id from public.raise_subscription_billing('e2595000-0000-4000-8000-000000000502');
insert into r2595_inv select 'Q' || k || '-P1', r.invoice_id from generate_series(6, 10) k,
  lateral public.raise_subscription_billing(('e2595000-0000-4000-8000-00000000' || lpad(k::text, 2, '0') || '01')::uuid) r;
create function pg_temp.inv(p_k text) returns text language sql stable as $f$ select id from r2595_inv where k = p_k $f$;
grant execute on function pg_temp.inv(text) to authenticated;

-- The receipts (as recorded at the desk), and their bank lines.
select public.record_instalment_payment(pg_temp.inv('Q1-P1'), 95933, 'bank_transfer', 'UTR2595ONE', 'R2595', null, 0, date '2026-08-05', 'e2595000-0000-4000-8000-0000000000ba');
select public.record_instalment_payment(pg_temp.inv('Q2-P1'), 94993, 'bank_transfer', 'UTR2595TWO', 'R2595', null, 0, date '2026-08-05', 'e2595000-0000-4000-8000-0000000000ba');
select public.record_instalment_payment(pg_temp.inv('Q3-P1'), 5850, 'bank_transfer', 'UTR2595THREE', 'R2595', null, 0, date '2026-08-05', 'e2595000-0000-4000-8000-0000000000ba');
select public.record_instalment_payment(pg_temp.inv('Q4-P1'), 95933, 'bank_transfer', 'UTR2595FOUR', 'R2595', null, 0, date '2026-08-05', 'e2595000-0000-4000-8000-0000000000ba');
select public.record_instalment_payment(pg_temp.inv('Q5-P1'), 95933, 'bank_transfer', 'UTR2595FIVEA', 'R2595', null, 0, date '2026-08-05', 'e2595000-0000-4000-8000-0000000000ba');
select public.record_instalment_payment(pg_temp.inv('Q5-P2'), 95993, 'bank_transfer', 'UTR2595FIVEB', 'R2595', null, 0, date '2026-08-06', 'e2595000-0000-4000-8000-0000000000ba');
select public.record_instalment_payment(pg_temp.inv('Q' || k || '-P1'), 95933, 'bank_transfer', 'UTR2595N' || k, 'R2595', null, 0, date '2026-08-05', 'e2595000-0000-4000-8000-0000000000ba')
  from generate_series(6, 10) k;
select set_config('request.jwt.claims', '', true);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit, source)
select ('e2595000-0000-4000-8000-0000000000' || to_hex(k + 224))::uuid, 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000ba',
       '2026-08-05', 'NEFT R2595 N' || k, 'UTR2595N' || k, 95933, 0, 'manual'
  from generate_series(6, 10) k;   -- lines ...e6 .. ...ea
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit, source) values
  ('e2595000-0000-4000-8000-0000000000d1', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000ba', '2026-08-05', 'NEFT R2595 ONE', 'UTR2595ONE', 95933, 0, 'manual'),
  ('e2595000-0000-4000-8000-0000000000d2', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000ba', '2026-08-05', 'NEFT R2595 TWO', 'UTR2595TWO', 94993, 0, 'manual'),
  ('e2595000-0000-4000-8000-0000000000d3', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000ba', '2026-08-05', 'NEFT R2595 THREE', 'UTR2595THREE', 5850, 0, 'manual'),
  ('e2595000-0000-4000-8000-0000000000d4', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000ba', '2026-08-05', 'NEFT R2595 FOUR', 'UTR2595FOUR', 95932, 0, 'manual'),
  ('e2595000-0000-4000-8000-0000000000d5', 'e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000ba', '2026-08-06', 'NEFT R2595 FIVE', 'UTR2595FIVEB', 95993, 0, 'manual');

create function pg_temp.try(p_quote text) returns text language plpgsql as $f$
begin
  perform public.settle_quote_part_short(p_quote, 'test');
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $f$;
grant execute on function pg_temp.try(text) to authenticated;
create function pg_temp.match(p_line uuid, p_quote text) returns void language sql as $f$
  update public.bank_transactions set matched_to_type = 'payment',
         matched_to_id = (select p.id::text from public.payments p where p.quote_id = p_quote and p.status = 'received' order by p.received_at desc limit 1)
   where id = p_line $f$;

do $$
declare v_err text; v_n int; v_res jsonb; v_short bigint;
begin
  -- UNBANKED.
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"e2595000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  v_err := pg_temp.try('Q-R2595-1');
  if v_err is null or v_err not like '%Match this receipt to its bank line first%' then
    insert into r2595_fail values ('UNBANKED: got ' || coalesce(v_err, 'success'));
  end if;
  set local role postgres;
  perform pg_temp.match('e2595000-0000-4000-8000-0000000000d1', 'Q-R2595-1');
  perform pg_temp.match('e2595000-0000-4000-8000-0000000000d2', 'Q-R2595-2');
  perform pg_temp.match('e2595000-0000-4000-8000-0000000000d3', 'Q-R2595-3');
  perform pg_temp.match('e2595000-0000-4000-8000-0000000000d4', 'Q-R2595-4');
  perform pg_temp.match('e2595000-0000-4000-8000-0000000000d5', 'Q-R2595-5');
  perform pg_temp.match(('e2595000-0000-4000-8000-0000000000' || to_hex(k + 224))::uuid, 'Q-R2595-' || k) from generate_series(6, 10) k;
  -- Q6: a credit note on the part invoice. Q7: a write-off on it. Q8: the receipt already on a split line.
  -- Q9: the line already has a round-off. Q10: the receipt carries TDS.
  insert into public.credit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount, tax_rate)
  values ('CN-R2595-6', 'e2595000-0000-0000-0000-0000000000a0', pg_temp.inv('Q6-P1'), 118, 100, 18, 18);
  update public.invoices set written_off_at = now(), write_off_reason = 'R2595 test' where id = pg_temp.inv('Q7-P1');
  update public.payments set bank_txn_id = 'e2595000-0000-4000-8000-0000000000e8' where quote_id = 'Q-R2595-8';
  insert into public.bank_receipt_round_offs (tenant_id, bank_txn_id, amount) values
    ('e2595000-0000-0000-0000-0000000000a0', 'e2595000-0000-4000-8000-0000000000e9', 1);
  insert into public.tds_receivable (id, tenant_id, customer_name, section, rate_pct, gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, payment_id)
  select 'TDS-R2595-10', 'e2595000-0000-0000-0000-0000000000a0', 'R2595 Cust', '194J', 2, 81350, 1627, 95933, '2026-27', date '2026-08-05', p.id
    from public.payments p where p.quote_id = 'Q-R2595-10';

  -- ROLE.
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"e2595000-0000-4000-8000-0000000000a3","role":"authenticated"}', true);
  v_err := pg_temp.try('Q-R2595-1');
  if v_err is null or v_err not like '42501%' then insert into r2595_fail values ('ROLE sales: got ' || coalesce(v_err, 'success')); end if;
  perform set_config('request.jwt.claims', '{"sub":"e2595000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
  v_err := pg_temp.try('Q-R2595-1');
  if v_err is null or v_err not like '42501%' then insert into r2595_fail values ('ROLE other company: got ' || coalesce(v_err, 'success')); end if;

  -- OVER LIMIT + TDS-LIKE.
  perform set_config('request.jwt.claims', '{"sub":"e2595000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  v_err := pg_temp.try('Q-R2595-2');
  if v_err is null or v_err not like '%Only a small difference%' then insert into r2595_fail values ('OVER LIMIT: got ' || coalesce(v_err, 'success')); end if;
  v_err := pg_temp.try('Q-R2595-3');
  if v_err is null or v_err not like '%looks like TDS%' then insert into r2595_fail values ('TDS-LIKE: got ' || coalesce(v_err, 'success')); end if;

  v_err := pg_temp.try('Q-R2595-4');
  if v_err is null or v_err not like '%not exactly this receipt%' then insert into r2595_fail values ('NOT EXACT: got ' || coalesce(v_err, 'success')); end if;
  v_err := pg_temp.try('Q-R2595-5');
  if v_err is null or v_err not like '%later part%' then insert into r2595_fail values ('LATER PART: got ' || coalesce(v_err, 'success')); end if;

  -- refuses_credit_note / refuses_split_line / refuses_when_tds_on_receipt.
  v_err := pg_temp.try('Q-R2595-6');
  if v_err is null or v_err not like '%credit note or a write-off%' then insert into r2595_fail values ('CREDIT NOTE: got ' || coalesce(v_err, 'success')); end if;
  v_err := pg_temp.try('Q-R2595-7');
  if v_err is null or v_err not like '%credit note or a write-off%' then insert into r2595_fail values ('WRITE-OFF: got ' || coalesce(v_err, 'success')); end if;
  v_err := pg_temp.try('Q-R2595-8');
  if v_err is null or v_err not like '%already pays several items or has a round-off%' then insert into r2595_fail values ('SPLIT LINE: got ' || coalesce(v_err, 'success')); end if;
  v_err := pg_temp.try('Q-R2595-9');
  if v_err is null or v_err not like '%already pays several items or has a round-off%' then insert into r2595_fail values ('ROUND-OFF LINE: got ' || coalesce(v_err, 'success')); end if;
  v_err := pg_temp.try('Q-R2595-10');
  if v_err is null or v_err not like '%This receipt has TDS%' then insert into r2595_fail values ('TDS RECEIPT: got ' || coalesce(v_err, 'success')); end if;

  -- SETTLE.
  v_res := public.settle_quote_part_short('Q-R2595-1', 'Bank kept ₹60');
  if (v_res->>'amount')::int is distinct from 60 then insert into r2595_fail values ('SETTLE: result ' || v_res::text); end if;
  select coalesce(sum(r.amount), 0) into v_short from public.report_settlement_shortfalls('2026-08-01', '2026-08-31') r;
  if v_short <> 62 then insert into r2595_fail values ('SETTLE: P&L settlement shortfall ₹' || v_short || ' (want ₹62: the ₹60 once + Q4''s ₹1 + Q9''s earlier ₹1 round-off)'); end if;

  -- TWICE.
  v_err := pg_temp.try('Q-R2595-1');
  if v_err is null then insert into r2595_fail values ('TWICE: a second settle was accepted'); end if;
  set local role postgres;

  if (select status::text from public.invoices where id = pg_temp.inv('Q1-P1')) is distinct from 'paid' then
    insert into r2595_fail values ('SETTLE: Part 1 invoice is not paid');
  end if;
  if (select sum(amount) from public.payments where quote_id = 'Q-R2595-1' and status = 'received') is distinct from 95993 then
    insert into r2595_fail values ('SETTLE: quote received is not ₹95,993');
  end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R2595-1' and bank_txn_id = 'e2595000-0000-4000-8000-0000000000d1';
  if v_n <> 2 then insert into r2595_fail values ('SETTLE: ' || v_n || ' receipts on the line (want 2)'); end if;
  if not exists (select 1 from public.payments where quote_id = 'Q-R2595-1' and amount = 60
                  and reference = 'BANKCHG-e2595000-0000-4000-8000-0000000000d1' and method = 'bank_transfer') then
    insert into r2595_fail values ('SETTLE: no ₹60 BANKCHG receipt');
  end if;
  if (select sum(amount) from public.bank_receipt_round_offs where bank_txn_id = 'e2595000-0000-4000-8000-0000000000d1') is distinct from 60 then
    insert into r2595_fail values ('SETTLE: no +60 round-off on the line');
  end if;
  if (select count(*) from public.payments where quote_id = 'Q-R2595-1') <> 2 then
    insert into r2595_fail values ('TWICE: more receipts than 2 on the quote');
  end if;
  if (select status::text || '|' || coalesce(paid_amount, 0) from public.invoices where id = pg_temp.inv('Q1-P2')) is distinct from 'pending|0' then
    insert into r2595_fail values ('NEXT PART: Part 2 invoice changed: ' || (select status::text || '|' || coalesce(paid_amount, 0) from public.invoices where id = pg_temp.inv('Q1-P2')));
  end if;
  if exists (select 1 from public.payments where quote_id like 'Q-R2595-%' and quote_id <> 'Q-R2595-1' and reference like 'BANKCHG-%')
     or (select count(*) from public.payments where quote_id like 'Q-R2595-%' and quote_id not in ('Q-R2595-1', 'Q-R2595-8') and bank_txn_id is not null) <> 0
     or (select count(*) from public.bank_receipt_round_offs where tenant_id = 'e2595000-0000-0000-0000-0000000000a0') <> 2
     or exists (select 1 from public.invoices where id in (pg_temp.inv('Q6-P1'), pg_temp.inv('Q7-P1'), pg_temp.inv('Q8-P1'), pg_temp.inv('Q9-P1'), pg_temp.inv('Q10-P1')) and coalesce(paid_amount, 0) <> 95933)
     or exists (select 1 from public.bank_receipt_round_offs where bank_txn_id in ('e2595000-0000-4000-8000-0000000000d2', 'e2595000-0000-4000-8000-0000000000d3', 'e2595000-0000-4000-8000-0000000000d4', 'e2595000-0000-4000-8000-0000000000d5')) then
    insert into r2595_fail values ('a refused call wrote something');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2595_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2595_settle_quote_part_short:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2595_settle_quote_part_short';
end $$;

rollback;
