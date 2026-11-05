-- R-2483 (5 Nov 2026) — independent money review 5 (Anutech-HQ/drafts/REVIEWS/2026-11-05-money-cards-5.md).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r2483_review5_money_fixes.test.sql
--
--   F-1 (p2, R-2470): the below-cost measure read the cost from the line_items the rep writes. One write
--       "header discount 60% + line cost 0" on an approved quote went back to pending with
--       below_cost = false, so a bank receipt invoiced ₹1,29,600 taxable against ₹1,86,000 cost (the
--       reviewer's Q-1111-27-0001 case). Now, for a login's update, each line's cost is at least the cost
--       it had before (matched by line id, else item, else name), and a cost lowered by a login on an
--       approved quote marks it below cost — owner approval before any money — and that mark stays
--       until the owner approves (so the two-write variant fails too). A header-cut below-cost mark can
--       no longer be taken off by a later login write either (the R-2447 refusal measured only lines).
--   F-2 (p3, R-2407): reconcile_salary_with_owed_back refuses a salary already 'paid' (R-885 marks
--       salaries paid with paid_amount 0).
--   F-3 (p3, R-2469): release_stale_team_invite counts calls per login in SQL — over 30 an hour it is
--       refused, so a direct browser RPC cannot probe addresses without limit.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

create function pg_temp.r2483_login(p_uid text) returns text language sql as $l$
  select set_config('request.jwt.claims', case when p_uid is null then '' else
           json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true)
$l$;

create function pg_temp.r2483_err(p_sql text) returns text language plpgsql as $e$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlerrm;
end $e$;

-- The reviewer's quote: 25 seats × ₹12,960 (list ₹12,960), cost ₹7,440 each = ₹1,86,000.
create function pg_temp.r2483_lines(p_cost int, p_id text default 'l1', p_name text default 'Google Workspace Business Plus')
returns jsonb language sql as $f$
  select jsonb_build_array(jsonb_build_object('id', p_id, 'name', p_name, 'qty', 25,
           'rate', 12960, 'list_rate', 12960, 'cost', p_cost, 'commitment', 'annual_yearly'))
$f$;

-- An APPROVED quote, signed by the manager with no trigger (as in the r2470 test).
create function pg_temp.r2483_quote(p_id text, p_status text default 'approved') returns void
language plpgsql as $q$
begin
  insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                             discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                             approval_status, approval_tier)
  values (p_id, 'dddddddd-0000-0000-0000-000000248301', 'cccccccc-0000-0000-0000-000000248301', 'Cust 2483',
          'Google Workspace Business Plus', 25, 382320, 324000, 186000, 0, 18, 'sent', 'yearly',
          pg_temp.r2483_lines(7440), false, '2026-11-05', 'pending', 'manager');
  alter table public.quotes disable trigger trg_quote_approval_not_by_maker;
  if p_status = 'approved' then
    update public.quotes set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000248303',
           approved_at = now() - interval '1 hour', approved_discount_bps = 0, approved_margin_bps = 4259 where id = p_id;
  else
    update public.quotes set approval_status = p_status::public.quote_approval_status, approval_tier = null where id = p_id;
  end if;
  alter table public.quotes enable trigger trg_quote_approval_not_by_maker;
end $q$;

create function pg_temp.r2483_pay(p_id text) returns text language sql as $p$
  select pg_temp.r2483_err(format(
    'insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference) '
    'values (''dddddddd-0000-0000-0000-000000248301'', %L, ''cccccccc-0000-0000-0000-000000248301'', 1000, ''cash'', %L)',
    p_id, 'C' || p_id))
$p$;

select pg_temp.r2483_login(null);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000248301','R2483 Co','r2483@example.in','07','R2483');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000248301','own2483@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000248303','mgr2483@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000248304','sales2483@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000248301','dddddddd-0000-0000-0000-000000248301','own2483@example.in','Owner','owner', true, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000248303','dddddddd-0000-0000-0000-000000248301','mgr2483@example.in','Manager','manager', true, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000248304','dddddddd-0000-0000-0000-000000248301','sales2483@example.in','Sales','sales', true, now() - interval '30 days');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000248301','dddddddd-0000-0000-0000-000000248301','Cust 2483','07','c2483.in');

