-- R-1809 — a fixed asset cannot be LINKED to an expense inside a locked month
-- (migration 20261023232214_r1809_asset_link_locked_expense.sql, on top of R-1650's
-- 20261023223717_r1650_asset_delete_locked_expense.sql).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1809_asset_link_locked_expense.test.sql
--
-- What it proves (books locked to 30 Jun 2026):
--   1. Adding an asset (put to use 5 Jul — open) linked to a 15 Jun expense → refused with the
--      message "That expense is in a locked month (June 2026). Unlock the month first, or add the
--      asset without linking the expense." — and June's report_pnl still carries the expense.
--   2. The same asset WITHOUT the link is added.
--   3. Linking it afterwards (UPDATE expense_id → the June expense) → refused.
--   4. Linking a 10 Jul expense (open month) → allowed; July's P&L leaves that expense out.
--   5. R-1650 still holds: un-linking / deleting an asset whose expense is in the lock → refused.
--   6. Another company with no lock links freely (the rule is per tenant).
--   7. MUTATION CHECK: with the trigger dropped, the locked-month link goes through and June's
--      P&L loses the expense — so check 1 is what this migration adds.

begin;

insert into public.tenants (id, name, email, state_code, doc_code, books_locked_until) values
  ('c1809000-0000-0000-0000-0000000000a1'::uuid, 'T-R1809 A', 'r1809-a@example.in', '07', 'TRA', '2026-06-30'),
  ('c1809000-0000-0000-0000-0000000000b1'::uuid, 'T-R1809 B', 'r1809-b@example.in', '07', 'TRB', null);

insert into auth.users (id, email) values
  ('c1809000-0000-0000-0000-00000000a0a1', 'r1809-owner-a@example.test'),
  ('c1809000-0000-0000-0000-00000000b0b1', 'r1809-owner-b@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1809000-0000-0000-0000-00000000a0a1', 'c1809000-0000-0000-0000-0000000000a1', 'r1809-owner-a@example.in', 'owner', 'Owner A'),
  ('c1809000-0000-0000-0000-00000000b0b1', 'c1809000-0000-0000-0000-0000000000b1', 'r1809-owner-b@example.in', 'owner', 'Owner B');

insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type) values
  ('r1809-exp-jun', 'c1809000-0000-0000-0000-0000000000a1', 'Equipment', 'T-Laptop shop', '2026-06-15', 85000, 0, 'none'),
  ('r1809-exp-jul', 'c1809000-0000-0000-0000-0000000000a1', 'Equipment', 'T-Laptop shop', '2026-07-10', 61000, 0, 'none'),
  ('r1809-exp-old', 'c1809000-0000-0000-0000-0000000000a1', 'Equipment', 'T-Chair shop', '2026-05-20', 9000, 0, 'none'),
  ('r1809-exp-b',   'c1809000-0000-0000-0000-0000000000b1', 'Equipment', 'T-shop', '2026-06-15', 5000, 0, 'none');

-- R-1650 fixture: an asset already linked to a locked-month expense (made before the lock — direct DB).
insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use, expense_id) values
  ('c1809000-0000-0000-0000-0000000f0009', 'c1809000-0000-0000-0000-0000000000a1', 'Chair Old', 'furniture', 9000, '2026-07-02', 'r1809-exp-old');

set local role authenticated;

