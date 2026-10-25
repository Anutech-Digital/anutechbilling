-- R-1847 (epic R-1841, Phase 2): partners register for a partnership firm / LLP.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1847_firm_partners.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1847 migration> <this test> rollback;
-- Expect "PASS r1847". Needs R-1839 (owner_equity_movements) applied first.
--
-- Proves:
--   0. a drawings entry with a free-text partner name, recorded before the register exists,
--      stays exactly as it was (partner_id null, name unchanged) — no stored data changes.
--   1. the firm's owner adds partners A 60% (PAN typed in lower case → stored upper) and B 40%.
--   2. bad PAN / bad DPIN / share above 100 / duplicate name / left before joining are refused
--      with a plain message, and nothing is saved.
--   3. sales is refused (42501); a login with no company is refused (28000); a Pvt Ltd company
--      and a proprietor are refused (no partners register for them).
--   4. the accountant edits B; another company's partner id is not reachable.
--   5. RLS: the firm's accountant reads 2 partners, sales reads none, the LLP reads only its own.
--   6. a new drawings entry naming a registered partner gets that partner's id (any case);
--      a name that is not in the register is refused once the register has partners.
--   7. the old free-text entry is linked to A on request — its stored name is kept.
--   8. a partner with entries cannot be deleted (set a leaving date instead); one without can.
--   9. drawings dated after the partner left are refused.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1847000-0000-4000-8000-0000000000' || k)::uuid, 'r1847-' || k || '@example.test'
  from unnest(array['01','02','03','04','05','06','07']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, business_type) values
  ('e1847000-0000-0000-0000-0000000000f1', 'R1847 Firm',   'r1847a@example.in', '07', 'Delhi', 'R street, Delhi', 'R47A', '07AAACR1847R1Z1', 'registered', 'partnership'),
  ('e1847000-0000-0000-0000-0000000000f2', 'R1847 LLP',    'r1847b@example.in', '07', 'Delhi', 'R street, Delhi', 'R47B', '07AAACR1847R1Z2', 'registered', 'llp'),
  ('e1847000-0000-0000-0000-0000000000f3', 'R1847 PvtLtd', 'r1847c@example.in', '07', 'Delhi', 'R street, Delhi', 'R47C', '07AAACR1847R1Z3', 'registered', 'pvt_ltd'),
  ('e1847000-0000-0000-0000-0000000000f4', 'R1847 Prop',   'r1847d@example.in', '07', 'Delhi', 'R street, Delhi', 'R47D', '07AAACR1847R1Z4', 'registered', 'proprietor');

