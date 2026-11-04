\set ON_ERROR_STOP on
-- R-2364 (P1 money): Banking → Reconcile → "Suggested matches" never offers a receipt that another
-- bank line already uses, a known payer's customer ranks first, and reconcile_bank_txn refuses to
-- link a second bank line to a payment another line already carries.
-- Migration: 20261104060346_r2364_suggestions_skip_used.sql
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2364_suggestions_skip_used.test.sql
--
-- Expect "PASS r2364_suggestions_skip_used". Every check is collected and failures listed together.
--
--   USED     4 Nov Chrome (scenario zero-ref-credits): two ₹5,000 lines, ref 000…, one customer.
--            Line 1 booked → receipt P1 (reference BANK-<line 1>), line 1 matched to it. Opening
--            line 2 offered P1 as "Payment · High". Now: P1 is never suggested for line 2 (still
--            for line 1 itself); nor a receipt another line is matched to (P2), one whose
--            BANK-<id> reference names another line (P3), one a split line carries (P4), nor an
--            expense another debit line is reconciled to (E1). A free receipt (P7) still is.
--   PAYER    2 Nov staging (Gibi Paul ₹3,717, known payer of Bethelsoft): other customers'
--            ₹3,717 receipts came first. Now the known payer's customer's receipt is first and
--            the other customer's same-amount receipt is only 'low' (its name in the label) —
--            from customer_payers (narration) and from the line's own payer answer.
--   GUARD    reconcile_bank_txn(line 2 → P1) is refused; line 1 → P1 again and line 2 → P7 work.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2364000-0000-4000-8000-0000000000a2', 'r2364-billing@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2364000-0000-0000-0000-0000000000a0', 'R2364 Co', 'r2364@example.in', '07', 'R236');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2364000-0000-4000-8000-0000000000a2', 'e2364000-0000-0000-0000-0000000000a0', 'r2364-billing@example.in', 'R2364 Billing', 'billing', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2364000-0000-4000-8000-0000000000c1', 'e2364000-0000-0000-0000-0000000000a0', 'R2364 Zero Ref Traders', '07', 'India'),
  ('e2364000-0000-4000-8000-0000000000c2', 'e2364000-0000-0000-0000-0000000000a0', 'R2364 Jene Chemicals', '07', 'India'),
  ('e2364000-0000-4000-8000-0000000000c3', 'e2364000-0000-0000-0000-0000000000a0', 'R2364 Bethelsoft', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e2364000-0000-4000-8000-0000000000ba', 'e2364000-0000-0000-0000-0000000000a0', 'R2364 Current', 'R2364 Bank');

-- Bank lines: L1/L2 the two ₹5,000 zero-ref credits; L3 a line already matched to P2; L4 the line
-- P3 was created from (since reconciled to something else); L5 a split line carrying P4; L6 the
-- Gibi Paul ₹3,717 credit; L7/L8 two ₹900 debits (L7 reconciled to E1); L9 a ₹3,717 credit whose
-- payer answer names Bethelsoft; L10 an un-reconciled line P8 was created from (P8 is free again);
-- L11 a ₹3,717 credit from "GIBI PAUL TRADERS" — not the known payer "GIBI PAUL".
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit) values
  ('e2364000-0000-4000-8000-0000000000e1', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-10', 'NEFT CR R2364 ZERO REF', '000000000000', 5000, 0),
  ('e2364000-0000-4000-8000-0000000000e2', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-10', 'NEFT CR R2364 ZERO REF', '000000000000', 5000, 0),
  ('e2364000-0000-4000-8000-0000000000e3', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-09', 'NEFT CR R2364 OTHER', 'UTR2364B', 5000, 0),
  ('e2364000-0000-4000-8000-0000000000e4', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-11', 'NEFT CR R2364 FOUR', null, 5000, 0),
  ('e2364000-0000-4000-8000-0000000000e5', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-11', 'NEFT CR R2364 SPLIT', null, 9000, 0),
  ('e2364000-0000-4000-8000-0000000000e6', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-20', 'NEFT CR-INDB0000006-GIBI PAUL-R2364-INDBH2310', null, 3717, 0),
  ('e2364000-0000-4000-8000-0000000000e7', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-15', 'UPI R2364 RENT', null, 0, 900),
  ('e2364000-0000-4000-8000-0000000000e8', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-15', 'UPI R2364 RENT', null, 0, 900),
  ('e2364000-0000-4000-8000-0000000000e9', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-20', 'IMPS R2364 SOMEONE', null, 3717, 0),
  ('e2364000-0000-4000-8000-0000000000ea', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-12', 'NEFT CR R2364 DUP IMPORT', null, 5000, 0),
  ('e2364000-0000-4000-8000-0000000000eb', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000ba', '2026-10-20', 'NEFT CR-INDB0000006-GIBI PAUL TRADERS-R2364-INDBH2311', null, 3717, 0);

-- One-off quotes (no subscription side effects), not invoiced — a receipt needs a quote or invoice.
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
select 'Q-R2364-' || k, 'e2364000-0000-0000-0000-0000000000a0', null, c::uuid, n, amt, round(amt / 1.18), 18, 'accepted', 'awaiting', '[]'::jsonb
  from (values ('1', 'e2364000-0000-4000-8000-0000000000c1', 'R2364 Zero Ref Traders', 5000), ('2', 'e2364000-0000-4000-8000-0000000000c1', 'R2364 Zero Ref Traders', 5000),
               ('3', 'e2364000-0000-4000-8000-0000000000c1', 'R2364 Zero Ref Traders', 5000), ('4', 'e2364000-0000-4000-8000-0000000000c1', 'R2364 Zero Ref Traders', 5000),
               ('5', 'e2364000-0000-4000-8000-0000000000c2', 'R2364 Jene Chemicals', 3717), ('6', 'e2364000-0000-4000-8000-0000000000c3', 'R2364 Bethelsoft', 3717),
               ('7', 'e2364000-0000-4000-8000-0000000000c1', 'R2364 Zero Ref Traders', 5000),
               ('8', 'e2364000-0000-4000-8000-0000000000c1', 'R2364 Zero Ref Traders', 5000), ('9', 'e2364000-0000-4000-8000-0000000000c2', 'R2364 Jene Chemicals', 3717)) v(k, c, n, amt);
insert into public.payments (id, tenant_id, customer_id, amount, method, reference, status, received_at, bank_txn_id, quote_id) values
  -- P1: created from line 1 (BANK-<line 1>), line 1 matched to it.
  ('e2364000-0000-4000-8000-0000000000f1', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000c1', 5000, 'bank_transfer', 'BANK-e2364000-0000-4000-8000-0000000000e1', 'received', '2026-10-10 10:00+05:30', null, 'Q-R2364-1'),
  -- P2: plain reference, line 3 matched to it.
  ('e2364000-0000-4000-8000-0000000000f2', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000c1', 5000, 'bank_transfer', 'UTR2364B', 'received', '2026-10-09 10:00+05:30', null, 'Q-R2364-2'),
  -- P3: created from line 4 (BANK-<line 4>); line 4 is reconciled (to something else).
  ('e2364000-0000-4000-8000-0000000000f3', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000c1', 5000, 'bank_transfer', 'BANK-e2364000-0000-4000-8000-0000000000e4', 'received', '2026-10-11 10:00+05:30', null, 'Q-R2364-3'),
  -- P4: one of several receipts the split line 5 carries (payments.bank_txn_id).
  ('e2364000-0000-4000-8000-0000000000f4', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000c1', 5000, 'bank_transfer', 'SPLIT2364', 'received', '2026-10-11 10:00+05:30', null, 'Q-R2364-4'),
  -- P5: another customer's ₹3,717, same day as line 6.  P6: Bethelsoft's ₹3,717, two days later.
  ('e2364000-0000-4000-8000-0000000000f5', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000c2', 3717, 'bank_transfer', 'JENE2364', 'received', '2026-10-20 10:00+05:30', null, 'Q-R2364-5'),
  ('e2364000-0000-4000-8000-0000000000f6', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000c3', 3717, 'bank_transfer', 'BETH2364', 'received', '2026-10-22 10:00+05:30', null, 'Q-R2364-6'),
  -- P7: a free ₹5,000 receipt of the same customer — still a fair suggestion for line 2.
  ('e2364000-0000-4000-8000-0000000000f7', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000c1', 5000, 'bank_transfer', 'FREE2364', 'received', '2026-10-12 10:00+05:30', null, 'Q-R2364-7'),
  -- P8: created from line 10 (BANK-<line 10>), line 10 un-reconciled since — the receipt is free.
  ('e2364000-0000-4000-8000-0000000000f8', 'e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000c1', 5000, 'bank_transfer', 'BANK-e2364000-0000-4000-8000-0000000000ea', 'received', '2026-10-12 11:00+05:30', null, 'Q-R2364-8'),
  -- P9: a ₹3,717 receipt with no customer on it, same day as line 6.
  ('e2364000-0000-4000-8000-0000000000f9', 'e2364000-0000-0000-0000-0000000000a0', null, 3717, 'bank_transfer', 'NOCUST2364', 'received', '2026-10-20 11:00+05:30', null, 'Q-R2364-9');

update public.bank_transactions set matched_to_type = 'payment', matched_to_id = 'e2364000-0000-4000-8000-0000000000f1', matched_at = now(), match_confidence = 'manual'
 where id = 'e2364000-0000-4000-8000-0000000000e1';
update public.bank_transactions set matched_to_type = 'payment', matched_to_id = 'e2364000-0000-4000-8000-0000000000f2', matched_at = now(), match_confidence = 'manual'
 where id = 'e2364000-0000-4000-8000-0000000000e3';
update public.bank_transactions set matched_to_type = 'manual', matched_to_id = null, matched_at = now(), match_confidence = 'manual'
 where id = 'e2364000-0000-4000-8000-0000000000e4';
update public.bank_transactions set matched_to_type = 'split', matched_to_id = null, matched_at = now(), match_confidence = 'manual'
 where id = 'e2364000-0000-4000-8000-0000000000e5';
-- The split line holds P4 (set after the line is matched: trg_bank_split_line_unmatched clears it on a re-match).
update public.payments set bank_txn_id = 'e2364000-0000-4000-8000-0000000000e5' where id = 'e2364000-0000-4000-8000-0000000000f4';

insert into public.expenses (id, tenant_id, category, vendor_name, amount, expense_date, reconciled_txn_id) values
  ('EXP-R2364-1', 'e2364000-0000-0000-0000-0000000000a0', 'Rent', 'R2364 Landlord', 900, '2026-10-15', 'e2364000-0000-4000-8000-0000000000e7'),
  ('EXP-R2364-2', 'e2364000-0000-0000-0000-0000000000a0', 'Rent', 'R2364 Landlord 2', 900, '2026-10-15', null);
update public.bank_transactions set matched_to_type = 'expense', matched_to_id = 'EXP-R2364-1', matched_at = now(), match_confidence = 'manual'
 where id = 'e2364000-0000-4000-8000-0000000000e7';

-- Gibi Paul is a known payer of Bethelsoft; line 9's payer answer names Bethelsoft.
insert into public.customer_payers (tenant_id, customer_id, payer_name, payer_name_key, relation, uses) values
  ('e2364000-0000-0000-0000-0000000000a0', 'e2364000-0000-4000-8000-0000000000c3', 'GIBI PAUL', 'gibi paul', 'director', 2);
update public.bank_transactions
   set payer = jsonb_build_object('name', 'Someone', 'relation', 'third_party', 'customer_id', 'e2364000-0000-4000-8000-0000000000c3')
 where id = 'e2364000-0000-4000-8000-0000000000e9';

create temp table r2364_fail (msg text) on commit drop;
grant all on r2364_fail to authenticated;

do $$
declare
  v_ids text[]; v_first record; v_low text; v_code text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2364000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  -- ════ USED ════════════════════════════════════════════════════════════════════════
  select array_agg(s.match_id) into v_ids from public.suggest_bank_transaction_matches('e2364000-0000-4000-8000-0000000000e2') s;
  v_ids := coalesce(v_ids, '{}');
  if 'e2364000-0000-4000-8000-0000000000f1' = any (v_ids) then
    insert into r2364_fail values ('line 2 is offered P1 — the receipt line 1 already uses (BANK-<line 1>)');
  end if;
  if 'e2364000-0000-4000-8000-0000000000f2' = any (v_ids) then
    insert into r2364_fail values ('line 2 is offered P2 — line 3 is already matched to it');
  end if;
  if 'e2364000-0000-4000-8000-0000000000f3' = any (v_ids) then
    insert into r2364_fail values ('line 2 is offered P3 — it was created from line 4 (BANK-<line 4>)');
  end if;
  if 'e2364000-0000-4000-8000-0000000000f4' = any (v_ids) then
    insert into r2364_fail values ('line 2 is offered P4 — the split line 5 carries it');
  end if;
  if not ('e2364000-0000-4000-8000-0000000000f8' = any (v_ids)) then
    insert into r2364_fail values ('line 2 is NOT offered P8 — its source line 10 is un-reconciled, so it is free');
  end if;
  if not ('e2364000-0000-4000-8000-0000000000f7' = any (v_ids)) then
    insert into r2364_fail values ('line 2 is NOT offered P7 — a free ₹5,000 receipt of the same customer');
  end if;
  if not exists (select 1 from public.suggest_bank_transaction_matches('e2364000-0000-4000-8000-0000000000e1') s
                  where s.match_id = 'e2364000-0000-4000-8000-0000000000f1') then
    insert into r2364_fail values ('line 1 no longer sees its own receipt P1');
  end if;

  select array_agg(s.match_id) into v_ids from public.suggest_bank_transaction_matches('e2364000-0000-4000-8000-0000000000e8') s;
  v_ids := coalesce(v_ids, '{}');
  if 'EXP-R2364-1' = any (v_ids) then
    insert into r2364_fail values ('debit line 8 is offered EXP-R2364-1 — line 7 is already reconciled to it');
  end if;
  if not ('EXP-R2364-2' = any (v_ids)) then
    insert into r2364_fail values ('debit line 8 is NOT offered the free expense EXP-R2364-2');
  end if;

  -- ════ PAYER ═══════════════════════════════════════════════════════════════════════
  select s.match_id, s.match_confidence into v_first
    from public.suggest_bank_transaction_matches('e2364000-0000-4000-8000-0000000000e6') with ordinality s(match_type, match_id, match_label, match_amount, match_date, match_confidence, ord)
   order by s.ord limit 1;
  if v_first.match_id is distinct from 'e2364000-0000-4000-8000-0000000000f6' then
    insert into r2364_fail values ('Gibi Paul line: first suggestion is ' || coalesce(v_first.match_id, 'none') || ' (want Bethelsoft''s P6)');
  end if;
  select s.match_confidence into v_low from public.suggest_bank_transaction_matches('e2364000-0000-4000-8000-0000000000e6') s
   where s.match_id = 'e2364000-0000-4000-8000-0000000000f5';
  if v_low is distinct from 'low' then
    insert into r2364_fail values ('Gibi Paul line: Jene Chemicals'' same-amount receipt is ' || coalesce(v_low, 'not shown') || ' (want low)');
  end if;
  if not exists (select 1 from public.suggest_bank_transaction_matches('e2364000-0000-4000-8000-0000000000e6') s
                  where s.match_id = 'e2364000-0000-4000-8000-0000000000f5' and s.match_label like '%R2364 Jene Chemicals%') then
    insert into r2364_fail values ('Gibi Paul line: the other customer''s receipt does not carry its name');
  end if;

  select s.match_id into v_first
    from public.suggest_bank_transaction_matches('e2364000-0000-4000-8000-0000000000e9') with ordinality s(match_type, match_id, match_label, match_amount, match_date, match_confidence, ord)
   order by s.ord limit 1;
  if v_first.match_id is distinct from 'e2364000-0000-4000-8000-0000000000f6' then
    insert into r2364_fail values ('line 9 (payer answer = Bethelsoft): first suggestion is ' || coalesce(v_first.match_id, 'none') || ' (want P6)');
  end if;

  -- "GIBI PAUL TRADERS" is not the known payer "GIBI PAUL": no guess, Jene's same-day receipt stays exact.
  select s.match_confidence into v_low from public.suggest_bank_transaction_matches('e2364000-0000-4000-8000-0000000000eb') s
   where s.match_id = 'e2364000-0000-4000-8000-0000000000f5';
  if v_low is distinct from 'exact' then
    insert into r2364_fail values ('line 11 (GIBI PAUL TRADERS): Jene''s same-day receipt is ' || coalesce(v_low, 'not shown') || ' (want exact — a longer name is not the known payer)');
  end if;

  -- ════ GUARD ═══════════════════════════════════════════════════════════════════════
  v_code := null;
  begin
    perform public.reconcile_bank_txn('e2364000-0000-4000-8000-0000000000e2', 'payment', 'e2364000-0000-4000-8000-0000000000f1', 'manual');
  exception when unique_violation then v_code := 'refused'; end;
  if v_code is null then
    insert into r2364_fail values ('reconcile_bank_txn linked line 2 to P1 which line 1 already carries');
  end if;
  v_code := null;
  begin
    perform public.reconcile_bank_txn('e2364000-0000-4000-8000-0000000000e2', 'payment', 'e2364000-0000-4000-8000-0000000000f4', 'manual');
  exception when unique_violation then v_code := 'refused'; end;
  if v_code is null then
    insert into r2364_fail values ('reconcile_bank_txn linked line 2 to P4 which the split line 5 carries');
  end if;
  begin
    perform public.reconcile_bank_txn('e2364000-0000-4000-8000-0000000000e1', 'payment', 'e2364000-0000-4000-8000-0000000000f1', 'manual');
  exception when others then
    insert into r2364_fail values ('re-matching line 1 to its own P1 failed: ' || sqlerrm);
  end;
  begin
    perform public.reconcile_bank_txn('e2364000-0000-4000-8000-0000000000e2', 'payment', 'e2364000-0000-4000-8000-0000000000f7', 'manual');
  exception when others then
    insert into r2364_fail values ('matching line 2 to the free P7 failed: ' || sqlerrm);
  end;
  set local role postgres;
  if not exists (select 1 from public.bank_transactions where id = 'e2364000-0000-4000-8000-0000000000e2'
                  and matched_to_type = 'payment' and matched_to_id = 'e2364000-0000-4000-8000-0000000000f7') then
    insert into r2364_fail values ('line 2 is not matched to P7 after the allowed match');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2364_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2364_suggestions_skip_used:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2364_suggestions_skip_used';
end $$;

rollback;
