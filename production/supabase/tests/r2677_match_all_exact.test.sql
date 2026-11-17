\set ON_ERROR_STOP on
-- R-2677 (17 Nov 2026, p0 paisa, G-RECON): Banking → an account → "Match all exact (N)".
-- Migration 20261117145227_r2677_match_all_exact. Self-asserting, ONE transaction, rolled back.
--
--   A. Preview: a receipt with the same amount + same date = 'exact'; a paid expense same amount +
--      same date = 'exact'; a payment already recorded on the Expenses page (Mark paid, R-1911) for the
--      vendor named on the line = 'exact' (recorded_payment); the date / money in-out filter; the
--      reason is never empty.
--   B. Two receipts could be the line → 'ambiguous'.
--   C. One expense, two open lines of its amount (another account, 2 days later) → the first
--      'ambiguous', the second only 'likely' — nothing booked.
--   D. A line on / before the books lock → 'locked' (and refused at save).
--   E. Kinds that are not a plain link stay in the drawer: an UNPAID expense bill, an expense with TDS.
--   F. Save re-checks every row on the server: a row whose record was changed by the browser, a line of
--      another account, another company's line, a locked line, a line listed twice → skipped with a
--      reason; only the exact ones are matched; no expense / receipt / bill / invoice row is written.
--   G. Match again → 0, no run.
--   H. Undo this run: a line changed by hand since is released and listed; every other line open again
--      (the Mark-paid expense is back as it was: paid, not banked); the run is marked undone; undo again → 0.
--   J. A manager is refused; another company cannot see the account or undo the run.

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
  ('dddddddd-0000-0000-0000-000000267701','R2677 Co','r2677@example.in','07','R677'),
  ('dddddddd-0000-0000-0000-000000267702','R2677 Other Co','r2677b@example.in','07','R678');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000267701','owner2677@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000267702','manager2677@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000267703','owner2677b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000267701','dddddddd-0000-0000-0000-000000267701','owner2677@example.in','Owner 2677','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000267702','dddddddd-0000-0000-0000-000000267701','manager2677@example.in','Manager 2677','manager', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000267703','dddddddd-0000-0000-0000-000000267702','owner2677b@example.in','Owner 2677 B','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000267701','dddddddd-0000-0000-0000-000000267701','HDFC 4523','HDFC','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000267702','dddddddd-0000-0000-0000-000000267701','ICICI Current','ICICI','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000267703','dddddddd-0000-0000-0000-000000267702','Other Co bank','SBI','current', 0);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('cccccccc-0000-0000-0000-000000267701','dddddddd-0000-0000-0000-000000267701','R2677 Infra Traders','07','India');
insert into public.vendors (id, tenant_id, name, upi_id) values
  ('eeeeeeee-0000-0000-0000-000000267701','dddddddd-0000-0000-0000-000000267701','R2677 Broadband','r2677broadband@hdfcbank'),
  ('eeeeeeee-0000-0000-0000-000000267702','dddddddd-0000-0000-0000-000000267701','R2677 Office Mart','r2677office@okaxis');

