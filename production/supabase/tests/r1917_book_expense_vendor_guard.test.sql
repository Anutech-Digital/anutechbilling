-- R-1917 (25 Oct 2026, from the R-1906 audit B8): "Book as a new expense" on a vendor's bank line
-- while that vendor has an OPEN item of the same amount booked the cost twice (bill still open,
-- vendor cost doubled). book_bank_txn_as_expense now refuses and names the bill.
-- Migration: 20261025*_r1917_book_expense_vendor_guard.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. B8 (owner's path): Sharma's ₹11,800 expense bill PS-2 open, Sharma ₹11,800 line → Book as
--      expense REFUSED, the sentence names PS-2; no expense added, line still unreconciled.
--   B. Same vendor typed in other case / spaces → still refused.
--   C. Net of TDS: a ₹59,000 bill with ₹5,000 TDS on it, ₹54,000 line → refused.
--   D. COGS bill (vendor_bills) with ₹23,600 still due, ₹23,600 line → refused, names the bill.
--   E. A payment already recorded (Expenses → Mark paid, no bank line) of the line's amount → refused,
--      says it is already recorded.
--   F. A bill typed only as a name (no vendor record) → refused by the name.
--   G. Allowed: a different amount for the same vendor; a vendor with nothing open; no vendor;
--      another company's vendor of the same name never blocks.

begin;

create function pg_temp.r1917_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1917_supplier before insert on public.tenants for each row execute function pg_temp.r1917_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000191701','R1917 Co','r1917@example.in','07','R1917'),
  ('dddddddd-0000-0000-0000-000000191702','R1917 Other Co','r1917b@example.in','07','R1917B');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000191701','owner1917@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000191701','dddddddd-0000-0000-0000-000000191701','owner1917@example.in','Owner 1917','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000191701','dddddddd-0000-0000-0000-000000191701','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000191701','dddddddd-0000-0000-0000-000000191701','Sharma Associates','07AAKFS1917A1Z5','AAKFS1917A','Professional Services'),
  ('eeeeeeee-0000-0000-0000-000000191702','dddddddd-0000-0000-0000-000000191701','Google Cloud India','29AACCG1917B1Z9','AACCG1917B','COGS-Workspace'),
  ('eeeeeeee-0000-0000-0000-000000191703','dddddddd-0000-0000-0000-000000191701','Verma Contractors','07AAKFV1917A1Z5','AAKFV1917A','Repairs & Maintenance'),
  ('eeeeeeee-0000-0000-0000-000000191704','dddddddd-0000-0000-0000-000000191701','Gupta Printers','07AAKFG1917A1Z5','AAKFG1917A','Printing & Stationery'),
  -- another company's vendor with the SAME name and an open bill: must never block this company
  ('eeeeeeee-0000-0000-0000-000000191709','dddddddd-0000-0000-0000-000000191702','Kapoor Travels','07AAKFK1917A1Z5','AAKFK1917A','Travel');

insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method, tds_amount, tds_section) values
  -- A/B: Sharma's ₹11,800 bill PS-2, unpaid
  ('EXP-R1917-A','dddddddd-0000-0000-0000-000000191701','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000191701','2026-09-10',11800,1800,'gst','PS-2',false,null,0,null),
  -- C: Sharma's ₹59,000 bill PS-3 with ₹5,000 TDS already on it (cash due ₹54,000)
  ('EXP-R1917-C','dddddddd-0000-0000-0000-000000191701','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000191701','2026-09-12',59000,9000,'gst','PS-3',false,null,5000,'194J'),
  -- E: Verma's ₹7,080 bill marked paid on the Expenses page, no bank line yet
  ('EXP-R1917-E','dddddddd-0000-0000-0000-000000191701','Repairs & Maintenance','Verma Contractors','eeeeeeee-0000-0000-0000-000000191703','2026-09-20',7080,1080,'gst','VC-7',true,'bank_transfer',0,null),
  -- F: a name-only bill, no vendor record
  ('EXP-R1917-F','dddddddd-0000-0000-0000-000000191701','Repairs & Maintenance','Local Plumber',null,'2026-09-22',2500,0,'kaccha','LP-1',false,null,0,null),
  -- G: the other company's Kapoor Travels bill ₹4,000, unpaid
  ('EXP-R1917-G','dddddddd-0000-0000-0000-000000191702','Travel','Kapoor Travels','eeeeeeee-0000-0000-0000-000000191709','2026-09-22',4000,0,'kaccha','KT-1',false,null,0,null);
