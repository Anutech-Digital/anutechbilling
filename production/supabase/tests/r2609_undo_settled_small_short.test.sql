\set ON_ERROR_STOP on
-- R-2609: un-reconciling a bank line that carries an R-2595 settled small difference takes it back.
-- Migration: 20261108145951_r2609_undo_settled_small_short.sql (on top of 20261108092350 R-2595).
-- Self-asserting, ONE transaction, rolled back — run on the LOCAL DB only:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2609_undo_settled_small_short.test.sql
--
-- Expect "PASS r2609_undo_settled_small_short". Every check is collected and failures listed together.
--
--   Quarterly quotes, parts of ₹81,350 + 18% = ₹95,993; the bank brought ₹95,933 (₹60 short), settled (R-2595).
--   UNDO       owner un-reconciles Q1's line → no BANKCHG receipt (voucher kept as cancelled), Part 1 ₹60 due
--              again (pending, no paid date), round-off gone, P&L shortfall 0, quote received ₹95,933, line free
--   RESETTLE   re-match the line to the receipt, settle again → works (one BANKCHG receipt, round-off 60)
--   MANAGER    a manager un-reconciles Q2's line → refused 42501, nothing changed
--   REMATCH    Q2's line re-matched straight to nothing (reconcile_bank_txn, trusted) → reversed too
--   NEXT PART  Q3: Part 2 paid after the settle; undo → Part 1 ₹60 due, Part 2 still paid
--   CREDIT NOTE Q4: a credit note on Part 1 after the settle → undo refused, nothing changed

begin;
select set_config('request.jwt.claims', '', true);

create temp table r2609_fail (msg text) on commit drop;
grant all on r2609_fail to authenticated;

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

insert into auth.users (id, email) values
  ('e2609000-0000-4000-8000-0000000000a2', 'r2609-owner@example.test'),
  ('e2609000-0000-4000-8000-0000000000a3', 'r2609-manager@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2609000-0000-0000-0000-0000000000a0', 'R2609 A', 'r2609a@example.in', '07', 'R26A');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('e2609000-0000-4000-8000-0000000000a2', 'e2609000-0000-0000-0000-0000000000a0', 'r2609-owner@example.in', 'R2609 Owner', 'owner', true, now() - interval '1 day'),
  ('e2609000-0000-4000-8000-0000000000a3', 'e2609000-0000-0000-0000-0000000000a0', 'r2609-manager@example.in', 'R2609 Manager', 'manager', true, now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2609000-0000-4000-8000-0000000000c1', 'e2609000-0000-0000-0000-0000000000a0', 'R2609 Cust', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e2609000-0000-4000-8000-0000000000ba', 'e2609000-0000-0000-0000-0000000000a0', 'R2609 Current', 'R2609 Bank');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, billing_cycle, line_items)
select 'Q-R2609-' || k, 'e2609000-0000-0000-0000-0000000000a0', 'e2609000-0000-4000-8000-0000000000c1', 'R2609 Cust', 383972, 325400, 18, 'accepted', 'none', 'quarterly', '[]'::jsonb
  from generate_series(1, 4) k;
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id)
select ('e2609000-0000-4000-8000-0000000000e' || k)::uuid, 'e2609000-0000-0000-0000-0000000000a0', 'e2609000-0000-4000-8000-0000000000c1', 'R2609 Cust',
       'Workspace Business', 'google'::vendor, 10, 1000, 'quarterly'::billing_cycle, 'Q-R2609-' || k
  from generate_series(1, 4) k;
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
select ('e2609000-0000-4000-8000-00000000' || lpad(s::text, 2, '0') || lpad(n::text, 2, '0'))::uuid, 'e2609000-0000-0000-0000-0000000000a0',
       ('e2609000-0000-4000-8000-0000000000e' || s)::uuid, date '2026-08-01', n, date '2026-08-01' + (n - 1) * 90,
       date '2026-08-01' + (n - 1) * 90, date '2026-08-01' + n * 90 - 1, 81350, 18
  from generate_series(1, 4) s, generate_series(1, 4) n;

