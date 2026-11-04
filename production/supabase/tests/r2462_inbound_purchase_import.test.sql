-- R-2462 (4 Nov 2026) — Purchase Inbox "Add to expenses" books one order email ONCE.
-- Migration: 20261104034650_r2462_inbound_purchase_import.sql adds import_inbound_purchase(bigint)
-- and set_inbound_purchase_status(bigint, text), tightens the UPDATE policy on inbound_purchases to
-- owner / manager / accountant, and adds a guard trigger. FAILS without it (the functions do not
-- exist; a sales user can still mark a row imported straight through the table).
--
--   1. owner imports a pending row → one expense (ex-GST amount, GST, order date, bill no) and the
--      row is 'imported' with that expense_id
--   2. a second import of the same row (owner again, then the accountant) → no new expense; it
--      answers already = true with the SAME expense id
--   3. who: accountant and manager import; sales refused (no expense, row still pending); another
--      company refused (not found); a personal workspace refused
--   4. Ignore / Restore through set_inbound_purchase_status; an imported row cannot be ignored; an
--      ignored row cannot be imported until restored; a non-amazon row is described as online
--   5. the expense of an imported email is deleted → the email can be booked again (not stuck)
--   6. a non-INR order is refused with the next step (no foreign amount booked as rupees)
--   7. direct UPDATE: sales changes nothing; even the owner cannot move an imported row off its
--      expense or mark a row imported without one (old page code during the deploy)
--   8. grants: no anon execute; SECURITY DEFINER with search_path=public; expenses per company
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2462_inbound_purchase_import.test.sql

begin;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
-- T company (owner, accountant, sales, manager), O another company (owner), P a personal workspace.
insert into auth.users (id, email) values
  ('24620000-0000-4000-8000-0000000000a1', 'r2462-owner-t@example.test'),
  ('24620000-0000-4000-8000-0000000000a2', 'r2462-acct-t@example.test'),
  ('24620000-0000-4000-8000-0000000000a3', 'r2462-sales-t@example.test'),
  ('24620000-0000-4000-8000-0000000000a4', 'r2462-mgr-t@example.test'),
  ('24620000-0000-4000-8000-0000000000c1', 'r2462-owner-o@example.test'),
  ('24620000-0000-4000-8000-0000000000d1', 'r2462-owner-p@example.test');

insert into public.tenants (id, name, email, state_code, doc_code, workspace_kind) values
  ('24620000-0000-4000-8000-00000000000a', 'R2462 Company',  'r2462t@example.test', '07', 'R246T', 'business'),
  ('24620000-0000-4000-8000-00000000000c', 'R2462 Other',    'r2462o@example.test', '27', 'R246O', 'business'),
  ('24620000-0000-4000-8000-00000000000d', 'R2462 Personal', 'r2462p@example.test', '07', 'R246P', 'personal');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('24620000-0000-4000-8000-0000000000a1', '24620000-0000-4000-8000-00000000000a', 'r2462-owner-t@example.test', 'R2462 Owner T',      'owner',      true),
  ('24620000-0000-4000-8000-0000000000a2', '24620000-0000-4000-8000-00000000000a', 'r2462-acct-t@example.test',  'R2462 Accountant T', 'accountant', true),
  ('24620000-0000-4000-8000-0000000000a3', '24620000-0000-4000-8000-00000000000a', 'r2462-sales-t@example.test', 'R2462 Sales T',      'sales',      true),
  ('24620000-0000-4000-8000-0000000000a4', '24620000-0000-4000-8000-00000000000a', 'r2462-mgr-t@example.test',   'R2462 Manager T',    'manager',    true),
  ('24620000-0000-4000-8000-0000000000c1', '24620000-0000-4000-8000-00000000000c', 'r2462-owner-o@example.test', 'R2462 Owner O',      'owner',      true),
  ('24620000-0000-4000-8000-0000000000d1', '24620000-0000-4000-8000-00000000000d', 'r2462-owner-p@example.test', 'R2462 Owner P',      'owner',      true);

