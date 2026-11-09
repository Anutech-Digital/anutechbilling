-- R-2631 (9 Nov 2026, p1 money, owner's option A): on every NON-bank path the money is always recorded and
-- a NEW tax invoice is never dated in a GST-filed month — it is dated on the first open day instead.
-- Bank paths stay refused (R-2621 / R-2627). Migration 20261109200130_r2631_gst_filed_first_open_day.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
-- RED without the migration (A: the invoice is dated 23 Sep 2026, a filed month).
--
--   T1: GST filed up to Sep 2026 (owner, R-2621's setting).
--   A.  Desk receipt on 23 Sep + Generate invoice → receipt stays 23 Sep, invoice dated 1 Oct 2026 (number from
--       that date, due = date + terms); an invoice already dated in Sep is not touched.
--   A2. Generate invoice with no login (Razorpay webhook / online order path) on a 24 Sep receipt → 1 Oct.
--   B.  A part billed in parts whose bill date is 1 Sep (filed), paid now → its part invoice dated 1 Oct
--       (raise_subscription_billing via bill_subscription_instalment, the billing cron's call — no login).
--   D.  GSTR-1 for Oct 2026 also marked filed → 1 Nov; books lock only to 15 Oct (T2) → 16 Oct;
--       QRMP quarter Jul-Sep marked (T2) → a 10 Jul day → 16 Oct (past the quarter AND the lock).
--   E.  FY change (T3, GST filed up to Mar 2026): receipt 20 Mar 2026 → invoice 1 Apr 2026 with an FY 2026-27
--       number.
--   F.  Open month: a 5 Oct receipt → 5 Oct; a future day → today.
--   G.  Bank path unchanged: a 20 Sep bank line paying a quote with no invoice → still refused (R-2627).
--   A/A2 also: the settled invoice's paid date is the receipt day (23 / 24 Sep), not the shifted invoice date.
--   H.  A login asking invoice_date_for_receipt about another company → 42501; H3. a login with no company → 28000.
--   H2. Every month marked filed for 10+ years → plain error, no hang.

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
insert into auth.users (id, email) values
  ('b2631000-0000-0000-0000-0000000000a1', 'r2631-owner1@example.test'),
  ('b2631000-0000-0000-0000-0000000000a2', 'r2631-owner2@example.test'),
  ('b2631000-0000-0000-0000-0000000000a9', 'r2631-nocompany@example.test');   -- H3: a login with no company
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b2631000-0000-0000-0000-0000000000f1', 'R2631 Filed Co', 'r2631a@example.test', '07', 'R31A'),
  ('b2631000-0000-0000-0000-0000000000f2', 'R2631 Lock Co',  'r2631b@example.test', '07', 'R31B'),
  ('b2631000-0000-0000-0000-0000000000f3', 'R2631 FY Co',    'r2631c@example.test', '07', 'R31C'),
  ('b2631000-0000-0000-0000-0000000000f4', 'R2631 All Co',   'r2631d@example.test', '07', 'R31D');
update public.tenants set books_start_date = '2025-04-01' where id::text like 'b2631000-%';
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('b2631000-0000-0000-0000-0000000000a1', 'b2631000-0000-0000-0000-0000000000f1', 'r2631-owner1@example.test', 'Owner 1', 'owner', true, now() - interval '1 day'),
  ('b2631000-0000-0000-0000-0000000000a2', 'b2631000-0000-0000-0000-0000000000f3', 'r2631-owner2@example.test', 'Owner 3', 'owner', true, now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('b2631000-0000-0000-0000-0000000000c1', 'b2631000-0000-0000-0000-0000000000f1', 'R2631 Buyer', '07', 'India'),
  ('b2631000-0000-0000-0000-0000000000c2', 'b2631000-0000-0000-0000-0000000000f1', 'R2631 Parts', '07', 'India'),
  ('b2631000-0000-0000-0000-0000000000c3', 'b2631000-0000-0000-0000-0000000000f3', 'R2631 FY Buyer', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('b2631000-0000-0000-0000-0000000000d1', 'b2631000-0000-0000-0000-0000000000f1', 'Current', 'HDFC'),
  ('b2631000-0000-0000-0000-0000000000d3', 'b2631000-0000-0000-0000-0000000000f3', 'Current', 'HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2631000-0000-0000-0000-0000000000e1', 'b2631000-0000-0000-0000-0000000000f1', 'b2631000-0000-0000-0000-0000000000d1', '2026-09-20', 'NEFT CR R2631 G', 0, 1180, 'R2631UTRG', 'manual');

-- One-off accepted quotes, no invoice yet (₹1,000 + 18% = ₹1,180), terms 15 days.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           billing_cycle, line_items, is_one_off, created_date, payment_terms_days) values
  ('Q-R2631-A',  'b2631000-0000-0000-0000-0000000000f1', 'b2631000-0000-0000-0000-0000000000c1', 'R2631 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup A","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-09-01', 15),
  ('Q-R2631-A2', 'b2631000-0000-0000-0000-0000000000f1', 'b2631000-0000-0000-0000-0000000000c1', 'R2631 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup A2","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-09-01', 15),
  ('Q-R2631-F',  'b2631000-0000-0000-0000-0000000000f1', 'b2631000-0000-0000-0000-0000000000c1', 'R2631 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup F","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-10-01', 15),
  ('Q-R2631-G',  'b2631000-0000-0000-0000-0000000000f1', 'b2631000-0000-0000-0000-0000000000c1', 'R2631 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup G","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-09-01', 15),
  ('Q-R2631-E',  'b2631000-0000-0000-0000-0000000000f3', 'b2631000-0000-0000-0000-0000000000c3', 'R2631 FY Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup E","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-03-01', 15);

-- An invoice already dated in the filed month (must never move).
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items) values
  ('INV-R2631-OLD', 'b2631000-0000-0000-0000-0000000000f1', 'b2631000-0000-0000-0000-0000000000c1', 'R2631 Buyer',
   1180, 1180, 'pending', '2026-09-10', '2026-09-25', 1000, 180, 18, false, 0, 'tax_invoice', '[{"name":"Old","qty":1,"rate":1000}]'::jsonb);

-- B: a quarterly part whose bill date is 1 Sep 2026 (GST filed), paid late.
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
values ('Q-R2631-B', 'b2631000-0000-0000-0000-0000000000f1', 'R2631 Parts', 'b2631000-0000-0000-0000-0000000000c2', 18, 4720, 4000, 'quarterly', 'accepted',
        '[{"name":"Google Workspace Business Starter","qty":1,"rate":4000,"commitment":"annual_quarterly"}]'::jsonb);
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id, start_date, status)
values ('b2631000-0000-0000-0000-0000000000b1', 'b2631000-0000-0000-0000-0000000000f1', 'b2631000-0000-0000-0000-0000000000c2', 'R2631 Parts',
        'Google Workspace Business Starter', 'google'::vendor, 1, 333, 'quarterly'::billing_cycle, 'Q-R2631-B', '2026-09-01', 'active');
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
values ('b2631000-0000-0000-0000-0000000000b2', 'b2631000-0000-0000-0000-0000000000f1', 'b2631000-0000-0000-0000-0000000000b1',
        '2026-09-01', 1, '2026-09-01', '2026-09-01', '2026-11-30', 1000, 18);

-- T2: books lock only (no filed setting); T3: GST filed up to Mar 2026 (FY 2025-26); T4: every month marked.
update public.tenants set books_locked_until = '2026-10-15' where id = 'b2631000-0000-0000-0000-0000000000f2';
update public.tenants set gst_filed_through = '2026-03-31' where id = 'b2631000-0000-0000-0000-0000000000f3';
insert into public.compliance_log (tenant_id, obligation_key, period_key, filed_date)
select 'b2631000-0000-0000-0000-0000000000f4', 'gst_gstr1', to_char(m, 'YYYY-MM'), (m + interval '40 days')::date
  from generate_series(date '2015-01-01', date '2026-09-01', interval '1 month') m;

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

set local role authenticated;
select pg_temp.as_user('b2631000-0000-0000-0000-0000000000a1');

do $$
begin
  if public.set_gst_filed_through('2026-09-15') <> '2026-09-30' then raise exception 'SETUP: GST filed month not stored'; end if;
end $$;

-- ── A. Desk receipt on 23 Sep + Generate invoice → dated 1 Oct, receipt keeps 23 Sep ─────────────
do $$
declare r jsonb; v_inv record; v_paid date; v_want_no text;
begin
  r := public.record_desk_payment('Q-R2631-A', 1180, 'bank_transfer', 'R2631-A-DESK', 'Desk receipt',
         null, 0, '2026-09-23', 'b2631000-0000-0000-0000-0000000000d1');
  perform public.generate_invoice('Q-R2631-A');
  select i.* into v_inv from public.invoices i where i.quote_id = 'Q-R2631-A';
  if v_inv.id is null then raise exception 'FAIL A: no invoice raised (money must always be recorded and invoiced)'; end if;
  if v_inv.invoice_date is distinct from '2026-10-01' then
    raise exception 'FAIL A: invoice for a 23 Sep receipt (GST filed up to Sep) dated % (want 2026-10-01 — first open day)', v_inv.invoice_date; end if;
  if v_inv.due_date is distinct from '2026-10-16' then
    raise exception 'FAIL A: due date % (want 1 Oct + 15 days terms = 2026-10-16)', v_inv.due_date; end if;
  select (p.received_at at time zone 'Asia/Kolkata')::date into v_paid from public.payments p
   where p.quote_id = 'Q-R2631-A' and p.status = 'received';
  if v_paid is distinct from '2026-09-23' then raise exception 'FAIL A: the receipt moved to % (must keep 23 Sep)', v_paid; end if;
  if (select invoice_date from public.invoices where id = 'INV-R2631-OLD') <> '2026-09-10' then
    raise exception 'FAIL A: an existing Sep invoice was re-dated'; end if;
  if v_inv.status::text <> 'paid' or v_inv.paid_date is distinct from '2026-09-23' then
    raise exception 'FAIL A: settled invoice status % paid_date % (want paid on the receipt day 2026-09-23)', v_inv.status, v_inv.paid_date; end if;
  raise notice 'PASS A: 23 Sep receipt kept, invoice % dated 1 Oct 2026 (due 16 Oct), paid 23 Sep', v_inv.id;
end $$;

-- ── G. Bank path unchanged: a 20 Sep bank line on a quote with no invoice → still refused (R-2627) ──
do $$
declare v_msg text; ok boolean := false;
begin
  begin
    perform public.reconcile_bank_credit_to_item('b2631000-0000-0000-0000-0000000000e1', 'Q-R2631-G', null);
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'GST for Sep 2026 is already filed (%), so quote Q-R2631-G cannot get a new tax invoice dated 20 Sep 2026%Nothing was saved.%' then
    raise exception 'FAIL G: a bank line of a filed month paying a quote was not refused (%)', v_msg; end if;
  if exists (select 1 from public.invoices where quote_id = 'Q-R2631-G')
     or exists (select 1 from public.payments where quote_id = 'Q-R2631-G') then
    raise exception 'FAIL G: something was saved'; end if;
  raise notice 'PASS G: bank path still refused — %', v_msg;
end $$;

-- ── F. Open month and future day ──────────────────────────────────────────────────────────────
do $$
declare v_date date;
begin
  perform public.record_desk_payment('Q-R2631-F', 1180, 'bank_transfer', 'R2631-F-DESK', 'Desk receipt',
            null, 0, '2026-10-05', 'b2631000-0000-0000-0000-0000000000d1');
  perform public.generate_invoice('Q-R2631-F');
  select invoice_date into v_date from public.invoices where quote_id = 'Q-R2631-F';
  if v_date is distinct from '2026-10-05' then raise exception 'FAIL F: open-month receipt 5 Oct dated %', v_date; end if;
  if public.invoice_date_for_receipt('b2631000-0000-0000-0000-0000000000f1', public.ist_today() + 5) <> public.ist_today() then
    raise exception 'FAIL F: a future day was not clamped to today'; end if;
  raise notice 'PASS F: open month unchanged (5 Oct), future → today';
end $$;

-- ── H. Another company's id from a login → refused ───────────────────────────────────────────
do $$
declare ok boolean := false;
begin
  begin
    perform public.invoice_date_for_receipt('b2631000-0000-0000-0000-0000000000f2', '2026-09-01');
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FAIL H: another company''s invoice date was answered for this login'; end if;
  raise notice 'PASS H: another company refused';
end $$;

-- ── H3. A login with no company calling it directly → refused (§17c, fail-closed) ─────────────
select pg_temp.as_user('b2631000-0000-0000-0000-0000000000a9');
do $$
declare ok boolean := false;
begin
  begin
    perform public.invoice_date_for_receipt('b2631000-0000-0000-0000-0000000000f2', '2026-09-01');
  exception when invalid_authorization_specification then ok := true;
  end;
  if not ok then raise exception 'FAIL H3: a login with no company got another company''s invoice date'; end if;
  raise notice 'PASS H3: no-company login refused';
end $$;

-- ── E. FY change (T3, filed up to Mar 2026): 20 Mar receipt → 1 Apr 2026, FY 2026-27 number ──────
select pg_temp.as_user('b2631000-0000-0000-0000-0000000000a2');
do $$
declare v_inv record;
begin
  perform public.record_desk_payment('Q-R2631-E', 1180, 'bank_transfer', 'R2631-E-DESK', 'Desk receipt',
            null, 0, '2026-03-20', 'b2631000-0000-0000-0000-0000000000d3');
  perform public.generate_invoice('Q-R2631-E');
  select i.* into v_inv from public.invoices i where i.quote_id = 'Q-R2631-E';
  if v_inv.invoice_date is distinct from '2026-04-01' then
    raise exception 'FAIL E: 20 Mar 2026 receipt (GST filed up to Mar 2026) dated % (want 2026-04-01)', v_inv.invoice_date; end if;
  if v_inv.id !~ '-27-' then   -- INV-<code>-<FY end yy>-<n>: FY 2026-27 → -27-
    raise exception 'FAIL E: invoice number % is not from the FY 2026-27 series', v_inv.id; end if;
  raise notice 'PASS E: dated 1 Apr 2026, number % (FY 2026-27)', v_inv.id;
end $$;

-- ── From here: no login (cron / webhook / server) ──────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '', true);

-- ── A2. Generate invoice with no login on a 24 Sep receipt → 1 Oct ─────────────────────────────
do $$
declare v_date date;
begin
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2631000-0000-0000-0000-0000000000f1', 'Q-R2631-A2', 1180, 'razorpay', 'pay_R2631A2', 'received',
          timestamptz '2026-09-24 11:00:00+05:30');
  perform public.generate_invoice('Q-R2631-A2');
  select invoice_date into v_date from public.invoices where quote_id = 'Q-R2631-A2';
  if v_date is distinct from '2026-10-01' then raise exception 'FAIL A2: server-side invoice for a 24 Sep receipt dated % (want 2026-10-01)', v_date; end if;
  if (select paid_date from public.invoices where quote_id = 'Q-R2631-A2') is distinct from '2026-09-24' then
    raise exception 'FAIL A2: paid_date is not the receipt day 24 Sep'; end if;
  raise notice 'PASS A2: server path (Razorpay / online order) dated 1 Oct';
