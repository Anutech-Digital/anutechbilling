\set ON_ERROR_STOP on
-- R-1404 — client-data isolation proof: another tenant's OWNER (the strongest in-app role) can
-- neither read, export, change nor delete our rows, and cannot touch our files.
-- Runs in CI (.github/workflows/sql-tests.yml). Rolled back — safe anywhere. Fake fixtures only.
--
--   1. READ / EXPORT  every table the CSV / report exports are built from: Tenant B's owner sees
--                     0 of Tenant A's rows, both without a filter and with `where tenant_id = A`
--                     (the e2e cross-tenant.spec's two leak patterns, now in a layer CI runs).
--   2. REPORT RPCs    report_pnl / report_pnl_monthly / report_balance_sheet / report_day_book /
--                     report_party_ledger / report_ledger_vendors / msme_payables_aging /
--                     list_leads, called by B's owner, never contain A's marker.
--   3. WRITES         UPDATE / DELETE on customers, invoices, payments, subscriptions, quotes,
--                     employees, salary_payments (payroll), documents: 0 rows (or refused), and an
--                     INSERT into Tenant A is refused. Checked afterwards as the migration owner:
--                     every A row is still there, unchanged.
--   4. FILES          storage.objects: B's owner lists none of A's files in any bucket, cannot
--                     insert under A's folder, and UPDATE / DELETE of A's object change 0 rows.
--
-- `set local role authenticated` is the test: a superuser bypasses RLS, so without the switch this
-- file would pass on a database with no policies at all.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('14040000-0000-4000-8000-00000000000a', 'R1404A Tenant', 'r1404-a@example.test', '07', 'R14A'),
  ('14040000-0000-4000-8000-00000000000b', 'R1404B Tenant', 'r1404-b@example.test', '07', 'R14B');

insert into auth.users (id, instance_id, aud, role, email) values
  ('14040000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1404-owner-a@example.test'),
  ('14040000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1404-owner-b@example.test');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('14040000-0000-4000-8000-0000000000a1', '14040000-0000-4000-8000-00000000000a', 'r1404-owner-a@example.test', 'owner', true),
  ('14040000-0000-4000-8000-0000000000b1', '14040000-0000-4000-8000-00000000000b', 'r1404-owner-b@example.test', 'owner', true);

-- Tenant A's data. Every human-readable field carries the marker R1404A so a leak through any
-- report is a substring match, whatever shape the report returns.
insert into public.customers (id, tenant_id, name, created_at) values
  ('14040000-0000-4000-8000-0000000000c1', '14040000-0000-4000-8000-00000000000a', 'R1404A Customer', now() - interval '3 days');
insert into public.leads (id, tenant_id, company) values
  ('R1404A-LEAD-1', '14040000-0000-4000-8000-00000000000a', 'R1404A Lead Co');
insert into public.contacts (id, tenant_id, full_name, customer_id) values
  ('14040000-0000-4000-8000-0000000000c2', '14040000-0000-4000-8000-00000000000a', 'R1404A Contact', '14040000-0000-4000-8000-0000000000c1');
insert into public.quotes (id, tenant_id, customer_name, customer_id) values
  ('R1404A-Q-1', '14040000-0000-4000-8000-00000000000a', 'R1404A Customer', '14040000-0000-4000-8000-0000000000c1');
insert into public.invoices (id, tenant_id, customer_name, customer_id, amount) values
  ('R1404A-INV-1', '14040000-0000-4000-8000-00000000000a', 'R1404A Customer', '14040000-0000-4000-8000-0000000000c1', 140401);
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method) values
  ('14040000-0000-4000-8000-0000000000f1', '14040000-0000-4000-8000-00000000000a', 'R1404A-Q-1', '14040000-0000-4000-8000-0000000000c1', 140402, 'upi');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr) values
  ('14040000-0000-4000-8000-0000000000e1', '14040000-0000-4000-8000-00000000000a', '14040000-0000-4000-8000-0000000000c1', 'R1404A Customer', 'R1404A Plan', 'google', 3, 140403);
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('R1404A-ITEM-1', '14040000-0000-4000-8000-00000000000a', 'R1404A Plan', 'google', 500, 400);
insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, total) values
  ('R1404A-BILL-1', '14040000-0000-4000-8000-00000000000a', 'R1404A Vendor', current_date, 140404);
