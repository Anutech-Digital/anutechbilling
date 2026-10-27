-- R-1857 (epic R-1841, Phase 4): a director's personal mobile / email changes → DIR-3 KYC Web
-- within 30 days (Rule 12A(2), G.S.R. 943(E)). The register records the day it saw the change.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1857_director_kyc_change.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1857 migration> <this test> rollback;
-- Expect "PASS r1857".
--
-- Proves:
--   1. a new director (with email / phone) has NO change date — adding is not a change.
--   2. editing only the name / DSC / KYC year leaves the change date empty.
--   3. a new email → kyc_details_changed_on = today (IST); a new phone on another director too.
--   4. the accountant saving with the MASKED email / phone (R-1009) is not a change.
--   5. clearing the email (null) is not a change to report (nothing new to file).
--   6. the R-1850 rules still hold: sales refused 42501, cross-company edit refused, bad DIN refused.
--   7. the column cannot be set from outside the function (no direct update for authenticated).
--
-- Mutation checks (each must turn this test RED — tried 25 Oct 2026):
--   a. set the date on insert too                         → FAIL 1
--   b. compare only email (drop the phone check)          → FAIL 3b
--   c. compare before resolving the masked value          → FAIL 4
--   d. treat "email cleared" as a change                  → FAIL 5

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1857000-0000-4000-8000-0000000000' || k)::uuid, 'r1857-' || k || '@example.test'
  from unnest(array['01','02','03','04']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, business_type) values
  ('e1857000-0000-0000-0000-0000000000f1', 'R1857 PvtLtd', 'r1857a@example.in', '07', 'Delhi', 'R street, Delhi', 'R57A', '07AAACR1857R1Z1', 'registered', 'pvt_ltd'),
  ('e1857000-0000-0000-0000-0000000000f2', 'R1857 Other',  'r1857b@example.in', '07', 'Delhi', 'R street, Delhi', 'R57B', '07AAACR1857R1Z2', 'registered', null);

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1857000-0000-4000-8000-000000000001', 'e1857000-0000-0000-0000-0000000000f1', 'r1857-01@example.in', 'Pvt owner', 'owner', true),
  ('e1857000-0000-4000-8000-000000000002', 'e1857000-0000-0000-0000-0000000000f1', 'r1857-02@example.in', 'Pvt acct',  'accountant', true),
  ('e1857000-0000-4000-8000-000000000003', 'e1857000-0000-0000-0000-0000000000f1', 'r1857-03@example.in', 'Pvt sales', 'sales', true),
  ('e1857000-0000-4000-8000-000000000004', 'e1857000-0000-0000-0000-0000000000f2', 'r1857-04@example.in', 'Other mgr', 'manager', true);

create temp table r1857_res (k text primary key, v text);
grant all on r1857_res to authenticated, service_role;

create function pg_temp.r1857_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1857000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1857_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r1857_v(p_k text) returns text language sql as $$ select v from r1857_res where k = p_k $$;
create function pg_temp.r1857_chg(p_k text) returns date language sql as $$
  select kyc_details_changed_on from public.company_directors where id = pg_temp.r1857_v(p_k)::uuid
$$;

-- 1. owner adds A, B, C (all with contact details)
select pg_temp.r1857_as('01');
insert into r1857_res select 'dA', public.save_company_director(null, 'Asha Verma', '01234567', null, 'managing_director', '2024-04-01', null, '2027-03-31', 2025, 'asha@example.in', '9810012345')::text;
insert into r1857_res select 'dB', public.save_company_director(null, 'Bimal Rao',  '07654321', null, 'director', '2024-04-01', null, '2026-11-14', 2025, 'bimal@example.in', '9811122233')::text;
insert into r1857_res select 'dC', public.save_company_director(null, 'Chitra Iyer','05555555', null, 'director', '2024-04-01', null, null, 2025, 'chitra@example.in', '9822233344')::text;
insert into r1857_res select 'dD', public.save_company_director(null, 'Dev Mehta',  '06666666', null, 'director', '2024-04-01', null, null, 2025, 'dev@example.in', null)::text;
do $$ begin
  if pg_temp.r1857_chg('dA') is not null or pg_temp.r1857_chg('dB') is not null then
    raise exception 'FAIL 1 adding a director counted as a change';
  end if;
end $$;

