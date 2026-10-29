-- R-2098 (29 Oct 2026): ONE bank credit pays SEVERAL of a customer's quotes / invoices (+ an
-- optional new sale); money left over → the customer's advance; a small difference (≤ ₹50) →
-- round-off. Migration 20261029054707_r2098_bank_credit_split.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. 3 invoices, exact (₹11,800): each invoice paid in full on the BANK date, one receipt each
--      (bank account, bank date, one shared UTR), the line reconciled to the first receipt, every
--      receipt carries bank_txn_id; undeposited funds do not move; no settlement difference.
--   B. 8 invoices + ₹346 left over: 8 invoices paid, ₹346 is an OPEN customer credit (advance
--      receipt on the line too); advances on the balance sheet rise by exactly 346.
--   C. ₹48 short on 2 invoices with "round-off": both invoices fully paid, ₹48 in
--      report_settlement_shortfalls (P&L Bank Charges); a ₹2 excess written off is −2.
--   D. An open quote (part) + a new sale on one line: the quote's receipt, the new sale's quote +
--      invoice, both banked.
--   E. Refused, nothing written: over-allocation (beyond ₹50, or ≤ ₹50 without round-off), an
--      amount over an item's due, money left over with no choice, an item of another customer,
--      an item listed twice, a second click on the same line, a sales login (42501), a
--      no-company login (28000).
--   F. Un-reconcile a split line: the line is free, its receipts lose bank_txn_id (undeposited
--      again), its round-off row is gone.

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
  ('dddddddd-0000-0000-0000-000000209801','R2098 Co','r2098@example.in','07','R2098'),
  ('dddddddd-0000-0000-0000-000000209802','R2098 Other','r2098b@example.in','07','R2098B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000209801','owner2098@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000209802','sales2098@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000209803','nocompany2098@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000209801','dddddddd-0000-0000-0000-000000209801','owner2098@example.in','Owner 2098','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000209802','dddddddd-0000-0000-0000-000000209801','sales2098@example.in','Sales 2098','sales', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000209801','dddddddd-0000-0000-0000-000000209801','Acme 2098','07','acme2098.in'),
  ('cccccccc-0000-0000-0000-000000209802','dddddddd-0000-0000-0000-000000209801','Other 2098','07','other2098.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000209801','dddddddd-0000-0000-0000-000000209801','HDFC Current','HDFC');

-- One-off quotes, invoiced before the money comes: A1..A3 (5,900 / 3,540 / 2,360), B1..B8
-- (1,180 each), C1..C2 (5,900 each), X (11,800 for the refusals), O (another customer).
-- Q-D1 stays a quote (1,180, not invoiced) for D.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
select v.id, 'dddddddd-0000-0000-0000-000000209801', coalesce(v.cust, 'cccccccc-0000-0000-0000-000000209801')::uuid,
       case when v.cust is null then 'Acme 2098' else 'Other 2098' end,
       round(v.sub * 1.18)::int, v.sub, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Service ' || v.id, 'qty', 1, 'rate', v.sub, 'one_time', true)),
       true, '2026-10-10'
  from (values ('Q-A1', 5000, null), ('Q-A2', 3000, null), ('Q-A3', 2000, null),
               ('Q-B1', 1000, null), ('Q-B2', 1000, null), ('Q-B3', 1000, null), ('Q-B4', 1000, null),
               ('Q-B5', 1000, null), ('Q-B6', 1000, null), ('Q-B7', 1000, null), ('Q-B8', 1000, null),
               ('Q-C1', 5000, null), ('Q-C2', 5000, null), ('Q-C3', 5000, null), ('Q-X1', 10000, null),
               ('Q-D1', 1000, null), ('Q-O1', 1000, 'cccccccc-0000-0000-0000-000000209802')) as v(id, sub, cust);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000209801','dddddddd-0000-0000-0000-000000209801','bbbbbbbb-0000-0000-0000-000000209801','2026-10-20','NEFT ACME 2098 THREE',0,11800,'UTR2098A','manual'),
  ('11111111-0000-0000-0000-000000209802','dddddddd-0000-0000-0000-000000209801','bbbbbbbb-0000-0000-0000-000000209801','2026-10-21','NEFT ACME 2098 EIGHT',0,9786,'UTR2098B','manual'),
  ('11111111-0000-0000-0000-000000209803','dddddddd-0000-0000-0000-000000209801','bbbbbbbb-0000-0000-0000-000000209801','2026-10-22','NEFT ACME 2098 SHORT',0,11752,'UTR2098C','manual'),
  ('11111111-0000-0000-0000-000000209804','dddddddd-0000-0000-0000-000000209801','bbbbbbbb-0000-0000-0000-000000209801','2026-10-22','NEFT ACME 2098 EXTRA2',0,5902,'UTR2098C2','manual'),
  ('11111111-0000-0000-0000-000000209805','dddddddd-0000-0000-0000-000000209801','bbbbbbbb-0000-0000-0000-000000209801','2026-10-23','NEFT ACME 2098 SALE',0,6490,'UTR2098D','manual'),
  ('11111111-0000-0000-0000-000000209806','dddddddd-0000-0000-0000-000000209801','bbbbbbbb-0000-0000-0000-000000209801','2026-10-23','NEFT ACME 2098 X',0,11000,'UTR2098X','manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209801","role":"authenticated"}', true);
select public.generate_invoice(q) from unnest(array['Q-A1','Q-A2','Q-A3','Q-B1','Q-B2','Q-B3','Q-B4','Q-B5','Q-B6','Q-B7','Q-B8',
                                                    'Q-C1','Q-C2','Q-C3','Q-X1','Q-O1']) q;

create function pg_temp.inv(p_quote text) returns text language sql as $f$ select invoice_id from public.quotes where id = p_quote $f$;
create function pg_temp.items(p_quotes text[], p_amounts int[] default null) returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('invoice_id', pg_temp.inv(q), 'amount',
           coalesce(p_amounts[i], (select coalesce(net_payable, amount) from public.invoices where id = pg_temp.inv(q)))) order by i)
    from unnest(p_quotes) with ordinality as t(q, i) $f$;
