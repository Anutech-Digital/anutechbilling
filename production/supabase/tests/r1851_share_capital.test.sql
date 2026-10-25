-- R-1851 (epic R-1841, Phase 3): share capital + shareholders register for a Pvt Ltd.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1851_share_capital.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1851 migration> <this test> rollback;
-- Expect "PASS r1851".
--
-- Proves (card example):
--   1. a shareholder before the capital is set is refused ("Set the authorised capital…").
--   2. owner sets authorised ₹10,00,000, face value ₹10; adds A 50,000 + B 50,000 shares →
--      paid-up = 1,00,000 × ₹10 = ₹10,00,000 (= authorised).
--   3. one more share / C with 10,000 / A edited to 60,000 is refused (more than authorised);
--      lowering authorised to ₹5,00,000 is refused; PAN format / duplicate PAN refused.
--   4. accountant raises authorised to ₹15L and edits A to 60,000 (edit counts new, not old+new).
--   5. sales refused (42501), no company refused (28000), proprietor refused; another company's
--      shareholder not reachable (edit / delete).
--   6. RLS: accountant reads 2 holders + the capital row; sales reads none; the other company only
--      its own; no direct insert.
--   7. an existing hand-entered Share capital line (balance_sheet_items) is untouched.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1851000-0000-4000-8000-0000000000' || k)::uuid, 'r1851-' || k || '@example.test'
  from unnest(array['01','02','03','04','05','06']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, business_type) values
  ('e1851000-0000-0000-0000-0000000000f1', 'R1851 PvtLtd', 'r1851a@example.in', '07', 'Delhi', 'R street, Delhi', 'R51A', '07AAACR1851R1Z1', 'registered', 'pvt_ltd'),
  ('e1851000-0000-0000-0000-0000000000f2', 'R1851 Empty',  'r1851b@example.in', '07', 'Delhi', 'R street, Delhi', 'R51B', '07AAACR1851R1Z2', 'registered', null),
  ('e1851000-0000-0000-0000-0000000000f3', 'R1851 Prop',   'r1851c@example.in', '07', 'Delhi', 'R street, Delhi', 'R51C', '07AAACR1851R1Z3', 'registered', 'proprietor');

-- 06 has an auth login but no users row → no company
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1851000-0000-4000-8000-000000000001', 'e1851000-0000-0000-0000-0000000000f1', 'r1851-01@example.in', 'Pvt owner',  'owner', true),
  ('e1851000-0000-4000-8000-000000000002', 'e1851000-0000-0000-0000-0000000000f1', 'r1851-02@example.in', 'Pvt acct',   'accountant', true),
  ('e1851000-0000-4000-8000-000000000003', 'e1851000-0000-0000-0000-0000000000f1', 'r1851-03@example.in', 'Pvt sales',  'sales', true),
  ('e1851000-0000-4000-8000-000000000004', 'e1851000-0000-0000-0000-0000000000f2', 'r1851-04@example.in', 'Empty owner','owner', true),
  ('e1851000-0000-4000-8000-000000000005', 'e1851000-0000-0000-0000-0000000000f3', 'r1851-05@example.in', 'Prop owner', 'owner', true);

-- a hand-entered Share capital line from before the register
insert into public.balance_sheet_items (tenant_id, section, label, amount)
values ('e1851000-0000-0000-0000-0000000000f1', 'equity', 'Share capital', 100000);

create temp table r1851_res (k text primary key, v text);
grant all on r1851_res to authenticated, service_role;

create function pg_temp.r1851_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1851000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1851_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r1851_v(p_k text) returns text language sql as $$ select v from r1851_res where k = p_k $$;

