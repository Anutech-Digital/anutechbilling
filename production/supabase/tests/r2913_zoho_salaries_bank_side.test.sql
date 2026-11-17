-- R-2913 (17 Nov 2026, p0 paisa, G-FY2526): a salary imported from Zoho (R-2911 — a PAID expense of
-- category Salaries with a zoho_doc_id, no bank line) joins the bank side like any imported expense;
-- Payroll's own Salaries rows (no zoho_doc_id) keep today's behaviour.
-- Migration 20261117164500_r2913_zoho_salaries_bank_side. Self-asserting, ONE transaction, rolled back.
--
--   A. With a vendor: bank_debit_vendor_open_items lists it as a recorded payment,
--      bank_debit_vendor_auto_match offers it for its debit, and reconcile_bank_debit_to_vendor
--      {source: recorded_payment} links it — no new expense row.
--   B. With no vendor: zoho_expense_bank_matches says 'sure' for its debit (a Payroll Salaries row of the
--      same amount is NOT a rival), suggest_bank_transaction_matches offers it as an 'expense', and
--      reconcile_bank_txn links it.
--   C. "Book as expense" on either debit is refused (R-2680's sentence; with the vendor typed R-1917's
--      "already recorded as paid" sentence) and writes nothing.
--   D. Payroll's Salaries row (zoho_doc_id null, paid by bank): not a recorded payment, not offered, not
--      suggested, matching it as a recorded payment is still refused, and its debit books as before. An
--      UNPAID Salaries row stays out of the open-bill list.
--   E. Repeat / undo: a matched salary cannot be matched again; a second debit of that amount books
--      (one document covers ONE line); un-reconcile opens the salary and the guard again.
--   F. A cash-paid Zoho salary and another company's Zoho salary never block; R-2677's Match all exact
--      still runs with these rows (a no-vendor Zoho salary's line goes to the drawer there).

begin;

create function pg_temp.r2913_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2913_supplier before insert on public.tenants for each row execute function pg_temp.r2913_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000291301','R2913 Co','r2913@example.in','07','R2913'),
  ('dddddddd-0000-0000-0000-000000291302','R2913 Other','r2913b@example.in','07','R2914');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000291301','owner2913@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000291303','owner2913b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000291301','dddddddd-0000-0000-0000-000000291301','owner2913@example.in','Owner 2913','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000291303','dddddddd-0000-0000-0000-000000291302','owner2913b@example.in','Owner 2913 B','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type) values
  ('bbbbbbbb-0000-0000-0000-000000291301','dddddddd-0000-0000-0000-000000291301','HDFC 4523','HDFC','current'),
  ('bbbbbbbb-0000-0000-0000-000000291303','dddddddd-0000-0000-0000-000000291302','Other bank','SBI','current');
insert into public.zoho_fy_import_batches (id, tenant_id, kind, fy) values
  ('eeeeeeee-0000-0000-0000-000000291301','dddddddd-0000-0000-0000-000000291301','expenses','2025-26'),
  ('eeeeeeee-0000-0000-0000-000000291302','dddddddd-0000-0000-0000-000000291302','expenses','2025-26');
insert into public.vendors (id, tenant_id, name, upi_id) values
  ('ffffffff-0000-0000-0000-000000291301','dddddddd-0000-0000-0000-000000291301','R2913 Prashant','r2913prashant@hdfcbank');

