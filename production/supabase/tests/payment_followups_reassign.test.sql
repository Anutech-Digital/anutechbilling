-- Regression test for 20261017153945_r1528_followup_reassign_guard.sql (R-1528)
--
-- WHAT IT PROVES (self-asserting; whole file rolls back)
--   1. Sales cannot give a NEW follow-up to someone else (direct table write, 42501).
--   2. Sales may save it to the current default (customer owner), to themselves, or unassigned.
--   3. After the owner hands it to sales #2, sales may keep THAT default — and still not pick
--      anyone else (the default follows the latest follow-up, like the app).
--   4. Sales cannot change assigned_to on UPDATE (other fields still change).
--   5. Billing cannot reassign — insert or update (R-1515's update policy let it).
--   6. Owner, manager and accountant may give it to anyone in the company, insert and update.
--   7. A login with NO company is refused by THIS trigger (42501 + its own message), not only by RLS.
--   8. A row stamped with another company is refused by THIS trigger (42501).
--
-- Run it in one rollback with the migrations (CLAUDE.md §17c):
--   begin; <R-1515 + R-1528 migrations without begin/commit> <this file without begin/rollback> rollback;

begin;

insert into auth.users (id, email) values
  ('f1528000-0000-0000-0000-0000000000a1', 'rg-owner@example.test'),
  ('f1528000-0000-0000-0000-0000000000a2', 'rg-manager@example.test'),
  ('f1528000-0000-0000-0000-0000000000a3', 'rg-accountant@example.test'),
  ('f1528000-0000-0000-0000-0000000000a4', 'rg-billing@example.test'),
  ('f1528000-0000-0000-0000-0000000000a5', 'rg-sales@example.test'),
  ('f1528000-0000-0000-0000-0000000000a6', 'rg-sales2@example.test'),
  ('f1528000-0000-0000-0000-0000000000b1', 'rg-owner-b@example.test'),
  ('f1528000-0000-0000-0000-0000000000c1', 'rg-nobody@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('f1528000-0000-0000-0000-00000000aaaa', 'RG A', 'rg-a@example.test', '07', 'RGA1'),
  ('f1528000-0000-0000-0000-00000000bbbb', 'RG B', 'rg-b@example.test', '07', 'RGB1');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('f1528000-0000-0000-0000-0000000000a1', 'f1528000-0000-0000-0000-00000000aaaa', 'rg-owner@example.test',      'RG Owner',      'owner',      true),
  ('f1528000-0000-0000-0000-0000000000a2', 'f1528000-0000-0000-0000-00000000aaaa', 'rg-manager@example.test',    'RG Manager',    'manager',    true),
  ('f1528000-0000-0000-0000-0000000000a3', 'f1528000-0000-0000-0000-00000000aaaa', 'rg-accountant@example.test', 'RG Accountant', 'accountant', true),
  ('f1528000-0000-0000-0000-0000000000a4', 'f1528000-0000-0000-0000-00000000aaaa', 'rg-billing@example.test',    'RG Billing',    'billing',    true),
  ('f1528000-0000-0000-0000-0000000000a5', 'f1528000-0000-0000-0000-00000000aaaa', 'rg-sales@example.test',      'RG Sales',      'sales',      true),
  ('f1528000-0000-0000-0000-0000000000a6', 'f1528000-0000-0000-0000-00000000aaaa', 'rg-sales2@example.test',     'RG Sales 2',    'sales',      true),
  ('f1528000-0000-0000-0000-0000000000b1', 'f1528000-0000-0000-0000-00000000bbbb', 'rg-owner-b@example.test',    'RG Owner B',    'owner',      true);
-- rg-nobody has an auth login but NO users row → current_tenant_id() is NULL.

-- The manager sees the customers of the people who report to them (sales hierarchy RLS).
update public.users set manager_id = 'f1528000-0000-0000-0000-0000000000a2'
 where id in ('f1528000-0000-0000-0000-0000000000a5', 'f1528000-0000-0000-0000-0000000000a6');

-- The customer belongs to sales #1 (account_manager_id) — that is the default assignee.
insert into public.customers (id, tenant_id, name, account_manager_id) values
  ('f1528000-0000-0000-0000-0000000000ca', 'f1528000-0000-0000-0000-00000000aaaa', 'RG Customer A', 'f1528000-0000-0000-0000-0000000000a5');

set local role authenticated;

do $$
declare
  v_a       uuid := 'f1528000-0000-0000-0000-00000000aaaa';
  v_b       uuid := 'f1528000-0000-0000-0000-00000000bbbb';
  v_owner   uuid := 'f1528000-0000-0000-0000-0000000000a1';
  v_manager uuid := 'f1528000-0000-0000-0000-0000000000a2';
  v_acct    uuid := 'f1528000-0000-0000-0000-0000000000a3';
  v_billing uuid := 'f1528000-0000-0000-0000-0000000000a4';
  v_sales   uuid := 'f1528000-0000-0000-0000-0000000000a5';
  v_sales2  uuid := 'f1528000-0000-0000-0000-0000000000a6';
  v_nobody  uuid := 'f1528000-0000-0000-0000-0000000000c1';
  v_cust    uuid := 'f1528000-0000-0000-0000-0000000000ca';
  v_row     uuid;
  v_state   text;
  v_msg     text;
  v_n       int;
begin
  -- ── 1. sales → someone else on a new follow-up: refused ──────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  v_state := null; v_msg := null;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
    values (v_a, v_cust, 'call', 'sales gives it away', v_sales2);
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '42501' or v_msg not like 'Sirf owner, manager ya accountant%' then
    raise exception 'FAIL 1: sales gave a new follow-up to someone else (state %, msg %)', coalesce(v_state, 'none'), coalesce(v_msg, 'none');
  end if;

  -- ── 2. sales: default (customer owner = self), self, NULL — allowed ──────
  insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
  values (v_a, v_cust, 'call', 'sales keeps default', v_sales) returning id into v_row;
  insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
  values (v_a, v_cust, 'note', 'sales unassigned', null);

  -- ── 4. sales cannot change assigned_to on its own row; other fields ok ────
  update public.payment_followups set note = 'sales edits the note' where id = v_row;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'FAIL 4a: sales could not edit the note on its own follow-up (rows %)', v_n;
  end if;
  v_state := null; v_msg := null;
  begin
    update public.payment_followups set assigned_to = v_sales2 where id = v_row;
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '42501' or v_msg not like 'Sirf owner, manager ya accountant%' then
    raise exception 'FAIL 4b: sales changed assigned_to on update (state %, msg %)', coalesce(v_state, 'none'), coalesce(v_msg, 'none');
  end if;

  -- ── 6a. owner hands it to sales #2 (insert) — allowed ────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  -- created_at one minute later, so this hand-over is the LATEST follow-up (now() is per
  -- transaction, so every other row in this test shares one created_at). R-1559: a login can
  -- no longer write created_at, so the test moves it as the fixture owner (postgres).
  insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
  values (v_a, v_cust, 'call', 'owner hands to sales 2', v_sales2);
  reset role;
  update public.payment_followups set created_at = now() + interval '1 minute'
   where tenant_id = v_a and note = 'owner hands to sales 2';
  set local role authenticated;
  -- 6b. owner reassigns an existing row on update — allowed
  update public.payment_followups set assigned_to = v_manager where id = v_row;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'FAIL 6b: owner could not reassign on update (rows %)', v_n;
  end if;

  -- ── 3. sales may now keep the NEW default (sales #2), but not pick the owner ─
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
  values (v_a, v_cust, 'call', 'sales keeps latest default', v_sales2);
  v_state := null; v_msg := null;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
    values (v_a, v_cust, 'call', 'sales picks owner', v_owner);
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '42501' then
    raise exception 'FAIL 3: sales gave a follow-up to a non-default person (state %)', coalesce(v_state, 'none');
  end if;

  -- ── 5. billing cannot reassign: insert to someone else, or update ───────
  perform set_config('request.jwt.claims', json_build_object('sub', v_billing, 'role', 'authenticated')::text, true);
  v_state := null; v_msg := null;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
    values (v_a, v_cust, 'call', 'billing gives it to owner', v_owner);
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '42501' or v_msg not like 'Sirf owner, manager ya accountant%' then
    raise exception 'FAIL 5a: billing gave a new follow-up to someone else (state %, msg %)', coalesce(v_state, 'none'), coalesce(v_msg, 'none');
  end if;
  v_state := null; v_msg := null;
  begin
    update public.payment_followups set assigned_to = v_billing
     where customer_id = v_cust and note = 'owner hands to sales 2';
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '42501' then
    raise exception 'FAIL 5b: billing reassigned a follow-up on update (state %)', coalesce(v_state, 'none');
  end if;

  -- ── 6c/6d. manager and accountant may give it to anyone ─────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_manager, 'role', 'authenticated')::text, true);
  insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
  values (v_a, v_cust, 'call', 'manager hands to billing', v_billing);
  update public.payment_followups set assigned_to = v_owner where note = 'owner hands to sales 2';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'FAIL 6c: manager could not reassign on update (rows %)', v_n;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_acct, 'role', 'authenticated')::text, true);
  insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
  values (v_a, v_cust, 'call', 'accountant hands to sales 2', v_sales2);
  update public.payment_followups set assigned_to = v_sales where note = 'manager hands to billing';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'FAIL 6d: accountant could not reassign on update (rows %)', v_n;
  end if;

  -- ── 8. a row stamped with another company: refused by this trigger ──────
  v_state := null; v_msg := null;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note)
    values (v_b, v_cust, 'note', 'planted in B');
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '42501' or v_msg not like 'Ye follow-up aapki company ka nahi hai%' then
    raise exception 'FAIL 8: a follow-up for another company was not refused by the reassign guard (state %, msg %)', coalesce(v_state, 'none'), coalesce(v_msg, 'none');
  end if;

  -- ── 7. NULL tenant: refused by this trigger (fail closed) ───────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is not null then
    raise exception 'SETUP 7: the no-company login has a tenant — test 7 would prove nothing';
  end if;
  v_state := null; v_msg := null;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
    values (v_a, v_cust, 'note', 'from nowhere', v_nobody);
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '42501' or v_msg not like 'Aapka login kisi company se juda nahi hai%' then
    raise exception 'FAIL 7: a login with no company was not refused by the reassign guard (state %, msg %)', coalesce(v_state, 'none'), coalesce(v_msg, 'none');
  end if;

  raise notice 'PASS: payment_followups reassign guard — sales/billing cannot reassign (insert or update), sales keeps default/self/NULL, owner/manager/accountant reassign, NULL tenant + other company refused';
end $$;

rollback;
