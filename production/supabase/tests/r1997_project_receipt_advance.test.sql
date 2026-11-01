-- R-1997 (1 Nov 2026, G-RECON) — project receipt: money beyond the instalments becomes the
-- customer's ADVANCE (Pardeep's decision D1, 26 Oct: extra / early money = the customer's advance
-- credit, a liability in the books — like Zoho — applied later in one click).
-- Source: R-1910 audit case 4 (drafts/R-1910/c4_extra_amount.sql): ₹1,50,000 received against a
-- ₹1,18,000 instalment — the ₹32,000 extra went nowhere (refused, or all put on kist 1).
--
-- Owner's path: Banking → ₹1,50,000 money-in line → Reconcile → Project payment → the project's
-- open instalments ticked oldest first (R-1998 FIFO) → Save (allocate_project_receipt[_with_tds]).
--
--   1. FIFO first: a 2-kist project — ₹1,18,000 on kist 1 + ₹32,000 on kist 2, NO advance.
--   2. c4: nothing more is due (one kist of ₹1,18,000) → kist 1 Paid, its invoice Paid
--      ₹1,18,000; the ₹32,000 rest is ONE receipt (R-1863's: ₹0 "Advance on account" holder
--      quote + receipt voucher, payments.bank_txn_id = the line) + ONE open customer credit
--      (source 'overpayment') of ₹32,000. Balance Sheet: bank +₹1,50,000, Undeposited funds
--      unchanged (the receipt came in on the line — not counted twice), Advances from customers
--      +₹32,000.
--   3. The advance pays the customer's next quote through the existing Record payment →
--      "Use advance" path (record_desk_payment → redeem_customer_credits).
--   4. Un-reconcile while part of the advance is used → refused (R-1863's rule), nothing changed;
--      the Undo preview says the same.
--   5. Un-reconcile of an unused advance: kist payment AND advance receipt + credit go (voucher kept
--      as cancelled), holder quote rejected, line free, books back to before.
--   6. With TDS: ₹1,50,000 in the bank + ₹11,800 TDS on a ₹1,18,000 kist → ₹43,800 advance. A TDS
--      more than its rate on the instalments (a typo) is refused when money would be left over.
-- Fails before 20261101131404_r1997_project_receipt_advance (case 2 is refused "not on any instalment").
begin;

create function pg_temp.r1997_fill_supplier() returns trigger language plpgsql as $r$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, Delhi');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $r$;
create trigger zz_r1997_supplier before insert on public.tenants
  for each row execute function pg_temp.r1997_fill_supplier();

insert into public.tenants (id, name, email, state_code) values
  ('f1997000-0000-4000-8000-000000000001', 'R1997 TEST CO', 'r1997@test.invalid', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('f1997000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1997-owner@test.invalid');
insert into public.users (id, tenant_id, email, role) values
  ('f1997000-0000-4000-8000-0000000000a1', 'f1997000-0000-4000-8000-000000000001', 'r1997-owner@test.invalid', 'owner');
insert into public.customers (id, tenant_id, name, state_code) values
  ('f1997000-0000-4000-8000-0000000000c1', 'f1997000-0000-4000-8000-000000000001', 'R1997 Demo Client', '07');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('f1997000-0000-4000-8000-0000000000b1', 'f1997000-0000-4000-8000-000000000001', 'R1997 HDFC', 'HDFC', 0, '2026-04-01');
-- the customer's next sale, to use the advance on (case 3)
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
values ('Q-R1997-USE', 'f1997000-0000-4000-8000-000000000001', 'f1997000-0000-4000-8000-0000000000c1', 'R1997 Demo Client',
        11800, 10000, 0, 18, 'accepted', 'awaiting', 'yearly',
        '[{"name":"Support hours","qty":1,"rate":10000,"one_time":true}]'::jsonb, true, '2026-10-21');

create function pg_temp.as_user(p_user text) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$f$;
select pg_temp.as_user('f1997000-0000-4000-8000-0000000000a1');

create temp table ids (k text primary key, v text);

create function pg_temp.txn(p_amount int, p_date date, p_desc text) returns uuid language sql as $f$
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source)
  values ('f1997000-0000-4000-8000-000000000001', 'f1997000-0000-4000-8000-0000000000b1', p_date, p_desc,
          'UTR' || substr(md5(p_desc || p_amount), 1, 10), 0, p_amount, 'manual')
  returning id;
$f$;

-- A project sold the normal way (quotation → accepted), 18% GST, GST-inclusive milestones.
create function pg_temp.project(p_title text, p_ms int[]) returns uuid language plpgsql as $f$
declare v_pid uuid; v_ms jsonb := '[]'; v_total int := 0; i int;
begin
  for i in 1 .. array_length(p_ms, 1) loop
    v_ms := v_ms || jsonb_build_array(jsonb_build_object('label', 'Kist ' || i, 'total_amount', p_ms[i],
                                                         'due_date', (date '2026-10-01' + (i - 1) * 30)));
    v_total := v_total + p_ms[i];
  end loop;
  v_pid := public.create_project_quote('f1997000-0000-4000-8000-0000000000c1', 'R1997 Demo Client',
             p_title, null, jsonb_build_array(jsonb_build_object('name', p_title, 'qty', 1,
             'rate', round(v_total * 100.0 / 118), 'amount', round(v_total * 100.0 / 118))),
             18, false, v_ms);
  perform public.accept_project_quote(v_pid);
  return v_pid;
end $f$;

create function pg_temp.ms(p_project uuid, p_seq int) returns uuid language sql as $f$
  select id from public.project_milestones where project_id = p_project and seq = p_seq;
$f$;
create function pg_temp.ms_paid(p_ms uuid) returns int language sql as $f$
  select coalesce(sum(amount), 0)::int from public.project_payments where milestone_id = p_ms;
$f$;
create function pg_temp.alloc(variadic p jsonb[]) returns jsonb language sql as $f$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from unnest(p) x;
$f$;
create function pg_temp.a(p_ms uuid, p_amount int, p_invoice boolean default true) returns jsonb language sql as $f$
  select jsonb_build_object('milestone_id', p_ms, 'amount', p_amount, 'raise_invoice', p_invoice);
$f$;
create function pg_temp.tds(p_amount numeric, p_rate numeric default 10, p_section text default '194J') returns jsonb language sql as $f$
  select jsonb_build_object('section', p_section, 'rate_pct', p_rate, 'amount', p_amount);
$f$;
create function pg_temp.open_credit() returns int language sql as $f$
  select coalesce(sum(amount), 0)::int from public.customer_credits
   where customer_id = 'f1997000-0000-4000-8000-0000000000c1' and status = 'open';
$f$;

create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $f$
begin
  if not coalesce(p_ok, false) then raise exception 'R-1997 FAIL: %', p_msg; end if;
  raise notice 'ok  : %', p_msg;
end $f$;

create temp table snap (k text primary key, cash bigint, undeposited bigint, project_receivable bigint, tds bigint, advances bigint);
create function pg_temp.snap(p_k text) returns void language sql as $f$
  insert into snap
  select p_k, b.cash_and_bank, b.undeposited_funds, b.project_receivable, b.tds_receivable, b.advances_from_customers
    from public.report_balance_sheet(public.ist_today()) b
  on conflict (k) do update set cash = excluded.cash, undeposited = excluded.undeposited,
    project_receivable = excluded.project_receivable, tds = excluded.tds, advances = excluded.advances;
$f$;
create function pg_temp.d(p_k text, p_what text) returns bigint language plpgsql as $f$
declare b record; s record;
begin
  select * into b from public.report_balance_sheet(public.ist_today());
  select * into s from snap where k = p_k;
  return case p_what
    when 'cash' then b.cash_and_bank - s.cash
    when 'undeposited' then b.undeposited_funds - s.undeposited
    when 'project' then b.project_receivable - s.project_receivable
    when 'tds' then b.tds_receivable - s.tds
    when 'advances' then b.advances_from_customers - s.advances end;
end $f$;

-- ── 1. FIFO first: the next kist takes the extra, no advance ───────────────────────────────
do $$
declare v_p uuid; v_m1 uuid; v_m2 uuid; v_t uuid; r jsonb;
begin
  v_p  := pg_temp.project('R1997 FIFO CRM', array[118000, 118000]);
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2);
  v_t  := pg_temp.txn(150000, date '2026-10-10', 'IMPS-R1997 FIFO-150000');
  r := public.allocate_project_receipt(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m1, 118000), pg_temp.a(v_m2, 32000, false)));
  perform pg_temp.check(pg_temp.ms_paid(v_m1) = 118000 and pg_temp.ms_paid(v_m2) = 32000,
    format('FIFO: kist 1 ₹1,18,000 + kist 2 ₹32,000 (got %s + %s)', pg_temp.ms_paid(v_m1), pg_temp.ms_paid(v_m2)));
  perform pg_temp.check(coalesce((r->>'advance')::int, 0) = 0 and pg_temp.open_credit() = 0,
    format('FIFO: no advance when the next kist takes the money (advance %s, open credit %s)', r->>'advance', pg_temp.open_credit()));
