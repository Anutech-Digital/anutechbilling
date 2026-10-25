-- R-1849 (epic R-1841, Phase 2): the year-end split of a firm's profit among its partners.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1849_partner_appropriation.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1849 migration> <this test> rollback;
-- Expect "PASS r1849". Needs R-1847 (firm_partners) applied first. The test runs on today's
-- date: FY 2025-26 must be over (true from 1 Apr 2026), FY 2026-27 not over until 1 Apr 2027.
--
-- Proves (the numbers are the ones lib/accounting/partner-appropriation.test.ts gets):
--   1. the legal limits: ₹10L book profit → ₹7,80,000; FY 2023-24 slab → ₹6,90,000; a loss →
--      ₹3,00,000; 194T: ₹20,000 → 0, ₹20,001 → ₹2,000, none before FY 2025-26.
--   2. the owner posts FY 2025-26: net ₹10,60,000 → interest ₹60,000, remuneration ₹7,80,000
--      (₹9L in the deed, cut), shares ₹1,32,000 / ₹88,000, TDS ₹49,333 / ₹34,667.
--   3. refused, nothing saved: interest 15%, remuneration over the limit, wrong TDS, shares
--      not by ratio, a partner missing, the year not over, posting the same year twice,
--      sales (42501), a login with no company (28000), a Pvt Ltd company.
--   4. RLS: the accountant reads the split, sales reads nothing, the other company nothing.
--   5. Balance Sheet: TDS payable (dues_vendor_tds) goes up by ₹84,000.
--   6. a partner with a posted split cannot be deleted (plain message).
--   7. undo: only the latest year; refused inside locked books; then undone — lines gone,
--      TDS payable back.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1849000-0000-4000-8000-0000000000' || k)::uuid, 'r1849-' || k || '@example.test'
  from unnest(array['01','02','03','04','05','06']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, business_type) values
  ('e1849000-0000-0000-0000-0000000000f1', 'R1849 Firm',   'r1849a@example.in', '07', 'Delhi', 'R street, Delhi', 'R49A', '07AAACR1849R1Z1', 'registered', 'partnership'),
  ('e1849000-0000-0000-0000-0000000000f2', 'R1849 Other',  'r1849b@example.in', '07', 'Delhi', 'R street, Delhi', 'R49B', '07AAACR1849R1Z2', 'registered', 'partnership'),
  ('e1849000-0000-0000-0000-0000000000f3', 'R1849 PvtLtd', 'r1849c@example.in', '07', 'Delhi', 'R street, Delhi', 'R49C', '07AAACR1849R1Z3', 'registered', 'pvt_ltd');

-- 06 has an auth login but no users row → no company
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1849000-0000-4000-8000-000000000001', 'e1849000-0000-0000-0000-0000000000f1', 'r1849-01@example.in', 'Firm owner', 'owner', true),
  ('e1849000-0000-4000-8000-000000000002', 'e1849000-0000-0000-0000-0000000000f1', 'r1849-02@example.in', 'Firm acct',  'accountant', true),
  ('e1849000-0000-4000-8000-000000000003', 'e1849000-0000-0000-0000-0000000000f1', 'r1849-03@example.in', 'Firm sales', 'sales', true),
  ('e1849000-0000-4000-8000-000000000004', 'e1849000-0000-0000-0000-0000000000f2', 'r1849-04@example.in', 'Other owner','owner', true),
  ('e1849000-0000-4000-8000-000000000005', 'e1849000-0000-0000-0000-0000000000f3', 'r1849-05@example.in', 'Pvt owner',  'owner', true);

create temp table r1849_res (k text primary key, v text);
grant all on r1849_res to authenticated, service_role;

