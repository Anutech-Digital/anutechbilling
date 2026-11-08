-- R-2604 (8 Nov 2026): owner tool that moves old Balance Sheet "Advance/loan given|returned · <name>" rows
-- into Accounting → Loans given (or Employee loans for an employee the owner confirms).
-- Migration 20261108093000_r2604_move_bs_loans (on R-2603, R-2570, R-2340, R-1873).
-- Self-asserting, ONE transaction, rolled back. Local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. Sales user refused (preview + apply); nothing written.
--   B. Check first: groups by name ignoring case/spaces (Aakash Deep + 'aakash  deep' → one, net of a
--      return), employee suggested by first name ('Pardeep' → Pardeep Sharma), open one_shot loan → merge,
--      net 0 and no-name skipped; total before = after.
--   C. Apply with a stale expected total → refused, nothing moved.
--   D. Apply: one loan per person (net), Suman (no bank line) moved, Vinod ADDED to his open loan,
--      Pardeep → Employee loans (Pardeep Sharma), lines matched to the loans, BS rows gone (skipped stay),
--      stores total unchanged, 4 audit rows, other company untouched.
--   E. Second run = no-op.
--   F. Un-reconcile / delete a moved line → refused; deleting the loan frees its moved lines.

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

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000260401','R2604 Co','r2604@example.in','07','R2604'),
  ('dddddddd-0000-0000-0000-000000260402','R2604 Other','r2604b@example.in','07','R2604B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000260401','owner2604@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000260402','sales2604@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000260401','dddddddd-0000-0000-0000-000000260401','owner2604@example.in','Owner 2604','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000260402','dddddddd-0000-0000-0000-000000260401','sales2604@example.in','Sales 2604','sales', now() - interval '1 day');
insert into public.employees (id, tenant_id, name) values
  ('eeeeeeee-0000-0000-0000-000000260401','dddddddd-0000-0000-0000-000000260401','Pardeep Sharma'),
  ('eeeeeeee-0000-0000-0000-000000260402','dddddddd-0000-0000-0000-000000260401','Ravi Kumar');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000260401','dddddddd-0000-0000-0000-000000260401','HDFC Current','HDFC', 5000000),
  ('bbbbbbbb-0000-0000-0000-000000260402','dddddddd-0000-0000-0000-000000260402','Other bank','SBI', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000260401','dddddddd-0000-0000-0000-000000260401','bbbbbbbb-0000-0000-0000-000000260401','2026-06-05','IMPS AAKASH',100000,0,'A1','csv_upload'),
  ('22222222-0000-0000-0000-000000260402','dddddddd-0000-0000-0000-000000260401','bbbbbbbb-0000-0000-0000-000000260401','2026-06-20','IMPS AAKASH 2',50000,0,'A2','csv_upload'),
  ('22222222-0000-0000-0000-000000260403','dddddddd-0000-0000-0000-000000260401','bbbbbbbb-0000-0000-0000-000000260401','2026-07-01','NEFT CR AAKASH',0,30000,'A3','csv_upload'),
  ('22222222-0000-0000-0000-000000260404','dddddddd-0000-0000-0000-000000260401','bbbbbbbb-0000-0000-0000-000000260401','2026-05-10','IMPS PARDEEP',800000,0,'P1','csv_upload'),
  ('22222222-0000-0000-0000-000000260405','dddddddd-0000-0000-0000-000000260401','bbbbbbbb-0000-0000-0000-000000260401','2026-08-02','IMPS VINOD',40000,0,'V1','csv_upload'),
  ('22222222-0000-0000-0000-000000260406','dddddddd-0000-0000-0000-000000260402','bbbbbbbb-0000-0000-0000-000000260402','2026-06-05','IMPS OTHER',70000,0,'Z1','csv_upload');
insert into public.balance_sheet_items (id, tenant_id, section, label, amount, bank_txn_id) values
  ('cccccccc-0000-0000-0000-000000260401','dddddddd-0000-0000-0000-000000260401','asset','Advance/loan given · Aakash Deep',100000,'22222222-0000-0000-0000-000000260401'),
  ('cccccccc-0000-0000-0000-000000260402','dddddddd-0000-0000-0000-000000260401','asset','Advance/loan given · aakash  deep',50000,'22222222-0000-0000-0000-000000260402'),
  ('cccccccc-0000-0000-0000-000000260403','dddddddd-0000-0000-0000-000000260401','asset','Advance/loan returned · Aakash Deep',-30000,'22222222-0000-0000-0000-000000260403'),
  ('cccccccc-0000-0000-0000-000000260404','dddddddd-0000-0000-0000-000000260401','asset','Advance/loan given · Suman Rani',200000,null),
  ('cccccccc-0000-0000-0000-000000260405','dddddddd-0000-0000-0000-000000260401','asset','Advance/loan given · Pardeep',800000,'22222222-0000-0000-0000-000000260404'),
  ('cccccccc-0000-0000-0000-000000260406','dddddddd-0000-0000-0000-000000260401','asset','Advance/loan given · Vinod',40000,'22222222-0000-0000-0000-000000260405'),
  ('cccccccc-0000-0000-0000-000000260407','dddddddd-0000-0000-0000-000000260401','asset','Advance/loan given · Rajeev',5000,null),
  ('cccccccc-0000-0000-0000-000000260408','dddddddd-0000-0000-0000-000000260401','asset','Advance/loan returned · rajeev',-5000,null),
  ('cccccccc-0000-0000-0000-000000260409','dddddddd-0000-0000-0000-000000260401','asset','Advance/loan given',1000,null),
  ('cccccccc-0000-0000-0000-000000260410','dddddddd-0000-0000-0000-000000260401','asset','Office deposit',25000,null),
  ('cccccccc-0000-0000-0000-000000260411','dddddddd-0000-0000-0000-000000260402','asset','Advance/loan given · Aakash Deep',70000,'22222222-0000-0000-0000-000000260406');
update public.bank_transactions t set matched_to_type = 'bs_item', matched_to_id = b.id::text, match_confidence = 'manual', matched_at = now()
  from public.balance_sheet_items b where b.bank_txn_id = t.id and b.id::text like 'cccccccc-0000-0000-0000-0000002604%';
insert into public.loans_given (id, tenant_id, borrower_name, principal, given_on, repayment_plan, status) values
  ('99999999-0000-0000-0000-000000260401','dddddddd-0000-0000-0000-000000260401','VINOD',10000,'2026-09-01','one_shot','open');

-- ── A. Sales user refused ───────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000260402","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.preview_bs_loan_move();
    raise exception 'FAIL A: sales preview accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Only the owner or the accountant%' then raise exception 'FAIL A: wrong refusal: %', sqlerrm; end if;
  end;
  begin
    perform public.apply_bs_loan_move('{}'::jsonb, 1160000);
    raise exception 'FAIL A: sales apply accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Only the owner or the accountant%' then raise exception 'FAIL A: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000260401","role":"authenticated"}', true);

