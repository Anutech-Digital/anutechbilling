\set ON_ERROR_STOP on
-- R-2322 (1 Nov 2026): a customer refund booked on a money-out bank line (Banking → Reconcile →
-- Customer refund). Migration 20261101013533_r2322_bank_customer_refund.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner's example (R-2319 staging run, 31 Oct): a money-out line refunding a customer (Novoguild
-- ₹41,832) had no customer-refund choice. Same shape here, smaller numbers.
--
-- Proves:
--   A. Credit-note refund: invoice ₹11,800 paid (its receipt reconciled to a money-in line), credit
--      note ₹2,360 → ₹2,360 open credit. The refundable list offers it (₹2,360). A ₹3,000 money-out
--      line is refused (over-refund); a ₹1,500 line books through refund_credit_note_credit: RFV,
--      customer credit 2,360 → 860, invoice still paid, the receipt's money-in line untouched, the
--      money-out line matched ONCE (customer_refund), refunded_at = the bank date, balance sheet
--      advances −1,500 while cash / undeposited do not move (balanced against the bank debit).
--   B. Undo order: the rest (₹860) on a second line; un-reconciling the FIRST line is then refused
--      (its rows changed after it) — nothing changes; un-reconcile the second, then the first:
--      credit back to 2,360, the original receipt 11,800 received again, split rows gone, invoice
--      paid_amount back, both RFV numbers kept as cancelled refund vouchers, advances back.
--   C. Advance refund: a ₹10,000 bank advance (R-1863). A ₹6,000 line is refused (advance goes
--      back whole); a ₹10,000 line books through refund_payment: credit 0, advances −10,000; undo
--      restores credit + receipt.
--   D. Guards: sales login (42501), billing login cannot book or undo (42501), other company's
--      owner (42501), money-in line, already-reconciled line, short reason; a line cannot be set
--      to customer_refund by reconcile_bank_txn directly.

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
  ('d2322000-0000-0000-0000-0000000000a0', 'R2322 Co',    'r2322a@example.in', '07', 'R232'),
  ('d2322000-0000-0000-0000-0000000000b0', 'R2322 Other', 'r2322b@example.in', '07', 'R23B');