-- A = HDFC 4523 (…701), B = ICICI (…702), X = other company (…703)
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source) values
  -- 01 receipt, same amount + same date → exact
  ('11111111-0000-0000-0000-000000267701','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-10','NEFT CR-HSBC0001-R2677 INFRA TRADERS','HSBCN2677A',0,5000,'csv_upload'),
  -- 02 two receipts could be it → ambiguous
  ('11111111-0000-0000-0000-000000267702','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-12','IMPS CR-SOMEONE',null,0,7000,'csv_upload'),
  -- 03 paid Zoho expense, same amount + same date → exact
  ('11111111-0000-0000-0000-000000267703','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-24','RAZPZOHO 2677',null,2548,0,'csv_upload'),
  -- 04 + 05 one expense, two open lines (05 in the other account) → 04 ambiguous, 05 likely
  ('11111111-0000-0000-0000-000000267704','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-18','ZOHO TECHNOLOGIES UPI',null,1416,0,'csv_upload'),
  ('11111111-0000-0000-0000-000000267705','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267702','2026-10-20','ZOHO TECHNOLOGIES UPI',null,1416,0,'csv_upload'),
  -- 06 locked (lock set below)
  ('11111111-0000-0000-0000-000000267706','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-03-05','POS OLD SHOP',null,900,0,'csv_upload'),
  -- 07 Mark-paid expense of the vendor named on the line (UPI id) → recorded_payment exact
  ('11111111-0000-0000-0000-000000267707','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-10','UPI-R2677BROADBAND-r2677broadband@hdfcbank-NOV',null,6358,0,'csv_upload'),
  -- 08 receipt (another amount) — the browser will send it with the wrong record
  ('11111111-0000-0000-0000-000000267708','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-14','NEFT CR-R2677 INFRA TRADERS 2',null,0,3000,'csv_upload'),
  -- 09 receipt (another amount) — matched, then changed by hand before Undo
  ('11111111-0000-0000-0000-000000267709','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-15','NEFT CR-R2677 INFRA TRADERS 3',null,0,4321,'csv_upload'),
  -- 10 unpaid expense bill → drawer
  ('11111111-0000-0000-0000-000000267710','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-15','NEFT DR-SOME SUPPLIER',null,4100,0,'csv_upload'),
  -- 11 expense with TDS → drawer
  ('11111111-0000-0000-0000-000000267711','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-16','NEFT DR-CONSULTANT',null,9000,0,'csv_upload'),
  -- 12 nothing in the books → none
  ('11111111-0000-0000-0000-000000267712','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-17','UPI-TEA STALL',null,60,0,'csv_upload'),
  -- 13 November (outside the October filter) receipt, exact
  ('11111111-0000-0000-0000-000000267713','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-11-03','NEFT CR-R2677 INFRA TRADERS 4',null,0,8800,'csv_upload'),
  -- 14 other company, same amount as 01
  ('11111111-0000-0000-0000-000000267714','dddddddd-0000-0000-0000-000000267702','bbbbbbbb-0000-0000-0000-000000267703','2026-10-10','NEFT CR-X',null,0,5000,'csv_upload'),
  -- 15 an expense paid in CASH on the same day, same amount → drawer (never banked by the run)
  ('11111111-0000-0000-0000-000000267715','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-21','POS SOME STORE',null,2500,0,'csv_upload'),
  -- 16 Mark-paid expense of the vendor named on the line, SAME day → booked the R-1911 way (recorded_payment)
  ('11111111-0000-0000-0000-000000267716','dddddddd-0000-0000-0000-000000267701','bbbbbbbb-0000-0000-0000-000000267701','2026-10-22','UPI-OFFICEMART-r2677office@okaxis-STATIONERY',null,777,0,'csv_upload');

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
select 'Q-R2677-' || k, 'dddddddd-0000-0000-0000-000000267701', null, 'cccccccc-0000-0000-0000-000000267701'::uuid, 'R2677 Infra Traders',
       amt, round(amt / 1.18), 18, 'accepted', 'awaiting', '[]'::jsonb
  from (values ('1', 5000), ('2a', 7000), ('2b', 7000), ('8a', 3000), ('8b', 1234), ('9', 4321), ('13', 8800)) v(k, amt);
