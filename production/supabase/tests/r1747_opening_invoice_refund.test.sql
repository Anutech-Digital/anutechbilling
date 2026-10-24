-- R-1747 — refunding a payment on an invoice imported from Zoho Books (R-1739).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1747_opening_invoice_refund.test.sql
--
-- The owner's example (card R-1747): Zoho INV-000245 for T-ABC Pvt Ltd, Total ₹59,000, Balance
-- ₹20,000. A ₹15,000 payment is recorded on it (₹5,000 left), then refunded.
--
-- The rule (one place: refund_payment): an imported invoice cannot take a credit note here (its
-- GST was filed in Zoho Books — R-1739 trigger), so the refund is a PLAIN refund: RFV voucher,
-- payment marked refunded, and the invoice's balance opens again (₹20,000 due). No credit note,
-- no customer credit, no quote. Fail-closed: if the invoice did not reopen by exactly the
-- payment, nothing is refunded.
--
-- What it proves:
--   1. ₹15,000 refunded → RFV issued, payment refunded, invoice paid ₹39,000 / ₹20,000 due again,
--      result says opening_invoice + the invoice id/number and the balance due after.
--   2. No credit note, no debit note, no customer credit came out of it.
--   3. The partial "refund the credit-note credit" route refuses it (no credit note exists here).
--   4. Fail-closed: with the invoice's settle trigger switched off (the invoice would not reopen),
--      the refund is refused and the payment stays received.
--   5. A sales user cannot refund it (role rule unchanged).

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1747000-0000-0000-0000-0000000000a1'::uuid, 'T-R1747 A', 'r1747-a@example.in', '07', 'TYA');
insert into auth.users (id, email) values
  ('c1747000-0000-0000-0000-00000000a0a1', 'r1747-owner-a@example.test'),
  ('c1747000-0000-0000-0000-00000000a0a3', 'r1747-sales-a@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1747000-0000-0000-0000-00000000a0a1', 'c1747000-0000-0000-0000-0000000000a1', 'r1747-owner-a@example.in', 'owner', 'Owner A'),
  ('c1747000-0000-0000-0000-00000000a0a3', 'c1747000-0000-0000-0000-0000000000a1', 'r1747-sales-a@example.in', 'sales', 'Sales A');
insert into public.customers (id, tenant_id, name, gstin, state_code) values
  ('c1747000-0000-0000-0000-0000000c0001', 'c1747000-0000-0000-0000-0000000000a1', 'T-ABC Pvt Ltd', '07AAACT1234A1Z3', '07');

create temp table r1747_ids (k text primary key, v text);
grant all on r1747_ids to authenticated;

set local role authenticated;

-- ── Fixture: import INV-000245, record ₹15,000 and a second ₹1,000 on it ──────────────
do $$
declare v jsonb; v_id text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1747000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  perform public.import_opening_invoices(
    '[{"number":"INV-000245","invoice_date":"2026-08-16","due_date":"2026-09-15","customer_id":"c1747000-0000-0000-0000-0000000c0001",
       "total":59000,"balance":20000,"gstin":"07AAACT1234A1Z3","pos_state_code":"07"}]'::jsonb,
    'Invoice.csv');
  select i.id into v_id from public.invoices i
   where i.tenant_id = 'c1747000-0000-0000-0000-0000000000a1' and i.external_number = 'INV-000245';
  if v_id is null then raise exception 'FAIL 0: INV-000245 was not imported'; end if;
  insert into r1747_ids values ('inv', v_id);

  v := public.record_multi_invoice_payment(
    'c1747000-0000-0000-0000-0000000c0001', '2026-10-21', 'bank_transfer', null, 'T-UTR-1747-01', 15000,
    jsonb_build_array(jsonb_build_object('invoice_id', v_id, 'amount', 15000)), false, null);
  insert into r1747_ids values ('pay', v->'lines'->0->>'payment_id');
  v := public.record_multi_invoice_payment(
    'c1747000-0000-0000-0000-0000000c0001', '2026-10-21', 'upi', null, 'T-UTR-1747-02', 1000,
    jsonb_build_array(jsonb_build_object('invoice_id', v_id, 'amount', 1000)), false, null);
  insert into r1747_ids values ('pay2', v->'lines'->0->>'payment_id');
  if (select paid_amount from public.invoices where id = v_id) <> 55000 then
    raise exception 'FAIL 0b: after ₹16,000 the invoice is paid % (want 55000)', (select paid_amount from public.invoices where id = v_id);
  end if;