-- Imported from Zoho (as import_zoho_fy_purchases leaves a paid Zoho expense). Only the import may
-- write zoho_doc_id (tg_purchases_zoho_doc_guard) — its own switch, for this transaction.
select set_config('app.zoho_purchase_import', 'on', true);
insert into public.expenses (id, tenant_id, category, vendor_id, vendor_name, expense_date, amount, gst_paid, bill_type,
                             paid, paid_date, payment_method, bank_account_id, tds_amount, currency,
                             zoho_doc_id, zoho_leg, purchase_import_batch_id) values
  -- S1: salary to the vendor "R2913 Prashant", 17,000 paid 5 Jun 2025 from HDFC
  ('EXP-Z-2913-S1','dddddddd-0000-0000-0000-000000291301','Salaries','ffffffff-0000-0000-0000-000000291301','R2913 Prashant','2025-06-05',17000,0,'none',true,'2025-06-05','bank','bbbbbbbb-0000-0000-0000-000000291301',0,'INR','expenses:S1',1,'eeeeeeee-0000-0000-0000-000000291301'),
  -- S2: salary with NO vendor, 21,000 paid 5 Jul 2025 from HDFC
  ('EXP-Z-2913-S2','dddddddd-0000-0000-0000-000000291301','Salaries',null,null,'2025-07-05',21000,0,'none',true,'2025-07-05','bank','bbbbbbbb-0000-0000-0000-000000291301',0,'INR','expenses:S2',1,'eeeeeeee-0000-0000-0000-000000291301'),
  -- U1: an UNPAID Salaries row of the vendor (a Zoho bill re-categorised by hand) — no pay path, as before
  ('EXP-Z-2913-U1','dddddddd-0000-0000-0000-000000291301','Salaries','ffffffff-0000-0000-0000-000000291301','R2913 Prashant','2025-10-05',9000,0,'none',false,null,null,null,0,'INR','bills:U1',1,'eeeeeeee-0000-0000-0000-000000291301'),
  -- C1: a Zoho salary paid in CASH, 5,000
  ('EXP-Z-2913-C1','dddddddd-0000-0000-0000-000000291301','Salaries','ffffffff-0000-0000-0000-000000291301','R2913 Prashant','2025-09-05',5000,0,'none',true,'2025-09-05','cash','bbbbbbbb-0000-0000-0000-000000291301',0,'INR','expenses:C1',1,'eeeeeeee-0000-0000-0000-000000291301'),
  -- X1: the OTHER company's Zoho salary, 33,000
  ('EXP-Z-2913-X1','dddddddd-0000-0000-0000-000000291302','Salaries',null,null,'2025-09-10',33000,0,'none',true,'2025-09-10','bank','bbbbbbbb-0000-0000-0000-000000291303',0,'INR','expenses:X1',1,'eeeeeeee-0000-0000-0000-000000291302');
select set_config('app.zoho_purchase_import', '', true);
-- Payroll's own Salaries rows (no zoho_doc_id), paid by bank: P1 = the vendor-named 15,000;
-- P2 = 21,000 a day after S2 (the same amount — must not become a rival of S2).
insert into public.expenses (id, tenant_id, category, vendor_id, vendor_name, expense_date, amount, paid, paid_date, payment_method, bank_account_id) values
  ('EXP-P-2913-P1','dddddddd-0000-0000-0000-000000291301','Salaries','ffffffff-0000-0000-0000-000000291301','R2913 Prashant','2025-08-05',15000,true,'2025-08-05','bank','bbbbbbbb-0000-0000-0000-000000291301'),
  ('EXP-P-2913-P2','dddddddd-0000-0000-0000-000000291301','Salaries',null,null,'2025-07-06',21000,true,'2025-07-06','bank','bbbbbbbb-0000-0000-0000-000000291301');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  -- L1: S1's debit, two days later, naming the vendor's UPI id
  ('cccccccc-0000-0000-0000-000000291301','dddddddd-0000-0000-0000-000000291301','bbbbbbbb-0000-0000-0000-000000291301','2025-06-07','UPI-R2913PRASHANT-r2913prashant@hdfcbank-SAL MAY',17000,0,'csv_upload'),
  -- L2: S2's debit, same day
  ('cccccccc-0000-0000-0000-000000291302','dddddddd-0000-0000-0000-000000291301','bbbbbbbb-0000-0000-0000-000000291301','2025-07-05','NEFT QZX STAFF JUNE 21000',21000,0,'csv_upload'),
  -- L3: Payroll row P1's debit
  ('cccccccc-0000-0000-0000-000000291303','dddddddd-0000-0000-0000-000000291301','bbbbbbbb-0000-0000-0000-000000291301','2025-08-05','UPI-R2913PRASHANT-r2913prashant@hdfcbank-SAL JUL',15000,0,'csv_upload'),
  -- L5: a 5,000 debit on the cash salary's day; L6: a 33,000 debit on the other company's salary day
  ('cccccccc-0000-0000-0000-000000291305','dddddddd-0000-0000-0000-000000291301','bbbbbbbb-0000-0000-0000-000000291301','2025-09-05','ATM QZX 5000',5000,0,'csv_upload'),
  ('cccccccc-0000-0000-0000-000000291306','dddddddd-0000-0000-0000-000000291301','bbbbbbbb-0000-0000-0000-000000291301','2025-09-10','NEFT QZX 33000',33000,0,'csv_upload');