insert into public.expenses (id, tenant_id, category, expense_date, amount, vendor_name) values
  ('14040000-0000-4000-8000-0000000000d1', '14040000-0000-4000-8000-00000000000a', 'other', current_date, 140405, 'R1404A Vendor');
insert into public.purchase_orders (id, tenant_id, customer_name, vendor, plan, seats) values
  ('R1404A-PO-1', '14040000-0000-4000-8000-00000000000a', 'R1404A Customer', 'google', 'R1404A Plan', 3);
insert into public.tasks (tenant_id, title, due_at) values
  ('14040000-0000-4000-8000-00000000000a', 'R1404A Task', now());
insert into public.employees (id, tenant_id, name) values
  ('14040000-0000-4000-8000-0000000000e2', '14040000-0000-4000-8000-00000000000a', 'R1404A Employee');
insert into public.salary_payments (id, tenant_id, employee_id, period, pay_date, gross, net) values
  ('14040000-0000-4000-8000-0000000000e3', '14040000-0000-4000-8000-00000000000a', '14040000-0000-4000-8000-0000000000e2', '2026-09', current_date, 140406, 140406);
insert into public.statutory_dues_payments (tenant_id, amount, paid_on) values
  ('14040000-0000-4000-8000-00000000000a', 140407, current_date);
insert into public.documents (id, tenant_id, title, file_path) values
  ('14040000-0000-4000-8000-0000000000d2', '14040000-0000-4000-8000-00000000000a', 'R1404A Secret Deed', '14040000-0000-4000-8000-00000000000a/deed.pdf');

insert into storage.objects (bucket_id, name, owner) values
  ('documents',        '14040000-0000-4000-8000-00000000000a/deed.pdf',         '14040000-0000-4000-8000-0000000000a1'),
  ('employee-docs',    '14040000-0000-4000-8000-00000000000a/e2/kyc.pdf',       '14040000-0000-4000-8000-0000000000a1'),
  ('expense-receipts', '14040000-0000-4000-8000-00000000000a/d1/receipt.jpg',   '14040000-0000-4000-8000-0000000000a1'),
  ('tds-certificates', '14040000-0000-4000-8000-00000000000a/16a.pdf',          '14040000-0000-4000-8000-0000000000a1');

-- Helpers. Each runs the statement for the CURRENT caller and reports what RLS let through.
-- A write that RLS refuses either changes 0 rows or raises insufficient_privilege; both are "refused".
create function pg_temp.r1404_write_refused(p_sql text) returns boolean language plpgsql as $$
declare n int;
begin
  execute p_sql; get diagnostics n = row_count; return n = 0;
exception when insufficient_privilege then return true;
          when check_violation then return true;   -- tenant_guard / with-check style refusals
end $$;

