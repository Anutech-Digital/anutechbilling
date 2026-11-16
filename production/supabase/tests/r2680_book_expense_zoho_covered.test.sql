-- R-2680 (11 Nov 2026, p0 paisa, G-RECON N6): "Book as expense" and the bulk no-vendor sheet (both call
-- book_bank_txn_as_expense) refuse a debit that an imported Zoho expense already covers — that
-- expense is PAID with no bank line (R-2502 / R-2676), so booking its debit again counts the cost twice.
-- Migration 20261111222942_r2680_book_expense_zoho_covered. Self-asserting, ONE transaction, rolled back.
--
--   A. A debit equal to an open Zoho document's cash, same paid-from account, within 7 days of its paid
--      date → refused with the sentence (hint R-2680), with and without a vendor name typed. Nothing is
--      written by a refusal. ONE document covers ONE line (money rule S7): a second debit of that amount
--      (here ₹1 apart, same day, higher id) books; a lone debit ₹1 apart is refused; ₹2 apart books.
--   B. A two-row Zoho document is covered by ONE debit of its TOTAL (after TDS); a debit of one row's
--      amount books.
--   C. Not covered → books as before: another account's document, a document paid 8 days away, a USD
--      row, a Salaries row, a non-Zoho paid expense. An UNPAID Zoho bill (expense rows) and an unpaid Zoho
--      COGS bill (less its Zoho TDS) ARE covered, up to 120 days after the bill date, no vendor typed —
--      with the BILL sentence (pay it with "Record payment": matching a line does not pay a bill). With
--      the vendor typed, R-1917's own open-bill sentence still answers first.
--   D. Two identical Zoho expenses + three debits: the two nearest debits are refused, the third (a real
--      extra payment) books at once; after ONE expense is matched to its debit the other debit is still
--      refused; un-matching opens the guard again.
--   E. Another company's Zoho document never blocks; a sales user is still refused by the role gate.
--   F. A LATER debit (card / cheque posting): 24 days after the paid date is still covered when the
--      line's own UTR is the reference Zoho has for that payment (up to 60 days); with another UTR it
--      is not covered and books.
--   G. ONE debit for several Zoho bills: Zoho paid two bills with one vendor payment — the debit of
--      their TOTAL is refused (the sentence says "and 1 more"); a debit of one bill's own amount is not
--      that payment (R-2655: its debit is the total) and books. With an advance in the same Zoho payment
--      the payment's own amount is covered — and the bill's own amount is NOT (an unrelated debit of that
--      amount books; refusing it would send the user to match the wrong line and free the real debit).

begin;

create function pg_temp.r2680_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2680_supplier before insert on public.tenants for each row execute function pg_temp.r2680_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000268001','R2680 Co','r2680@example.in','07','R2680'),
  ('dddddddd-0000-0000-0000-000000268002','R2680 Other','r2680b@example.in','07','R2681');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000268001','owner2680@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000268002','sales2680@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000268003','owner2680b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000268001','dddddddd-0000-0000-0000-000000268001','owner2680@example.in','Owner 2680','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000268002','dddddddd-0000-0000-0000-000000268001','sales2680@example.in','Sales 2680','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000268003','dddddddd-0000-0000-0000-000000268002','owner2680b@example.in','Owner 2680 B','owner', now() - interval '1 day');
-- A = HDFC (…01), K = card (…02), X = the other company's account (…03)
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type) values
  ('bbbbbbbb-0000-0000-0000-000000268001','dddddddd-0000-0000-0000-000000268001','HDFC 4523','HDFC','current'),
  ('bbbbbbbb-0000-0000-0000-000000268002','dddddddd-0000-0000-0000-000000268001','HDFC Card','HDFC','credit_card'),
  ('bbbbbbbb-0000-0000-0000-000000268003','dddddddd-0000-0000-0000-000000268002','Other bank','SBI','current');
