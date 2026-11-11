-- R-2656 (10 Nov 2026, p1 paisa, G-RECON N3): own-account transfer + reversal pair detector.
-- Migration 20261110081000_r2656_bank_pair_detector. Self-asserting, ONE transaction, rolled back.
--
--   A. Preview: sure transfer (FD / sweep word), an FD account with no word = not shown, SBI-style
--      "BY TRANSFER" / "TRF" third-party lines = not shown, 3-day window (3 = pair, 4 = not), two
--      possible partners = 'ambiguous' (fail closed), "CHQ PAID-SELF" vs "NEFT CR-ACME" and "NEFT DR-VENDOR
--      RENT" vs "FD CLOSURE" (a word on one line only) = not shown, a refund naming nobody from the first
--      line = 'check' (never booked), a shared app name (PHONEPE) or IFSC + "TECHNOLOGIES" = 'check',
--      the same full payee name = sure, a number written in both narrations only (UPIRET + RRN) = 'check',
--      a reference on ONE line only + an unrelated refund = 'check' (11 Nov: was booked through a NULL),
--      the company's own account number in both narrations = 'check', a REFUND paid out
--      followed by another customer's receipt = not shown (the word is on the FIRST line), three ₹5L
--      cheques returned the same day = 3 sure pairs by cheque number, reversal whose other side is
--      booked = 'other_side_booked', books lock = 'locked', a reconciled line / another company's
--      line never seen.
--   B. Book: only the sure pairs are booked (transfer both sides 'transfer' pointing at each other,
--      no OWN-TRANSFER line added; reversal both 'manual' + reversal_of); a pair reconciled by hand
--      after the preview is skipped; no payment / expense / other income row is written.
--   C. Book again → 0, run_id null.
--   D. A pair un-reconciled by hand after the run can be booked again (its stale run pair is
--      released). Undo: a pair changed by hand since the run is left and listed; every other pair open
--      again; the run is marked undone; undo again → 0.
--   E. A manager is refused; another company cannot undo this run.

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
  ('dddddddd-0000-0000-0000-000000265601','R2656 Co','r2656@example.in','07','R656'),
  ('dddddddd-0000-0000-0000-000000265602','R2656 Other Co','r2656b@example.in','07','R657');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000265601','owner2656@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000265602','manager2656@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000265603','owner2656b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000265601','dddddddd-0000-0000-0000-000000265601','owner2656@example.in','Owner 2656','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000265602','dddddddd-0000-0000-0000-000000265601','manager2656@example.in','Manager 2656','manager', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000265603','dddddddd-0000-0000-0000-000000265602','owner2656b@example.in','Owner 2656 B','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000265601','dddddddd-0000-0000-0000-000000265601','HDFC 4523','HDFC','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000265602','dddddddd-0000-0000-0000-000000265601','ICICI Current','ICICI','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000265603','dddddddd-0000-0000-0000-000000265601','HDFC FD 1','HDFC','fixed_deposit', 0),
  ('bbbbbbbb-0000-0000-0000-000000265604','dddddddd-0000-0000-0000-000000265602','Other Co bank','SBI','current', 0);