end $$;

-- ── 2. c4: more than everything due → the rest is the customer's advance ──────────────────
select pg_temp.snap('c4');
do $$
declare v_p uuid; v_m1 uuid; v_t uuid; r jsonb; v_pay record; v_q record; v_cr record; i record;
begin
  v_p  := pg_temp.project('R1997 C4 CRM', array[118000]);
  v_m1 := pg_temp.ms(v_p, 1);
  v_t  := pg_temp.txn(150000, date '2026-10-12', 'IMPS-R1997 DEMO CLIENT-150000');
  insert into ids values ('c4_line', v_t::text), ('c4_ms', v_m1::text), ('c4_p', v_p::text);

  r := public.allocate_project_receipt(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m1, 118000)));

  perform pg_temp.check(pg_temp.ms_paid(v_m1) = 118000, format('c4: kist 1 ₹1,18,000 paid, not over-paid (got %s)', pg_temp.ms_paid(v_m1)));
  select * into i from public.invoices where id = (select invoice_id from public.project_milestones where id = v_m1);
  perform pg_temp.check(i.amount = 118000 and i.paid_amount = 118000 and i.status::text = 'paid',
    format('c4: kist 1 invoice ₹1,18,000 Paid (got %s / %s %s)', i.amount, i.paid_amount, i.status));
  perform pg_temp.check((r->>'advance')::int = 32000 and r->>'advance_credit_id' is not null,
    format('c4: the Save says ₹32,000 kept as advance (%s)', r));

  select * into v_pay from public.payments where id = (r->>'advance_payment_id')::uuid;
  perform pg_temp.check(v_pay.amount = 32000 and v_pay.bank_txn_id = v_t and v_pay.receipt_voucher_no is not null
                        and v_pay.customer_id = 'f1997000-0000-4000-8000-0000000000c1' and v_pay.status::text = 'received',
    format('c4: one ₹32,000 receipt (voucher %s) on the bank line for the customer', v_pay.receipt_voucher_no));
  perform pg_temp.check(public.bank_advance_payment(v_pay.id), 'c4: it is an R-1863 advance (₹0 "Advance on account" holder)');
  select * into v_q from public.quotes where id = v_pay.quote_id;
  perform pg_temp.check(public.is_customer_advance_quote(v_q.plan, v_q.amount, v_q.invoice_id, v_q.line_items),
    'c4: the holder quote is an advance, nothing to invoice (R-2023)');
  select * into v_cr from public.customer_credits where source_payment_id = v_pay.id;
  perform pg_temp.check(v_cr.amount = 32000 and v_cr.status = 'open' and v_cr.source = 'overpayment',
    format('c4: one open ₹32,000 customer credit, source overpayment (got %s %s %s)', v_cr.amount, v_cr.status, v_cr.source));
  perform pg_temp.check(pg_temp.open_credit() = 32000, format('c4: customer''s open advance ₹32,000 (got %s)', pg_temp.open_credit()));
  perform pg_temp.check((select matched_to_type from public.bank_transactions where id = v_t) = 'project',
    'c4: the line is reconciled once (project)');

  perform pg_temp.check(pg_temp.d('c4', 'cash') = 150000, format('c4 BS: bank +₹1,50,000 (got %s)', pg_temp.d('c4', 'cash')));
  perform pg_temp.check(pg_temp.d('c4', 'undeposited') = 0,
    format('c4 BS: Undeposited funds unchanged — the advance came in on the line (got %s)', pg_temp.d('c4', 'undeposited')));
  perform pg_temp.check(pg_temp.d('c4', 'advances') = 32000,
    format('c4 BS: Advances from customers +₹32,000 (got %s)', pg_temp.d('c4', 'advances')));
  perform pg_temp.check(pg_temp.d('c4', 'project') = 0, format('c4 BS: project receivable unchanged (got %s)', pg_temp.d('c4', 'project')));