create function pg_temp.undeposited() returns bigint language sql as $f$ select undeposited_funds from public.report_balance_sheet('2026-10-31') $f$;
create function pg_temp.advances() returns bigint language sql as $f$ select advances_from_customers from public.report_balance_sheet('2026-10-31') $f$;
create temp table r2098_bs (k text primary key, v bigint);
grant all on r2098_bs to authenticated;

-- ── A. three invoices, exact ────────────────────────────────────────────────────────────────
insert into r2098_bs values ('undep0', pg_temp.undeposited());
do $$
declare r jsonb; n int; v_first uuid; t record;
begin
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209801', 'cccccccc-0000-0000-0000-000000209801',
         pg_temp.items(array['Q-A1','Q-A2','Q-A3']), null, null);
  if r->>'kind' <> 'split' or jsonb_array_length(r->'parts') <> 3 or (r->>'allocated')::int <> 11800 or (r->>'round_off')::int <> 0 then
    raise exception 'FAIL A: result %', r; end if;
  select count(*) into n from public.invoices
   where id in (pg_temp.inv('Q-A1'), pg_temp.inv('Q-A2'), pg_temp.inv('Q-A3'))
     and status = 'paid' and paid_date = '2026-10-20' and paid_amount = coalesce(net_payable, amount);
  if n <> 3 then raise exception 'FAIL A: % of 3 invoices paid in full on the bank date', n; end if;
  select count(*) into n from public.payments
   where bank_txn_id = '11111111-0000-0000-0000-000000209801' and status = 'received' and reference = 'UTR2098A'
     and bank_account_id = 'bbbbbbbb-0000-0000-0000-000000209801' and received_at::date = '2026-10-20'
     and credit_applied = 0;
  if n <> 3 then raise exception 'FAIL A: % of 3 receipts banked on the line', n; end if;
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000209801';
  if t.matched_to_type <> 'payment' or t.matched_to_id <> (r->>'payment_id') then
    raise exception 'FAIL A: line matched % %', t.matched_to_type, t.matched_to_id; end if;
  if exists (select 1 from public.report_settlement_shortfalls('2026-10-01', '2026-10-31') s where s.txn_date = '2026-10-20') then
    raise exception 'FAIL A: a settlement difference on an exact line'; end if;
  raise notice 'PASS A: 3 invoices paid on 20 Oct, 3 banked receipts on one UTR, line reconciled';