create function pg_temp.r1849_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1849000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1849_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r1849_v(p_k text) returns text language sql as $$ select v from r1849_res where k = p_k $$;
/* The lines the screen sends: [a, b] for partner ids in r1849_res pA / pB. */
create function pg_temp.r1849_lines(
  a_int bigint, a_ipct numeric, a_rem bigint, a_share bigint, a_tds bigint,
  b_int bigint, b_rem bigint, b_share bigint, b_tds bigint,
  a_cap bigint default 500000, a_days int default 365, a_dpct numeric default 12, b_days int default 365
) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('partner_id', pg_temp.r1849_v('pA'), 'capital_base', a_cap, 'interest_days', a_days,
      'deed_interest_pct', a_dpct, 'interest_pct', a_ipct, 'interest', a_int, 'working', true,
      'deed_remuneration', 500000, 'remuneration', a_rem, 'profit_share', a_share, 'tds', a_tds),
    jsonb_build_object('partner_id', pg_temp.r1849_v('pB'), 'capital_base', 0, 'interest_days', b_days,
      'deed_interest_pct', 12, 'interest_pct', 12, 'interest', b_int, 'working', true,
      'deed_remuneration', 400000, 'remuneration', b_rem, 'profit_share', b_share, 'tds', b_tds))
$$;

-- 1. the legal limits
do $$ begin
  if public.partner_remuneration_limit(2025, 1000000) <> 780000 then raise exception 'FAIL 1a 10L → %', public.partner_remuneration_limit(2025, 1000000); end if;
  if public.partner_remuneration_limit(2026, 1000000) <> 780000 then raise exception 'FAIL 1b 2026'; end if;
  if public.partner_remuneration_limit(2024, 1000000) <> 780000 then raise exception 'FAIL 1c 2024 (AY 2025-26)'; end if;
  if public.partner_remuneration_limit(2023, 1000000) <> 690000 then raise exception 'FAIL 1d old slab %', public.partner_remuneration_limit(2023, 1000000); end if;
  if public.partner_remuneration_limit(2025, -100000) <> 300000 then raise exception 'FAIL 1e loss'; end if;
  if public.partner_remuneration_limit(2025, 200000) <> 300000 then raise exception 'FAIL 1f floor'; end if;
  if public.partner_remuneration_limit(2023, 100000) <> 150000 then raise exception 'FAIL 1g old floor'; end if;
  if public.partner_tds_due(2025, 20000) <> 0 then raise exception 'FAIL 1h 20000'; end if;
  if public.partner_tds_due(2025, 20001) <> 2000 then raise exception 'FAIL 1i 20001'; end if;
  if public.partner_tds_due(2024, 500000) <> 0 then raise exception 'FAIL 1j before 194T'; end if;
end $$;

-- the firm's partners: Asha 60% (₹5L capital), Bimal 40%
select pg_temp.r1849_as('01');
insert into r1849_res select 'pA', public.save_firm_partner(null, 'Asha Verma', 'ABCPV1234K', null, false, 60, 500000, null, null, null)::text;
insert into r1849_res select 'pB', public.save_firm_partner(null, 'Bimal Rao', 'BCDPR2345L', null, false, 40, 0, null, null, null)::text;
insert into r1849_res select 'dues_before', (select dues_vendor_tds from public.report_balance_sheet(null))::text;

-- 3. refusals (before the good post, so "nothing saved" is easy to see)
insert into r1849_res select 'int15', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(75000, 15, 428333, 128400, 50333, 0, 342667, 85600, 34267, 500000, 365, 15)));
insert into r1849_res select 'rem_over', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(60000, 12, 500000, 60000, 56000, 0, 400000, 40000, 40000)));
insert into r1849_res select 'bad_tds', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(60000, 12, 433333, 132000, 0, 0, 346667, 88000, 34667)));
insert into r1849_res select 'bad_share', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(60000, 12, 433333, 110000, 49333, 0, 346667, 110000, 34667)));
insert into r1849_res select 'bad_sum', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(60000, 12, 433333, 132000, 49333, 0, 346667, 87000, 34667)));
insert into r1849_res select 'bad_int', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(70000, 12, 433333, 122000, 50333, 0, 346667, 88000, 34667)));
insert into r1849_res select 'missing', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  jsonb_build_array(pg_temp.r1849_lines(60000, 12, 433333, 132000, 49333, 0, 346667, 88000, 34667)->0)));
insert into r1849_res select 'not_over', pg_temp.r1849_err(format('select public.post_partner_appropriation(2026, 1060000, %L)',
  pg_temp.r1849_lines(60000, 12, 433333, 132000, 49333, 0, 346667, 88000, 34667)));