do $$
declare
  v_ok boolean;
  v_msg text;
  v_n int;
  v_amt bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1809000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);

  -- 1. add an asset linked to the June (locked) expense → refused, §24 message
  v_ok := false;
  begin
    insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use, expense_id) values
      ('c1809000-0000-0000-0000-0000000f0001', 'c1809000-0000-0000-0000-0000000000a1', 'Laptop A', 'computers', 85000, '2026-07-05', 'r1809-exp-jun');
  exception when check_violation then
    v_msg := sqlerrm;
    v_ok := v_msg = 'That expense is in a locked month (June 2026). Unlock the month first, or add the asset without linking the expense.';
  end;
  if not v_ok then raise exception 'FAIL 1a: linking a locked-month expense to a new asset was not refused with the R-1809 message (got: %)', coalesce(v_msg, 'no error'); end if;
  select coalesce(sum((g->>'amount')::bigint), 0) into v_amt
    from public.report_pnl('2026-06-01', '2026-06-30') r, jsonb_array_elements(r.expense_groups) g;
  if v_amt <> 85000 then raise exception 'FAIL 1b: June expenses % — the closed month changed (expected 85000)', v_amt; end if;

  -- 2. the same asset without the link → added
  insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use) values
    ('c1809000-0000-0000-0000-0000000f0001', 'c1809000-0000-0000-0000-0000000000a1', 'Laptop A', 'computers', 85000, '2026-07-05');
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 2: asset without a link was not added'; end if;

  -- 3. link it afterwards → refused
  v_ok := false;
  begin
    update public.fixed_assets set expense_id = 'r1809-exp-jun' where id = 'c1809000-0000-0000-0000-0000000f0001';
  exception when check_violation then v_ok := sqlerrm like 'That expense is in a locked month (June 2026)%';
  end;
  if not v_ok then raise exception 'FAIL 3: linking a locked-month expense by update was not refused'; end if;

  -- 4. link an open-month (July) expense → allowed; July P&L leaves it out
  update public.fixed_assets set expense_id = 'r1809-exp-jul' where id = 'c1809000-0000-0000-0000-0000000f0001';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 4a: open-month link refused'; end if;
  select coalesce(sum((g->>'amount')::bigint), 0) into v_amt
    from public.report_pnl('2026-07-01', '2026-07-31') r, jsonb_array_elements(r.expense_groups) g;
  if v_amt <> 0 then raise exception 'FAIL 4b: July expenses % — the capitalised July expense is still a cost', v_amt; end if;

  -- 5. R-1650 unchanged: un-link / delete the asset on a locked-month expense → refused
  v_ok := false;
  begin
    update public.fixed_assets set expense_id = null where id = 'c1809000-0000-0000-0000-0000000f0009';
  exception when check_violation then v_ok := sqlerrm like '%lock%' and sqlerrm like '%Chair Old%';
  end;
  if not v_ok then raise exception 'FAIL 5a: R-1650 un-link check lost'; end if;
  v_ok := false;
  begin
    delete from public.fixed_assets where id = 'c1809000-0000-0000-0000-0000000f0009';
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL 5b: R-1650 delete check lost'; end if;

  -- 6. company B (no lock) links a June expense freely
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1809000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use, expense_id) values
    ('c1809000-0000-0000-0000-0000000f0002', 'c1809000-0000-0000-0000-0000000000b1', 'Desk B', 'furniture', 5000, '2026-06-20', 'r1809-exp-b');
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 6: unlocked company could not link'; end if;
end $$;

reset role;

do $$
declare v_n int; v_amt bigint;
begin
  -- 7. MUTATION CHECK — without the trigger the locked-month link goes through and June changes.
  alter table public.fixed_assets disable trigger trg_fixed_asset_expense_lock;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1809000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.fixed_assets (id, tenant_id, name, block, cost, put_to_use, expense_id) values
    ('c1809000-0000-0000-0000-0000000f0003', 'c1809000-0000-0000-0000-0000000000a1', 'Laptop M', 'computers', 85000, '2026-07-05', 'r1809-exp-jun');
  get diagnostics v_n = row_count;
  select coalesce(sum((g->>'amount')::bigint), 0) into v_amt
    from public.report_pnl('2026-06-01', '2026-06-30') r, jsonb_array_elements(r.expense_groups) g;
  execute 'reset role';
  if v_n <> 1 or v_amt <> 0 then raise exception 'FAIL 7: mutation check — without the trigger the link should go through and June lose the expense (rows %, June %)', v_n, v_amt; end if;
  raise notice 'mutation check: without trg_fixed_asset_expense_lock the locked-month link succeeds and June''s P&L drops ₹85,000';
end $$;

rollback;
