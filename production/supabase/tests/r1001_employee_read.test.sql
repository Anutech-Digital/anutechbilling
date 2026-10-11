\set ON_ERROR_STOP on
-- R-1001 (P1 SECURITY): employee personal data (employees, employee_loans,
-- employee_loan_repayments, employee_documents) is readable by owner, manager and
-- accountant only. Migration 20261011142130_r1001_employee_read_roles.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1001_employee_read.test.sql
--
-- Expect "PASS r1001_employee_read". Every check is collected first and the failures are
-- listed together at the end (on the old policies: every non-money role read the victim's
-- row, loan, repayment and document, and the two RPCs did not exist).
--
--   SEES ALL (company A)   owner, manager, accountant — 4 tables
--   SEES NOTHING           billing, sales, sales_senior, support, delivery, partner_agent,
--                          inactive user, no-company user — 4 tables (not even their own row)
--   SEES NOTHING OF A      owner of company B
--   OWN ROW                every linked user via my_employee_profile(); no pin_hash / notes
--   LINK LIST              my_employee_link_choices(): unlinked, e-mail empty or own; names only
--   WRITES                 sales cannot add an employee document; owner can

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1001000-0000-4000-8000-0000000000a1', 'r1001-owner@example.test'),
  ('e1001000-0000-4000-8000-0000000000a2', 'r1001-manager@example.test'),
  ('e1001000-0000-4000-8000-0000000000a3', 'r1001-accountant@example.test'),
  ('e1001000-0000-4000-8000-0000000000a4', 'r1001-billing@example.test'),
  ('e1001000-0000-4000-8000-0000000000a5', 'r1001-sales@example.test'),
  ('e1001000-0000-4000-8000-0000000000a6', 'r1001-salessr@example.test'),
  ('e1001000-0000-4000-8000-0000000000a7', 'r1001-support@example.test'),
  ('e1001000-0000-4000-8000-0000000000a8', 'r1001-delivery@example.test'),
  ('e1001000-0000-4000-8000-0000000000a9', 'r1001-partner@example.test'),
  ('e1001000-0000-4000-8000-0000000000aa', 'r1001-inactive@example.test'),
  ('e1001000-0000-4000-8000-0000000000ab', 'r1001-newsales@example.test'),
  ('e1001000-0000-4000-8000-0000000000b1', 'r1001-owner-b@example.test'),
  ('e1001000-0000-4000-8000-0000000000ff', 'r1001-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1001000-0000-0000-0000-0000000000a0', 'R1001 A', 'r1001a@example.in', '07', 'R1KA'),
  ('e1001000-0000-0000-0000-0000000000b0', 'R1001 B', 'r1001b@example.in', '07', 'R1KB');