select pg_temp.r1849_as('03');
insert into r1849_res select 'sales', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(60000, 12, 433333, 132000, 49333, 0, 346667, 88000, 34667)));
select pg_temp.r1849_as('06');
insert into r1849_res select 'nocompany', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(60000, 12, 433333, 132000, 49333, 0, 346667, 88000, 34667)));
select pg_temp.r1849_as('05');
insert into r1849_res select 'pvt', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(60000, 12, 433333, 132000, 49333, 0, 346667, 88000, 34667)));

-- 2. the owner posts FY 2025-26
select pg_temp.r1849_as('01');
insert into r1849_res select 'post25', public.post_partner_appropriation(2025, 1060000,
  pg_temp.r1849_lines(60000, 12, 433333, 132000, 49333, 0, 346667, 88000, 34667))::text;
insert into r1849_res select 'twice', pg_temp.r1849_err(format('select public.post_partner_appropriation(2025, 1060000, %L)',
  pg_temp.r1849_lines(60000, 12, 433333, 132000, 49333, 0, 346667, 88000, 34667)));
insert into r1849_res select 'dues_after', (select dues_vendor_tds from public.report_balance_sheet(null))::text;
insert into r1849_res select 'del_b', pg_temp.r1849_err(format('select public.delete_firm_partner(%L)', pg_temp.r1849_v('pB')));