update public.expenses set paid_date = '2026-10-01' where id = 'EXP-R1917-E';

insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category, subtotal, igst, total, status, paid_amount) values
  ('BILL-R1917-D','dddddddd-0000-0000-0000-000000191701','eeeeeeee-0000-0000-0000-000000191702','Google Cloud India','29AACCG1917B1Z9','G-20','2026-09-05','2026-10-05','COGS-Workspace',20000,3600,23600,'unpaid',0);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191701','dddddddd-0000-0000-0000-000000191701','bbbbbbbb-0000-0000-0000-000000191701','2026-10-08','IMPS SHARMA ASSOCIATES PS-2',11800,0,'I1','csv_upload'),
  ('11111111-0000-0000-0000-000000191702','dddddddd-0000-0000-0000-000000191701','bbbbbbbb-0000-0000-0000-000000191701','2026-10-09','NEFT SHARMA ASSOCIATES PS-3',54000,0,'I2','csv_upload'),
  ('11111111-0000-0000-0000-000000191703','dddddddd-0000-0000-0000-000000191701','bbbbbbbb-0000-0000-0000-000000191701','2026-10-09','NEFT GOOGLE CLOUD INDIA',23600,0,'I3','csv_upload'),
  ('11111111-0000-0000-0000-000000191704','dddddddd-0000-0000-0000-000000191701','bbbbbbbb-0000-0000-0000-000000191701','2026-10-10','IMPS VERMA CONTRACTORS',7080,0,'I4','csv_upload'),
  ('11111111-0000-0000-0000-000000191705','dddddddd-0000-0000-0000-000000191701','bbbbbbbb-0000-0000-0000-000000191701','2026-10-10','UPI LOCAL PLUMBER',2500,0,'I5','csv_upload'),
  ('11111111-0000-0000-0000-000000191706','dddddddd-0000-0000-0000-000000191701','bbbbbbbb-0000-0000-0000-000000191701','2026-10-11','UPI SHARMA ASSOCIATES TEA',500,0,'I6','csv_upload'),
  ('11111111-0000-0000-0000-000000191707','dddddddd-0000-0000-0000-000000191701','bbbbbbbb-0000-0000-0000-000000191701','2026-10-11','UPI GUPTA PRINTERS',3000,0,'I7','csv_upload'),
  ('11111111-0000-0000-0000-000000191708','dddddddd-0000-0000-0000-000000191701','bbbbbbbb-0000-0000-0000-000000191701','2026-10-11','UPI ZOMATO',4000,0,'I8','csv_upload'),
  ('11111111-0000-0000-0000-000000191709','dddddddd-0000-0000-0000-000000191701','bbbbbbbb-0000-0000-0000-000000191701','2026-10-11','UPI KAPOOR TRAVELS',4000,0,'I9','csv_upload');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191701","role":"authenticated"}', true);

create function pg_temp.r1917_refusal(p_txn uuid, p_cat text, p_vendor text) returns text language plpgsql as $f$
begin
  perform public.book_bank_txn_as_expense(p_txn, p_cat, p_vendor, 0, null);
  return null;
exception when others then
  return sqlerrm;
end $f$;

-- ── A. B8, the owner's path ──────────────────────────────────────────────────
do $$
declare m text; n_exp int; v_type text;
begin
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191701', 'Professional Services', 'Sharma Associates');
  if m is null then raise exception 'A FAIL (B8): Book-as-expense accepted on a Sharma line while bill PS-2 (Rs 11,800) is open'; end if;
  if m not like '%PS-2%' or m not like '%Sharma Associates%' or m not like '%Record payment%' then
    raise exception 'A FAIL: the refusal must name the vendor, bill PS-2 and the Record payment way — got: %', m;
  end if;
  select count(*) into n_exp from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000191701' and reconciled_txn_id = '11111111-0000-0000-0000-000000191701';
  select matched_to_type into v_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000191701';
  if n_exp <> 0 or v_type is not null then raise exception 'A FAIL: refused but something was written (expenses %, line %)', n_exp, v_type; end if;
  raise notice 'A PASS: B8 refused — %', m;