-- A = HDFC 4523 (…601), B = ICICI (…602), F = FD (…603), X = other company (…604)
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source) values
  -- 1 sure transfer (word): A out → F in, 1 day apart; X has the same amount (other company, unseen)
  ('11111111-0000-0000-0000-000000265601','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-01','TRF TO FD 50300012345678 SWEEP',null,500000,0,'manual'),
  ('11111111-0000-0000-0000-000000265602','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265603','2026-10-02','PRINCIPAL DEPOSITED',null,0,500000,'manual'),
  ('11111111-0000-0000-0000-000000265603','dddddddd-0000-0000-0000-000000265602','bbbbbbbb-0000-0000-0000-000000265604','2026-10-01','FD CLOSED',null,0,500000,'manual'),
  -- 2 an FD account alone is no reason (no word, no ref) → not shown
  ('11111111-0000-0000-0000-000000265604','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-05','NEFT DR HDFC0000001 ANUTECH',null,77000,0,'manual'),
  ('11111111-0000-0000-0000-000000265605','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265603','2026-10-05','DEPOSIT',null,0,77000,'manual'),
  -- 3 SBI-style 'TRANSFER' / 'TRF' on third-party lines is no reason: vendor paid from A, customer paid into B → not shown
  ('11111111-0000-0000-0000-000000265606','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-03','NEFT TRF TO VENDOR X',null,12345,0,'manual'),
  ('11111111-0000-0000-0000-000000265607','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-10-03','BY TRANSFER-NEFT CUSTOMER Y',null,0,12345,'manual'),
  -- 4 window: 3 days → pair; 4 days → not shown
  ('11111111-0000-0000-0000-000000265608','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-10','SWEEP OUT',null,30000,0,'manual'),
  ('11111111-0000-0000-0000-000000265609','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-10-13','SWEEP IN',null,0,30000,'manual'),
  ('11111111-0000-0000-0000-000000265610','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-10','SWEEP OUT',null,40000,0,'manual'),
  ('11111111-0000-0000-0000-000000265611','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-10-14','SWEEP IN',null,0,40000,'manual'),
  -- 5 two possible partners → ambiguous, nothing booked
  ('11111111-0000-0000-0000-000000265612','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-20','SWEEP OUT TO ICICI',null,250000,0,'manual'),
  ('11111111-0000-0000-0000-000000265613','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-10-20','SWEEP IN FROM HDFC',null,0,250000,'manual'),
  ('11111111-0000-0000-0000-000000265614','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-10-21','SWEEP IN FROM HDFC',null,0,250000,'manual'),
  -- 6 UPI reversal, same account
  ('11111111-0000-0000-0000-000000265615','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-25','UPI-PHONEPE-PAY-621856395591-OK',null,1500,0,'manual'),
  ('11111111-0000-0000-0000-000000265616','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-26','UPIRET-621856395591-PHONEPE',null,0,1500,'manual'),
  -- 7 three ₹5L cheques returned the same day — paired by cheque number
  ('11111111-0000-0000-0000-000000265617','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-03-24','CHQ PAID-HDFC STANDARD LIFE','000111',500000,0,'manual'),
  ('11111111-0000-0000-0000-000000265618','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-03-24','CHQ PAID-HDFC STANDARD LIFE','000112',500000,0,'manual'),
  ('11111111-0000-0000-0000-000000265619','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-03-24','CHQ PAID-HDFC STANDARD LIFE','000113',500000,0,'manual'),
  ('11111111-0000-0000-0000-000000265620','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-03-24','I/W CHQ RET-FUNDS INSUFFICIENT','000113',0,500000,'manual'),
  ('11111111-0000-0000-0000-000000265621','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-03-24','I/W CHQ RET-FUNDS INSUFFICIENT','000111',0,500000,'manual'),
  ('11111111-0000-0000-0000-000000265622','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-03-24','I/W CHQ RET-FUNDS INSUFFICIENT','000112',0,500000,'manual'),
  -- 8 reversal whose debit is already booked → listed for the owner, never booked
  ('11111111-0000-0000-0000-000000265623','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-27','UPI-SWIGGY-ORDER',null,2000,0,'manual'),
  ('11111111-0000-0000-0000-000000265624','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-28','REV-UPI-SWIGGY-ORDER',null,0,2000,'manual'),
  -- 9 already reconciled transfer side → its partner is not shown
  ('11111111-0000-0000-0000-000000265625','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-10-29','TRF OWN',null,9000,0,'manual'),
  ('11111111-0000-0000-0000-000000265626','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-10-29','TRF OWN',null,0,9000,'manual'),
  -- 10 a lonely transfer-word line (no partner; a both-sides line is refused by debit_xor_credit) → not shown
  ('11111111-0000-0000-0000-000000265628','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-10-30','TRF ODD',null,0,700,'manual'),
  -- 11 on or before the books lock (lock set below)
  ('11111111-0000-0000-0000-000000265629','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-03-02','SWEEP OUT',null,61000,0,'manual'),
  ('11111111-0000-0000-0000-000000265630','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-03-02','SWEEP IN',null,0,61000,'manual'),
  -- 12 sure at preview, reconciled by hand before Book (the staging agent case)
  ('11111111-0000-0000-0000-000000265631','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-02','SWEEP OUT',null,3333,0,'manual'),
  ('11111111-0000-0000-0000-000000265632','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-11-02','SWEEP IN',null,0,3333,'manual'),
  -- 13 a refund paid to customer A, then customer B pays the same amount → not a reversal
  ('11111111-0000-0000-0000-000000265633','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-05','NEFT REFUND TO CUST A',null,5000,0,'manual'),
  ('11111111-0000-0000-0000-000000265634','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-07','UPI CUST B PAYMENT',null,0,5000,'manual'),
  -- 14 checker 10 Nov (proven): a word on ONE line of two current accounts is no reason → not shown
  ('11111111-0000-0000-0000-000000265635','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-10','CHQ PAID-SELF',null,50000,0,'manual'),
  ('11111111-0000-0000-0000-000000265636','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-11-11','NEFT CR-ACME PVT LTD',null,0,50000,'manual'),
  ('11111111-0000-0000-0000-000000265637','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265602','2026-11-12','NEFT DR-VENDOR Z RENT',null,100000,0,'manual'),
  ('11111111-0000-0000-0000-000000265638','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-13','FD CLOSURE PROCEEDS',null,0,100000,'manual'),
  -- 15 a refund on the later line that names nobody from the first line → 'check', never booked
  ('11111111-0000-0000-0000-000000265639','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-15','NEFT DR-OFFICE RENT NOV',null,7000,0,'manual'),
  ('11111111-0000-0000-0000-000000265640','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-16','IMPS REFUND FROM AMAZON',null,0,7000,'manual'),
  -- 16 re-check 10 Nov (proven): a shared payment app is not the same party → 'check'
  ('11111111-0000-0000-0000-000000265641','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-18','UPI-PHONEPE-SWIGGY',null,1500,0,'manual'),
  ('11111111-0000-0000-0000-000000265642','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-19','UPI REFUND-PHONEPE-AMAZON',null,0,1500,'manual'),
  -- 17 re-check 10 Nov (proven): a shared IFSC + "TECHNOLOGIES/TRADERS" is not the same party → 'check'
  ('11111111-0000-0000-0000-000000265643','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-20','NEFT DR-HDFC0000240-SHARMA TECHNOLOGIES',null,25000,0,'manual'),
  ('11111111-0000-0000-0000-000000265644','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-21','NEFT RETURN-HDFC0000240-GUPTA TRADERS',null,0,25000,'manual'),
  -- 18 the SAME full payee name (2+ words) with a return word → sure
  ('11111111-0000-0000-0000-000000265645','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-22','NEFT DR-HDFC0000240-RAMESH KUMAR SHARMA',null,33000,0,'manual'),
  ('11111111-0000-0000-0000-000000265646','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-11-23','NEFT RETURN-HDFC0000240-RAMESH KUMAR SHARMA',null,0,33000,'manual'),
  -- 19 independent check 11 Nov (proven, was booked): only the OUT line has a reference (cheque no.) and
  --    an unrelated refund comes in the next day → 'check', never booked (a NULL must never mean sure)
  ('11111111-0000-0000-0000-000000265647','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-12-01','CHQ PAID-ZOMATO','000211',900,0,'manual'),
  ('11111111-0000-0000-0000-000000265648','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-12-02','AMAZON REFUND',null,0,900,'manual'),
  ('11111111-0000-0000-0000-000000265649','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-12-15','CHQ PAID-SUPPLIER K','000333',1700,0,'manual'),
  ('11111111-0000-0000-0000-000000265650','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-12-16','NYKAA REFUND',null,0,1700,'manual'),
  -- 20 the reverse: only the IN line has a reference → 'check'
  ('11111111-0000-0000-0000-000000265651','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-12-05','NEFT DR-VENDOR P',null,1100,0,'manual'),
  ('11111111-0000-0000-0000-000000265652','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-12-06','I/W CHQ RET-MYNTRA REFUND','000222',0,1100,'manual'),
  -- 21 the two narrations share only the company's OWN account number (…4523) → 'check', and the
  --    number is not even named as a shared reference
  ('11111111-0000-0000-0000-000000265653','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-12-20','NEFT DR-50100012344523-VENDOR Q',null,1900,0,'manual'),
  ('11111111-0000-0000-0000-000000265654','dddddddd-0000-0000-0000-000000265601','bbbbbbbb-0000-0000-0000-000000265601','2026-12-21','NEFT RETURN-50100012344523-SELLER R',null,0,1900,'manual');

