-- R-1839 (Pardeep, 24 Oct 2026): owner drawings / capital introduced.
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1839_owner_equity.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1839 migration> <this test> rollback;
-- Expect "PASS r1839".
--
-- Proves:
--   1. proprietor owner records ₹5,000 drawings from the bank → one movement + one debit line
--      on that account (matched owner_equity), so the account's book balance drops by ₹5,000.
--   2. capital introduced ₹20,000 → a credit line; Petty Cash drawings ₹700 → a cash debit line.
--   3. sales is refused (42501); a login with no company is refused (28000); a credit card refused.
--   4. bank page: the imported ₹5,000 debit booked against the hand-recorded entry REPLACES its
--      manual line (one ₹5,000 debit on the account, not two); a fresh ₹3,000 debit books new
--      drawings; a money-in line books capital introduced; amount / direction mismatches refused.
--   5. un-reconciling a line (reconcile_bank_txn → null) removes its entry; deleting an entry
--      removes its own manual line, and frees (does not delete) an imported line.
--   6. pvt_ltd: both functions refuse (no drawings in a company); partnership needs the partner.
--   7. another company's entry / line is not reachable.
--   8. report_pnl for the period is the same before and after (drawings never touch the P&L).

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1839000-0000-4000-8000-0000000000' || k)::uuid, 'r1839-' || k || '@example.test'
  from unnest(array['01','02','03','04','05','06']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, business_type) values
  ('e1839000-0000-0000-0000-0000000000f1', 'R1839 Prop',  'r1839a@example.in', '07', 'Delhi', 'R street, Delhi', 'R39A', '07AAACR1839R1Z1', 'registered', 'proprietor'),
  ('e1839000-0000-0000-0000-0000000000f2', 'R1839 PvtLtd','r1839b@example.in', '07', 'Delhi', 'R street, Delhi', 'R39B', '07AAACR1839R1Z2', 'registered', 'pvt_ltd'),
  ('e1839000-0000-0000-0000-0000000000f3', 'R1839 Firm',  'r1839c@example.in', '07', 'Delhi', 'R street, Delhi', 'R39C', '07AAACR1839R1Z3', 'registered', 'partnership');