create function pg_temp.book(p_txn uuid, p_vendor text default null) returns text language plpgsql as $f$
begin
  return 'ok:' || public.book_bank_txn_as_expense(p_txn, 'Office Supplies', p_vendor, 0, null);
exception when others then
  return sqlstate || ':' || sqlerrm;
end $f$;
create function pg_temp.match_rp(p_txn uuid, p_doc text, p_amount integer) returns text language plpgsql as $f$
begin
  perform public.reconcile_bank_debit_to_vendor(p_txn, 'ffffffff-0000-0000-0000-000000291301'::uuid, null,
    jsonb_build_array(jsonb_build_object('source', 'recorded_payment', 'doc_id', p_doc, 'amount', p_amount)), null, 0, null, 0, null);
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $f$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000291301","role":"authenticated"}', true);

do $$
declare r text; n0 int; n int; v_rec record; v_got text;
begin
  select count(*) into n0 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000291301';

  -- ── A: listed and offered ──
  select string_agg(o.source || ':' || o.doc_id || ':' || o.amount_due || ':' || coalesce(o.paid_on::text, '-'), ' ' order by o.doc_id) into v_got
    from public.bank_debit_vendor_open_items('ffffffff-0000-0000-0000-000000291301') o;
  if v_got is distinct from 'recorded_payment:EXP-Z-2913-S1:17000:2025-06-05' then
    raise exception 'A/D FAIL: the vendor''s open items should be ONLY the Zoho salary S1 as a recorded payment (not Payroll''s P1, the cash C1 or the unpaid U1): %', v_got; end if;
  select string_agg(m.source || ':' || m.doc_id || ':' || m.amount, ' ') into v_got
    from public.bank_debit_vendor_auto_match('cccccccc-0000-0000-0000-000000291301') m;
  if v_got is distinct from 'recorded_payment:EXP-Z-2913-S1:17000' then
    raise exception 'A FAIL: the Zoho salary''s debit was not offered its recorded payment: %', v_got; end if;
  raise notice 'A PASS: a Zoho salary with a vendor is a recorded payment and is offered for its debit';

  -- ── B: no vendor — Match Zoho expenses + the line''s suggestions ──
  select m.status, m.txn_id, m.categories, m.cash into v_rec
    from public.zoho_expense_bank_matches('bbbbbbbb-0000-0000-0000-000000291301') m where m.zoho_doc_id = 'expenses:S2';
  if v_rec.status is distinct from 'sure' or v_rec.txn_id is distinct from 'cccccccc-0000-0000-0000-000000291302'
     or v_rec.categories is distinct from 'Salaries' or v_rec.cash is distinct from 21000 then
    raise exception 'B FAIL: the no-vendor Zoho salary is not a sure match of its debit (Payroll''s P2 must not be a rival): %', v_rec; end if;
  if not exists (select 1 from public.zoho_expense_bank_matches('bbbbbbbb-0000-0000-0000-000000291301') m where m.zoho_doc_id = 'expenses:S1')
     or exists (select 1 from public.zoho_expense_bank_matches(null) m where m.zoho_doc_id in ('expenses:C1', 'expenses:X1', 'bills:U1')) then
    raise exception 'B FAIL: S1 missing from Match Zoho expenses, or a cash / other-company / unpaid salary listed'; end if;
  select string_agg(s.match_type || ':' || s.match_id || ':' || s.match_confidence, ' ' order by s.match_id) into v_got
    from public.suggest_bank_transaction_matches('cccccccc-0000-0000-0000-000000291302') s;
  if v_got is distinct from 'expense:EXP-Z-2913-S2:exact' then
    raise exception 'B/D FAIL: the line''s suggestions should be the Zoho salary S2 only (never Payroll''s P2): %', v_got; end if;
  raise notice 'B PASS: a no-vendor Zoho salary is a sure Zoho match and is suggested on its line';

  -- ── F (read only, before anything is matched): R-2677 Match all exact still runs with these rows ──
  select string_agg(right(c.txn_id::text, 2) || '|' || c.status || '|' || coalesce(c.kind, '-'), ' ' order by c.txn_id) into v_got
    from public.bank_exact_match_candidates('bbbbbbbb-0000-0000-0000-000000291301', null, null, 'out') c
   where c.txn_id in ('cccccccc-0000-0000-0000-000000291301', 'cccccccc-0000-0000-0000-000000291302', 'cccccccc-0000-0000-0000-000000291303');
  if v_got is distinct from '01|ambiguous|recorded_payment 02|drawer|expense 03|none|-' then
    raise exception 'F FAIL: Match all exact — no Zoho salary line is ''exact'' there (S1: its recorded payment, to pick in the drawer; S2: drawer — R-2677''s own Salaries filter) and Payroll''s P1 line has nothing: %', v_got; end if;

  -- ── C: Book as expense is refused, nothing written ──
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291301');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (R2913 Prashant, paid 05 Jun 2025, ₹17,000). Match the line to it in Reconcile instead of booking a new expense, or the cost is counted twice.' then
    raise exception 'C FAIL: the Zoho salary''s debit (vendor) was booked again: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291301', 'R2913 Prashant');
  if r not like 'P0001:R2913 Prashant bill % — ₹17,000 is already recorded as paid (05 Jun 2025). Match this bank line to that payment with "Record payment" instead of booking a new expense%' then
    raise exception 'C FAIL: with the vendor typed R-1917''s sentence did not answer: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291302');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (Salaries, paid 05 Jul 2025, ₹21,000). Match the line to it in Reconcile%' then
    raise exception 'C FAIL: the no-vendor Zoho salary''s debit was booked again: %', r; end if;
  if (select count(*) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000291301') <> n0
     or exists (select 1 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000291301' and matched_to_type is not null) then
    raise exception 'C FAIL: a refusal wrote something'; end if;
  raise notice 'C PASS: Book as expense refuses a debit a Zoho salary already covers';

  -- ── D: Payroll''s own Salaries row keeps today''s behaviour ──
  if exists (select 1 from public.bank_debit_vendor_auto_match('cccccccc-0000-0000-0000-000000291303')) then
    raise exception 'D FAIL: Payroll''s Salaries row was offered as a vendor payment'; end if;
  if exists (select 1 from public.suggest_bank_transaction_matches('cccccccc-0000-0000-0000-000000291303') s where s.match_type = 'expense') then
    raise exception 'D FAIL: Payroll''s Salaries row was suggested as an expense'; end if;
  r := pg_temp.match_rp('cccccccc-0000-0000-0000-000000291303', 'EXP-P-2913-P1', 15000);
  if r not like '22023:Expense % was not paid from a bank — it cannot be matched to a bank line.' then
    raise exception 'D FAIL: Payroll''s Salaries row was matched as a recorded payment: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291303');
  if r not like 'ok:%' then raise exception 'D FAIL: Payroll''s Salaries row blocked Book as expense (it never did): %', r; end if;
  raise notice 'D PASS: Payroll''s Salaries rows stay out, as before';

  -- ── A (booking): the recorded payment is matched — the debit is tied, no new expense ──
  select count(*) into n from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000291301';
  r := pg_temp.match_rp('cccccccc-0000-0000-0000-000000291301', 'EXP-Z-2913-S1', 17000);
  if r <> 'ok' then raise exception 'A FAIL: the Zoho salary could not be matched to its debit: %', r; end if;
  if (select reconciled_txn_id from public.expenses where id = 'EXP-Z-2913-S1') is distinct from 'cccccccc-0000-0000-0000-000000291301'
     or (select matched_to_type from public.bank_transactions where id = 'cccccccc-0000-0000-0000-000000291301') is distinct from 'vendor_payment'
     or (select count(*) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000291301') <> n
     or (select category from public.expenses where id = 'EXP-Z-2913-S1') <> 'Salaries' then
    raise exception 'A FAIL: after the match the salary is not tied to its line, or a row was added / changed'; end if;
  if exists (select 1 from public.bank_debit_vendor_open_items('ffffffff-0000-0000-0000-000000291301')) then
    raise exception 'A FAIL: the matched salary is still an open item'; end if;
  -- B (booking): the no-vendor salary through the line''s suggestion
  perform public.reconcile_bank_txn('cccccccc-0000-0000-0000-000000291302', 'expense', 'EXP-Z-2913-S2', 'exact');
  if (select reconciled_txn_id from public.expenses where id = 'EXP-Z-2913-S2') is distinct from 'cccccccc-0000-0000-0000-000000291302' then
    raise exception 'B FAIL: the no-vendor Zoho salary was not tied to its line'; end if;
  raise notice 'A/B PASS: both salaries are matched to their debits, no new expense';

  -- ── E: repeat, a second debit, undo ──
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
    ('cccccccc-0000-0000-0000-000000291311','dddddddd-0000-0000-0000-000000291301','bbbbbbbb-0000-0000-0000-000000291301','2025-06-08','UPI-R2913PRASHANT-r2913prashant@hdfcbank-BONUS',17000,0,'csv_upload'),
    ('cccccccc-0000-0000-0000-000000291312','dddddddd-0000-0000-0000-000000291301','bbbbbbbb-0000-0000-0000-000000291301','2025-07-06','NEFT QZX STAFF EXTRA 21000',21000,0,'csv_upload');
  r := pg_temp.match_rp('cccccccc-0000-0000-0000-000000291311', 'EXP-Z-2913-S1', 17000);
  if r not like '%is not a payment waiting for its bank line%' then raise exception 'E FAIL: the matched salary was matched a second time: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291301');
  if r not ilike '%already reconciled%' then raise exception 'E FAIL: the matched line was booked: %', r; end if;
  -- one document covers ONE line: the second debits are other payments and book
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291311'); if r not like 'ok:%' then raise exception 'E FAIL: a second 17,000 debit was refused after the salary was matched: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291312'); if r not like 'ok:%' then raise exception 'E FAIL: a second 21,000 debit was refused after the salary was matched: %', r; end if;
  -- undo: the salary waits for its bank line again, and the guard is back (live state)
  perform public.unreconcile_bank_receipt('cccccccc-0000-0000-0000-000000291301', false);
  select o.source || ':' || o.doc_id || ':' || o.amount_due into v_got from public.bank_debit_vendor_open_items('ffffffff-0000-0000-0000-000000291301') o;
  if v_got is distinct from 'recorded_payment:EXP-Z-2913-S1:17000'
     or (select reconciled_txn_id from public.expenses where id = 'EXP-Z-2913-S1') is not null
     or not (select paid from public.expenses where id = 'EXP-Z-2913-S1') then
    raise exception 'E FAIL: after un-reconcile the salary is not a recorded payment again: %', v_got; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291301');
  if r not like 'P0001:This debit looks like a purchase already imported from Zoho (R2913 Prashant, paid 05 Jun 2025, ₹17,000)%' then
    raise exception 'E FAIL: after un-reconcile the guard did not come back: %', r; end if;
  raise notice 'E PASS: no second match, a second debit books, un-reconcile opens the salary and the guard again';

  -- ── F: cash-paid and other-company Zoho salaries never block ──
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291305'); if r not like 'ok:%' then raise exception 'F FAIL: a cash-paid Zoho salary blocked a bank debit: %', r; end if;
  r := pg_temp.book('cccccccc-0000-0000-0000-000000291306'); if r not like 'ok:%' then raise exception 'F FAIL: another company''s Zoho salary blocked: %', r; end if;
  raise notice 'F PASS: cash / other-company salaries never block; Match all exact runs';
  raise notice 'R-2913 PASS: Zoho-imported Salaries rows join the bank side; Payroll''s rows unchanged';
end $$;

rollback;
