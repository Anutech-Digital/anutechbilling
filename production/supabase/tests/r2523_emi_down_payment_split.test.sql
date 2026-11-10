-- R-2523 (6 Nov 2026): an EMI asset's down payment from SEVERAL sources + the first EMI's
-- broken-period interest. Migration 20261106100856_r2523_emi_down_payment_split.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- The staging case (fy-bank, R-2094, 6 Nov): Thar Roxx (₹19,70,000, HDFC loan ₹17,70,000) bought
-- 3 Feb 2026, down payment ₹2,00,000 recorded as "paid from Petty Cash". It was really paid as
--   HDFC 4523 → Shiva Auto Cars ₹21,000 (2 Jan 2026), ₹87,394 (30 Jan), ₹19,700 (2 Feb) = ₹1,28,094
--   + Petty Cash ₹71,906.
-- The first EMI bank line (5 Mar 2026) is ₹30,183 against a scheduled EMI of ₹27,764: ₹2,419 is
-- broken-period interest.
--
-- Proves:
--   A. Bank page: each HDFC line is reconciled to the down payment one by one with its OWN
--      (partial) amount — the Petty Cash part shrinks 2,00,000 → 1,79,000 → 91,606 → 71,906.
--      Cash: HDFC −1,28,094, Petty Cash −71,906 (sum = the down payment, counted once);
--      asset cost, loan and schedule unchanged. emi_matches_for_bank_txn offers the partial line.
--   B. A line bigger than what is still on manual/owner parts is refused, nothing written.
--   C. Undo: un-reconciling the 87,394 line gives it back to the Petty Cash part (1,59,300);
--      reconciling it again brings it back to 71,906.
--   D. set_emi_down_payment_parts: the same split in ONE step from Assets & EMIs (3 statement
--      lines + Petty Cash 71,906) on a second purchase; parts must add up to the down payment;
--      a reconciled statement part cannot be dropped silently; owner capital part allowed
--      (proprietor); a sales login is refused (42501); another company's line is refused.
--   E. change_emi_down_payment_source refuses a split down payment (it moves ONE source).
--   F. First EMI ₹30,183 vs ₹27,764: 'interest' extra → principal = schedule principal,
--      interest = schedule interest + 2,419 in ONE 'Interest' expense; schedule of later EMIs
--      unchanged; loan outstanding as per schedule. Undo puts everything back.
--   H. Undo is the exact mirror: an owner part replaced by an equal line comes back as capital;
--      a line comes out of the part on its own account first and goes back there.
--   G. EMI 1 paid by hand (₹27,764 manual line), then the ₹30,183 statement line replaces it
--      with the extra as interest — the manual line goes, interest expense grows by 2,419.

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
insert into public.tenants (id, name, email, state_code, doc_code, business_type) values
  ('dddddddd-0000-0000-0000-000000252301','R2523 Co','r2523@example.in','07','R2523','proprietor'),
  ('dddddddd-0000-0000-0000-000000252302','R2523 Other','r2523b@example.in','07','R2523B','proprietor');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000252301','owner2523@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000252302','sales2523@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000252303','other2523@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000252301','dddddddd-0000-0000-0000-000000252301','owner2523@example.in','Owner 2523','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000252302','dddddddd-0000-0000-0000-000000252301','sales2523@example.in','Sales 2523','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000252303','dddddddd-0000-0000-0000-000000252302','other2523@example.in','Other 2523','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000252301','dddddddd-0000-0000-0000-000000252301','HDFC 4523','HDFC','current', 2020919, '2025-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252302','dddddddd-0000-0000-0000-000000252301','Petty Cash','Cash','cash', 500000, '2025-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252303','dddddddd-0000-0000-0000-000000252302','Other bank','SBI','current', 0, '2025-04-01');

-- Statement lines (imported) as on staging.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000252301','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-01-02','THAR ADVANCE SHIVA AUTO CARS',21000,0,'T1','csv_upload'),
  ('11111111-0000-0000-0000-000000252302','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-01-30','THAR PAYMENT SHIVA AUTO CARS',87394,0,'T2','csv_upload'),
  ('11111111-0000-0000-0000-000000252303','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-02-02','THAR PAYMENT SHIVA AUTO CARS',19700,0,'T3','csv_upload'),
  ('11111111-0000-0000-0000-000000252304','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-03-05','EMI 168081883 CHQ S16808188312',30183,0,'E1','csv_upload'),
  ('11111111-0000-0000-0000-000000252305','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-01-15','THAR ACCESSORIES',250000,0,'T4','csv_upload'),
  ('11111111-0000-0000-0000-000000252309','dddddddd-0000-0000-0000-000000252302','bbbbbbbb-0000-0000-0000-000000252303','2026-01-02','THAR OTHER CO',21000,0,'X1','csv_upload');