do $$
declare v_h public.partner_appropriations; v_a public.partner_appropriation_lines; v_b public.partner_appropriation_lines;
begin
  if pg_temp.r1849_v('int15')     not like '%12%%'                then raise exception 'FAIL 3a interest 15: %', pg_temp.r1849_v('int15'); end if;
  if pg_temp.r1849_v('rem_over')  not like '%allowed on a book profit%' then raise exception 'FAIL 3b rem over: %', pg_temp.r1849_v('rem_over'); end if;
  if pg_temp.r1849_v('bad_tds')   not like '%TDS%'                then raise exception 'FAIL 3c tds: %', pg_temp.r1849_v('bad_tds'); end if;
  if pg_temp.r1849_v('bad_share') not like '%share of profit%'    then raise exception 'FAIL 3d share: %', pg_temp.r1849_v('bad_share'); end if;
  if pg_temp.r1849_v('bad_sum')   not like '%must equal the net profit%' then raise exception 'FAIL 3e sum: %', pg_temp.r1849_v('bad_sum'); end if;
  if pg_temp.r1849_v('bad_int')   not like '%interest at 12%'     then raise exception 'FAIL 3f interest amount: %', pg_temp.r1849_v('bad_int'); end if;
  if pg_temp.r1849_v('missing')   not like '%Every partner%'      then raise exception 'FAIL 3g missing: %', pg_temp.r1849_v('missing'); end if;
  if pg_temp.r1849_v('not_over')  not like '%not over yet%'       then raise exception 'FAIL 3h not over: %', pg_temp.r1849_v('not_over'); end if;
  if pg_temp.r1849_v('sales')     not like '42501:%'              then raise exception 'FAIL 3i sales: %', pg_temp.r1849_v('sales'); end if;
  if pg_temp.r1849_v('nocompany') not like '28000:%'              then raise exception 'FAIL 3j no company: %', pg_temp.r1849_v('nocompany'); end if;
  if pg_temp.r1849_v('pvt')       not like '%Partnership or LLP%' then raise exception 'FAIL 3k pvt: %', pg_temp.r1849_v('pvt'); end if;
  if pg_temp.r1849_v('twice')     not like '%already split%'      then raise exception 'FAIL 3l twice: %', pg_temp.r1849_v('twice'); end if;

  if (select count(*) from public.partner_appropriations where tenant_id = 'e1849000-0000-0000-0000-0000000000f1') <> 1
    then raise exception 'FAIL 3m a refused call saved something'; end if;

  select * into v_h from public.partner_appropriations where id = pg_temp.r1849_v('post25')::uuid;
  if v_h.posted_on <> '2026-03-31' or v_h.interest_total <> 60000 or v_h.book_profit <> 1000000
     or v_h.max_remuneration <> 780000 or v_h.remuneration_total <> 780000 or v_h.residual <> 220000 or v_h.tds_total <> 84000
    then raise exception 'FAIL 2a header %', row_to_json(v_h); end if;
  select * into v_a from public.partner_appropriation_lines where appropriation_id = v_h.id and partner_id = pg_temp.r1849_v('pA')::uuid;
  select * into v_b from public.partner_appropriation_lines where appropriation_id = v_h.id and partner_id = pg_temp.r1849_v('pB')::uuid;
  if v_a.interest <> 60000 or v_a.remuneration <> 433333 or v_a.profit_share <> 132000 or v_a.tds <> 49333
     or v_a.share_pct <> 60 or v_a.tds_section <> '194T' then raise exception 'FAIL 2b Asha %', row_to_json(v_a); end if;
  if v_b.interest <> 0 or v_b.remuneration <> 346667 or v_b.profit_share <> 88000 or v_b.tds <> 34667
    then raise exception 'FAIL 2c Bimal %', row_to_json(v_b); end if;

  -- 5. Balance Sheet TDS payable
  if pg_temp.r1849_v('dues_after')::bigint - pg_temp.r1849_v('dues_before')::bigint <> 84000
    then raise exception 'FAIL 5 BS TDS payable % → %', pg_temp.r1849_v('dues_before'), pg_temp.r1849_v('dues_after'); end if;
  -- 6. delete a partner with a split
  if pg_temp.r1849_v('del_b') not like '%profit split posted%' then raise exception 'FAIL 6 delete: %', pg_temp.r1849_v('del_b'); end if;
end $$;

-- 4. RLS
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1849000-0000-4000-8000-000000000002')::text, true);
set local role authenticated;
insert into r1849_res select 'acct_h', (select count(*) from public.partner_appropriations)::text;
insert into r1849_res select 'acct_l', (select count(*) from public.partner_appropriation_lines)::text;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1849000-0000-4000-8000-000000000003')::text, true);
insert into r1849_res select 'sales_l', (select count(*) from public.partner_appropriation_lines)::text;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1849000-0000-4000-8000-000000000004')::text, true);
insert into r1849_res select 'other_h', (select count(*) from public.partner_appropriations)::text;
do $$ begin
  insert into public.partner_appropriations (tenant_id, fy_start, posted_on, net_profit, interest_total, book_profit, max_remuneration, remuneration_total, residual, tds_total) values ('e1849000-0000-0000-0000-0000000000f2', 2024, '2025-03-31', 0, 0, 0, 0, 0, 0, 0);
  insert into r1849_res values ('direct_ins', 'OK');
