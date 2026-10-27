-- R-1852 (epic R-1841, Phase 3): link a director (company_directors) to the employee Payroll pays.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1852_director_employee.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1852 migration> <this test> rollback;
-- Expect "PASS r1852".
--
-- Proves:
--   1. the owner links director A to employee E1; the accountant links B to E2; unlink (null) works.
--   2. one employee is one director: linking E1 to B as well is refused with a plain message.
--   3. another company's employee or director is refused ("not in your company"), both ways.
--   4. sales is refused 42501; a login with no company 28000; a proprietor's company is refused.
--   5. no direct update of employee_id for authenticated (writes only through the function).
--   6. deleting the employee clears the link (on delete set null), the director stays.
--   7. save_company_director (R-1850 / R-1857) keeps the link when the director is edited.
--
-- Mutation checks (each must turn this test RED — tried 25 Oct 2026):
--   a. drop the employee tenant check            → FAIL 1a (A got the other company's employee)
--   b. drop the role check                       → FAIL 1a (sales unlinked A)
--   c. drop the "already linked" check (the index alone → raw duplicate-key error) → FAIL 2
--   d. drop the director tenant check            → FAIL 3b

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1852000-0000-4000-8000-0000000000' || k)::uuid, 'r1852-' || k || '@example.test'
  from unnest(array['01','02','03','04','05','06']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, business_type) values
  ('e1852000-0000-0000-0000-0000000000f1', 'R1852 PvtLtd', 'r1852a@example.in', '07', 'Delhi', 'R street, Delhi', 'R52A', '07AAACR1852R1Z1', 'registered', 'pvt_ltd'),
  ('e1852000-0000-0000-0000-0000000000f2', 'R1852 Other',  'r1852b@example.in', '07', 'Delhi', 'R street, Delhi', 'R52B', '07AAACR1852R1Z2', 'registered', null),
  ('e1852000-0000-0000-0000-0000000000f3', 'R1852 Prop',   'r1852c@example.in', '07', 'Delhi', 'R street, Delhi', 'R52C', '07AAACR1852R1Z3', 'registered', 'proprietor');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1852000-0000-4000-8000-000000000001', 'e1852000-0000-0000-0000-0000000000f1', 'r1852-01@example.in', 'Pvt owner', 'owner', true),
  ('e1852000-0000-4000-8000-000000000002', 'e1852000-0000-0000-0000-0000000000f1', 'r1852-02@example.in', 'Pvt acct',  'accountant', true),
  ('e1852000-0000-4000-8000-000000000003', 'e1852000-0000-0000-0000-0000000000f1', 'r1852-03@example.in', 'Pvt sales', 'sales', true),
  ('e1852000-0000-4000-8000-000000000004', 'e1852000-0000-0000-0000-0000000000f2', 'r1852-04@example.in', 'Other mgr', 'manager', true),
  ('e1852000-0000-4000-8000-000000000005', 'e1852000-0000-0000-0000-0000000000f3', 'r1852-05@example.in', 'Prop owner', 'owner', true);

-- directors (service context: the register's own function) and employees
insert into public.company_directors (id, tenant_id, name, din, designation) values
  ('e1852000-0000-0000-0000-0000000000d1', 'e1852000-0000-0000-0000-0000000000f1', 'Asha Verma', '01234567', 'managing_director'),
  ('e1852000-0000-0000-0000-0000000000d2', 'e1852000-0000-0000-0000-0000000000f1', 'Bimal Rao',  '07654321', 'director'),
  ('e1852000-0000-0000-0000-0000000000d4', 'e1852000-0000-0000-0000-0000000000f2', 'Other Dir',  '01111111', 'director');
insert into public.employees (id, tenant_id, name, monthly_gross) values
  ('e1852000-0000-0000-0000-0000000000e1', 'e1852000-0000-0000-0000-0000000000f1', 'Asha Verma', 150000),
  ('e1852000-0000-0000-0000-0000000000e2', 'e1852000-0000-0000-0000-0000000000f1', 'Bimal Rao',  90000),
  ('e1852000-0000-0000-0000-0000000000e4', 'e1852000-0000-0000-0000-0000000000f2', 'Other Emp',  50000),
  ('e1852000-0000-0000-0000-0000000000e5', 'e1852000-0000-0000-0000-0000000000f3', 'Prop Emp',   20000);

create temp table r1852_res (k text primary key, v text);
grant all on r1852_res to authenticated, service_role;

create function pg_temp.r1852_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1852000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1852_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r1852_v(p_k text) returns text language sql as $$ select v from r1852_res where k = p_k $$;
create function pg_temp.r1852_emp(p_dir text) returns uuid language sql as $$
  select employee_id from public.company_directors where id = ('e1852000-0000-0000-0000-0000000000' || p_dir)::uuid
$$;

-- 1. owner links A↔E1; accountant links B↔E2, then unlinks and links again
select pg_temp.r1852_as('01');
select public.set_director_employee('e1852000-0000-0000-0000-0000000000d1', 'e1852000-0000-0000-0000-0000000000e1');
select pg_temp.r1852_as('02');
select public.set_director_employee('e1852000-0000-0000-0000-0000000000d2', 'e1852000-0000-0000-0000-0000000000e2');
select public.set_director_employee('e1852000-0000-0000-0000-0000000000d2', null);
insert into r1852_res values ('unlinked', coalesce(pg_temp.r1852_emp('d2')::text, 'null'));
select public.set_director_employee('e1852000-0000-0000-0000-0000000000d2', 'e1852000-0000-0000-0000-0000000000e2');

-- 2. one employee, one director
insert into r1852_res select 'dup', pg_temp.r1852_err($q$select public.set_director_employee('e1852000-0000-0000-0000-0000000000d2', 'e1852000-0000-0000-0000-0000000000e1')$q$);

-- 3. cross-company
insert into r1852_res select 'cross_emp', pg_temp.r1852_err($q$select public.set_director_employee('e1852000-0000-0000-0000-0000000000d1', 'e1852000-0000-0000-0000-0000000000e4')$q$);
insert into r1852_res select 'cross_dir', pg_temp.r1852_err($q$select public.set_director_employee('e1852000-0000-0000-0000-0000000000d4', 'e1852000-0000-0000-0000-0000000000e1')$q$);

-- 4. who may write
select pg_temp.r1852_as('03');
insert into r1852_res select 'sales', pg_temp.r1852_err($q$select public.set_director_employee('e1852000-0000-0000-0000-0000000000d1', null)$q$);
select pg_temp.r1852_as('06');
insert into r1852_res select 'nocompany', pg_temp.r1852_err($q$select public.set_director_employee('e1852000-0000-0000-0000-0000000000d1', null)$q$);
select pg_temp.r1852_as('05');
insert into r1852_res select 'prop', pg_temp.r1852_err($q$select public.set_director_employee('e1852000-0000-0000-0000-0000000000d1', 'e1852000-0000-0000-0000-0000000000e5')$q$);

do $$ begin
  if pg_temp.r1852_emp('d1') is distinct from 'e1852000-0000-0000-0000-0000000000e1'::uuid then raise exception 'FAIL 1a A not linked: %', pg_temp.r1852_emp('d1'); end if;
  if pg_temp.r1852_v('unlinked') <> 'null' then raise exception 'FAIL 1b unlink: %', pg_temp.r1852_v('unlinked'); end if;
  if pg_temp.r1852_emp('d2') is distinct from 'e1852000-0000-0000-0000-0000000000e2'::uuid then raise exception 'FAIL 1c B not linked'; end if;
  if pg_temp.r1852_v('dup') not like '%already linked to%' then raise exception 'FAIL 2 dup: %', pg_temp.r1852_v('dup'); end if;
  if pg_temp.r1852_v('cross_emp') not like '%employee is not in your company%' then raise exception 'FAIL 3a cross employee: %', pg_temp.r1852_v('cross_emp'); end if;
  if pg_temp.r1852_v('cross_dir') not like '%director is not in your company%' then raise exception 'FAIL 3b cross director: %', pg_temp.r1852_v('cross_dir'); end if;
  if pg_temp.r1852_v('sales')     not like '42501:%' then raise exception 'FAIL 4a sales: %', pg_temp.r1852_v('sales'); end if;
  if pg_temp.r1852_v('nocompany') not like '28000:%' then raise exception 'FAIL 4b no company: %', pg_temp.r1852_v('nocompany'); end if;
  if pg_temp.r1852_v('prop') not like '%for a Pvt Ltd%' then raise exception 'FAIL 4c prop: %', pg_temp.r1852_v('prop'); end if;
  if pg_temp.r1852_emp('d4') is not null then raise exception 'FAIL 3c other company director changed'; end if;
end $$;

-- 5. no direct write
select pg_temp.r1852_as('01');
set local role authenticated;
do $$ begin
  update public.company_directors set employee_id = null;
  raise exception 'FAIL 5 direct update was allowed';
exception when insufficient_privilege then null;
end $$;
-- the owner can READ the link (the P&L and the employee drawer need it)
do $$ begin
  if (select count(*) from public.company_directors where employee_id is not null) <> 2 then raise exception 'FAIL 5b read link'; end if;
end $$;
reset role;

-- 7. editing the director keeps the link
select pg_temp.r1852_as('01');
select public.save_company_director('e1852000-0000-0000-0000-0000000000d1', 'Asha K Verma', '01234567', null, 'managing_director', null, null, null, null, null, null);
do $$ begin
  if pg_temp.r1852_emp('d1') is distinct from 'e1852000-0000-0000-0000-0000000000e1'::uuid then raise exception 'FAIL 7 edit dropped the link'; end if;
end $$;

-- 6. deleting the employee clears the link
delete from public.employees where id = 'e1852000-0000-0000-0000-0000000000e2';
do $$ begin
  if not exists (select 1 from public.company_directors where id = 'e1852000-0000-0000-0000-0000000000d2' and employee_id is null) then
    raise exception 'FAIL 6 employee delete did not clear the link';
  end if;
end $$;

select 'PASS r1852' as result;

rollback;