-- T: A (owner imports twice), B (accountant / sales / other company), C (ignore / restore, not amazon),
--    D (manager), E (USD), F (direct-update checks). P: G (personal workspace).
insert into public.inbound_purchases (tenant_id, source, message_id, order_id, subject, order_date, currency, total, gst, items, status) values
  ('24620000-0000-4000-8000-00000000000a', 'amazon', 'r2462-msg-a', '404-2462-A', 'Your Amazon order A', date '2026-11-02', 'INR', 1180, 180,
   '[{"name": "Keyboard", "qty": 1, "amount": 1180}]'::jsonb, 'pending'),
  ('24620000-0000-4000-8000-00000000000a', 'amazon', 'r2462-msg-b', '404-2462-B', 'Your Amazon order B', date '2026-11-03', 'INR', 590, 90,
   '[{"name": "Mouse", "qty": 2, "amount": 590}]'::jsonb, 'pending'),
  ('24620000-0000-4000-8000-00000000000a', 'other',  'r2462-msg-c', null,         'Order C',             null,              'INR', 100, 0,
   '[]'::jsonb, 'pending'),
  ('24620000-0000-4000-8000-00000000000a', 'amazon', 'r2462-msg-d', '404-2462-D', 'Your Amazon order D', date '2026-11-03', 'INR', 100.50, 15.30,
   '[{"name": "Cable", "qty": 1, "amount": 100.50}]'::jsonb, 'pending'),
  ('24620000-0000-4000-8000-00000000000a', 'other',  'r2462-msg-e', 'US-1',       'Order E',             date '2026-11-03', 'usd', 50, 0,
   '[]'::jsonb, 'pending'),
  ('24620000-0000-4000-8000-00000000000a', 'amazon', 'r2462-msg-f', '404-2462-F', 'Your Amazon order F', date '2026-11-03', 'INR', 118, 18,
   '[]'::jsonb, 'pending'),
  ('24620000-0000-4000-8000-00000000000d', 'amazon', 'r2462-msg-g', '404-2462-G', 'Your Amazon order G', date '2026-11-03', 'INR', 118, 18,
   '[]'::jsonb, 'pending');

create temp table r2462_ids as
  select message_id, id from public.inbound_purchases where message_id like 'r2462-msg-%';
grant select on r2462_ids to authenticated;

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

set local role authenticated;
do $$
declare
  v_a bigint := (select id from r2462_ids where message_id = 'r2462-msg-a');
  v_b bigint := (select id from r2462_ids where message_id = 'r2462-msg-b');
  v_c bigint := (select id from r2462_ids where message_id = 'r2462-msg-c');
  v_d bigint := (select id from r2462_ids where message_id = 'r2462-msg-d');
  v_e bigint := (select id from r2462_ids where message_id = 'r2462-msg-e');
  v_f bigint := (select id from r2462_ids where message_id = 'r2462-msg-f');
  v_g bigint := (select id from r2462_ids where message_id = 'r2462-msg-g');
  r1 jsonb; r2 jsonb; e record; n int; v_msg text; v_status text;