-- 06 has an auth login but no users row → no company
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1847000-0000-4000-8000-000000000001', 'e1847000-0000-0000-0000-0000000000f1', 'r1847-01@example.in', 'Firm owner', 'owner', true),
  ('e1847000-0000-4000-8000-000000000002', 'e1847000-0000-0000-0000-0000000000f1', 'r1847-02@example.in', 'Firm acct',  'accountant', true),
  ('e1847000-0000-4000-8000-000000000003', 'e1847000-0000-0000-0000-0000000000f1', 'r1847-03@example.in', 'Firm sales', 'sales', true),
  ('e1847000-0000-4000-8000-000000000004', 'e1847000-0000-0000-0000-0000000000f2', 'r1847-04@example.in', 'LLP owner',  'owner', true),
  ('e1847000-0000-4000-8000-000000000005', 'e1847000-0000-0000-0000-0000000000f3', 'r1847-05@example.in', 'Pvt owner',  'owner', true),
  ('e1847000-0000-4000-8000-000000000007', 'e1847000-0000-0000-0000-0000000000f4', 'r1847-07@example.in', 'Prop owner', 'owner', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('e1847000-0000-4000-8000-0000000000a1', 'e1847000-0000-0000-0000-0000000000f1', 'Firm Bank', 'SBI', 'current', 100000, '2026-04-01');

create temp table r1847_res (k text primary key, v text);
grant all on r1847_res to authenticated, service_role;

create function pg_temp.r1847_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1847000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1847_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r1847_v(p_k text) returns text language sql as $$ select v from r1847_res where k = p_k $$;

-- 0. before the register: a free-text partner name (R-1839) is still accepted and kept.
select pg_temp.r1847_as('01');
insert into r1847_res select 'legacy', public.record_owner_equity_movement('drawings', '2026-06-05', 1200, 'e1847000-0000-4000-8000-0000000000a1', 'Asha (old)', 'before register')::text;

-- 1. owner adds A 60% and B 40%
insert into r1847_res select 'pA', public.save_firm_partner(null, 'Asha Verma', 'abcpv1234k', null, false, 60, 100000, '2024-04-01', null, null)::text;
insert into r1847_res select 'pB', public.save_firm_partner(null, 'Bimal Rao', 'BCDPR2345L', null, false, 40, 50000, '2024-04-01', null, null)::text;

-- 2. refusals
insert into r1847_res select 'bad_pan',  pg_temp.r1847_err($q$select public.save_firm_partner(null, 'C One', 'ABC123', null, false, 0, 0, null, null, null)$q$);
insert into r1847_res select 'bad_din',  pg_temp.r1847_err($q$select public.save_firm_partner(null, 'C Two', null, '12AB', false, 0, 0, null, null, null)$q$);
insert into r1847_res select 'big_pct',  pg_temp.r1847_err($q$select public.save_firm_partner(null, 'C Three', null, null, false, 101, 0, null, null, null)$q$);
insert into r1847_res select 'neg_cap',  pg_temp.r1847_err($q$select public.save_firm_partner(null, 'C Four', null, null, false, 0, -5, null, null, null)$q$);
insert into r1847_res select 'dup_name', pg_temp.r1847_err($q$select public.save_firm_partner(null, '  asha verma ', null, null, false, 0, 0, null, null, null)$q$);
insert into r1847_res select 'dup_pan',  pg_temp.r1847_err($q$select public.save_firm_partner(null, 'C Five', 'ABCPV1234K', null, false, 0, 0, null, null, null)$q$);
insert into r1847_res select 'left_bad', pg_temp.r1847_err($q$select public.save_firm_partner(null, 'C Six', null, null, false, 0, 0, '2026-04-01', '2026-03-01', null)$q$);
insert into r1847_res select 'no_name',  pg_temp.r1847_err($q$select public.save_firm_partner(null, '  ', null, null, false, 0, 0, null, null, null)$q$);

-- 3. who may write
select pg_temp.r1847_as('03');
insert into r1847_res select 'sales', pg_temp.r1847_err($q$select public.save_firm_partner(null, 'S', null, null, false, 0, 0, null, null, null)$q$);
insert into r1847_res select 'sales_del', pg_temp.r1847_err(format('select public.delete_firm_partner(%L)', pg_temp.r1847_v('pB')));
insert into r1847_res select 'sales_link', pg_temp.r1847_err(format('select public.link_owner_equity_partner(%L, %L)', pg_temp.r1847_v('legacy'), pg_temp.r1847_v('pA')));
select pg_temp.r1847_as('06');
insert into r1847_res select 'nocompany', pg_temp.r1847_err($q$select public.save_firm_partner(null, 'N', null, null, false, 0, 0, null, null, null)$q$);
select pg_temp.r1847_as('05');
insert into r1847_res select 'pvt', pg_temp.r1847_err($q$select public.save_firm_partner(null, 'D', null, null, false, 0, 0, null, null, null)$q$);
select pg_temp.r1847_as('07');
insert into r1847_res select 'prop', pg_temp.r1847_err($q$select public.save_firm_partner(null, 'P', null, null, false, 0, 0, null, null, null)$q$);

-- LLP adds a designated partner with a DPIN
select pg_temp.r1847_as('04');
insert into r1847_res select 'pL', public.save_firm_partner(null, 'Lata Iyer', 'CDEPI3456M', '01234567', true, 100, 10000, '2025-01-01', null, 'deed 1 Jan 2025')::text;
-- the LLP cannot edit the firm's partner, nor delete or link the firm's rows
insert into r1847_res select 'cross_edit', pg_temp.r1847_err(format('select public.save_firm_partner(%L, %L, null, null, false, 10, 0, null, null, null)', pg_temp.r1847_v('pB'), 'Hijack'));
insert into r1847_res select 'cross_del', pg_temp.r1847_err(format('select public.delete_firm_partner(%L)', pg_temp.r1847_v('pB')));
insert into r1847_res select 'cross_link', pg_temp.r1847_err(format('select public.link_owner_equity_partner(%L, %L)', pg_temp.r1847_v('legacy'), pg_temp.r1847_v('pL')));

-- 4. accountant edits B (share 40 → 35, DPIN ignored for a firm is still validated)
select pg_temp.r1847_as('02');
select public.save_firm_partner(pg_temp.r1847_v('pB')::uuid, 'Bimal Rao', 'BCDPR2345L', null, false, 35, 50000, '2024-04-01', null, 'share cut');

do $$
declare v_a public.firm_partners; v_b public.firm_partners;
begin
  select * into v_a from public.firm_partners where id = pg_temp.r1847_v('pA')::uuid;
  select * into v_b from public.firm_partners where id = pg_temp.r1847_v('pB')::uuid;
  if v_a.pan <> 'ABCPV1234K' or v_a.profit_share_pct <> 60 or v_a.capital_contribution <> 100000 or v_a.tenant_id <> 'e1847000-0000-0000-0000-0000000000f1' then
    raise exception 'FAIL 1a partner A %', row_to_json(v_a);
  end if;
  if v_b.profit_share_pct <> 35 or v_b.note <> 'share cut' or v_b.name <> 'Bimal Rao' then raise exception 'FAIL 4a edit B %', row_to_json(v_b); end if;
  if pg_temp.r1847_v('bad_pan')  not like '%PAN%'           then raise exception 'FAIL 2a pan: %', pg_temp.r1847_v('bad_pan'); end if;
  if pg_temp.r1847_v('bad_din')  not like '%8 digits%'      then raise exception 'FAIL 2b din: %', pg_temp.r1847_v('bad_din'); end if;
  if pg_temp.r1847_v('big_pct')  not like '%0 and 100%'     then raise exception 'FAIL 2c pct: %', pg_temp.r1847_v('big_pct'); end if;
  if pg_temp.r1847_v('neg_cap')  not like '%capital%'       then raise exception 'FAIL 2d cap: %', pg_temp.r1847_v('neg_cap'); end if;
  if pg_temp.r1847_v('dup_name') not like '%already%'       then raise exception 'FAIL 2e dup name: %', pg_temp.r1847_v('dup_name'); end if;
  if pg_temp.r1847_v('dup_pan')  not like '%PAN%already%'   then raise exception 'FAIL 2f dup pan: %', pg_temp.r1847_v('dup_pan'); end if;
  if pg_temp.r1847_v('left_bad') not like '%leaving date%'  then raise exception 'FAIL 2g left: %', pg_temp.r1847_v('left_bad'); end if;
  if pg_temp.r1847_v('no_name')  not like '%name%'          then raise exception 'FAIL 2h name: %', pg_temp.r1847_v('no_name'); end if;
  if pg_temp.r1847_v('sales')      not like '42501:%' then raise exception 'FAIL 3a sales: %', pg_temp.r1847_v('sales'); end if;
  if pg_temp.r1847_v('sales_del')  not like '42501:%' then raise exception 'FAIL 3b sales delete: %', pg_temp.r1847_v('sales_del'); end if;
  if pg_temp.r1847_v('sales_link') not like '42501:%' then raise exception 'FAIL 3c sales link: %', pg_temp.r1847_v('sales_link'); end if;
  if pg_temp.r1847_v('nocompany')  not like '28000:%' then raise exception 'FAIL 3d no company: %', pg_temp.r1847_v('nocompany'); end if;
  if pg_temp.r1847_v('pvt')  not like '%Partnership or LLP%' then raise exception 'FAIL 3e pvt: %', pg_temp.r1847_v('pvt'); end if;
  if pg_temp.r1847_v('prop') not like '%Partnership or LLP%' then raise exception 'FAIL 3f prop: %', pg_temp.r1847_v('prop'); end if;
  if pg_temp.r1847_v('cross_edit') not like '%not in your company%' then raise exception 'FAIL 4b cross edit: %', pg_temp.r1847_v('cross_edit'); end if;
  if pg_temp.r1847_v('cross_del')  not like '%not in your company%' then raise exception 'FAIL 4c cross delete: %', pg_temp.r1847_v('cross_del'); end if;
  if pg_temp.r1847_v('cross_link') not like '%not in your company%' then raise exception 'FAIL 4d cross link: %', pg_temp.r1847_v('cross_link'); end if;
  if (select count(*) from public.firm_partners where tenant_id = 'e1847000-0000-0000-0000-0000000000f1') <> 2 then raise exception 'FAIL 2i a refused call saved something'; end if;
  if (select count(*) from public.firm_partners where tenant_id in ('e1847000-0000-0000-0000-0000000000f3', 'e1847000-0000-0000-0000-0000000000f4')) <> 0 then raise exception 'FAIL 3g pvt/prop saved'; end if;
  if (select is_designated::text || din_dpin from public.firm_partners where id = pg_temp.r1847_v('pL')::uuid) <> 'true01234567' then raise exception 'FAIL 3h LLP partner'; end if;
end $$;

-- 0 (cont.) the free-text entry is untouched by the migration and by adding partners
do $$ begin
  if (select coalesce(partner_id::text, 'null') || '|' || partner_name from public.owner_equity_movements where id = pg_temp.r1847_v('legacy')::uuid) <> 'null|Asha (old)' then
    raise exception 'FAIL 0 legacy entry changed';
  end if;
end $$;

-- 5. RLS
select pg_temp.r1847_as('02');
set local role authenticated;
do $$ begin
  if (select count(*) from public.firm_partners) <> 2 then raise exception 'FAIL 5a firm accountant sees % partners', (select count(*) from public.firm_partners); end if;
end $$;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1847000-0000-4000-8000-000000000003')::text, true);
do $$ begin
  if (select count(*) from public.firm_partners) <> 0 then raise exception 'FAIL 5b sales sees partners'; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1847000-0000-4000-8000-000000000004')::text, true);
do $$ begin
  if (select count(*) from public.firm_partners) <> 1 then raise exception 'FAIL 5c LLP sees % partners', (select count(*) from public.firm_partners); end if;
end $$;
-- no direct writes, only through the functions
do $$
declare v_state text;
begin
  insert into public.firm_partners (tenant_id, name) values ('e1847000-0000-0000-0000-0000000000f2', 'Direct');
  insert into r1847_res values ('direct_ins', 'OK');
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  insert into r1847_res values ('direct_ins', v_state || ':');
end $$;
reset role;
do $$ begin
  if pg_temp.r1847_v('direct_ins') not like '42501:%' then raise exception 'FAIL 5d direct insert: %', pg_temp.r1847_v('direct_ins'); end if;
end $$;

-- 6. new entries link to the register
select pg_temp.r1847_as('01');
insert into r1847_res select 'mA', public.record_owner_equity_movement('drawings', '2026-10-05', 2000, 'e1847000-0000-4000-8000-0000000000a1', 'asha verma', null)::text;
insert into r1847_res select 'mB', public.record_owner_equity_movement('capital_introduced', '2026-10-06', 9000, 'e1847000-0000-4000-8000-0000000000a1', 'Bimal Rao', null)::text;
insert into r1847_res select 'stranger', pg_temp.r1847_err($q$select public.record_owner_equity_movement('drawings', '2026-10-05', 100, 'e1847000-0000-4000-8000-0000000000a1', 'Somebody Else')$q$);
do $$ begin
  if (select partner_id::text from public.owner_equity_movements where id = pg_temp.r1847_v('mA')::uuid) is distinct from pg_temp.r1847_v('pA') then raise exception 'FAIL 6a A not linked'; end if;
  if (select partner_id::text from public.owner_equity_movements where id = pg_temp.r1847_v('mB')::uuid) is distinct from pg_temp.r1847_v('pB') then raise exception 'FAIL 6b B not linked'; end if;
  if pg_temp.r1847_v('stranger') not like '%register%' then raise exception 'FAIL 6c stranger: %', pg_temp.r1847_v('stranger'); end if;
end $$;

-- 7. link the old free-text entry to A; the stored name stays
select public.link_owner_equity_partner(pg_temp.r1847_v('legacy')::uuid, pg_temp.r1847_v('pA')::uuid);
do $$ begin
  if (select partner_id::text || '|' || partner_name from public.owner_equity_movements where id = pg_temp.r1847_v('legacy')::uuid)
     <> pg_temp.r1847_v('pA') || '|Asha (old)' then raise exception 'FAIL 7 legacy link'; end if;
end $$;

-- 8. delete: refused with entries, allowed without
insert into r1847_res select 'del_used', pg_temp.r1847_err(format('select public.delete_firm_partner(%L)', pg_temp.r1847_v('pA')));
insert into r1847_res select 'pC', public.save_firm_partner(null, 'Chetan', null, null, false, 5, 0, null, null, null)::text;
select public.delete_firm_partner(pg_temp.r1847_v('pC')::uuid);
do $$ begin
  if pg_temp.r1847_v('del_used') not like '%leaving date%' then raise exception 'FAIL 8a delete used: %', pg_temp.r1847_v('del_used'); end if;
  if exists (select 1 from public.firm_partners where id = pg_temp.r1847_v('pC')::uuid) then raise exception 'FAIL 8b unused partner not deleted'; end if;
  if not exists (select 1 from public.firm_partners where id = pg_temp.r1847_v('pA')::uuid) then raise exception 'FAIL 8c used partner deleted'; end if;
end $$;

-- 9. a leaving date before B's own entry (6 Oct) is refused; B leaves on 6 Oct 2026, and
--    drawings dated after that are refused
insert into r1847_res select 'left_early', pg_temp.r1847_err(format('select public.save_firm_partner(%L, %L, null, null, false, 35, 50000, null, %L, null)', pg_temp.r1847_v('pB'), 'Bimal Rao', '2026-09-30'));
select public.save_firm_partner(pg_temp.r1847_v('pB')::uuid, 'Bimal Rao', 'BCDPR2345L', null, false, 35, 50000, '2024-04-01', '2026-10-06', 'retired');
insert into r1847_res select 'after_left', pg_temp.r1847_err($q$select public.record_owner_equity_movement('drawings', '2026-10-07', 100, 'e1847000-0000-4000-8000-0000000000a1', 'Bimal Rao')$q$);
do $$ begin
  if pg_temp.r1847_v('left_early') not like '%entries after%' then raise exception 'FAIL 9a left early: %', pg_temp.r1847_v('left_early'); end if;
  if pg_temp.r1847_v('after_left') not like '%left the firm%' then raise exception 'FAIL 9b after left: %', pg_temp.r1847_v('after_left'); end if;
end $$;

select 'PASS r1847' as result;

rollback;
