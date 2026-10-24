\set ON_ERROR_STOP on
-- R-1565 (P1): advance credit applied to a payment is not money received.
-- Migration: 20261018044814_r1565_credit_applied_not_cash (payments.credit_applied +
-- record_desk_payment + day book / customer ledger / bank suggestions / settlement shortfall).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1565_credit_applied_not_cash.test.sql
--
-- Expect "PASS r1565_credit_applied_not_cash". Every check is collected and failures listed together.
--
--   STORE     Quote A ₹6,000 paid ₹10,000 (10 Sep) → ₹4,000 credit. Quote B ₹6,000 paid ₹2,000
--             cash + ₹4,000 credit (5 Oct) → payment amount 6,000, credit_applied 4,000.
--             Quote C ₹3,000 paid wholly by a ₹3,000 credit (6 Oct) → amount 3,000,
--             credit_applied 3,000. A plain payment keeps credit_applied 0.
--   REPLAY    the same B reference again → no new row, credit_applied and open credit unchanged
--   GUARD     credit_applied above amount, or negative, is refused by the table
--   REPORTS   Day Book Receipts = ₹12,000 (10,000 + 2,000; nothing for C); customer ledger
--             Receipts = ₹12,000; a ₹2,000 bank line is an EXACT match for B and C is never
--             suggested; B matched to that ₹2,000 bank line is no settlement shortfall

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1565000-0000-4000-8000-0000000000a2', 'r1565-billing@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1565000-0000-0000-0000-0000000000a0', 'R1565 A', 'r1565a@example.in', '07', 'R156');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1565000-0000-4000-8000-0000000000a2', 'e1565000-0000-0000-0000-0000000000a0', 'r1565-billing@example.in', 'R1565 Billing', 'billing', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1565000-0000-4000-8000-0000000000c1', 'e1565000-0000-0000-0000-0000000000a0', 'R1565 Cust', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e1565000-0000-4000-8000-0000000000ba', 'e1565000-0000-0000-0000-0000000000a0', 'R1565 Current', 'R1565 Bank');
-- One-off quotes (no subscription side effects), not invoiced.
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
select 'Q-R1565-' || k, 'e1565000-0000-0000-0000-0000000000a0', null, 'e1565000-0000-4000-8000-0000000000c1',
       'R1565 Cust', amt, round(amt / 1.18), 18, 'accepted', 'awaiting', '[]'::jsonb
  from (values ('A', 6000), ('B', 6000), ('C', 3000), ('D', 1180)) v(k, amt);

create temp table r1565_fail (msg text) on commit drop;
grant all on r1565_fail to authenticated;
create function pg_temp.r1565_credit() returns integer language sql as $$
  select coalesce(sum(amount), 0)::int from public.customer_credits
   where customer_id = 'e1565000-0000-4000-8000-0000000000c1' and status = 'open' $$;

