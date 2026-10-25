-- R-1853 (epic R-1841, Phase 3): loans to and from a company's directors.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1853_director_loans.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1853 migration> <this test> rollback;
-- Expect "PASS r1853".
--
-- Proves:
--   1. give_director_loan: the owner lends to the Managing Director under s.185(3)(a)(i) — the
--      loan row carries the director and the reason, the borrower name is the register's name,
--      the cash leaves the bank (debit). The accountant lends to an ordinary director with
--      "CA confirmed".
--   2. refusals, each with a plain message and NO row / bank line left behind: no reason, an
--      unknown reason, an MD/WTD reason for an ordinary director, a director who had ceased on
--      the loan date, another company's director, a proprietor (no directors).
--   3. who: sales and manager refused (42501 — loans given is owner / accountant), a login with
--      no company refused (28000).
--   4. record_director_loan_taken: the accountant records ₹3,00,000 from the MD with the
--      written declaration; the manager records one without it. Lender = register name, bank
--      credit. Refused: declaration not answered, ceased director, other company's director,
--      proprietor, sales (42501), no company (28000) — nothing saved.
--   5. the table rules: a director loan without its reason / declaration answer cannot exist.
--   6. delete_company_director refuses a director with loans in the books (plain message), and
--      still deletes one without loans.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1853000-0000-4000-8000-0000000000' || k)::uuid, 'r1853-' || k || '@example.test'
  from unnest(array['01','02','03','04','05','06','07']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, business_type) values
  ('e1853000-0000-0000-0000-0000000000f1', 'R1853 PvtLtd', 'r1853a@example.in', '07', 'Delhi', 'R street, Delhi', 'R53A', '07AAACR1853R1Z1', 'registered', 'pvt_ltd'),
  ('e1853000-0000-0000-0000-0000000000f2', 'R1853 Prop',   'r1853b@example.in', '07', 'Delhi', 'R street, Delhi', 'R53B', '07AAACR1853R1Z2', 'registered', 'proprietor'),
  ('e1853000-0000-0000-0000-0000000000f3', 'R1853 Other',  'r1853c@example.in', '07', 'Delhi', 'R street, Delhi', 'R53C', '07AAACR1853R1Z3', 'registered', 'pvt_ltd');

