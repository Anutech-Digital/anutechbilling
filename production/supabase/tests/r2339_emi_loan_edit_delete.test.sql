-- R-2339 (1 Nov 2026): edit or delete a loan set up from an EMI line (R-2323 emi_purchases.kind = 'loan').
-- Migration 20261101092000_r2339_emi_loan_edit_delete (edit_emi_loan, delete_emi_loan).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example: R-2323's bike loan — ₹2,50,000 at 11%, 14 EMIs of ₹19,054 from 5 Oct 2026
-- (HDFC). The rate was typed wrong: the loan letter says 10.5%.
--
-- Proves:
--   A. A sales login can neither edit nor delete (42501); another company's owner cannot touch it.
--   B. Delete, no EMI paid, loan money = an imported money-in line (R-2341): the loan and its
--      schedule are gone, the line is unmatched again, cash unchanged; logged in activity_log.
--   C. Delete, loan money = the manual line made at set-up (R-2323 "came into an account"): that
--      line is removed too, cash back to before; logged.
--   D. Delete, "taken before these books" (the owner default): gone, no bank line touched.
--   E. Delete refused while an EMI is reconciled; nothing changes.
--   F. Edit after EMI 1: rate 10.5%, 13 EMIs left, EMI ₹19,054, lender renamed — EMI 1 (paid) and
--      its payment untouched; EMIs 2–14 = the new schedule (EMI 2: ₹2,041 interest on ₹2,33,238);
--      ₹2,33,238 still owed; the loan row carries the new rate / lender; logged with before/after.
--   G. Edit refused, nothing written: rows that do not clear what is owed, rows that do not follow
--      the new rate (11% rows sent as 10.5%), an EMI that changes mid-way, no lender, rate over 60;
--      a cleared loan has nothing left to change.

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
  ('dddddddd-0000-0000-0000-000000233901','R2339 Co','r2339@example.in','07','R2339'),
  ('dddddddd-0000-0000-0000-000000233902','R2339 Other','r2339b@example.in','07','R2339B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000233901','owner2339@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000233902','sales2339@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000233903','owner2339b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000233901','dddddddd-0000-0000-0000-000000233901','owner2339@example.in','Owner 2339','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000233902','dddddddd-0000-0000-0000-000000233901','sales2339@example.in','Sales 2339','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000233903','dddddddd-0000-0000-0000-000000233902','owner2339b@example.in','Owner 2339b','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000233901','dddddddd-0000-0000-0000-000000233901','HDFC Current','HDFC', 500000, '2025-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000233901','dddddddd-0000-0000-0000-000000233901','bbbbbbbb-0000-0000-0000-000000233901','2026-09-04','NEFT CR HDFC BANK LOAN DISB',0,250000,'D1','csv_upload'),
  ('22222222-0000-0000-0000-000000233902','dddddddd-0000-0000-0000-000000233901','bbbbbbbb-0000-0000-0000-000000233901','2026-10-05','NACH DR HDFC BANK BIKE EMI',19054,0,'N1','csv_upload');