end $$;

-- ── B. Same vendor, other case / spaces ─────────────────────────────────────
do $$
declare m text;
begin
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191701', 'Professional Services', '  sharma associates ');
  if m is null or m not like '%PS-2%' then raise exception 'B FAIL: "  sharma associates " slipped past the guard (%)', m; end if;
  if m not like 'Sharma Associates has an open bill PS-2 for ₹11,800.%' then
    raise exception 'B FAIL: the sentence must use the vendor''s own name and the amount in Indian format — got: %', m;
  end if;
  raise notice 'B PASS: vendor name matched ignoring case and spaces';
end $$;

-- ── C. Net of TDS ───────────────────────────────────────────────────────────
do $$
declare m text;
begin
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191702', 'Professional Services', 'Sharma Associates');
  if m is null or m not like '%PS-3%' then raise exception 'C FAIL: Rs 54,000 line = PS-3 after TDS was not refused (%)', m; end if;
  raise notice 'C PASS: net-of-TDS amount refused — %', m;
end $$;

-- ── D. COGS bill ────────────────────────────────────────────────────────────
do $$
declare m text;
begin
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191703', 'Other', 'Google Cloud India');
  if m is null or m not like '%G-20%' then raise exception 'D FAIL: COGS bill G-20 Rs 23,600 open, Book-as-expense not refused (%)', m; end if;
  raise notice 'D PASS: COGS bill refused — %', m;
end $$;

-- ── E. Payment already recorded (Mark paid) ─────────────────────────────────
do $$
declare m text;
begin
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191704', 'Repairs & Maintenance', 'Verma Contractors');
  if m is null or m not like '%VC-7%' or m not like '%already recorded%' then
    raise exception 'E FAIL: Mark-paid VC-7 Rs 7,080 + the real line booked as a second expense (%)', m;
  end if;
  raise notice 'E PASS: recorded payment refused — %', m;
end $$;

-- ── F. Name-only bill (no vendor record) ────────────────────────────────────
do $$
declare m text;
begin
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191705', 'Repairs & Maintenance', 'Local Plumber');
  if m is null or m not like '%LP-1%' then raise exception 'F FAIL: name-only bill LP-1 not guarded (%)', m; end if;
  raise notice 'F PASS: name-only bill refused';
end $$;

-- ── G. What stays allowed ───────────────────────────────────────────────────
do $$
declare m text; v_type text; n int;
begin
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191706', 'Staff Welfare', 'Sharma Associates');   -- ₹500, no ₹500 item
  if m is not null then raise exception 'G FAIL: a Rs 500 Sharma line (no Rs 500 item open) was refused: %', m; end if;
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191707', 'Printing & Stationery', 'Gupta Printers');   -- nothing open
  if m is not null then raise exception 'G FAIL: a vendor with nothing open was refused: %', m; end if;
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191708', 'Staff Welfare', null);   -- no vendor
  if m is not null then raise exception 'G FAIL: a line with no vendor was refused: %', m; end if;
  m := pg_temp.r1917_refusal('11111111-0000-0000-0000-000000191709', 'Travel', 'Kapoor Travels');   -- other company's bill
  if m is not null then raise exception 'G FAIL: another company''s Kapoor Travels bill blocked this company: %', m; end if;
  select count(*) into n from public.bank_transactions
   where id in ('11111111-0000-0000-0000-000000191706','11111111-0000-0000-0000-000000191707','11111111-0000-0000-0000-000000191708','11111111-0000-0000-0000-000000191709')
     and matched_to_type = 'expense';
  if n <> 4 then raise exception 'G FAIL: % of 4 allowed lines booked', n; end if;
  raise notice 'G PASS: other amount, nothing open, no vendor, other company — all still book as expenses';
end $$;

rollback;