end $$;
do $$
begin
  if pg_temp.undeposited() <> (select v from r2098_bs where k = 'undep0') then
    raise exception 'FAIL A: undeposited funds moved % → %', (select v from r2098_bs where k = 'undep0'), pg_temp.undeposited(); end if;
  raise notice 'PASS A: undeposited funds unchanged (every receipt is in the bank)';
end $$;

-- ── B. eight invoices + ₹346 left over → advance ─────────────────────────────────────────────
insert into r2098_bs values ('adv0', pg_temp.advances());
do $$
declare r jsonb; n int; c record;
begin
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209802', 'cccccccc-0000-0000-0000-000000209801',
         pg_temp.items(array['Q-B1','Q-B2','Q-B3','Q-B4','Q-B5','Q-B6','Q-B7','Q-B8']), null, 'advance');
  if (r->>'advance_credit')::int <> 346 or jsonb_array_length(r->'parts') <> 8 then raise exception 'FAIL B: result %', r; end if;
  select count(*) into n from public.invoices where id in (select pg_temp.inv('Q-B' || g) from generate_series(1, 8) g) and status = 'paid';
  if n <> 8 then raise exception 'FAIL B: % of 8 invoices paid', n; end if;
  select cc.* into c from public.customer_credits cc
    join public.payments p on p.id = cc.source_payment_id
   where p.bank_txn_id = '11111111-0000-0000-0000-000000209802' and cc.status = 'open';
  if c.amount is distinct from 346 or c.customer_id <> 'cccccccc-0000-0000-0000-000000209801' then
    raise exception 'FAIL B: advance credit % for %', c.amount, c.customer_id; end if;
  select count(*) into n from public.payments where bank_txn_id = '11111111-0000-0000-0000-000000209802';
  if n <> 9 then raise exception 'FAIL B: % receipts on the line (want 8 + advance)', n; end if;
  if (select sum(amount) from public.payments where bank_txn_id = '11111111-0000-0000-0000-000000209802') <> 9786 then
    raise exception 'FAIL B: receipts do not add up to the line'; end if;
  raise notice 'PASS B: 8 invoices paid, ₹346 open advance credit, 9 receipts = ₹9,786';
end $$;
do $$
begin
  if pg_temp.advances() - (select v from r2098_bs where k = 'adv0') <> 346 then
    raise exception 'FAIL B: advances moved by % (want 346)', pg_temp.advances() - (select v from r2098_bs where k = 'adv0'); end if;
  if pg_temp.undeposited() <> (select v from r2098_bs where k = 'undep0') then raise exception 'FAIL B: undeposited funds moved'; end if;
  raise notice 'PASS B: balance sheet advances +346, undeposited unchanged';
end $$;