-- Loan ₹17,70,000: EMI 1 ₹27,764 (13,000 interest), EMI 2 the rest — valid for the R-1864 checks.
create function pg_temp.r2523_input(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('name','Thar Roxx','block','vehicles','cost',1970000,'down_payment',200000,
    'processing_fee',0,'processing_fee_gst',0,'purchased_on','2026-02-03','lender','HDFC BANK',
    'lender_ref','168081883','interest_rate',9.5,'no_cost',false,
    'account_id','bbbbbbbb-0000-0000-0000-000000252302',
    'schedule','[{"seq":1,"due_on":"2026-03-05","emi":27764,"principal":14764,"interest":13000,"balance_after":1755236},
                 {"seq":2,"due_on":"2026-04-05","emi":1767236,"principal":1755236,"interest":12000,"balance_after":0}]'::jsonb) || p_extra;
$f$;
create function pg_temp.r2523_bal(p_acc uuid) returns bigint language sql as $f$
  select a.opening_balance + coalesce((select sum(credit) - sum(debit) from public.bank_transactions t where t.bank_account_id = a.id), 0)
    from public.bank_accounts a where a.id = p_acc;
$f$;
-- Down-payment parts of a purchase: (manual + imported lines matched to it) + owner capital.
create function pg_temp.r2523_parts(p uuid) returns bigint language sql as $f$
  select coalesce((select sum(debit) from public.bank_transactions where matched_to_type = 'emi' and matched_to_id = p::text), 0)
       + coalesce((select sum(amount) from public.owner_equity_movements where emi_purchase_id = p), 0);
$f$;
create function pg_temp.r2523_petty(p uuid) returns bigint language sql as $f$
  select coalesce(sum(debit), 0) from public.bank_transactions
   where matched_to_type = 'emi' and matched_to_id = p::text and bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252302';
$f$;
create temp table r2523_ids (k text primary key, v uuid);
grant all on r2523_ids to public;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252301","role":"authenticated"}', true);
insert into r2523_ids select 'thar', public.record_emi_asset_purchase(pg_temp.r2523_input());

-- ── A. Bank page: three HDFC lines, one by one, partial amounts ─────────────────────────
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar'); v_m record; v_r jsonb;
begin
  if pg_temp.r2523_petty(v_p) <> 200000 then raise exception 'FAIL setup: petty part should be 2,00,000, got %', pg_temp.r2523_petty(v_p); end if;

  -- The bank page offers the 21,000 line as part of the down payment.
  select * into v_m from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000252301') m
   where m.purchase_id = v_p and m.kind = 'down_payment';
  if v_m.purchase_id is null then raise exception 'FAIL A: the 21,000 THAR line is not offered as part of the down payment'; end if;
  if v_m.expected <> 200000 or v_m.difference <> -179000 then
    raise exception 'FAIL A: partial candidate should show expected 2,00,000 / difference -1,79,000, got % / %', v_m.expected, v_m.difference;
  end if;
  if v_m.confidence <> 'low' then raise exception 'FAIL A: a partial down-payment match must stay "low" (never auto-reconciled), got %', v_m.confidence; end if;

  v_r := public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252301', v_p, 0);
  if pg_temp.r2523_petty(v_p) <> 179000 then raise exception 'FAIL A: petty part after 21,000 should be 1,79,000, got %', pg_temp.r2523_petty(v_p); end if;
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252302', v_p, 0);
  if pg_temp.r2523_petty(v_p) <> 91606 then raise exception 'FAIL A: petty part after 87,394 should be 91,606, got %', pg_temp.r2523_petty(v_p); end if;
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252303', v_p, 0);
  if pg_temp.r2523_petty(v_p) <> 71906 then raise exception 'FAIL A: petty part after 19,700 should be 71,906, got %', pg_temp.r2523_petty(v_p); end if;

  if pg_temp.r2523_parts(v_p) <> 200000 then raise exception 'FAIL A: parts add up to %, not 2,00,000', pg_temp.r2523_parts(v_p); end if;
  if (select count(*) from public.bank_transactions where matched_to_type = 'emi' and matched_to_id = v_p::text and source <> 'manual') <> 3 then
    raise exception 'FAIL A: the three HDFC lines should be matched to the down payment';
  end if;
  if pg_temp.r2523_bal('bbbbbbbb-0000-0000-0000-000000252301') <> 2020919 - 128094 - 250000 - 30183 then
    raise exception 'FAIL A: HDFC balance wrong: %', pg_temp.r2523_bal('bbbbbbbb-0000-0000-0000-000000252301');
  end if;
  if pg_temp.r2523_bal('bbbbbbbb-0000-0000-0000-000000252302') <> 500000 - 71906 then
    raise exception 'FAIL A: Petty Cash should be 4,28,094, got %', pg_temp.r2523_bal('bbbbbbbb-0000-0000-0000-000000252302');
  end if;
  if (select financed from public.emi_purchases where id = v_p) <> 1770000
     or (select cost from public.fixed_assets where emi_purchase_id = v_p) <> 1970000
     or (select count(*) from public.emi_schedule where purchase_id = v_p) <> 2 then
    raise exception 'FAIL A: asset / loan / schedule changed';
  end if;
  -- The purchase still points at one line (the biggest part) for the old screens.
  if (select down_bank_txn_id from public.emi_purchases where id = v_p) is distinct from
     (select id from public.bank_transactions where matched_to_type = 'emi' and matched_to_id = v_p::text order by debit desc, txn_date limit 1) then
    raise exception 'FAIL A: down_bank_txn_id should be the biggest part';
  end if;
end $$;

-- ── B. A line bigger than what is left on manual parts ──────────────────────────────────
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar');
begin
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252305', v_p, 0);
  raise exception 'FAIL B: a 2,50,000 line was taken as part of a 71,906 rest';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like '%71906%' and sqlerrm not like '%71,906%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar');
