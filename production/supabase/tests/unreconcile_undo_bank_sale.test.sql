-- Regression test: unreconcile_bank_receipt (migration 20260925210000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/unreconcile_undo_bank_sale.test.sql
--
-- What it proves:
--   1. Undo-sale on a line booked via "Invoice banao & reconcile" frees the line, reverses
--      the ISSUED invoice with a full credit note (migration 20260927140000 — it is not
--      voided: number in the series, may be in a filed GSTR-1), leaves nothing due on it,
--      deletes the receipt and resets the quote.
--   2. Without undo-sale it only frees the line; invoice and receipt stay.
--   3. A receipt recorded separately (not from the bank line) is refused, nothing changes.
--   4. An invoice with a credit note is refused, nothing changes.
--   5. Another company's user cannot touch the line.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a4', 'UNREC TEST A', 'ur-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000b4', 'UNREC TEST B', 'ur-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ur-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ur-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a4', 'aaaaaaaa-0000-0000-0000-0000000000a4', 'ur-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b4', 'bbbbbbbb-0000-0000-0000-0000000000b4', 'ur-b-user@example.in', 'owner');
insert into public.customers (id, tenant_id, name, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000c0004', 'aaaaaaaa-0000-0000-0000-0000000000a4', 'Demo Co', '07');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000ba004', 'aaaaaaaa-0000-0000-0000-0000000000a4', 'Test HDFC', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-0000000b7001', 'aaaaaaaa-0000-0000-0000-0000000000a4', 'aaaaaaaa-0000-0000-0000-0000000ba004', '2026-08-07', 'TPT-PO 00038', 0, 11800, 'manual'),
  ('aaaaaaaa-0000-0000-0000-0000000b7002', 'aaaaaaaa-0000-0000-0000-0000000000a4', 'aaaaaaaa-0000-0000-0000-0000000ba004', '2026-08-08', 'TPT-OTHER', 0, 11800, 'manual');

create temp table s (k text primary key, v text);
grant all on s to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a4', 'role', 'authenticated')::text, true);

-- Book a line the way "Invoice banao & reconcile" does (lib/queries/bank.ts useBookCreditAsInvoice).
create function pg_temp.book_sale(p_txn uuid, p_notes text) returns void language plpgsql as $$
declare inv record; pay jsonb; begin
  select * into inv from public.create_direct_invoice('aaaaaaaa-0000-0000-0000-0000000c0004',
    '[{"id":"line-1","name":"ERP","qty":1,"rate":10000,"cost":0}]'::jsonb, 'Raised from a bank receipt (reconcile)', false);
  select to_jsonb(r) into pay from public.record_payment(inv.quote_id, inv.net_payable, 'bank_transfer', 'BANK-' || p_txn, p_notes) r;
  update public.bank_transactions set matched_to_type = 'payment', matched_to_id = pay->>'payment_id' where id = p_txn;
  insert into s values ('inv:' || p_txn, inv.invoice_id), ('q:' || p_txn, inv.quote_id), ('pay:' || p_txn, pay->>'payment_id')
    on conflict (k) do update set v = excluded.v;
end $$;

select pg_temp.book_sale('aaaaaaaa-0000-0000-0000-0000000b7001', 'Reconciled from bank receipt');

-- 5. another company cannot touch it
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000b0b4', 'role', 'authenticated')::text, true);
do $$ begin
  perform public.unreconcile_bank_receipt('aaaaaaaa-0000-0000-0000-0000000b7001', true);
  raise exception 'FAIL: cross-tenant undo accepted';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a4', 'role', 'authenticated')::text, true);

-- 4. invoice with a credit note → refused, nothing changes
-- Fixture row written as the table owner: since R-719 nobody inserts a credit note directly
-- through PostgREST (only issue_credit_note numbers one), so the test cannot either.
reset role;
insert into public.credit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount, tax_rate, credit_date)
  select 'CN-TEST-UR-1', 'aaaaaaaa-0000-0000-0000-0000000000a4', v, 118, 100, 18, 18, '2026-08-10' from s where k = 'inv:aaaaaaaa-0000-0000-0000-0000000b7001';