-- ── C. ₹48 short → round-off; ₹2 extra → round-off gain ─────────────────────────────────────
do $$
declare r jsonb; n int; s bigint;
begin
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209803', 'cccccccc-0000-0000-0000-000000209801',
         pg_temp.items(array['Q-C1','Q-C2']), null, 'round_off');
  if (r->>'round_off')::int <> 48 then raise exception 'FAIL C: result %', r; end if;
  select count(*) into n from public.invoices where id in (pg_temp.inv('Q-C1'), pg_temp.inv('Q-C2')) and status = 'paid';
  if n <> 2 then raise exception 'FAIL C: % of 2 invoices paid', n; end if;
  select sum(amount) into s from public.report_settlement_shortfalls('2026-10-22', '2026-10-22');
  if s is distinct from 48::bigint then raise exception 'FAIL C: settlement difference % (want 48)', s; end if;

  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209804', 'cccccccc-0000-0000-0000-000000209801',
         pg_temp.items(array['Q-C3']), null, 'round_off');
  if (r->>'round_off')::int <> -2 then raise exception 'FAIL C: excess result %', r; end if;
  select sum(amount) into s from public.report_settlement_shortfalls('2026-10-22', '2026-10-22');
  if s is distinct from 46::bigint then raise exception 'FAIL C: settlement difference % (want 48 − 2)', s; end if;
  if exists (select 1 from public.customer_credits cc join public.payments p on p.id = cc.source_payment_id
              where p.bank_txn_id = '11111111-0000-0000-0000-000000209804') then
    raise exception 'FAIL C: the written-off ₹2 became customer credit'; end if;
  raise notice 'PASS C: ₹48 short written off (Bank Charges 48), ₹2 extra written off (−2), invoices paid';
end $$;
do $$
begin
  if pg_temp.undeposited() <> (select v from r2098_bs where k = 'undep0') then raise exception 'FAIL C: undeposited funds moved'; end if;
  raise notice 'PASS C: undeposited unchanged';
end $$;

-- ── D. a quote (part) + a new sale on one line ──────────────────────────────────────────────
do $$
declare r jsonb; v_q text; n int;
begin
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209805', 'cccccccc-0000-0000-0000-000000209801',
         '[{"quote_id":"Q-D1","amount":590}]'::jsonb,
         '{"lines":[{"name":"Setup","qty":1,"rate":5000,"commitment":"one_time"}],"amount":5900}'::jsonb, null);
  if jsonb_array_length(r->'parts') <> 2 then raise exception 'FAIL D: result %', r; end if;
  v_q := r->'parts'->1->>'quote_id';
  if (select amount from public.quotes where id = v_q) <> 5900 or (r->'parts'->1->>'invoice_issued') is null then
    raise exception 'FAIL D: new sale % not invoiced: %', v_q, r->'parts'->1; end if;
  if (select public.quote_open_balance('Q-D1')) <> 590 then raise exception 'FAIL D: Q-D1 open % (want 590)', public.quote_open_balance('Q-D1'); end if;
  select count(*) into n from public.payments where bank_txn_id = '11111111-0000-0000-0000-000000209805';
  if n <> 2 then raise exception 'FAIL D: % receipts on the line', n; end if;
  raise notice 'PASS D: part of Q-D1 + new sale % (invoiced) on one line', v_q;
end $$;

-- ── E. refusals — nothing written ───────────────────────────────────────────────────────────
do $$
declare v_pay int; v_inv text := pg_temp.inv('Q-X1');
  procedure_check text;