begin
  if pg_temp.r2523_petty(v_p) <> 71906 or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000252305') is not null then
    raise exception 'FAIL B: the refused reconcile wrote something';
  end if;
end $$;

-- ── C. Undo one part: it goes back to the Petty Cash part ───────────────────────────────
update public.bank_transactions set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
 where id = '11111111-0000-0000-0000-000000252302';
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar');
begin
  if pg_temp.r2523_petty(v_p) <> 159300 then raise exception 'FAIL C: after un-reconciling 87,394 the petty part should be 1,59,300, got %', pg_temp.r2523_petty(v_p); end if;
  if pg_temp.r2523_parts(v_p) <> 200000 then raise exception 'FAIL C: parts add up to % after undo', pg_temp.r2523_parts(v_p); end if;
  if (select count(*) from public.bank_transactions where matched_to_type = 'emi' and matched_to_id = v_p::text and source = 'manual') <> 1 then
    raise exception 'FAIL C: undo should not make a second manual line';
  end if;
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252302', v_p, 0);
  if pg_temp.r2523_petty(v_p) <> 71906 then raise exception 'FAIL C: re-reconcile should bring petty back to 71,906, got %', pg_temp.r2523_petty(v_p); end if;
end $$;

-- ── E. change_emi_down_payment_source moves ONE source — refused on a split ─────────────
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar');
begin
  perform public.change_emi_down_payment_source(v_p, null, true);
  raise exception 'FAIL E: a split down payment was moved whole';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like '%split%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
end $$;