insert into public.zoho_fy_import_batches (id, tenant_id, kind, fy) values
  ('eeeeeeee-0000-0000-0000-000000268001','dddddddd-0000-0000-0000-000000268001','expenses','2026-27'),
  ('eeeeeeee-0000-0000-0000-000000268002','dddddddd-0000-0000-0000-000000268002','expenses','2026-27');

-- Imported from Zoho (as import_zoho_fy_purchases + _r2502_mark_paid leave them). Only the import may
-- write zoho_doc_id (tg_purchases_zoho_doc_guard) — its own switch, for this transaction.
select set_config('app.zoho_purchase_import', 'on', true);
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type,
                             paid, paid_date, payment_method, bank_account_id, tds_amount, tds_section, currency,
                             zoho_doc_id, zoho_leg, purchase_import_batch_id) values
  -- A: 500, no vendor, paid 10 Oct from HDFC
  ('EXP-Z-2680-A-1','dddddddd-0000-0000-0000-000000268001','Bank Charges',null,'2026-10-10',500,0,'none',true,'2026-10-10','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','expenses:A',1,'eeeeeeee-0000-0000-0000-000000268001'),
  -- B: two rows 1,000 (TDS 100) + 300 = 1,200 cash, paid 12 Oct
  ('EXP-Z-2680-B-1','dddddddd-0000-0000-0000-000000268001','Professional Services','R2680 CA','2026-10-12',1000,0,'none',true,'2026-10-12','bank','bbbbbbbb-0000-0000-0000-000000268001',100,'194J','INR','bills:B',1,'eeeeeeee-0000-0000-0000-000000268001'),
  ('EXP-Z-2680-B-2','dddddddd-0000-0000-0000-000000268001','Office Supplies','R2680 CA','2026-10-12',300,0,'none',true,'2026-10-12','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','bills:B',2,'eeeeeeee-0000-0000-0000-000000268001'),
  -- C: paid from the CARD (2,100); a USD row (2,200); a Salaries row (2,300); an unpaid Zoho bill (2,400)
  ('EXP-Z-2680-C1-1','dddddddd-0000-0000-0000-000000268001','Software',null,'2026-10-14',2100,0,'none',true,'2026-10-14','card','bbbbbbbb-0000-0000-0000-000000268002',0,null,'INR','expenses:C1',1,'eeeeeeee-0000-0000-0000-000000268001'),
  ('EXP-Z-2680-C2-1','dddddddd-0000-0000-0000-000000268001','Software',null,'2026-10-14',2200,0,'none',true,'2026-10-14','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'USD','expenses:C2',1,'eeeeeeee-0000-0000-0000-000000268001'),
  ('EXP-Z-2680-C3-1','dddddddd-0000-0000-0000-000000268001','Salaries',null,'2026-10-14',2300,0,'none',true,'2026-10-14','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','expenses:C3',1,'eeeeeeee-0000-0000-0000-000000268001'),
  ('EXP-Z-2680-C4-1','dddddddd-0000-0000-0000-000000268001','Software','R2680 Unpaid Vendor','2026-10-14',2400,0,'none',false,null,null,null,0,null,'INR','bills:C4',1,'eeeeeeee-0000-0000-0000-000000268001'),
  -- C: 2,600 paid 1 Oct — its debit below is 8 days later
  ('EXP-Z-2680-C6-1','dddddddd-0000-0000-0000-000000268001','Software',null,'2026-10-01',2600,0,'none',true,'2026-10-01','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','expenses:C6',1,'eeeeeeee-0000-0000-0000-000000268001'),
  -- D: two identical 118 bank charges, 20 + 21 Oct
  ('EXP-Z-2680-D1-1','dddddddd-0000-0000-0000-000000268001','Bank Charges',null,'2026-10-20',118,0,'none',true,'2026-10-20','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','expenses:D1',1,'eeeeeeee-0000-0000-0000-000000268001'),
  ('EXP-Z-2680-D2-1','dddddddd-0000-0000-0000-000000268001','Bank Charges',null,'2026-10-21',118,0,'none',true,'2026-10-21','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','expenses:D2',1,'eeeeeeee-0000-0000-0000-000000268001'),
  -- E: the OTHER company has a 3,000 Zoho expense on 25 Oct
  ('EXP-Z-2680-X-1','dddddddd-0000-0000-0000-000000268002','Bank Charges',null,'2026-10-25',3000,0,'none',true,'2026-10-25','bank','bbbbbbbb-0000-0000-0000-000000268003',0,null,'INR','expenses:X',1,'eeeeeeee-0000-0000-0000-000000268002');
select set_config('app.zoho_purchase_import', 'on', true);
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type,
                             paid, paid_date, payment_method, bank_account_id, tds_amount, tds_section, currency,
                             zoho_doc_id, zoho_leg, purchase_import_batch_id) values
  -- F: paid 1 Oct; Zoho's reference is the UTR 628712000680 / 628712000681
  ('EXP-Z-2680-F1-1','dddddddd-0000-0000-0000-000000268001','Software',null,'2026-10-01',4000,0,'none',true,'2026-10-01','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','expenses:F1',1,'eeeeeeee-0000-0000-0000-000000268001'),
  ('EXP-Z-2680-F2-1','dddddddd-0000-0000-0000-000000268001','Software',null,'2026-10-01',4100,0,'none',true,'2026-10-01','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','expenses:F2',1,'eeeeeeee-0000-0000-0000-000000268001'),
  -- G: two bills of one vendor, paid on 5 Oct by ONE Zoho vendor payment PG (5,000 + 3,100 = 8,100)
  ('EXP-Z-2680-G1-1','dddddddd-0000-0000-0000-000000268001','Professional Services','R2680 Lawyer','2026-10-05',5000,0,'none',true,'2026-10-05','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','bills:G1',1,'eeeeeeee-0000-0000-0000-000000268001'),
  ('EXP-Z-2680-G2-1','dddddddd-0000-0000-0000-000000268001','Professional Services','R2680 Lawyer','2026-10-05',3100,0,'none',true,'2026-10-05','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','bills:G2',1,'eeeeeeee-0000-0000-0000-000000268001');
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type,
                             paid, paid_date, payment_method, bank_account_id, tds_amount, tds_section, currency,
                             zoho_doc_id, zoho_leg, purchase_import_batch_id) values
  ('EXP-Z-2680-A2-1','dddddddd-0000-0000-0000-000000268001','Bank Charges',null,'2026-10-10',600,0,'none',true,'2026-10-10','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','expenses:A2',1,'eeeeeeee-0000-0000-0000-000000268001'),
  -- J: one bill of 9,000 paid on 7 Oct by Zoho payment PJ of 10,000 (1,000 of it an advance)
  ('EXP-Z-2680-J1-1','dddddddd-0000-0000-0000-000000268001','Professional Services','R2680 Auditor','2026-10-07',9000,0,'none',true,'2026-10-07','bank','bbbbbbbb-0000-0000-0000-000000268001',0,null,'INR','bills:J1',1,'eeeeeeee-0000-0000-0000-000000268001');
