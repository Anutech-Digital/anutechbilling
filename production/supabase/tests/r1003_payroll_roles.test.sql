\set ON_ERROR_STOP on
-- R-1003 (P1 SECURITY, launch blocker): salary rows are read ONLY by owner, manager and
-- accountant (Pardeep's R-718 role table: payroll = owner / manager / accountant).
-- Migration 20261011142000_r1003_payroll_roles. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1003_payroll_roles.test.sql
--
-- Expect "PASS r1003_payroll_roles". Failures are collected and listed together.
-- Before the migration it fails: billing reads both salary rows (20261007053000, R-254) and can
-- edit / delete a staff loan (20261011083000, R-719).
--
--   SEES 2 salary rows       owner, manager, accountant
--   SEES 0 salary rows       billing, sales, sales_senior, support, delivery, partner_agent,
--                            a null-caller (no public.users row), owner of another company
--   staff loan write         owner / manager / accountant may edit a loan's note; billing,
--                            sales, support, delivery change nothing

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1003000-0000-4000-8000-0000000000a1', 'r1003-owner@example.test'),
  ('e1003000-0000-4000-8000-0000000000a2', 'r1003-manager@example.test'),
  ('e1003000-0000-4000-8000-0000000000a3', 'r1003-accountant@example.test'),
  ('e1003000-0000-4000-8000-0000000000a4', 'r1003-billing@example.test'),
  ('e1003000-0000-4000-8000-0000000000a5', 'r1003-sales@example.test'),
  ('e1003000-0000-4000-8000-0000000000a6', 'r1003-salessr@example.test'),
  ('e1003000-0000-4000-8000-0000000000a7', 'r1003-support@example.test'),
  ('e1003000-0000-4000-8000-0000000000a8', 'r1003-delivery@example.test'),
  ('e1003000-0000-4000-8000-0000000000a9', 'r1003-partner@example.test'),
  ('e1003000-0000-4000-8000-0000000000b1', 'r1003-owner-b@example.test'),
  ('e1003000-0000-4000-8000-0000000000ff', 'r1003-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1003000-0000-0000-0000-0000000000a0', 'R1003 A', 'r1003a@example.in', '07', 'R13A'),
  ('e1003000-0000-0000-0000-0000000000b0', 'R1003 B', 'r1003b@example.in', '07', 'R13B');

-- The null-caller has NO public.users row.
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1003000-0000-4000-8000-0000000000a1', 'e1003000-0000-0000-0000-0000000000a0', 'r1003-owner@example.in',      'R1003 Owner',      'owner',         true),
  ('e1003000-0000-4000-8000-0000000000a2', 'e1003000-0000-0000-0000-0000000000a0', 'r1003-manager@example.in',    'R1003 Manager',    'manager',       true),
  ('e1003000-0000-4000-8000-0000000000a3', 'e1003000-0000-0000-0000-0000000000a0', 'r1003-accountant@example.in', 'R1003 Accountant', 'accountant',    true),
  ('e1003000-0000-4000-8000-0000000000a4', 'e1003000-0000-0000-0000-0000000000a0', 'r1003-billing@example.in',    'R1003 Billing',    'billing',       true),
  ('e1003000-0000-4000-8000-0000000000a5', 'e1003000-0000-0000-0000-0000000000a0', 'r1003-sales@example.in',      'R1003 Sales',      'sales',         true),
  ('e1003000-0000-4000-8000-0000000000a6', 'e1003000-0000-0000-0000-0000000000a0', 'r1003-salessr@example.in',    'R1003 Sales Sr',   'sales_senior',  true),
  ('e1003000-0000-4000-8000-0000000000a7', 'e1003000-0000-0000-0000-0000000000a0', 'r1003-support@example.in',    'R1003 Support',    'support',       true),
  ('e1003000-0000-4000-8000-0000000000a8', 'e1003000-0000-0000-0000-0000000000a0', 'r1003-delivery@example.in',   'R1003 Delivery',   'delivery',      true),
  ('e1003000-0000-4000-8000-0000000000a9', 'e1003000-0000-0000-0000-0000000000a0', 'r1003-partner@example.in',    'R1003 Partner',    'partner_agent', true),
  ('e1003000-0000-4000-8000-0000000000b1', 'e1003000-0000-0000-0000-0000000000b0', 'r1003-owner-b@example.in',    'R1003 Owner B',    'owner',         true);

insert into public.employees (id, tenant_id, name, monthly_gross) values
  ('e1003000-0000-4000-8000-0000000e0001', 'e1003000-0000-0000-0000-0000000000a0', 'R1003 Emp 1', 20000),
  ('e1003000-0000-4000-8000-0000000e0002', 'e1003000-0000-0000-0000-0000000000a0', 'R1003 Emp 2', 30000);

insert into public.salary_payments (tenant_id, employee_id, period, gross, net, pay_date, paid_status) values
  ('e1003000-0000-0000-0000-0000000000a0', 'e1003000-0000-4000-8000-0000000e0001', '2026-09', 20000, 18000, '2026-10-01', 'paid'),
  ('e1003000-0000-0000-0000-0000000000a0', 'e1003000-0000-4000-8000-0000000e0002', '2026-09', 30000, 27000, '2026-10-01', 'paid');

insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on, kind, notes) values
  ('e1003000-0000-4000-8000-00000001a000', 'e1003000-0000-0000-0000-0000000000a0', 'R1003 Emp 1', 5000, '2026-10-01', 'loan', 'orig');

