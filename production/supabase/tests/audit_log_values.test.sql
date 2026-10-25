-- Regression test: audit log carries old/new values (migration 20260927150000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/audit_log_values.test.sql
--
-- What it proves (caller = the company's owner):
--   1. Changing an expense's amount logs { amount: { old, new } } — and only that field.
--   2. An update that changes nothing logs nothing.
--   3. Deleting a salary payment logs the whole old row, so it can be read back.
--   4. A tax challan (tax_payments) is logged too — a table that had no trail before.
--   5. Nothing is logged for a change made with no signed-in user (system / cron).

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'AUDIT A', 'au-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000e1a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'au-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000e1a1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'au-owner@example.in', 'owner');
insert into public.employees (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e1e1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'Audit Person');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-00000000ae1b', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'HDFC', 'HDFC', 0, '2026-04-01');
-- rows written by the system: no JWT → no log lines (5)
insert into public.expenses (id, tenant_id, category, amount, expense_date) values
  ('EXP-AUDIT-1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'Office Rent', 10000, '2026-09-10');
insert into public.salary_payments (id, tenant_id, employee_id, period, gross, net, pay_date, paid_status) values
  ('aaaaaaaa-0000-0000-0000-00000000e1c1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-00000000e1e1', '2026-08', 30000, 25000, '2026-09-01', 'paid');

do $$ declare n int; begin
  update public.expenses set amount = 10001 where id = 'EXP-AUDIT-1';
  /* R-1922: a new company is born with its Customer messages switch ON, and the R-897 switch
     trail deliberately logs that as "System: customer_messages: on" (entity automation_job) —
     the setting the company starts with, not a system change to a business row. Only that one
     line is set aside; every other line still counts, so the system inserts/update above must
     still log nothing. */
  select count(*) into n from public.activity_log
   where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000e1'
     and not (entity = 'automation_job' and entity_id = 'customer_messages' and user_id is null);
  if n <> 0 then raise exception 'FAIL 5: a system change (no user) was logged'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000e1a1', 'role', 'authenticated')::text, true);

do $$
declare r record; n int;
begin
  -- 1
  update public.expenses set amount = 12000 where id = 'EXP-AUDIT-1';
  select * into r from public.activity_log where entity = 'expenses' and entity_id = 'EXP-AUDIT-1' and action = 'update' order by id desc limit 1;
  if not found then raise exception 'FAIL 1a: update not logged'; end if;
  if (r.changes->'amount'->>'old')::int <> 10001 or (r.changes->'amount'->>'new')::int <> 12000 then
    raise exception 'FAIL 1b: amount old/new wrong: %', r.changes;
  end if;
  if r.changes ? 'category' then raise exception 'FAIL 1c: an unchanged column was logged'; end if;
  if r.changes ? 'updated_at' then raise exception 'FAIL 1d: updated_at logged as a change'; end if;

  -- 2
  select count(*) into n from public.activity_log where entity = 'expenses' and entity_id = 'EXP-AUDIT-1';
  update public.expenses set amount = 12000 where id = 'EXP-AUDIT-1';
  if (select count(*) from public.activity_log where entity = 'expenses' and entity_id = 'EXP-AUDIT-1') <> n then
    raise exception 'FAIL 2: a no-op update was logged';
  end if;

  -- 3
  delete from public.salary_payments where id = 'aaaaaaaa-0000-0000-0000-00000000e1c1';
  select * into r from public.activity_log where entity = 'salary_payments' and action = 'delete' order by id desc limit 1;
  if not found then raise exception 'FAIL 3a: salary delete not logged'; end if;
  if (r.changes->'old'->>'net')::int <> 25000 or r.changes->'old'->>'period' <> '2026-08' then
    raise exception 'FAIL 3b: deleted row not kept: %', r.changes;
  end if;
  if r.label <> '2026-08' then raise exception 'FAIL 3c: label should be the period, got %', r.label; end if;

  -- 4
  insert into public.tax_payments (tenant_id, kind, amount, period, paid_on, bank_account_id)
  values ('aaaaaaaa-0000-0000-0000-0000000000e1', 'gst', 5000, '2026-08', '2026-09-20', 'aaaaaaaa-0000-0000-0000-00000000ae1b');
  select count(*) into n from public.activity_log where entity = 'tax_payments' and action = 'insert';
  if n <> 1 then raise exception 'FAIL 4: tax challan insert not logged'; end if;
end $$;

select 'audit_log_values: all assertions passed' as result;
rollback;