exception when others then insert into r1849_res values ('direct_ins', sqlstate || ': ' || sqlerrm);
end $$;
reset role;
do $$ begin
  if pg_temp.r1849_v('acct_h') <> '1' or pg_temp.r1849_v('acct_l') <> '2' then raise exception 'FAIL 4a accountant reads % / %', pg_temp.r1849_v('acct_h'), pg_temp.r1849_v('acct_l'); end if;
  if pg_temp.r1849_v('sales_l') <> '0' then raise exception 'FAIL 4b sales reads %', pg_temp.r1849_v('sales_l'); end if;
  if pg_temp.r1849_v('other_h') <> '0' then raise exception 'FAIL 4c other company reads %', pg_temp.r1849_v('other_h'); end if;
  if pg_temp.r1849_v('direct_ins') not like '42501:%' then raise exception 'FAIL 4d direct insert: %', pg_temp.r1849_v('direct_ins'); end if;
end $$;

-- 7. undo: FY 2024-25 posted too → undoing it is refused while 2025-26 stands; locked books refuse
select pg_temp.r1849_as('01');
-- FY 2024-25: net ₹1,00,000; interest 12% on ₹5L = ₹60,000; book profit ₹40,000; no remuneration; no TDS (before 194T)
select public.post_partner_appropriation(2024, 100000, jsonb_build_array(
  jsonb_build_object('partner_id', pg_temp.r1849_v('pA'), 'capital_base', 500000, 'interest_days', 365, 'deed_interest_pct', 12,
    'interest_pct', 12, 'interest', 60000, 'working', true, 'deed_remuneration', 0, 'remuneration', 0, 'profit_share', 24000, 'tds', 0),
  jsonb_build_object('partner_id', pg_temp.r1849_v('pB'), 'capital_base', 0, 'interest_days', 365, 'deed_interest_pct', 0,
    'interest_pct', 0, 'interest', 0, 'working', false, 'deed_remuneration', 0, 'remuneration', 0, 'profit_share', 16000, 'tds', 0)));
insert into r1849_res select 'undo_old', pg_temp.r1849_err('select public.undo_partner_appropriation(2024)');
update public.tenants set books_locked_until = '2026-03-31' where id = 'e1849000-0000-0000-0000-0000000000f1';
insert into r1849_res select 'undo_locked', pg_temp.r1849_err('select public.undo_partner_appropriation(2025)');
update public.tenants set books_locked_until = null where id = 'e1849000-0000-0000-0000-0000000000f1';
select pg_temp.r1849_as('03');
insert into r1849_res select 'undo_sales', pg_temp.r1849_err('select public.undo_partner_appropriation(2025)');
select pg_temp.r1849_as('01');
select public.undo_partner_appropriation(2025);
insert into r1849_res select 'dues_undone', (select dues_vendor_tds from public.report_balance_sheet(null))::text;
do $$ begin
  if pg_temp.r1849_v('undo_old')    not like '%undo FY 2025-26 first%' then raise exception 'FAIL 7a undo older: %', pg_temp.r1849_v('undo_old'); end if;
  if pg_temp.r1849_v('undo_locked') not like '%lock%'                  then raise exception 'FAIL 7b undo locked: %', pg_temp.r1849_v('undo_locked'); end if;
  if pg_temp.r1849_v('undo_sales')  not like '42501:%'                 then raise exception 'FAIL 7c undo sales: %', pg_temp.r1849_v('undo_sales'); end if;
  if exists (select 1 from public.partner_appropriations where id = pg_temp.r1849_v('post25')::uuid) then raise exception 'FAIL 7d not undone'; end if;
  if exists (select 1 from public.partner_appropriation_lines where appropriation_id = pg_temp.r1849_v('post25')::uuid) then raise exception 'FAIL 7e lines left'; end if;
  if pg_temp.r1849_v('dues_undone') <> pg_temp.r1849_v('dues_before') then raise exception 'FAIL 7f TDS payable not back: %', pg_temp.r1849_v('dues_undone'); end if;
  if (select count(*) from public.partner_appropriations where tenant_id = 'e1849000-0000-0000-0000-0000000000f1' and fy_start = 2024) <> 1
    then raise exception 'FAIL 7g FY 2024-25 should stay'; end if;
end $$;

select 'PASS r1849' as result;

rollback;