end $$;

-- ── 3. the advance pays the next quote (Record payment → Use advance) ─────────────────────
do $$
declare r jsonb;
begin
  r := public.record_desk_payment('Q-R1997-USE', 0, 'bank_transfer', 'ADV-R1997', null,
         'f1997000-0000-4000-8000-0000000000c1', 11800);
  perform pg_temp.check((r->>'is_fully_paid')::boolean, format('use: Q-R1997-USE paid from the advance (%s)', r));
  perform pg_temp.check(pg_temp.open_credit() = 20200, format('use: ₹20,200 advance still open (got %s)', pg_temp.open_credit()));
  insert into ids values ('use_pay', r->>'payment_id');
end $$;

-- ── 4. un-reconcile refused while the advance is used ─────────────────────────────────────
do $$
declare ok boolean := false; v_t uuid := (select v::uuid from ids where k = 'c4_line'); pv jsonb;
begin
  pv := public.project_receipt_undo_preview(v_t);
  perform pg_temp.check((pv->>'blocked')::boolean and pv->>'block_message' like '%already used or refunded%',
    format('used: the Undo preview says it is blocked (%s)', pv->>'block_message'));
  begin
    perform public.unreconcile_bank_receipt(v_t, false);
  exception when check_violation then ok := sqlerrm like '%already used or refunded%';
  end;
  perform pg_temp.check(ok, 'used: un-reconcile refused while ₹11,800 of the advance is used');
  perform pg_temp.check((select matched_to_type from public.bank_transactions where id = v_t) = 'project'
                        and pg_temp.ms_paid((select v::uuid from ids where k = 'c4_ms')) = 118000
                        and pg_temp.open_credit() = 20200,
    'used: nothing changed (line, kist payment, credit)');
  -- undo the use (delete that payment — the credit opens again), as the message says
  perform public.delete_payment((select v::uuid from ids where k = 'use_pay'));
  perform pg_temp.check(pg_temp.open_credit() = 32000, format('used: deleting the payment that used it re-opens ₹32,000 (got %s)', pg_temp.open_credit()));