select pg_temp.r1851_as('01');
-- 1. no capital yet
insert into r1851_res select 'nocap', pg_temp.r1851_err($q$select public.save_shareholder(null, 'Asha', null, 10, null)$q$);
-- 2. card example
select public.save_share_capital(1000000, 10);
insert into r1851_res select 'hA', public.save_shareholder(null, 'Asha Verma', 'abcpv1234k', 50000, '2024-04-01')::text;
insert into r1851_res select 'hB', public.save_shareholder(null, 'Bimal Rao', null, 50000, '2024-04-01')::text;
-- 3. refusals
insert into r1851_res select 'one_more', pg_temp.r1851_err($q$select public.save_shareholder(null, 'C', null, 1, null)$q$);
insert into r1851_res select 'c10k',     pg_temp.r1851_err($q$select public.save_shareholder(null, 'C', null, 10000, null)$q$);
insert into r1851_res select 'a60k',     pg_temp.r1851_err(format('select public.save_shareholder(%L, %L, %L, 60000, null)', pg_temp.r1851_v('hA'), 'Asha Verma', 'ABCPV1234K'));
insert into r1851_res select 'lower',    pg_temp.r1851_err($q$select public.save_share_capital(500000, 10)$q$);
insert into r1851_res select 'zero_fv',  pg_temp.r1851_err($q$select public.save_share_capital(1000000, 0)$q$);
insert into r1851_res select 'badpan',   pg_temp.r1851_err($q$select public.save_shareholder(null, 'D', 'ABC', 1, null)$q$);
insert into r1851_res select 'duppan',   pg_temp.r1851_err($q$select public.save_shareholder(null, 'D', 'ABCPV1234K', 1, null)$q$);
insert into r1851_res select 'noshares', pg_temp.r1851_err($q$select public.save_shareholder(null, 'D', null, 0, null)$q$);
do $$
declare v_paid bigint;
begin
  select sum(h.shares) * c.face_value into v_paid
    from public.company_shareholders h join public.company_share_capital c on c.tenant_id = h.tenant_id
   where h.tenant_id = 'e1851000-0000-0000-0000-0000000000f1' group by c.face_value;
  if v_paid <> 1000000 then raise exception 'FAIL 2 paid-up %', v_paid; end if;
  if (select pan from public.company_shareholders where id = pg_temp.r1851_v('hA')::uuid) <> 'ABCPV1234K' then raise exception 'FAIL 2b pan upper'; end if;
  if pg_temp.r1851_v('nocap')    not like '%Set the authorised capital%'   then raise exception 'FAIL 1 nocap: %', pg_temp.r1851_v('nocap'); end if;
  if pg_temp.r1851_v('one_more') not like '%more than the authorised%'     then raise exception 'FAIL 3a: %', pg_temp.r1851_v('one_more'); end if;
  if pg_temp.r1851_v('c10k')     not like '%1,10,000%' and pg_temp.r1851_v('c10k') not like '%110000 shares%' then raise exception 'FAIL 3b: %', pg_temp.r1851_v('c10k'); end if;
  if pg_temp.r1851_v('a60k')     not like '%more than the authorised%'     then raise exception 'FAIL 3c: %', pg_temp.r1851_v('a60k'); end if;
  if pg_temp.r1851_v('lower')    not like '%cannot be less%'               then raise exception 'FAIL 3d: %', pg_temp.r1851_v('lower'); end if;
  if pg_temp.r1851_v('zero_fv')  not like '%face value%'                   then raise exception 'FAIL 3e: %', pg_temp.r1851_v('zero_fv'); end if;
  if pg_temp.r1851_v('badpan')   not like '%PAN must be%'                  then raise exception 'FAIL 3f: %', pg_temp.r1851_v('badpan'); end if;
  if pg_temp.r1851_v('duppan')   not like '%already used%'                 then raise exception 'FAIL 3g: %', pg_temp.r1851_v('duppan'); end if;
  if pg_temp.r1851_v('noshares') not like '%number of shares%'             then raise exception 'FAIL 3h: %', pg_temp.r1851_v('noshares'); end if;
  if (select count(*) from public.company_shareholders where tenant_id = 'e1851000-0000-0000-0000-0000000000f1') <> 2 then raise exception 'FAIL 3z refused rows saved'; end if;
end $$;

-- 4. accountant raises authorised and edits A
select pg_temp.r1851_as('02');
select public.save_share_capital(1500000, 10);
select public.save_shareholder(pg_temp.r1851_v('hA')::uuid, 'Asha Verma', 'ABCPV1234K', 60000, '2024-04-01');
do $$ begin
  if (select shares from public.company_shareholders where id = pg_temp.r1851_v('hA')::uuid) <> 60000 then raise exception 'FAIL 4 edit'; end if;
  if (select authorised_capital from public.company_share_capital where tenant_id = 'e1851000-0000-0000-0000-0000000000f1') <> 1500000 then raise exception 'FAIL 4 authorised'; end if;
end $$;