create temp table r2339_sched as select '[{"seq":1,"due_on":"2026-10-05","emi":19054,"principal":16762,"interest":2292,"balance_after":233238},{"seq":2,"due_on":"2026-11-05","emi":19054,"principal":16916,"interest":2138,"balance_after":216322},{"seq":3,"due_on":"2026-12-05","emi":19054,"principal":17071,"interest":1983,"balance_after":199251},{"seq":4,"due_on":"2027-01-05","emi":19054,"principal":17228,"interest":1826,"balance_after":182023},{"seq":5,"due_on":"2027-02-05","emi":19054,"principal":17385,"interest":1669,"balance_after":164638},{"seq":6,"due_on":"2027-03-05","emi":19054,"principal":17545,"interest":1509,"balance_after":147093},{"seq":7,"due_on":"2027-04-05","emi":19054,"principal":17706,"interest":1348,"balance_after":129387},{"seq":8,"due_on":"2027-05-05","emi":19054,"principal":17868,"interest":1186,"balance_after":111519},{"seq":9,"due_on":"2027-06-05","emi":19054,"principal":18032,"interest":1022,"balance_after":93487},{"seq":10,"due_on":"2027-07-05","emi":19054,"principal":18197,"interest":857,"balance_after":75290},{"seq":11,"due_on":"2027-08-05","emi":19054,"principal":18364,"interest":690,"balance_after":56926},{"seq":12,"due_on":"2027-09-05","emi":19054,"principal":18532,"interest":522,"balance_after":38394},{"seq":13,"due_on":"2027-10-05","emi":19054,"principal":18702,"interest":352,"balance_after":19692},{"seq":14,"due_on":"2027-11-05","emi":19873,"principal":19692,"interest":181,"balance_after":0}]'::jsonb as s,
  -- EMIs 2..14 at 10.5% on ₹2,33,238, the bank's ₹19,054 kept (lib/accounting/loan-edit.ts)
  '[{"seq":2,"due_on":"2026-11-05","emi":19054,"principal":17013,"interest":2041,"balance_after":216225},{"seq":3,"due_on":"2026-12-05","emi":19054,"principal":17162,"interest":1892,"balance_after":199063},{"seq":4,"due_on":"2027-01-05","emi":19054,"principal":17312,"interest":1742,"balance_after":181751},{"seq":5,"due_on":"2027-02-05","emi":19054,"principal":17464,"interest":1590,"balance_after":164287},{"seq":6,"due_on":"2027-03-05","emi":19054,"principal":17616,"interest":1438,"balance_after":146671},{"seq":7,"due_on":"2027-04-05","emi":19054,"principal":17771,"interest":1283,"balance_after":128900},{"seq":8,"due_on":"2027-05-05","emi":19054,"principal":17926,"interest":1128,"balance_after":110974},{"seq":9,"due_on":"2027-06-05","emi":19054,"principal":18083,"interest":971,"balance_after":92891},{"seq":10,"due_on":"2027-07-05","emi":19054,"principal":18241,"interest":813,"balance_after":74650},{"seq":11,"due_on":"2027-08-05","emi":19054,"principal":18401,"interest":653,"balance_after":56249},{"seq":12,"due_on":"2027-09-05","emi":19054,"principal":18562,"interest":492,"balance_after":37687},{"seq":13,"due_on":"2027-10-05","emi":19054,"principal":18724,"interest":330,"balance_after":18963},{"seq":14,"due_on":"2027-11-05","emi":19129,"principal":18963,"interest":166,"balance_after":0}]'::jsonb as e;
grant select on r2339_sched to public;
create temp table r2339_ids (k text primary key, v uuid);
grant all on r2339_ids to public;
create temp table r2339_vals (k text primary key, v bigint);
grant all on r2339_vals to public;