end $$;

-- ── 5. un-reconcile of an unused advance takes it back with the kist payment ──────────────
do $$
declare v_t uuid := (select v::uuid from ids where k = 'c4_line'); v_pay record; u jsonb;
begin
  select p.* into v_pay from public.payments p where p.bank_txn_id = v_t;
  u := public.unreconcile_bank_receipt(v_t, false);
  perform pg_temp.check((u->>'advance_removed')::int = 32000, format('undo: result names the ₹32,000 advance (%s)', u));
  perform pg_temp.check((select matched_to_type from public.bank_transactions where id = v_t) is null, 'undo: line free');
  perform pg_temp.check(pg_temp.ms_paid((select v::uuid from ids where k = 'c4_ms')) = 0, 'undo: kist payment gone');
  perform pg_temp.check(not exists (select 1 from public.payments where id = v_pay.id), 'undo: advance receipt gone');
  perform pg_temp.check(not exists (select 1 from public.customer_credits where source_payment_id = v_pay.id) and pg_temp.open_credit() = 0,
    'undo: advance credit gone');
  perform pg_temp.check(exists (select 1 from public.cancelled_vouchers where doc_no = v_pay.receipt_voucher_no and payment_id = v_pay.id),
    'undo: its receipt voucher kept as cancelled (series unbroken)');
  perform pg_temp.check((select status::text from public.quotes where id = v_pay.quote_id) = 'rejected', 'undo: holder quote rejected');
  perform pg_temp.check(pg_temp.d('c4', 'advances') = 0 and pg_temp.d('c4', 'undeposited') = 0,
    format('undo BS: advances %s, undeposited %s — back to before', pg_temp.d('c4', 'advances'), pg_temp.d('c4', 'undeposited')));
  -- and it books again
  perform public.allocate_project_receipt(v_t, (select v::uuid from ids where k = 'c4_p'),
            pg_temp.alloc(pg_temp.a((select v::uuid from ids where k = 'c4_ms'), 118000)));
  perform pg_temp.check(pg_temp.open_credit() = 32000 and pg_temp.d('c4', 'advances') = 32000, 'undo: the line books again with its advance');