-- ── F. First EMI ₹30,183 vs ₹27,764 — the extra ₹2,419 is broken-period interest ────────
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar'); v_r jsonb; v_pay public.emi_payments; v_m record;
begin
  select * into v_m from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000252304') m where m.purchase_id = v_p and m.seq = 1;
  if v_m.purchase_id is null or v_m.difference <> 2419 then raise exception 'FAIL F: EMI 1 is not offered for the 30,183 line'; end if;

  -- The interest must be the schedule's + the extra, the principal the schedule's.
  begin
    perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252304', v_p, 1, 14764, 13000 + 2000, 0);
    raise exception 'FAIL F: a split that is not the line was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  v_r := public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252304', v_p, 1, 14764, 13000 + 2419, 0);
  select * into v_pay from public.emi_payments where id = (v_r ->> 'payment_id')::uuid;
  if v_pay.amount <> 30183 or v_pay.principal_part <> 14764 or v_pay.interest_part <> 15419 or v_pay.charges <> 0 then
    raise exception 'FAIL F: payment split wrong: % / % / % / %', v_pay.amount, v_pay.principal_part, v_pay.interest_part, v_pay.charges;
  end if;
  if (select amount from public.expenses where id = v_pay.expense_id) <> 15419
     or (select category from public.expenses where id = v_pay.expense_id) <> 'Interest' then
    raise exception 'FAIL F: interest expense should be one Interest expense of 15,419';
  end if;
  if (select description from public.expenses where id = v_pay.expense_id) not like '%2,419 broken-period%' then
    raise exception 'FAIL F: interest expense should say it includes 2,419 broken-period interest: %', (select description from public.expenses where id = v_pay.expense_id);
  end if;
  if exists (select 1 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000252301' and category = 'Bank Charges') then
    raise exception 'FAIL F: broken-period interest must not be a bank charge';
  end if;
  if (select principal from public.emi_schedule where purchase_id = v_p and seq = 2) <> 1755236
     or (select emi from public.emi_schedule where purchase_id = v_p and seq = 2) <> 1767236 then
    raise exception 'FAIL F: EMI 2 changed';
  end if;
  if public.emi_outstanding(v_p) <> 1755236 then raise exception 'FAIL F: loan outstanding should be 17,55,236, got %', public.emi_outstanding(v_p); end if;

  -- Undo: statement line freed, payment + expense gone, schedule back.
  perform public.undo_emi_payment(v_pay.id);
  if exists (select 1 from public.emi_payments where purchase_id = v_p)
     or exists (select 1 from public.expenses where id = v_pay.expense_id)
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000252304') is not null
     or (select interest from public.emi_schedule where purchase_id = v_p and seq = 1) <> 13000 then
    raise exception 'FAIL F: undo did not put everything back';
  end if;
end $$;

-- ── G. EMI 1 paid by hand (27,764), then the 30,183 statement line replaces it ──────────
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar'); v_r jsonb; v_pay public.emi_payments; v_manual uuid; v_m record;
begin
  v_r := public.pay_next_emi(v_p, 'bbbbbbbb-0000-0000-0000-000000252301', '2026-03-03');
  select * into v_pay from public.emi_payments where id = (v_r ->> 'payment_id')::uuid;
  v_manual := v_pay.bank_txn_id;

  select * into v_m from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000252304') m
   where m.purchase_id = v_p and m.seq = 1 and m.kind = 'paid_by_hand';
  if v_m.purchase_id is null or v_m.difference <> 2419 then raise exception 'FAIL G: the paid-by-hand EMI 1 is not offered for the bigger line'; end if;

  begin
    perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252304', v_p, 1);
    raise exception 'FAIL G: a bigger line replaced the manual EMI without saying what the extra is';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  v_r := public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252304', v_p, 1, null, 13000 + 2419, 0);
  select * into v_pay from public.emi_payments where id = v_pay.id;
  if v_pay.bank_txn_id <> '11111111-0000-0000-0000-000000252304' or v_pay.amount <> 30183
     or v_pay.interest_part <> 15419 or v_pay.principal_part <> 14764 then
    raise exception 'FAIL G: payment not moved to the statement line with the extra interest';
  end if;
  if exists (select 1 from public.bank_transactions where id = v_manual) then raise exception 'FAIL G: the manual 27,764 line is still there'; end if;
  if (select amount from public.expenses where id = v_pay.expense_id) <> 15419 then raise exception 'FAIL G: interest expense not 15,419'; end if;
  if (select interest from public.emi_schedule where purchase_id = v_p and seq = 1) <> 15419 then raise exception 'FAIL G: schedule row 1 should show the interest paid'; end if;
  if public.emi_outstanding(v_p) <> 1755236 then raise exception 'FAIL G: outstanding wrong'; end if;
end $$;

-- ── D. set_emi_down_payment_parts: the whole split in one step ──────────────────────────
-- A second purchase (the same car again, for the one-step path) with its own three statement lines.
select set_config('request.jwt.claims', '', true);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000252311','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-01-02','THAR ADVANCE SHIVA AUTO CARS',21000,0,'U1','csv_upload'),
  ('11111111-0000-0000-0000-000000252312','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-01-30','THAR PAYMENT SHIVA AUTO CARS',87394,0,'U2','csv_upload'),
  ('11111111-0000-0000-0000-000000252313','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-02-02','THAR PAYMENT SHIVA AUTO CARS',19700,0,'U3','csv_upload');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252301","role":"authenticated"}', true);
insert into r2523_ids select 'thar2', public.record_emi_asset_purchase(pg_temp.r2523_input());

create function pg_temp.r2523_split(p_petty integer, p_extra jsonb default '[]'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_array(
    jsonb_build_object('bank_txn_id','11111111-0000-0000-0000-000000252311'),
    jsonb_build_object('bank_txn_id','11111111-0000-0000-0000-000000252312'),
    jsonb_build_object('bank_txn_id','11111111-0000-0000-0000-000000252313'),
    jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000252302','amount',p_petty)) || p_extra;
$f$;

-- Must add up.
do $$ begin
  perform public.set_emi_down_payment_parts((select v from r2523_ids where k = 'thar2'), pg_temp.r2523_split(70000));
  raise exception 'FAIL D: parts that do not add up were accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like '%2,00,000%' and sqlerrm not like '%200000%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
end $$;
-- Another company's line.
do $$ begin
  perform public.set_emi_down_payment_parts((select v from r2523_ids where k = 'thar2'),
    jsonb_build_array(jsonb_build_object('bank_txn_id','11111111-0000-0000-0000-000000252309'),
                      jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000252302','amount',179000)));
  raise exception 'FAIL D: another company''s bank line was used';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Bank line not found in your company%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
end $$;
-- Sales login.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252302","role":"authenticated"}', true);
do $$ begin
  perform public.set_emi_down_payment_parts((select v from r2523_ids where k = 'thar2'), pg_temp.r2523_split(71906));
  raise exception 'FAIL D: a sales login split a down payment';
exception when insufficient_privilege then null;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252301","role":"authenticated"}', true);
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar2');
begin
  if pg_temp.r2523_petty(v_p) <> 200000 then raise exception 'FAIL D: a refused split wrote something (petty %)', pg_temp.r2523_petty(v_p); end if;
end $$;

-- The real split.
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar2'); v_r jsonb;
begin
  v_r := public.set_emi_down_payment_parts(v_p, pg_temp.r2523_split(71906));
  if pg_temp.r2523_petty(v_p) <> 71906 or pg_temp.r2523_parts(v_p) <> 200000 then
    raise exception 'FAIL D: split not booked: petty %, total %', pg_temp.r2523_petty(v_p), pg_temp.r2523_parts(v_p);
  end if;
  if (select count(*) from public.bank_transactions where matched_to_type = 'emi' and matched_to_id = v_p::text) <> 4 then
    raise exception 'FAIL D: expected 3 statement lines + 1 Petty Cash line';
  end if;
  -- Petty Cash pays 71,906 for each of the two purchases.
  if pg_temp.r2523_bal('bbbbbbbb-0000-0000-0000-000000252302') <> 500000 - 71906 - 71906 then raise exception 'FAIL D: Petty Cash balance wrong'; end if;
  if not exists (select 1 from public.activity_log where entity_id = v_p::text and action = 'emi_down_payment_split') then
    raise exception 'FAIL D: no activity_log row';
  end if;

  -- Dropping a reconciled statement part silently is refused.
  begin
    perform public.set_emi_down_payment_parts(v_p, jsonb_build_array(
      jsonb_build_object('bank_txn_id','11111111-0000-0000-0000-000000252311'),
      jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000252302','amount',179000)));
    raise exception 'FAIL D: a reconciled statement part was dropped';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%un-reconcile%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
  end;

  -- Petty part → owner capital (proprietor): no bank line, capital +71,906.
  v_r := public.set_emi_down_payment_parts(v_p, (pg_temp.r2523_split(0) - 3)
           || jsonb_build_array(jsonb_build_object('paid_by_owner', true, 'amount', 71906)));
  if pg_temp.r2523_petty(v_p) <> 0 or (select amount from public.owner_equity_movements where emi_purchase_id = v_p) <> 71906
     or pg_temp.r2523_parts(v_p) <> 200000 then
    raise exception 'FAIL D: owner part not booked';
  end if;
  if pg_temp.r2523_bal('bbbbbbbb-0000-0000-0000-000000252302') <> 500000 - 71906 then raise exception 'FAIL D: Petty Cash should only carry the first purchase''s 71,906'; end if;
end $$;


-- ── H. Undo is the exact mirror (down_taken_from) ───────────────────────────────────────
--   H1. Paid by owner ₹2,00,000; an equal HDFC statement line replaces the owner part (offered,
--       but LOW — never auto-reconciled); un-reconciling brings the capital row back, no
--       manual line on HDFC.
--   H2. Parts HDFC by hand ₹50,000 + Petty Cash ₹1,50,000: an HDFC ₹30,000 line comes out of the
--       HDFC part (same account first), not the bigger Petty Cash one; undo puts HDFC back.
select set_config('request.jwt.claims', '', true);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000252321','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-02-03','THAR FULL PAYMENT',200000,0,'V1','csv_upload'),
  ('11111111-0000-0000-0000-000000252322','dddddddd-0000-0000-0000-000000252301','bbbbbbbb-0000-0000-0000-000000252301','2026-02-01','THAR PART PAYMENT',30000,0,'V2','csv_upload');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252301","role":"authenticated"}', true);
insert into r2523_ids select 'thar3', public.record_emi_asset_purchase((pg_temp.r2523_input() - 'account_id') || '{"paid_by_owner": true}'::jsonb);

do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar3'); v_m record;
begin
  if (select amount from public.owner_equity_movements where emi_purchase_id = v_p) <> 200000 then raise exception 'FAIL H1 setup: no owner part'; end if;
  select * into v_m from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000252321') m where m.purchase_id = v_p;
  if v_m.purchase_id is null or v_m.difference <> 0 then raise exception 'FAIL H1: the equal line is not offered for the owner part'; end if;
  if v_m.confidence <> 'low' then raise exception 'FAIL H1: replacing an owner part must never be auto (confidence %)', v_m.confidence; end if;

  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252321', v_p, 0);
  if exists (select 1 from public.owner_equity_movements where emi_purchase_id = v_p) or pg_temp.r2523_parts(v_p) <> 200000 then
    raise exception 'FAIL H1: the line did not replace the owner part';
  end if;
end $$;
update public.bank_transactions set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
 where id = '11111111-0000-0000-0000-000000252321';
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar3');
begin
  if coalesce((select amount from public.owner_equity_movements where emi_purchase_id = v_p and kind = 'capital_introduced'), 0) <> 200000 then
    raise exception 'FAIL H1: un-reconcile did not bring the owner capital back';
  end if;
  if exists (select 1 from public.bank_transactions where matched_to_type = 'emi' and matched_to_id = v_p::text) then
    raise exception 'FAIL H1: un-reconcile made a manual line on HDFC (the outflow would show twice)';
  end if;
  if (select down_taken_from from public.emi_purchases where id = v_p) <> '{}'::jsonb then raise exception 'FAIL H1: down_taken_from not cleared'; end if;
end $$;

do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar3'); v_hdfc_manual bigint;
begin
  perform public.set_emi_down_payment_parts(v_p, jsonb_build_array(
    jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000252301','amount',50000,'date','2026-02-03'),
    jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000252302','amount',150000)));
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252322', v_p, 0);
  select debit into v_hdfc_manual from public.bank_transactions
   where matched_to_type = 'emi' and matched_to_id = v_p::text and source = 'manual' and bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252301';
  if v_hdfc_manual <> 20000 or pg_temp.r2523_petty(v_p) <> 150000 then
    raise exception 'FAIL H2: the HDFC line should come out of the HDFC part (HDFC by hand %, petty %)', v_hdfc_manual, pg_temp.r2523_petty(v_p);
  end if;
end $$;
update public.bank_transactions set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
 where id = '11111111-0000-0000-0000-000000252322';
do $$
declare v_p uuid := (select v from r2523_ids where k = 'thar3');
begin
  if (select debit from public.bank_transactions where matched_to_type = 'emi' and matched_to_id = v_p::text and source = 'manual'
        and bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252301') <> 50000 or pg_temp.r2523_petty(v_p) <> 150000 then
    raise exception 'FAIL H2: undo did not put the HDFC part back to 50,000';
  end if;
end $$;

rollback;