begin
  -- ── 1. owner imports A ──
  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000a1');
  r1 := public.import_inbound_purchase(v_a);
  if (r1->>'already')::boolean is distinct from false or coalesce(r1->>'expense_id', '') = '' then
    raise exception 'FAIL 1a: first import answered %', r1;
  end if;
  select * into e from public.expenses where id = r1->>'expense_id';
  if not found then raise exception 'FAIL 1b: no expense % made', r1->>'expense_id'; end if;
  if e.tenant_id <> '24620000-0000-4000-8000-00000000000a' or e.amount <> 1000 or e.gst_paid <> 180
     or e.expense_date <> date '2026-11-02' or e.bill_no <> '404-2462-A' or e.vendor_name <> 'Amazon'
     or e.bill_type <> 'gst' or e.paid or e.category <> 'Office Supplies' or e.currency <> 'INR'
     or e.description <> 'Amazon order 404-2462-A — 1× Keyboard' then
    raise exception 'FAIL 1c: expense wrong: tenant % amount % gst % date % bill % vendor % type % paid % cat % desc %',
      e.tenant_id, e.amount, e.gst_paid, e.expense_date, e.bill_no, e.vendor_name, e.bill_type, e.paid, e.category, e.description;
  end if;
  select status into v_status from public.inbound_purchases where id = v_a;
  if v_status <> 'imported'
     or (select expense_id from public.inbound_purchases where id = v_a) is distinct from r1->>'expense_id' then
    raise exception 'FAIL 1d: row A is % (want imported + the expense id)', v_status;
  end if;

  -- ── 2. second import of A (owner again, then the accountant) → no second expense ──
  r2 := public.import_inbound_purchase(v_a);
  if (r2->>'already')::boolean is distinct from true or r2->>'expense_id' is distinct from r1->>'expense_id' then
    raise exception 'FAIL 2a: second import answered % (want already=true, same expense %)', r2, r1->>'expense_id';
  end if;
  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000a2');
  r2 := public.import_inbound_purchase(v_a);
  if (r2->>'already')::boolean is distinct from true then raise exception 'FAIL 2b: accountant re-import answered %', r2; end if;
  select count(*) into n from public.expenses where tenant_id = '24620000-0000-4000-8000-00000000000a';
  if n <> 1 then raise exception 'FAIL 2c: % expenses after two imports of one email (want 1)', n; end if;

  -- ── 3. who may import ──
  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000a3');     -- sales
  begin
    perform public.import_inbound_purchase(v_b);
    raise exception 'FAIL 3a: a sales user imported an order email';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'Only the owner, a manager or the accountant%' then raise exception 'FAIL 3b: sales refusal says %', v_msg; end if;
  end;
  begin
    perform public.set_inbound_purchase_status(v_b, 'ignored');
    raise exception 'FAIL 3c: a sales user ignored an order email';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000c1');     -- another company, T's row id
  begin
    perform public.import_inbound_purchase(v_b);
    raise exception 'FAIL 3d: another company imported T''s order email';
  exception when no_data_found then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'This order email was not found%' then raise exception 'FAIL 3e: other-company refusal says %', v_msg; end if;
  end;
  begin
    perform public.set_inbound_purchase_status(v_b, 'ignored');
    raise exception 'FAIL 3f: another company ignored T''s order email';
  exception when no_data_found then null;
  end;

  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000d1');     -- personal workspace, its own row
  begin
    perform public.import_inbound_purchase(v_g);
    raise exception 'FAIL 3k: a personal workspace booked an expense';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'Purchases are part of a business account%' then raise exception 'FAIL 3l: personal refusal says %', v_msg; end if;
  end;

  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000a2');     -- accountant
  r1 := public.import_inbound_purchase(v_b);
  if (r1->>'already')::boolean is distinct from false then raise exception 'FAIL 3g: accountant import answered %', r1; end if;
  select count(*) into n from public.expenses where tenant_id = '24620000-0000-4000-8000-00000000000a';
  if n <> 2 then raise exception 'FAIL 3h: % expenses after A + B (want 2)', n; end if;

  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000a4');     -- manager; paise rounded once
  r1 := public.import_inbound_purchase(v_d);
  select * into e from public.expenses where id = r1->>'expense_id';
  if e.amount <> 86 or e.gst_paid <> 15 then
    raise exception 'FAIL 3m: 100.50 incl 15.30 booked as % + % (want 86 + 15 = the rounded total 101)', e.amount, e.gst_paid;
  end if;

  -- ── 4. ignore / restore ──
  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000a2');
  begin
    perform public.set_inbound_purchase_status(v_a, 'ignored');
    raise exception 'FAIL 4a: an imported email was ignored';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'Already added to expenses%' then raise exception 'FAIL 4b: ignore-imported says %', v_msg; end if;
  end;
  perform public.set_inbound_purchase_status(v_c, 'ignored');
  perform public.set_inbound_purchase_status(v_c, 'ignored');           -- a second click is fine
  if (select status from public.inbound_purchases where id = v_c) <> 'ignored' then raise exception 'FAIL 4c: C not ignored'; end if;
  begin
    perform public.import_inbound_purchase(v_c);
    raise exception 'FAIL 4d: an ignored email was imported';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'This order email was ignored%' then raise exception 'FAIL 4e: import-ignored says %', v_msg; end if;
  end;
  begin
    perform public.set_inbound_purchase_status(v_c, 'imported');
    raise exception 'FAIL 4f: status set to imported without an expense';
  exception when invalid_parameter_value then null;
  end;
  perform public.set_inbound_purchase_status(v_c, 'pending');            -- restore
  r1 := public.import_inbound_purchase(v_c);
  select * into e from public.expenses where id = r1->>'expense_id';
  if e.vendor_name <> 'Online purchase' or e.bill_type <> 'none' or e.amount <> 100 or e.gst_paid <> 0
     or e.description <> 'Online purchase' or e.expense_date is null then
    raise exception 'FAIL 4g: restored C booked as % % % % % %', e.vendor_name, e.bill_type, e.amount, e.gst_paid, e.description, e.expense_date;
  end if;

  -- ── 6. USD order refused with the next step ──
  begin
    perform public.import_inbound_purchase(v_e);
    raise exception 'FAIL 6a: a USD order was booked';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'This order is in USD — add it from Expenses%' then raise exception 'FAIL 6b: USD refusal says %', v_msg; end if;
  end;
  if (select status from public.inbound_purchases where id = v_e) <> 'pending' then raise exception 'FAIL 6c: E left pending?'; end if;

  -- ── 7. direct UPDATE (old page code) ──
  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000a3');     -- sales
  update public.inbound_purchases set status = 'ignored' where id = v_f;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 7a: sales changed % rows directly', n; end if;
  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000a1');     -- owner
  begin
    update public.inbound_purchases set status = 'pending' where id = v_a;
    raise exception 'FAIL 7b: an imported row went back to pending directly';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'Already added to expenses%' then raise exception 'FAIL 7c: says %', v_msg; end if;
  end;
  begin
    update public.inbound_purchases set expense_id = (select expense_id from public.inbound_purchases where id = v_b) where id = v_a;
    raise exception 'FAIL 7d: an imported row was pointed at another expense';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'Already added to expenses%' then raise exception 'FAIL 7e: says %', v_msg; end if;
  end;
  begin
    update public.inbound_purchases set status = 'imported' where id = v_f;
    raise exception 'FAIL 7f: a row was marked imported with no expense';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'An order email is marked added to expenses only together%' then raise exception 'FAIL 7g: says %', v_msg; end if;
  end;
  update public.inbound_purchases set status = 'ignored' where id = v_f;  -- the owner's old-code Ignore still works
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 7h: owner direct ignore changed % rows', n; end if;
end $$;
reset role;

