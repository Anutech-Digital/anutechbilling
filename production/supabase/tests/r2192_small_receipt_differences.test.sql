\set ON_ERROR_STOP on
-- R-2192 (G-ZOHO / G-RECON): small receipt differences.
-- Migration: 20261107205640_r2192_small_receipt_differences.sql
-- Self-asserting, ONE transaction, rolled back — run on the LOCAL DB only:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2192_small_receipt_differences.test.sql
--
-- Expect "PASS r2192_small_receipt_differences". Every check is collected and failures listed together.
--
--   ONE-SHORT  ₹13,105 line, ₹13,106 receipt the same day → auto-reconcile books it; the ₹1 is the
--              P&L's settlement shortfall (report_settlement_shortfalls ₹1) — counted once, no row.
--   TWO-SHORT  ₹19,998 line, ₹20,000 receipt → 'low', auto-reconcile leaves it.
--   ONE-OVER   ₹5,001 line, ₹5,000 receipt → booked; bank_receipt_round_offs −1 (gain) on the line.
--   EXACT-WINS ₹7,000 line, a ₹7,000 receipt 2 days off + a ₹7,001 receipt same day → the exact one
--              is booked (the ₹1-off one stays 'low'; nothing that auto-matched before turns ambiguous).
--   CHARGE     a ₹50,000 invoice paid by a wire of ₹49,500 → split rest 'bank_charge' → invoice paid,
--              (R-2577: the line is an inward remittance — USD600.0@82.5 — so an Indian customer may have one)
--              ONE Bank Charges expense EXP-FXC-<line> ₹500 on the line; un-reconcile removes it.
--   LIMITS     bank_charge over 10% → refused; an over-payment with bank_charge → refused; nothing written.

begin;
select set_config('request.jwt.claims', '', true);

create temp table r2192_fail (msg text) on commit drop;
grant all on r2192_fail to authenticated;

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