-- ── B. Check first ──────────────────────────────────────────────────────────────────────
do $$
declare v jsonb := public.preview_bs_loan_move(); g jsonb;
begin
  if (v->>'movable_net')::bigint <> 1160000 then raise exception 'FAIL B: movable_net %', v->>'movable_net'; end if;
  if (v->>'total_before') <> (v->>'total_after') then raise exception 'FAIL B: totals differ %', v; end if;
  if jsonb_array_length(v->'groups') <> 6 then raise exception 'FAIL B: % groups', jsonb_array_length(v->'groups'); end if;
  select x into g from jsonb_array_elements(v->'groups') x where x->>'key' = 'aakash deep';
  if g is null or (g->>'net')::int <> 120000 or (g->>'given')::int <> 150000 or (g->>'returned')::int <> 30000
     or g->>'target' <> 'loan_given' or (g->>'lines')::int <> 3 or g->>'name' <> 'Aakash Deep' then
    raise exception 'FAIL B: aakash group %', g;
  end if;
  select x into g from jsonb_array_elements(v->'groups') x where x->>'key' = 'pardeep';
  if g->>'target' <> 'employee' or g->'employee'->>'name' <> 'Pardeep Sharma' then raise exception 'FAIL B: pardeep group %', g; end if;
  select x into g from jsonb_array_elements(v->'groups') x where x->>'key' = 'vinod';
  if g->'merge_loan'->>'id' <> '99999999-0000-0000-0000-000000260401' or g->>'name' <> 'VINOD' then raise exception 'FAIL B: vinod group %', g; end if;
  select x into g from jsonb_array_elements(v->'groups') x where x->>'key' = 'rajeev';
  if g->>'target' <> 'skip' then raise exception 'FAIL B: rajeev not skipped %', g; end if;
  select x into g from jsonb_array_elements(v->'groups') x where x->>'key' = '';
  if g->>'target' <> 'skip' then raise exception 'FAIL B: no-name not skipped %', g; end if;