select pg_temp.r2483_quote('Q-R2483-B1');               -- F-1 case B: one write
select pg_temp.r2483_quote('Q-R2483-B2');               -- F-1 two writes: cost first, then the header
select pg_temp.r2483_quote('Q-R2483-B3');               -- F-1 line swapped for a new id with cost 0
select pg_temp.r2483_quote('Q-R2483-H1', 'not_required'); -- header-cut mark cleared by a later write
select pg_temp.r2483_quote('Q-R2483-N1');               -- control: price raised keeps approval
select pg_temp.r2483_quote('Q-R2483-N2', 'not_required'); -- control: unsigned quote, cost corrected down
select pg_temp.r2483_quote('Q-R2483-U1');               -- un-approve first, then cost, then header
select pg_temp.r2483_quote('Q-R2483-M1');               -- control: annual → monthly flex is not a cost cut
select pg_temp.r2483_quote('Q-R2483-R1', 'pending');    -- an old cost cut, approved again since
-- R1: below cost marked; a cost cut 60 days ago, then an approval_reset naming the approver 30 days ago
-- (the quote had been approved again), now healthy and pending.
update public.quotes set below_cost = true where id = 'Q-R2483-R1';
insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes, created_at) values
  ('dddddddd-0000-0000-0000-000000248301', 'aaaaaaaa-0000-0000-0000-000000248304', 'quote.cost_lowered', 'quote', 'Q-R2483-R1',
   'old cut', '{}'::jsonb, now() - interval '60 days'),
  ('dddddddd-0000-0000-0000-000000248301', 'aaaaaaaa-0000-0000-0000-000000248304', 'quote.approval_reset', 'quote', 'Q-R2483-R1',
   'later reset', jsonb_build_object('was_approved_by', 'aaaaaaaa-0000-0000-0000-000000248301'), now() - interval '30 days');

select pg_temp.r2483_login('aaaaaaaa-0000-0000-0000-000000248304');   -- the sales login (a rep)

