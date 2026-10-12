-- Regression test: referral commission on project payments (migration 20260926170000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/referral_commission_project.test.sql
--
-- What it proves:
--   1. A 5% recurring agreement earns 5% of the pre-GST value on each project payment — bank and TDS
--      rows both (₹5,40,000 + ₹50,000 settle ₹5,00,000 taxable → ₹25,000), TDS 2% by default.
--   2. A fixed agreement pays once per instalment — not again on the TDS row.
--   3. A one_time agreement accrues once.
--   4. Deleting a project payment cancels its unpaid commission.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a9', 'REFPRJ TEST', 'rp@example.in', '07');
insert into public.customers (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-0000000c0009', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'Demo Co'),
  ('aaaaaaaa-0000-0000-0000-0000000c0010', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'Fixed Fee Co'),
  ('aaaaaaaa-0000-0000-0000-0000000c0011', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'Once Co');
insert into public.referral_partners (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-0000000e0009', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'Ramesh Kumar');
insert into public.referral_agreements (id, tenant_id, partner_id, customer_id, label, basis, percent, fixed_amount, scope, deduct_tds, status) values
  ('aaaaaaaa-0000-0000-0000-0000000a0901', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000e0009', 'aaaaaaaa-0000-0000-0000-0000000c0009', 'ERP referral', 'percent', 5, 0, 'recurring', true, 'active'),
  ('aaaaaaaa-0000-0000-0000-0000000a0902', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000e0009', 'aaaaaaaa-0000-0000-0000-0000000c0010', 'Fixed', 'fixed', 0, 10000, 'recurring', false, 'active'),
  ('aaaaaaaa-0000-0000-0000-0000000a0903', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000e0009', 'aaaaaaaa-0000-0000-0000-0000000c0011', 'Once', 'percent', 10, 0, 'one_time', false, 'active');
insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, gst_rate) values
  ('aaaaaaaa-0000-0000-0000-0000000b0901', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000c0009', 'Demo Co', 'Complete Billing System', 5000000, 900000, 5900000, 18),
  ('aaaaaaaa-0000-0000-0000-0000000b0902', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000c0010', 'Fixed Fee Co', 'App', 1000000, 180000, 1180000, 18),
  ('aaaaaaaa-0000-0000-0000-0000000b0903', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000c0011', 'Once Co', 'Site', 1000000, 180000, 1180000, 18);

-- 1. percent: bank + TDS rows of one instalment
insert into public.project_payments (id, tenant_id, project_id, amount, method, received_at) values
  ('aaaaaaaa-0000-0000-0000-0000000d0901', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000b0901', 540000, 'bank_transfer', '2026-08-07'),
  ('aaaaaaaa-0000-0000-0000-0000000d0902', 'aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000b0901', 50000,  'tds',           '2026-08-07');
do $$ declare g int; t int; begin
  select sum(gross_commission), sum(tds_amount) into g, t from public.referral_commissions
   where agreement_id = 'aaaaaaaa-0000-0000-0000-0000000a0901' and status = 'earned';
  -- 457627 + 42373 = 500000 taxable → 5% = 22881 + 2119 = 25000
  if g <> 25000 then raise exception 'FAIL: percent commission %', g; end if;
  if t <> 458 + 42 then raise exception 'FAIL: TDS at 2%% %', t; end if;
end $$;

-- 2. fixed: once per instalment, not on the TDS row
insert into public.project_payments (tenant_id, project_id, amount, method, received_at) values
  ('aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000b0902', 108000, 'bank_transfer', '2026-08-10'),
  ('aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000b0902', 10000,  'tds',           '2026-08-10');
do $$ begin
  if (select count(*) from public.referral_commissions where agreement_id = 'aaaaaaaa-0000-0000-0000-0000000a0902') <> 1 then
    raise exception 'FAIL: fixed fee accrued on the TDS row too'; end if;
end $$;

-- 3. one_time: once
insert into public.project_payments (tenant_id, project_id, amount, method, received_at) values
  ('aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000b0903', 118000, 'bank_transfer', '2026-08-11'),
  ('aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-0000000b0903', 118000, 'bank_transfer', '2026-09-11');
do $$ begin
  if (select count(*) from public.referral_commissions where agreement_id = 'aaaaaaaa-0000-0000-0000-0000000a0903') <> 1 then
    raise exception 'FAIL: one_time accrued twice'; end if;
end $$;

-- 4. delete cancels
delete from public.project_payments where id = 'aaaaaaaa-0000-0000-0000-0000000d0902';
do $$ begin
  if (select status from public.referral_commissions where project_payment_id = 'aaaaaaaa-0000-0000-0000-0000000d0902') <> 'cancelled' then
    raise exception 'FAIL: commission not cancelled'; end if;
end $$;

select 'referral_commission_project: all assertions passed' as result;
rollback;
