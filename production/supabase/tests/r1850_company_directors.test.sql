-- R-1850 (epic R-1841, Phase 3): directors register for a Pvt Ltd.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1850_company_directors.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1850 migration> <this test> rollback;
-- Expect "PASS r1850".
--
-- Proves:
--   1. the Pvt Ltd owner adds 2 directors (PAN typed in lower case → stored upper, phone spaces
--      removed); an empty business type (= Pvt Ltd) may add one too.
--   2. 7-digit DIN / missing DIN / bad PAN / duplicate DIN / bad designation / ceased before
--      appointed / future KYC year / bad email are refused with a plain message.
--   3. sales is refused (42501); a login with no company is refused (28000); a proprietor and a
--      partnership are refused (no directors register for them).
--   4. the accountant edits director B with a MASKED email / phone → the stored ones are kept;
--      ceasing B is saved. Another company's director id is not reachable (edit / delete).
--   5. RLS: the company's accountant reads 2 directors, sales reads none, another company reads
--      only its own; no direct insert for authenticated.
--   6. delete works for a director added by mistake.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1850000-0000-4000-8000-0000000000' || k)::uuid, 'r1850-' || k || '@example.test'
  from unnest(array['01','02','03','04','05','06','07']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, business_type) values
  ('e1850000-0000-0000-0000-0000000000f1', 'R1850 PvtLtd', 'r1850a@example.in', '07', 'Delhi', 'R street, Delhi', 'R50A', '07AAACR1850R1Z1', 'registered', 'pvt_ltd'),
  ('e1850000-0000-0000-0000-0000000000f2', 'R1850 Empty',  'r1850b@example.in', '07', 'Delhi', 'R street, Delhi', 'R50B', '07AAACR1850R1Z2', 'registered', null),
  ('e1850000-0000-0000-0000-0000000000f3', 'R1850 Prop',   'r1850c@example.in', '07', 'Delhi', 'R street, Delhi', 'R50C', '07AAACR1850R1Z3', 'registered', 'proprietor'),
  ('e1850000-0000-0000-0000-0000000000f4', 'R1850 Firm',   'r1850d@example.in', '07', 'Delhi', 'R street, Delhi', 'R50D', '07AAACR1850R1Z4', 'registered', 'partnership');

-- 06 has an auth login but no users row → no company
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1850000-0000-4000-8000-000000000001', 'e1850000-0000-0000-0000-0000000000f1', 'r1850-01@example.in', 'Pvt owner',  'owner', true),
  ('e1850000-0000-4000-8000-000000000002', 'e1850000-0000-0000-0000-0000000000f1', 'r1850-02@example.in', 'Pvt acct',   'accountant', true),
  ('e1850000-0000-4000-8000-000000000003', 'e1850000-0000-0000-0000-0000000000f1', 'r1850-03@example.in', 'Pvt sales',  'sales', true),
  ('e1850000-0000-4000-8000-000000000004', 'e1850000-0000-0000-0000-0000000000f2', 'r1850-04@example.in', 'Empty mgr',  'manager', true),
  ('e1850000-0000-4000-8000-000000000005', 'e1850000-0000-0000-0000-0000000000f3', 'r1850-05@example.in', 'Prop owner', 'owner', true),
  ('e1850000-0000-4000-8000-000000000007', 'e1850000-0000-0000-0000-0000000000f4', 'r1850-07@example.in', 'Firm owner', 'owner', true);

create temp table r1850_res (k text primary key, v text);
grant all on r1850_res to authenticated, service_role;

create function pg_temp.r1850_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1850000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1850_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r1850_v(p_k text) returns text language sql as $$ select v from r1850_res where k = p_k $$;

-- 1. owner adds A (MD) and B (director)
select pg_temp.r1850_as('01');
insert into r1850_res select 'dA', public.save_company_director(null, 'Asha Verma', '01234567', 'abcpv1234k', 'managing_director', '2024-04-01', null, '2027-03-31', 2025, 'asha@example.in', '98100 12345')::text;
insert into r1850_res select 'dB', public.save_company_director(null, 'Bimal Rao', '07654321', null, 'director', '2024-04-01', null, '2026-11-14', null, 'bimal@example.in', '9811122233')::text;

