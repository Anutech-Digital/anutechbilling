-- Regression test: R-2181 — a P&L Revenue row's drill-down lists only that row's documents,
-- and its total equals the row (ex-GST, net of credit notes).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2181_pnl_revenue_drill.test.sql
--
-- Fixture (tenant A, Oct 2026), three families + a fully credited invoice + a mixed invoice:
--   GW1  Google Workspace item 10 × 1,000                  → google 10,000
--   MS1  Microsoft 365 item 4 × 1,500                      → microsoft 6,000
--   MS2  Microsoft 365 item 2 × 1,500, fully credited by CN-MS2 (3,000) → microsoft net 0
--   ZO1  Zoho item 3 × 800                                 → zoho 2,400
--   MIX  Google 1 × 1,000 + Microsoft 1 × 1,000, taxable 2,001 → google 1,001 · microsoft 1,000
--   Tenant B: one Microsoft invoice (must never show).
-- 1. Microsoft drill: only Microsoft rows (MS1, MS2, CN-MS2, MIX's Microsoft share); total
--    6,000 + 3,000 − 3,000 + 1,000 = 7,000 = the Microsoft row of report_pnl_revenue_by_product.
-- 2. Every family: drill total = its row. All families (Revenue card) = report_pnl Revenue.
-- 3. The fully credited invoice nets to ₹0; amounts are ex-GST.
-- 4. No company → refused; tenant B's invoice never appears.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('d2181000-0000-0000-0000-0000000000a1', 'R2181 A', 'r2181-a@example.in', '07'),
  ('d2181000-0000-0000-0000-0000000000b1', 'R2181 B', 'r2181-b@example.in', '07');
insert into auth.users (id, email) values
  ('d2181000-0000-0000-0000-0000000000a2', 'r2181-user-a@example.test'),
  ('d2181000-0000-0000-0000-0000000000b2', 'r2181-user-b@example.test'),
  ('d2181000-0000-0000-0000-0000000000c2', 'r2181-nobody@example.test');
insert into public.users (id, tenant_id, email, role) values
  ('d2181000-0000-0000-0000-0000000000a2', 'd2181000-0000-0000-0000-0000000000a1', 'r2181-user-a@example.in', 'owner'),
  ('d2181000-0000-0000-0000-0000000000b2', 'd2181000-0000-0000-0000-0000000000b1', 'r2181-user-b@example.in', 'owner');

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('R2181-GW',   'd2181000-0000-0000-0000-0000000000a1', 'Business Starter', 'google',    1000, 600),
  ('R2181-MS',   'd2181000-0000-0000-0000-0000000000a1', 'Business Basic',   'microsoft', 1500, 900),
  ('R2181-ZO',   'd2181000-0000-0000-0000-0000000000a1', 'Mail Lite',        'zoho',      800,  500);

insert into public.invoices (id, tenant_id, customer_name, amount, taxable_value, tax_amount, tax_rate, status, invoice_date, document_kind, line_items) values
  ('R2181-GW1', 'd2181000-0000-0000-0000-0000000000a1', 'Cust G', 11800, 10000, 1800, 18, 'paid',    '2026-10-03', 'tax_invoice',
   '[{"id":"l1","name":"Business Starter","item_id":"R2181-GW","qty":10,"rate":1000}]'),
  ('R2181-MS1', 'd2181000-0000-0000-0000-0000000000a1', 'Cust M', 7080,  6000,  1080, 18, 'pending', '2026-10-04', 'tax_invoice',
   '[{"id":"l1","name":"Business Basic","item_id":"R2181-MS","qty":4,"rate":1500}]'),
  ('R2181-MS2', 'd2181000-0000-0000-0000-0000000000a1', 'Cust N', 3540,  3000,  540,  18, 'paid',    '2026-10-05', 'tax_invoice',
   '[{"id":"l1","name":"Business Basic","item_id":"R2181-MS","qty":2,"rate":1500}]'),
  ('R2181-ZO1', 'd2181000-0000-0000-0000-0000000000a1', 'Cust Z', 2832,  2400,  432,  18, 'overdue', '2026-10-06', 'tax_invoice',
   '[{"id":"l1","name":"Mail Lite","item_id":"R2181-ZO","qty":3,"rate":800}]'),
  ('R2181-MIX', 'd2181000-0000-0000-0000-0000000000a1', 'Cust X', 2361,  2001,  360,  18, 'paid',    '2026-10-07', 'tax_invoice',
   '[{"id":"l1","name":"Business Starter","item_id":"R2181-GW","qty":1,"rate":1000},
     {"id":"l2","name":"Business Basic","item_id":"R2181-MS","qty":1,"rate":1000}]'),
  ('R2181-B',   'd2181000-0000-0000-0000-0000000000b1', 'Cust B', 11800, 10000, 1800, 18, 'paid',    '2026-10-03', 'tax_invoice',
   '[{"id":"l1","name":"Microsoft 365 Business Basic","qty":1,"rate":10000}]');

insert into public.credit_notes (id, tenant_id, invoice_id, customer_name, reason_code, amount, taxable_value, tax_amount, tax_rate, credit_date) values
  ('CN-R2181-MS2', 'd2181000-0000-0000-0000-0000000000a1', 'R2181-MS2', 'Cust N', 'other', 3540, 3000, 540, 18, '2026-10-20');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd2181000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);