end $$;

-- ── C. Stale Check first → refused ──────────────────────────────────────────────────────
do $$
begin
  begin
    perform public.apply_bs_loan_move('{"pardeep":"eeeeeeee-0000-0000-0000-000000260401"}'::jsonb, 999);
    raise exception 'FAIL C: stale total accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'The Balance Sheet loan lines changed since Check first%' then raise exception 'FAIL C: wrong refusal: %', sqlerrm; end if;
  end;
  begin
    perform public.apply_bs_loan_move('{"pardeep":"eeeeeeee-0000-0000-0000-000000999999"}'::jsonb, 1160000);
    raise exception 'FAIL C: foreign employee accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'The employee picked for%' then raise exception 'FAIL C: wrong refusal (employee): %', sqlerrm; end if;
  end;
  if (select count(*) from public.balance_sheet_items where tenant_id = 'dddddddd-0000-0000-0000-000000260401') <> 10
     or exists (select 1 from public.bs_loan_moves where tenant_id = 'dddddddd-0000-0000-0000-000000260401') then
    raise exception 'FAIL C: a refused apply moved something';
  end if;
end $$;

-- ── D. Apply ────────────────────────────────────────────────────────────────────────────
create temp table r2604_res as
  select public.apply_bs_loan_move('{"pardeep":"eeeeeeee-0000-0000-0000-000000260401"}'::jsonb, 1160000) as r;
grant all on r2604_res to public;

do $$
declare
  v jsonb := (select r from r2604_res);
  v_l public.loans_given; v_e public.employee_loans; v_n int;