set local role authenticated;
do $$ begin
  perform public.unreconcile_bank_receipt('aaaaaaaa-0000-0000-0000-0000000b7001', true);
  raise exception 'FAIL: invoice with credit note undone';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;
do $$ begin
  if (select matched_to_type from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b7001') is distinct from 'payment' then
    raise exception 'FAIL: refused call still freed the line'; end if;
end $$;
delete from public.credit_notes where invoice_id = (select v from s where k = 'inv:aaaaaaaa-0000-0000-0000-0000000b7001');

-- 1. undo sale
select public.unreconcile_bank_receipt('aaaaaaaa-0000-0000-0000-0000000b7001', true);
do $$ declare inv text := (select v from s where k = 'inv:aaaaaaaa-0000-0000-0000-0000000b7001'); begin
  if (select matched_to_type from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b7001') is not null then
    raise exception 'FAIL: line not freed'; end if;
  if (select status::text from public.invoices where id = inv) = 'void' then raise exception 'FAIL: issued invoice was voided instead of credited'; end if;
  if (select count(*) from public.credit_notes where invoice_id = inv and reason_code = 'cancellation'
        and amount = (select amount from public.invoices where id = inv)) <> 1 then
    raise exception 'FAIL: no full credit note for the reversed sale'; end if;
  if (select net_payable from public.invoices where id = inv) <> 0 then raise exception 'FAIL: something still due on the credited invoice'; end if;
  if (select paid_date from public.invoices where id = inv) is not null then raise exception 'FAIL: paid_date not cleared'; end if;
  if exists (select 1 from public.payments where id = (select v from s where k = 'pay:aaaaaaaa-0000-0000-0000-0000000b7001')::uuid) then
    raise exception 'FAIL: receipt not removed'; end if;
  if (select payment_status::text from public.quotes where id = (select v from s where k = 'q:aaaaaaaa-0000-0000-0000-0000000b7001')) <> 'none' then
    raise exception 'FAIL: quote not reset'; end if;
  /* R-1566: the reversal note takes the sale's money back — it must not also leave that
     money with the customer as credit (issue_credit_note_core p_settle = false). */
  if exists (select 1 from public.customer_credits
              where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a4' and status = 'open') then
    raise exception 'FAIL: undo-sale left open customer credit for money that was taken back'; end if;
end $$;

-- 2. plain un-reconcile keeps the sale
select pg_temp.book_sale('aaaaaaaa-0000-0000-0000-0000000b7002', 'Reconciled from bank receipt');
select public.unreconcile_bank_receipt('aaaaaaaa-0000-0000-0000-0000000b7002', false);
do $$ begin
  if (select matched_to_type from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b7002') is not null then
    raise exception 'FAIL: line not freed (plain)'; end if;
  if (select status::text from public.invoices where id = (select v from s where k = 'inv:aaaaaaaa-0000-0000-0000-0000000b7002')) = 'void' then
    raise exception 'FAIL: plain un-reconcile voided the invoice'; end if;
  if not exists (select 1 from public.payments where id = (select v from s where k = 'pay:aaaaaaaa-0000-0000-0000-0000000b7002')::uuid) then
    raise exception 'FAIL: plain un-reconcile removed the receipt'; end if;
end $$;

-- 3. a receipt recorded separately is refused
update public.bank_transactions set matched_to_type = 'payment', matched_to_id = (select v from s where k = 'pay:aaaaaaaa-0000-0000-0000-0000000b7002')
 where id = 'aaaaaaaa-0000-0000-0000-0000000b7002';
update public.payments set notes = 'Cheque from customer' where id = (select v from s where k = 'pay:aaaaaaaa-0000-0000-0000-0000000b7002')::uuid;
do $$ begin
  perform public.unreconcile_bank_receipt('aaaaaaaa-0000-0000-0000-0000000b7002', true);
  raise exception 'FAIL: separate receipt undone';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;

select 'unreconcile_undo_bank_sale: all assertions passed' as result;
rollback;