update public.bank_accounts set account_number_last4 = '4523' where id = 'bbbbbbbb-0000-0000-0000-000000265601';
update public.tenants set books_locked_until = '2026-03-10' where id = 'dddddddd-0000-0000-0000-000000265601';

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000265601","role":"authenticated"}', true);

do $$
declare
  v_res   jsonb;
  v_run   uuid;
  v_n     integer;
  v_pairs jsonb;
  v_got   text;
  v_want  text;
  v_pay0  integer; v_exp0 integer; v_oi0 integer; v_lines0 integer;
begin
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000265623', 'manual', null, 'manual');
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000265625', 'manual', null, 'manual');

  -- A. preview
  select string_agg(format('%s|%s|%s|%s', kind, status, right(out_txn_id::text, 2), right(in_txn_id::text, 2)), ' ' order by right(out_txn_id::text, 2), right(in_txn_id::text, 2))
    into v_got from public.bank_pair_candidates(null);
  v_want := 'transfer|sure|01|02 transfer|sure|08|09 transfer|ambiguous|12|13 transfer|ambiguous|12|14'
         || ' reversal|check|15|16 reversal|sure|17|21 reversal|sure|18|22 reversal|sure|19|20'
         || ' reversal|other_side_booked|23|24 transfer|locked|29|30 transfer|sure|31|32 reversal|check|39|40'
         || ' reversal|check|41|42 reversal|check|43|44 reversal|sure|45|46'
         || ' reversal|check|47|48 reversal|check|49|50 reversal|check|51|52 reversal|check|53|54';
  if v_got is distinct from v_want then
    raise exception 'FAIL A: preview — got: % — want: %', v_got, v_want;
  end if;
  if exists (select 1 from public.bank_pair_candidates(null) where reason is null or length(reason) < 10) then
    raise exception 'FAIL A: a row without a reason'; end if;
  -- a number written in both narrations (UPIRET with the RRN) is not proof by itself (it may be an
  -- account number): 'check', and the reason says so
  if (select reason from public.bank_pair_candidates(null) where out_txn_id = '11111111-0000-0000-0000-000000265615')
       not like 'A reversal word and the same number in both narrations%' then
    raise exception 'FAIL A: UPI pair reason'; end if;
  -- the company's own account number in both narrations is not a shared number at all
  if (select reason from public.bank_pair_candidates(null) where out_txn_id = '11111111-0000-0000-0000-000000265653')
       not like 'A reversal word, but the two lines share no reference number or payee name%' then
    raise exception 'FAIL A: own account number was read as a shared reference'; end if;
  if (select reason from public.bank_pair_candidates(null) where out_txn_id = '11111111-0000-0000-0000-000000265647')
       not like 'A reversal word, but the two lines share no reference number or payee name%' then
    raise exception 'FAIL A: cheque + unrelated refund reason'; end if;
  if (select reason from public.bank_pair_candidates(null) where out_txn_id = '11111111-0000-0000-0000-000000265645')
       not like 'Reversal word on the money coming back, same payee name%' then
    raise exception 'FAIL A: same-payee reason'; end if;
  if (select reason from public.bank_pair_candidates(null) where out_txn_id = '11111111-0000-0000-0000-000000265617')
       not like 'Reversal word on the money coming back, same cheque / reference number%' then
    raise exception 'FAIL A: cheque pair reason'; end if;
  -- account filter: the FD account sees only its one pair
  select count(*) into v_n from public.bank_pair_candidates('bbbbbbbb-0000-0000-0000-000000265603');
  if v_n <> 1 then raise exception 'FAIL A: FD account filter gave % rows, want 1', v_n; end if;
  raise notice 'A PASS: preview — sure / ambiguous / other side booked / locked, 3-day window, no-word pairs hidden';

  -- B. the staging agent books pair 12 by hand after the preview
  perform public.reconcile_bank_txn_manual('11111111-0000-0000-0000-000000265632', 'Booked by hand meanwhile', null);
  select count(*) into v_pay0 from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000265601';
  select count(*) into v_exp0 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000265601';
  select count(*) into v_oi0  from public.other_incomes where tenant_id = 'dddddddd-0000-0000-0000-000000265601';
  select count(*) into v_lines0 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000265601';

  -- the browser sends every row it saw, ambiguous / locked / booked ones too, plus a made-up pair
  select jsonb_agg(jsonb_build_object('out_txn_id', out_txn_id, 'in_txn_id', in_txn_id))
    into v_pairs
    from (select out_txn_id, in_txn_id from public.bank_pair_candidates(null)
          union all select '11111111-0000-0000-0000-000000265631'::uuid, '11111111-0000-0000-0000-000000265632'::uuid
          union all select '11111111-0000-0000-0000-000000265606'::uuid, '11111111-0000-0000-0000-000000265607'::uuid) s;
  v_res := public.book_bank_pairs(v_pairs);
  v_run := (v_res->>'run_id')::uuid;
  if (v_res->>'booked')::int <> 6 or v_run is null then
    raise exception 'FAIL B: booked % (want 6): %', v_res->>'booked', v_res; end if;
  if (select count(*) from public.bank_pair_run_lines where run_id = v_run) <> 6 then
    raise exception 'FAIL B: run lines'; end if;
  -- transfer: both sides 'transfer', pointing at each other, no added line
  if (select matched_to_type || ':' || matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000265601')
       is distinct from 'transfer:11111111-0000-0000-0000-000000265602'
     or (select matched_to_type || ':' || matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000265602')
       is distinct from 'transfer:11111111-0000-0000-0000-000000265601' then
    raise exception 'FAIL B: FD transfer not paired both ways'; end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000265601') <> v_lines0 then
    raise exception 'FAIL B: a line was added (OWN-TRANSFER) — the pair should match the existing line'; end if;
  -- reversal: by cheque number
  if (select matched_to_type || ':' || reversal_of from public.bank_transactions where id = '11111111-0000-0000-0000-000000265617')
       is distinct from 'manual:11111111-0000-0000-0000-000000265621'
     or (select reversal_of from public.bank_transactions where id = '11111111-0000-0000-0000-000000265620')
       is distinct from '11111111-0000-0000-0000-000000265619' then
    raise exception 'FAIL B: cheque returns not paired by cheque number'; end if;
  if (select reconcile_note from public.bank_transactions where id = '11111111-0000-0000-0000-000000265621') not like 'Reversal pair (Find pairs):%' then
    raise exception 'FAIL B: reversal reason missing'; end if;
  -- not booked: ambiguous, locked, other side booked, the hand-booked one, the made-up pair
  if exists (select 1 from public.bank_transactions
              where id in ('11111111-0000-0000-0000-000000265612','11111111-0000-0000-0000-000000265613','11111111-0000-0000-0000-000000265614',
                           '11111111-0000-0000-0000-000000265629','11111111-0000-0000-0000-000000265630',
                           '11111111-0000-0000-0000-000000265624','11111111-0000-0000-0000-000000265631',
                           '11111111-0000-0000-0000-000000265606','11111111-0000-0000-0000-000000265607',
                           '11111111-0000-0000-0000-000000265610','11111111-0000-0000-0000-000000265611',
                           '11111111-0000-0000-0000-000000265604','11111111-0000-0000-0000-000000265605',
                           '11111111-0000-0000-0000-000000265633','11111111-0000-0000-0000-000000265634',
                           '11111111-0000-0000-0000-000000265635','11111111-0000-0000-0000-000000265636',
                           '11111111-0000-0000-0000-000000265637','11111111-0000-0000-0000-000000265638',
                           '11111111-0000-0000-0000-000000265639','11111111-0000-0000-0000-000000265640',
                           '11111111-0000-0000-0000-000000265641','11111111-0000-0000-0000-000000265642',
                           '11111111-0000-0000-0000-000000265643','11111111-0000-0000-0000-000000265644',
                           '11111111-0000-0000-0000-000000265615','11111111-0000-0000-0000-000000265616',
                           '11111111-0000-0000-0000-000000265647','11111111-0000-0000-0000-000000265648',
                           '11111111-0000-0000-0000-000000265649','11111111-0000-0000-0000-000000265650',
                           '11111111-0000-0000-0000-000000265651','11111111-0000-0000-0000-000000265652',
                           '11111111-0000-0000-0000-000000265653','11111111-0000-0000-0000-000000265654')
                and (matched_to_type is not null or reversal_of is not null)) then
    raise exception 'FAIL B: a not-sure line was booked'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000265623') is distinct from 'manual'
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000265632') is distinct from 'manual'
     or (select reconcile_note from public.bank_transactions where id = '11111111-0000-0000-0000-000000265632') is distinct from 'Booked by hand meanwhile' then
    raise exception 'FAIL B: a hand-booked line was changed'; end if;
  if not exists (select 1 from jsonb_array_elements(v_res->'skipped') e
                  where e->>'out_txn_id' = '11111111-0000-0000-0000-000000265631' and e->>'reason' like 'Not a sure pair any more%') then
    raise exception 'FAIL B: hand-booked pair not reported as skipped: %', v_res->'skipped'; end if;
  if (select count(*) from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000265601') <> v_pay0
     or (select count(*) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000265601') <> v_exp0
     or (select count(*) from public.other_incomes where tenant_id = 'dddddddd-0000-0000-0000-000000265601') <> v_oi0 then
    raise exception 'FAIL B: a payment / expense / other income row was written'; end if;
  raise notice 'B PASS: 6 sure pairs booked through the transfer / manual pair paths; the rest left as they were';

  -- C. book again → nothing
  v_res := public.book_bank_pairs(v_pairs);
  if (v_res->>'booked')::int <> 0 or v_res->>'run_id' is not null then
    raise exception 'FAIL C: second book booked something: %', v_res; end if;
  raise notice 'C PASS: Book twice books once';

  -- D. one pair changed by hand; the FD transfer un-reconciled by hand and booked again (new run)
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000265619', false);
  perform public.reconcile_bank_txn_manual('11111111-0000-0000-0000-000000265619', 'Booked another way by hand', null);
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000265601', false);
  if (select count(*) from public.bank_transactions
       where id in ('11111111-0000-0000-0000-000000265601','11111111-0000-0000-0000-000000265602') and matched_to_type is null) <> 2 then
    raise exception 'FAIL D: un-reconciling one side of the transfer did not free both'; end if;
  v_res := public.book_bank_pairs('[{"out_txn_id":"11111111-0000-0000-0000-000000265601","in_txn_id":"11111111-0000-0000-0000-000000265602"}]'::jsonb);
  if (v_res->>'booked')::int <> 1 then
    raise exception 'FAIL D: a pair freed by hand could not be booked again: %', v_res; end if;
  v_res := public.undo_bank_pair_run(v_run);
  if (v_res->>'undone')::int <> 4 or jsonb_array_length(v_res->'left') <> 1
     or (v_res->'left'->0->>'out_txn_id') <> '11111111-0000-0000-0000-000000265619' then
    raise exception 'FAIL D: undo result %', v_res; end if;
  if (select undone_at from public.bank_pair_runs where id = v_run) is null then
    raise exception 'FAIL D: run not marked undone (nothing of it is left)'; end if;
  -- the re-booked FD transfer belongs to the NEW run: still booked
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000265601') is distinct from 'transfer' then
    raise exception 'FAIL D: undo of the old run un-booked the new run''s pair'; end if;
  v_res := public.undo_bank_pair_run((select l.run_id from public.bank_pair_run_lines l
                                       where l.out_txn_id = '11111111-0000-0000-0000-000000265601' and l.undone_at is null));
  if (v_res->>'undone')::int <> 1 then raise exception 'FAIL D: new run undo %', v_res; end if;
  if exists (select 1 from public.bank_transactions
              where id in ('11111111-0000-0000-0000-000000265601','11111111-0000-0000-0000-000000265602',
                           '11111111-0000-0000-0000-000000265608','11111111-0000-0000-0000-000000265609',
                           '11111111-0000-0000-0000-000000265615','11111111-0000-0000-0000-000000265616',
                           '11111111-0000-0000-0000-000000265617','11111111-0000-0000-0000-000000265621',
                           '11111111-0000-0000-0000-000000265618','11111111-0000-0000-0000-000000265622')
                and (matched_to_type is not null or reversal_of is not null or reconcile_note is not null)) then
    raise exception 'FAIL D: a pair stayed reconciled after Undo'; end if;
  if (select matched_to_type || ':' || reconcile_note from public.bank_transactions where id = '11111111-0000-0000-0000-000000265619')
       is distinct from 'manual:Booked another way by hand' then
    raise exception 'FAIL D: the hand-changed line was touched by Undo'; end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000265601') <> v_lines0 then
    raise exception 'FAIL D: Undo deleted or added a statement line'; end if;
  v_res := public.undo_bank_pair_run(v_run);
  if (v_res->>'undone')::int <> 0 or jsonb_array_length(v_res->'left') <> 0 then
    raise exception 'FAIL D: second undo %', v_res; end if;
  -- the freed lines are offered again
  if not exists (select 1 from public.bank_pair_candidates(null)
                  where out_txn_id = '11111111-0000-0000-0000-000000265601' and status = 'sure') then
    raise exception 'FAIL D: freed transfer not offered again'; end if;
  raise notice 'D PASS: Undo frees both sides, leaves the hand-changed pair, runs once';
end $$;

-- E. roles and companies
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000265602","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform * from public.bank_pair_candidates(null);
  exception when sqlstate '42501' then ok := true; end;
  if not ok then raise exception 'FAIL E: a manager could read the pairs'; end if;
  ok := false;
  begin perform public.book_bank_pairs('[]'::jsonb);
  exception when sqlstate '42501' then ok := true; end;
  if not ok then raise exception 'FAIL E: a manager could book pairs'; end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000265603","role":"authenticated"}', true);
do $$
declare ok boolean := false; v_run uuid; v_n integer;
begin
  select id into v_run from public.bank_pair_runs where tenant_id = 'dddddddd-0000-0000-0000-000000265601' limit 1;
  begin perform public.undo_bank_pair_run(v_run);
  exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'FAIL E: another company could undo the run'; end if;
  select count(*) into v_n from public.bank_pair_candidates(null);
  if v_n <> 0 then raise exception 'FAIL E: another company sees % pairs', v_n; end if;
  raise notice 'E PASS: manager refused, other company sees nothing and cannot undo';
end $$;

rollback;