begin
  select count(*) into v_pay from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000209801';
  -- over-allocation beyond ₹50 (11,800 on an 11,000 line), even with round-off
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209806', 'cccccccc-0000-0000-0000-000000209801',
              pg_temp.items(array['Q-X1']), null, 'round_off');
    raise exception 'FAIL E: over-allocation accepted';
  exception when check_violation then
    if sqlerrm not like '%add up to ₹11800 but only ₹11000%' then raise exception 'FAIL E: wrong message %', sqlerrm; end if;
  end;
  -- ₹40 short without the round-off choice
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209806', 'cccccccc-0000-0000-0000-000000209801',
              pg_temp.items(array['Q-X1'], array[11040]), null, null);
    raise exception 'FAIL E: short without round-off accepted';
  exception when check_violation then null;
  end;
  -- more than the item's due
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209806', 'cccccccc-0000-0000-0000-000000209801',
              jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 11801)), null, 'round_off');
    raise exception 'FAIL E: amount over due accepted';
  exception when check_violation then
    if sqlerrm not like '%more than its ₹11800 due%' then raise exception 'FAIL E: wrong message %', sqlerrm; end if;
  end;
  -- money left over, no choice
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209806', 'cccccccc-0000-0000-0000-000000209801',
              pg_temp.items(array['Q-X1'], array[5000]), null, null);
    raise exception 'FAIL E: leftover without a choice accepted';
  exception when check_violation then null;
  end;
  -- ₹6,000 left over can't be a round-off
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209806', 'cccccccc-0000-0000-0000-000000209801',
              pg_temp.items(array['Q-X1'], array[5000]), null, 'round_off');
    raise exception 'FAIL E: big round-off accepted';
  exception when check_violation then null;
  end;
  -- another customer's invoice
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209806', 'cccccccc-0000-0000-0000-000000209801',
              pg_temp.items(array['Q-O1']), null, 'advance');
    raise exception 'FAIL E: other customer''s invoice accepted';
  exception when check_violation then null;
  end;
  -- listed twice
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209806', 'cccccccc-0000-0000-0000-000000209801',
              pg_temp.items(array['Q-X1','Q-X1'], array[5000, 5000]), null, 'advance');
    raise exception 'FAIL E: duplicate accepted';
  exception when invalid_parameter_value then null;
  end;
  -- second click on line A
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209801', 'cccccccc-0000-0000-0000-000000209801',
              pg_temp.items(array['Q-X1'], array[11800]), null, null);
    raise exception 'FAIL E: second click accepted';
  exception when check_violation then
    if sqlerrm not like '%already reconciled%' then raise exception 'FAIL E: wrong message %', sqlerrm; end if;
  end;
  if (select count(*) from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000209801') <> v_pay
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000209806') is not null then
    raise exception 'FAIL E: something was written'; end if;
  raise notice 'PASS E(owner): over-allocation, short without round-off, over due, unexplained leftover, big round-off, other customer, duplicate, second click — all refused, nothing written';
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209802","role":"authenticated"}', true);
do $$
begin
  perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209806', 'cccccccc-0000-0000-0000-000000209801',
            '[]'::jsonb, null, 'advance');
  raise exception 'FAIL E(sales): accepted';
exception when insufficient_privilege then
  raise notice 'PASS E(sales): refused with 42501';
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209803","role":"authenticated"}', true);
do $$
begin
  perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209806', 'cccccccc-0000-0000-0000-000000209801',
            '[]'::jsonb, null, 'advance');
  raise exception 'FAIL E(no company): accepted';
exception when sqlstate '28000' then
  raise notice 'PASS E(no company): refused with 28000';
end $$;
set local role authenticated;
do $$
begin
  if exists (select 1 from public.bank_receipt_round_offs) then
    raise exception 'FAIL E(no company): round-offs readable without a company'; end if;
  raise notice 'PASS E(no company): round-off rows not readable';
end $$;
reset role;

-- ── F. un-reconcile a split line ────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209801","role":"authenticated"}', true);
do $$
declare n int;
begin
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000209803', false);
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000209803') is not null then
    raise exception 'FAIL F: line still matched'; end if;
  select count(*) into n from public.payments where bank_txn_id = '11111111-0000-0000-0000-000000209803';
  if n <> 0 then raise exception 'FAIL F: % receipts still on the line', n; end if;
  if exists (select 1 from public.bank_receipt_round_offs where bank_txn_id = '11111111-0000-0000-0000-000000209803') then
    raise exception 'FAIL F: round-off row kept'; end if;
  if pg_temp.undeposited() - (select v from r2098_bs where k = 'undep0') <> 11800 then
    raise exception 'FAIL F: undeposited moved by % (want the two receipts, 11,800)', pg_temp.undeposited() - (select v from r2098_bs where k = 'undep0'); end if;
  if (select sum(amount) from public.report_settlement_shortfalls('2026-10-22', '2026-10-22')) is distinct from -2::bigint then
    raise exception 'FAIL F: line C''s round-off still in the P&L'; end if;
  raise notice 'PASS F: un-reconciled — line free, receipts undeposited (+11,800), round-off gone';
end $$;

select 'R-2098 bank credit split: ALL PASS' as result;

rollback;