insert into public.vendors (id, tenant_id, name) values ('ffffffff-0000-0000-0000-000000268001','dddddddd-0000-0000-0000-000000268001','R2680 Licences');
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, bill_no, bill_date, category, line_items, subtotal, cgst, sgst, igst, total,
                                 status, paid_amount, currency, fx_rate, document_type, zoho_doc_id, purchase_import_batch_id, zoho_tds_amount, zoho_tds_section) values
  ('BILL-Z-2680-H','dddddddd-0000-0000-0000-000000268001','ffffffff-0000-0000-0000-000000268001','R2680 Licences','H-1','2026-09-20','COGS-Workspace','[]'::jsonb,7000,0,0,0,7000,
   'unpaid',0,'INR',1,'other','bills:H','eeeeeeee-0000-0000-0000-000000268001',700,'194J');
select set_config('app.zoho_purchase_import', '', true);
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload) values
  ('dddddddd-0000-0000-0000-000000268001','vendorpayments','2026-27','PJ','10','2026-10-07','','{"reference":"","amount":10000,"unapplied":1000}'),
  ('dddddddd-0000-0000-0000-000000268001','expenses','2026-27','F1','','2026-10-01','paid','{"reference":"UPI 628712000680"}'),
  ('dddddddd-0000-0000-0000-000000268001','expenses','2026-27','F2','','2026-10-01','paid','{"reference":"628712000681"}'),
  ('dddddddd-0000-0000-0000-000000268001','vendorpayments','2026-27','PG','9','2026-10-05','','{"reference":""}');