insert into auth.users (id, email) values
  ('a2322000-0000-4000-8000-0000000000a1', 'owner2322@example.test'),
  ('a2322000-0000-4000-8000-0000000000a2', 'sales2322@example.test'),
  ('a2322000-0000-4000-8000-0000000000a3', 'billing2322@example.test'),
  ('a2322000-0000-4000-8000-0000000000b1', 'ownerb2322@example.test');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('a2322000-0000-4000-8000-0000000000a1', 'd2322000-0000-0000-0000-0000000000a0', 'owner2322@example.in',   'Owner 2322',   'owner',   true),
  ('a2322000-0000-4000-8000-0000000000a2', 'd2322000-0000-0000-0000-0000000000a0', 'sales2322@example.in',   'Sales 2322',   'sales',   true),
  ('a2322000-0000-4000-8000-0000000000a3', 'd2322000-0000-0000-0000-0000000000a0', 'billing2322@example.in', 'Billing 2322', 'billing', true),
  ('a2322000-0000-4000-8000-0000000000b1', 'd2322000-0000-0000-0000-0000000000b0', 'ownerb2322@example.in',  'Owner B 2322', 'owner',   true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('c2322000-0000-4000-8000-0000000000c1', 'd2322000-0000-0000-0000-0000000000a0', 'Novo 2322', '07', 'India'),
  ('c2322000-0000-4000-8000-0000000000c2', 'd2322000-0000-0000-0000-0000000000a0', 'Adv 2322',  '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('b2322000-0000-0000-0000-0000000000a0', 'd2322000-0000-0000-0000-0000000000a0', 'HDFC Current', 'HDFC'),
  ('b2322000-0000-0000-0000-0000000000b0', 'd2322000-0000-0000-0000-0000000000b0', 'Other bank', 'SBI');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R2322-CN', 'd2322000-0000-0000-0000-0000000000a0', 'c2322000-0000-4000-8000-0000000000c1', 'Novo 2322', 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('12322000-0000-0000-0000-000000000001', 'd2322000-0000-0000-0000-0000000000a0', 'b2322000-0000-0000-0000-0000000000a0', '2026-10-20', 'NEFT NOVO 2322',        0, 11800, 'UTR2322IN',   'manual'),
  ('12322000-0000-0000-0000-000000000002', 'd2322000-0000-0000-0000-0000000000a0', 'b2322000-0000-0000-0000-0000000000a0', '2026-10-28', 'REFUND NOVO 2322 BIG',   3000, 0, 'UTR2322BIG',  'manual'),
  ('12322000-0000-0000-0000-000000000003', 'd2322000-0000-0000-0000-0000000000a0', 'b2322000-0000-0000-0000-0000000000a0', '2026-10-29', 'REFUND NOVO 2322',       1500, 0, 'UTR2322OUT1', 'manual'),
  ('12322000-0000-0000-0000-000000000004', 'd2322000-0000-0000-0000-0000000000a0', 'b2322000-0000-0000-0000-0000000000a0', '2026-10-30', 'REFUND NOVO 2322 REST',   860, 0, 'UTR2322OUT2', 'manual'),
  ('12322000-0000-0000-0000-000000000005', 'd2322000-0000-0000-0000-0000000000a0', 'b2322000-0000-0000-0000-0000000000a0', '2026-10-21', 'NEFT ADV 2322',          0, 10000, 'UTR2322ADV',  'manual'),
  ('12322000-0000-0000-0000-000000000006', 'd2322000-0000-0000-0000-0000000000a0', 'b2322000-0000-0000-0000-0000000000a0', '2026-10-29', 'REFUND ADV 2322 PART',   6000, 0, 'UTR2322AP',   'manual'),
  ('12322000-0000-0000-0000-000000000007', 'd2322000-0000-0000-0000-0000000000a0', 'b2322000-0000-0000-0000-0000000000a0', '2026-10-30', 'REFUND ADV 2322',       10000, 0, 'UTR2322AO',   'manual'),
  ('12322000-0000-0000-0000-000000000008', 'd2322000-0000-0000-0000-0000000000b0', 'b2322000-0000-0000-0000-0000000000b0', '2026-10-30', 'OTHER CO OUT',           1500, 0, 'UTR2322X',    'manual');

create temp table r2322_fail (msg text) on commit drop;
grant all on r2322_fail to authenticated;

create function pg_temp.r2322_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
create function pg_temp.r2322_try(p_txn uuid, p_pay uuid, p_reason text) returns text language plpgsql as $$
begin
  perform public.reconcile_bank_debit_as_customer_refund(p_txn, p_pay, p_reason);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r2322_try_undo(p_txn uuid) returns text language plpgsql as $$
begin
  perform public.unreconcile_bank_receipt(p_txn, false);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.r2322_as(text) to authenticated;
grant execute on function pg_temp.r2322_try(uuid, uuid, text) to authenticated;
grant execute on function pg_temp.r2322_try_undo(uuid) to authenticated;

do $$
declare
  c1   constant uuid := 'c2322000-0000-4000-8000-0000000000c1';
  c2   constant uuid := 'c2322000-0000-4000-8000-0000000000c2';
  l_in   constant uuid := '12322000-0000-0000-0000-000000000001';
  l_big  constant uuid := '12322000-0000-0000-0000-000000000002';
  l_out1 constant uuid := '12322000-0000-0000-0000-000000000003';
  l_out2 constant uuid := '12322000-0000-0000-0000-000000000004';
  l_adv  constant uuid := '12322000-0000-0000-0000-000000000005';
  l_ap   constant uuid := '12322000-0000-0000-0000-000000000006';
  l_ao   constant uuid := '12322000-0000-0000-0000-000000000007';
  l_x    constant uuid := '12322000-0000-0000-0000-000000000008';
  owner  constant text := 'a2322000-0000-4000-8000-0000000000a1';
  v_inv text; v_pay uuid; v_adv uuid; v_r jsonb; v_r2 jsonb; v_e text; v_n int; v_t text;
  v_adv0 bigint; v_adv1 bigint; v_cash0 bigint; v_cash1 bigint; v_und0 bigint; v_und1 bigint;
  v_paid0 int; v_snap0 text; v_snap1 text;
begin
  set local role authenticated;
  perform pg_temp.r2322_as(owner);

  -- ════ A. setup: invoice, payment reconciled to the money-in line, credit note ══════════════
  select invoice_id into v_inv from public.generate_invoice('Q-R2322-CN');
  perform public.record_desk_payment('Q-R2322-CN', 11800, 'bank_transfer', 'UTR2322IN', null, null, 0, '2026-10-20'::date, null);
  select id into v_pay from public.payments where quote_id = 'Q-R2322-CN';
  perform public.reconcile_bank_txn(l_in, 'payment', v_pay::text, 'manual');
  perform public.issue_credit_note(v_inv, 2360, 'other', 'Two seats removed', null);
  set local role postgres;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c1 and status = 'open') <> 2360 then
    insert into r2322_fail values ('A setup: open credit is not 2360');
  end if;
  select paid_amount into v_paid0 from public.invoices where id = v_inv;
  select string_agg(id::text || ':' || amount || ':' || status, ',' order by id) into v_snap0 from public.customer_credits where customer_id = c1;
  set local role authenticated;

  -- the refundable list
  select count(*) into v_n from public.customer_refundable_items(c1)
   where payment_id = v_pay and kind = 'credit_note' and refundable = 2360 and invoice_id = v_inv and not whole_only;
  if v_n <> 1 then insert into r2322_fail values ('A: refundable list does not offer the 2360 credit-note credit'); end if;

  -- over-refund
  v_e := pg_temp.r2322_try(l_big, v_pay, 'Two seats removed, money back');
  if v_e is null or v_e not like '22023: At most ₹2360 can be refunded against invoice %' then
    insert into r2322_fail values ('A: over-refund not refused: ' || coalesce(v_e, 'ran'));
  end if;

  -- guards
  v_e := pg_temp.r2322_try(l_out1, v_pay, 'x');
  if v_e is null or v_e not like '22023: Write why the money went back%' then insert into r2322_fail values ('D: short reason: ' || coalesce(v_e, 'ran')); end if;
  v_e := pg_temp.r2322_try(l_adv, v_pay, 'Two seats removed, money back');
  if v_e is null or v_e not like '22023: A customer refund is money going out%' then insert into r2322_fail values ('D: money-in line: ' || coalesce(v_e, 'ran')); end if;
  v_e := pg_temp.r2322_try(l_in, v_pay, 'Two seats removed, money back');
  if v_e is null or v_e not like '22023: This line is already reconciled%' then insert into r2322_fail values ('D: reconciled line: ' || coalesce(v_e, 'ran')); end if;
  perform pg_temp.r2322_as('a2322000-0000-4000-8000-0000000000a2');
  v_e := pg_temp.r2322_try(l_out1, v_pay, 'Two seats removed, money back');
  if v_e is null or v_e not like '42501: Refunds are for an owner, manager or accountant%' then insert into r2322_fail values ('D: sales booked: ' || coalesce(v_e, 'ran')); end if;
  perform pg_temp.r2322_as('a2322000-0000-4000-8000-0000000000a3');
  v_e := pg_temp.r2322_try(l_out1, v_pay, 'Two seats removed, money back');
  if v_e is null or v_e not like '42501: Refunds are for an owner, manager or accountant%' then insert into r2322_fail values ('D: billing booked: ' || coalesce(v_e, 'ran')); end if;
  perform pg_temp.r2322_as('a2322000-0000-4000-8000-0000000000b1');
  v_e := pg_temp.r2322_try(l_x, v_pay, 'Two seats removed, money back');
  if v_e is null or v_e not like '42501: That payment was not found in your company%' then insert into r2322_fail values ('D: other company booked: ' || coalesce(v_e, 'ran')); end if;
  perform pg_temp.r2322_as(owner);
  begin
    perform public.reconcile_bank_txn(l_out1, 'customer_refund', gen_random_uuid()::text, 'manual');
    insert into r2322_fail values ('D: reconcile_bank_txn made a customer_refund line by hand');
  exception when others then
    if sqlerrm not like 'A bank line becomes a customer refund only through Reconcile%' then
      insert into r2322_fail values ('D: direct customer_refund refused with the wrong message: ' || sqlerrm);
    end if;
  end;

  -- the ₹1,500 refund
  select advances_from_customers, cash_and_bank, undeposited_funds into v_adv0, v_cash0, v_und0 from public.report_balance_sheet(public.ist_today());
  begin
    v_r := public.reconcile_bank_debit_as_customer_refund(l_out1, v_pay, 'Two seats removed, money back');
  exception when others then insert into r2322_fail values ('A: 1500 refund raised: ' || sqlerrm);
  end;
  if coalesce(v_r->>'kind', '') <> 'credit_note' or (v_r->>'amount')::int <> 1500 or coalesce(v_r->>'refund_voucher_no', '') not like 'RFV-%'
     or (v_r->>'credit_note_credit_left')::int <> 860 then
    insert into r2322_fail values ('A: result wrong: ' || coalesce(v_r::text, 'null'));
  end if;
  select advances_from_customers, cash_and_bank, undeposited_funds into v_adv1, v_cash1, v_und1 from public.report_balance_sheet(public.ist_today());
  if v_adv0 - v_adv1 <> 1500 then insert into r2322_fail values ('A: advances moved ' || (v_adv1 - v_adv0) || ' (want −1500)'); end if;
  if v_cash1 <> v_cash0 or v_und1 <> v_und0 then insert into r2322_fail values ('A: cash/undeposited moved on reconcile — not balanced'); end if;

  set local role postgres;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c1 and status = 'open') <> 860 then
    insert into r2322_fail values ('A: open credit is not 860 after the 1500 refund');
  end if;
  select matched_to_type into v_t from public.bank_transactions where id = l_out1;
  if v_t is distinct from 'customer_refund'
     or (select count(*) from public.bank_customer_refunds where bank_txn_id = l_out1 and id::text = (select matched_to_id from public.bank_transactions where id = l_out1)) <> 1 then
    insert into r2322_fail values ('A: money-out line not matched once to its refund (' || coalesce(v_t, 'null') || ')');
  end if;
  if (select matched_to_type || ':' || matched_to_id from public.bank_transactions where id = l_in) is distinct from 'payment:' || v_pay::text then
    insert into r2322_fail values ('A: the receipt''s money-in line changed');
  end if;
  select count(*) into v_n from public.payments
   where quote_id = 'Q-R2322-CN' and status = 'refunded' and amount = 1500
     and (refunded_at at time zone 'UTC')::date = '2026-10-29' and refund_voucher_no = v_r->>'refund_voucher_no';
  if v_n <> 1 then insert into r2322_fail values ('A: want one 1500 refunded row on the bank date, got ' || v_n); end if;
  if (select status::text from public.invoices where id = v_inv) <> 'paid' then insert into r2322_fail values ('A: invoice no longer paid'); end if;
  set local role authenticated;

  -- ════ B. the rest on a second line, then undo in the right order ══════════════════════════
  begin
    v_r2 := public.reconcile_bank_debit_as_customer_refund(l_out2, v_pay, 'Rest of the credit back');
  exception when others then insert into r2322_fail values ('B: 860 refund raised: ' || sqlerrm);
  end;
  set local role postgres;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c1 and status = 'open') <> 0 then
    insert into r2322_fail values ('B: credit left after refunding the rest');
  end if;
  set local role authenticated;
  -- over-refund: nothing left
  v_e := pg_temp.r2322_try(l_big, v_pay, 'Two seats removed, money back');
  if v_e is null or v_e not like '22023: Invoice % has no open credit-note credit to refund%' then
    insert into r2322_fail values ('B: refund with no credit left not refused: ' || coalesce(v_e, 'ran'));
  end if;

  -- undo the FIRST line now → refused, nothing changes
  v_e := pg_temp.r2322_try_undo(l_out1);
  if v_e is null or v_e not like '23514: This refund (RFV-%) cannot be taken back%' then
    insert into r2322_fail values ('B: out-of-order undo not refused: ' || coalesce(v_e, 'ran'));
  end if;
  set local role postgres;
  if (select matched_to_type from public.bank_transactions where id = l_out1) is distinct from 'customer_refund' then
    insert into r2322_fail values ('B: refused undo still freed the line');
  end if;
  set local role authenticated;

  -- billing cannot take a refund back
  perform pg_temp.r2322_as('a2322000-0000-4000-8000-0000000000a3');
  v_e := pg_temp.r2322_try_undo(l_out2);
  if v_e is null or v_e not like '42501: Un-reconciling this line takes back the ₹860 customer refund%' then
    insert into r2322_fail values ('D: billing undo not refused: ' || coalesce(v_e, 'ran'));
  end if;
  perform pg_temp.r2322_as(owner);

  v_e := pg_temp.r2322_try_undo(l_out2);
  if v_e is not null then insert into r2322_fail values ('B: undo of the second line raised: ' || v_e); end if;
  v_e := pg_temp.r2322_try_undo(l_out1);
  if v_e is not null then insert into r2322_fail values ('B: undo of the first line raised: ' || v_e); end if;

  set local role postgres;
  select string_agg(id::text || ':' || amount || ':' || status, ',' order by id) into v_snap1 from public.customer_credits where customer_id = c1;
  if v_snap1 is distinct from v_snap0 then insert into r2322_fail values ('B: credits not restored: ' || coalesce(v_snap1, 'none') || ' vs ' || coalesce(v_snap0, 'none')); end if;
  if (select string_agg(amount || ':' || status, ',') from public.payments where quote_id = 'Q-R2322-CN') is distinct from '11800:received' then
    insert into r2322_fail values ('B: payments not restored: ' || (select string_agg(amount || ':' || status, ',') from public.payments where quote_id = 'Q-R2322-CN'));
  end if;
  if (select paid_amount from public.invoices where id = v_inv) is distinct from v_paid0 then insert into r2322_fail values ('B: invoice paid_amount not restored'); end if;
  if (select count(*) from public.bank_transactions where id in (l_out1, l_out2) and matched_to_type is null) <> 2 then
    insert into r2322_fail values ('B: lines not free after undo');
  end if;
  if (select count(*) from public.bank_customer_refunds where bank_txn_id in (l_out1, l_out2)) <> 0 then
    insert into r2322_fail values ('B: refund rows left after undo');
  end if;
  if (select count(*) from public.cancelled_vouchers where doc_type = 'refund_voucher'
        and doc_no in (v_r->>'refund_voucher_no', v_r2->>'refund_voucher_no')) <> 2 then
    insert into r2322_fail values ('B: refund voucher numbers not kept as cancelled');
  end if;
  set local role authenticated;
  select advances_from_customers into v_adv1 from public.report_balance_sheet(public.ist_today());
  if v_adv1 <> v_adv0 then insert into r2322_fail values ('B: advances not back after undo: ' || v_adv1 || ' vs ' || v_adv0); end if;

  -- ════ C. an unused advance ════════════════════════════════════════════════════════════════
  perform public.reconcile_bank_credit_as_advance(l_adv, c2);
  set local role postgres;
  select matched_to_id::uuid into v_adv from public.bank_transactions where id = l_adv;
  set local role authenticated;
  select count(*) into v_n from public.customer_refundable_items(c2) where payment_id = v_adv and kind = 'advance' and refundable = 10000 and whole_only;
  if v_n <> 1 then insert into r2322_fail values ('C: refundable list does not offer the 10000 advance'); end if;
  v_e := pg_temp.r2322_try(l_ap, v_adv, 'Advance not needed any more');
  if v_e is null or v_e not like '22023: This advance is ₹10000 but the bank line is ₹6000%' then
    insert into r2322_fail values ('C: part advance refund not refused: ' || coalesce(v_e, 'ran'));
  end if;
  select advances_from_customers, cash_and_bank into v_adv0, v_cash0 from public.report_balance_sheet(public.ist_today());
  begin
    v_r := public.reconcile_bank_debit_as_customer_refund(l_ao, v_adv, 'Advance not needed any more');
  exception when others then insert into r2322_fail values ('C: advance refund raised: ' || sqlerrm);
  end;
  if coalesce(v_r->>'kind', '') <> 'advance' or (v_r->>'amount')::int <> 10000 then insert into r2322_fail values ('C: result wrong: ' || coalesce(v_r::text, 'null')); end if;
  select advances_from_customers, cash_and_bank into v_adv1, v_cash1 from public.report_balance_sheet(public.ist_today());
  if v_adv0 - v_adv1 <> 10000 or v_cash1 <> v_cash0 then insert into r2322_fail values ('C: advances moved ' || (v_adv1 - v_adv0) || ' (want −10000, cash unchanged)'); end if;
  set local role postgres;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c2 and status = 'open') <> 0 then
    insert into r2322_fail values ('C: advance credit still open');
  end if;
  set local role authenticated;
  v_e := pg_temp.r2322_try_undo(l_ao);
  if v_e is not null then insert into r2322_fail values ('C: advance undo raised: ' || v_e); end if;
  set local role postgres;
  if (select coalesce(sum(amount), 0) from public.customer_credits where customer_id = c2 and status = 'open') <> 10000
     or (select status from public.payments where id = v_adv) <> 'received' then
    insert into r2322_fail values ('C: advance not restored after undo');
  end if;
  set local role authenticated;
  select advances_from_customers into v_adv1 from public.report_balance_sheet(public.ist_today());
  if v_adv1 <> v_adv0 then insert into r2322_fail values ('C: advances not back after undo'); end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n') into v_msgs from r2322_fail;
  if v_msgs is not null then raise exception E'FAIL r2322_bank_customer_refund:\n%', v_msgs; end if;
  raise notice 'PASS r2322_bank_customer_refund';
end $$;

rollback;
