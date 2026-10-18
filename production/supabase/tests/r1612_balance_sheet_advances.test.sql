\set ON_ERROR_STOP on
-- R-1612 (P1): report_balance_sheet — advance credit applied to a payment is not cash again,
-- and an overpayment's credit stops being a liability once it is used.
-- Migration: 20261018163944_r1612_balance_sheet_advances.sql (on R-1576's body).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1612_balance_sheet_advances.test.sql
--
-- Expect "PASS r1612_balance_sheet_advances". Every check is collected and failures listed together.
--
--   USED      Quote A ₹6,000 invoiced + paid; ₹10,000 received → ₹4,000 overpayment credit, later
--             USED on quote B (not invoiced): B's payment amount ₹6,000 = ₹2,000 cash + ₹4,000
--             credit (credit_applied 4,000). Money in = ₹12,000 → undeposited ₹12,000 (was
--             ₹16,000). Liability = B's ₹6,000 advance only (was ₹10,000: A's used ₹4,000 stayed).
--   OPEN      Quote D ₹1,000 invoiced, ₹1,500 received → ₹500 credit still open → +₹500 liability.
--   UNINV     Quote E ₹1,000 not invoiced, ₹1,300 received → ₹300 open credit → ₹1,300 liability
--             (₹1,000 advance + ₹300 credit — never ₹1,600).
--   INST      Split-billed quote S (no invoice of its own): ₹2,360 paid on its raised instalment
--             invoice INV-S1 (paid_amount 2,360) → not an advance (was ₹2,360); ₹640 extra waits
--             for the next instalment → ₹640 advance.
--   RECEIV    receivables unchanged (0 — everything paid).
--   OTHER     another company's rows are in none of these.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1612000-0000-4000-8000-0000000000a2', 'r1612-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1612000-0000-0000-0000-0000000000a0', 'R1612 A', 'r1612a@example.in', '07', 'R161'),
  ('e1612000-0000-0000-0000-0000000000b0', 'R1612 B', 'r1612b@example.in', '07', 'R16B');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1612000-0000-4000-8000-0000000000a2', 'e1612000-0000-0000-0000-0000000000a0', 'r1612-owner@example.in', 'R1612 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1612000-0000-4000-8000-0000000000c1', 'e1612000-0000-0000-0000-0000000000a0', 'R1612 Cust', '07', 'India'),
  ('e1612000-0000-4000-8000-0000000000c2', 'e1612000-0000-0000-0000-0000000000b0', 'R1612 Other', '07', 'India');

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, paid_amount, taxable_value, tax_amount, tax_rate, invoice_date, status, quote_id) values
  ('R1612-INV-A',  'e1612000-0000-0000-0000-0000000000a0', 'R1612 Cust', 'e1612000-0000-4000-8000-0000000000c1', 6000, 6000, 6000, 5085, 915, 18, '2026-09-05', 'paid', null),
  ('R1612-INV-D',  'e1612000-0000-0000-0000-0000000000a0', 'R1612 Cust', 'e1612000-0000-4000-8000-0000000000c1', 1000, 1000, 1000, 847, 153, 18, '2026-09-06', 'paid', null),
  ('R1612-INV-S1', 'e1612000-0000-0000-0000-0000000000a0', 'R1612 Cust', 'e1612000-0000-4000-8000-0000000000c1', 2360, 2360, 2360, 2000, 360, 18, '2026-10-01', 'paid', null);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id)
select 'Q-R1612-' || k, 'e1612000-0000-0000-0000-0000000000a0', 'e1612000-0000-4000-8000-0000000000c1', 'R1612 Cust',
       amt, round(amt / 1.18), 18, 'accepted', 'none', '[]'::jsonb, inv
  from (values ('A', 6000, 'R1612-INV-A'), ('B', 6000, null), ('D', 1000, 'R1612-INV-D'), ('E', 1000, null), ('S', 9440, null)) v(k, amt, inv);
update public.invoices set quote_id = 'Q-R1612-A' where id = 'R1612-INV-A';
update public.invoices set quote_id = 'Q-R1612-D' where id = 'R1612-INV-D';
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id) values
  ('Q-R1612-X', 'e1612000-0000-0000-0000-0000000000b0', 'e1612000-0000-4000-8000-0000000000c2', 'R1612 Other', 5000, 4237, 18, 'accepted', 'none', '[]'::jsonb, null);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id) values
  ('e1612000-0000-4000-8000-0000000000e1', 'e1612000-0000-0000-0000-0000000000a0', 'e1612000-0000-4000-8000-0000000000c1', 'R1612 Cust', 'Workspace Starter', 'google'::vendor, 2, 667, 'quarterly'::billing_cycle, 'Q-R1612-S');
insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, invoice_id) values
  ('e1612000-0000-0000-0000-0000000000a0', 'e1612000-0000-4000-8000-0000000000e1', '2026-10-01', 1, '2026-10-01', '2026-10-01', '2026-12-31', 2000, 18, 'R1612-INV-S1'),
  ('e1612000-0000-0000-0000-0000000000a0', 'e1612000-0000-4000-8000-0000000000e1', '2026-10-01', 2, '2027-01-01', '2027-01-01', '2027-03-31', 2000, 18, null);

insert into public.payments (id, tenant_id, quote_id, customer_id, amount, credit_applied, method, reference, status, received_at) values
  ('e1612000-0000-4000-8000-0000000000a1', 'e1612000-0000-0000-0000-0000000000a0', 'Q-R1612-A', 'e1612000-0000-4000-8000-0000000000c1', 10000, 0,    'upi', 'R1612-A', 'received', '2026-09-05'),
  ('e1612000-0000-4000-8000-0000000000b1', 'e1612000-0000-0000-0000-0000000000a0', 'Q-R1612-B', 'e1612000-0000-4000-8000-0000000000c1', 6000,  4000, 'upi', 'R1612-B', 'received', '2026-10-05'),
  ('e1612000-0000-4000-8000-0000000000d1', 'e1612000-0000-0000-0000-0000000000a0', 'Q-R1612-D', 'e1612000-0000-4000-8000-0000000000c1', 1500,  0,    'upi', 'R1612-D', 'received', '2026-09-06'),
  ('e1612000-0000-4000-8000-0000000000e9', 'e1612000-0000-0000-0000-0000000000a0', 'Q-R1612-E', 'e1612000-0000-4000-8000-0000000000c1', 1300,  0,    'upi', 'R1612-E', 'received', '2026-10-06'),
  ('e1612000-0000-4000-8000-0000000000f1', 'e1612000-0000-0000-0000-0000000000a0', 'Q-R1612-S', 'e1612000-0000-4000-8000-0000000000c1', 3000,  0,    'upi', 'R1612-S', 'received', '2026-10-02'),
  ('e1612000-0000-4000-8000-0000000000f9', 'e1612000-0000-0000-0000-0000000000b0', 'Q-R1612-X', 'e1612000-0000-4000-8000-0000000000c2', 5000,  0,    'upi', 'R1612-X', 'received', '2026-10-02');

insert into public.customer_credits (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, status) values
  -- A's ₹4,000 overpayment, used on B.
  ('e1612000-0000-0000-0000-0000000000a0', 'e1612000-0000-4000-8000-0000000000c1', 4000, 'overpayment', 'e1612000-0000-4000-8000-0000000000a1', 'Q-R1612-A', 'used'),
  ('e1612000-0000-0000-0000-0000000000a0', 'e1612000-0000-4000-8000-0000000000c1', 500,  'overpayment', 'e1612000-0000-4000-8000-0000000000d1', 'Q-R1612-D', 'open'),
  ('e1612000-0000-0000-0000-0000000000a0', 'e1612000-0000-4000-8000-0000000000c1', 300,  'overpayment', 'e1612000-0000-4000-8000-0000000000e9', 'Q-R1612-E', 'open'),
  ('e1612000-0000-0000-0000-0000000000b0', 'e1612000-0000-4000-8000-0000000000c2', 999,  'overpayment', null, 'Q-R1612-X', 'open');

create temp table r1612_fail (msg text) on commit drop;
grant all on r1612_fail to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'e1612000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

do $$
declare b record;
begin
  select * into b from public.report_balance_sheet('2026-10-31');
  -- cash in hand: 10,000 + 2,000 (B's cash) + 1,500 + 1,300 + 3,000 = 17,800 (was 21,800)
  if b.undeposited_funds <> 17800 then
    insert into r1612_fail values (format('USED cash: undeposited_funds %s (want 17800 — B''s ₹4,000 credit is not money in)', b.undeposited_funds));
  end if;
  -- liability: B 6,000 + D open 500 + E (1,000 advance + 300 credit) + S 640 = 8,440
  --   (was 6,000 + 4,000 used + 500 + 1,300 + 3,000 = 14,800)
  if b.advances_from_customers <> 8440 then
    insert into r1612_fail values (format('USED/OPEN/UNINV/INST liability: advances_from_customers %s (want 8440)', b.advances_from_customers));
  end if;
  if b.receivables <> 0 then
    insert into r1612_fail values (format('RECEIV: receivables %s (want 0)', b.receivables));
  end if;
end $$;

reset role;
do $$
declare n int; m text;
begin
  select count(*), string_agg(msg, E'\n') into n, m from r1612_fail;
  if n > 0 then raise exception E'FAIL r1612_balance_sheet_advances (% checks):\n%', n, m; end if;
  raise notice 'PASS r1612_balance_sheet_advances';
end $$;

rollback;
