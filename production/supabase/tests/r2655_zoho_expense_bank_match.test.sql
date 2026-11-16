-- R-2655 (11 Nov 2026, p0 paisa, G-RECON N6) — PART 1: preview "match imported Zoho expenses to bank lines".
-- Migration 20261111161638_r2655_zoho_expense_bank_match. Self-asserting, ONE transaction, rolled back.
--
--   A. Preview (owner, all accounts):
--      A1 a Zoho document of 2 category rows ↔ ONE debit of their sum = sure (2 parts);
--      A2 TDS: the debit of amount − TDS = sure; the debit of the full bill amount is not a match;
--      A3 a debit ₹1 apart = 'look', never sure;
--      A4 two documents + two debits of one amount = 'ambiguous' (4 rows); the Zoho reference = the
--         line's own UTR picks the one pair (sure) — the other document stays ambiguous (fail closed);
--      A5 paid from the card account: never paired with the bank account's same-amount debit; petty
--         cash, a USD row, a Salaries row and a non-Zoho expense are not listed;
--      A6 the only same-amount debit is already reconciled as an expense = 'booked_elsewhere';
--      A7 paid date on / before the books lock = 'locked';
--      A8 19 days apart with no reference = 'no_line' naming that debit; 24 days apart WITH the same
--         UTR = sure;
--      A9 a hand-recorded paid expense of the same amount could be the debit too = 'ambiguous';
--      A10 a document with one part not open = 'look' (changed by hand);
--      A11 Zoho paid two bills with ONE vendor payment: both 'look' (the debit is their total) and an
--          unrelated debit of one bill's amount is never offered;
--      A12 the debit carries a UTR that is not the one Zoho has = 'look', never sure;
--      A13 a Zoho expense marked paid with NO account = 'look', and it makes the same-amount document
--          paid from the bank 'ambiguous' (it could be that debit too);
--      A14 a payment recorded on the Bills page (its stand-in manual line) of the same amount =
--          'ambiguous', and that manual line is never shown as a bank debit;
--      A15 a sibling Zoho document already matched to its own debit is NOT a 'booked_elsewhere' for
--          the next document of the same amount (that one is 'no_line');
--      another company's document and line are never seen.
--   B. Read only: nothing is written (lines, expenses, payment lines unchanged); a second call gives
--      the same rows; the account filter keeps only that account's documents.
--   C. A manager is refused; the other company's owner sees only its own one pair.

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
  ('dddddddd-0000-0000-0000-000000265501','R2655 Co','r2655@example.in','07','R655'),
  ('dddddddd-0000-0000-0000-000000265502','R2655 Other Co','r2655b@example.in','07','R65B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000265501','owner2655@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000265502','manager2655@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000265503','owner2655b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000265501','dddddddd-0000-0000-0000-000000265501','owner2655@example.in','Owner 2655','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000265502','dddddddd-0000-0000-0000-000000265501','manager2655@example.in','Manager 2655','manager', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000265503','dddddddd-0000-0000-0000-000000265502','owner2655b@example.in','Owner 2655 B','owner', now() - interval '1 day');
-- A = HDFC 4523 (…501), K = card (…502), C = petty cash (…503), X = other company (…504)
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000265501','dddddddd-0000-0000-0000-000000265501','HDFC 4523','HDFC','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000265502','dddddddd-0000-0000-0000-000000265501','HDFC Card','HDFC','credit_card', 0),
  ('bbbbbbbb-0000-0000-0000-000000265503','dddddddd-0000-0000-0000-000000265501','Petty cash','Cash','cash', 0),
  ('bbbbbbbb-0000-0000-0000-000000265504','dddddddd-0000-0000-0000-000000265502','Other Co bank','SBI','current', 0);
insert into public.vendors (id, tenant_id, name) values
  ('eeeeeeee-0000-0000-0000-000000265501','dddddddd-0000-0000-0000-000000265501','Amazon Retail'),
  ('eeeeeeee-0000-0000-0000-000000265502','dddddddd-0000-0000-0000-000000265501','Sharma Associates'),
  ('eeeeeeee-0000-0000-0000-000000265503','dddddddd-0000-0000-0000-000000265502','Other Vendor');
insert into public.zoho_fy_import_batches (id, tenant_id, kind, fy) values
  ('cccccccc-0000-0000-0000-000000265501','dddddddd-0000-0000-0000-000000265501','expenses','2026-27'),
  ('cccccccc-0000-0000-0000-000000265502','dddddddd-0000-0000-0000-000000265502','expenses','2026-27');

-- Zoho-imported expenses, as import_zoho_fy_purchases + _r2502_mark_paid leave them (paid, account, no line).
-- The import's own switch (tg_purchases_zoho_doc_guard lets only the import write zoho_doc_id).
select set_config('app.zoho_purchase_import', 'on', true);
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no,
                             paid, paid_date, payment_method, bank_account_id, tds_amount, tds_section, currency,
                             zoho_doc_id, zoho_leg, purchase_import_batch_id) values
  -- A1 one document, two category rows: 5,000 + 1,800 = 6,800
  ('EXP-Z-2655-1-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-01',5000,0,'none','AMZ-1',true,'2026-10-01','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z1',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-1-2','dddddddd-0000-0000-0000-000000265501','Software','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-01',1800,0,'none','AMZ-1',true,'2026-10-01','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z1',2,'cccccccc-0000-0000-0000-000000265501'),
  -- A2 TDS: 11,800 − 1,000 = 10,800 cash
  ('EXP-Z-2655-2-1','dddddddd-0000-0000-0000-000000265501','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000265502','2026-10-02',11800,1800,'gst','PS-9',true,'2026-10-05','bank','bbbbbbbb-0000-0000-0000-000000265501',1000,'194J','INR','bills:Z2',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A3 ₹1 apart
  ('EXP-Z-2655-3-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-08',999,0,'none','AMZ-3',true,'2026-10-08','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z3',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A4 two of 500; then 700 with a reference + 700 without
  ('EXP-Z-2655-4A-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-10',500,0,'none','AMZ-4A',true,'2026-10-10','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z4A',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-4B-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-11',500,0,'none','AMZ-4B',true,'2026-10-11','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z4B',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-4C-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-12',700,0,'none','AMZ-4C',true,'2026-10-12','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z4C',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-4D-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-13',700,0,'none','AMZ-4D',true,'2026-10-13','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z4D',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A5 paid from the card; petty cash; USD
  ('EXP-Z-2655-5-1','dddddddd-0000-0000-0000-000000265501','Software','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-15',4321,0,'none','AMZ-5',true,'2026-10-15','card','bbbbbbbb-0000-0000-0000-000000265502',0,null,'INR','expenses:Z5',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-5C-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-15',150,0,'none','AMZ-5C',true,'2026-10-15','cash','bbbbbbbb-0000-0000-0000-000000265503',0,null,'INR','expenses:Z5C',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-5U-1','dddddddd-0000-0000-0000-000000265501','Software','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-15',160,0,'none','AMZ-5U',true,'2026-10-15','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'USD','expenses:Z5U',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A6 the debit is already booked as something else
  ('EXP-Z-2655-6-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-18',2500,0,'none','AMZ-6',true,'2026-10-18','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z6',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A7 paid before the books lock (set below)
  ('EXP-Z-2655-7-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-09-29',3000,0,'none','AMZ-7',true,'2026-09-29','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z7',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A8 window
  ('EXP-Z-2655-8-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-01',8000,0,'none','AMZ-8',true,'2026-10-01','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z8',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-8R-1','dddddddd-0000-0000-0000-000000265501','Office Supplies',null,null,'2026-10-01',9000,0,'none','AMZ-8R',true,'2026-10-01','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z8R',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A9 a hand-recorded rival (below) of the same amount
  ('EXP-Z-2655-9-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-22',1234,0,'none','AMZ-9',true,'2026-10-22','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z9',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A10 one part open, one part not paid (changed by hand)
  ('EXP-Z-2655-10-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-24',400,0,'none','AMZ-10',true,'2026-10-24','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z10',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-10-2','dddddddd-0000-0000-0000-000000265501','Software','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-24',300,0,'none','AMZ-10',false,null,null,null,0,null,'INR','expenses:Z10',2,'cccccccc-0000-0000-0000-000000265501'),
  -- the other company: same amount as A1
  ('EXP-Z-2655-X-1','dddddddd-0000-0000-0000-000000265502','Office Supplies','Other Vendor','eeeeeeee-0000-0000-0000-000000265503','2026-10-01',6800,0,'none','OV-1',true,'2026-10-01','bank','bbbbbbbb-0000-0000-0000-000000265504',0,null,'INR','expenses:ZX',1,'cccccccc-0000-0000-0000-000000265502');
select set_config('app.zoho_purchase_import', '', true);
-- not from Zoho: the hand expense that A6's line is booked to, and A9's rival
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, paid, paid_date, payment_method, bank_account_id) values
  ('EXP-HAND-2655-6','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon','2026-10-19',2500,0,'none',true,'2026-10-19','bank','bbbbbbbb-0000-0000-0000-000000265501'),
  ('EXP-HAND-2655-9','dddddddd-0000-0000-0000-000000265501','Office Supplies','Somebody','2026-10-23',1234,0,'none',true,'2026-10-23','bank',null);
-- the Zoho references (scan payloads)
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload) values
  ('dddddddd-0000-0000-0000-000000265501','expenses','2026-27','Z4C','', '2026-10-12','paid','{"reference":"628712345678"}'),
  ('dddddddd-0000-0000-0000-000000265501','expenses','2026-27','Z8R','', '2026-10-01','paid','{"reference":"UPI 628700000001"}');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source) values
  -- A1
  ('11111111-0000-0000-0000-000000265501','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-03','POS 416021XXXXXX1234 AMZN',null,6800,0,'csv_upload'),
  -- A2: the cash debit and a full-amount debit
  ('11111111-0000-0000-0000-000000265502','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-06','IB FUNDS TRANSFER DR',null,10800,0,'csv_upload'),
  ('11111111-0000-0000-0000-000000265503','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-06','IB FUNDS TRANSFER DR',null,11800,0,'csv_upload'),
  -- A3
  ('11111111-0000-0000-0000-000000265504','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-08','POS AMZN',null,1000,0,'csv_upload'),
  -- A4
  ('11111111-0000-0000-0000-000000265505','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-10','POS AMZN',null,500,0,'csv_upload'),
  ('11111111-0000-0000-0000-000000265506','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-11','POS AMZN',null,500,0,'csv_upload'),
  ('11111111-0000-0000-0000-000000265507','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-12','UPI-SOMEONE-628712345678-PAY',null,700,0,'csv_upload'),
  ('11111111-0000-0000-0000-000000265508','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-13','UPI-OTHER-628799999999-PAY',null,700,0,'csv_upload'),
  -- A5: the bank account has a debit of the card document's amount
  ('11111111-0000-0000-0000-000000265509','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-15','POS AMZN',null,4321,0,'csv_upload'),
  -- A7
  ('11111111-0000-0000-0000-000000265511','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-01','POS AMZN',null,3000,0,'csv_upload'),
  -- A8
  ('11111111-0000-0000-0000-000000265512','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-20','POS AMZN',null,8000,0,'csv_upload'),
  ('11111111-0000-0000-0000-000000265513','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-25','UPI-AMZN-628700000001-PAY',null,9000,0,'csv_upload'),
  -- A9
  ('11111111-0000-0000-0000-000000265514','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-22','POS AMZN',null,1234,0,'csv_upload'),
  -- the other company
  ('11111111-0000-0000-0000-000000265515','dddddddd-0000-0000-0000-000000265502','bbbbbbbb-0000-0000-0000-000000265504','2026-10-02','POS OV',null,6800,0,'csv_upload');
-- A6: the debit is already reconciled to the hand expense
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source,
                                      matched_to_type, matched_to_id, match_confidence) values
  ('11111111-0000-0000-0000-000000265510','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-19','POS AMZN',null,2500,0,'csv_upload','expense','EXP-HAND-2655-6','manual');
update public.expenses set reconciled_txn_id = '11111111-0000-0000-0000-000000265510' where id = 'EXP-HAND-2655-6';
update public.tenants set books_locked_until = '2026-09-30' where id = 'dddddddd-0000-0000-0000-000000265501';

-- ── review cases A11–A15 ──
select set_config('app.zoho_purchase_import', 'on', true);
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no,
                             paid, paid_date, payment_method, bank_account_id, tds_amount, tds_section, currency,
                             zoho_doc_id, zoho_leg, purchase_import_batch_id) values
  -- A11 two bills, ONE Zoho vendor payment P11 (5,000 + 3,100 = one 8,100 debit)
  ('EXP-Z-2655-11A-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Sharma Associates','eeeeeeee-0000-0000-0000-000000265502','2026-10-26',5000,0,'none','PS-11A',true,'2026-10-26','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','bills:Z11A',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-11B-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Sharma Associates','eeeeeeee-0000-0000-0000-000000265502','2026-10-26',3100,0,'none','PS-11B',true,'2026-10-26','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','bills:Z11B',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A12 Zoho has UTR …000012; the debit carries another UTR
  ('EXP-Z-2655-12-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-27',1500,0,'none','AMZ-12',true,'2026-10-27','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z12',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A13 paid with no account + the same amount paid from the bank
  ('EXP-Z-2655-13-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-28',2222,0,'none','AMZ-13',true,'2026-10-28','bank',null,0,null,'INR','expenses:Z13',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-14-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-28',2222,0,'none','AMZ-14',true,'2026-10-28','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z14',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A14 a Bills-page payment of the same amount exists
  ('EXP-Z-2655-15-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-29',3333,0,'none','AMZ-15',true,'2026-10-29','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z15',1,'cccccccc-0000-0000-0000-000000265501'),
  -- A15 siblings of 1,180: 16A already matched to its debit, 16B waiting
  ('EXP-Z-2655-16A-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-30',1180,0,'none','AMZ-16A',true,'2026-10-30','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z16A',1,'cccccccc-0000-0000-0000-000000265501'),
  ('EXP-Z-2655-16B-1','dddddddd-0000-0000-0000-000000265501','Office Supplies','Amazon Retail','eeeeeeee-0000-0000-0000-000000265501','2026-10-31',1180,0,'none','AMZ-16B',true,'2026-10-31','bank','bbbbbbbb-0000-0000-0000-000000265501',0,null,'INR','expenses:Z16B',1,'cccccccc-0000-0000-0000-000000265501');
select set_config('app.zoho_purchase_import', '', true);
insert into public.zoho_vendor_payment_links (tenant_id, batch_id, zoho_payment_id, zoho_bill_id, target_type, target_ids, amount) values
  ('dddddddd-0000-0000-0000-000000265501','cccccccc-0000-0000-0000-000000265501','P11','Z11A','expense',array['EXP-Z-2655-11A-1'],5000),
  ('dddddddd-0000-0000-0000-000000265501','cccccccc-0000-0000-0000-000000265501','P11','Z11B','expense',array['EXP-Z-2655-11B-1'],3100);
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload) values
  ('dddddddd-0000-0000-0000-000000265501','expenses','2026-27','Z12','', '2026-10-27','paid','{"reference":"628712000012"}');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source) values
  ('11111111-0000-0000-0000-000000265520','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-26','UPI-SOMEBODY ELSE',null,5000,0,'csv_upload'),
  ('11111111-0000-0000-0000-000000265521','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-27','UPI-AMZN-628799000012-PAY',null,1500,0,'csv_upload'),
  ('11111111-0000-0000-0000-000000265522','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-28','POS AMZN',null,2222,0,'csv_upload'),
  ('11111111-0000-0000-0000-000000265523','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-30','POS AMZN',null,3333,0,'csv_upload');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source,
                                      matched_to_type, matched_to_id, match_confidence) values
  -- A14 the stand-in line of a Bills-page payment (not a bank debit)
  ('11111111-0000-0000-0000-000000265524','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-29','Paid: Some vendor bill',null,3333,0,'manual','vendor_bill','VB-R2655-X','manual'),
  -- A15 16A's own debit, matched to it
  ('11111111-0000-0000-0000-000000265525','dddddddd-0000-0000-0000-000000265501','bbbbbbbb-0000-0000-0000-000000265501','2026-10-30','POS AMZN',null,1180,0,'csv_upload','expense','EXP-Z-2655-16A-1','manual');
select set_config('app.zoho_purchase_import', 'on', true);
update public.expenses set reconciled_txn_id = '11111111-0000-0000-0000-000000265525' where id = 'EXP-Z-2655-16A-1';
select set_config('app.zoho_purchase_import', '', true);

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000265501","role":"authenticated"}', true);

do $$
declare
  v_got text; v_want text; v_n int; r record;
  v_lines0 text; v_exp0 text; v_pl0 bigint;
begin
  select md5(string_agg(t.id::text || coalesce(t.matched_to_type, '-') || coalesce(t.matched_to_id, '-'), ',' order by t.id)) into v_lines0
    from public.bank_transactions t where t.tenant_id in ('dddddddd-0000-0000-0000-000000265501','dddddddd-0000-0000-0000-000000265502');
  select md5(string_agg(e.id || e.paid::text || coalesce(e.reconciled_txn_id::text, '-') || e.paid_amount::text, ',' order by e.id)) into v_exp0
    from public.expenses e where e.tenant_id in ('dddddddd-0000-0000-0000-000000265501','dddddddd-0000-0000-0000-000000265502');
  select count(*) into v_pl0 from public.bank_vendor_payment_lines;

  -- ── A ──
  select string_agg(m.zoho_doc_id || '>' || coalesce(right(m.txn_id::text, 2), '--') || ':' || m.status, ' ' order by m.zoho_doc_id, m.txn_id)
    into v_got from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id !~ 'Z1[1-6]';
  v_want := 'bills:Z2>02:sure expenses:Z1>01:sure expenses:Z10>--:look expenses:Z3>04:look'
         || ' expenses:Z4A>05:ambiguous expenses:Z4A>06:ambiguous expenses:Z4B>05:ambiguous expenses:Z4B>06:ambiguous'
         || ' expenses:Z4C>07:sure expenses:Z4D>08:ambiguous expenses:Z5>--:no_line expenses:Z6>10:booked_elsewhere'
         || ' expenses:Z7>11:locked expenses:Z8>12:no_line expenses:Z8R>13:sure expenses:Z9>14:ambiguous';
  if v_got is distinct from v_want then
    raise exception 'FAIL A: preview — got: % — want: %', v_got, v_want;
  end if;
  if exists (select 1 from public.zoho_expense_bank_matches(null) m where coalesce(m.reason, '') = '') then
    raise exception 'FAIL A: a row without a reason'; end if;

  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z1';
  if r.cash <> 6800 or r.parts <> 2 or r.expense_ids <> array['EXP-Z-2655-1-1','EXP-Z-2655-1-2']
     or r.account <> 'HDFC 4523' or r.vendor_name <> 'Amazon Retail' or r.reason not like 'Same amount, paid from this account, 2 day(s) apart%' then
    raise exception 'FAIL A1: split document row %', r; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'bills:Z2';
  if r.cash <> 10800 or r.reason not like 'Same amount%' then raise exception 'FAIL A2: TDS cash %', r; end if;
  if exists (select 1 from public.zoho_expense_bank_matches(null) m where m.txn_id = '11111111-0000-0000-0000-000000265503') then
    raise exception 'FAIL A2: the full-amount debit (before TDS) was offered'; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z3';
  if r.reason not like '%₹1 apart%' then raise exception 'FAIL A3: reason %', r.reason; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z4C';
  if r.reason not like 'Same bank reference as in Zoho%' or r.reference <> '628712345678' then
    raise exception 'FAIL A4: reference pair %', r; end if;
  if exists (select 1 from public.zoho_expense_bank_matches(null) m where m.txn_id = '11111111-0000-0000-0000-000000265509') then
    raise exception 'FAIL A5: the bank debit was paired with a document paid from the card'; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z5';
  if r.account <> 'HDFC Card' then raise exception 'FAIL A5: card document account %', r.account; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z6';
  if r.reason not like '%already reconciled as expense%in the books twice%' then raise exception 'FAIL A6: reason %', r.reason; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z7';
  if r.reason <> 'Books are locked up to 30 Sep 2026.' then raise exception 'FAIL A7: reason %', r.reason; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z8';
  if r.reason not like '%nearest one is on 20 Oct 2026 (19 days away)%' then raise exception 'FAIL A8: reason %', r.reason; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z9';
  if r.reason not like 'Another paid expense of the same amount%' then raise exception 'FAIL A9: reason %', r.reason; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z10';
  if r.reason not like '1 of its 2 parts are open%' then raise exception 'FAIL A10: reason %', r.reason; end if;
  -- A11 one Zoho payment, two bills
  select string_agg(m.zoho_doc_id || ':' || m.status || ':' || coalesce(right(m.txn_id::text, 2), '--'), ' ' order by m.zoho_doc_id) into v_got
    from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id in ('bills:Z11A', 'bills:Z11B');
  if v_got is distinct from 'bills:Z11A:look:-- bills:Z11B:look:--' then raise exception 'FAIL A11: %', v_got; end if;
  if not exists (select 1 from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'bills:Z11A' and m.reason like 'Zoho paid this bill together with 1 other bill(s)%') then
    raise exception 'FAIL A11: reason'; end if;
  if exists (select 1 from public.zoho_expense_bank_matches(null) m where m.txn_id = '11111111-0000-0000-0000-000000265520') then
    raise exception 'FAIL A11: an unrelated debit of one bill''s amount was offered'; end if;
  -- A12 another UTR on the debit
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z12';
  if r.status <> 'look' or r.txn_id <> '11111111-0000-0000-0000-000000265521' or r.reason not like '%not the one Zoho has%' then raise exception 'FAIL A12: %', r; end if;
  -- A13 no paid-from account
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z13';
  if r.status <> 'look' or r.account_id is not null or r.reason not like 'Marked paid with no paid-from account%' then raise exception 'FAIL A13: %', r; end if;
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z14';
  if r.status <> 'ambiguous' or r.txn_id <> '11111111-0000-0000-0000-000000265522' then raise exception 'FAIL A13: the bank document should be ambiguous: %', r; end if;
  -- A14 a Bills-page payment of the same amount
  select * into r from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id = 'expenses:Z15';
  if r.status <> 'ambiguous' or r.txn_id <> '11111111-0000-0000-0000-000000265523' then raise exception 'FAIL A14: %', r; end if;
  if exists (select 1 from public.zoho_expense_bank_matches(null) m where m.txn_id = '11111111-0000-0000-0000-000000265524') then
    raise exception 'FAIL A14: the stand-in manual line was shown as a bank debit'; end if;
  -- A15 a sibling matched to its own debit
  select string_agg(m.zoho_doc_id || ':' || m.status, ' ') into v_got
    from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id like 'expenses:Z16%';
  if v_got is distinct from 'expenses:Z16B:no_line' then raise exception 'FAIL A15: %', v_got; end if;
  raise notice 'A PASS: sure / ambiguous / look / booked_elsewhere / locked / no_line as designed';

  -- ── B ──
  select string_agg(m.zoho_doc_id || '>' || coalesce(right(m.txn_id::text, 2), '--') || ':' || m.status, ' ' order by m.zoho_doc_id, m.txn_id)
    into v_got from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id !~ 'Z1[1-6]';
  if v_got is distinct from v_want then raise exception 'FAIL B: second call differs'; end if;
  if (select md5(string_agg(t.id::text || coalesce(t.matched_to_type, '-') || coalesce(t.matched_to_id, '-'), ',' order by t.id))
        from public.bank_transactions t where t.tenant_id in ('dddddddd-0000-0000-0000-000000265501','dddddddd-0000-0000-0000-000000265502')) is distinct from v_lines0
     or (select md5(string_agg(e.id || e.paid::text || coalesce(e.reconciled_txn_id::text, '-') || e.paid_amount::text, ',' order by e.id))
           from public.expenses e where e.tenant_id in ('dddddddd-0000-0000-0000-000000265501','dddddddd-0000-0000-0000-000000265502')) is distinct from v_exp0
     or (select count(*) from public.bank_vendor_payment_lines) <> v_pl0 then
    raise exception 'FAIL B: the preview wrote something'; end if;
  select count(*) into v_n from public.zoho_expense_bank_matches('bbbbbbbb-0000-0000-0000-000000265502');
  if v_n <> 1 then raise exception 'FAIL B: card account filter gave % rows, want 1', v_n; end if;
  select count(*) into v_n from public.zoho_expense_bank_matches('bbbbbbbb-0000-0000-0000-000000265504');
  if v_n <> 0 then raise exception 'FAIL B: another company''s account gave % rows', v_n; end if;
  raise notice 'B PASS: read only, stable, account filter';
end $$;

-- ── C ── a manager is refused; the other company sees only its own
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000265502","role":"authenticated"}', true);
do $$
begin
  begin
    perform 1 from public.zoho_expense_bank_matches(null);
    raise exception 'FAIL C: a manager got the preview';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000265503","role":"authenticated"}', true);
do $$
declare v_got text;
begin
  select string_agg(m.zoho_doc_id || ':' || m.status || ':' || right(m.txn_id::text, 2), ' ') into v_got from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id !~ 'Z1[1-6]';
  if v_got is distinct from 'expenses:ZX:sure:15' then raise exception 'FAIL C: other company sees %', v_got; end if;
  raise notice 'C PASS: manager refused, other company sees only its own';
end $$;

rollback;