-- ── 5. the expense behind A is deleted (FK sets expense_id null) → A can be booked again ──
delete from public.expenses e using public.inbound_purchases ip
 where ip.message_id = 'r2462-msg-a' and e.id = ip.expense_id;
set local role authenticated;
do $$
declare
  v_a bigint := (select id from r2462_ids where message_id = 'r2462-msg-a');
  r1 jsonb;
begin
  perform pg_temp.as_user('24620000-0000-4000-8000-0000000000a1');
  if (select status from public.inbound_purchases where id = v_a) <> 'imported'
     or (select expense_id from public.inbound_purchases where id = v_a) is not null then
    raise exception 'FAIL 5a: after the expense delete A is not imported-without-expense';
  end if;
  r1 := public.import_inbound_purchase(v_a);
  if (r1->>'already')::boolean is distinct from false or not exists (select 1 from public.expenses where id = r1->>'expense_id') then
    raise exception 'FAIL 5b: A could not be booked again after its expense was deleted: %', r1;
  end if;
end $$;
reset role;

do $$
begin
  if (select count(*) from public.expenses where tenant_id = '24620000-0000-4000-8000-00000000000c') <> 0
     or (select count(*) from public.expenses where tenant_id = '24620000-0000-4000-8000-00000000000d') <> 0 then
    raise exception 'FAIL 8a: an expense landed in the other company or the personal workspace';
  end if;
  if (select count(*) from public.expenses where tenant_id = '24620000-0000-4000-8000-00000000000a') <> 4 then
    raise exception 'FAIL 8b: % expenses for T (want 4: A again, B, C, D)',
      (select count(*) from public.expenses where tenant_id = '24620000-0000-4000-8000-00000000000a');
  end if;
  if has_function_privilege('anon', 'public.import_inbound_purchase(bigint)', 'execute')
     or has_function_privilege('anon', 'public.set_inbound_purchase_status(bigint, text)', 'execute') then
    raise exception 'FAIL 8c: anon may execute an R-2462 function';
  end if;
  if (select count(*) from pg_proc where proname in ('import_inbound_purchase', 'set_inbound_purchase_status')
        and prosecdef and proconfig::text like '%search_path=public%') <> 2 then
    raise exception 'FAIL 8d: not SECURITY DEFINER with search_path=public';
  end if;
end $$;

rollback;
