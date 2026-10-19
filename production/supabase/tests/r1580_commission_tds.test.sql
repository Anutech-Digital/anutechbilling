\set ON_ERROR_STOP on
-- R-1580 (P1): report_balance_sheet — TDS deducted on partner commissions (s.194H) is a
-- statutory due, and commission earned but not yet paid is a payable.
-- Migration: 20261018184158_r1580_commission_tds.sql (on R-1614's body).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1580_commission_tds.test.sql
--
-- Expect "PASS r1580_commission_tds". Every check is collected and failures listed together.
--
--   EARNED    ₹50,000 commission, 194H TDS ₹1,000, net ₹49,000, earned 15 Oct, not paid
--             → commissions_payable ₹49,000; its ₹1,000 in dues_vendor_tds.
--   PAID      ₹10,000 commission, TDS ₹200, paid (net ₹9,800 left the bank) → no payable;
--             the ₹200 TDS stays a due until a challan (TS subtracts dues_paid).
--   CANCELLED ₹5,000 / TDS ₹100 cancelled → in neither.
--   EXPENSE   a ₹300 vendor TDS on an expense still counts (unchanged) → dues 300+1000+200 = 1,500.
--   OTHER     another company's commission is in none of these.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1580000-0000-4000-8000-0000000000a2', 'r1580-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1580000-0000-0000-0000-0000000000a0', 'R1580 A', 'r1580a@example.in', '07', 'R158'),
  ('e1580000-0000-0000-0000-0000000000b0', 'R1580 B', 'r1580b@example.in', '07', 'R15B');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1580000-0000-4000-8000-0000000000a2', 'e1580000-0000-0000-0000-0000000000a0', 'r1580-owner@example.in', 'R1580 Owner', 'owner', true);

insert into public.referral_partners (id, tenant_id, name, pan, deduct_tds, tds_rate) values
  ('e1580000-0000-4000-8000-0000000000e1', 'e1580000-0000-0000-0000-0000000000a0', 'R1580 Partner', 'ABCPS1234K', true, 2),
  ('e1580000-0000-4000-8000-0000000000e2', 'e1580000-0000-0000-0000-0000000000b0', 'R1580 Other',   null,         true, 2);
insert into public.referral_agreements (id, tenant_id, partner_id, basis, percent, scope, deduct_tds, tds_rate, status) values
  ('e1580000-0000-4000-8000-0000000000f1', 'e1580000-0000-0000-0000-0000000000a0', 'e1580000-0000-4000-8000-0000000000e1', 'percent', 10, 'recurring', true, 2, 'active'),
  ('e1580000-0000-4000-8000-0000000000f2', 'e1580000-0000-0000-0000-0000000000b0', 'e1580000-0000-4000-8000-0000000000e2', 'percent', 10, 'recurring', true, 2, 'active');

insert into public.referral_commissions
    (tenant_id, agreement_id, partner_id, basis, rate, base_amount, gross_commission, tds_amount, net_payable, status, earned_date, paid_date) values
  ('e1580000-0000-0000-0000-0000000000a0', 'e1580000-0000-4000-8000-0000000000f1', 'e1580000-0000-4000-8000-0000000000e1', 'percent', 10, 500000, 50000, 1000, 49000, 'earned',    '2026-10-15', null),
  ('e1580000-0000-0000-0000-0000000000a0', 'e1580000-0000-4000-8000-0000000000f1', 'e1580000-0000-4000-8000-0000000000e1', 'percent', 10, 100000, 10000,  200,  9800, 'paid',      '2026-10-05', '2026-10-20'),
  ('e1580000-0000-0000-0000-0000000000a0', 'e1580000-0000-4000-8000-0000000000f1', 'e1580000-0000-4000-8000-0000000000e1', 'percent', 10,  50000,  5000,  100,  4900, 'cancelled', '2026-10-06', null),
  ('e1580000-0000-0000-0000-0000000000b0', 'e1580000-0000-4000-8000-0000000000f2', 'e1580000-0000-4000-8000-0000000000e2', 'percent', 10,  70000,  7000,  140,  6860, 'earned',    '2026-10-07', null);

insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, tds_section, tds_amount, paid, payment_method) values
  ('EXP-R1580-1', 'e1580000-0000-0000-0000-0000000000a0', 'Professional Fees', 'R1580 CA', '2026-10-10', 30000, 0, '194J', 300, true, 'bank_transfer');

create temp table r1580_fail (msg text) on commit drop;
grant all on r1580_fail to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'e1580000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

do $$
declare b record;
begin
  select * into b from public.report_balance_sheet('2026-10-31');
  if b.commissions_payable <> 49000 then
    insert into r1580_fail values (format('EARNED/PAID/CANCELLED/OTHER: commissions_payable %s (want 49000 — only the earned, unpaid net)', b.commissions_payable));
  end if;
  if b.dues_vendor_tds <> 1500 then
    insert into r1580_fail values (format('EARNED/PAID/CANCELLED/EXPENSE/OTHER: dues_vendor_tds %s (want 1500 = expense 300 + commission TDS 1000 + 200)', b.dues_vendor_tds));
  end if;
end $$;

reset role;
do $$
declare n int; m text;
begin
  select count(*), string_agg(msg, E'\n') into n, m from r1580_fail;
  if n > 0 then raise exception E'FAIL r1580_commission_tds (% checks):\n%', n, m; end if;
  raise notice 'PASS r1580_commission_tds';
end $$;

rollback;