create temp table r2609_inv (k text primary key, id text) on commit drop;
grant all on r2609_inv to authenticated;
select set_config('request.jwt.claims', '{"sub":"e2609000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
insert into r2609_inv select 'Q' || k || '-P1', r.invoice_id from generate_series(1, 4) k,
  lateral public.raise_subscription_billing(('e2609000-0000-4000-8000-00000000' || lpad(k::text, 2, '0') || '01')::uuid) r;
insert into r2609_inv select 'Q3-P2', invoice_id from public.raise_subscription_billing('e2609000-0000-4000-8000-000000000302');
create function pg_temp.inv(p_k text) returns text language sql stable as $f$ select id from r2609_inv where k = p_k $f$;
grant execute on function pg_temp.inv(text) to authenticated;

select public.record_instalment_payment(pg_temp.inv('Q' || k || '-P1'), 95933, 'bank_transfer', 'UTR2609N' || k, 'R2609', null, 0, date '2026-08-05', 'e2609000-0000-4000-8000-0000000000ba')
  from generate_series(1, 4) k;
select set_config('request.jwt.claims', '', true);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit, source)
select ('e2609000-0000-4000-8000-0000000000d' || k)::uuid, 'e2609000-0000-0000-0000-0000000000a0', 'e2609000-0000-4000-8000-0000000000ba',
       '2026-08-05', 'NEFT R2609 N' || k, 'UTR2609N' || k, 95933, 0, 'manual'
  from generate_series(1, 4) k;

create function pg_temp.match(p_line uuid, p_quote text) returns void language sql as $f$
  update public.bank_transactions set matched_to_type = 'payment',
         matched_to_id = (select p.id::text from public.payments p where p.quote_id = p_quote and p.status = 'received'
                           and p.reference not like 'BANKCHG-%' order by p.received_at desc limit 1)
   where id = p_line $f$;
create function pg_temp.undo(p_line uuid) returns text language plpgsql as $f$
begin
  perform public.unreconcile_bank_receipt(p_line, false);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $f$;
grant execute on function pg_temp.undo(uuid) to authenticated;
-- what the line, its quote and its part invoice look like (to prove "nothing changed")
create function pg_temp.snap(p_k int) returns text language sql stable as $f$
  select concat_ws('|',
    (select matched_to_type || ':' || coalesce(matched_to_id, '') from public.bank_transactions where id = ('e2609000-0000-4000-8000-0000000000d' || p_k)::uuid),
    (select count(*) || '/' || coalesce(sum(amount), 0) || '/' || count(bank_txn_id) from public.payments where quote_id = 'Q-R2609-' || p_k),
    (select coalesce(sum(amount), 0) from public.bank_receipt_round_offs where bank_txn_id = ('e2609000-0000-4000-8000-0000000000d' || p_k)::uuid),
    (select status::text || '/' || coalesce(paid_amount, 0) from public.invoices where id = pg_temp.inv('Q' || p_k || '-P1')))
$f$;
grant execute on function pg_temp.snap(int) to authenticated;