-- 2. refusals
insert into r1850_res select 'din7',   pg_temp.r1850_err($q$select public.save_company_director(null, 'C One', '1234567', null, 'director', null, null, null, null, null, null)$q$);
insert into r1850_res select 'nodin',  pg_temp.r1850_err($q$select public.save_company_director(null, 'C Two', ' ', null, 'director', null, null, null, null, null, null)$q$);
insert into r1850_res select 'badpan', pg_temp.r1850_err($q$select public.save_company_director(null, 'C Three', '11112222', 'ABC123', 'director', null, null, null, null, null, null)$q$);
insert into r1850_res select 'dupdin', pg_temp.r1850_err($q$select public.save_company_director(null, 'C Four', '01234567', null, 'director', null, null, null, null, null, null)$q$);
insert into r1850_res select 'desig',  pg_temp.r1850_err($q$select public.save_company_director(null, 'C Five', '11113333', null, 'chairman', null, null, null, null, null, null)$q$);
insert into r1850_res select 'dates',  pg_temp.r1850_err($q$select public.save_company_director(null, 'C Six', '11114444', null, 'director', '2026-04-01', '2026-03-01', null, null, null, null)$q$);
insert into r1850_res select 'kyc',    pg_temp.r1850_err($q$select public.save_company_director(null, 'C Seven', '11115555', null, 'director', null, null, null, 2099, null, null)$q$);
insert into r1850_res select 'email',  pg_temp.r1850_err($q$select public.save_company_director(null, 'C Eight', '11116666', null, 'director', null, null, null, null, 'not-an-email', null)$q$);
insert into r1850_res select 'noname', pg_temp.r1850_err($q$select public.save_company_director(null, '  ', '11117777', null, 'director', null, null, null, null, null, null)$q$);

-- 3. who may write
select pg_temp.r1850_as('03');
insert into r1850_res select 'sales',     pg_temp.r1850_err($q$select public.save_company_director(null, 'S', '22223333', null, 'director', null, null, null, null, null, null)$q$);
insert into r1850_res select 'sales_del', pg_temp.r1850_err(format('select public.delete_company_director(%L)', pg_temp.r1850_v('dB')));
select pg_temp.r1850_as('06');
insert into r1850_res select 'nocompany', pg_temp.r1850_err($q$select public.save_company_director(null, 'N', '22224444', null, 'director', null, null, null, null, null, null)$q$);
insert into r1850_res select 'nocompany_del', pg_temp.r1850_err(format('select public.delete_company_director(%L)', pg_temp.r1850_v('dB')));
select pg_temp.r1850_as('05');
insert into r1850_res select 'prop', pg_temp.r1850_err($q$select public.save_company_director(null, 'P', '22225555', null, 'director', null, null, null, null, null, null)$q$);
select pg_temp.r1850_as('07');
insert into r1850_res select 'firm', pg_temp.r1850_err($q$select public.save_company_director(null, 'F', '22226666', null, 'director', null, null, null, null, null, null)$q$);

-- empty business type = Pvt Ltd: the manager adds one director (same DIN as A is fine in another company)
select pg_temp.r1850_as('04');
insert into r1850_res select 'dE', public.save_company_director(null, 'Esha Kapoor', '01234567', null, 'additional_director', null, null, null, null, null, null)::text;
insert into r1850_res select 'cross_edit', pg_temp.r1850_err(format('select public.save_company_director(%L, %L, %L, null, %L, null, null, null, null, null, null)', pg_temp.r1850_v('dB'), 'Hijack', '07654321', 'director'));
insert into r1850_res select 'cross_del',  pg_temp.r1850_err(format('select public.delete_company_director(%L)', pg_temp.r1850_v('dB')));

-- 4. accountant edits B with the MASKED email / phone the gateway showed them, and ceases B
select pg_temp.r1850_as('02');
select public.save_company_director(pg_temp.r1850_v('dB')::uuid, 'Bimal Rao', '07654321', 'BCDPR2345L', 'whole_time_director', '2024-04-01', '2026-09-30', '2026-11-14', 2025, 'bi••••@example.in', '••••••2233');