do $$
declare
  v_r jsonb; v_a uuid; v_b uuid; v_c uuid; v_d uuid; v_n int; v_code text; v_j jsonb; v_sum bigint; v_txn uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e1565000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  -- ════ STORE ═══════════════════════════════════════════════════════════════════════
  v_r := public.record_desk_payment('Q-R1565-A', 10000, 'bank_transfer', 'R1565-A', null, null, 0,
                                    '2026-09-10', 'e1565000-0000-4000-8000-0000000000ba');
  v_a := (v_r->>'payment_id')::uuid;
  if (v_r->>'overpaid_credit')::int is distinct from 4000 then
    insert into r1565_fail values ('A: overpaid_credit ' || coalesce(v_r->>'overpaid_credit', 'null') || ' (want 4000)');
  end if;

  v_r := public.record_desk_payment('Q-R1565-B', 2000, 'bank_transfer', 'R1565-B', null,
                                    'e1565000-0000-4000-8000-0000000000c1', 4000,
                                    '2026-10-05', 'e1565000-0000-4000-8000-0000000000ba');
  v_b := (v_r->>'payment_id')::uuid;
  if (v_r->>'credit_applied')::int is distinct from 4000 then
    insert into r1565_fail values ('B: credit_applied result ' || coalesce(v_r->>'credit_applied', 'null') || ' (want 4000)');
  end if;

  -- A manual ₹3,000 credit pays quote C in full: no money comes in at all.
  set local role postgres;
  insert into public.customer_credits (tenant_id, customer_id, amount, source, status)
  values ('e1565000-0000-0000-0000-0000000000a0', 'e1565000-0000-4000-8000-0000000000c1', 3000, 'manual', 'open');
  set local role authenticated;
  v_r := public.record_desk_payment('Q-R1565-C', 0, 'other', 'R1565-C', null,
                                    'e1565000-0000-4000-8000-0000000000c1', 3000,
                                    '2026-10-06', null);
  v_c := (v_r->>'payment_id')::uuid;

  v_r := public.record_desk_payment('Q-R1565-D', 1180, 'upi', 'R1565-D', null, null, 0, '2026-10-07', null);
  v_d := (v_r->>'payment_id')::uuid;

  set local role postgres;
  if not exists (select 1 from public.payments where id = v_a and amount = 10000 and credit_applied = 0) then
    insert into r1565_fail values ('A: not stored as amount 10000, credit_applied 0');
  end if;
  if not exists (select 1 from public.payments where id = v_b and amount = 6000 and credit_applied = 4000) then
    insert into r1565_fail values ('B: stored as amount ' || coalesce((select amount::text from public.payments where id = v_b), 'none')
      || ', credit_applied ' || coalesce((select credit_applied::text from public.payments where id = v_b), 'none') || ' (want 6000 / 4000)');
  end if;
  if not exists (select 1 from public.payments where id = v_c and amount = 3000 and credit_applied = 3000) then
    insert into r1565_fail values ('C: stored as amount ' || coalesce((select amount::text from public.payments where id = v_c), 'none')
      || ', credit_applied ' || coalesce((select credit_applied::text from public.payments where id = v_c), 'none') || ' (want 3000 / 3000)');
  end if;
  if not exists (select 1 from public.payments where id = v_d and amount = 1180 and credit_applied = 0) then
    insert into r1565_fail values ('D: a plain payment is not credit_applied 0');
  end if;
  select coalesce(sum(amount - credit_applied), 0) into v_sum from public.payments
   where tenant_id = 'e1565000-0000-0000-0000-0000000000a0' and quote_id in ('Q-R1565-A', 'Q-R1565-B', 'Q-R1565-C');
  if v_sum <> 12000 then insert into r1565_fail values ('money received on A+B+C is ' || v_sum || ' (want 12000)'); end if;
  if pg_temp.r1565_credit() <> 0 then insert into r1565_fail values ('open credit after B and C is ' || pg_temp.r1565_credit() || ' (want 0)'); end if;

  -- ════ REPLAY ══════════════════════════════════════════════════════════════════════
  insert into public.customer_credits (tenant_id, customer_id, amount, source, status)
  values ('e1565000-0000-0000-0000-0000000000a0', 'e1565000-0000-4000-8000-0000000000c1', 500, 'manual', 'open');
  set local role authenticated;
  v_r := public.record_desk_payment('Q-R1565-B', 2000, 'bank_transfer', 'R1565-B', null,
                                    'e1565000-0000-4000-8000-0000000000c1', 500,
                                    '2026-10-05', 'e1565000-0000-4000-8000-0000000000ba');
  set local role postgres;
  if (select count(*) from public.payments where quote_id = 'Q-R1565-B') <> 1 then
    insert into r1565_fail values ('replay added a payment row on B');
  end if;
  if (select credit_applied from public.payments where id = v_b) <> 4000 then
    insert into r1565_fail values ('replay changed B credit_applied to ' || (select credit_applied from public.payments where id = v_b));
  end if;
  if pg_temp.r1565_credit() <> 500 then insert into r1565_fail values ('replay consumed credit: open ' || pg_temp.r1565_credit() || ' (want 500)'); end if;

  -- ════ GUARD ═══════════════════════════════════════════════════════════════════════
  v_code := null;
  begin
    update public.payments set credit_applied = 6001 where id = v_b;
  exception when check_violation then v_code := 'refused'; end;
  if v_code is null then insert into r1565_fail values ('credit_applied above amount was accepted'); end if;
  v_code := null;
  begin
    update public.payments set credit_applied = -1 where id = v_d;
  exception when check_violation then v_code := 'refused'; end;
  if v_code is null then insert into r1565_fail values ('negative credit_applied was accepted'); end if;

  -- ════ REPORTS ═════════════════════════════════════════════════════════════════════
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e1565000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  v_j := public.report_day_book('2026-09-01', '2026-10-06');
  select coalesce(sum((e->>'amount')::bigint), 0), count(*) into v_sum, v_n
    from jsonb_array_elements(v_j) e where e->>'voucher' = 'Receipt';
  if v_sum <> 12000 or v_n <> 2 then
    insert into r1565_fail values ('Day Book Receipts ' || v_sum || ' in ' || v_n || ' rows (want 12000 in 2)');
  end if;

  v_j := public.report_party_ledger('customer', 'e1565000-0000-4000-8000-0000000000c1', '2026-09-01', '2026-10-06');
  select coalesce(sum((e->>'amount')::bigint), 0) into v_sum
    from jsonb_array_elements(v_j->'entries') e where e->>'voucher' = 'Receipt';
  if v_sum <> 12000 then insert into r1565_fail values ('customer ledger Receipts ' || v_sum || ' (want 12000)'); end if;

  set local role postgres;
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, credit)
  values ('e1565000-0000-4000-8000-0000000000e1', 'e1565000-0000-0000-0000-0000000000a0',
          'e1565000-0000-4000-8000-0000000000ba', '2026-10-05', 'NEFT R1565 CUST', 2000),
         ('e1565000-0000-4000-8000-0000000000e3', 'e1565000-0000-0000-0000-0000000000a0',
          'e1565000-0000-4000-8000-0000000000ba', '2026-10-06', 'NEFT R1565 3000', 3000);
  set local role authenticated;
  if not exists (select 1 from public.suggest_bank_transaction_matches('e1565000-0000-4000-8000-0000000000e1') s
                  where s.match_id = v_b::text and s.match_amount = 2000 and s.match_confidence = 'exact') then
    insert into r1565_fail values ('a ₹2,000 bank line on 5 Oct is not an exact match for B''s ₹2,000 cash');
  end if;
  if exists (select 1 from public.suggest_bank_transaction_matches('e1565000-0000-4000-8000-0000000000e3') s
              where s.match_id = v_c::text) then
    insert into r1565_fail values ('C (paid wholly by credit) was suggested for a bank line');
  end if;

  set local role postgres;
  update public.bank_transactions set matched_to_type = 'payment', matched_to_id = v_b::text
   where id = 'e1565000-0000-4000-8000-0000000000e1';
  set local role authenticated;
  if exists (select 1 from public.report_settlement_shortfalls('2026-10-01', '2026-10-31') s where s.payment_id = v_b) then
    insert into r1565_fail values ('B matched to its ₹2,000 bank line shows a settlement shortfall (the credit is not bank money)');
  end if;
  set local role postgres;
end $$;

do $$
declare v_list text;
begin
  select string_agg('  - ' || msg, E'\n') into v_list from r1565_fail;
  if v_list is not null then
    raise exception E'FAIL r1565_credit_applied_not_cash:\n%', v_list;
  end if;
  raise notice 'PASS r1565_credit_applied_not_cash';
end $$;

rollback;