create function pg_temp.r2339_bike(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('lender','HDFC Bank','lender_ref','BIKE','principal',250000,'interest_rate',11,
    'account_id',null,'received_on',null,'received_txn_id',null,'reconcile_txn_id',null,
    'schedule',(select s from r2339_sched)) || p_extra;
$f$;
create function pg_temp.r2339_as(p_user text) returns text language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.r2339_edit(p_id uuid, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('purchase_id', p_id, 'lender', 'HDFC Bank Ltd', 'lender_ref', 'BIKE-7', 'interest_rate', 10.5,
    'schedule', (select e from r2339_sched)) || p_extra;
$f$;

select pg_temp.r2339_as('aaaaaaaa-0000-0000-0000-000000233901');
insert into r2339_vals values
  ('cash0', (select cash_and_bank from public.report_balance_sheet('2026-12-31'))),
  ('lines0', (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000233901'));

-- ── A + B. Delete: loan money = the imported line ────────────────────────────────────────
do $$
declare v_id uuid; v_r jsonb; v_log public.activity_log;
begin
  v_id := (public.record_emi_loan_taken(pg_temp.r2339_bike(jsonb_build_object(
    'account_id','bbbbbbbb-0000-0000-0000-000000233901','received_txn_id','22222222-0000-0000-0000-000000233901'))) ->> 'purchase_id')::uuid;
  if (select matched_to_id from public.bank_transactions where id = '22222222-0000-0000-0000-000000233901') is distinct from v_id::text then
    raise exception 'FAIL B: set-up did not match the imported line';
  end if;

  -- A. sales login refused; another company's owner refused
  perform pg_temp.r2339_as('aaaaaaaa-0000-0000-0000-000000233902');
  begin
    perform public.delete_emi_loan(v_id);
    raise exception 'FAIL A: sales deleted a loan';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlstate <> '42501' then raise exception 'FAIL A: wrong refusal for sales delete: % %', sqlstate, sqlerrm; end if;
  end;
  begin
    perform public.edit_emi_loan(pg_temp.r2339_edit(v_id));
    raise exception 'FAIL A: sales edited a loan';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlstate <> '42501' then raise exception 'FAIL A: wrong refusal for sales edit: % %', sqlstate, sqlerrm; end if;
  end;
  perform pg_temp.r2339_as('aaaaaaaa-0000-0000-0000-000000233903');
  begin
    perform public.delete_emi_loan(v_id);
    raise exception 'FAIL A: another company deleted the loan';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'That loan is not in your company%' then raise exception 'FAIL A: wrong refusal (other company): %', sqlerrm; end if;
  end;
  begin
    perform public.edit_emi_loan(pg_temp.r2339_edit(v_id));
    raise exception 'FAIL A: another company edited the loan';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'That loan is not in your company%' then raise exception 'FAIL A: wrong refusal (other company edit): %', sqlerrm; end if;
  end;
  perform pg_temp.r2339_as('aaaaaaaa-0000-0000-0000-000000233901');
  if not exists (select 1 from public.emi_purchases where id = v_id) then raise exception 'FAIL A: a refused delete removed the loan'; end if;

  v_r := public.delete_emi_loan(v_id);
  if v_r ->> 'money_in_line' <> 'line_unmatched' then raise exception 'FAIL B: %', v_r; end if;
  if exists (select 1 from public.emi_purchases where id = v_id) then raise exception 'FAIL B: loan still there'; end if;
  if exists (select 1 from public.emi_schedule where purchase_id = v_id) then raise exception 'FAIL B: schedule left'; end if;
  if (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000233901') is not null then
    raise exception 'FAIL B: the imported line is still matched';
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000233901') <> (select v from r2339_vals where k = 'lines0') then
    raise exception 'FAIL B: bank lines changed';
  end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) <> (select v from r2339_vals where k = 'cash0') then
    raise exception 'FAIL B: cash changed';
  end if;
  if (select emi_loans_payable from public.report_balance_sheet('2026-12-31')) <> 0 then raise exception 'FAIL B: loan still on the Balance Sheet'; end if;
  select * into v_log from public.activity_log where entity = 'emi_purchase' and entity_id = v_id::text and action = 'emi_loan_deleted';
  if not found or v_log.tenant_id <> 'dddddddd-0000-0000-0000-000000233901' or v_log.user_id is distinct from 'aaaaaaaa-0000-0000-0000-000000233901'
     or (v_log.changes ->> 'financed')::int <> 250000 or v_log.changes ->> 'money_in_line' <> 'line_unmatched' then
    raise exception 'FAIL B: activity_log %', row_to_json(v_log);
  end if;
end $$;

-- ── C. Delete: loan money = the manual line made at set-up ───────────────────────────────
do $$
declare v_id uuid; v_line uuid; v_r jsonb;
begin
  v_id := (public.record_emi_loan_taken(pg_temp.r2339_bike(jsonb_build_object(
    'account_id','bbbbbbbb-0000-0000-0000-000000233901','received_on','2026-09-04'))) ->> 'purchase_id')::uuid;
  v_line := (select received_bank_txn_id from public.emi_purchases where id = v_id);
  if (select source from public.bank_transactions where id = v_line) is distinct from 'manual' then raise exception 'FAIL C: no manual line made'; end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) <> (select v from r2339_vals where k = 'cash0') + 250000 then
    raise exception 'FAIL C: set-up did not add the cash';
  end if;
  v_r := public.delete_emi_loan(v_id);
  if v_r ->> 'money_in_line' <> 'manual_line_removed' then raise exception 'FAIL C: %', v_r; end if;
  if exists (select 1 from public.bank_transactions where id = v_line) then raise exception 'FAIL C: the manual money-in line is still there'; end if;
  if exists (select 1 from public.emi_purchases where id = v_id) then raise exception 'FAIL C: loan still there'; end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) <> (select v from r2339_vals where k = 'cash0') then
    raise exception 'FAIL C: cash not back to before';
  end if;
  if not exists (select 1 from public.activity_log where entity_id = v_id::text and action = 'emi_loan_deleted'
                  and changes ->> 'money_in_line' = 'manual_line_removed') then
    raise exception 'FAIL C: not logged';
  end if;
end $$;

-- ── D. Delete: taken before these books (no bank line) ───────────────────────────────────
do $$
declare v_id uuid; v_r jsonb;
begin
  v_id := (public.record_emi_loan_taken(pg_temp.r2339_bike()) ->> 'purchase_id')::uuid;
  v_r := public.delete_emi_loan(v_id);
  if v_r ->> 'money_in_line' <> 'none' then raise exception 'FAIL D: %', v_r; end if;
  if exists (select 1 from public.emi_purchases where id = v_id) then raise exception 'FAIL D: loan still there'; end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000233901') <> (select v from r2339_vals where k = 'lines0') then
    raise exception 'FAIL D: bank lines changed';
  end if;
end $$;

-- ── E. EMI 1 reconciled → delete refused ─────────────────────────────────────────────────
do $$
declare v_id uuid;
begin
  v_id := (public.record_emi_loan_taken(pg_temp.r2339_bike('{"reconcile_txn_id":"22222222-0000-0000-0000-000000233902"}')) ->> 'purchase_id')::uuid;
  insert into r2339_ids values ('bike', v_id);
  begin
    perform public.delete_emi_loan(v_id);
    raise exception 'FAIL E: deleted a loan with a reconciled EMI';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '1 EMI(s) of the loan from HDFC Bank are reconciled — undo them first%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
  end;
  if not exists (select 1 from public.emi_purchases where id = v_id) or (select count(*) from public.emi_schedule where purchase_id = v_id) <> 14
     or (select count(*) from public.emi_payments where purchase_id = v_id) <> 1 then
    raise exception 'FAIL E: a refused delete changed the loan';
  end if;
  insert into r2339_vals values
    ('paid_row', (select principal + interest::bigint * 1000000 from public.emi_schedule where purchase_id = v_id and seq = 1)),
    ('pays', (select count(*) from public.emi_payments where purchase_id = v_id)),
    ('exp', (select count(*) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000233901'));
end $$;

-- ── G. Edit refusals — nothing written ──────────────────────────────────────────────────
do $$
declare
  v_id uuid := (select v from r2339_ids where k = 'bike');
  v_case record;
  v_snap jsonb := (select jsonb_agg(to_jsonb(s) - 'id' - 'created_at' order by seq) from public.emi_schedule s
                    where purchase_id = (select v from r2339_ids where k = 'bike'));
begin
  for v_case in
    select * from (values
      ('does not clear', jsonb_build_object('schedule', (select jsonb_path_query_array(e, '$[0 to 11]') from r2339_sched)), 'The schedule repays ₹214275 but ₹233238 is owed%'),
      ('old 11% rows as 10.5%', jsonb_build_object('schedule', (select jsonb_path_query_array(s, '$[1 to 13]') from r2339_sched)), 'EMI 2: interest at 10.5 % a year on ₹233238 still owed is ₹2041, not ₹2138%'),
      ('EMI changes mid-way', jsonb_build_object('schedule', (select jsonb_set(e, '{3,emi}', '19055') from r2339_sched)), 'EMI 5 is ₹19055 but the EMI is ₹19054%'),
      ('no lender', '{"lender":" "}'::jsonb, 'Enter the lender%'),
      ('rate 61', '{"interest_rate":61}'::jsonb, 'Enter the interest rate%')
    ) as c(name, extra, msg)
  loop
    begin
      perform public.edit_emi_loan(pg_temp.r2339_edit(v_id, v_case.extra));
      raise exception 'FAIL G (%): accepted', v_case.name;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like v_case.msg then raise exception 'FAIL G (%): wrong refusal: %', v_case.name, sqlerrm; end if;
    end;
  end loop;
  if (select jsonb_agg(to_jsonb(s) - 'id' - 'created_at' order by seq) from public.emi_schedule s where purchase_id = v_id) is distinct from v_snap then
    raise exception 'FAIL G: a refused edit changed the schedule';
  end if;
  if (select interest_rate from public.emi_purchases where id = v_id) <> 11 or (select lender from public.emi_purchases where id = v_id) <> 'HDFC Bank' then
    raise exception 'FAIL G: a refused edit changed the loan';
  end if;
  if exists (select 1 from public.activity_log where entity_id = v_id::text and action = 'emi_loan_edited') then raise exception 'FAIL G: logged a refused edit'; end if;
end $$;

-- ── F. Edit after EMI 1 — only the unpaid part changes ──────────────────────────────────
do $$
declare v_id uuid := (select v from r2339_ids where k = 'bike'); v_r jsonb; v_p public.emi_purchases; v_log public.activity_log;
begin
  v_r := public.edit_emi_loan(pg_temp.r2339_edit(v_id));
  if (v_r ->> 'from_seq')::int <> 2 or (v_r ->> 'outstanding')::int <> 233238 or (v_r ->> 'emis_left')::int <> 13 then raise exception 'FAIL F: %', v_r; end if;
  -- paid EMI 1 untouched
  if (select principal + interest::bigint * 1000000 from public.emi_schedule where purchase_id = v_id and seq = 1) <> (select v from r2339_vals where k = 'paid_row')
     or (select emi_payment_id from public.emi_schedule where purchase_id = v_id and seq = 1) is null then
    raise exception 'FAIL F: the paid EMI changed';
  end if;
  if (select count(*) from public.emi_payments where purchase_id = v_id) <> (select v from r2339_vals where k = 'pays')
     or (select count(*) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000233901') <> (select v from r2339_vals where k = 'exp') then
    raise exception 'FAIL F: payments / interest expenses changed';
  end if;
  -- the unpaid part = the new schedule
  if (select jsonb_agg(jsonb_build_object('seq', seq, 'due_on', due_on, 'emi', emi, 'principal', principal, 'interest', interest, 'balance_after', balance_after) order by seq)
        from public.emi_schedule where purchase_id = v_id and seq >= 2) is distinct from (select e from r2339_sched) then
    raise exception 'FAIL F: unpaid schedule is not the 10.5 per cent one';
  end if;
  if public.emi_outstanding(v_id) <> 233238 then raise exception 'FAIL F: outstanding changed to %', public.emi_outstanding(v_id); end if;
  if (select emi_loans_payable from public.report_balance_sheet('2026-12-31')) <> 233238 then raise exception 'FAIL F: Balance Sheet loan changed'; end if;
  select * into v_p from public.emi_purchases where id = v_id;
  if v_p.interest_rate <> 10.5 or v_p.lender <> 'HDFC Bank Ltd' or v_p.name <> 'Loan — HDFC Bank Ltd' or v_p.lender_ref <> 'BIKE-7'
     or v_p.emi_amount <> 19054 or v_p.emi_count <> 14 or v_p.financed <> 250000 or v_p.no_cost then
    raise exception 'FAIL F: loan row %', row_to_json(v_p);
  end if;
  select * into v_log from public.activity_log where entity_id = v_id::text and action = 'emi_loan_edited';
  if not found or (v_log.changes -> 'before' ->> 'interest_rate')::numeric <> 11 or (v_log.changes -> 'after' ->> 'interest_rate')::numeric <> 10.5
     or v_log.changes -> 'before' ->> 'lender' <> 'HDFC Bank' or (v_log.changes ->> 'outstanding')::int <> 233238
     or jsonb_array_length(v_log.changes -> 'before' -> 'unpaid') <> 13 then
    raise exception 'FAIL F: activity_log %', row_to_json(v_log);
  end if;
end $$;

-- ── G2. A cleared loan has nothing left to change ───────────────────────────────────────
do $$
declare v_id uuid := (select v from r2339_ids where k = 'bike');
begin
  update public.emi_purchases set status = 'closed' where id = v_id;
  begin
    perform public.edit_emi_loan(pg_temp.r2339_edit(v_id));
    raise exception 'FAIL G2: edited a cleared loan';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This loan is cleared%' then raise exception 'FAIL G2: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

select 'R-2339 EMI loan edit / delete: ALL PASS' as result;

rollback;