-- 06 has an auth login but no users row → no company
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1853000-0000-4000-8000-000000000001', 'e1853000-0000-0000-0000-0000000000f1', 'r1853-01@example.in', 'Pvt owner',  'owner', true),
  ('e1853000-0000-4000-8000-000000000002', 'e1853000-0000-0000-0000-0000000000f1', 'r1853-02@example.in', 'Pvt acct',   'accountant', true),
  ('e1853000-0000-4000-8000-000000000003', 'e1853000-0000-0000-0000-0000000000f1', 'r1853-03@example.in', 'Pvt sales',  'sales', true),
  ('e1853000-0000-4000-8000-000000000004', 'e1853000-0000-0000-0000-0000000000f2', 'r1853-04@example.in', 'Prop owner', 'owner', true),
  ('e1853000-0000-4000-8000-000000000005', 'e1853000-0000-0000-0000-0000000000f1', 'r1853-05@example.in', 'Pvt mgr',    'manager', true),
  ('e1853000-0000-4000-8000-000000000007', 'e1853000-0000-0000-0000-0000000000f3', 'r1853-07@example.in', 'Other owner','owner', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('e1853000-0000-0000-0000-0000000000b1', 'e1853000-0000-0000-0000-0000000000f1', 'R1853 Current', 'HDFC', 'current', 1000000, '2026-04-01'),
  ('e1853000-0000-0000-0000-0000000000b2', 'e1853000-0000-0000-0000-0000000000f2', 'R1853 Prop bank', 'SBI', 'current', 1000000, '2026-04-01');

-- The register (R-1850) — seeded directly: MD, ordinary director, a director who left on 31 Jan,
-- and a director of ANOTHER company.
insert into public.company_directors (id, tenant_id, name, din, designation, appointed_on, ceased_on) values
  ('e1853000-0000-0000-0000-0000000000d1', 'e1853000-0000-0000-0000-0000000000f1', 'Asha Verma', '01234567', 'managing_director', '2024-04-01', null),
  ('e1853000-0000-0000-0000-0000000000d2', 'e1853000-0000-0000-0000-0000000000f1', 'Bimal Rao',  '07654321', 'director',          '2024-04-01', null),
  ('e1853000-0000-0000-0000-0000000000d3', 'e1853000-0000-0000-0000-0000000000f1', 'Chetan Old', '05555555', 'whole_time_director','2024-04-01', '2026-01-31'),
  ('e1853000-0000-0000-0000-0000000000d4', 'e1853000-0000-0000-0000-0000000000f1', 'Dev Spare',  '06666666', 'director',          '2024-04-01', null),
  ('e1853000-0000-0000-0000-0000000000d5', 'e1853000-0000-0000-0000-0000000000f1', 'Esha Lender','08888888', 'director',          '2024-04-01', null),
  ('e1853000-0000-0000-0000-0000000000d9', 'e1853000-0000-0000-0000-0000000000f3', 'Xavier Else','09999999', 'managing_director', '2024-04-01', null);

create temp table r1853_res (k text primary key, v text);
grant all on r1853_res to authenticated, service_role;

create function pg_temp.r1853_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1853000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1853_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r1853_v(p_k text) returns text language sql as $$ select v from r1853_res where k = p_k $$;

-- ── 1. loans TO directors ──────────────────────────────────────────────────────────────
select pg_temp.r1853_as('01');
insert into r1853_res select 'gMD', public.give_director_loan(
  'e1853000-0000-0000-0000-0000000000d1', 'md_wtd_service', 200000, '2026-10-01',
  'e1853000-0000-0000-0000-0000000000b1', 9.5, 'one_shot', '2027-03-31', null, 'Staff loan policy')::text;
select pg_temp.r1853_as('02');
insert into r1853_res select 'gD', public.give_director_loan(
  'e1853000-0000-0000-0000-0000000000d2', 'ca_confirmed', 50000, '2026-10-05',
  'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)::text;

-- ── 2. refusals (owner) ────────────────────────────────────────────────────────────────
select pg_temp.r1853_as('01');
insert into r1853_res select 'g_nobasis', pg_temp.r1853_err($q$select public.give_director_loan('e1853000-0000-0000-0000-0000000000d2', null, 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)$q$);
insert into r1853_res select 'g_badbasis', pg_temp.r1853_err($q$select public.give_director_loan('e1853000-0000-0000-0000-0000000000d2', 'because', 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)$q$);
insert into r1853_res select 'g_mdbasis', pg_temp.r1853_err($q$select public.give_director_loan('e1853000-0000-0000-0000-0000000000d2', 'md_wtd_scheme', 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)$q$);
insert into r1853_res select 'g_ceased', pg_temp.r1853_err($q$select public.give_director_loan('e1853000-0000-0000-0000-0000000000d3', 'md_wtd_service', 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)$q$);
insert into r1853_res select 'g_cross', pg_temp.r1853_err($q$select public.give_director_loan('e1853000-0000-0000-0000-0000000000d9', 'md_wtd_service', 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)$q$);
insert into r1853_res select 'g_nodir', pg_temp.r1853_err($q$select public.give_director_loan(null, 'ca_confirmed', 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)$q$);

-- ── 3. who ─────────────────────────────────────────────────────────────────────────────
select pg_temp.r1853_as('03');
insert into r1853_res select 'g_sales', pg_temp.r1853_err($q$select public.give_director_loan('e1853000-0000-0000-0000-0000000000d1', 'md_wtd_service', 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)$q$);
select pg_temp.r1853_as('05');
insert into r1853_res select 'g_mgr', pg_temp.r1853_err($q$select public.give_director_loan('e1853000-0000-0000-0000-0000000000d1', 'md_wtd_service', 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)$q$);
select pg_temp.r1853_as('06');
insert into r1853_res select 'g_nocompany', pg_temp.r1853_err($q$select public.give_director_loan('e1853000-0000-0000-0000-0000000000d1', 'md_wtd_service', 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b1', 0, 'one_shot', null, null, null)$q$);
select pg_temp.r1853_as('04');
insert into r1853_res select 'g_prop', pg_temp.r1853_err($q$select public.give_director_loan('e1853000-0000-0000-0000-0000000000d1', 'md_wtd_service', 1000, '2026-10-05', 'e1853000-0000-0000-0000-0000000000b2', 0, 'one_shot', null, null, null)$q$);

-- ── 4. loans FROM directors ────────────────────────────────────────────────────────────
select pg_temp.r1853_as('02');
insert into r1853_res select 'tMD', public.record_director_loan_taken(
  'e1853000-0000-0000-0000-0000000000d1', 300000, '2026-10-02', 'e1853000-0000-0000-0000-0000000000b1', 0, true, 'Working capital')::text;
select pg_temp.r1853_as('05');
insert into r1853_res select 'tD', public.record_director_loan_taken(
  'e1853000-0000-0000-0000-0000000000d2', 40000, '2026-10-03', 'e1853000-0000-0000-0000-0000000000b1', null, false, null)::text;
-- Esha only LENT to the company (no loan given to her) — proves the delete check reads business_loans too.
insert into r1853_res select 'tE', public.record_director_loan_taken(
  'e1853000-0000-0000-0000-0000000000d5', 10000, '2026-10-03', 'e1853000-0000-0000-0000-0000000000b1', null, true, null)::text;
insert into r1853_res select 't_nodecl', pg_temp.r1853_err($q$select public.record_director_loan_taken('e1853000-0000-0000-0000-0000000000d2', 1000, '2026-10-03', 'e1853000-0000-0000-0000-0000000000b1', null, null, null)$q$);
insert into r1853_res select 't_ceased', pg_temp.r1853_err($q$select public.record_director_loan_taken('e1853000-0000-0000-0000-0000000000d3', 1000, '2026-10-03', 'e1853000-0000-0000-0000-0000000000b1', null, true, null)$q$);
insert into r1853_res select 't_cross',  pg_temp.r1853_err($q$select public.record_director_loan_taken('e1853000-0000-0000-0000-0000000000d9', 1000, '2026-10-03', 'e1853000-0000-0000-0000-0000000000b1', null, true, null)$q$);
insert into r1853_res select 't_zero',   pg_temp.r1853_err($q$select public.record_director_loan_taken('e1853000-0000-0000-0000-0000000000d2', 0, '2026-10-03', 'e1853000-0000-0000-0000-0000000000b1', null, true, null)$q$);
select pg_temp.r1853_as('03');
insert into r1853_res select 't_sales', pg_temp.r1853_err($q$select public.record_director_loan_taken('e1853000-0000-0000-0000-0000000000d2', 1000, '2026-10-03', 'e1853000-0000-0000-0000-0000000000b1', null, true, null)$q$);
select pg_temp.r1853_as('06');
insert into r1853_res select 't_nocompany', pg_temp.r1853_err($q$select public.record_director_loan_taken('e1853000-0000-0000-0000-0000000000d2', 1000, '2026-10-03', 'e1853000-0000-0000-0000-0000000000b1', null, true, null)$q$);
select pg_temp.r1853_as('04');
insert into r1853_res select 't_prop', pg_temp.r1853_err($q$select public.record_director_loan_taken('e1853000-0000-0000-0000-0000000000d1', 1000, '2026-10-03', 'e1853000-0000-0000-0000-0000000000b2', null, true, null)$q$);

-- ── 6. delete a director with loans / without ──────────────────────────────────────────
select pg_temp.r1853_as('01');
insert into r1853_res select 'del_loans', pg_temp.r1853_err($q$select public.delete_company_director('e1853000-0000-0000-0000-0000000000d1')$q$);
insert into r1853_res select 'del_taken', pg_temp.r1853_err($q$select public.delete_company_director('e1853000-0000-0000-0000-0000000000d5')$q$);
insert into r1853_res select 'del_spare', pg_temp.r1853_err($q$select public.delete_company_director('e1853000-0000-0000-0000-0000000000d4')$q$);

select set_config('request.jwt.claims', '', true);

do $$
declare
  v_g  public.loans_given;
  v_g2 public.loans_given;
  v_t  public.business_loans;
  v_t2 public.business_loans;
  v_tx public.bank_transactions;
begin
  -- 1.
  select * into v_g  from public.loans_given where id = pg_temp.r1853_v('gMD')::uuid;
  select * into v_g2 from public.loans_given where id = pg_temp.r1853_v('gD')::uuid;
  if v_g.director_id <> 'e1853000-0000-0000-0000-0000000000d1' or v_g.s185_basis <> 'md_wtd_service'
     or v_g.borrower_name <> 'Asha Verma' or v_g.borrower_type <> 'person' or v_g.principal <> 200000
     or v_g.interest_rate <> 9.5 or v_g.notes <> 'Staff loan policy' or v_g.tenant_id <> 'e1853000-0000-0000-0000-0000000000f1' then
    raise exception 'FAIL 1a loan to MD %', row_to_json(v_g);
  end if;
  select * into v_tx from public.bank_transactions where id = v_g.bank_txn_id;
  if v_tx.debit <> 200000 or v_tx.credit <> 0 or v_tx.bank_account_id <> 'e1853000-0000-0000-0000-0000000000b1' then
    raise exception 'FAIL 1b cash out %', row_to_json(v_tx);
  end if;
  if v_g2.director_id <> 'e1853000-0000-0000-0000-0000000000d2' or v_g2.s185_basis <> 'ca_confirmed' or v_g2.borrower_name <> 'Bimal Rao' then
    raise exception 'FAIL 1c loan to director %', row_to_json(v_g2);
  end if;

  -- 2. / 3.
  if pg_temp.r1853_v('g_nobasis')  not like '%s.185 reason%'                 then raise exception 'FAIL 2a %', pg_temp.r1853_v('g_nobasis'); end if;
  if pg_temp.r1853_v('g_badbasis') not like '%s.185 reason%'                 then raise exception 'FAIL 2b %', pg_temp.r1853_v('g_badbasis'); end if;
  if pg_temp.r1853_v('g_mdbasis')  not like '%managing or whole-time%'       then raise exception 'FAIL 2c %', pg_temp.r1853_v('g_mdbasis'); end if;
  if pg_temp.r1853_v('g_ceased')   not like '%was not a director on%'        then raise exception 'FAIL 2d %', pg_temp.r1853_v('g_ceased'); end if;
  if pg_temp.r1853_v('g_cross')    not like '%not in your directors register%' then raise exception 'FAIL 2e %', pg_temp.r1853_v('g_cross'); end if;
  if pg_temp.r1853_v('g_nodir')    not like '%Pick the director%'            then raise exception 'FAIL 2f %', pg_temp.r1853_v('g_nodir'); end if;
  if pg_temp.r1853_v('g_prop')     not like '%Pvt Ltd%'                      then raise exception 'FAIL 2g %', pg_temp.r1853_v('g_prop'); end if;
  if pg_temp.r1853_v('g_sales')    not like '42501:%' then raise exception 'FAIL 3a %', pg_temp.r1853_v('g_sales'); end if;
  if pg_temp.r1853_v('g_mgr')      not like '42501:%' then raise exception 'FAIL 3b %', pg_temp.r1853_v('g_mgr'); end if;
  if pg_temp.r1853_v('g_nocompany') not like '28000:%' then raise exception 'FAIL 3c %', pg_temp.r1853_v('g_nocompany'); end if;
  if (select count(*) from public.loans_given where tenant_id in ('e1853000-0000-0000-0000-0000000000f1', 'e1853000-0000-0000-0000-0000000000f2')) <> 2 then
    raise exception 'FAIL 2z a refused loan was saved';
  end if;

  -- 4.
  select * into v_t  from public.business_loans where id = pg_temp.r1853_v('tMD')::uuid;
  select * into v_t2 from public.business_loans where id = pg_temp.r1853_v('tD')::uuid;
  if v_t.director_id <> 'e1853000-0000-0000-0000-0000000000d1' or v_t.director_declaration is distinct from true
     or v_t.lender <> 'Asha Verma' or v_t.principal <> 300000 or v_t.purpose <> 'Working capital' then
    raise exception 'FAIL 4a loan from MD %', row_to_json(v_t);
  end if;
  if v_t2.director_declaration is distinct from false or v_t2.lender <> 'Bimal Rao' then raise exception 'FAIL 4b %', row_to_json(v_t2); end if;
  if not exists (select 1 from public.bank_transactions where tenant_id = 'e1853000-0000-0000-0000-0000000000f1'
                  and credit = 300000 and debit = 0 and description = 'Loan received: Asha Verma') then
    raise exception 'FAIL 4c cash in';
  end if;
  if pg_temp.r1853_v('t_nodecl') not like '%written declaration%'          then raise exception 'FAIL 4d %', pg_temp.r1853_v('t_nodecl'); end if;
  if pg_temp.r1853_v('t_ceased') not like '%was not a director on%'        then raise exception 'FAIL 4e %', pg_temp.r1853_v('t_ceased'); end if;
  if pg_temp.r1853_v('t_cross')  not like '%not in your directors register%' then raise exception 'FAIL 4f %', pg_temp.r1853_v('t_cross'); end if;
  if pg_temp.r1853_v('t_zero')   not like '%positive%'                     then raise exception 'FAIL 4g %', pg_temp.r1853_v('t_zero'); end if;
  if pg_temp.r1853_v('t_sales')  not like '42501:%' then raise exception 'FAIL 4h %', pg_temp.r1853_v('t_sales'); end if;
  if pg_temp.r1853_v('t_nocompany') not like '28000:%' then raise exception 'FAIL 4i %', pg_temp.r1853_v('t_nocompany'); end if;
  if pg_temp.r1853_v('t_prop')   not like '%Pvt Ltd%' then raise exception 'FAIL 4j %', pg_temp.r1853_v('t_prop'); end if;
  if (select count(*) from public.business_loans where tenant_id in ('e1853000-0000-0000-0000-0000000000f1', 'e1853000-0000-0000-0000-0000000000f2')) <> 3 then
    raise exception 'FAIL 4z a refused loan was saved';
  end if;

  -- 6.
  if pg_temp.r1853_v('del_loans') not like '%has loans in the books%' then raise exception 'FAIL 6a %', pg_temp.r1853_v('del_loans'); end if;
  if pg_temp.r1853_v('del_taken') not like '%has loans in the books%' then raise exception 'FAIL 6b %', pg_temp.r1853_v('del_taken'); end if;
  if pg_temp.r1853_v('del_spare') <> 'OK' then raise exception 'FAIL 6c %', pg_temp.r1853_v('del_spare'); end if;
  if exists (select 1 from public.company_directors where id = 'e1853000-0000-0000-0000-0000000000d4') then raise exception 'FAIL 6d spare not deleted'; end if;
  if not exists (select 1 from public.company_directors where id = 'e1853000-0000-0000-0000-0000000000d1') then raise exception 'FAIL 6e MD deleted'; end if;
end $$;

-- ── 5. table rules (as the owner of the tables) ────────────────────────────────────────
do $$ begin
  update public.loans_given set s185_basis = null where id = pg_temp.r1853_v('gMD')::uuid;
  raise exception 'FAIL 5a a director loan without its s.185 reason was allowed';
exception when check_violation then null;
end $$;
do $$ begin
  update public.loans_given set s185_basis = 'ca_confirmed' where id = (select id from public.loans_given where director_id is null limit 1);
  if found then raise exception 'FAIL 5b an s.185 reason on a non-director loan was allowed'; end if;
exception when check_violation then null;
end $$;
do $$ begin
  update public.business_loans set director_declaration = null where id = pg_temp.r1853_v('tMD')::uuid;
  raise exception 'FAIL 5c a director loan without the declaration answer was allowed';
exception when check_violation then null;
end $$;

select 'PASS r1853' as result;

rollback;