-- 06 has an auth login but no users row → no company
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1839000-0000-4000-8000-000000000001', 'e1839000-0000-0000-0000-0000000000f1', 'r1839-01@example.in', 'Prop owner', 'owner', true),
  ('e1839000-0000-4000-8000-000000000002', 'e1839000-0000-0000-0000-0000000000f1', 'r1839-02@example.in', 'Prop sales', 'sales', true),
  ('e1839000-0000-4000-8000-000000000003', 'e1839000-0000-0000-0000-0000000000f2', 'r1839-03@example.in', 'Pvt owner',  'owner', true),
  ('e1839000-0000-4000-8000-000000000004', 'e1839000-0000-0000-0000-0000000000f3', 'r1839-04@example.in', 'Firm acct',  'accountant', true),
  ('e1839000-0000-4000-8000-000000000005', 'e1839000-0000-0000-0000-0000000000f1', 'r1839-05@example.in', 'Prop acct',  'accountant', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('e1839000-0000-4000-8000-0000000000a1', 'e1839000-0000-0000-0000-0000000000f1', 'HDFC Current', 'HDFC', 'current', 100000, '2026-04-01'),
  ('e1839000-0000-4000-8000-0000000000a2', 'e1839000-0000-0000-0000-0000000000f1', 'Petty Cash',   'Cash', 'cash',     5000,   '2026-04-01'),
  ('e1839000-0000-4000-8000-0000000000a3', 'e1839000-0000-0000-0000-0000000000f1', 'HDFC Card',    'HDFC', 'credit_card', 0,   '2026-04-01'),
  ('e1839000-0000-4000-8000-0000000000b1', 'e1839000-0000-0000-0000-0000000000f2', 'Pvt Bank',     'ICICI','current', 100000, '2026-04-01'),
  ('e1839000-0000-4000-8000-0000000000c1', 'e1839000-0000-0000-0000-0000000000f3', 'Firm Bank',    'SBI',  'current', 100000, '2026-04-01');

-- Imported statement lines (csv_upload) on the proprietor's bank, and one on the firm's.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('e1839000-0000-4000-8000-0000000000d1', 'e1839000-0000-0000-0000-0000000000f1', 'e1839000-0000-4000-8000-0000000000a1', '2026-10-06', 'UPI/SELF/OWNER', 5000, 0, 'csv_upload'),
  ('e1839000-0000-4000-8000-0000000000d2', 'e1839000-0000-0000-0000-0000000000f1', 'e1839000-0000-4000-8000-0000000000a1', '2026-10-10', 'ATM WDL',        3000, 0, 'csv_upload'),
  ('e1839000-0000-4000-8000-0000000000d3', 'e1839000-0000-0000-0000-0000000000f1', 'e1839000-0000-4000-8000-0000000000a1', '2026-10-12', 'NEFT FROM OWNER',0, 15000, 'csv_upload'),
  ('e1839000-0000-4000-8000-0000000000d4', 'e1839000-0000-0000-0000-0000000000f1', 'e1839000-0000-4000-8000-0000000000a1', '2026-10-14', 'IMPS SELF',      4444, 0, 'csv_upload'),
  ('e1839000-0000-4000-8000-0000000000d5', 'e1839000-0000-0000-0000-0000000000f2', 'e1839000-0000-4000-8000-0000000000b1', '2026-10-14', 'DIRECTOR',       9000, 0, 'csv_upload');

create temp table r1839_res (k text primary key, v text);
grant all on r1839_res to authenticated, service_role;

create function pg_temp.r1839_as(p_who text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1839000-0000-4000-8000-0000000000' || p_who)::text, true);
$$;
create function pg_temp.r1839_err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ': ' || v_msg;
end $$;
create function pg_temp.r1839_bal(p_acc uuid) returns bigint language sql as $$
  select (select opening_balance from public.bank_accounts where id = p_acc)
       + coalesce((select sum(credit - debit) from public.bank_transactions where bank_account_id = p_acc), 0);
$$;

-- P&L before (drawings must not move it).
select pg_temp.r1839_as('01');
insert into r1839_res select 'pnl_before', (select row_to_json(x)::text from public.report_pnl('2026-04-01', '2027-03-31') x limit 1);

-- 1. drawings ₹5,000 from the bank (hand-recorded)
insert into r1839_res select 'm1', public.record_owner_equity_movement('drawings', '2026-10-05', 5000, 'e1839000-0000-4000-8000-0000000000a1', null, 'Home rent')::text;
do $$
declare v_m public.owner_equity_movements; v_t public.bank_transactions;
begin
  select * into v_m from public.owner_equity_movements where id = (select v::uuid from r1839_res where k = 'm1');
  select * into v_t from public.bank_transactions where id = v_m.bank_txn_id;
  if v_m.amount <> 5000 or v_m.kind <> 'drawings' or not v_m.own_line then raise exception 'FAIL 1a movement %', row_to_json(v_m); end if;
  if v_t.debit <> 5000 or v_t.credit <> 0 or v_t.matched_to_type <> 'owner_equity' or v_t.matched_to_id <> v_m.id::text or v_t.source <> 'manual' then
    raise exception 'FAIL 1b line %', row_to_json(v_t);
  end if;
  if pg_temp.r1839_bal('e1839000-0000-4000-8000-0000000000a1') <> 100000 - 5000 + 15000 - 5000 - 3000 - 4444 then
    raise exception 'FAIL 1c balance %', pg_temp.r1839_bal('e1839000-0000-4000-8000-0000000000a1');
  end if;
end $$;

-- 2. capital introduced ₹20,000 (accountant) + Petty Cash drawings ₹700
select pg_temp.r1839_as('05');
insert into r1839_res select 'm2', public.record_owner_equity_movement('capital_introduced', '2026-10-07', 20000, 'e1839000-0000-4000-8000-0000000000a1')::text;
insert into r1839_res select 'm3', public.record_owner_equity_movement('drawings', '2026-10-08', 700, 'e1839000-0000-4000-8000-0000000000a2', null, 'Personal')::text;
do $$
begin
  if (select credit from public.bank_transactions t join public.owner_equity_movements m on m.bank_txn_id = t.id
       where m.id = (select v::uuid from r1839_res where k = 'm2')) <> 20000 then raise exception 'FAIL 2a capital line'; end if;
  if pg_temp.r1839_bal('e1839000-0000-4000-8000-0000000000a2') <> 4300 then
    raise exception 'FAIL 2b petty cash balance %', pg_temp.r1839_bal('e1839000-0000-4000-8000-0000000000a2');
  end if;
end $$;

-- 3. refusals
select pg_temp.r1839_as('02');
insert into r1839_res select 'sales', pg_temp.r1839_err($q$select public.record_owner_equity_movement('drawings', '2026-10-05', 100, 'e1839000-0000-4000-8000-0000000000a1')$q$);
insert into r1839_res select 'sales_book', pg_temp.r1839_err($q$select public.book_bank_txn_as_owner_equity('e1839000-0000-4000-8000-0000000000d2')$q$);
insert into r1839_res select 'sales_del', pg_temp.r1839_err($q$select public.delete_owner_equity_movement((select v::uuid from r1839_res where k = 'm2'))$q$);
select pg_temp.r1839_as('06');
insert into r1839_res select 'nocompany', pg_temp.r1839_err($q$select public.record_owner_equity_movement('drawings', '2026-10-05', 100, 'e1839000-0000-4000-8000-0000000000a1')$q$);
select pg_temp.r1839_as('01');
insert into r1839_res select 'card', pg_temp.r1839_err($q$select public.record_owner_equity_movement('drawings', '2026-10-05', 100, 'e1839000-0000-4000-8000-0000000000a3')$q$);
insert into r1839_res select 'zero', pg_temp.r1839_err($q$select public.record_owner_equity_movement('drawings', '2026-10-05', 0, 'e1839000-0000-4000-8000-0000000000a1')$q$);
insert into r1839_res select 'otheracc', pg_temp.r1839_err($q$select public.record_owner_equity_movement('drawings', '2026-10-05', 100, 'e1839000-0000-4000-8000-0000000000b1')$q$);
do $$
begin
  if (select v from r1839_res where k = 'sales')      not like '42501:%' then raise exception 'FAIL 3a sales: %', (select v from r1839_res where k = 'sales'); end if;
  if (select v from r1839_res where k = 'sales_book') not like '42501:%' then raise exception 'FAIL 3b sales book: %', (select v from r1839_res where k = 'sales_book'); end if;
  if (select v from r1839_res where k = 'sales_del')  not like '42501:%' then raise exception 'FAIL 3c sales delete: %', (select v from r1839_res where k = 'sales_del'); end if;
  if (select v from r1839_res where k = 'nocompany')  not like '28000:%' then raise exception 'FAIL 3d no company: %', (select v from r1839_res where k = 'nocompany'); end if;
  if (select v from r1839_res where k = 'card')       not like '%credit card%' then raise exception 'FAIL 3e card: %', (select v from r1839_res where k = 'card'); end if;
  if (select v from r1839_res where k = 'zero')       not like '%more than ₹0%' then raise exception 'FAIL 3f zero: %', (select v from r1839_res where k = 'zero'); end if;
  if (select v from r1839_res where k = 'otheracc')   not like '%not in your company%' then raise exception 'FAIL 3g other account: %', (select v from r1839_res where k = 'otheracc'); end if;
  if (select count(*) from public.owner_equity_movements where tenant_id = 'e1839000-0000-0000-0000-0000000000f1') <> 3 then raise exception 'FAIL 3h a refused call saved something'; end if;
end $$;

-- 4. bank page
--   4a. wrong amount / wrong direction refused
insert into r1839_res select 'amount', pg_temp.r1839_err($q$select public.book_bank_txn_as_owner_equity('e1839000-0000-4000-8000-0000000000d2', null, null, (select v::uuid from r1839_res where k = 'm1'))$q$);
insert into r1839_res select 'direction', pg_temp.r1839_err($q$select public.book_bank_txn_as_owner_equity('e1839000-0000-4000-8000-0000000000d3', null, null, (select v::uuid from r1839_res where k = 'm1'))$q$);
--   4b. the imported ₹5,000 debit takes over the hand-recorded entry
insert into r1839_res select 'b1', public.book_bank_txn_as_owner_equity('e1839000-0000-4000-8000-0000000000d1', null, null, (select v::uuid from r1839_res where k = 'm1'))::text;
--   4c. a fresh ₹3,000 debit → new drawings; ₹15,000 credit → capital introduced
insert into r1839_res select 'b2', public.book_bank_txn_as_owner_equity('e1839000-0000-4000-8000-0000000000d2', null, 'ATM cash for home')::text;
insert into r1839_res select 'b3', public.book_bank_txn_as_owner_equity('e1839000-0000-4000-8000-0000000000d3')::text;
insert into r1839_res select 'again', pg_temp.r1839_err($q$select public.book_bank_txn_as_owner_equity('e1839000-0000-4000-8000-0000000000d2')$q$);
do $$
declare v_m public.owner_equity_movements;
begin
  if (select v from r1839_res where k = 'amount')    not like '%same amount%' then raise exception 'FAIL 4a amount: %', (select v from r1839_res where k = 'amount'); end if;
  if (select v from r1839_res where k = 'direction') not like '%money in%' then raise exception 'FAIL 4a direction: %', (select v from r1839_res where k = 'direction'); end if;
  select * into v_m from public.owner_equity_movements where id = (select v::uuid from r1839_res where k = 'm1');
  if v_m.bank_txn_id <> 'e1839000-0000-4000-8000-0000000000d1' or v_m.own_line or v_m.movement_date <> '2026-10-06' then
    raise exception 'FAIL 4b entry not moved onto the real line %', row_to_json(v_m);
  end if;
  if (select count(*) from public.bank_transactions where bank_account_id = 'e1839000-0000-4000-8000-0000000000a1' and debit = 5000) <> 1 then
    raise exception 'FAIL 4b the ₹5,000 is in the bank twice';
  end if;
  if (select (v::jsonb)->>'replaced_line' from r1839_res where k = 'b1') is null then raise exception 'FAIL 4b replaced_line not returned'; end if;
  if (select matched_to_type from public.bank_transactions where id = 'e1839000-0000-4000-8000-0000000000d1') <> 'owner_equity' then raise exception 'FAIL 4b line not matched'; end if;
  if (select kind || amount from public.owner_equity_movements where bank_txn_id = 'e1839000-0000-4000-8000-0000000000d2') <> 'drawings3000' then raise exception 'FAIL 4c drawings'; end if;
  if (select kind || amount from public.owner_equity_movements where bank_txn_id = 'e1839000-0000-4000-8000-0000000000d3') <> 'capital_introduced15000' then raise exception 'FAIL 4c capital'; end if;
  if (select v from r1839_res where k = 'again') not like '%already reconciled%' then raise exception 'FAIL 4d booked twice: %', (select v from r1839_res where k = 'again'); end if;
  -- balance: opening 1,00,000 + 15,000 + 20,000 (capital, own line) − 5,000 − 3,000 − 4,444 (imported)
  if pg_temp.r1839_bal('e1839000-0000-4000-8000-0000000000a1') <> 122556 then
    raise exception 'FAIL 4e balance %', pg_temp.r1839_bal('e1839000-0000-4000-8000-0000000000a1');
  end if;
end $$;

-- 5. un-reconcile / delete
select public.reconcile_bank_txn('e1839000-0000-4000-8000-0000000000d2', null, null, 'manual');
select public.delete_owner_equity_movement((select v::uuid from r1839_res where k = 'm3'));   -- own line (Petty Cash)
select public.delete_owner_equity_movement((select v::uuid from r1839_res where k = 'm1'));   -- imported line
do $$
begin
  if exists (select 1 from public.owner_equity_movements where bank_txn_id = 'e1839000-0000-4000-8000-0000000000d2') then raise exception 'FAIL 5a un-reconcile left the entry'; end if;
  if pg_temp.r1839_bal('e1839000-0000-4000-8000-0000000000a2') <> 5000 then raise exception 'FAIL 5b petty cash line not removed'; end if;
  if not exists (select 1 from public.bank_transactions where id = 'e1839000-0000-4000-8000-0000000000d1' and matched_to_type is null) then
    raise exception 'FAIL 5c imported line deleted or still matched';
  end if;
  if exists (select 1 from public.owner_equity_movements where id = (select v::uuid from r1839_res where k = 'm1')) then raise exception 'FAIL 5d entry left'; end if;
end $$;

-- 6. pvt_ltd refuses; partnership needs the partner
select pg_temp.r1839_as('03');
insert into r1839_res select 'pvt_rec',  pg_temp.r1839_err($q$select public.record_owner_equity_movement('drawings', '2026-10-05', 100, 'e1839000-0000-4000-8000-0000000000b1')$q$);
insert into r1839_res select 'pvt_book', pg_temp.r1839_err($q$select public.book_bank_txn_as_owner_equity('e1839000-0000-4000-8000-0000000000d5')$q$);
select pg_temp.r1839_as('04');
insert into r1839_res select 'firm_nopartner', pg_temp.r1839_err($q$select public.record_owner_equity_movement('drawings', '2026-10-05', 100, 'e1839000-0000-4000-8000-0000000000c1')$q$);
insert into r1839_res select 'firm_ok', public.record_owner_equity_movement('drawings', '2026-10-05', 100, 'e1839000-0000-4000-8000-0000000000c1', 'Ravi')::text;
-- 7. the firm cannot reach the proprietor's entry or line
insert into r1839_res select 'cross_del',  pg_temp.r1839_err($q$select public.delete_owner_equity_movement((select v::uuid from r1839_res where k = 'm2'))$q$);
insert into r1839_res select 'cross_book', pg_temp.r1839_err($q$select public.book_bank_txn_as_owner_equity('e1839000-0000-4000-8000-0000000000d4', 'Ravi')$q$);
insert into r1839_res select 'cross_read', (select count(*)::text from public.owner_equity_movements);
do $$
begin
  if (select v from r1839_res where k = 'pvt_rec')  not like '%Pvt Ltd%' then raise exception 'FAIL 6a pvt record: %', (select v from r1839_res where k = 'pvt_rec'); end if;
  if (select v from r1839_res where k = 'pvt_book') not like '%Pvt Ltd%' then raise exception 'FAIL 6b pvt book: %', (select v from r1839_res where k = 'pvt_book'); end if;
  if (select v from r1839_res where k = 'firm_nopartner') not like '%partner%' then raise exception 'FAIL 6c partner: %', (select v from r1839_res where k = 'firm_nopartner'); end if;
  if (select partner_name from public.owner_equity_movements where id = (select v::uuid from r1839_res where k = 'firm_ok')) <> 'Ravi' then raise exception 'FAIL 6d partner saved'; end if;
  if (select v from r1839_res where k = 'cross_del')  not like '%not in your company%' then raise exception 'FAIL 7a cross delete: %', (select v from r1839_res where k = 'cross_del'); end if;
  if (select v from r1839_res where k = 'cross_book') not like '%not found in your company%' then raise exception 'FAIL 7b cross book: %', (select v from r1839_res where k = 'cross_book'); end if;
end $$;

-- 7c. RLS: the firm's accountant reads only the firm's entry (run as authenticated).
select pg_temp.r1839_as('04');
set local role authenticated;
do $$ begin
  if (select count(*) from public.owner_equity_movements) <> 1 then raise exception 'FAIL 7c RLS: firm sees % entries', (select count(*) from public.owner_equity_movements); end if;
end $$;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1839000-0000-4000-8000-000000000002')::text, true);
do $$ begin
  if (select count(*) from public.owner_equity_movements) <> 0 then raise exception 'FAIL 7d RLS: sales sees entries'; end if;
end $$;
reset role;

-- 8. P&L unchanged
select pg_temp.r1839_as('01');
do $$ begin
  if (select v from r1839_res where k = 'pnl_before')
     is distinct from (select row_to_json(x)::text from public.report_pnl('2026-04-01', '2027-03-31') x limit 1) then
    raise exception 'FAIL 8 P&L moved: % → %', (select v from r1839_res where k = 'pnl_before'),
      (select row_to_json(x)::text from public.report_pnl('2026-04-01', '2027-03-31') x limit 1);
  end if;
end $$;

select 'PASS r1839' as result;

rollback;
