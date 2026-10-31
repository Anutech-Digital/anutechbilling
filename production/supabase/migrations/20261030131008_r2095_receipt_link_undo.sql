-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'invoice_on_receipt') and to_regprocedure('public.tg_bank_txn_payment_link()') is null and not exists(select 1 from pg_trigger where tgname = 'trg_bank_txn_payment_link')
-- deploy-key: r2095receiptlinkundo
-- 20261030131008_r2095_receipt_link_undo.sql
-- R-2106 (31 Oct): peek = 123423 has run (its quotes.invoice_on_receipt column) AND its trigger/function are gone,
-- so it is false before 123423 and while the trigger exists; 123423's peek no longer asks for the trigger.
--
-- R-2095 fix of red SQL CI (tb_money_events_balanced, G1b razorpay settlement net of fee).
-- 20261030123423 filled payments.bank_txn_id for EVERY receipt matched to a bank line. That column
-- means "one of SEVERAL receipts on one line" (R-2098): report_settlement_shortfalls and the
-- balance sheet skip such receipts' shortfall (the split books it as a round-off), so a Razorpay
-- settlement net of its fee lost its fee from the books (Dr − Cr moved by -236).
-- A single receipt already names its line the other way round — bank_transactions.matched_to_id
-- is the payment id — so the trigger and its back-fill are taken out again. Receipts the back-fill
-- touched get bank_txn_id cleared where the line carries that receipt alone (matched_to_id = the
-- payment, no other receipt on it, no round-off): exactly the rows R-2098 never fills.
-- Test: supabase/tests/tb_money_events_balanced.test.sql (G1b), r2095_sale_invoice_on_receipt.test.sql (A).

begin;

drop trigger if exists trg_bank_txn_payment_link on public.bank_transactions;
drop function if exists public.tg_bank_txn_payment_link();

update public.payments p set bank_txn_id = null
  from public.bank_transactions t
 where p.bank_txn_id = t.id and t.tenant_id = p.tenant_id
   and t.matched_to_type = 'payment' and t.matched_to_id = p.id::text
   and not exists (select 1 from public.payments p2 where p2.bank_txn_id = t.id and p2.id <> p.id)
   and not exists (select 1 from public.bank_receipt_round_offs r where r.bank_txn_id = t.id);

commit;