-- 2. name / DSC / KYC year edits are not a change of contact
select public.save_company_director(pg_temp.r1857_v('dA')::uuid, 'Asha K Verma', '01234567', null, 'managing_director', '2024-04-01', null, '2028-03-31', 2025, 'asha@example.in', '9810012345');
do $$ begin
  if pg_temp.r1857_chg('dA') is not null then raise exception 'FAIL 2 a name/DSC edit counted as a contact change'; end if;
end $$;

-- 3. new email on A, new phone on B
select public.save_company_director(pg_temp.r1857_v('dA')::uuid, 'Asha K Verma', '01234567', null, 'managing_director', '2024-04-01', null, '2028-03-31', 2025, 'asha.verma@example.in', '9810012345');
select public.save_company_director(pg_temp.r1857_v('dB')::uuid, 'Bimal Rao', '07654321', null, 'director', '2024-04-01', null, '2026-11-14', 2025, 'bimal@example.in', '9899988877');
do $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if pg_temp.r1857_chg('dA') is distinct from v_today then raise exception 'FAIL 3a new email: %', pg_temp.r1857_chg('dA'); end if;
  if pg_temp.r1857_chg('dB') is distinct from v_today then raise exception 'FAIL 3b new phone: %', pg_temp.r1857_chg('dB'); end if;
end $$;

-- 4. accountant saves C with the MASKED email / phone the gateway showed → no change
select pg_temp.r1857_as('02');
select public.save_company_director(pg_temp.r1857_v('dC')::uuid, 'Chitra Iyer', '05555555', null, 'director', '2024-04-01', null, '2027-01-01', 2025, 'ch••••@example.in', '••••••3344');
do $$ begin
  if pg_temp.r1857_chg('dC') is not null then raise exception 'FAIL 4 a masked save counted as a change'; end if;
  if (select email from public.company_directors where id = pg_temp.r1857_v('dC')::uuid) <> 'chitra@example.in' then
    raise exception 'FAIL 4b masked email overwrote the real one';
  end if;
end $$;

-- 5. clearing D's email is not something to file
select pg_temp.r1857_as('01');
select public.save_company_director(pg_temp.r1857_v('dD')::uuid, 'Dev Mehta', '06666666', null, 'director', '2024-04-01', null, null, 2025, null, null);
do $$ begin
  if pg_temp.r1857_chg('dD') is not null then raise exception 'FAIL 5 a cleared email counted as a change'; end if;
end $$;

-- 6. R-1850 rules unchanged
select pg_temp.r1857_as('03');
insert into r1857_res select 'sales', pg_temp.r1857_err(format('select public.save_company_director(%L, %L, %L, null, %L, null, null, null, null, %L, null)', pg_temp.r1857_v('dA'), 'Asha', '01234567', 'director', 'x@example.in'));
select pg_temp.r1857_as('04');
insert into r1857_res select 'cross', pg_temp.r1857_err(format('select public.save_company_director(%L, %L, %L, null, %L, null, null, null, null, %L, null)', pg_temp.r1857_v('dA'), 'Hijack', '01234567', 'director', 'x@example.in'));
select pg_temp.r1857_as('01');
insert into r1857_res select 'din7', pg_temp.r1857_err($q$select public.save_company_director(null, 'C One', '1234567', null, 'director', null, null, null, null, null, null)$q$);
do $$ begin
  if pg_temp.r1857_v('sales') not like '42501:%' then raise exception 'FAIL 6a sales: %', pg_temp.r1857_v('sales'); end if;
  if pg_temp.r1857_v('cross') not like '%not in your company%' then raise exception 'FAIL 6b cross: %', pg_temp.r1857_v('cross'); end if;
  if pg_temp.r1857_v('din7')  not like '%DIN must be 8 digits%' then raise exception 'FAIL 6c din7: %', pg_temp.r1857_v('din7'); end if;
  if (select email from public.company_directors where id = pg_temp.r1857_v('dA')::uuid) <> 'asha.verma@example.in' then
    raise exception 'FAIL 6d a refused save changed the row';
  end if;
end $$;

-- 7. no direct update of the column
select pg_temp.r1857_as('01');
set local role authenticated;
do $$ begin
  update public.company_directors set kyc_details_changed_on = null;
  raise exception 'FAIL 7 direct update was allowed';
exception when insufficient_privilege then null;
end $$;
reset role;

select 'PASS r1857' as result;

rollback;