end $$;

-- ── B. Part with bill date 1 Sep (filed), paid late, billed by the cron's call → 1 Oct ─────────
do $$
declare r jsonb; v_date date;
begin
  perform public.record_payment('Q-R2631-B', 1180, 'upi', 'R2631-B-PAY');
  r := public.bill_subscription_instalment('b2631000-0000-0000-0000-0000000000b2', false);
  select invoice_date into v_date from public.invoices where id = r->>'invoice_id';
  if v_date is distinct from '2026-10-01' then
    raise exception 'FAIL B: part billed on 1 Sep (filed) dated % (want 2026-10-01): %', v_date, r; end if;
  raise notice 'PASS B: part invoice % dated 1 Oct 2026 (bill date 1 Sep is filed)', r->>'invoice_id';
end $$;

-- ── D. More filed marks and the books lock ───────────────────────────────────────────────────
do $$
declare v_date date;
begin
  insert into public.compliance_log (tenant_id, obligation_key, period_key, filed_date)
  values ('b2631000-0000-0000-0000-0000000000f1', 'gst_gstr1', '2026-10', '2026-11-08');
  v_date := public.invoice_date_for_receipt('b2631000-0000-0000-0000-0000000000f1', '2026-09-23');
  if v_date is distinct from '2026-11-01' then raise exception 'FAIL D: Sep filed + Oct GSTR-1 marked → % (want 2026-11-01)', v_date; end if;

  v_date := public.invoice_date_for_receipt('b2631000-0000-0000-0000-0000000000f2', '2026-09-10');
  if v_date is distinct from '2026-10-16' then raise exception 'FAIL D: books locked to 15 Oct → % (want 2026-10-16)', v_date; end if;

  insert into public.compliance_log (tenant_id, obligation_key, period_key, filed_date)
  values ('b2631000-0000-0000-0000-0000000000f2', 'gst_gstr1', '2026-q2', '2026-10-13');   -- QRMP Jul-Sep
  v_date := public.invoice_date_for_receipt('b2631000-0000-0000-0000-0000000000f2', '2026-07-10');
  if v_date is distinct from '2026-10-16' then raise exception 'FAIL D: Jul-Sep quarter marked + lock 15 Oct → % (want 2026-10-16)', v_date; end if;
  raise notice 'PASS D: Oct GSTR-1 mark → 1 Nov; lock → 16 Oct; quarter mark skipped';
end $$;

-- ── H2. Every month marked for 10+ years → a plain error, no hang ───────────────────────────
do $$
declare v_msg text; ok boolean := false;
begin
  begin
    perform public.invoice_date_for_receipt('b2631000-0000-0000-0000-0000000000f4', '2015-01-10');
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'Every month from Jan 2015 on is marked GST-filed%' then
    raise exception 'FAIL H2: no plain error for an endless filed run (%)', v_msg; end if;
  raise notice 'PASS H2: %', v_msg;
end $$;

select 'R-2631 first open day for a new invoice in a GST-filed month: ALL PASS' as result;

rollback;