do $$
declare v_err text; v_before text; v_short bigint; v_inv record; v_vno text;
begin
  perform pg_temp.match(('e2609000-0000-4000-8000-0000000000d' || k)::uuid, 'Q-R2609-' || k) from generate_series(1, 4) k;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"e2609000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  perform public.settle_quote_part_short('Q-R2609-' || k, 'R2609') from generate_series(1, 4) k;
  -- Q3: Part 2 paid in full after the settle.
  perform public.record_instalment_payment(pg_temp.inv('Q3-P2'), 95993, 'bank_transfer', 'UTR2609P2', 'R2609', null, 0, date '2026-11-05', 'e2609000-0000-4000-8000-0000000000ba');
  set local role postgres;
  if (select count(*) from public.payments where quote_id like 'Q-R2609-%' and reference like 'BANKCHG-%') <> 4 then
    raise exception 'setup: the four settles did not all write a BANKCHG receipt';
  end if;
  -- Q4: a credit note on Part 1 after the settle.
  insert into public.credit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount, tax_rate)
  values ('CN-R2609-4', 'e2609000-0000-0000-0000-0000000000a0', pg_temp.inv('Q4-P1'), 118, 100, 18, 18);

  -- MANAGER.
  v_before := pg_temp.snap(2);
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"e2609000-0000-4000-8000-0000000000a3","role":"authenticated"}', true);
  v_err := pg_temp.undo('e2609000-0000-4000-8000-0000000000d2');
  if v_err is null or v_err not like '42501%Only an owner or accountant can remove a receipt%' then
    insert into r2609_fail values ('MANAGER: got ' || coalesce(v_err, 'success'));
  end if;
  set local role postgres;
  if pg_temp.snap(2) is distinct from v_before then insert into r2609_fail values ('MANAGER: changed ' || v_before || ' -> ' || pg_temp.snap(2)); end if;

  -- CREDIT NOTE.
  v_before := pg_temp.snap(4);
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"e2609000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  v_err := pg_temp.undo('e2609000-0000-4000-8000-0000000000d4');
  if v_err is null or v_err not like '%credit note or a write-off after%' then
    insert into r2609_fail values ('CREDIT NOTE: got ' || coalesce(v_err, 'success'));
  end if;
  set local role postgres;
  if pg_temp.snap(4) is distinct from v_before then insert into r2609_fail values ('CREDIT NOTE: changed ' || v_before || ' -> ' || pg_temp.snap(4)); end if;

  -- UNDO (owner, the Undo button's RPC).
  select receipt_voucher_no into v_vno from public.payments where quote_id = 'Q-R2609-1' and reference like 'BANKCHG-%';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"e2609000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  v_err := pg_temp.undo('e2609000-0000-4000-8000-0000000000d1');
  if v_err is not null then insert into r2609_fail values ('UNDO: refused: ' || v_err); end if;
  v_err := pg_temp.undo('e2609000-0000-4000-8000-0000000000d3');
  if v_err is not null then insert into r2609_fail values ('NEXT PART: undo refused: ' || v_err); end if;
  set local role postgres;

  if exists (select 1 from public.payments where quote_id in ('Q-R2609-1', 'Q-R2609-3') and reference like 'BANKCHG-%') then
    insert into r2609_fail values ('UNDO: the ₹60 BANKCHG receipt is still there');
  end if;
  if v_vno is not null and not exists (select 1 from public.cancelled_vouchers where doc_no = v_vno and quote_id = 'Q-R2609-1' and amount = 60) then
    insert into r2609_fail values ('UNDO: voucher ' || v_vno || ' of the removed receipt not kept as cancelled');
  end if;
  select status::text as status, paid_amount, paid_date into v_inv from public.invoices where id = pg_temp.inv('Q1-P1');
  if v_inv.status not in ('pending', 'overdue') or v_inv.paid_amount is distinct from 95933 or v_inv.paid_date is not null then
    insert into r2609_fail values ('UNDO: Part 1 invoice ' || v_inv.status || '/' || coalesce(v_inv.paid_amount, -1) || '/' || coalesce(v_inv.paid_date::text, 'no date') || ' (want pending|overdue/95933/no date)');
  end if;
  if exists (select 1 from public.bank_receipt_round_offs where bank_txn_id in ('e2609000-0000-4000-8000-0000000000d1', 'e2609000-0000-4000-8000-0000000000d3')) then
    insert into r2609_fail values ('UNDO: round-off left on the line');
  end if;
  if (select coalesce(sum(amount), 0) from public.payments where quote_id = 'Q-R2609-1' and status = 'received') <> 95933
     or (select payment_amount from public.quotes where id = 'Q-R2609-1') is distinct from 95933 then
    insert into r2609_fail values ('UNDO: quote received is not ₹95,933 (' || (select payment_amount from public.quotes where id = 'Q-R2609-1') || ')');
  end if;
  if exists (select 1 from public.payments where quote_id = 'Q-R2609-1' and bank_txn_id is not null)
     or (select matched_to_type from public.bank_transactions where id = 'e2609000-0000-4000-8000-0000000000d1') is not null then
    insert into r2609_fail values ('UNDO: the line is not free / a receipt still points at it');
  end if;
  select coalesce(sum(r.amount), 0) into v_short from public.report_settlement_shortfalls('2026-08-01', '2026-08-31') r;
  -- Q2 and Q4 are still settled (₹60 each); Q1 and Q3 undone.
  if v_short <> 120 then insert into r2609_fail values ('UNDO: P&L settlement shortfall ₹' || v_short || ' (want ₹120 — Q2 + Q4 only)'); end if;

  -- NEXT PART.
  if (select status::text || '/' || paid_amount from public.invoices where id = pg_temp.inv('Q3-P1')) not in ('pending/95933', 'overdue/95933') then
    insert into r2609_fail values ('NEXT PART: Part 1 is ' || (select status::text || '/' || paid_amount from public.invoices where id = pg_temp.inv('Q3-P1')));
  end if;
  if (select status::text || '/' || paid_amount from public.invoices where id = pg_temp.inv('Q3-P2')) is distinct from 'paid/95993' then
    insert into r2609_fail values ('NEXT PART: Part 2 changed: ' || (select status::text || '/' || paid_amount from public.invoices where id = pg_temp.inv('Q3-P2')));
  end if;

  -- RESETTLE.
  perform pg_temp.match('e2609000-0000-4000-8000-0000000000d1', 'Q-R2609-1');
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"e2609000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  begin
    perform public.settle_quote_part_short('Q-R2609-1', 'again');
  exception when others then
    insert into r2609_fail values ('RESETTLE: refused: ' || sqlerrm);
  end;
  set local role postgres;
  if (select count(*) from public.payments where quote_id = 'Q-R2609-1' and reference = 'BANKCHG-e2609000-0000-4000-8000-0000000000d1') <> 1
     or (select coalesce(sum(amount), 0) from public.bank_receipt_round_offs where bank_txn_id = 'e2609000-0000-4000-8000-0000000000d1') <> 60
     or (select status::text from public.invoices where id = pg_temp.inv('Q1-P1')) <> 'paid' then
    insert into r2609_fail values ('RESETTLE: not settled again: ' || pg_temp.snap(1));
  end if;

  -- REMATCH (no Undo button: the line freed through reconcile_bank_txn in a trusted session).
  -- Also LEGACY: a settle made before R-2609 has no invoice_id on its round-off → the one part paid that day.
  if (select invoice_id from public.bank_receipt_round_offs where bank_txn_id = 'e2609000-0000-4000-8000-0000000000d2') is distinct from pg_temp.inv('Q2-P1') then
    insert into r2609_fail values ('SETTLE: the round-off does not name the part invoice');
  end if;
  update public.bank_receipt_round_offs set invoice_id = null where bank_txn_id = 'e2609000-0000-4000-8000-0000000000d2';
  perform public.reconcile_bank_txn('e2609000-0000-4000-8000-0000000000d2', null, null, 'manual');
  if exists (select 1 from public.payments where quote_id = 'Q-R2609-2' and reference like 'BANKCHG-%')
     or (select status::text || '/' || paid_amount from public.invoices where id = pg_temp.inv('Q2-P1')) not in ('pending/95933', 'overdue/95933')
     or exists (select 1 from public.bank_receipt_round_offs where bank_txn_id = 'e2609000-0000-4000-8000-0000000000d2') then
    insert into r2609_fail values ('REMATCH: not reversed: ' || pg_temp.snap(2));
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2609_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2609_undo_settled_small_short:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2609_undo_settled_small_short';
end $$;

rollback;