insert into public.payments (id, tenant_id, customer_id, amount, method, reference, status, received_at, quote_id) values
  ('f2677000-0000-4000-8000-000000000001','dddddddd-0000-0000-0000-000000267701','cccccccc-0000-0000-0000-000000267701',5000,'bank_transfer','HSBCN2677A','received','2026-10-10 12:00+05:30','Q-R2677-1'),
  ('f2677000-0000-4000-8000-00000000002a','dddddddd-0000-0000-0000-000000267701','cccccccc-0000-0000-0000-000000267701',7000,'bank_transfer',null,'received','2026-10-12 12:00+05:30','Q-R2677-2a'),
  ('f2677000-0000-4000-8000-00000000002b','dddddddd-0000-0000-0000-000000267701','cccccccc-0000-0000-0000-000000267701',7000,'bank_transfer',null,'received','2026-10-13 12:00+05:30','Q-R2677-2b'),
  ('f2677000-0000-4000-8000-00000000008a','dddddddd-0000-0000-0000-000000267701','cccccccc-0000-0000-0000-000000267701',3000,'bank_transfer',null,'received','2026-10-14 12:00+05:30','Q-R2677-8a'),
  ('f2677000-0000-4000-8000-00000000008b','dddddddd-0000-0000-0000-000000267701','cccccccc-0000-0000-0000-000000267701',1234,'bank_transfer',null,'received','2026-10-14 12:00+05:30','Q-R2677-8b'),
  ('f2677000-0000-4000-8000-000000000009','dddddddd-0000-0000-0000-000000267701','cccccccc-0000-0000-0000-000000267701',4321,'bank_transfer',null,'received','2026-10-15 12:00+05:30','Q-R2677-9'),
  ('f2677000-0000-4000-8000-000000000013','dddddddd-0000-0000-0000-000000267701','cccccccc-0000-0000-0000-000000267701',8800,'bank_transfer',null,'received','2026-11-03 12:00+05:30','Q-R2677-13');

insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, paid_date, payment_method, tds_amount, tds_section) values
  ('EXP-R2677-03','dddddddd-0000-0000-0000-000000267701','Software','Zoho Corp',null,'2026-10-24',2548,0,'none',null,true,'2026-10-24','bank',0,null),
  ('EXP-R2677-04','dddddddd-0000-0000-0000-000000267701','Software','Zoho Technologies',null,'2026-10-18',1416,0,'none',null,true,'2026-10-18','bank',0,null),
  ('EXP-R2677-06','dddddddd-0000-0000-0000-000000267701','Office Expenses','Old Shop',null,'2026-03-05',900,0,'none',null,true,'2026-03-05','bank',0,null),
  -- Mark paid on the Expenses page on 10 Oct; billed 25 Sep (outside the suggester's 7 days)
  ('EXP-R2677-07','dddddddd-0000-0000-0000-000000267701','Internet','R2677 Broadband','eeeeeeee-0000-0000-0000-000000267701','2026-09-25',6358,0,'none','DLINV/2677',true,'2026-10-10','bank',0,null),
  ('EXP-R2677-10','dddddddd-0000-0000-0000-000000267701','Office Expenses','Some Supplier',null,'2026-10-15',4100,0,'none',null,false,null,null,0,null),
  ('EXP-R2677-11','dddddddd-0000-0000-0000-000000267701','Professional Services','Consultant',null,'2026-10-16',9000,0,'none',null,true,'2026-10-16','bank',900,'194J'),
  ('EXP-R2677-15','dddddddd-0000-0000-0000-000000267701','Office Expenses','Some Store',null,'2026-10-21',2500,0,'none',null,true,'2026-10-21','cash',0,null),
  ('EXP-R2677-16','dddddddd-0000-0000-0000-000000267701','Office Expenses','R2677 Office Mart','eeeeeeee-0000-0000-0000-000000267702','2026-10-22',777,0,'none','OM-16',true,'2026-10-22','bank',0,null);

update public.tenants set books_locked_until = '2026-03-10' where id = 'dddddddd-0000-0000-0000-000000267701';

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000267701","role":"authenticated"}', true);

do $$
declare
  v_got  text;
  v_want text;
  v_n    integer;
begin
  -- A–E. October, all directions, account A
  select string_agg(format('%s|%s|%s', right(txn_id::text, 2), status, coalesce(kind, '-')), ' ' order by right(txn_id::text, 2))
    into v_got
    from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', '2026-10-01', '2026-10-31', 'all');
  v_want := '01|exact|payment 02|ambiguous|payment 03|exact|expense 04|ambiguous|expense 07|exact|recorded_payment'
         || ' 08|exact|payment 09|exact|payment 10|drawer|expense 11|drawer|expense 12|none|- 15|drawer|expense 16|exact|recorded_payment';
  if v_got is distinct from v_want then
    raise exception 'FAIL A: preview — got: % — want: %', v_got, v_want;
  end if;
  if exists (select 1 from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', null, null, 'all')
              where why is null or length(why) < 10) then
    raise exception 'FAIL A: a row without a reason'; end if;
  if (select match_id from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', '2026-10-01', '2026-10-31', 'out')
       where txn_id = '11111111-0000-0000-0000-000000267707') is distinct from 'EXP-R2677-07' then
    raise exception 'FAIL A: recorded payment record'; end if;
  -- money in only, October: 01 02 08 09
  select count(*) into v_n from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', '2026-10-01', '2026-10-31', 'in');
  if v_n <> 4 then raise exception 'FAIL A: money-in filter gave % rows, want 4', v_n; end if;
  -- no dates: the November line and the locked March line are in too
  select string_agg(right(txn_id::text, 2) || '|' || status, ' ' order by right(txn_id::text, 2)) into v_got
    from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', null, null, 'all')
   where right(txn_id::text, 2) in ('06', '13');
  if v_got is distinct from '06|locked 13|exact' then raise exception 'FAIL D: got %', v_got; end if;
  -- C: the second line of the same expense (other account) is only 'likely'
  select status into v_got from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267702', null, null, 'all')
   where txn_id = '11111111-0000-0000-0000-000000267705';
  if v_got is distinct from 'likely' then raise exception 'FAIL C: second line is %', v_got; end if;
  -- paging: pages of 3 (keyset on the line id) give exactly the same lines as one page
  declare v_after uuid := null; v_page integer; v_all integer := 0; v_last uuid;
  begin
    loop
      select count(*), max(txn_id::text)::uuid into v_page, v_last
        from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', null, null, 'all', v_after, 3);
      v_all := v_all + v_page;
      exit when v_page < 3;
      v_after := v_last;
    end loop;
    select count(*) into v_n from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', null, null, 'all', null, 200);
    if v_all <> v_n or v_n < 10 then raise exception 'FAIL A: paged % lines, one page %', v_all, v_n; end if;
  end;
  raise notice 'A-E PASS: exact / ambiguous (2 records, 2 lines) / locked / drawer / likely / none, filters';
end $$;

do $$
declare
  v_res   jsonb;
  v_rows  jsonb;
  v_run   uuid;
  v_n     integer;
  v_pay0 integer; v_exp0 integer; v_bill0 integer; v_inv0 integer; v_lines0 integer;
  v_skip  text;
begin
  select count(*) into v_pay0  from public.payments      where tenant_id = 'dddddddd-0000-0000-0000-000000267701';
  select count(*) into v_exp0  from public.expenses      where tenant_id = 'dddddddd-0000-0000-0000-000000267701';
  select count(*) into v_bill0 from public.vendor_bills  where tenant_id = 'dddddddd-0000-0000-0000-000000267701';
  select count(*) into v_inv0  from public.invoices      where tenant_id = 'dddddddd-0000-0000-0000-000000267701';
  select count(*) into v_lines0 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000267701';

  -- F. the browser sends: the October exact rows (08 with the WRONG receipt), the ambiguous 02, the
  -- locked 06, line 05 of account B, the other company's 14, 01 twice, and a made-up id.
  select jsonb_agg(jsonb_build_object('txn_id', txn_id, 'match_type', kind,
           'match_id', case when txn_id = '11111111-0000-0000-0000-000000267708' then 'f2677000-0000-4000-8000-00000000008b' else match_id end))
    into v_rows
    from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', '2026-10-01', '2026-10-31', 'all')
   where status in ('exact', 'ambiguous');
  v_rows := v_rows
    || jsonb_build_array(
         jsonb_build_object('txn_id', '11111111-0000-0000-0000-000000267706', 'match_type', 'expense', 'match_id', 'EXP-R2677-06'),
         jsonb_build_object('txn_id', '11111111-0000-0000-0000-000000267705', 'match_type', 'expense', 'match_id', 'EXP-R2677-04'),
         jsonb_build_object('txn_id', '11111111-0000-0000-0000-000000267714', 'match_type', 'payment', 'match_id', 'f2677000-0000-4000-8000-000000000001'),
         jsonb_build_object('txn_id', '11111111-0000-0000-0000-000000267701', 'match_type', 'payment', 'match_id', 'f2677000-0000-4000-8000-000000000001'),
         jsonb_build_object('txn_id', 'not-a-line', 'match_type', 'payment', 'match_id', 'x'));

  v_res := public.book_bank_exact_matches('bbbbbbbb-0000-0000-0000-000000267701', v_rows);
  v_run := (v_res->>'run_id')::uuid;
  if (v_res->>'booked')::int <> 5 or v_run is null then
    raise exception 'FAIL F: booked % (want 5: 01 03 07 09 16) — %', v_res->>'booked', v_res;
  end if;
  select string_agg(right(s->>'txn_id', 2), ' ' order by right(s->>'txn_id', 2)) into v_skip
    from jsonb_array_elements(v_res->'skipped') s;
  if v_skip is distinct from '01 02 04 05 06 08 14 ne' then
    raise exception 'FAIL F: skipped % — %', v_skip, v_res->'skipped';
  end if;
  if (select s->>'reason' from jsonb_array_elements(v_res->'skipped') s where s->>'txn_id' = '11111111-0000-0000-0000-000000267708')
       not like 'The record for this line is not the one the preview showed%' then
    raise exception 'FAIL F: tampered row reason — %', v_res->'skipped'; end if;
  -- what was matched, exactly
  if (select matched_to_type || ':' || matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000267701')
       is distinct from 'payment:f2677000-0000-4000-8000-000000000001' then raise exception 'FAIL F: line 01'; end if;
  if (select matched_to_type || ':' || matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000267703')
       is distinct from 'expense:EXP-R2677-03' then raise exception 'FAIL F: line 03'; end if;
  if (select reconciled_txn_id from public.expenses where id = 'EXP-R2677-03') is distinct from '11111111-0000-0000-0000-000000267703' then
    raise exception 'FAIL F: expense 03 not banked on line 03'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000267707') is null then
    raise exception 'FAIL F: line 07 (recorded payment) not matched'; end if;
  -- 16: the same-day Mark-paid expense went the R-1911 way (the line took the Mark-paid's place)
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000267716') is null
     or not exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = 'EXP-R2677-16' and l.kind = 'recorded_payment') then
    raise exception 'FAIL F: line 16 not booked as the recorded payment'; end if;
  -- 15: the cash expense was never banked
  if (select reconciled_txn_id from public.expenses where id = 'EXP-R2677-15') is not null then
    raise exception 'FAIL F: cash expense 15 was banked'; end if;
  if exists (select 1 from public.bank_transactions where id in ('11111111-0000-0000-0000-000000267702','11111111-0000-0000-0000-000000267704',
               '11111111-0000-0000-0000-000000267705','11111111-0000-0000-0000-000000267706','11111111-0000-0000-0000-000000267708',
               '11111111-0000-0000-0000-000000267710','11111111-0000-0000-0000-000000267711','11111111-0000-0000-0000-000000267714')
               and matched_to_type is not null) then
    raise exception 'FAIL F: a skipped line was matched'; end if;
  -- nothing new in the books
  select count(*) into v_n from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000267701';
  if v_n <> v_pay0 then raise exception 'FAIL F: payments % → %', v_pay0, v_n; end if;
  select count(*) into v_n from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000267701';
  if v_n <> v_exp0 then raise exception 'FAIL F: expenses % → %', v_exp0, v_n; end if;
  select count(*) into v_n from public.vendor_bills where tenant_id = 'dddddddd-0000-0000-0000-000000267701';
  if v_n <> v_bill0 then raise exception 'FAIL F: vendor bills % → %', v_bill0, v_n; end if;
  select count(*) into v_n from public.invoices where tenant_id = 'dddddddd-0000-0000-0000-000000267701';
  if v_n <> v_inv0 then raise exception 'FAIL F: invoices % → %', v_inv0, v_n; end if;
  select count(*) into v_n from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000267701';
  if v_n <> v_lines0 then raise exception 'FAIL F: bank lines % → %', v_lines0, v_n; end if;
  select count(*) into v_n from public.bank_exact_match_run_lines where run_id = v_run and undone_at is null;
  if v_n <> 5 then raise exception 'FAIL F: run lines %', v_n; end if;
  if (select booked from public.bank_exact_match_runs where id = v_run) <> 5 then raise exception 'FAIL F: run count'; end if;
  raise notice 'F PASS: server re-check — tampered / other account / other company / locked / ambiguous / twice skipped; nothing new in the books';

  -- G. again → nothing, no run
  v_res := public.book_bank_exact_matches('bbbbbbbb-0000-0000-0000-000000267701', v_rows);
  if (v_res->>'booked')::int <> 0 or v_res->>'run_id' is not null then
    raise exception 'FAIL G: second press booked % — %', v_res->>'booked', v_res; end if;
  raise notice 'G PASS: second press matches nothing';

  -- H. line 09 un-reconciled and booked again by hand as something else after the run → left alone by
  -- Undo. (A hand re-match to the SAME receipt is told apart by matched_at — a later transaction's
  -- now(); inside this one test transaction now() does not move, so the test changes the type.)
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000267709', false);
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000267709', 'manual', null, 'manual');
  v_res := public.undo_bank_exact_match_run(v_run);
  if (v_res->>'undone')::int <> 4 or (v_res->>'remaining')::int <> 0 or jsonb_array_length(v_res->'left') <> 1
     or (v_res->'left'->0->>'txn_id') <> '11111111-0000-0000-0000-000000267709' then
    raise exception 'FAIL H: undo — %', v_res; end if;
  if exists (select 1 from public.bank_transactions where id in ('11111111-0000-0000-0000-000000267701','11111111-0000-0000-0000-000000267703',
               '11111111-0000-0000-0000-000000267707','11111111-0000-0000-0000-000000267716') and matched_to_type is not null) then
    raise exception 'FAIL H: a run line is still reconciled'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000267709') is distinct from 'manual' then
    raise exception 'FAIL H: the hand-matched line 09 was undone'; end if;
  if (select reconciled_txn_id from public.expenses where id = 'EXP-R2677-03') is not null then
    raise exception 'FAIL H: expense 03 still banked'; end if;
  -- the Mark-paid expense is back as it was: paid, not banked, offered again as a recorded payment
  if (select paid::text || ':' || coalesce(reconciled_txn_id::text, '-') from public.expenses where id = 'EXP-R2677-07') is distinct from 'true:-' then
    raise exception 'FAIL H: expense 07 is %', (select paid::text || ':' || coalesce(reconciled_txn_id::text, '-') from public.expenses where id = 'EXP-R2677-07'); end if;
  if (select status from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', '2026-10-10', '2026-10-10', 'out')
       where txn_id = '11111111-0000-0000-0000-000000267707') is distinct from 'exact' then
    raise exception 'FAIL H: line 07 not offered again after Undo'; end if;
  if (select paid::text || ':' || coalesce(reconciled_txn_id::text, '-') from public.expenses where id = 'EXP-R2677-16') is distinct from 'true:-' then
    raise exception 'FAIL H: expense 16 not back as Mark-paid'; end if;
  if (select undone_at from public.bank_exact_match_runs where id = v_run) is null then
    raise exception 'FAIL H: run not marked undone'; end if;
  v_res := public.undo_bank_exact_match_run(v_run);
  if (v_res->>'undone')::int <> 0 then raise exception 'FAIL H: second undo — %', v_res; end if;
  raise notice 'H PASS: undo — exactly the run''s matches back, the hand-changed line left, undo twice = 0';
end $$;

-- K. One press in chunks = one run (the second chunk passes the run id), the scope is kept on the run,
--    an undone run takes no more chunks, and Undo in pages of 1 ends with remaining 0.
do $$
declare v_res jsonb; v_run uuid; ok boolean := false;
begin
  v_res := public.book_bank_exact_matches('bbbbbbbb-0000-0000-0000-000000267701',
    jsonb_build_array(jsonb_build_object('txn_id', '11111111-0000-0000-0000-000000267701', 'match_type', 'payment', 'match_id', 'f2677000-0000-4000-8000-000000000001')),
    null, '{"from":"2026-10-01","to":"2026-11-30","dir":"all"}'::jsonb);
  v_run := (v_res->>'run_id')::uuid;
  v_res := public.book_bank_exact_matches('bbbbbbbb-0000-0000-0000-000000267701',
    jsonb_build_array(jsonb_build_object('txn_id', '11111111-0000-0000-0000-000000267713', 'match_type', 'payment', 'match_id', 'f2677000-0000-4000-8000-000000000013')),
    v_run, null);
  if (v_res->>'run_id')::uuid is distinct from v_run or (v_res->>'booked')::int <> 1 then raise exception 'FAIL K: second chunk — %', v_res; end if;
  if (select booked::text || ':' || (filter->>'from') || ':' || (filter->>'dir') from public.bank_exact_match_runs where id = v_run)
       is distinct from '2:2026-10-01:all' then raise exception 'FAIL K: run row'; end if;
  v_res := public.undo_bank_exact_match_run(v_run, 1);
  if (v_res->>'undone')::int <> 1 or (v_res->>'remaining')::int <> 1 then raise exception 'FAIL K: undo page 1 — %', v_res; end if;
  if (select undone_at from public.bank_exact_match_runs where id = v_run) is not null then raise exception 'FAIL K: undone too early'; end if;
  v_res := public.undo_bank_exact_match_run(v_run, 1);
  if (v_res->>'undone')::int <> 1 or (v_res->>'remaining')::int <> 0 then raise exception 'FAIL K: undo page 2 — %', v_res; end if;
  if (select undone_at from public.bank_exact_match_runs where id = v_run) is null then raise exception 'FAIL K: run not undone'; end if;
  begin
    perform public.book_bank_exact_matches('bbbbbbbb-0000-0000-0000-000000267701', '[]'::jsonb, v_run, null);
  exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'FAIL K: an undone run took another chunk'; end if;
  raise notice 'K PASS: chunks = one run, scope kept, undo in pages';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000267702","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform 1 from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', null, null, 'all');
  exception when sqlstate '42501' then ok := true; end;
  if not ok then raise exception 'FAIL J: a manager could read the preview'; end if;
  ok := false;
  begin perform public.book_bank_exact_matches('bbbbbbbb-0000-0000-0000-000000267701', '[]'::jsonb);
  exception when sqlstate '42501' then ok := true; end;
  if not ok then raise exception 'FAIL J: a manager could match'; end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000267703","role":"authenticated"}', true);
do $$
declare ok boolean := false; v_run uuid;
begin
  select id into v_run from public.bank_exact_match_runs where tenant_id = 'dddddddd-0000-0000-0000-000000267701' limit 1;
  begin perform public.undo_bank_exact_match_run(v_run);
  exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'FAIL J: another company could undo the run'; end if;
  ok := false;
  begin perform 1 from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000267701', null, null, 'all');
  exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'FAIL J: another company could read the account'; end if;
  raise notice 'J PASS: manager refused, other company sees nothing and cannot undo';
  raise notice 'PASS r2677_match_all_exact';
end $$;

rollback;