insert into auth.users (id, email) values ('e2192000-0000-4000-8000-0000000000a2', 'r2192-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2192000-0000-0000-0000-0000000000a0', 'R2192 Co', 'r2192@example.in', '07', 'R219');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('e2192000-0000-4000-8000-0000000000a2', 'e2192000-0000-0000-0000-0000000000a0', 'r2192-owner@example.in', 'R2192 Owner', 'owner', true, now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('e2192000-0000-4000-8000-0000000000c1', 'e2192000-0000-0000-0000-0000000000a0', 'R2192 Aks Traders', '07', 'India', 'aks2192.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e2192000-0000-4000-8000-0000000000ba', 'e2192000-0000-0000-0000-0000000000a0', 'R2192 Current', 'R2192 Bank'),
  ('e2192000-0000-4000-8000-0000000000bb', 'e2192000-0000-0000-0000-0000000000a0', 'R2192 Wire', 'R2192 Bank');

-- Receipts (one quote each — the suggester reads payments).
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
select 'Q-R2192-' || k, 'e2192000-0000-0000-0000-0000000000a0', null, 'e2192000-0000-4000-8000-0000000000c1', 'R2192 Aks Traders',
       amt, round(amt / 1.18), 18, 'accepted', 'awaiting', '[]'::jsonb
  from (values ('1', 13106), ('2', 20000), ('3', 5000), ('4', 7000), ('5', 7001)) v(k, amt);
insert into public.payments (id, tenant_id, customer_id, amount, method, reference, status, received_at, quote_id) values
  ('e2192000-0000-4000-8000-0000000000f1', 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000c1', 13106, 'cheque', 'R2192 P1', 'received', '2026-10-10 10:00+05:30', 'Q-R2192-1'),
  ('e2192000-0000-4000-8000-0000000000f2', 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000c1', 20000, 'cheque', 'R2192 P2', 'received', '2026-10-11 10:00+05:30', 'Q-R2192-2'),
  ('e2192000-0000-4000-8000-0000000000f3', 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000c1', 5000, 'cheque', 'R2192 P3', 'received', '2026-10-12 10:00+05:30', 'Q-R2192-3'),
  ('e2192000-0000-4000-8000-0000000000f4', 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000c1', 7000, 'cheque', 'R2192 P4', 'received', '2026-10-11 10:00+05:30', 'Q-R2192-4'),
  ('e2192000-0000-4000-8000-0000000000f5', 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000c1', 7001, 'cheque', 'R2192 P5', 'received', '2026-10-13 10:00+05:30', 'Q-R2192-5');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit, source) values
  ('e2192000-0000-4000-8000-0000000000e1', 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000ba', '2026-10-10', 'CHQ DEP R2192 ONE SHORT', null, 13105, 0, 'manual'),
  ('e2192000-0000-4000-8000-0000000000e2', 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000ba', '2026-10-11', 'CHQ DEP R2192 TWO SHORT', null, 19998, 0, 'manual'),
  ('e2192000-0000-4000-8000-0000000000e3', 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000ba', '2026-10-12', 'CHQ DEP R2192 ONE OVER', null, 5001, 0, 'manual'),
  ('e2192000-0000-4000-8000-0000000000e4', 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000ba', '2026-10-13', 'CHQ DEP R2192 EXACT WINS', null, 7000, 0, 'manual');

-- ════ ₹1 tolerance: suggester + auto-reconcile ══════════════════════════════════════════════
do $$
declare v_conf text; v_res jsonb; v_short bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2192000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  select s.match_confidence into v_conf from public.suggest_bank_transaction_matches('e2192000-0000-4000-8000-0000000000e1') s
   where s.match_id = 'e2192000-0000-4000-8000-0000000000f1';
  if v_conf is distinct from 'high' then
    insert into r2192_fail values ('ONE-SHORT: ₹13,106 receipt for a ₹13,105 line is ' || coalesce(v_conf, 'not shown') || ' (want high)');
  end if;
  select s.match_confidence into v_conf from public.suggest_bank_transaction_matches('e2192000-0000-4000-8000-0000000000e2') s
   where s.match_id = 'e2192000-0000-4000-8000-0000000000f2';
  if v_conf is distinct from 'low' then
    insert into r2192_fail values ('TWO-SHORT: ₹20,000 receipt for a ₹19,998 line is ' || coalesce(v_conf, 'not shown') || ' (want low)');
  end if;
  select s.match_confidence into v_conf from public.suggest_bank_transaction_matches('e2192000-0000-4000-8000-0000000000e4') s
   where s.match_id = 'e2192000-0000-4000-8000-0000000000f5';
  if v_conf is distinct from 'low' then
    insert into r2192_fail values ('EXACT-WINS: the ₹7,001 receipt is ' || coalesce(v_conf, 'not shown') || ' while a ₹7,000 one exists (want low)');
  end if;

  v_res := public.auto_reconcile_bank_account('e2192000-0000-4000-8000-0000000000ba');
  if (v_res->>'reconciled')::int <> 3 or (v_res->>'failed')::int <> 0 then
    insert into r2192_fail values ('auto-reconcile result ' || v_res::text || ' (want 3 reconciled, 0 failed)');
  end if;

  select coalesce(sum(r.amount), 0) into v_short from public.report_settlement_shortfalls('2026-10-01', '2026-10-31') r
   where r.payment_id = 'e2192000-0000-4000-8000-0000000000f1';
  if v_short <> 1 then
    insert into r2192_fail values ('ONE-SHORT: settlement shortfall for P1 is ₹' || v_short || ' (want ₹1)');
  end if;
  select coalesce(sum(r.amount), 0) into v_short from public.report_settlement_shortfalls('2026-10-01', '2026-10-31') r;
  if v_short <> 0 then   -- +1 (P1 short) −1 (the ₹5,001 gain)
    insert into r2192_fail values ('P&L Bank Charges · settlement total is ₹' || v_short || ' (want ₹0: ₹1 short + ₹1 gain)');
  end if;
  set local role postgres;

  if not exists (select 1 from public.bank_transactions where id = 'e2192000-0000-4000-8000-0000000000e1'
                  and matched_to_type = 'payment' and matched_to_id = 'e2192000-0000-4000-8000-0000000000f1') then
    insert into r2192_fail values ('ONE-SHORT: the ₹13,105 line was not auto-reconciled to the ₹13,106 receipt');
  end if;
  if exists (select 1 from public.bank_receipt_round_offs where bank_txn_id = 'e2192000-0000-4000-8000-0000000000e1') then
    insert into r2192_fail values ('ONE-SHORT: a round-off row was written too — the ₹1 would count twice');
  end if;
  if exists (select 1 from public.bank_transactions where id = 'e2192000-0000-4000-8000-0000000000e2' and matched_to_type is not null) then
    insert into r2192_fail values ('TWO-SHORT: a ₹2 gap was auto-reconciled');
  end if;
  if not exists (select 1 from public.bank_transactions where id = 'e2192000-0000-4000-8000-0000000000e3'
                  and matched_to_id = 'e2192000-0000-4000-8000-0000000000f3') then
    insert into r2192_fail values ('ONE-OVER: the ₹5,001 line was not auto-reconciled to the ₹5,000 receipt');
  end if;
  if (select sum(amount) from public.bank_receipt_round_offs where bank_txn_id = 'e2192000-0000-4000-8000-0000000000e3') is distinct from -1 then
    insert into r2192_fail values ('ONE-OVER: no −1 round-off row on the ₹5,001 line');
  end if;
  if not exists (select 1 from public.bank_transactions where id = 'e2192000-0000-4000-8000-0000000000e4'
                  and matched_to_id = 'e2192000-0000-4000-8000-0000000000f4') then
    insert into r2192_fail values ('EXACT-WINS: the ₹7,000 line was not booked to the ₹7,000 receipt');
  end if;
  -- Idempotent: a second call writes nothing more.
  perform public.bank_line_receipt_round_off('e2192000-0000-4000-8000-0000000000e3');
  if (select count(*) from public.bank_receipt_round_offs where bank_txn_id = 'e2192000-0000-4000-8000-0000000000e3') <> 1 then
    insert into r2192_fail values ('ONE-OVER: a second call wrote a second round-off');
  end if;
  -- Un-reconciled → the round-off goes (R-2098 trigger).
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = 'e2192000-0000-4000-8000-0000000000e3';
  if exists (select 1 from public.bank_receipt_round_offs where bank_txn_id = 'e2192000-0000-4000-8000-0000000000e3') then
    insert into r2192_fail values ('ONE-OVER: un-reconciling left the round-off behind');
  end if;
end $$;

-- ════ Bank / SWIFT charge on a wire ════════════════════════════════════════════════════════
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
select v.id, 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000c1', 'R2192 Aks Traders',
       round(v.sub * 1.18)::int, v.sub, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Service ' || v.id, 'qty', 1, 'rate', v.sub, 'one_time', true)),
       true, '2026-10-10'
  from (values ('Q-R2192-W', 42373), ('Q-R2192-X', 10000)) as v(id, sub);
select set_config('request.jwt.claims', '{"sub":"e2192000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
select public.generate_invoice(q) from unnest(array['Q-R2192-W', 'Q-R2192-X']) q;

create function pg_temp.inv(p_quote text) returns text language sql as $f$ select invoice_id from public.quotes where id = p_quote $f$;
create function pg_temp.due(p_quote text) returns int language sql as $f$
  select o.amount_due::int from public.bank_credit_open_items('e2192000-0000-4000-8000-0000000000c1') o where o.invoice_id = pg_temp.inv(p_quote) $f$;

-- W: the wire ₹500 short. X: a line far too short (₹2,000 of ~₹11,800) and one paying ₹10 extra.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit, source)
select v.id::uuid, 'e2192000-0000-0000-0000-0000000000a0', 'e2192000-0000-4000-8000-0000000000bb', '2026-10-20', v.d, v.r, v.amt, 0, 'manual'
  from (values ('e2192000-0000-4000-8000-0000000000d1', 'INWARD SWIFT R2192 AKS USD600.0@82.5', 'SWIFTR2192A', pg_temp.due('Q-R2192-W') - 500),
               ('e2192000-0000-4000-8000-0000000000d2', 'INWARD SWIFT R2192 BIG GAP', 'SWIFTR2192B', pg_temp.due('Q-R2192-X') - 2000),
               ('e2192000-0000-4000-8000-0000000000d3', 'INWARD SWIFT R2192 OVER', 'SWIFTR2192C', pg_temp.due('Q-R2192-X') + 10)) v(id, d, r, amt);

do $$
declare r jsonb; v_e record; v_ok boolean;
begin
  -- LIMITS first (nothing may be written).
  v_ok := false;
  begin
    perform public.reconcile_bank_credit_split('e2192000-0000-4000-8000-0000000000d2', 'e2192000-0000-4000-8000-0000000000c1',
      jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2192-X'), 'amount', pg_temp.due('Q-R2192-X'))), null, 'bank_charge');
  exception when check_violation then v_ok := sqlerrm like '%more than a bank charge%';
  end;
  if not v_ok then insert into r2192_fail values ('LIMITS: a ₹2,000 gap on ~₹11,800 was accepted as a bank charge'); end if;
  v_ok := false;
  begin
    perform public.reconcile_bank_credit_split('e2192000-0000-4000-8000-0000000000d3', 'e2192000-0000-4000-8000-0000000000c1',
      jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2192-X'), 'amount', pg_temp.due('Q-R2192-X'))), null, 'bank_charge');
  exception when check_violation then v_ok := sqlerrm like '%more came in%';
  end;
  if not v_ok then insert into r2192_fail values ('LIMITS: an over-payment was accepted with bank_charge'); end if;
  if exists (select 1 from public.expenses where tenant_id = 'e2192000-0000-0000-0000-0000000000a0')
     or exists (select 1 from public.payments where bank_txn_id in ('e2192000-0000-4000-8000-0000000000d2', 'e2192000-0000-4000-8000-0000000000d3')) then
    insert into r2192_fail values ('LIMITS: a refused call wrote something');
  end if;

  -- CHARGE.
  r := public.reconcile_bank_credit_split('e2192000-0000-4000-8000-0000000000d1', 'e2192000-0000-4000-8000-0000000000c1',
         jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2192-W'), 'amount', pg_temp.due('Q-R2192-W'))), null, 'bank_charge');
  if (r->>'bank_charge')::int is distinct from 500 or (r->>'round_off')::int <> 0 then
    insert into r2192_fail values ('CHARGE: result ' || r::text || ' (want bank_charge 500, round_off 0)');
  end if;
  if (select status from public.invoices where id = pg_temp.inv('Q-R2192-W')) is distinct from 'paid' then
    insert into r2192_fail values ('CHARGE: the invoice is not Paid after the wire + ₹500 bank charge');
  end if;
  select * into v_e from public.expenses where id = 'EXP-FXC-e2192000-0000-4000-8000-0000000000d1';
  if not found or v_e.category <> 'Bank Charges' or v_e.amount <> 500 or not v_e.paid
     or v_e.reconciled_txn_id is distinct from 'e2192000-0000-4000-8000-0000000000d1'::uuid
     or v_e.bank_account_id is distinct from 'e2192000-0000-4000-8000-0000000000bb'::uuid then
    insert into r2192_fail values ('CHARGE: no ₹500 Bank Charges expense on the wire line');
  end if;
  -- R-2599 (money-rules S5): the bank's charge is booked without input GST — no ITC on it.
  if v_e.bill_type is distinct from 'none' or coalesce(v_e.gst_paid, -1) <> 0 then
    insert into r2192_fail values ('CHARGE: the bank charge carries input GST (bill_type ' || coalesce(v_e.bill_type, 'null') || ', gst_paid ' || coalesce(v_e.gst_paid::text, 'null') || ') - want none / 0');
  end if;
  if (select count(*) from public.expenses where tenant_id = 'e2192000-0000-0000-0000-0000000000a0') <> 1 then
    insert into r2192_fail values ('CHARGE: more than one expense booked');
  end if;
  if exists (select 1 from public.bank_receipt_round_offs where bank_txn_id = 'e2192000-0000-4000-8000-0000000000d1') then
    insert into r2192_fail values ('CHARGE: a round-off row as well — the charge would count twice');
  end if;

  -- Un-reconciled → the charge goes (R-2427's trigger).
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = 'e2192000-0000-4000-8000-0000000000d1';
  if exists (select 1 from public.expenses where id = 'EXP-FXC-e2192000-0000-4000-8000-0000000000d1') then
    insert into r2192_fail values ('CHARGE: un-reconciling the wire left the bank charge behind');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2192_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2192_small_receipt_differences:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2192_small_receipt_differences';
end $$;

rollback;
