-- R-2529 (6 Nov 2026): follow-ups of the independent review of R-2523 (EMI down payment from
-- several sources). Migration 20261106121452_r2529_emi_dp_followups.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. (finding 1) Un-reconcile after the part a line was taken out of is gone: Petty Cash
--      ₹2,00,000; HDFC ₹1,00,000 #1 is taken out of it, HDFC ₹1,00,000 #2 replaces the rest.
--      Un-reconciling #1 brings ₹1,00,000 back on PETTY CASH on its own date — not a manual
--      HDFC line (the outflow would show twice on HDFC).
--   B. Un-reconcile after a split reset down_taken_from: the statement line kept through the
--      split goes back as a manual part on its own account; parts still add up.
--   C. (finding 2) Books lock against the PART's date: a line dated after the lock cannot be
--      taken out of an owner part (or manual part) dated inside it — reconcile AND un-reconcile,
--      for an app login and for a service-role caller alike.
--   D. set_emi_down_payment_parts: the same statement line twice; another company's account.
--   E. (finding 3) Extra interest is capped at the UI's limit — ₹2,000 or 10% of the EMI,
--      whichever is bigger — on a fresh instalment and on a paid-by-hand EMI.
--   F. A second extra-interest attempt on an EMI already moved to a statement line is refused
--      and changes nothing; undo of R-2523 case G (paid by hand → bigger statement line) puts
--      the schedule, expense and line back.
--   G. (finding 4) A down-payment part is not offered for a debit that does not name the item
--      or is outside 90 days before … 10 days after the purchase — so it no longer blocks the
--      R-1867 vendor auto-match; a named line in the window still is.

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
  ('dddddddd-0000-0000-0000-000000252901','R2529 Co','r2529@example.in','07','R2529','proprietor'),
  ('dddddddd-0000-0000-0000-000000252902','R2529 Other','r2529b@example.in','07','R2529B','proprietor');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000252901','owner2529@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000252903','other2529@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000252901','dddddddd-0000-0000-0000-000000252901','owner2529@example.in','Owner 2529','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000252903','dddddddd-0000-0000-0000-000000252902','other2529@example.in','Other 2529','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000252901','dddddddd-0000-0000-0000-000000252901','HDFC 4523','HDFC','current', 5000000, '2025-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252902','dddddddd-0000-0000-0000-000000252901','Petty Cash','Cash','cash', 5000000, '2025-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252903','dddddddd-0000-0000-0000-000000252902','Other bank','SBI','current', 0, '2025-04-01');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  -- A
  ('11111111-0000-0000-0000-000000252901','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-01-30','THAR PAYMENT SHIVA AUTO CARS',100000,0,'A1','csv_upload'),
  ('11111111-0000-0000-0000-000000252902','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-02-02','THAR PAYMENT SHIVA AUTO CARS',100000,0,'A2','csv_upload'),
  -- B
  ('11111111-0000-0000-0000-000000252903','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-02-01','THAR ADVANCE',50000,0,'B1','csv_upload'),
  -- C (dated after the lock of 31 Jan; the parts are dated 10 Jan)
  ('11111111-0000-0000-0000-000000252904','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-02-05','THAR PAYMENT',50000,0,'C1','csv_upload'),
  ('11111111-0000-0000-0000-000000252905','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-02-06','THAR PAYMENT',40000,0,'C2','csv_upload'),
  ('11111111-0000-0000-0000-000000252906','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-02-07','THAR PAYMENT',30000,0,'C3','csv_upload'),
  -- E / F (EMI lines)
  ('11111111-0000-0000-0000-000000252911','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-03-05','EMI 168081883 CHQ',30764,0,'E1','csv_upload'),
  ('11111111-0000-0000-0000-000000252912','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-03-05','EMI 168081883 CHQ',30183,0,'F1','csv_upload'),
  ('11111111-0000-0000-0000-000000252913','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-03-06','EMI 168081883 CHQ',30183,0,'F2','csv_upload'),
  -- G (vendor payments of the same amount as a down-payment part)
  ('11111111-0000-0000-0000-000000252921','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-02-03','NEFT SHIVA AUTO CARS INV 77',200000,0,'G1','csv_upload'),
  ('11111111-0000-0000-0000-000000252922','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-08-20','THAR SERVICE',200000,0,'G2','csv_upload'),
  ('11111111-0000-0000-0000-000000252923','dddddddd-0000-0000-0000-000000252901','bbbbbbbb-0000-0000-0000-000000252901','2026-02-03','THAR FULL DOWN PAYMENT',200000,0,'G3','csv_upload');

