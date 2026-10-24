-- Regression test: R-1578 — an expense turned into a fixed asset is CAPITALISED: report_pnl
-- must not count it as a cost (the asset register depreciates it instead — lib/accounting/
-- depreciation.ts; the P&L / Trial Balance depreciation line is built in TS from the register).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1578_capitalised_expense_pnl.test.sql
--
-- Tenant A, Oct 2026: a ₹1,20,000 laptop bought as an 'Equipment' expense (+ ₹21,600 GST),
-- turned into a fixed asset (fixed_assets.expense_id); a ₹5,000 rent expense; a ₹3,000
-- Equipment expense that was NOT capitalised. Tenant B owns an asset that points at A's
-- rent expense (expense_id is a plain FK, not tenant-checked) — it must not hide A's rent.
--   1. expense_groups / unassigned_by_category carry only rent + the small Equipment
--      expense (8,000) — the laptop is not a cost.
--   2. itc_groups do not carry the laptop's GST (else expenses = paid − ITC would go
--      negative by ₹21,600).
--   3. project_expenses do not carry a capitalised, project-tagged expense.
--   4. Before the asset exists the laptop IS a cost (the exclusion is the asset link, not the
--      category) — and a deleted asset puts it back.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('d1578000-0000-0000-0000-0000000000a1', 'R1578 A', 'r1578-a@example.in', '07'),
  ('d1578000-0000-0000-0000-0000000000b1', 'R1578 B', 'r1578-b@example.in', '07');
insert into auth.users (id, email) values
  ('d1578000-0000-0000-0000-0000000000a2', 'r1578-user-a@example.test');
insert into public.users (id, tenant_id, email, role) values
  ('d1578000-0000-0000-0000-0000000000a2', 'd1578000-0000-0000-0000-0000000000a1', 'r1578-user-a@example.in', 'owner');

insert into public.project_sales (id, tenant_id, title, customer_name, taxable_amount, gst_amount, total_amount) values
  ('d1578000-0000-0000-0000-0000000000c1', 'd1578000-0000-0000-0000-0000000000a1', 'R1578 Project', 'R1578 Cust', 100000, 18000, 118000);

insert into public.expenses (id, tenant_id, category, vendor_name, description, amount, gst_paid, bill_type, expense_date, project_id) values
  ('R1578-LAPTOP', 'd1578000-0000-0000-0000-0000000000a1', 'Equipment', 'Laptop Shop', 'Dell laptop', 141600, 21600, 'gst', '2026-10-05', null),
  ('R1578-RENT',   'd1578000-0000-0000-0000-0000000000a1', 'Office Rent', 'Landlord', 'Rent Oct', 5000, 0, 'none', '2026-10-06', null),
  ('R1578-MOUSE',  'd1578000-0000-0000-0000-0000000000a1', 'Equipment', 'Laptop Shop', 'Mouse', 3000, 0, 'none', '2026-10-07', null),
  ('R1578-SERVER', 'd1578000-0000-0000-0000-0000000000a1', 'Equipment', 'Server Co', 'Project server', 50000, 0, 'none', '2026-10-08', 'd1578000-0000-0000-0000-0000000000c1');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd1578000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);

-- 4 (before): the laptop is a cost until it is capitalised.
do $$
declare p record; total bigint;
begin
  select * into p from public.report_pnl('2026-10-01', '2026-10-31');
  select coalesce(sum((g->>'amount')::bigint), 0) into total from jsonb_array_elements(p.expense_groups) g;
  if total <> 199600 then raise exception 'FAIL 4a: before the asset, expenses % (want 199600)', total; end if;
end $$;

reset role;
insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use, expense_id) values
  ('d1578000-0000-0000-0000-0000000000f1', 'd1578000-0000-0000-0000-0000000000a1', 'Dell laptop', 'computers', 120000, '2026-10-05', 'R1578-LAPTOP'),
  ('d1578000-0000-0000-0000-0000000000f3', 'd1578000-0000-0000-0000-0000000000a1', 'Project server', 'computers', 50000, '2026-10-08', 'R1578-SERVER'),
  ('d1578000-0000-0000-0000-0000000000f2', 'd1578000-0000-0000-0000-0000000000b1', 'B points at A rent', 'furniture', 5000, '2026-10-06', 'R1578-RENT');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd1578000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);

do $$
declare p record; total bigint; eq bigint; gst bigint; un bigint;
begin
  select * into p from public.report_pnl('2026-10-01', '2026-10-31');
  -- 1
  select coalesce(sum((g->>'amount')::bigint), 0) into total from jsonb_array_elements(p.expense_groups) g;
  if total <> 8000 then raise exception 'FAIL 1a: expenses % (want 8000 — the capitalised laptop is not a cost): %', total, p.expense_groups; end if;
  select coalesce(sum((g->>'amount')::bigint), 0) into eq from jsonb_array_elements(p.expense_groups) g where g->>'category' = 'Equipment';
  if eq <> 3000 then raise exception 'FAIL 1b: Equipment % (want 3000 — the mouse stays a cost)', eq; end if;
  select coalesce(sum((g->>'amount')::bigint), 0) into un from jsonb_array_elements(p.unassigned_by_category) g;
  if un <> 8000 then raise exception 'FAIL 1c: unassigned_by_category % (want 8000)', un; end if;
  -- 2
  select coalesce(sum((g->>'gst_paid')::bigint), 0) into gst from jsonb_array_elements(p.itc_groups) g;
  if gst <> 0 then raise exception 'FAIL 2: itc_groups still carry % of capitalised GST', gst; end if;
  -- 3
  if jsonb_array_length(p.project_expenses) <> 0 then raise exception 'FAIL 3: project_expenses carry a capitalised expense: %', p.project_expenses; end if;
end $$;

-- 4 (after delete): the asset gone → the laptop is a cost again.
reset role;
delete from public.fixed_assets where id in ('d1578000-0000-0000-0000-0000000000f1', 'd1578000-0000-0000-0000-0000000000f3');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd1578000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
do $$
declare p record; total bigint;
begin
  select * into p from public.report_pnl('2026-10-01', '2026-10-31');
  select coalesce(sum((g->>'amount')::bigint), 0) into total from jsonb_array_elements(p.expense_groups) g;
  if total <> 199600 then raise exception 'FAIL 4b: asset deleted, expenses % (want 199600)', total; end if;
end $$;

rollback;