-- Employees: one per login (suffix = login suffix), the victim (…e0000), two link choices
-- for the new sales login (…e00c1 no e-mail, …e00c2 its own e-mail) and one it must NOT be
-- offered (…e00c3 someone else's e-mail). Company B has its own owner's row.
insert into public.employees (id, tenant_id, name, monthly_gross, pan, phone, email, notes, pin_hash, is_active) values
  ('e1001000-0000-4000-8000-0000000e0000', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Victim',     55000, 'AAAPV1001A', '9000000000', null, 'private HR note', 'x', true),
  ('e1001000-0000-4000-8000-0000000e00a1', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Owner',      90000, null, null, null, null, 'secret-hash', true),
  ('e1001000-0000-4000-8000-0000000e00a2', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Manager',    70000, null, null, null, null, null, true),
  ('e1001000-0000-4000-8000-0000000e00a3', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Accountant', 60000, null, null, null, null, null, true),
  ('e1001000-0000-4000-8000-0000000e00a4', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Billing',    30000, null, null, null, null, null, true),
  ('e1001000-0000-4000-8000-0000000e00a5', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Sales',      25000, 'AAAPS1001S', null, null, 'note', 'secret-hash', true),
  ('e1001000-0000-4000-8000-0000000e00a6', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 SalesSr',    35000, null, null, null, null, null, true),
  ('e1001000-0000-4000-8000-0000000e00a7', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Support',    22000, null, null, null, null, null, true),
  ('e1001000-0000-4000-8000-0000000e00a8', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Delivery',   24000, null, null, null, null, null, true),
  ('e1001000-0000-4000-8000-0000000e00a9', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Partner',    10000, null, null, null, null, null, true),
  ('e1001000-0000-4000-8000-0000000e00aa', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Inactive',   10000, null, null, null, null, null, true),
  ('e1001000-0000-4000-8000-0000000e00c1', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Choice NoMail', 1, null, null, null, null, null, true),
  ('e1001000-0000-4000-8000-0000000e00c2', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Choice OwnMail', 1, null, null, 'r1001-newsales@example.in', null, null, true),
  ('e1001000-0000-4000-8000-0000000e00c3', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Choice OtherMail', 1, null, null, 'someone-else@example.in', null, null, true),
  ('e1001000-0000-4000-8000-0000000e00b1', 'e1001000-0000-0000-0000-0000000000b0', 'R1001 Owner B',    80000, null, null, null, null, null, true);

-- The no-company caller has NO public.users row. The inactive login is is_active = false.
insert into public.users (id, tenant_id, email, full_name, role, is_active, employee_id) values
  ('e1001000-0000-4000-8000-0000000000a1', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-owner@example.in',      'R1001 Owner',      'owner',         true,  'e1001000-0000-4000-8000-0000000e00a1'),
  ('e1001000-0000-4000-8000-0000000000a2', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-manager@example.in',    'R1001 Manager',    'manager',       true,  'e1001000-0000-4000-8000-0000000e00a2'),
  ('e1001000-0000-4000-8000-0000000000a3', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-accountant@example.in', 'R1001 Accountant', 'accountant',    true,  'e1001000-0000-4000-8000-0000000e00a3'),
  ('e1001000-0000-4000-8000-0000000000a4', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-billing@example.in',    'R1001 Billing',    'billing',       true,  'e1001000-0000-4000-8000-0000000e00a4'),
  ('e1001000-0000-4000-8000-0000000000a5', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-sales@example.in',      'R1001 Sales',      'sales',         true,  'e1001000-0000-4000-8000-0000000e00a5'),
  ('e1001000-0000-4000-8000-0000000000a6', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-salessr@example.in',    'R1001 SalesSr',    'sales_senior',  true,  'e1001000-0000-4000-8000-0000000e00a6'),
  ('e1001000-0000-4000-8000-0000000000a7', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-support@example.in',    'R1001 Support',    'support',       true,  'e1001000-0000-4000-8000-0000000e00a7'),
  ('e1001000-0000-4000-8000-0000000000a8', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-delivery@example.in',   'R1001 Delivery',   'delivery',      true,  'e1001000-0000-4000-8000-0000000e00a8'),
  ('e1001000-0000-4000-8000-0000000000a9', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-partner@example.in',    'R1001 Partner',    'partner_agent', true,  'e1001000-0000-4000-8000-0000000e00a9'),
  ('e1001000-0000-4000-8000-0000000000aa', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-inactive@example.in',   'R1001 Inactive',   'owner',         false, 'e1001000-0000-4000-8000-0000000e00aa'),
  ('e1001000-0000-4000-8000-0000000000ab', 'e1001000-0000-0000-0000-0000000000a0', 'r1001-newsales@example.in',   'R1001 New Sales',  'sales',         true,  null),
  ('e1001000-0000-4000-8000-0000000000b1', 'e1001000-0000-0000-0000-0000000000b0', 'r1001-owner-b@example.in',    'R1001 Owner B',    'owner',         true,  'e1001000-0000-4000-8000-0000000e00b1');

insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on) values
  ('e1001000-0000-4000-8000-00000001a000', 'e1001000-0000-0000-0000-0000000000a0', 'R1001 Victim', 40000, '2026-09-01');
insert into public.employee_loan_repayments (id, tenant_id, loan_id, amount, repaid_on, method) values
  ('e1001000-0000-4000-8000-00000002a000', 'e1001000-0000-0000-0000-0000000000a0', 'e1001000-0000-4000-8000-00000001a000', 5000, '2026-10-01', 'cash');
insert into public.employee_documents (id, tenant_id, employee_id, doc_type, file_name, file_path) values
  ('e1001000-0000-4000-8000-00000003a000', 'e1001000-0000-0000-0000-0000000000a0', 'e1001000-0000-4000-8000-0000000e0000', 'other', 'pan.pdf', 'e1001000-0000-0000-0000-0000000000a0/victim/pan.pdf');

create temp table r1001_fail (n serial, label text, detail text);
grant all on r1001_fail to authenticated, service_role;
grant usage on sequence r1001_fail_n_seq to authenticated, service_role;

create function pg_temp.r1001_as(sub text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', sub)::text, true);
end $f$;
grant execute on function pg_temp.r1001_as(text) to authenticated, service_role;

/* Runs `q` (a query returning one value) as the CURRENT role/claims; an error is recorded
   as a failure (e.g. the RPC is missing on the old schema). */
create function pg_temp.r1001_val(label text, q text) returns text
language plpgsql as $f$
declare v text; v_state text; v_msg text;
begin
  begin
    execute q into v;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r1001_fail(label, detail) values (label, format('query failed %s (%s)', v_state, v_msg));
    return null;
  end;
  return v;
end $f$;
grant execute on function pg_temp.r1001_val(text, text) to authenticated, service_role;

create function pg_temp.r1001_check(label text, got text, want text) returns void
language plpgsql as $f$
begin
  if got is distinct from want then
    insert into r1001_fail(label, detail) values (label, format('got %s, want %s', coalesce(got, 'NULL'), want));
  else
    raise notice 'ok   %: %', label, got;
  end if;
end $f$;
grant execute on function pg_temp.r1001_check(text, text, text) to authenticated, service_role;

set local role authenticated;

-- ── 1. Table reads, every role ─────────────────────────────────────────────────────
do $$
declare who record; v_all boolean;
begin
  for who in select * from (values
      ('owner',          'e1001000-0000-4000-8000-0000000000a1', true),
      ('manager',        'e1001000-0000-4000-8000-0000000000a2', true),
      ('accountant',     'e1001000-0000-4000-8000-0000000000a3', true),
      ('billing',        'e1001000-0000-4000-8000-0000000000a4', false),
      ('sales',          'e1001000-0000-4000-8000-0000000000a5', false),
      ('sales_senior',   'e1001000-0000-4000-8000-0000000000a6', false),
      ('support',        'e1001000-0000-4000-8000-0000000000a7', false),
      ('delivery',       'e1001000-0000-4000-8000-0000000000a8', false),
      ('partner_agent',  'e1001000-0000-4000-8000-0000000000a9', false),
      ('inactive-owner', 'e1001000-0000-4000-8000-0000000000aa', false),
      ('no-company',     'e1001000-0000-4000-8000-0000000000ff', false),
      ('owner-B',        'e1001000-0000-4000-8000-0000000000b1', false)) w(label, sub, sees) loop
    perform pg_temp.r1001_as(who.sub);
    v_all := who.sees;
    perform pg_temp.r1001_check(who.label || ' employees of A',
      pg_temp.r1001_val(who.label || ' employees', $q$select count(*)::text from public.employees where tenant_id = 'e1001000-0000-0000-0000-0000000000a0'$q$),
      case when v_all then '14' else '0' end);
    perform pg_temp.r1001_check(who.label || ' victim salary/PAN',
      pg_temp.r1001_val(who.label || ' victim', $q$select count(*)::text from public.employees where id = 'e1001000-0000-4000-8000-0000000e0000' and pan is not null$q$),
      case when v_all then '1' else '0' end);
    perform pg_temp.r1001_check(who.label || ' employee_loans',
      pg_temp.r1001_val(who.label || ' loans', $q$select count(*)::text from public.employee_loans where tenant_id = 'e1001000-0000-0000-0000-0000000000a0'$q$),
      case when v_all then '1' else '0' end);
    perform pg_temp.r1001_check(who.label || ' employee_loan_repayments',
      pg_temp.r1001_val(who.label || ' repayments', $q$select count(*)::text from public.employee_loan_repayments where tenant_id = 'e1001000-0000-0000-0000-0000000000a0'$q$),
      case when v_all then '1' else '0' end);
    perform pg_temp.r1001_check(who.label || ' employee_documents',
      pg_temp.r1001_val(who.label || ' documents', $q$select count(*)::text from public.employee_documents where tenant_id = 'e1001000-0000-0000-0000-0000000000a0'$q$),
      case when v_all then '1' else '0' end);
  end loop;
end $$;

-- ── 2. my_employee_profile(): own row only, safe columns ─────────────────────────────
do $$
declare who record;
begin
  for who in select * from (values
      ('owner',         'e1001000-0000-4000-8000-0000000000a1', 'e1001000-0000-4000-8000-0000000e00a1'),
      ('manager',       'e1001000-0000-4000-8000-0000000000a2', 'e1001000-0000-4000-8000-0000000e00a2'),
      ('accountant',    'e1001000-0000-4000-8000-0000000000a3', 'e1001000-0000-4000-8000-0000000e00a3'),
      ('billing',       'e1001000-0000-4000-8000-0000000000a4', 'e1001000-0000-4000-8000-0000000e00a4'),
      ('sales',         'e1001000-0000-4000-8000-0000000000a5', 'e1001000-0000-4000-8000-0000000e00a5'),
      ('sales_senior',  'e1001000-0000-4000-8000-0000000000a6', 'e1001000-0000-4000-8000-0000000e00a6'),
      ('support',       'e1001000-0000-4000-8000-0000000000a7', 'e1001000-0000-4000-8000-0000000e00a7'),
      ('delivery',      'e1001000-0000-4000-8000-0000000000a8', 'e1001000-0000-4000-8000-0000000e00a8'),
      ('partner_agent', 'e1001000-0000-4000-8000-0000000000a9', 'e1001000-0000-4000-8000-0000000e00a9'),
      ('owner-B',       'e1001000-0000-4000-8000-0000000000b1', 'e1001000-0000-4000-8000-0000000e00b1'),
      ('inactive-owner','e1001000-0000-4000-8000-0000000000aa', null),
      ('unlinked',      'e1001000-0000-4000-8000-0000000000ab', null),
      ('no-company',    'e1001000-0000-4000-8000-0000000000ff', null)) w(label, sub, emp) loop
    perform pg_temp.r1001_as(who.sub);
    perform pg_temp.r1001_check(who.label || ' my_employee_profile id',
      pg_temp.r1001_val(who.label || ' profile', $q$select public.my_employee_profile()->>'id'$q$),
      who.emp);
    perform pg_temp.r1001_check(who.label || ' profile hides pin_hash/notes',
      pg_temp.r1001_val(who.label || ' profile keys', $q$select (coalesce(public.my_employee_profile(), '{}'::jsonb) ?| array['pin_hash', 'notes'])::text$q$),
      'false');
  end loop;
end $$;

-- sales sees its OWN salary and PAN through the RPC (payslip / profile use)
select pg_temp.r1001_as('e1001000-0000-4000-8000-0000000000a5');
select pg_temp.r1001_check('sales own PAN via profile',
  pg_temp.r1001_val('sales own PAN', $q$select public.my_employee_profile()->>'pan'$q$), 'AAAPS1001S');

-- ── 3. my_employee_link_choices(): unlinked new sales login ─────────────────────────
select pg_temp.r1001_as('e1001000-0000-4000-8000-0000000000ab');
select pg_temp.r1001_check('link choices for unlinked sales',
  pg_temp.r1001_val('link choices', $q$select string_agg(x->>'name', ',' order by x->>'name') from jsonb_array_elements(public.my_employee_link_choices()) x where x->>'name' like 'R1001 Choice%'$q$),
  'R1001 Choice NoMail,R1001 Choice OwnMail');
select pg_temp.r1001_check('link choices never offer a linked employee',
  pg_temp.r1001_val('link linked', $q$select count(*)::text from jsonb_array_elements(public.my_employee_link_choices()) x where x->>'id' in ('e1001000-0000-4000-8000-0000000e00a5', 'e1001000-0000-4000-8000-0000000e00a1')$q$),
  '0');
select pg_temp.r1001_check('link choices are id + name only',
  pg_temp.r1001_val('link keys', $q$select coalesce(bool_and((select array_agg(k order by k) from jsonb_object_keys(x) k) = array['id', 'name']), true)::text from jsonb_array_elements(public.my_employee_link_choices()) x$q$),
  'true');
select pg_temp.r1001_as('e1001000-0000-4000-8000-0000000000ff');
select pg_temp.r1001_check('link choices for no-company',
  pg_temp.r1001_val('link nocompany', $q$select jsonb_array_length(public.my_employee_link_choices())::text$q$), '0');
select pg_temp.r1001_as('e1001000-0000-4000-8000-0000000000b1');
select pg_temp.r1001_check('owner-B link choices never show company A',
  pg_temp.r1001_val('link B', $q$select count(*)::text from jsonb_array_elements(public.my_employee_link_choices()) x where x->>'name' like 'R1001 Choice%'$q$), '0');

-- ── 4. employee_documents writes: sales refused, owner allowed ───────────────────────
select pg_temp.r1001_as('e1001000-0000-4000-8000-0000000000a5');
do $$
begin
  begin
    insert into public.employee_documents (tenant_id, employee_id, doc_type, file_name, file_path)
      values ('e1001000-0000-0000-0000-0000000000a0', 'e1001000-0000-4000-8000-0000000e0000', 'other', 'x.pdf', 'x/x.pdf');
    insert into r1001_fail(label, detail) values ('sales add document', 'insert SUCCEEDED');
  exception when insufficient_privilege then
    raise notice 'ok   sales add document: refused';
  end;
end $$;
select pg_temp.r1001_as('e1001000-0000-4000-8000-0000000000a1');
insert into public.employee_documents (tenant_id, employee_id, doc_type, file_name, file_path)
  values ('e1001000-0000-0000-0000-0000000000a0', 'e1001000-0000-4000-8000-0000000e0000', 'other', 'owner.pdf', 'x/owner.pdf');

-- ── 5. service_role is still trusted ────────────────────────────────────────────────
reset role;
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select pg_temp.r1001_check('service_role employees of A',
  pg_temp.r1001_val('service employees', $q$select count(*)::text from public.employees where tenant_id = 'e1001000-0000-0000-0000-0000000000a0'$q$), '14');
select pg_temp.r1001_check('service_role documents of A',
  pg_temp.r1001_val('service docs', $q$select count(*)::text from public.employee_documents where tenant_id = 'e1001000-0000-0000-0000-0000000000a0'$q$), '2');
reset role;

-- ── Verdict ───────────────────────────────────────────────────────────────────────
do $$
declare v text;
begin
  select string_agg(format('  FAIL %s: %s', label, detail), E'\n' order by n) into v from r1001_fail;
  if v is not null then
    raise exception E'r1001_employee_read — % failure(s):\n%', (select count(*) from r1001_fail), v;
  end if;
  raise notice 'PASS r1001_employee_read';
end $$;

rollback;
