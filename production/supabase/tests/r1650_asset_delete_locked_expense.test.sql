-- R-1650 — a fixed asset bought with an expense inside a locked month cannot be deleted
-- (migration 20261023223717_r1650_asset_delete_locked_expense.sql).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1650_asset_delete_locked_expense.test.sql
--
-- What it proves:
--   1. Books locked to 30 Jun 2026. Laptop A: expense 15 Jun (locked), put to use 5 Jul (open).
--      Deleting A → refused (check_violation); un-linking its expense → refused.
--   2. Editing A's notes is still allowed (only the link matters).
--   3. Laptop B: expense 10 Jul (open). Deleting B is allowed, and B's expense is back in July's
--      report_pnl expenses — the rule the confirm dialog now states.
--   4. Another company's owner cannot see/delete A (RLS) — nothing changes.
--   5. A direct DB session (no API role) is trusted, as tg_books_locked.
--   6. MUTATION CHECK: with the trigger dropped, deleting A goes through — so check 1 is what
--      the new trigger adds, not something the old lock already did.

begin;

insert into public.tenants (id, name, email, state_code, doc_code, books_locked_until) values
  ('c1650000-0000-0000-0000-0000000000a1'::uuid, 'T-R1650 A', 'r1650-a@example.in', '07', 'TQA', '2026-06-30'),
  ('c1650000-0000-0000-0000-0000000000b1'::uuid, 'T-R1650 B', 'r1650-b@example.in', '07', 'TQB', null);

insert into auth.users (id, email) values
  ('c1650000-0000-0000-0000-00000000a0a1', 'r1650-owner-a@example.test'),
  ('c1650000-0000-0000-0000-00000000b0b1', 'r1650-owner-b@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1650000-0000-0000-0000-00000000a0a1', 'c1650000-0000-0000-0000-0000000000a1', 'r1650-owner-a@example.in', 'owner', 'Owner A'),
  ('c1650000-0000-0000-0000-00000000b0b1', 'c1650000-0000-0000-0000-0000000000b1', 'r1650-owner-b@example.in', 'owner', 'Owner B');

insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type) values
  ('r1650-exp-jun', 'c1650000-0000-0000-0000-0000000000a1', 'Equipment', 'T-Laptop shop', '2026-06-15', 85000, 0, 'none'),
  ('r1650-exp-jul', 'c1650000-0000-0000-0000-0000000000a1', 'Equipment', 'T-Laptop shop', '2026-07-10', 61000, 0, 'none');

insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use, expense_id) values
  ('c1650000-0000-0000-0000-0000000f0001', 'c1650000-0000-0000-0000-0000000000a1', 'Laptop A', 'computers', 85000, '2026-07-05', 'r1650-exp-jun'),
  ('c1650000-0000-0000-0000-0000000f0002', 'c1650000-0000-0000-0000-0000000000a1', 'Laptop B', 'computers', 61000, '2026-07-12', 'r1650-exp-jul');

set local role authenticated;

do $$
declare
  v_ok boolean;
  v_n int;
  v_jul bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1650000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);

  -- 1a. delete A → refused
  v_ok := false;
  begin
    delete from public.fixed_assets where id = 'c1650000-0000-0000-0000-0000000f0001';
  exception when check_violation then
    v_ok := sqlerrm like '%lock%' and sqlerrm like '%Laptop A%';
  end;
  if not v_ok then raise exception 'FAIL 1a: deleting an asset whose expense is in a locked month was not refused'; end if;

  -- 1b. un-link A's expense → refused
  v_ok := false;
  begin
    update public.fixed_assets set expense_id = null where id = 'c1650000-0000-0000-0000-0000000f0001';
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL 1b: un-linking a locked-month expense was not refused'; end if;
  select count(*) into v_n from public.fixed_assets where id = 'c1650000-0000-0000-0000-0000000f0001' and expense_id = 'r1650-exp-jun';
  if v_n <> 1 then raise exception 'FAIL 1: Laptop A changed'; end if;

  -- 2. notes edit still allowed
  update public.fixed_assets set notes = 'serial 123' where id = 'c1650000-0000-0000-0000-0000000f0001';
  select count(*) into v_n from public.fixed_assets where id = 'c1650000-0000-0000-0000-0000000f0001' and notes = 'serial 123';
  if v_n <> 1 then raise exception 'FAIL 2: notes edit blocked'; end if;

  -- 3. B (open month) — before delete, July P&L leaves its expense out; after, it is a cost again
  select coalesce(sum((g->>'amount')::bigint), 0) into v_jul
    from public.report_pnl('2026-07-01', '2026-07-31') r, jsonb_array_elements(r.expense_groups) g;
  if v_jul <> 0 then raise exception 'FAIL 3a: July expenses % before delete (B is capitalised)', v_jul; end if;
  delete from public.fixed_assets where id = 'c1650000-0000-0000-0000-0000000f0002';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 3b: open-month asset not deleted'; end if;
  select coalesce(sum((g->>'amount')::bigint), 0) into v_jul
    from public.report_pnl('2026-07-01', '2026-07-31') r, jsonb_array_elements(r.expense_groups) g;
  if v_jul <> 61000 then raise exception 'FAIL 3c: July expenses % after delete, expected 61000', v_jul; end if;

  -- 4. another company: sees nothing, deletes nothing
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1650000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  delete from public.fixed_assets where id = 'c1650000-0000-0000-0000-0000000f0001';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: other tenant deleted Laptop A'; end if;
end $$;

reset role;

do $$
declare v_n int;
begin
  -- 6. MUTATION CHECK — without the new trigger the old lock lets the delete through.
  alter table public.fixed_assets disable trigger trg_fixed_asset_expense_lock;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1650000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  delete from public.fixed_assets where id = 'c1650000-0000-0000-0000-0000000f0001';
  get diagnostics v_n = row_count;
  execute 'reset role';
  if v_n <> 1 then raise exception 'FAIL 6: mutation check — without the trigger the delete should have gone through (got %)', v_n; end if;
  raise notice 'mutation check: without trg_fixed_asset_expense_lock the locked-month delete succeeds (as before R-1650)';
end $$;

rollback;

-- 5. Direct DB session (trusted) — separate transaction, also rolled back.
begin;
insert into public.tenants (id, name, email, state_code, doc_code, books_locked_until) values
  ('c1650000-0000-0000-0000-0000000000c1'::uuid, 'T-R1650 C', 'r1650-c@example.in', '07', 'TQC', '2026-06-30');
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type) values
  ('r1650-exp-c', 'c1650000-0000-0000-0000-0000000000c1', 'Equipment', 'T-shop', '2026-06-15', 1000, 0, 'none');
insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use, expense_id) values
  ('c1650000-0000-0000-0000-0000000f0003', 'c1650000-0000-0000-0000-0000000000c1', 'Chair C', 'furniture', 1000, '2026-07-05', 'r1650-exp-c');
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', '', true);
  delete from public.fixed_assets where id = 'c1650000-0000-0000-0000-0000000f0003';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 5: direct DB session was blocked'; end if;
  raise notice 'R-1650: all checks passed';
end $$;
rollback;