end $$;

-- ── 5. A sales user cannot refund it ─────────────────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1747000-0000-0000-0000-00000000a0a3', 'role', 'authenticated')::text, true);
  begin
    perform public.refund_payment((select v from r1747_ids where k = 'pay')::uuid, 'Customer paid twice');
    raise exception 'FAIL 5: a sales user refunded a payment';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS 5: sales user refused';
end $$;

-- ── 4. Fail-closed: the invoice does not reopen → nothing is refunded ─────────────────
reset role;
alter table public.payments disable trigger trg_payments_opening_invoice_settle;
set local role authenticated;
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1747000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  begin
    perform public.refund_payment((select v from r1747_ids where k = 'pay2')::uuid, 'Customer paid twice');
    raise exception 'FAIL 4a: refund went through although invoice % did not reopen', (select v from r1747_ids where k = 'inv');
  exception when others then
    if sqlerrm not like '%nothing was refunded%' then raise; end if;
  end;
  if (select status::text from public.payments where id = (select v from r1747_ids where k = 'pay2')::uuid) <> 'received' then
    raise exception 'FAIL 4b: the payment changed although the refund was refused';
  end if;
  raise notice 'PASS 4: invoice not reopened → refund refused, payment still received';
end $$;
reset role;
alter table public.payments enable trigger trg_payments_opening_invoice_settle;
set local role authenticated;

-- ── 1–2. The owner's ₹15,000 refund: plain refund, the balance opens again ───────────
do $$
declare
  v       jsonb;
  v_inv   record;
  v_pay   record;
  v_id    text := (select t.v from r1747_ids t where k = 'inv');
  v_pid   uuid := (select t.v from r1747_ids t where k = 'pay')::uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1747000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.refund_payment(v_pid, 'Customer paid twice');

  select * into v_pay from public.payments where id = v_pid;
  if v_pay.status::text <> 'refunded' or v_pay.refund_voucher_no is null or v_pay.refund_voucher_no not like 'RFV-%' then
    raise exception 'FAIL 1a: payment is % / voucher % (want refunded with an RFV)', v_pay.status, v_pay.refund_voucher_no;
  end if;
  select * into v_inv from public.invoices where id = v_id;
  if v_inv.paid_amount <> 40000 or v_inv.status::text = 'paid' then
    raise exception 'FAIL 1b: invoice is paid % / % (want 40000 — ₹19,000 due again)', v_inv.paid_amount, v_inv.status;
  end if;
  if coalesce((v->>'opening_invoice')::boolean, false) is not true
     or v->>'invoice_id' is distinct from v_id
     or v->>'invoice_number' is distinct from 'INV-000245'
     or (v->>'invoice_due_after')::int is distinct from 19000
     or (v->>'amount')::int <> 15000
     or v->>'quote_id' is not null
     or v->>'new_payment_status' is not null then
    raise exception 'FAIL 1c: refund result % (want opening_invoice true, invoice %, number INV-000245, due after 19000, no quote status)', v, v_id;
  end if;

  if exists (select 1 from public.credit_notes where invoice_id = v_id)
     or exists (select 1 from public.debit_notes where invoice_id = v_id) then
    raise exception 'FAIL 2a: a credit / debit note was made on imported invoice %', v_id;
  end if;
  if exists (select 1 from public.customer_credits
              where tenant_id = 'c1747000-0000-0000-0000-0000000000a1'
                and (source_payment_id = v_pid or source_invoice_id = v_id)) then
    raise exception 'FAIL 2b: the refund made customer credit';
  end if;
  raise notice 'PASS 1-2: ₹15,000 refunded as %, INV-000245 has ₹19,000 due again, no credit note / credit', v_pay.refund_voucher_no;
end $$;

-- ── 3. The partial credit-note route refuses it ──────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1747000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  begin
    perform public.refund_credit_note_credit((select v from r1747_ids where k = 'pay2')::uuid, 500, 'Part refund test');
    raise exception 'FAIL 3: refund_credit_note_credit refunded part of a payment on an imported invoice';
  exception when others then
    if sqlerrm like 'FAIL 3%' then raise; end if;
  end;
  if (select status::text from public.payments where id = (select v from r1747_ids where k = 'pay2')::uuid) <> 'received' then
    raise exception 'FAIL 3b: the second payment changed';
  end if;
  raise notice 'PASS 3: no partial credit-note refund on an imported invoice';
end $$;

rollback;