-- Thar Roxx: ₹19,70,000, down ₹2,00,000 on 3 Feb 2026, HDFC loan ₹17,70,000; EMI 1 ₹27,764.
create function pg_temp.r2529_input(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('name','Thar Roxx','block','vehicles','cost',1970000,'down_payment',200000,
    'processing_fee',0,'processing_fee_gst',0,'purchased_on','2026-02-03','lender','HDFC BANK',
    'lender_ref','168081883','interest_rate',9.5,'no_cost',false,
    'account_id','bbbbbbbb-0000-0000-0000-000000252902',
    'schedule','[{"seq":1,"due_on":"2026-03-05","emi":27764,"principal":14764,"interest":13000,"balance_after":1755236},
                 {"seq":2,"due_on":"2026-04-05","emi":1767236,"principal":1755236,"interest":12000,"balance_after":0}]'::jsonb) || p_extra;
$f$;
create function pg_temp.r2529_parts(p uuid) returns bigint language sql as $f$
  select coalesce((select sum(debit) from public.bank_transactions where matched_to_type = 'emi' and matched_to_id = p::text), 0)
       + coalesce((select sum(amount) from public.owner_equity_movements where emi_purchase_id = p), 0);
$f$;
create function pg_temp.r2529_manual(p uuid, p_acc uuid) returns bigint language sql as $f$
  select coalesce(sum(debit), 0) from public.bank_transactions
   where matched_to_type = 'emi' and matched_to_id = p::text and source = 'manual' and bank_account_id = p_acc;
$f$;
create function pg_temp.r2529_free(p_txn uuid) returns void language sql as $f$
  update public.bank_transactions set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
   where id = p_txn;
$f$;
create temp table r2529_ids (k text primary key, v uuid);
grant all on r2529_ids to public;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252901","role":"authenticated"}', true);
insert into r2529_ids select 'a', public.record_emi_asset_purchase(pg_temp.r2529_input());
insert into r2529_ids select 'b', public.record_emi_asset_purchase(pg_temp.r2529_input());
insert into r2529_ids select 'c_owner', public.record_emi_asset_purchase((pg_temp.r2529_input() - 'account_id') || '{"paid_by_owner": true}'::jsonb);
insert into r2529_ids select 'c_manual', public.record_emi_asset_purchase(pg_temp.r2529_input());
insert into r2529_ids select 'd', public.record_emi_asset_purchase(pg_temp.r2529_input());
insert into r2529_ids select 'e', public.record_emi_asset_purchase(pg_temp.r2529_input());
insert into r2529_ids select 'f', public.record_emi_asset_purchase(pg_temp.r2529_input());

-- ── A. Taken-from part gone → back to the ORIGINAL account and date ─────────────────────
do $$
declare v_p uuid := (select v from r2529_ids where k = 'a');
begin
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252901', v_p, 0);  -- out of Petty 2L → 1L
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252902', v_p, 0);  -- replaces Petty 1L
  if pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252902') <> 0 or pg_temp.r2529_parts(v_p) <> 200000 then
    raise exception 'FAIL A setup: petty part should be gone, parts 2,00,000 (petty %, parts %)',
      pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252902'), pg_temp.r2529_parts(v_p);
  end if;
end $$;
select pg_temp.r2529_free('11111111-0000-0000-0000-000000252901');
do $$
declare v_p uuid := (select v from r2529_ids where k = 'a');
begin
  if pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252901') <> 0 then
    raise exception 'FAIL A: un-reconcile made a manual HDFC line (₹%) — the part was taken out of Petty Cash',
      pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252901');
  end if;
  if pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252902') <> 100000 then
    raise exception 'FAIL A: Petty Cash part should be back at 1,00,000, got %', pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252902');
  end if;
  if not exists (select 1 from public.bank_transactions where matched_to_type = 'emi' and matched_to_id = v_p::text
                  and source = 'manual' and bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252902' and txn_date = '2026-02-03') then
    raise exception 'FAIL A: the Petty Cash part should come back on its own date (3 Feb 2026)';
  end if;
  if pg_temp.r2529_parts(v_p) <> 200000 then raise exception 'FAIL A: parts add up to %', pg_temp.r2529_parts(v_p); end if;
end $$;

-- ── B. A split resets down_taken_from: the kept statement line goes back on its own account ─
do $$
declare v_p uuid := (select v from r2529_ids where k = 'b');
begin
  perform public.set_emi_down_payment_parts(v_p, jsonb_build_array(
    jsonb_build_object('bank_txn_id','11111111-0000-0000-0000-000000252903'),
    jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000252902','amount',150000)));
  if (select down_taken_from from public.emi_purchases where id = v_p) <> '{}'::jsonb then raise exception 'FAIL B setup: split should reset down_taken_from'; end if;
end $$;
select pg_temp.r2529_free('11111111-0000-0000-0000-000000252903');
do $$
declare v_p uuid := (select v from r2529_ids where k = 'b');
begin
  if pg_temp.r2529_parts(v_p) <> 200000 then raise exception 'FAIL B: parts add up to % after un-reconcile', pg_temp.r2529_parts(v_p); end if;
  if pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252901') <> 50000
     or pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252902') <> 150000 then
    raise exception 'FAIL B: expected HDFC by hand 50,000 + Petty 1,50,000, got % + %',
      pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252901'), pg_temp.r2529_manual(v_p, 'bbbbbbbb-0000-0000-0000-000000252902');
  end if;
end $$;

-- ── C. Books lock against the PART's date ───────────────────────────────────────────────
-- The parts are dated 10 Jan 2026 (the purchase is 3 Feb — its own row is NOT in the lock, so
-- only the part's date can stop it). Before the lock: C2 (40,000) taken out of the manual part,
-- C3 (30,000) out of the owner part. Then the books are locked up to 31 Jan.
do $$ begin
  perform public.set_emi_down_payment_parts((select v from r2529_ids where k = 'c_manual'), jsonb_build_array(
    jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000252902','amount',200000,'date','2026-01-10')));
  perform public.set_emi_down_payment_parts((select v from r2529_ids where k = 'c_owner'), jsonb_build_array(
    jsonb_build_object('paid_by_owner',true,'amount',200000,'date','2026-01-10')));
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252905', (select v from r2529_ids where k = 'c_manual'), 0);
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252906', (select v from r2529_ids where k = 'c_owner'), 0);
end $$;
select set_config('request.jwt.claims', '', true);
update public.tenants set books_locked_until = '2026-01-31' where id = 'dddddddd-0000-0000-0000-000000252901';
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252901","role":"authenticated"}', true);

-- C1. Reconcile a line dated 5 Feb (open) out of the owner part dated 10 Jan (locked) — refused.
do $$
declare v_p uuid := (select v from r2529_ids where k = 'c_owner');
begin
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252904', v_p, 0);
  raise exception 'FAIL C1: a line was taken out of an owner part in a locked month';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Books are locked%' then raise exception 'FAIL C1: wrong refusal: %', sqlerrm; end if;
end $$;
-- C1b. … and out of a manual part dated 3 Feb — refused too.
do $$
declare v_p uuid := (select v from r2529_ids where k = 'c_manual');
begin
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252904', v_p, 0);
  raise exception 'FAIL C1b: a line was taken out of a manual part in a locked month';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Books are locked%' then raise exception 'FAIL C1b: wrong refusal: %', sqlerrm; end if;
end $$;
-- C2. Un-reconcile C3 (back into the locked owner part) — refused for an app login …
do $$
begin
  perform pg_temp.r2529_free('11111111-0000-0000-0000-000000252906');
  raise exception 'FAIL C2: un-reconcile changed an owner part in a locked month';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Books are locked%' then raise exception 'FAIL C2: wrong refusal: %', sqlerrm; end if;
end $$;
-- … and for a service-role caller (the bank_transactions lock trigger lets service_role through).
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
  perform pg_temp.r2529_free('11111111-0000-0000-0000-000000252906');
  raise exception 'FAIL C2s: service-role un-reconcile changed an owner part in a locked month';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Books are locked%' then raise exception 'FAIL C2s: wrong refusal: %', sqlerrm; end if;
end $$;
do $$
begin
  perform pg_temp.r2529_free('11111111-0000-0000-0000-000000252905');
  raise exception 'FAIL C2m: service-role un-reconcile changed a manual part in a locked month';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Books are locked%' then raise exception 'FAIL C2m: wrong refusal: %', sqlerrm; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252901","role":"authenticated"}', true);
do $$
begin
  if (select amount from public.owner_equity_movements where emi_purchase_id = (select v from r2529_ids where k = 'c_owner')) <> 170000
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000252906') is distinct from 'emi'
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000252904') is not null then
    raise exception 'FAIL C: a refused reconcile / un-reconcile wrote something';
  end if;
end $$;
select set_config('request.jwt.claims', '', true);
update public.tenants set books_locked_until = null where id = 'dddddddd-0000-0000-0000-000000252901';
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252901","role":"authenticated"}', true);

-- ── D. set_emi_down_payment_parts: same line twice; another company's account ───────────
do $$ begin
  perform public.set_emi_down_payment_parts((select v from r2529_ids where k = 'd'), jsonb_build_array(
    jsonb_build_object('bank_txn_id','11111111-0000-0000-0000-000000252904'),
    jsonb_build_object('bank_txn_id','11111111-0000-0000-0000-000000252904'),
    jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000252902','amount',100000)));
  raise exception 'FAIL D: the same statement line was used twice';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like '%twice%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  perform public.set_emi_down_payment_parts((select v from r2529_ids where k = 'd'), jsonb_build_array(
    jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000252903','amount',200000)));
  raise exception 'FAIL D: another company''s account was used';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like '%not in your company%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  if pg_temp.r2529_manual((select v from r2529_ids where k = 'd'), 'bbbbbbbb-0000-0000-0000-000000252902') <> 200000
     or exists (select 1 from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252903') then
    raise exception 'FAIL D: a refused split wrote something';
  end if;
end $$;

-- ── E. Extra interest cap: ₹2,000 or 10% of the EMI (₹2,776 here), whichever is bigger ──
do $$
declare v_p uuid := (select v from r2529_ids where k = 'e');
begin
  -- 30,764 = 27,764 + 3,000: 3,000 > 2,776 → refused.
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252911', v_p, 1, 14764, 13000 + 3000, 0);
  raise exception 'FAIL E: ₹3,000 extra interest (cap ₹2,776) was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like '%2,776%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
end $$;
do $$
declare v_p uuid := (select v from r2529_ids where k = 'e'); v_pay uuid; v_r jsonb;
begin
  if exists (select 1 from public.emi_payments where purchase_id = v_p) then raise exception 'FAIL E: refused reconcile wrote a payment'; end if;
  -- Paid by hand (27,764), then the 30,764 line with the extra as interest — refused too.
  v_r := public.pay_next_emi(v_p, 'bbbbbbbb-0000-0000-0000-000000252901', '2026-03-03');
  v_pay := (v_r ->> 'payment_id')::uuid;
  begin
    perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252911', v_p, 1, null, 13000 + 3000, 0);
    raise exception 'FAIL E: ₹3,000 extra interest on a paid-by-hand EMI was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%2,776%' then raise exception 'FAIL E: wrong refusal (by hand): %', sqlerrm; end if;
  end;
  if (select interest_part from public.emi_payments where id = v_pay) <> 13000 then raise exception 'FAIL E: the refused by-hand reconcile changed the payment'; end if;
  -- Within the cap (2,419) still works.
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252912', v_p, 1, null, 13000 + 2419, 0);
  if (select interest_part from public.emi_payments where id = v_pay) <> 15419 then raise exception 'FAIL E: 2,419 within the cap was not taken'; end if;
end $$;

-- ── F. Second extra-interest attempt; undo of R-2523 case G ─────────────────────────────
do $$
declare v_p uuid := (select v from r2529_ids where k = 'e'); v_pay public.emi_payments;
begin
  select * into v_pay from public.emi_payments where purchase_id = v_p;
  begin
    perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000252913', v_p, 1, null, 13000 + 2419 + 2419, 0);
    raise exception 'FAIL F: a second extra-interest reconcile on EMI 1 was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  if (select interest_part from public.emi_payments where id = v_pay.id) <> 15419
     or (select amount from public.expenses where id = v_pay.expense_id) <> 15419
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000252913') is not null then
    raise exception 'FAIL F: the refused second attempt changed something';
  end if;
end $$;
-- Undo case G: un-reconcile the 30,183 statement line.
select pg_temp.r2529_free('11111111-0000-0000-0000-000000252912');
do $$
declare v_p uuid := (select v from r2529_ids where k = 'e');
begin
  if exists (select 1 from public.emi_payments where purchase_id = v_p) then raise exception 'FAIL F: undo left the EMI payment'; end if;
  if exists (select 1 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000252901' and category = 'Interest'
              and description like '%' || 'Thar Roxx · EMI 1%') then
    raise exception 'FAIL F: undo left the interest expense';
  end if;
  if (select interest from public.emi_schedule where purchase_id = v_p and seq = 1) <> 13000
     or (select emi from public.emi_schedule where purchase_id = v_p and seq = 1) <> 27764
     or (select emi_payment_id from public.emi_schedule where purchase_id = v_p and seq = 1) is not null then
    raise exception 'FAIL F: undo did not put the schedule back (interest %, emi %)',
      (select interest from public.emi_schedule where purchase_id = v_p and seq = 1), (select emi from public.emi_schedule where purchase_id = v_p and seq = 1);
  end if;
  if public.emi_outstanding(v_p) <> 1770000 then raise exception 'FAIL F: outstanding should be 17,70,000, got %', public.emi_outstanding(v_p); end if;
end $$;

-- ── G. Down-payment candidates need the item named + the date window ────────────────────
do $$
declare v_p uuid := (select v from r2529_ids where k = 'f');
begin
  if exists (select 1 from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000252921') m where m.purchase_id = v_p and m.kind = 'down_payment') then
    raise exception 'FAIL G: a vendor payment that does not name the item was offered as the down payment';
  end if;
  if exists (select 1 from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000252922') m where m.purchase_id = v_p and m.kind = 'down_payment') then
    raise exception 'FAIL G: a line 6 months after the purchase was offered as the down payment';
  end if;
  if not exists (select 1 from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000252923') m where m.purchase_id = v_p and m.kind = 'down_payment') then
    raise exception 'FAIL G: the named line on the purchase date is no longer offered';
  end if;
end $$;

rollback;