do $$
declare v_a public.company_directors; v_b public.company_directors;
begin
  select * into v_a from public.company_directors where id = pg_temp.r1850_v('dA')::uuid;
  select * into v_b from public.company_directors where id = pg_temp.r1850_v('dB')::uuid;
  if v_a.pan <> 'ABCPV1234K' or v_a.phone <> '9810012345' or v_a.designation <> 'managing_director' or v_a.last_kyc_year <> 2025
     or v_a.tenant_id <> 'e1850000-0000-0000-0000-0000000000f1' then
    raise exception 'FAIL 1a director A %', row_to_json(v_a);
  end if;
  if v_b.email <> 'bimal@example.in' or v_b.phone <> '9811122233' then raise exception 'FAIL 4a masked contact overwrote the real one %', row_to_json(v_b); end if;
  if v_b.ceased_on <> '2026-09-30' or v_b.pan <> 'BCDPR2345L' or v_b.designation <> 'whole_time_director' then raise exception 'FAIL 4b edit B %', row_to_json(v_b); end if;
  if (select tenant_id from public.company_directors where id = pg_temp.r1850_v('dE')::uuid) <> 'e1850000-0000-0000-0000-0000000000f2' then raise exception 'FAIL 1b empty type'; end if;

  if pg_temp.r1850_v('din7')   not like '%DIN must be 8 digits%'     then raise exception 'FAIL 2a din7: %', pg_temp.r1850_v('din7'); end if;
  if pg_temp.r1850_v('nodin')  not like '%Enter the director''s DIN%' then raise exception 'FAIL 2b nodin: %', pg_temp.r1850_v('nodin'); end if;
  if pg_temp.r1850_v('badpan') not like '%PAN must be%'              then raise exception 'FAIL 2c pan: %', pg_temp.r1850_v('badpan'); end if;
  if pg_temp.r1850_v('dupdin') not like '%already in the directors%' then raise exception 'FAIL 2d dup: %', pg_temp.r1850_v('dupdin'); end if;
  if pg_temp.r1850_v('desig')  not like '%Pick a designation%'       then raise exception 'FAIL 2e desig: %', pg_temp.r1850_v('desig'); end if;
  if pg_temp.r1850_v('dates')  not like '%cessation date%'           then raise exception 'FAIL 2f dates: %', pg_temp.r1850_v('dates'); end if;
  if pg_temp.r1850_v('kyc')    not like '%KYC year%'                 then raise exception 'FAIL 2g kyc: %', pg_temp.r1850_v('kyc'); end if;
  if pg_temp.r1850_v('email')  not like '%valid email%'              then raise exception 'FAIL 2h email: %', pg_temp.r1850_v('email'); end if;
  if pg_temp.r1850_v('noname') not like '%director''s name%'         then raise exception 'FAIL 2i name: %', pg_temp.r1850_v('noname'); end if;

  if pg_temp.r1850_v('sales')         not like '42501:%'  then raise exception 'FAIL 3a sales: %', pg_temp.r1850_v('sales'); end if;
  if pg_temp.r1850_v('sales_del')     not like '42501:%'  then raise exception 'FAIL 3b sales del: %', pg_temp.r1850_v('sales_del'); end if;
  if pg_temp.r1850_v('nocompany')     not like '28000:%'  then raise exception 'FAIL 3c no company: %', pg_temp.r1850_v('nocompany'); end if;
  if pg_temp.r1850_v('nocompany_del') not like '28000:%'  then raise exception 'FAIL 3d no company del: %', pg_temp.r1850_v('nocompany_del'); end if;
  if pg_temp.r1850_v('prop') not like '%for a Pvt Ltd%' then raise exception 'FAIL 3e prop: %', pg_temp.r1850_v('prop'); end if;
  if pg_temp.r1850_v('firm') not like '%for a Pvt Ltd%' then raise exception 'FAIL 3f firm: %', pg_temp.r1850_v('firm'); end if;
  if pg_temp.r1850_v('cross_edit') not like '%not in your company%' then raise exception 'FAIL 4c cross edit: %', pg_temp.r1850_v('cross_edit'); end if;
  if pg_temp.r1850_v('cross_del')  not like '%not in your company%' then raise exception 'FAIL 4d cross del: %', pg_temp.r1850_v('cross_del'); end if;
  if (select count(*) from public.company_directors where tenant_id = 'e1850000-0000-0000-0000-0000000000f1') <> 2 then raise exception 'FAIL 2z refused rows were saved'; end if;
end $$;

-- 5. RLS
select pg_temp.r1850_as('02');
set local role authenticated;
do $$ begin
  if (select count(*) from public.company_directors) <> 2 then raise exception 'FAIL 5a accountant sees % directors', (select count(*) from public.company_directors); end if;
end $$;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1850000-0000-4000-8000-000000000003')::text, true);
do $$ begin
  if (select count(*) from public.company_directors) <> 0 then raise exception 'FAIL 5b sales sees directors'; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1850000-0000-4000-8000-000000000004')::text, true);
do $$ begin
  if (select count(*) from public.company_directors) <> 1 then raise exception 'FAIL 5c other company sees % directors', (select count(*) from public.company_directors); end if;
end $$;
-- no direct writes, only through the functions
do $$ begin
  insert into public.company_directors (tenant_id, name, din) values ('e1850000-0000-0000-0000-0000000000f2', 'X', '99998888');
  raise exception 'FAIL 5d direct insert was allowed';
exception when insufficient_privilege then null;
end $$;
reset role;

-- 6. delete a director added by mistake
select pg_temp.r1850_as('04');
select public.delete_company_director(pg_temp.r1850_v('dE')::uuid);
do $$ begin
  if exists (select 1 from public.company_directors where id = pg_temp.r1850_v('dE')::uuid) then raise exception 'FAIL 6 delete'; end if;
end $$;

select 'PASS r1850' as result;

rollback;
