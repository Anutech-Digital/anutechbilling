-- R-1863 (24 Oct 2026): a bank credit booked as a customer's ADVANCE (on account), un-reconciled
-- cleanly, and an old one-off "bank sale" booking (before R-1838) relinked onto what it paid.
-- Migration 20261024144118_r1863_bank_credit_advance.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. Advance: one receipt (voucher, bank account, BANK date) on a ₹0 "Advance on account" holder
--      quote + ONE open customer credit of the full amount (source overpayment, linked to that
--      receipt — record_payment's own shape), line reconciled to the receipt; the balance sheet's
--      advances rise by exactly the amount and undeposited funds do not move; the holder quote is
--      not offered as an open item.
--   B. The credit pays the customer's next quote through Record payment's "apply credit"
--      (record_desk_payment → redeem_customer_credits), unchanged.
--   C. Un-reconcile is REFUSED once any of the credit is used — nothing changes.
--   D. Un-reconcile of an unused advance: line free, receipt gone (voucher kept as cancelled),
--      credit gone, holder quote rejected; the line books again.
--   E. Guards: already-reconciled / money-out / other company's line / other company's customer,
--      a sales login (42501), a no-company login (28000); a billing login cannot take an advance
--      back (removes a receipt) — nothing written.
--   F. Old one-off bookings list: the pre-R-1838 bank sale is listed with its invoice; R-1838 /
--      advance lines are not.
--   G. Relink onto a renewal quote, ONE transaction: the old GST invoice gets a full credit note,
--      the old receipt is gone and its voucher kept as cancelled, the old quote is rejected, the
--      subscription renews, the line is reconciled to the new payment.
--   H. Relink refused (nothing changed) when the books are locked over the old receipt / invoice.
--   I. Relink of a line that is not an old one-off booking, and by a billing login, refused.
--   J. Relink onto an advance.

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
  ('dddddddd-0000-0000-0000-000000186301','R1863 Co','r1863@example.in','07','R1863'),
  ('dddddddd-0000-0000-0000-000000186302','R1863 Other','r1863b@example.in','07','R1863B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000186301','owner1863@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000186302','sales1863@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000186303','nocompany1863@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000186304','billing1863@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000186301','dddddddd-0000-0000-0000-000000186301','owner1863@example.in','Owner 1863','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000186302','dddddddd-0000-0000-0000-000000186301','sales1863@example.in','Sales 1863','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000186304','dddddddd-0000-0000-0000-000000186301','billing1863@example.in','Billing 1863','billing', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000186301','dddddddd-0000-0000-0000-000000186301','Acme 1863','07','acme1863.in'),
  ('cccccccc-0000-0000-0000-000000186302','dddddddd-0000-0000-0000-000000186301','Beta 1863','07','beta1863.in'),
  ('cccccccc-0000-0000-0000-000000186303','dddddddd-0000-0000-0000-000000186302','Gamma 1863','07','gamma1863.in');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000186301','dddddddd-0000-0000-0000-000000186301','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000186302','dddddddd-0000-0000-0000-000000186302','Other bank','SBI');

-- Acme's next quote (paid later with the advance credit): 5,000 + 18% = 5,900, one-off.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
values ('Q-R1863-USE','dddddddd-0000-0000-0000-000000186301','cccccccc-0000-0000-0000-000000186301','Acme 1863',
        5900, 5000, 0, 18, 'accepted', 'awaiting', 'yearly',
        '[{"name":"Support hours","qty":1,"rate":5000,"one_time":true}]'::jsonb, true, '2026-10-21');

-- Beta's running subscription and its renewal quote (10 × 1,000 + 18% = 11,800) for the relink (G).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  start_date, renewal_date, status, term_months, domain)
values ('eeeeeeee-0000-0000-0000-000000186301','dddddddd-0000-0000-0000-000000186301','cccccccc-0000-0000-0000-000000186302',
        'Beta 1863','Google Workspace Business Starter','google',10,833,'2025-11-01','2026-11-01','active',12,'beta1863.in');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_renewal, extension_months,
                           renewal_subscription_id, renewal_term_date, created_date)
values ('Q-R1863-REN','dddddddd-0000-0000-0000-000000186301','cccccccc-0000-0000-0000-000000186302','Beta 1863',
        11800, 10000, 0, 18, 'sent', 'awaiting', 'yearly',
        '[{"name":"Google Workspace Business Starter","qty":10,"rate":1000,"commitment":"annual_yearly"}]'::jsonb,
        true, 12, 'eeeeeeee-0000-0000-0000-000000186301', '2026-11-01', '2026-10-10');
update public.subscriptions set renewal_quote_id = 'Q-R1863-REN' where id = 'eeeeeeee-0000-0000-0000-000000186301';

-- The OLD "Create invoice" one-off quotes (pre-R-1838 shape) for G, H and J.
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date, notes)
values
  ('Q-R1863-OLD1','dddddddd-0000-0000-0000-000000186301','cccccccc-0000-0000-0000-000000186302','Beta 1863','Google Workspace',
   11800, 10000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Google Workspace","qty":1,"rate":10000,"one_time":true}]'::jsonb, true, '2026-10-12', 'Raised from a bank receipt (reconcile)'),
  ('Q-R1863-OLD2','dddddddd-0000-0000-0000-000000186301','cccccccc-0000-0000-0000-000000186302','Beta 1863','Google Workspace',
   5900, 5000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Google Workspace","qty":1,"rate":5000,"one_time":true}]'::jsonb, true, '2026-10-05', 'Raised from a bank receipt (reconcile)'),
  ('Q-R1863-OLD3','dddddddd-0000-0000-0000-000000186301','cccccccc-0000-0000-0000-000000186301','Acme 1863','Consulting',
   3540, 3000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Consulting","qty":1,"rate":3000,"one_time":true}]'::jsonb, true, '2026-10-14', 'Raised from a bank receipt (reconcile)');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000186301','dddddddd-0000-0000-0000-000000186301','bbbbbbbb-0000-0000-0000-000000186301','2026-10-20','NEFT ACME 1863 ADVANCE',0,10000,'UTR1863ADV','manual'),
  ('11111111-0000-0000-0000-000000186302','dddddddd-0000-0000-0000-000000186301','bbbbbbbb-0000-0000-0000-000000186301','2026-10-21','NEFT ACME 1863 ADV2',0,6000,'UTR1863ADV2','manual'),
  ('11111111-0000-0000-0000-000000186303','dddddddd-0000-0000-0000-000000186301','bbbbbbbb-0000-0000-0000-000000186301','2026-10-21','RENT PAID',5000,0,'UTR1863OUT','manual'),
  ('11111111-0000-0000-0000-000000186304','dddddddd-0000-0000-0000-000000186302','bbbbbbbb-0000-0000-0000-000000186302','2026-10-21','OTHER CO',0,4000,'UTR1863X','manual'),
  ('11111111-0000-0000-0000-000000186305','dddddddd-0000-0000-0000-000000186301','bbbbbbbb-0000-0000-0000-000000186301','2026-10-12','NEFT BETA 1863',0,11800,'UTR1863OLD1','manual'),
  ('11111111-0000-0000-0000-000000186306','dddddddd-0000-0000-0000-000000186301','bbbbbbbb-0000-0000-0000-000000186301','2026-10-05','NEFT BETA 1863 OCT',0,5900,'UTR1863OLD2','manual'),
  ('11111111-0000-0000-0000-000000186307','dddddddd-0000-0000-0000-000000186301','bbbbbbbb-0000-0000-0000-000000186301','2026-10-14','NEFT ACME 1863 CONSULT',0,3540,'UTR1863OLD3','manual'),
  ('11111111-0000-0000-0000-000000186308','dddddddd-0000-0000-0000-000000186301','bbbbbbbb-0000-0000-0000-000000186301','2026-10-22','NEFT SOMEONE',0,7000,'UTR1863FREE','manual');

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186301","role":"authenticated"}', true);

-- The old flow (useBookCreditAsInvoice, before R-1838): record_payment with the bank-sale note,
-- invoice, then the line matched to the receipt.
do $$
declare r jsonb; q text; t uuid;
begin
  for q, t in values ('Q-R1863-OLD1', '11111111-0000-0000-0000-000000186305'::uuid),
                     ('Q-R1863-OLD2', '11111111-0000-0000-0000-000000186306'::uuid),
                     ('Q-R1863-OLD3', '11111111-0000-0000-0000-000000186307'::uuid)
  loop
    r := public.record_desk_payment(q, (select credit from public.bank_transactions where id = t)::int, 'bank_transfer',
           (select reference from public.bank_transactions where id = t), 'Reconciled from bank receipt',
           null, 0, (select txn_date from public.bank_transactions where id = t), 'bbbbbbbb-0000-0000-0000-000000186301');
    perform public.generate_invoice(q);
    perform public.reconcile_bank_txn(t, 'payment', r->>'payment_id', 'manual');
  end loop;
end $$;

-- A. Advance
do $$
declare r jsonb; p record; c record; q record; t record; n int;
        adv0 bigint; und0 bigint; adv1 bigint; und1 bigint;
begin
  select advances_from_customers, undeposited_funds into adv0, und0 from public.report_balance_sheet('2026-10-31');
  r := public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000186301', 'cccccccc-0000-0000-0000-000000186301');
  if r->>'kind' is distinct from 'advance' or (r->>'advance_credit')::int is distinct from 10000 or r->>'customer_name' is distinct from 'Acme 1863' then
    raise exception 'FAIL A: result %', r; end if;
  select * into p from public.payments where id = (r->>'payment_id')::uuid;
  if p.amount is distinct from 10000 or p.receipt_voucher_no is null or p.bank_account_id is distinct from 'bbbbbbbb-0000-0000-0000-000000186301'
     or p.reference is distinct from 'UTR1863ADV' or p.customer_id is distinct from 'cccccccc-0000-0000-0000-000000186301'
     or (p.received_at at time zone 'Asia/Kolkata')::date is distinct from '2026-10-20' or p.status is distinct from 'received'
     or coalesce(p.credit_applied, 0) <> 0 then
    raise exception 'FAIL A: payment % % % % %', p.amount, p.receipt_voucher_no, p.bank_account_id, p.reference, p.received_at; end if;
  select count(*) into n from public.customer_credits where source_payment_id = p.id;
  if n <> 1 then raise exception 'FAIL A: % credit rows (want 1)', n; end if;
  select * into c from public.customer_credits where source_payment_id = p.id;
  if c.amount is distinct from 10000 or c.status is distinct from 'open' or c.source is distinct from 'overpayment'
     or c.customer_id is distinct from 'cccccccc-0000-0000-0000-000000186301' or c.source_quote_id is distinct from p.quote_id then
    raise exception 'FAIL A: credit % % % %', c.amount, c.status, c.source, c.customer_id; end if;
  select * into q from public.quotes where id = p.quote_id;
  if q.amount is distinct from 0 or not q.is_one_off or q.plan is distinct from 'Advance on account' or q.invoice_id is not null
     or q.customer_id is distinct from 'cccccccc-0000-0000-0000-000000186301' then
    raise exception 'FAIL A: holder quote % % % %', q.amount, q.is_one_off, q.plan, q.invoice_id; end if;
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000186301';
  if t.matched_to_type is distinct from 'payment' or t.matched_to_id is distinct from p.id::text then
    raise exception 'FAIL A: line % %', t.matched_to_type, t.matched_to_id; end if;
  if not public.bank_advance_payment(p.id) then raise exception 'FAIL A: not recognised as an advance'; end if;
  select advances_from_customers, undeposited_funds into adv1, und1 from public.report_balance_sheet('2026-10-31');
  if adv1 - adv0 <> 10000 or und1 <> und0 then
    raise exception 'FAIL A: balance sheet advances % → % (want +10000), undeposited % → %', adv0, adv1, und0, und1; end if;
  if exists (select 1 from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000186301') o where o.quote_id = p.quote_id) then
    raise exception 'FAIL A: the holder quote is offered as an open item'; end if;
  if exists (select 1 from public.bank_old_one_off_bookings('bbbbbbbb-0000-0000-0000-000000186301') o where o.txn_id = t.id) then
    raise exception 'FAIL A: an advance listed as an old one-off booking'; end if;
  raise notice 'PASS A: advance ₹10,000 → receipt %, open credit ₹10,000, line reconciled, BS advances +10,000', p.receipt_voucher_no;
end $$;

-- B. The credit pays the next quote through Record payment (apply credit)
do $$
declare r jsonb; n int;
begin
  r := public.record_desk_payment('Q-R1863-USE', 2000, 'cash', 'CASH-R1863', null,
         'cccccccc-0000-0000-0000-000000186301', 3900);
  if (r->>'is_fully_paid')::boolean is not true then raise exception 'FAIL B: Q-R1863-USE not paid: %', r; end if;
  if (select credit_applied from public.payments where id = (r->>'payment_id')::uuid) is distinct from 3900 then
    raise exception 'FAIL B: credit_applied % (want 3900)', (select credit_applied from public.payments where id = (r->>'payment_id')::uuid); end if;
  select coalesce(sum(amount), 0) into n from public.customer_credits
   where customer_id = 'cccccccc-0000-0000-0000-000000186301' and status = 'open';
  if n <> 6100 then raise exception 'FAIL B: open credit % (want 6100)', n; end if;
  raise notice 'PASS B: ₹3,900 of the advance paid Q-R1863-USE through Record payment; ₹6,100 still open';
end $$;

-- C. Un-reconcile refused once credit is used
do $$
declare ok boolean := false; v_pay text;
begin
  select matched_to_id into v_pay from public.bank_transactions where id = '11111111-0000-0000-0000-000000186301';
  begin perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000186301', false);
  exception when check_violation then ok := sqlerrm like '%already used or refunded%' and sqlerrm like '%then un-reconcile%'; end;
  if not ok then raise exception 'FAIL C: un-reconcile of a used advance was not refused'; end if;
  if (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000186301') is distinct from v_pay
     or not exists (select 1 from public.payments where id = v_pay::uuid) then
    raise exception 'FAIL C: something changed'; end if;
  raise notice 'PASS C: used advance — un-reconcile refused, nothing changed';
end $$;

-- D. Un-reconcile an unused advance
do $$
declare r jsonb; u jsonb; v_pay uuid; v_q text; v_vno text;
begin
  r := public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000186302', 'cccccccc-0000-0000-0000-000000186301');
  v_pay := (r->>'payment_id')::uuid; v_q := r->>'quote_id'; v_vno := r->>'receipt_voucher_no';
  u := public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000186302', false);
  if (u->>'advance_removed')::int is distinct from 6000 then raise exception 'FAIL D: result %', u; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000186302') is not null then
    raise exception 'FAIL D: line still matched'; end if;
  if exists (select 1 from public.payments where id = v_pay) then raise exception 'FAIL D: receipt still there'; end if;
  if exists (select 1 from public.customer_credits where source_payment_id = v_pay) then raise exception 'FAIL D: credit still there'; end if;
  if not exists (select 1 from public.cancelled_vouchers where doc_no = v_vno and payment_id = v_pay) then
    raise exception 'FAIL D: voucher % not kept as cancelled', v_vno; end if;
  if (select status from public.quotes where id = v_q) is distinct from 'rejected' then raise exception 'FAIL D: holder quote not rejected'; end if;
  /* and it books again */
  r := public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000186302', 'cccccccc-0000-0000-0000-000000186301');
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000186302') is distinct from 'payment' then
    raise exception 'FAIL D: could not book again'; end if;
  raise notice 'PASS D: unused advance un-reconciled — receipt gone (voucher % cancelled), credit gone, books again', v_vno;
end $$;

-- E. Guards (owner)
do $$
declare ok boolean;
begin
  ok := false;
  begin perform public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000186301', 'cccccccc-0000-0000-0000-000000186301');
  exception when check_violation then ok := sqlerrm like '%already reconciled%'; end;
  if not ok then raise exception 'FAIL E: an already-reconciled line was not refused'; end if;

  ok := false;
  begin perform public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000186303', 'cccccccc-0000-0000-0000-000000186301');
  exception when invalid_parameter_value then ok := sqlerrm like '%money-in%'; end;
  if not ok then raise exception 'FAIL E: a money-out line was not refused'; end if;

  ok := false;
  begin perform public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000186304', 'cccccccc-0000-0000-0000-000000186303');
  exception when insufficient_privilege then ok := sqlerrm like '%not in your company%'; end;
  if not ok then raise exception 'FAIL E: another company''s line was not refused'; end if;

  ok := false;
  begin perform public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000186308', 'cccccccc-0000-0000-0000-000000186303');
  exception when no_data_found then ok := sqlerrm like '%Customer not found%'; end;
  if not ok then raise exception 'FAIL E: another company''s customer was not refused'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000186308') is not null then
    raise exception 'FAIL E: line changed'; end if;
  raise notice 'PASS E(owner): reconciled / money-out / other-company line / other-company customer refused';
end $$;

-- F. Old one-off bookings list
do $$
declare n int; r record;
begin
  select count(*) into n from public.bank_old_one_off_bookings('bbbbbbbb-0000-0000-0000-000000186301');
  if n <> 3 then raise exception 'FAIL F: % old bookings (want 3)', n; end if;
  select * into r from public.bank_old_one_off_bookings('bbbbbbbb-0000-0000-0000-000000186301') o where o.txn_id = '11111111-0000-0000-0000-000000186305';
  if r.quote_id is distinct from 'Q-R1863-OLD1' or r.invoice_id is null or r.amount is distinct from 11800
     or r.customer_name is distinct from 'Beta 1863' or r.blocker is not null or r.receipt_voucher_no is null then
    raise exception 'FAIL F: row % % % % %', r.quote_id, r.invoice_id, r.amount, r.customer_name, r.blocker; end if;
  raise notice 'PASS F: 3 old one-off bookings listed (OLD1 → invoice %, no blocker)', r.invoice_id;
end $$;

-- H. Books locked over the old receipt → refused, nothing changed (lock up to 10 Oct; OLD2 is 5 Oct)
update public.tenants set books_locked_until = '2026-10-10' where id = 'dddddddd-0000-0000-0000-000000186301';
do $$
declare ok boolean := false; v_pay text; r record;
begin
  select * into r from public.bank_old_one_off_bookings('bbbbbbbb-0000-0000-0000-000000186301') o where o.txn_id = '11111111-0000-0000-0000-000000186306';
  if r.blocker is distinct from 'books_locked' then raise exception 'FAIL H: blocker % (want books_locked)', r.blocker; end if;
  select matched_to_id into v_pay from public.bank_transactions where id = '11111111-0000-0000-0000-000000186306';
  begin perform public.relink_bank_one_off_sale('11111111-0000-0000-0000-000000186306',
          '{"path":"advance","customer_id":"cccccccc-0000-0000-0000-000000186302"}'::jsonb);
  exception when check_violation then ok := sqlerrm like '%Books are locked up to 10 Oct 2026%' and sqlerrm like '%/accounting/close%'; end;
  if not ok then raise exception 'FAIL H: relink in a locked month was not refused'; end if;
  if (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000186306') is distinct from v_pay
     or not exists (select 1 from public.payments where id = v_pay::uuid)
     or exists (select 1 from public.credit_notes where invoice_id = r.invoice_id) then
    raise exception 'FAIL H: something changed'; end if;
  raise notice 'PASS H: books locked → relink refused with the unlock step, nothing changed';
end $$;
update public.tenants set books_locked_until = null where id = 'dddddddd-0000-0000-0000-000000186301';

-- G. Relink OLD1 onto Beta's renewal quote
do $$
declare r jsonb; v_old_pay uuid; v_old_inv text; v_vno text; s record; t record;
begin
  select matched_to_id::uuid into v_old_pay from public.bank_transactions where id = '11111111-0000-0000-0000-000000186305';
  select receipt_voucher_no into v_vno from public.payments where id = v_old_pay;
  select invoice_id into v_old_inv from public.quotes where id = 'Q-R1863-OLD1';
  r := public.relink_bank_one_off_sale('11111111-0000-0000-0000-000000186305',
         '{"path":"item","quote_id":"Q-R1863-REN"}'::jsonb);
  if r->>'kind' is distinct from 'renewal' or r->>'relinked_from_quote' is distinct from 'Q-R1863-OLD1'
     or r->>'old_invoice_credited' is distinct from v_old_inv or r->>'old_credit_note_id' is null then
    raise exception 'FAIL G: result %', r; end if;
  if (select coalesce(sum(amount), 0) from public.credit_notes where invoice_id = v_old_inv) <> 11800 then
    raise exception 'FAIL G: old invoice credit note total % (want 11800)', (select sum(amount) from public.credit_notes where invoice_id = v_old_inv); end if;
  if exists (select 1 from public.payments where id = v_old_pay) then raise exception 'FAIL G: old receipt still there'; end if;
  if not exists (select 1 from public.cancelled_vouchers where doc_no = v_vno and payment_id = v_old_pay) then
    raise exception 'FAIL G: old voucher % not kept as cancelled', v_vno; end if;
  if (select status from public.quotes where id = 'Q-R1863-OLD1') is distinct from 'rejected' then raise exception 'FAIL G: old quote not rejected'; end if;
  /* the customer was not left owing the old invoice, and got no credit from its note */
  if (select coalesce(net_payable, 0) - coalesce(paid_amount, 0) from public.invoices where id = v_old_inv) <> 0 then
    raise exception 'FAIL G: old invoice still due'; end if;
  if exists (select 1 from public.customer_credits where customer_id = 'cccccccc-0000-0000-0000-000000186302') then
    raise exception 'FAIL G: the reversal made customer credit'; end if;
  select * into s from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000186301';
  if s.renewal_date is distinct from '2027-11-01' then raise exception 'FAIL G: renewal date %', s.renewal_date; end if;
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000186305';
  if t.matched_to_type is distinct from 'payment' or t.matched_to_id is distinct from r->>'payment_id' then
    raise exception 'FAIL G: line % %', t.matched_to_type, t.matched_to_id; end if;
  if (select quote_id from public.payments where id = (r->>'payment_id')::uuid) is distinct from 'Q-R1863-REN' then
    raise exception 'FAIL G: new payment not on the renewal quote'; end if;
  if exists (select 1 from public.bank_old_one_off_bookings('bbbbbbbb-0000-0000-0000-000000186301') o where o.txn_id = t.id) then
    raise exception 'FAIL G: still listed as an old booking'; end if;
  raise notice 'PASS G: relink → credit note % on %, old receipt gone (voucher cancelled), renewal to 2027-11-01', r->>'old_credit_note_id', v_old_inv;
end $$;

-- I. Not an old booking → refused
do $$
declare ok boolean := false;
begin
  begin perform public.relink_bank_one_off_sale('11111111-0000-0000-0000-000000186301',
          '{"path":"advance","customer_id":"cccccccc-0000-0000-0000-000000186301"}'::jsonb);
  exception when check_violation then ok := sqlerrm like '%not an old one-off bank sale%'; end;
  if not ok then raise exception 'FAIL I: relink of a non-old line was not refused'; end if;
  raise notice 'PASS I(owner): relink of a line that is not an old one-off booking refused';
end $$;

-- J. Relink OLD3 onto an advance for Acme
do $$
declare r jsonb; v_old_inv text;
begin
  select invoice_id into v_old_inv from public.quotes where id = 'Q-R1863-OLD3';
  r := public.relink_bank_one_off_sale('11111111-0000-0000-0000-000000186307',
         '{"path":"advance","customer_id":"cccccccc-0000-0000-0000-000000186301"}'::jsonb);
  if r->>'kind' is distinct from 'advance' or (r->>'advance_credit')::int is distinct from 3540 or r->>'old_invoice_credited' is distinct from v_old_inv then
    raise exception 'FAIL J: %', r; end if;
  if not exists (select 1 from public.customer_credits where source_payment_id = (r->>'payment_id')::uuid and amount = 3540 and status = 'open') then
    raise exception 'FAIL J: no open credit of 3540'; end if;
  raise notice 'PASS J: relink onto an advance → ₹3,540 open credit, old invoice % credit-noted', v_old_inv;
end $$;

-- A billing login: may book an advance, may not take one back or relink (both remove a receipt).
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186304","role":"authenticated"}', true);
do $$
declare ok boolean;
begin
  ok := false;
  begin perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000186302', false);
  exception when insufficient_privilege then ok := sqlerrm like '%Only an owner or accountant can remove a receipt%'; end;
  if not ok then raise exception 'FAIL E: billing took an advance back'; end if;
  ok := false;
  begin perform public.relink_bank_one_off_sale('11111111-0000-0000-0000-000000186306',
          '{"path":"advance","customer_id":"cccccccc-0000-0000-0000-000000186302"}'::jsonb);
  exception when insufficient_privilege then ok := sqlerrm like '%only an owner or accountant%'; end;
  if not ok then raise exception 'FAIL I: billing relinked'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000186302') is distinct from 'payment' then
    raise exception 'FAIL E: billing changed the advance line'; end if;
  raise notice 'PASS E/I(billing): cannot take an advance back or relink';
end $$;

-- A sales login: refused by the money-role gate.
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186302","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000186308', 'cccccccc-0000-0000-0000-000000186301');
  exception when insufficient_privilege then ok := sqlerrm like '%reconcile a bank receipt%'; end;
  if not ok then raise exception 'FAIL E: sales role not refused'; end if;
  ok := false;
  begin perform public.bank_old_one_off_bookings('bbbbbbbb-0000-0000-0000-000000186301');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL E: sales role read old bookings'; end if;
  raise notice 'PASS E(sales): refused with 42501';
end $$;

-- A login with no company: fail closed (§17c).
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000186303","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000186304', 'cccccccc-0000-0000-0000-000000186303');
  exception when sqlstate '28000' then ok := sqlerrm like '%No company%'; end;
  if not ok then raise exception 'FAIL E: no-company login not refused'; end if;
  ok := false;
  begin perform public.relink_bank_one_off_sale('11111111-0000-0000-0000-000000186306', '{"path":"advance"}'::jsonb);
  exception when sqlstate '28000' then ok := true; end;
  if not ok then raise exception 'FAIL E: no-company login relink not refused'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000186304') is not null then
    raise exception 'FAIL E: other company''s line changed'; end if;
  raise notice 'PASS E(no company): refused with 28000, nothing written';
end $$;

rollback;