-- ── 1. The Microsoft row opens only Microsoft documents, and adds up to the row ──────────
do $$
declare got text; tot bigint; row_amt bigint;
begin
  select string_agg(format('%s:%s:%s', l.doc_id, l.family, l.amount), ',' order by l.doc_id), sum(l.amount)
    into got, tot
    from public.report_pnl_revenue_lines('2026-10-01', '2026-10-31', array['microsoft']) l;
  if got is distinct from 'CN-R2181-MS2:microsoft:-3000,R2181-MIX:microsoft:1000,R2181-MS1:microsoft:6000,R2181-MS2:microsoft:3000' then
    raise exception 'FAIL 1a: Microsoft drill rows = % (want only MS1, MS2, its credit note and MIX''s Microsoft share)', got;
  end if;
  select r.invoiced - r.credit_notes + r.debit_notes into row_amt
    from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31') r where r.family = 'microsoft';
  if tot is distinct from 7000 or tot is distinct from row_amt then
    raise exception 'FAIL 1b: Microsoft drill total % <> row % (want 7000)', tot, row_amt;
  end if;
end $$;

-- ── 2. Every family's drill = its row; all families = report_pnl Revenue ────────────────
do $$
declare diff text; p record; allsum bigint; n int;
begin
  select string_agg(format('%s: row %s drill %s', r.family, r.invoiced - r.credit_notes + r.debit_notes,
                           (select sum(l.amount) from public.report_pnl_revenue_lines('2026-10-01', '2026-10-31', array[r.family]) l)), '; ')
    into diff
    from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31') r
   where (r.invoiced - r.credit_notes + r.debit_notes)
         is distinct from (select coalesce(sum(l.amount), 0) from public.report_pnl_revenue_lines('2026-10-01', '2026-10-31', array[r.family]) l);
  if diff is not null then raise exception 'FAIL 2a: drill <> row: %', diff; end if;

  select count(*) into n from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31');
  if n <> 3 then raise exception 'FAIL 2b: % families (want google, microsoft, zoho)', n; end if;

  select * into p from public.report_pnl('2026-10-01', '2026-10-31');
  select sum(l.amount) into allsum from public.report_pnl_revenue_lines('2026-10-01', '2026-10-31') l;
  if allsum is distinct from p.inv_taxable - p.cn_taxable + p.dn_taxable or allsum <> 20401 then
    raise exception 'FAIL 2c: Revenue drill % <> report_pnl Revenue % (want 20401, ex-GST)', allsum, p.inv_taxable - p.cn_taxable + p.dn_taxable;
  end if;
end $$;

-- ── 3. The fully credited invoice nets to ₹0 ──────────────────────────────────────────
do $$
declare net bigint;
begin
  select sum(l.amount) into net from public.report_pnl_revenue_lines('2026-10-01', '2026-10-31') l where l.invoice_id = 'R2181-MS2';
  if net is distinct from 0 then raise exception 'FAIL 3: fully credited MS2 nets to % (want 0)', net; end if;
  if exists (select 1 from public.report_pnl_revenue_lines('2026-10-01', '2026-10-31') l where l.invoice_id = 'R2181-B') then
    raise exception 'FAIL 4a: tenant B''s invoice shows in tenant A''s drill';
  end if;
end $$;

-- ── 4. No company → refused ─────────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'd2181000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
do $$
begin
  perform * from public.report_pnl_revenue_lines('2026-10-01', '2026-10-31');
  raise exception 'FAIL 4b: a user with no company read the drill';
exception when insufficient_privilege then null;
end $$;

rollback;
