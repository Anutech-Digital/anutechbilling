\set ON_ERROR_STOP on
-- R-2472 (P1 security, money): a bank line can be matched only to a receipt / expense / project
-- receipt / salary / other bank line of the SAME company. reconcile_bank_txn is SECURITY DEFINER and
-- (since R-718) checked only that the bank line was the caller's — never the target id. Company A's
-- login could link its line to company B's payment, mark B's expense reconciled, point B's project
-- receipt at A's line, or (through the salary trigger) mark B's salary paid.
-- Migration: 20261104090200_r2472_bank_target_tenant_gate.sql
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2472_bank_target_tenant_gate.test.sql
--
-- Expect "PASS r2472_bank_target_tenant_gate". Every check is collected and failures listed together.
--
--   CROSS   Company A's billing login, A's bank lines, B's ids: payment / expense / project /
--           salary / transfer (B's bank line) → refused (42501), and B's rows are untouched.
--   UNKNOWN a match type the RPC does not know, with an id → refused for a signed-in caller.
--   OWN     A's own payment and expense still match; un-reconcile (null) still works.
--   TRIGGER a plain UPDATE of A's own line (RLS allows it) to B's salary / payment → refused by
--           trg_bank_match_target_company; to A's own payment → goes through. B's salary stays unpaid.
--   FLOWS   vendor_payment / statutory through the generic RPC → refused (their own flow books
--           them); 'manual' with a linked id → refused.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2472000-0000-4000-8000-0000000000a2', 'r2472-billing@example.test'),
  ('e2472000-0000-4000-8000-0000000000a3', 'r2472-accountant@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2472000-0000-0000-0000-0000000000a0', 'R2472 Co A', 'r2472a@example.in', '07', 'R247'),
  ('e2472000-0000-0000-0000-0000000000b0', 'R2472 Co B', 'r2472b@example.in', '07', 'R24B');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2472000-0000-4000-8000-0000000000a2', 'e2472000-0000-0000-0000-0000000000a0', 'r2472-billing@example.in', 'R2472 Billing', 'billing', true),
  ('e2472000-0000-4000-8000-0000000000a3', 'e2472000-0000-0000-0000-0000000000a0', 'r2472-accountant@example.in', 'R2472 Accountant', 'accountant', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2472000-0000-4000-8000-0000000000ca', 'e2472000-0000-0000-0000-0000000000a0', 'R2472 A Customer', '07', 'India'),
  ('e2472000-0000-4000-8000-0000000000cb', 'e2472000-0000-0000-0000-0000000000b0', 'R2472 B Customer', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e2472000-0000-4000-8000-0000000000ba', 'e2472000-0000-0000-0000-0000000000a0', 'R2472 A Current', 'R2472 Bank'),
  ('e2472000-0000-4000-8000-0000000000bb', 'e2472000-0000-0000-0000-0000000000b0', 'R2472 B Current', 'R2472 Bank');

-- A's lines: e1 credit 5,000 · e2 debit 900 · e3 credit 7,000 · e4 debit 20,000. B's line: f9.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit) values
  ('e2472000-0000-4000-8000-0000000000e1', 'e2472000-0000-0000-0000-0000000000a0', 'e2472000-0000-4000-8000-0000000000ba', '2026-10-10', 'NEFT CR R2472 A', 'UTR2472A', 5000, 0),
  ('e2472000-0000-4000-8000-0000000000e2', 'e2472000-0000-0000-0000-0000000000a0', 'e2472000-0000-4000-8000-0000000000ba', '2026-10-10', 'UPI R2472 A RENT', null, 0, 900),
  ('e2472000-0000-4000-8000-0000000000e3', 'e2472000-0000-0000-0000-0000000000a0', 'e2472000-0000-4000-8000-0000000000ba', '2026-10-10', 'NEFT CR R2472 A PROJECT', null, 7000, 0),
  ('e2472000-0000-4000-8000-0000000000e4', 'e2472000-0000-0000-0000-0000000000a0', 'e2472000-0000-4000-8000-0000000000ba', '2026-10-31', 'NEFT R2472 A SALARY', null, 0, 20000),
  ('e2472000-0000-4000-8000-0000000000f9', 'e2472000-0000-0000-0000-0000000000b0', 'e2472000-0000-4000-8000-0000000000bb', '2026-10-10', 'NEFT CR R2472 B', 'UTR2472B', 5000, 0);

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R2472-A', 'e2472000-0000-0000-0000-0000000000a0', null, 'e2472000-0000-4000-8000-0000000000ca', 'R2472 A Customer', 5000, 4237, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R2472-B', 'e2472000-0000-0000-0000-0000000000b0', null, 'e2472000-0000-4000-8000-0000000000cb', 'R2472 B Customer', 5000, 4237, 18, 'accepted', 'awaiting', '[]'::jsonb);
insert into public.payments (id, tenant_id, customer_id, amount, method, reference, status, received_at, quote_id) values
  ('e2472000-0000-4000-8000-0000000000fa', 'e2472000-0000-0000-0000-0000000000a0', 'e2472000-0000-4000-8000-0000000000ca', 5000, 'bank_transfer', 'UTR2472A', 'received', '2026-10-10 10:00+05:30', 'Q-R2472-A'),
  ('e2472000-0000-4000-8000-0000000000fb', 'e2472000-0000-0000-0000-0000000000b0', 'e2472000-0000-4000-8000-0000000000cb', 5000, 'bank_transfer', 'UTR2472B', 'received', '2026-10-10 10:00+05:30', 'Q-R2472-B');
insert into public.expenses (id, tenant_id, category, vendor_name, amount, expense_date) values
  ('EXP-R2472-A', 'e2472000-0000-0000-0000-0000000000a0', 'Rent', 'R2472 A Landlord', 900, '2026-10-10'),
  ('EXP-R2472-B', 'e2472000-0000-0000-0000-0000000000b0', 'Rent', 'R2472 B Landlord', 900, '2026-10-10');
insert into public.project_sales (id, tenant_id, title, customer_name, taxable_amount, gst_amount, total_amount) values
  ('e2472000-0000-4000-8000-0000000000d0', 'e2472000-0000-0000-0000-0000000000b0', 'R2472 B Project', 'R2472 B Customer', 5932, 1068, 7000);
insert into public.project_payments (id, tenant_id, project_id, amount, received_at) values
  ('e2472000-0000-4000-8000-0000000000d1', 'e2472000-0000-0000-0000-0000000000b0', 'e2472000-0000-4000-8000-0000000000d0', 7000, '2026-10-10');
insert into public.employees (id, tenant_id, name) values
  ('e2472000-0000-4000-8000-0000000000d5', 'e2472000-0000-0000-0000-0000000000b0', 'R2472 B Employee');
insert into public.salary_payments (id, tenant_id, employee_id, period, gross, net, pay_date, paid_status, paid_amount) values
  ('e2472000-0000-4000-8000-0000000000d6', 'e2472000-0000-0000-0000-0000000000b0', 'e2472000-0000-4000-8000-0000000000d5', '2026-10', 20000, 20000, '2026-10-31', 'unpaid', 0);

create temp table r2472_fail (msg text) on commit drop;
grant all on r2472_fail to authenticated;

do $$
declare
  v_code text;
  v_case record;
  v_n    integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2472000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  -- ════ CROSS + UNKNOWN ═════════════════════════════════════════════════════════════
  for v_case in
    select * from (values
      ('e2472000-0000-4000-8000-0000000000e1'::uuid, 'payment',  'e2472000-0000-4000-8000-0000000000fb', 'company B''s payment'),
      ('e2472000-0000-4000-8000-0000000000e2'::uuid, 'expense',  'EXP-R2472-B',                          'company B''s expense'),
      ('e2472000-0000-4000-8000-0000000000e3'::uuid, 'project',  'e2472000-0000-4000-8000-0000000000d1', 'company B''s project receipt'),
      ('e2472000-0000-4000-8000-0000000000e4'::uuid, 'salary',   'e2472000-0000-4000-8000-0000000000d6', 'company B''s salary'),
      ('e2472000-0000-4000-8000-0000000000e1'::uuid, 'transfer', 'e2472000-0000-4000-8000-0000000000f9', 'company B''s bank line'),
      ('e2472000-0000-4000-8000-0000000000e1'::uuid, 'no_such_type', 'e2472000-0000-4000-8000-0000000000fa', 'an unknown match type')
    ) v(txn, typ, target, what)
  loop
    v_code := null;
    begin
      perform public.reconcile_bank_txn(v_case.txn, v_case.typ, v_case.target, 'manual');
    exception when insufficient_privilege then v_code := 'refused';
              when others then v_code := 'other: ' || sqlstate || ' ' || sqlerrm;
    end;
    if v_code is null then
      insert into r2472_fail values ('A''s login matched its line to ' || v_case.what || ' (' || v_case.typ || ')');
    elsif v_code <> 'refused' then
      insert into r2472_fail values ('matching A''s line to ' || v_case.what || ' failed, but not as a refusal (42501): ' || v_code);
    end if;
  end loop;

  -- ════ OWN ═════════════════════════════════════════════════════════════════════════
  begin
    perform public.reconcile_bank_txn('e2472000-0000-4000-8000-0000000000e1', 'payment', 'e2472000-0000-4000-8000-0000000000fa', 'manual');
  exception when others then
    insert into r2472_fail values ('matching A''s line to A''s own payment failed: ' || sqlerrm);
  end;
  begin
    perform public.reconcile_bank_txn('e2472000-0000-4000-8000-0000000000e2', 'expense', 'EXP-R2472-A', 'manual');
  exception when others then
    insert into r2472_fail values ('matching A''s debit line to A''s own expense failed: ' || sqlerrm);
  end;
  begin
    perform public.reconcile_bank_txn('e2472000-0000-4000-8000-0000000000e2', null, null, 'manual');
  exception when others then
    insert into r2472_fail values ('un-reconciling A''s debit line failed: ' || sqlerrm);
  end;

  -- ════ TRIGGER ═════════════════════════════════════════════════════════════════════
  -- A plain UPDATE of A's own line (RLS allows it) pointing at B's salary / payment → refused (42501).
  -- The row count proves RLS let the UPDATE reach the line, so the refusal is the new trigger's.
  -- RLS lets owner / manager / accountant update a line (not billing) — so A's accountant here.
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2472000-0000-4000-8000-0000000000a3', 'role', 'authenticated')::text, true);
  for v_case in
    select * from (values
      ('salary',  'e2472000-0000-4000-8000-0000000000d6', 'company B''s salary'),
      ('payment', 'e2472000-0000-4000-8000-0000000000fb', 'company B''s payment')
    ) v(typ, target, what)
  loop
    v_code := null;
    begin
      update public.bank_transactions
         set matched_to_type = v_case.typ, matched_to_id = v_case.target, match_confidence = 'manual'
       where id = 'e2472000-0000-4000-8000-0000000000e4';
      get diagnostics v_n = row_count;
      v_code := 'ran (' || v_n || ' row)';
    exception when insufficient_privilege then v_code := 'refused';
              when others then v_code := 'other: ' || sqlstate || ' ' || sqlerrm;
    end;
    if v_code <> 'refused' then
      insert into r2472_fail values ('plain UPDATE of A''s line to ' || v_case.what || ': ' || v_code || ' (want refused 42501)');
    end if;
  end loop;
  -- the same UPDATE to A's own payment goes through (RLS reaches the line; the trigger lets it pass)
  begin
    update public.bank_transactions
       set matched_to_type = 'payment', matched_to_id = 'e2472000-0000-4000-8000-0000000000fa', match_confidence = 'manual'
     where id = 'e2472000-0000-4000-8000-0000000000e3';
    get diagnostics v_n = row_count;
    if v_n <> 1 then insert into r2472_fail values ('plain UPDATE of A''s own line to A''s payment touched ' || v_n || ' rows (want 1)'); end if;
    update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = 'e2472000-0000-4000-8000-0000000000e3';
  exception when others then
    insert into r2472_fail values ('plain UPDATE of A''s own line to A''s own payment failed: ' || sqlerrm);
  end;

  -- ════ OWN FLOWS ONLY ══════════════════════════════════════════════════════════════
  -- types only their own booking flow sets (it writes the books) are refused through this RPC;
  -- manual / split take no linked record. (Back to A's billing login.)
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2472000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  for v_case in
    select * from (values
      ('vendor_payment', 'e2472000-0000-4000-8000-0000000000ca'::text),
      ('statutory', null::text),
      ('manual', 'e2472000-0000-4000-8000-0000000000fa'::text)
    ) v(typ, target)
  loop
    v_code := null;
    begin
      perform public.reconcile_bank_txn('e2472000-0000-4000-8000-0000000000e4', v_case.typ, v_case.target, 'manual');
    exception when insufficient_privilege or invalid_parameter_value then v_code := 'refused';
              when others then v_code := 'other: ' || sqlstate || ' ' || sqlerrm;
    end;
    if v_code is distinct from 'refused' then
      insert into r2472_fail values ('reconcile_bank_txn(' || v_case.typ || ') through the generic RPC: ' || coalesce(v_code, 'ran') || ' (want refused)');
    end if;
  end loop;
  set local role postgres;

  if exists (select 1 from public.bank_transactions where id = 'e2472000-0000-4000-8000-0000000000e4' and matched_to_type is not null) then
    insert into r2472_fail values ('A''s salary line e4 ended up matched after only refused attempts');
  end if;

  if (select paid_status from public.salary_payments where id = 'e2472000-0000-4000-8000-0000000000d6') <> 'unpaid'
     or (select paid_amount from public.salary_payments where id = 'e2472000-0000-4000-8000-0000000000d6') <> 0 then
    insert into r2472_fail values ('company B''s salary was marked paid from company A''s bank line');
  end if;
  if (select reconciled_txn_id from public.expenses where id = 'EXP-R2472-B') is not null then
    insert into r2472_fail values ('company B''s expense was marked reconciled to company A''s line');
  end if;
  if (select bank_txn_id from public.project_payments where id = 'e2472000-0000-4000-8000-0000000000d1') is not null then
    insert into r2472_fail values ('company B''s project receipt now points at company A''s line');
  end if;
  if (select bank_txn_id from public.payments where id = 'e2472000-0000-4000-8000-0000000000fb') is not null then
    insert into r2472_fail values ('company B''s payment now points at company A''s line');
  end if;
  if not exists (select 1 from public.bank_transactions where id = 'e2472000-0000-4000-8000-0000000000e1'
                  and matched_to_type = 'payment' and matched_to_id = 'e2472000-0000-4000-8000-0000000000fa') then
    insert into r2472_fail values ('A''s credit line is not matched to A''s own payment after the allowed match');
  end if;
  if exists (select 1 from public.bank_transactions where id = 'e2472000-0000-4000-8000-0000000000e2' and matched_to_type is not null)
     or (select reconciled_txn_id from public.expenses where id = 'EXP-R2472-A') is not null then
    insert into r2472_fail values ('A''s debit line / expense still linked after un-reconcile');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2472_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2472_bank_target_tenant_gate:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2472_bank_target_tenant_gate';
end $$;

rollback;