-- ── F-1 case B (the reviewer's proof): header discount 60% + line cost 0 in ONE write ──────────
update public.quotes set discount_pct = 60, line_items = pg_temp.r2483_lines(0) where id = 'Q-R2483-B1';
do $$
declare v_q record; v_msg text := pg_temp.r2483_pay('Q-R2483-B1');
begin
  select * into v_q from public.quotes where id = 'Q-R2483-B1';
  if v_q.approval_status::text <> 'pending' or not coalesce(v_q.below_cost, false) or v_q.approval_tier::text <> 'owner' then
    raise exception 'FAIL F1-B: header cut + cost 0 → status %, below_cost %, tier %', v_q.approval_status, v_q.below_cost, v_q.approval_tier;
  end if;
  if v_msg not like 'This quote is below cost and waits for the owner''s approval.%' then
    raise exception 'FAIL F1-B: money on the cut quote: %', v_msg;
  end if;
  raise notice 'PASS F1-B: header cut + zeroed line cost in one write is below cost; money waits';
end $$;

-- ── F-1 two writes: zero the cost (approval resets), then cut the header, then try to clear ──────
update public.quotes set line_items = pg_temp.r2483_lines(0) where id = 'Q-R2483-B2';
do $$
declare v_q record;
begin
  select * into v_q from public.quotes where id = 'Q-R2483-B2';
  if v_q.approval_status::text <> 'pending' or not coalesce(v_q.below_cost, false) or v_q.approval_tier::text <> 'owner' then
    raise exception 'FAIL F1-2a: a login lowered the cost on an approved quote → status %, below_cost %, tier %',
      v_q.approval_status, v_q.below_cost, v_q.approval_tier;
  end if;
  if not exists (select 1 from public.activity_log where entity_id = 'Q-R2483-B2' and action = 'quote.approval_reset'
                    and changes->>'cost_lowered' = 'true') then
    raise exception 'FAIL F1-2a: no approval_reset line saying the cost was lowered';
  end if;
end $$;
update public.quotes set discount_pct = 60 where id = 'Q-R2483-B2';
do $$
declare v_msg text;
begin
  v_msg := pg_temp.r2483_err('update public.quotes set below_cost = false where id = ''Q-R2483-B2''');
  if v_msg not like 'Quote Q-R2483-B2 is below cost%' then
    raise exception 'FAIL F1-2b: a login cleared the mark after a cost cut: %', v_msg;
  end if;
  v_msg := pg_temp.r2483_pay('Q-R2483-B2');
  if v_msg not like 'This quote is below cost and waits for the owner''s approval.%' then
    raise exception 'FAIL F1-2b: money on the cut quote after two writes: %', v_msg;
  end if;
  raise notice 'PASS F1-2: cost cut first, header cut second — still below cost, mark cannot be cleared, money waits';
end $$;

-- ── F-1 line swap: same product under a new line id with cost 0 + header cut ──────────────────
update public.quotes set discount_pct = 60, line_items = pg_temp.r2483_lines(0, 'l2') where id = 'Q-R2483-B3';
do $$
begin
  if not (select coalesce(below_cost, false) from public.quotes where id = 'Q-R2483-B3') then
    raise exception 'FAIL F1-3: a line swapped for a new id with cost 0 escaped the cost floor';
  end if;
  raise notice 'PASS F1-3: a swapped line keeps the old cost (matched by name)';
end $$;

-- ── header-cut mark cannot be cleared by a later login write (R-2447 refusal measured only lines) ──
update public.quotes set discount_pct = 60 where id = 'Q-R2483-H1';
do $$
declare v_msg text;
begin
  if not (select coalesce(below_cost, false) from public.quotes where id = 'Q-R2483-H1') then
    raise exception 'FAIL H1: a header cut under cost was not marked (R-2470 regression)';
  end if;
  v_msg := pg_temp.r2483_err('update public.quotes set below_cost = false where id = ''Q-R2483-H1''');
  if v_msg not like 'Quote Q-R2483-H1 is below cost%' then
    raise exception 'FAIL H1: a login cleared the header below-cost mark: %', v_msg;
  end if;
  raise notice 'PASS H1: the header below-cost mark stays while the header is under cost';
end $$;

-- ── un-approve first (status off 'approved' is logged), then zero the cost, then cut the header ──
update public.quotes set approval_status = 'pending', approved_by = null where id = 'Q-R2483-U1';
update public.quotes set line_items = pg_temp.r2483_lines(0) where id = 'Q-R2483-U1';
update public.quotes set discount_pct = 60 where id = 'Q-R2483-U1';
do $$
declare v_msg text := pg_temp.r2483_pay('Q-R2483-U1');
begin
  if not exists (select 1 from public.activity_log where entity_id = 'Q-R2483-U1' and action = 'quote.approval_reset'
                    and changes->>'was_approved_by' = 'aaaaaaaa-0000-0000-0000-000000248303') then
    raise exception 'FAIL U1: moving an approved quote off Approved left no approval_reset naming the approver';
  end if;
  if not (select coalesce(below_cost, false) from public.quotes where id = 'Q-R2483-U1') then
    raise exception 'FAIL U1: un-approve, cost 0, header cut → not below cost';
  end if;
  if v_msg not like 'This quote is below cost and waits for the owner''s approval.%' then
    raise exception 'FAIL U1: money on the cut quote: %', v_msg;
  end if;
  raise notice 'PASS U1: un-approving first does not hide a later cost cut';
end $$;

-- ── a cost cut that was approved again since no longer locks the mark ───────────────────────
do $$
declare v_msg text := pg_temp.r2483_err('update public.quotes set below_cost = false where id = ''Q-R2483-R1''');
begin
  if v_msg <> 'OK' then
    raise exception 'FAIL R1: an old cost cut, approved again since, still blocks clearing a healthy quote: %', v_msg;
  end if;
  raise notice 'PASS R1: only a cost cut not approved since keeps the mark';
end $$;

-- ── controls ─────────────────────────────────────────────────────────────────────────────
-- M1: the same line moved to monthly flex (₹1,200 / month, cost ₹650 / month = ₹7,800 a year ≥ ₹7,440)
update public.quotes set line_items = jsonb_build_array(jsonb_build_object('id', 'l1', 'name', 'Google Workspace Business Plus',
         'qty', 25, 'rate', 1200, 'list_rate', 1200, 'cost', 650, 'commitment', 'monthly')) where id = 'Q-R2483-M1';
do $$
begin
  if (select approval_status::text <> 'approved' or coalesce(below_cost, false) from public.quotes where id = 'Q-R2483-M1') then
    raise exception 'FAIL M1: annual → monthly flex (cost per month) was read as a cost cut';
  end if;
  raise notice 'PASS M1: costs are compared per year';
end $$;

update public.quotes set amount = 389700, subtotal = 330250,
       line_items = jsonb_set(pg_temp.r2483_lines(7440), '{0,rate}', '13210') where id = 'Q-R2483-N1';
update public.quotes set line_items = pg_temp.r2483_lines(7000) where id = 'Q-R2483-N2';
do $$
begin
  if (select approval_status::text <> 'approved' or coalesce(below_cost, false) from public.quotes where id = 'Q-R2483-N1') then
    raise exception 'FAIL N1: raising the price lost the approval or marked below cost';
  end if;
  if (select coalesce(below_cost, false) from public.quotes where id = 'Q-R2483-N2') then
    raise exception 'FAIL N2: a cost corrected down on an unsigned healthy quote was marked below cost';
  end if;
  if pg_temp.r2483_pay('Q-R2483-N2') <> 'OK' then
    raise exception 'FAIL N2: money refused on a healthy unsigned quote';
  end if;
  raise notice 'PASS N: price rise keeps approval; a cost fix on an unsigned healthy quote is not blocked';
end $$;

-- ═══ F-2: reconcile_salary_with_owed_back refuses a salary R-885 already marked 'paid' ═══════
select pg_temp.r2483_login(null);
insert into public.employees (id, tenant_id, name, is_active) values
  ('e2483000-0000-4000-8000-0000000000e1', 'dddddddd-0000-0000-0000-000000248301', 'Neelam R2483', true);
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('e2483000-0000-4000-8000-0000000000a1', 'dddddddd-0000-0000-0000-000000248301', 'HDFC Current', 'HDFC', 'current', 100000, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('e2483000-0000-4000-8000-0000000000d1', 'dddddddd-0000-0000-0000-000000248301', 'e2483000-0000-4000-8000-0000000000a1', '2026-10-31', 'NEFT SALARIES OCT (R-885 batch)', 30000, 0, 'csv_upload'),
  ('e2483000-0000-4000-8000-0000000000d2', 'dddddddd-0000-0000-0000-000000248301', 'e2483000-0000-4000-8000-0000000000a1', '2026-11-01', 'NEFT NEELAM R2483', 46000, 0, 'csv_upload');
-- as reconcile_salaries_to_bank_txn (R-885) leaves it: paid, paid_amount 0, linked to its line
insert into public.salary_payments (id, tenant_id, employee_id, period, gross, net, pay_date, paid_status, paid_amount, reconciled_txn_id) values
  ('e2483000-0000-4000-8000-0000000000c1', 'dddddddd-0000-0000-0000-000000248301', 'e2483000-0000-4000-8000-0000000000e1', '2026-10', 30000, 30000, '2026-10-31', 'paid', 0, 'e2483000-0000-4000-8000-0000000000d1');
insert into public.reimbursements (id, tenant_id, person_name, purpose, amount, incurred_on, status, employee_id) values
  ('e2483000-0000-4000-8000-0000000000f1', 'dddddddd-0000-0000-0000-000000248301', 'Neelam R2483', 'Paid to the company by mistake', 16000, '2026-10-26', 'pending', 'e2483000-0000-4000-8000-0000000000e1');

select pg_temp.r2483_login('aaaaaaaa-0000-0000-0000-000000248301');
do $$
declare v_msg text;
begin
  v_msg := pg_temp.r2483_err($s$select public.reconcile_salary_with_owed_back('e2483000-0000-4000-8000-0000000000d2',
             'e2483000-0000-4000-8000-0000000000c1', 'e2483000-0000-4000-8000-0000000000f1')$s$);
  if v_msg not like '%already paid%' then
    raise exception 'FAIL F2: a salary already paid by R-885 was paid again: %', v_msg;
  end if;
  if (select reconciled_txn_id from public.salary_payments where id = 'e2483000-0000-4000-8000-0000000000c1')
       <> 'e2483000-0000-4000-8000-0000000000d1'
     or (select matched_to_type from public.bank_transactions where id = 'e2483000-0000-4000-8000-0000000000d2') is not null then
    raise exception 'FAIL F2: the refusal left changes behind';
  end if;
  raise notice 'PASS F2: a salary already marked paid is refused';
end $$;

-- ═══ F-3: release_stale_team_invite is capped per login (30 an hour) in SQL ════════════════
select pg_temp.r2483_login('aaaaaaaa-0000-0000-0000-000000248301');
do $$
declare i int; v_msg text;
begin
  for i in 1..30 loop
    v_msg := pg_temp.r2483_err(format('select public.release_stale_team_invite(%L)', 'probe' || i || '@example.test'));
    if v_msg <> 'OK' then
      raise exception 'FAIL F3: call % of 30 refused: %', i, v_msg;
    end if;
  end loop;
  v_msg := pg_temp.r2483_err('select public.release_stale_team_invite(''probe31@example.test'')');
  if v_msg not like 'Too many address checks%' then
    raise exception 'FAIL F3: the 31st check in an hour was answered: %', v_msg;
  end if;
  raise notice 'PASS F3: the 31st address check in an hour is refused';
end $$;
-- another owner of another company is not affected by this owner's count
select pg_temp.r2483_login(null);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000248302','R2483 Other','r2483b@example.in','07','R2483B');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000248311','own2483b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000248311','dddddddd-0000-0000-0000-000000248302','own2483b@example.in','Owner B','owner', true, now() - interval '30 days');
select pg_temp.r2483_login('aaaaaaaa-0000-0000-0000-000000248311');
do $$
begin
  if pg_temp.r2483_err('select public.release_stale_team_invite(''probe1@example.test'')') <> 'OK' then
    raise exception 'FAIL F3: another owner was capped by the first owner''s checks';
  end if;
  raise notice 'PASS F3b: the cap is per login';
end $$;
-- F3c: the count is per LOGIN, not per workspace — 30 checks written in another workspace still count
select pg_temp.r2483_login(null);
insert into public.activity_log (tenant_id, user_id, action, entity, label)
select 'dddddddd-0000-0000-0000-000000248301', 'aaaaaaaa-0000-0000-0000-000000248311', 'team_invite.address_checked', 'team_invite', 'x'
  from generate_series(1, 30);
select pg_temp.r2483_login('aaaaaaaa-0000-0000-0000-000000248311');
do $$
declare v_msg text := pg_temp.r2483_err('select public.release_stale_team_invite(''probe2@example.test'')');
begin
  if v_msg not like 'Too many address checks%' then
    raise exception 'FAIL F3c: checks made from another workspace were not counted: %', v_msg;
  end if;
  raise notice 'PASS F3c: the cap counts the login across workspaces';
end $$;

select pg_temp.r2483_login(null);
do $$ begin raise notice 'PASS r2483_review5_money_fixes'; end $$;

rollback;