begin
  if (v->>'total_before') <> (v->>'total_after') or (v->>'moved_net')::bigint <> 1160000 then raise exception 'FAIL D: result %', v; end if;
  -- Aakash: one loan, net, first date, first spelling, no bank_txn_id; 3 lines matched to it
  select * into v_l from public.loans_given where tenant_id = 'dddddddd-0000-0000-0000-000000260401' and lower(borrower_name) = 'aakash deep';
  get diagnostics v_n = row_count;
  if v_n <> 1 or v_l.principal <> 120000 or v_l.given_on <> '2026-06-05' or v_l.borrower_name <> 'Aakash Deep'
     or v_l.bank_txn_id is not null or v_l.repayment_plan <> 'one_shot' or v_l.status <> 'open' then
    raise exception 'FAIL D: aakash loan %', row_to_json(v_l);
  end if;
  if (select count(*) from public.bank_transactions where id in ('22222222-0000-0000-0000-000000260401','22222222-0000-0000-0000-000000260402','22222222-0000-0000-0000-000000260403')
        and matched_to_type = 'loan_given' and matched_to_id = v_l.id::text) <> 3 then
    raise exception 'FAIL D: aakash lines not matched to the loan';
  end if;
  -- Suman: no line
  if (select principal from public.loans_given where tenant_id = 'dddddddd-0000-0000-0000-000000260401' and borrower_name = 'Suman Rani') is distinct from 200000 then
    raise exception 'FAIL D: suman loan';
  end if;
  -- Vinod: added to the open loan, no second loan
  if (select count(*) from public.loans_given where tenant_id = 'dddddddd-0000-0000-0000-000000260401' and lower(borrower_name) = 'vinod') <> 1
     or (select principal from public.loans_given where id = '99999999-0000-0000-0000-000000260401') <> 50000 then
    raise exception 'FAIL D: vinod not merged';
  end if;
  if (select matched_to_id from public.bank_transactions where id = '22222222-0000-0000-0000-000000260405') <> '99999999-0000-0000-0000-000000260401' then
    raise exception 'FAIL D: vinod line not on his loan';
  end if;
  -- Pardeep → employee loan
  select * into v_e from public.employee_loans where tenant_id = 'dddddddd-0000-0000-0000-000000260401';
  if v_e.employee_name <> 'Pardeep Sharma' or v_e.principal <> 800000 or v_e.bank_txn_id is not null or v_e.bank_account_id is not null then
    raise exception 'FAIL D: employee loan %', row_to_json(v_e);
  end if;
  if (select matched_to_type || ':' || matched_to_id from public.bank_transactions where id = '22222222-0000-0000-0000-000000260404') <> 'employee_loan:' || v_e.id then
    raise exception 'FAIL D: pardeep line not on the employee loan';
  end if;
  if exists (select 1 from public.loans_given where tenant_id = 'dddddddd-0000-0000-0000-000000260401' and lower(borrower_name) like 'pardeep%') then
    raise exception 'FAIL D: pardeep also on Loans given';
  end if;
  -- BS: only the skipped rows + the unrelated one stay
  if (select string_agg(id::text, ',' order by id) from public.balance_sheet_items where tenant_id = 'dddddddd-0000-0000-0000-000000260401')
     <> 'cccccccc-0000-0000-0000-000000260407,cccccccc-0000-0000-0000-000000260408,cccccccc-0000-0000-0000-000000260409,cccccccc-0000-0000-0000-000000260410' then
    raise exception 'FAIL D: wrong BS rows left';
  end if;
  if (select count(*) from public.bs_loan_moves where tenant_id = 'dddddddd-0000-0000-0000-000000260401') <> 4
     or not exists (select 1 from public.bs_loan_moves where person_key = 'vinod' and merged) then
    raise exception 'FAIL D: audit rows';
  end if;
  -- other company untouched
  if not exists (select 1 from public.balance_sheet_items where id = 'cccccccc-0000-0000-0000-000000260411')
     or (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000260406') <> 'bs_item' then
    raise exception 'FAIL D: other company touched';
  end if;
  if public.loans_given_asset() <> 120000 + 200000 + 50000 then
    raise exception 'FAIL D: loans given asset %', public.loans_given_asset();
  end if;
end $$;

-- ── E. Second run = no-op ───────────────────────────────────────────────────────────────
do $$
declare v jsonb := public.apply_bs_loan_move('{}'::jsonb, 0);
begin
  if not (v->>'nothing_to_move')::boolean then raise exception 'FAIL E: second run moved %', v; end if;
  if (select count(*) from public.bs_loan_moves where tenant_id = 'dddddddd-0000-0000-0000-000000260401') <> 4 then raise exception 'FAIL E: audit grew'; end if;
end $$;

-- ── F. Undo guards ──────────────────────────────────────────────────────────────────────
do $$
declare v_id uuid := (select id from public.loans_given where tenant_id = 'dddddddd-0000-0000-0000-000000260401' and borrower_name = 'Aakash Deep');
begin
  begin
    perform public.reconcile_bank_txn('22222222-0000-0000-0000-000000260402', null, null, null);
    raise exception 'FAIL F: un-reconcile accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This line was moved from the Balance Sheet into the loan to Aakash Deep%' then raise exception 'FAIL F: wrong refusal: %', sqlerrm; end if;
  end;
  begin
    perform public.reconcile_bank_txn('22222222-0000-0000-0000-000000260404', null, null, null);
    raise exception 'FAIL F: employee line un-reconcile accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This line was moved from the Balance Sheet into the loan to Pardeep Sharma%' then raise exception 'FAIL F: wrong refusal (emp): %', sqlerrm; end if;
  end;
  begin
    delete from public.bank_transactions where id = '22222222-0000-0000-0000-000000260401';
    raise exception 'FAIL F: delete accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This line was moved from the Balance Sheet%' then raise exception 'FAIL F: wrong refusal (delete): %', sqlerrm; end if;
  end;
  perform public.delete_loan_given(v_id);
  if exists (select 1 from public.bank_transactions where id in ('22222222-0000-0000-0000-000000260401','22222222-0000-0000-0000-000000260402','22222222-0000-0000-0000-000000260403')
              and matched_to_type is not null) then
    raise exception 'FAIL F: deleting the loan left its moved lines matched';
  end if;
  if (select count(*) from public.bank_transactions where id in ('22222222-0000-0000-0000-000000260401','22222222-0000-0000-0000-000000260402','22222222-0000-0000-0000-000000260403')) <> 3 then
    raise exception 'FAIL F: deleting the loan deleted a statement line';
  end if;
  perform public.delete_employee_loan((select id from public.employee_loans where tenant_id = 'dddddddd-0000-0000-0000-000000260401'));
  if (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000260404') is not null
     or exists (select 1 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000260401' and description like 'Correction%') then
    raise exception 'FAIL F: employee loan delete did not free the line cleanly';
  end if;
end $$;

do $$ begin raise notice 'R-2604 ALL PASS'; end $$;

rollback;