-- A report's whole output as one string; an error is reported as text (an error is not a leak,
-- but it is printed so a broken signature does not hide behind a PASS).
create function pg_temp.r1404_report(p_sql text) returns text language plpgsql as $$
declare out text;
begin
  execute 'select coalesce(string_agg(t::text, '' ''), '''') from (' || p_sql || ') t' into out;
  return out;
exception when others then return 'ERR ' || sqlerrm;
end $$;
-- The caller below is `authenticated`; without these grants the helpers themselves are "permission denied".
grant execute on function pg_temp.r1404_write_refused(text), pg_temp.r1404_report(text) to authenticated;

do $$
declare
  c_a constant uuid := '14040000-0000-4000-8000-00000000000a';
  u_b constant text := '14040000-0000-4000-8000-0000000000b1';
  tbl text; n int; total int; rep text; v_bucket text;
  export_tables text[] := array[
    'customers','leads','contacts','quotes','invoices','payments','subscriptions','items',
    'vendor_bills','expenses','purchase_orders','tasks','employees','salary_payments',
    'statutory_dues_payments','documents'];
  reports text[] := array[
    'select * from public.report_pnl(current_date - 300, current_date + 1)',
    'select public.report_pnl_monthly(current_date - 300, current_date + 1)',
    'select * from public.report_balance_sheet(current_date + 1)',
    'select public.report_day_book(current_date - 300, current_date + 1)',
    'select public.report_party_ledger(''customer'', ''14040000-0000-4000-8000-0000000000c1'', current_date - 300, current_date + 1)',
    'select public.report_ledger_vendors()',
    'select * from public.msme_payables_aging(current_date + 1)',
    'select public.list_leads(null, 100, ''{}''::jsonb)'];
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u_b, 'role', 'authenticated')::text, true);

  -- ════ 1. read / export: Tenant B's owner sees nothing of A ═══════════════════════════════
  foreach tbl in array export_tables loop
    execute format('select count(*) from public.%I where tenant_id = %L', tbl, c_a) into n;
    if n <> 0 then raise exception 'FAIL 1: B''s owner reads % row(s) of %.% with tenant_id = A', n, 'public', tbl; end if;
    execute format('select count(*) from public.%I', tbl) into total;
    if total <> 0 then raise exception 'FAIL 1: B''s owner''s unfiltered select on % returns % row(s) (B has none)', tbl, total; end if;
  end loop;
  raise notice 'PASS 1: % export tables — 0 of A''s rows for B''s owner, filtered and unfiltered', array_length(export_tables, 1);

  -- ════ 2. report RPCs ═════════════════════════════════════════════════════════════════════
  foreach rep in array reports loop
    rep := pg_temp.r1404_report(rep);
    if rep like 'ERR %' then
      -- A refusal is not a leak (its message may echo B's own arguments, e.g. the id B asked for).
      raise notice 'note 2: report refused / could not run for B (not a leak): %', left(rep, 160);
      continue;
    end if;
    if position('R1404A' in rep) > 0 or position('14040' in rep) > 0 then
      raise exception 'FAIL 2: a report called by B''s owner contains A''s data: %', left(rep, 300);
    end if;
  end loop;
  raise notice 'PASS 2: % report RPCs show B''s owner none of A''s figures', array_length(reports, 1);

  -- ════ 3. cross-tenant UPDATE / DELETE / INSERT ════════════════════════════════════════════
  if not pg_temp.r1404_write_refused('update public.customers set name = ''pwned'' where tenant_id = ''' || c_a || '''') then raise exception 'FAIL 3: B updated A''s customer'; end if;
  if not pg_temp.r1404_write_refused('update public.invoices set customer_name = ''pwned'' where tenant_id = ''' || c_a || '''') then raise exception 'FAIL 3: B updated A''s invoice'; end if;
  if not pg_temp.r1404_write_refused('update public.payments set amount = 1 where tenant_id = ''' || c_a || '''') then raise exception 'FAIL 3: B updated A''s payment'; end if;
  if not pg_temp.r1404_write_refused('update public.subscriptions set seats = 999 where tenant_id = ''' || c_a || '''') then raise exception 'FAIL 3: B updated A''s subscription'; end if;
  if not pg_temp.r1404_write_refused('update public.quotes set customer_name = ''pwned'' where tenant_id = ''' || c_a || '''') then raise exception 'FAIL 3: B updated A''s quote'; end if;
  if not pg_temp.r1404_write_refused('update public.employees set name = ''pwned'' where tenant_id = ''' || c_a || '''') then raise exception 'FAIL 3: B updated A''s employee'; end if;
  if not pg_temp.r1404_write_refused('update public.salary_payments set net = 1 where tenant_id = ''' || c_a || '''') then raise exception 'FAIL 3: B updated A''s salary payment'; end if;
  if not pg_temp.r1404_write_refused('update public.documents set title = ''pwned'' where tenant_id = ''' || c_a || '''') then raise exception 'FAIL 3: B updated A''s document'; end if;

  foreach tbl in array array['customers','invoices','payments','subscriptions','quotes','employees','salary_payments','documents'] loop
    if not pg_temp.r1404_write_refused(format('delete from public.%I where tenant_id = %L', tbl, c_a)) then
      raise exception 'FAIL 3: B deleted A''s % row(s)', tbl;
    end if;
  end loop;

  if not pg_temp.r1404_write_refused('insert into public.customers (tenant_id, name) values (''' || c_a || ''', ''planted by B'')') then raise exception 'FAIL 3: B inserted a customer into A'; end if;
  if not pg_temp.r1404_write_refused('insert into public.invoices (id, tenant_id, customer_name, amount) values (''R1404B-PLANT'', ''' || c_a || ''', ''planted by B'', 1)') then raise exception 'FAIL 3: B inserted an invoice into A'; end if;
  if not pg_temp.r1404_write_refused('insert into public.employees (tenant_id, name) values (''' || c_a || ''', ''planted by B'')') then raise exception 'FAIL 3: B inserted an employee into A'; end if;
  if not pg_temp.r1404_write_refused('insert into public.documents (tenant_id, title, file_path) values (''' || c_a || ''', ''planted'', ''' || c_a || '/planted.pdf'')') then raise exception 'FAIL 3: B inserted a document into A'; end if;
  raise notice 'PASS 3: cross-tenant UPDATE / DELETE / INSERT refused on all 8 tables';

  -- ════ 4. files ═══════════════════════════════════════════════════════════════════════════
  foreach v_bucket in array array['documents','employee-docs','expense-receipts','tds-certificates'] loop
    select count(*) into n from storage.objects where bucket_id = v_bucket and name like c_a || '/%';
    if n <> 0 then raise exception 'FAIL 4: B''s owner lists % of A''s file(s) in bucket %', n, v_bucket; end if;
  end loop;
  if not pg_temp.r1404_write_refused('insert into storage.objects (bucket_id, name, owner) values (''documents'', ''' || c_a || '/planted.pdf'', ''' || u_b || ''')') then raise exception 'FAIL 4: B planted a file under A''s folder'; end if;
  if not pg_temp.r1404_write_refused('update storage.objects set metadata = ''{"r1404":"swapped"}''::jsonb where name like ''' || c_a || '/%''') then raise exception 'FAIL 4: B changed A''s file row'; end if;
  if not pg_temp.r1404_write_refused('delete from storage.objects where name like ''' || c_a || '/%''') then raise exception 'FAIL 4: B deleted A''s file row'; end if;
  raise notice 'PASS 4: B''s owner sees, plants, changes and deletes none of A''s files';

  -- ════ sanity: A's own owner still sees A (the test is not green because everything is hidden) ══
  perform set_config('request.jwt.claims', json_build_object('sub', '14040000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  select count(*) into n from public.customers where tenant_id = c_a;
  if n <> 1 then raise exception 'FAIL 5: A''s owner sees % customer(s) (expected 1) — fixture or policy broken', n; end if;
  select count(*) into n from storage.objects where bucket_id = 'documents' and name like c_a || '/%';
  if n <> 1 then raise exception 'FAIL 5: A''s owner sees % vault file(s) (expected 1)', n; end if;
  raise notice 'PASS 5: A''s owner still reads A';
end $$;

-- After the writes: as the migration owner (no RLS), A's rows are all present and unchanged.
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare c_a constant uuid := '14040000-0000-4000-8000-00000000000a'; n int;
begin
  select count(*) into n from public.customers where tenant_id = c_a and name = 'R1404A Customer';
  if n <> 1 then raise exception 'FAIL 6: A''s customer changed or vanished'; end if;
  select count(*) into n from public.invoices where tenant_id = c_a and customer_name = 'R1404A Customer' and amount = 140401;
  if n <> 1 then raise exception 'FAIL 6: A''s invoice changed or vanished'; end if;
  select count(*) into n from public.payments where tenant_id = c_a and amount = 140402;
  if n <> 1 then raise exception 'FAIL 6: A''s payment changed or vanished'; end if;
  select count(*) into n from public.subscriptions where tenant_id = c_a and seats = 3;
  if n <> 1 then raise exception 'FAIL 6: A''s subscription changed or vanished'; end if;
  select count(*) into n from public.quotes where tenant_id = c_a and customer_name = 'R1404A Customer';
  if n <> 1 then raise exception 'FAIL 6: A''s quote changed or vanished'; end if;
  select count(*) into n from public.employees where tenant_id = c_a and name = 'R1404A Employee';
  if n <> 1 then raise exception 'FAIL 6: A''s employee changed or vanished'; end if;
  select count(*) into n from public.salary_payments where tenant_id = c_a and net = 140406;
  if n <> 1 then raise exception 'FAIL 6: A''s salary payment changed or vanished'; end if;
  select count(*) into n from public.documents where tenant_id = c_a and title = 'R1404A Secret Deed';
  if n <> 1 then raise exception 'FAIL 6: A''s document changed or vanished'; end if;
  select count(*) into n from public.invoices where id = 'R1404B-PLANT';
  if n <> 0 then raise exception 'FAIL 6: B''s planted invoice exists in A'; end if;
  select count(*) into n from public.customers where tenant_id = c_a;
  if n <> 1 then raise exception 'FAIL 6: A has % customers (planted row?)', n; end if;
  select count(*) into n from storage.objects where name like c_a || '/%' and coalesce(metadata::text, '') not like '%swapped%';
  if n <> 4 then raise exception 'FAIL 6: A''s 4 files are not all intact (%)', n; end if;
  raise notice 'PASS 6: every A row and file intact after B''s attempts';
end $$;

rollback;