end $$;

-- ── 6. with TDS ───────────────────────────────────────────────────────────────────────────
select pg_temp.snap('t6');
do $$
declare v_p uuid; v_m uuid; v_t uuid; v_t2 uuid; r jsonb; ok boolean := false;
begin
  v_p := pg_temp.project('R1997 TDS CRM', array[118000]);
  v_m := pg_temp.ms(v_p, 1);
  v_t := pg_temp.txn(150000, date '2026-10-14', 'IMPS-R1997 TDS-150000');
  v_t2 := pg_temp.txn(150000, date '2026-10-15', 'IMPS-R1997 TDS TYPO-150000');

  -- a TDS typo (₹30,000 on a ₹1,18,000 kist at 10%) with money left over → refused, nothing written
  begin
    perform public.allocate_project_receipt_with_tds(v_t2, v_p, pg_temp.alloc(pg_temp.a(v_m, 118000)), pg_temp.tds(30000));
  exception when check_violation then ok := sqlerrm like '%TDS%';
  end;
  perform pg_temp.check(ok, 'tds: ₹30,000 TDS on a ₹1,18,000 kist at 10% refused when money is left over');
  perform pg_temp.check(pg_temp.ms_paid(v_m) = 0 and (select matched_to_type from public.bank_transactions where id = v_t2) is null,
    'tds: refusal wrote nothing');

  r := public.allocate_project_receipt_with_tds(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m, 118000)), pg_temp.tds(11800));
  perform pg_temp.check(pg_temp.ms_paid(v_m) = 118000, format('tds: kist settled ₹1,18,000 (bank ₹1,06,200 + TDS ₹11,800) (got %s)', pg_temp.ms_paid(v_m)));
  perform pg_temp.check((r->>'advance')::int = 43800, format('tds: ₹43,800 of the bank money kept as advance (%s)', r->>'advance'));
  perform pg_temp.check(pg_temp.d('t6', 'cash') = 300000 and pg_temp.d('t6', 'undeposited') = 0
                        and pg_temp.d('t6', 'advances') = 43800 and pg_temp.d('t6', 'tds') = 11800,
    format('tds BS: bank +300000 — both lines (%s), undeposited 0 (%s), advances +43800 (%s), TDS receivable +11800 (%s)',
           pg_temp.d('t6', 'cash'), pg_temp.d('t6', 'undeposited'), pg_temp.d('t6', 'advances'), pg_temp.d('t6', 'tds')));
end $$;

rollback;