-- 5. who may write
select pg_temp.r1851_as('03');
insert into r1851_res select 'sales',     pg_temp.r1851_err($q$select public.save_share_capital(100, 1)$q$);
insert into r1851_res select 'sales_sh',  pg_temp.r1851_err($q$select public.save_shareholder(null, 'S', null, 1, null)$q$);
insert into r1851_res select 'sales_del', pg_temp.r1851_err(format('select public.delete_shareholder(%L)', pg_temp.r1851_v('hB')));
select pg_temp.r1851_as('06');
insert into r1851_res select 'nocompany',     pg_temp.r1851_err($q$select public.save_share_capital(100, 1)$q$);
insert into r1851_res select 'nocompany_sh',  pg_temp.r1851_err($q$select public.save_shareholder(null, 'N', null, 1, null)$q$);
insert into r1851_res select 'nocompany_del', pg_temp.r1851_err(format('select public.delete_shareholder(%L)', pg_temp.r1851_v('hB')));
select pg_temp.r1851_as('05');
insert into r1851_res select 'prop', pg_temp.r1851_err($q$select public.save_share_capital(100, 1)$q$);
-- empty type = Pvt Ltd: allowed, and cannot reach the other company's holder
select pg_temp.r1851_as('04');
select public.save_share_capital(100000, 10);
insert into r1851_res select 'hE', public.save_shareholder(null, 'Esha', null, 10000, null)::text;
insert into r1851_res select 'cross_edit', pg_temp.r1851_err(format('select public.save_shareholder(%L, %L, null, 1, null)', pg_temp.r1851_v('hB'), 'Hijack'));
insert into r1851_res select 'cross_del',  pg_temp.r1851_err(format('select public.delete_shareholder(%L)', pg_temp.r1851_v('hB')));
do $$ begin
  if pg_temp.r1851_v('sales')         not like '42501:%' then raise exception 'FAIL 5a: %', pg_temp.r1851_v('sales'); end if;
  if pg_temp.r1851_v('sales_sh')      not like '42501:%' then raise exception 'FAIL 5b: %', pg_temp.r1851_v('sales_sh'); end if;
  if pg_temp.r1851_v('sales_del')     not like '42501:%' then raise exception 'FAIL 5c: %', pg_temp.r1851_v('sales_del'); end if;
  if pg_temp.r1851_v('nocompany')     not like '28000:%' then raise exception 'FAIL 5d: %', pg_temp.r1851_v('nocompany'); end if;
  if pg_temp.r1851_v('nocompany_sh')  not like '28000:%' then raise exception 'FAIL 5e: %', pg_temp.r1851_v('nocompany_sh'); end if;
  if pg_temp.r1851_v('nocompany_del') not like '28000:%' then raise exception 'FAIL 5f: %', pg_temp.r1851_v('nocompany_del'); end if;
  if pg_temp.r1851_v('prop') not like '%for a Pvt Ltd%' then raise exception 'FAIL 5g: %', pg_temp.r1851_v('prop'); end if;
  if pg_temp.r1851_v('cross_edit') not like '%not in your company%' then raise exception 'FAIL 5h: %', pg_temp.r1851_v('cross_edit'); end if;
  if pg_temp.r1851_v('cross_del')  not like '%not in your company%' then raise exception 'FAIL 5i: %', pg_temp.r1851_v('cross_del'); end if;
  if (select name from public.company_shareholders where id = pg_temp.r1851_v('hB')::uuid) <> 'Bimal Rao' then raise exception 'FAIL 5j B changed'; end if;
end $$;

-- 6. RLS
select pg_temp.r1851_as('02');
set local role authenticated;
do $$ begin
  if (select count(*) from public.company_shareholders) <> 2 then raise exception 'FAIL 6a accountant sees % holders', (select count(*) from public.company_shareholders); end if;
  if (select count(*) from public.company_share_capital) <> 1 then raise exception 'FAIL 6b capital rows'; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1851000-0000-4000-8000-000000000003')::text, true);
do $$ begin
  if (select count(*) from public.company_shareholders) <> 0 or (select count(*) from public.company_share_capital) <> 0 then raise exception 'FAIL 6c sales sees rows'; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1851000-0000-4000-8000-000000000004')::text, true);
do $$ begin
  if (select count(*) from public.company_shareholders) <> 1 then raise exception 'FAIL 6d other company sees %', (select count(*) from public.company_shareholders); end if;
end $$;
do $$ begin
  insert into public.company_shareholders (tenant_id, name, shares) values ('e1851000-0000-0000-0000-0000000000f2', 'X', 1);
  raise exception 'FAIL 6e direct insert was allowed';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  insert into public.company_share_capital (tenant_id, authorised_capital, face_value) values ('e1851000-0000-0000-0000-0000000000f2', 1, 1);
  raise exception 'FAIL 6f direct insert was allowed';
exception when insufficient_privilege then null;
end $$;
reset role;

-- 7. the hand-entered line is untouched; delete works
do $$ begin
  if (select count(*) from public.balance_sheet_items where tenant_id = 'e1851000-0000-0000-0000-0000000000f1' and label = 'Share capital' and amount = 100000) <> 1 then
    raise exception 'FAIL 7 manual line changed';
  end if;
end $$;
select pg_temp.r1851_as('04');
select public.delete_shareholder(pg_temp.r1851_v('hE')::uuid);
do $$ begin
  if exists (select 1 from public.company_shareholders where id = pg_temp.r1851_v('hE')::uuid) then raise exception 'FAIL 7b delete'; end if;
end $$;

select 'PASS r1851' as result;

rollback;