create temp table r1003_fail (n serial, label text, detail text);
grant all on r1003_fail to authenticated;
grant usage on sequence r1003_fail_n_seq to authenticated;

set local role authenticated;
do $$
declare who record; n int; want int;
begin
  for who in select * from (values
      ('owner',          'e1003000-0000-4000-8000-0000000000a1', 2),
      ('manager',        'e1003000-0000-4000-8000-0000000000a2', 2),
      ('accountant',     'e1003000-0000-4000-8000-0000000000a3', 2),
      ('billing',        'e1003000-0000-4000-8000-0000000000a4', 0),
      ('sales',          'e1003000-0000-4000-8000-0000000000a5', 0),
      ('sales_senior',   'e1003000-0000-4000-8000-0000000000a6', 0),
      ('support',        'e1003000-0000-4000-8000-0000000000a7', 0),
      ('delivery',       'e1003000-0000-4000-8000-0000000000a8', 0),
      ('partner_agent',  'e1003000-0000-4000-8000-0000000000a9', 0),
      ('other-company',  'e1003000-0000-4000-8000-0000000000b1', 0),
      ('null-caller',    'e1003000-0000-4000-8000-0000000000ff', 0)) w(label, sub, want) loop
    perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', who.sub)::text, true);
    select count(*) into n from public.salary_payments
     where employee_id in ('e1003000-0000-4000-8000-0000000e0001', 'e1003000-0000-4000-8000-0000000e0002');
    if n <> who.want then
      insert into r1003_fail (label, detail) values (who.label || ' salary_payments', 'saw ' || n || ' rows, want ' || who.want);
    end if;
  end loop;

  -- Staff loan edits: only the payroll roles change the note.
  for who in select * from (values
      ('billing',    'e1003000-0000-4000-8000-0000000000a4', 0),
      ('sales',      'e1003000-0000-4000-8000-0000000000a5', 0),
      ('support',    'e1003000-0000-4000-8000-0000000000a7', 0),
      ('delivery',   'e1003000-0000-4000-8000-0000000000a8', 0),
      ('accountant', 'e1003000-0000-4000-8000-0000000000a3', 1),
      ('manager',    'e1003000-0000-4000-8000-0000000000a2', 1),
      ('owner',      'e1003000-0000-4000-8000-0000000000a1', 1)) w(label, sub, want) loop
    perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', who.sub)::text, true);
    begin
      update public.employee_loans set notes = 'by ' || who.label where id = 'e1003000-0000-4000-8000-00000001a000';
      get diagnostics n = row_count;
    exception when insufficient_privilege then n := 0;
    end;
    if n <> who.want then
      insert into r1003_fail (label, detail) values (who.label || ' employee_loans update', 'changed ' || n || ' rows, want ' || who.want);
    end if;
  end loop;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare f text;
begin
  select string_agg(label || ': ' || detail, E'\n  ' order by n) into f from r1003_fail;
  if f is not null then
    raise exception E'FAIL r1003_payroll_roles\n  %', f;
  end if;
  raise notice 'PASS r1003_payroll_roles';
end $$;

rollback;