insert into public.zoho_vendor_payment_links (tenant_id, batch_id, zoho_payment_id, zoho_bill_id, target_type, target_ids, amount) values
  ('dddddddd-0000-0000-0000-000000268001','eeeeeeee-0000-0000-0000-000000268001','PG','G1','expense',array['EXP-Z-2680-G1-1'],5000),
  ('dddddddd-0000-0000-0000-000000268001','eeeeeeee-0000-0000-0000-000000268001','PG','G2','expense',array['EXP-Z-2680-G2-1'],3100),
  ('dddddddd-0000-0000-0000-000000268001','eeeeeeee-0000-0000-0000-000000268001','PJ','J1','expense',array['EXP-Z-2680-J1-1'],9000);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('cccccccc-0000-0000-0000-000000268021','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-25','UPI-QZX F1-628712000680-PAY',4000,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268022','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-25','UPI-QZX F2-628799999999-PAY',4100,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268023','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-06','NEFT QZX G 8100',8100,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268024','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-06','NEFT QZX G 5000',5000,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268026','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-11','POS QZX A2 601',601,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268027','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-10','NEFT QZX H 6300',6300,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268028','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-08','NEFT QZX J 10000',10000,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268029','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-09','NEFT QZX J 9000',9000,0,'csv_upload');
-- C: a paid expense NOT from Zoho (2,500) — the vendor guards' business, not this one
insert into public.expenses (id, tenant_id, category, expense_date, amount, paid, paid_date, payment_method, bank_account_id) values
  ('EXP-HAND-2680','dddddddd-0000-0000-0000-000000268001','Software','2026-10-14',2500,true,'2026-10-14','bank','bbbbbbbb-0000-0000-0000-000000268001');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('cccccccc-0000-0000-0000-000000268001','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-12','POS QZX A 500',500,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268002','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-12','POS QZX A 501',501,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268003','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-12','POS QZX A 502',502,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268004','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-13','NEFT QZX B 1200',1200,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268005','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-13','NEFT QZX B 1000',1000,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268006','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-14','POS QZX C 2100',2100,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268007','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-14','POS QZX C 2200',2200,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268008','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-14','POS QZX C 2300',2300,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268009','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-14','POS QZX C 2400',2400,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268010','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-14','POS QZX C 2500',2500,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268011','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-09','POS QZX C 2600',2600,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268012','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-20','BANK CHG QZX D1',118,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268013','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-21','BANK CHG QZX D2',118,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268014','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-22','BANK CHG QZX D3',118,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000268015','dddddddd-0000-0000-0000-000000268001','bbbbbbbb-0000-0000-0000-000000268001','2026-10-25','POS QZX E 3000',3000,0,'csv_upload');

create function pg_temp.book(p_txn uuid, p_vendor text default null) returns text language plpgsql as $f$
begin
  return 'ok:' || public.book_bank_txn_as_expense(p_txn, 'Office Supplies', p_vendor, 0, null);
exception when others then
  return sqlstate || ':' || sqlerrm;
end $f$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000268001","role":"authenticated"}', true);

do $$
declare r text; n0 int; n int;
begin
  select count(*) into n0 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000268001';

  -- ── A ──
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268001');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (Bank Charges, paid 10 Oct 2026, ₹500). Match the line to it in Reconcile instead of booking a new expense, or the cost is counted twice.' then
    raise exception 'A FAIL: the covered debit was not refused with the sentence: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268001', 'Some Vendor');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho%' then raise exception 'A FAIL: a typed vendor name got past the guard: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268026');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (Bank Charges, paid 10 Oct 2026, ₹600)%' then raise exception 'A FAIL: a lone debit ₹1 apart was booked: %', r; end if;
  if (select count(*) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000268001') <> n0
     or exists (select 1 from public.bank_transactions where id in ('cccccccc-0000-0000-0000-000000268001','cccccccc-0000-0000-0000-000000268026') and matched_to_type is not null) then
    raise exception 'A FAIL: a refusal wrote something'; end if;
  -- S7: one document covers ONE line — the second debit near that amount is another payment
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268002');
  if r not like 'ok:%' then raise exception 'A FAIL: one Zoho document blocked a second debit: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268003');
  if r not like 'ok:%' then raise exception 'A FAIL: ₹2 apart was refused: %', r; end if;
  raise notice 'A PASS: the nearest debit (±₹1) refused, a second one and ₹2 apart booked';

  -- ── B ──
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268004');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (R2680 CA, paid 12 Oct 2026, ₹1,200)%' then
    raise exception 'B FAIL: the document total (after TDS) was not covered: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268005');
  if r not like 'ok:%' then raise exception 'B FAIL: one row''s amount was treated as the document: %', r; end if;
  raise notice 'B PASS: a two-row document is one debit of its total after TDS';

  -- ── C ──
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268006'); if r not like 'ok:%' then raise exception 'C FAIL: another account''s document blocked: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268007'); if r not like 'ok:%' then raise exception 'C FAIL: a USD row blocked: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268008'); if r not like 'ok:%' then raise exception 'C FAIL: a Salaries row blocked: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268009');
  if r not like 'P0001:This debit looks like the payment of a bill already imported from Zoho (R2680 Unpaid Vendor, bill dated 14 Oct 2026, ₹2,400). Pay that bill with "Record payment" on this line instead of booking a new expense, or the cost is counted twice.' then
    raise exception 'C FAIL: the debit of an unpaid Zoho bill was booked, or got the wrong way out: %', r; end if;
  if r like '%Match the line%' then raise exception 'C FAIL: a bill was told to be matched in Reconcile (that does not pay it): %', r; end if;
  -- with the vendor typed, R-1917 answers (its own open-bill sentence), not this guard
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268027', 'R2680 Licences');
  if r not like 'P0001:R2680 Licences has an open bill H-1 for ₹7,000. Pay it with "Record payment" on this line instead of booking a new expense%' then
    raise exception 'C FAIL: with the vendor typed R-1917''s sentence did not answer first: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268027');
  if r not like 'P0001:This debit looks like the payment of a bill already imported from Zoho (R2680 Licences, bill dated 20 Sep 2026, ₹6,300). Pay that bill with "Record payment" on this line%' then
    raise exception 'C FAIL: the debit of an unpaid Zoho COGS bill (less its TDS, 20 days later) was booked: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268010'); if r not like 'ok:%' then raise exception 'C FAIL: a non-Zoho paid expense blocked: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268011'); if r not like 'ok:%' then raise exception 'C FAIL: a document paid 8 days away blocked: %', r; end if;
  raise notice 'C PASS: not covered → booked as before; unpaid Zoho bills are covered';

  -- ── D ──
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268012'); if r not like 'P0001:This debit looks like%' then raise exception 'D FAIL: D1 debit booked: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268013'); if r not like 'P0001:This debit looks like%' then raise exception 'D FAIL: D2 debit booked: %', r; end if;
  -- two documents cover the two nearest debits; the third ₹118 is a payment Zoho does not have
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268014'); if r not like 'ok:%' then raise exception 'D FAIL: two documents blocked a third debit: %', r; end if;
  -- the owner matches the first expense to the first debit (Reconcile → match to the expense)
  update public.bank_transactions set matched_to_type = 'expense', matched_to_id = 'EXP-Z-2680-D1-1', match_confidence = 'manual' where id = 'cccccccc-0000-0000-0000-000000268012';
  update public.expenses set reconciled_txn_id = 'cccccccc-0000-0000-0000-000000268012' where id = 'EXP-Z-2680-D1-1';
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268013'); if r not like 'P0001:This debit looks like%(Bank Charges, paid 21 Oct 2026, ₹118)%' then raise exception 'D FAIL: the second debit booked while the second Zoho expense is open: %', r; end if;
  -- match the second, then un-match it: the guard follows the live state
  update public.bank_transactions set matched_to_type = 'expense', matched_to_id = 'EXP-Z-2680-D2-1', match_confidence = 'manual' where id = 'cccccccc-0000-0000-0000-000000268013';
  update public.expenses set reconciled_txn_id = 'cccccccc-0000-0000-0000-000000268013' where id = 'EXP-Z-2680-D2-1';
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268013'); if r not ilike '%already reconciled%' then raise exception 'D FAIL: a matched line: %', r; end if;
  update public.expenses set reconciled_txn_id = null where id = 'EXP-Z-2680-D2-1';
  update public.bank_transactions set matched_to_type = null, matched_to_id = null, match_confidence = null where id = 'cccccccc-0000-0000-0000-000000268013';
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268013'); if r not like 'P0001:This debit looks like%' then raise exception 'D FAIL: after un-matching, the guard did not come back: %', r; end if;
  raise notice 'D PASS: identical expenses — one line each, a real extra payment books, live state';

  -- ── F ── a later debit: covered by the reference (24 days), not covered with another UTR
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268021');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (Software, paid 01 Oct 2026, ₹4,000)%' then
    raise exception 'F FAIL: a debit 24 days later with Zoho''s own UTR was booked: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268022');
  if r not like 'ok:%' then raise exception 'F FAIL: a debit 24 days later with ANOTHER UTR was refused: %', r; end if;
  raise notice 'F PASS: a later debit is covered by the bank reference (60 days), not by the amount alone';

  -- ── G ── one Zoho payment, two bills: the total is covered; one bill''s amount too
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268023');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (R2680 Lawyer and 1 more bill, paid 05 Oct 2026, ₹8,100)%' then
    raise exception 'G FAIL: the debit of two bills paid together was booked: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268024');
  if r not like 'ok:%' then raise exception 'G FAIL: a debit of ONE bill''s own amount was refused (its payment is the total): %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268028');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (R2680 Auditor (one Zoho payment), paid 07 Oct 2026, ₹10,000)%' then
    raise exception 'G FAIL: the debit of a Zoho payment that also carries an advance was booked: %', r; end if;
  -- the bill inside that payment is not a unit by itself: an unrelated 9,000 debit books …
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268029');
  if r not like 'ok:%' then raise exception 'G FAIL: an unrelated debit of the bill''s own amount was refused (its payment is 10,000): %', r; end if;
  -- … and the real 10,000 debit is still refused afterwards
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268028');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (R2680 Auditor (one Zoho payment), paid 07 Oct 2026, ₹10,000)%' then
    raise exception 'G FAIL: the payment''s real debit became bookable: %', r; end if;
  raise notice 'G PASS: several bills / an advance in one Zoho payment — the payment''s amount is covered';

  -- ── E ── the other company's 3,000 Zoho expense never blocks this company's 3,000 debit
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268015'); if r not like 'ok:%' then raise exception 'E FAIL: another company''s document blocked: %', r; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000268002","role":"authenticated"}', true);
do $$
declare r text;
begin
  r := pg_temp.book('cccccccc-0000-0000-0000-000000268001');
  if r not like '42501:%' then raise exception 'E FAIL: a sales user was not refused by the role gate: %', r; end if;
  raise notice 'E PASS: own company only; role gate unchanged';
end $$;

rollback;
