-- R-1838 (24 Oct 2026): a bank credit is reconciled to WHAT the money is for — a renewal quote, an
-- add-seats quote, a new-product quote (subscription ticked / unticked), an unpaid invoice (with TDS),
-- or a new sale with seats × unit price — through the existing money RPCs in one transaction.
-- Migration 20261024131600_r1838_bank_credit_pay_for.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. bank_credit_open_items lists the customer's renewal / add-seats / new quotes and unpaid
--      invoice with the amount due, and nothing of another customer.
--   B. Renewal quote: the subscription rolls forward one term, an invoice is issued, the line is
--      reconciled to the payment, the payment carries the bank account and the BANK date.
--   C. Add-seats quote: recorded + reconciled, no new subscription.
--   D. New-product quote, "Create subscription" ticked with a start date (= bank date) and a chosen
--      renewal date → ONE subscription with exactly those dates.
--   E. Same, unticked → NO subscription, quote is_one_off, invoice still issued.
--   F. New sale 5 seats × ₹3,000 annual → quote 15,000 + 18% = 17,700, 1 subscription of 5 seats.
--   G. Unpaid invoice paid less 2% TDS → TDS receivable 200, invoice paid.
--   H. More money than due → the extra is customer credit (record_payment's own rule).
--   I. Guards: already-reconciled line, money-out line, another company's line, a no-company login
--      (28000) and a sales login (42501) are refused; nothing is written.

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
  ('dddddddd-0000-0000-0000-000000183801','R1838 Co','r1838@example.in','07','R1838'),
  ('dddddddd-0000-0000-0000-000000183802','R1838 Other','r1838b@example.in','07','R1838B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000183801','owner1838@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000183802','sales1838@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000183803','nocompany1838@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000183801','dddddddd-0000-0000-0000-000000183801','owner1838@example.in','Owner 1838','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000183802','dddddddd-0000-0000-0000-000000183801','sales1838@example.in','Sales 1838','sales', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000183801','dddddddd-0000-0000-0000-000000183801','Acme 1838','07','acme1838.in'),
  ('cccccccc-0000-0000-0000-000000183802','dddddddd-0000-0000-0000-000000183801','Other 1838','07','other1838.in');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000183801','dddddddd-0000-0000-0000-000000183801','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000183802','dddddddd-0000-0000-0000-000000183802','Other bank','SBI');

-- A running annual subscription renewing on 1 Nov 2026, with its renewal quote (10 × 3,000 + 18%).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  start_date, renewal_date, status, term_months, domain)
values ('eeeeeeee-0000-0000-0000-000000183801','dddddddd-0000-0000-0000-000000183801','cccccccc-0000-0000-0000-000000183801',
        'Acme 1838','Google Workspace Business Starter','google',10,2500,'2025-11-01','2026-11-01','active',12,'acme1838.in');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_renewal, extension_months,
                           renewal_subscription_id, renewal_term_date, created_date)
values ('Q-R1838-REN','dddddddd-0000-0000-0000-000000183801','cccccccc-0000-0000-0000-000000183801','Acme 1838',
        35400, 30000, 0, 18, 'sent', 'awaiting', 'yearly',
        '[{"name":"Google Workspace Business Starter","qty":10,"rate":3000,"commitment":"annual_yearly"}]'::jsonb,
        true, 12, 'eeeeeeee-0000-0000-0000-000000183801', '2026-11-01', '2026-10-15');
update public.subscriptions set renewal_quote_id = 'Q-R1838-REN' where id = 'eeeeeeee-0000-0000-0000-000000183801';

-- Add-seats (pro-rata) quote on the same subscription: 2 seats, 4,000 + 18% = 4,720.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_add_seats, add_seats_subscription_id, is_one_off, created_date)
values ('Q-R1838-ADD','dddddddd-0000-0000-0000-000000183801','cccccccc-0000-0000-0000-000000183801','Acme 1838',
        4720, 4000, 0, 18, 'accepted', 'awaiting', 'yearly',
        '[{"name":"Google Workspace Business Starter · 2 more seats (pro-rata)","qty":2,"rate":2000,"commitment":"annual_yearly"}]'::jsonb,
        true, 'eeeeeeee-0000-0000-0000-000000183801', false, '2026-10-16');

-- Two fresh new-product quotes (5 × 2,000 + 18% = 11,800 each) and a one-off quote for the invoice.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, created_date)
values
  ('Q-R1838-NEW1','dddddddd-0000-0000-0000-000000183801','cccccccc-0000-0000-0000-000000183801','Acme 1838',
   11800, 10000, 0, 18, 'sent', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Standard","qty":5,"rate":2000,"commitment":"annual_yearly","domain":"n1.acme1838.in"}]'::jsonb, '2026-10-17'),
  ('Q-R1838-NEW2','dddddddd-0000-0000-0000-000000183801','cccccccc-0000-0000-0000-000000183801','Acme 1838',
   11800, 10000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Standard","qty":5,"rate":2000,"commitment":"annual_yearly","domain":"n2.acme1838.in"}]'::jsonb, '2026-10-17'),
  ('Q-R1838-INV','dddddddd-0000-0000-0000-000000183801','cccccccc-0000-0000-0000-000000183801','Acme 1838',
   11800, 10000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Website setup","qty":1,"rate":10000,"one_time":true}]'::jsonb, '2026-10-10'),
  ('Q-R1838-OVR','dddddddd-0000-0000-0000-000000183801','cccccccc-0000-0000-0000-000000183801','Acme 1838',
   5900, 5000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Support hours","qty":1,"rate":5000,"one_time":true}]'::jsonb, '2026-10-10'),
  ('Q-R1838-OTH','dddddddd-0000-0000-0000-000000183801','cccccccc-0000-0000-0000-000000183802','Other 1838',
   11800, 10000, 0, 18, 'sent', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Standard","qty":5,"rate":2000,"commitment":"annual_yearly"}]'::jsonb, '2026-10-17');
update public.quotes set is_one_off = true where id in ('Q-R1838-INV', 'Q-R1838-OVR');

-- Money-in bank lines (and one money-out, one of another company).
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000183801','dddddddd-0000-0000-0000-000000183801','bbbbbbbb-0000-0000-0000-000000183801','2026-10-20','NEFT ACME 1838 RENEWAL',0,35400,'UTR1838REN','manual'),
  ('11111111-0000-0000-0000-000000183802','dddddddd-0000-0000-0000-000000183801','bbbbbbbb-0000-0000-0000-000000183801','2026-10-20','NEFT ACME 1838 SEATS',0,4720,'UTR1838ADD','manual'),
  ('11111111-0000-0000-0000-000000183803','dddddddd-0000-0000-0000-000000183801','bbbbbbbb-0000-0000-0000-000000183801','2026-10-18','NEFT ACME 1838 NEW1',0,11800,'UTR1838NEW1','manual'),
  ('11111111-0000-0000-0000-000000183804','dddddddd-0000-0000-0000-000000183801','bbbbbbbb-0000-0000-0000-000000183801','2026-10-19','NEFT ACME 1838 NEW2',0,11800,'UTR1838NEW2','manual'),
  ('11111111-0000-0000-0000-000000183805','dddddddd-0000-0000-0000-000000183801','bbbbbbbb-0000-0000-0000-000000183801','2026-10-21','NEFT ACME 1838 SALE',0,17700,'UTR1838SALE','manual'),
  ('11111111-0000-0000-0000-000000183806','dddddddd-0000-0000-0000-000000183801','bbbbbbbb-0000-0000-0000-000000183801','2026-10-21','NEFT ACME 1838 TDS',0,11600,'UTR1838TDS','manual'),
  ('11111111-0000-0000-0000-000000183807','dddddddd-0000-0000-0000-000000183801','bbbbbbbb-0000-0000-0000-000000183801','2026-10-21','NEFT ACME 1838 EXTRA',0,7000,'UTR1838OVR','manual'),
  ('11111111-0000-0000-0000-000000183808','dddddddd-0000-0000-0000-000000183801','bbbbbbbb-0000-0000-0000-000000183801','2026-10-21','RENT PAID',5000,0,'UTR1838OUT','manual'),
  ('11111111-0000-0000-0000-000000183809','dddddddd-0000-0000-0000-000000183802','bbbbbbbb-0000-0000-0000-000000183802','2026-10-21','OTHER CO',0,11800,'UTR1838X','manual');

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000183801","role":"authenticated"}', true);

-- The unpaid invoice for G (issued before the money arrives).
select public.generate_invoice('Q-R1838-INV');

-- A. open items
do $$
declare n int; r record;
begin
  select count(*) into n from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000183801');
  -- REN, ADD, NEW1, NEW2, OVR (quotes) + INV's invoice = 6
  if n is distinct from 6 then raise exception 'FAIL A: % open items (want 6)', n; end if;
  select * into r from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000183801') o where o.quote_id = 'Q-R1838-REN';
  if r.kind is distinct from 'renewal' or r.amount_due is distinct from 35400 or r.renewal_date is distinct from '2026-11-01' or r.seats is distinct from 10 then
    raise exception 'FAIL A: renewal row % % % %', r.kind, r.amount_due, r.renewal_date, r.seats; end if;
  select * into r from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000183801') o where o.quote_id = 'Q-R1838-ADD';
  if r.kind is distinct from 'add_seats' or r.amount_due is distinct from 4720 or r.subscription_id is distinct from 'eeeeeeee-0000-0000-0000-000000183801' then
    raise exception 'FAIL A: add-seats row % % %', r.kind, r.amount_due, r.subscription_id; end if;
  select * into r from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000183801') o where o.quote_id = 'Q-R1838-NEW1';
  if r.kind is distinct from 'new' or not r.makes_subscription or r.amount_due is distinct from 11800 then
    raise exception 'FAIL A: new row % % %', r.kind, r.makes_subscription, r.amount_due; end if;
  select * into r from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000183801') o where o.kind = 'invoice';
  if r.quote_id is distinct from 'Q-R1838-INV' or r.amount_due is distinct from 11800 or r.taxable_value is distinct from 10000 then
    raise exception 'FAIL A: invoice row % % %', r.quote_id, r.amount_due, r.taxable_value; end if;
  if exists (select 1 from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000183801') o where o.quote_id = 'Q-R1838-OTH') then
    raise exception 'FAIL A: another customer''s quote listed'; end if;
  raise notice 'PASS A: open items = renewal / add seats / new / one-off quotes + unpaid invoice, amounts due right';
end $$;

-- B. Renewal
do $$
declare r jsonb; s record; p record; t record;
begin
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183801', 'Q-R1838-REN');
  select * into s from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000183801';
  if s.renewal_date is distinct from '2027-11-01' then raise exception 'FAIL B: renewal date % (want 2027-11-01)', s.renewal_date; end if;
  if r->>'kind' is distinct from 'renewal' or not (r->>'renewal_rolled_forward')::boolean then raise exception 'FAIL B: result %', r; end if;
  if r->>'invoice_issued' is null then raise exception 'FAIL B: no invoice issued: %', r; end if;
  if (r->'subscriptions'->0->>'renewal_date') is distinct from '2027-11-01' then raise exception 'FAIL B: result sub %', r->'subscriptions'; end if;
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000183801';
  if t.matched_to_type is distinct from 'payment' or t.matched_to_id is distinct from r->>'payment_id' then raise exception 'FAIL B: line not reconciled % %', t.matched_to_type, t.matched_to_id; end if;
  select * into p from public.payments where id = (r->>'payment_id')::uuid;
  if p.bank_account_id is distinct from 'bbbbbbbb-0000-0000-0000-000000183801' or p.amount is distinct from 35400 or p.reference is distinct from 'UTR1838REN'
     or (p.received_at at time zone 'Asia/Kolkata')::date is distinct from '2026-10-20' then
    raise exception 'FAIL B: payment % % % %', p.bank_account_id, p.amount, p.reference, p.received_at; end if;
  if (select status from public.invoices where id = r->>'invoice_issued') is distinct from 'paid' then raise exception 'FAIL B: invoice not paid'; end if;
  if (select paid_date from public.invoices where id = r->>'invoice_issued') is distinct from '2026-10-20'::date then
    raise exception 'FAIL B: invoice paid_date % (want the bank date 2026-10-20)', (select paid_date from public.invoices where id = r->>'invoice_issued'); end if;
  /* Never the one-off "bank sale" note: un-reconcile must not be able to delete a renewal payment. */
  if p.notes is not distinct from 'Reconciled from bank receipt' then raise exception 'FAIL B: payment carries the deletable bank-sale note'; end if;
  /* The bank line IS the cash: no second (synthetic) bank line may appear for this payment. */
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000183801') is distinct from 8 then
    raise exception 'FAIL B: bank lines now % (want the 8 imported)', (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000183801'); end if;
  raise notice 'PASS B: renewal → subscription renews 2027-11-01, invoice % paid, line reconciled on the bank date', r->>'invoice_issued';
end $$;

-- C. Add seats
do $$
declare r jsonb; n int;
begin
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183802', 'Q-R1838-ADD');
  if r->>'kind' is distinct from 'add_seats' or (r->>'outstanding')::int is distinct from 0 then raise exception 'FAIL C: %', r; end if;
  select count(*) into n from public.subscriptions where quote_id = 'Q-R1838-ADD';
  if n is distinct from 0 then raise exception 'FAIL C: add-seats made % new subscription(s)', n; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000183802') is distinct from 'payment' then
    raise exception 'FAIL C: not reconciled'; end if;
  raise notice 'PASS C: add-seats paid + reconciled, no new subscription';
end $$;

-- D. New-product quote, subscription ticked, start = bank date, renewal chosen
do $$
declare r jsonb; s record; n int;
begin
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183803', 'Q-R1838-NEW1', null, 0, null, null,
                                            true, '2026-10-18', '2027-10-31');
  select count(*) into n from public.subscriptions where quote_id = 'Q-R1838-NEW1';
  if n is distinct from 1 then raise exception 'FAIL D: % subscriptions (want 1)', n; end if;
  select * into s from public.subscriptions where quote_id = 'Q-R1838-NEW1';
  if s.start_date is distinct from '2026-10-18' or s.renewal_date is distinct from '2027-10-31' or s.seats is distinct from 5 then
    raise exception 'FAIL D: sub % → % seats %', s.start_date, s.renewal_date, s.seats; end if;
  if r->>'invoice_issued' is null or (r->>'subscription_skipped')::boolean then raise exception 'FAIL D: %', r; end if;
  if (select is_one_off from public.quotes where id = 'Q-R1838-NEW1') then raise exception 'FAIL D: quote marked one-off'; end if;
  raise notice 'PASS D: ticked → 1 subscription 2026-10-18 → 2027-10-31, 5 seats, invoice %', r->>'invoice_issued';
end $$;

-- E. New-product quote, subscription UNticked
do $$
declare r jsonb; n int;
begin
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183804', 'Q-R1838-NEW2', null, 0, null, null, false);
  select count(*) into n from public.subscriptions where quote_id = 'Q-R1838-NEW2';
  if n is distinct from 0 then raise exception 'FAIL E: unticked still made % subscription(s)', n; end if;
  if not (r->>'subscription_skipped')::boolean or r->>'invoice_issued' is null then raise exception 'FAIL E: %', r; end if;
  if not (select is_one_off from public.quotes where id = 'Q-R1838-NEW2') then raise exception 'FAIL E: quote not one-off'; end if;
  raise notice 'PASS E: unticked → no subscription, invoice % issued, quote one-off', r->>'invoice_issued';
end $$;

-- F. New sale: 5 seats × ₹3,000 annual
do $$
declare r jsonb; q record; s record;
begin
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000183805', 'cccccccc-0000-0000-0000-000000183801',
         '[{"item_id":null,"name":"Google Workspace Business Plus","qty":5,"rate":3000,"cost":2500,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-10-21', null);
  select * into q from public.quotes where id = r->>'quote_id';
  if q.subtotal is distinct from 15000 or q.amount is distinct from 17700 or q.tax_rate is distinct from 18 or q.is_one_off or q.status is distinct from 'accepted' then
    raise exception 'FAIL F: quote % % % % %', q.subtotal, q.amount, q.tax_rate, q.is_one_off, q.status; end if;
  select * into s from public.subscriptions where quote_id = q.id;
  if s.seats is distinct from 5 or s.start_date is distinct from '2026-10-21' or s.renewal_date is distinct from '2027-10-21' then
    raise exception 'FAIL F: sub % seats % → %', s.seats, s.start_date, s.renewal_date; end if;
  if r->>'invoice_issued' is null or not (r->>'new_quote')::boolean or (r->>'quote_total')::int is distinct from 17700 then raise exception 'FAIL F: %', r; end if;
  raise notice 'PASS F: new sale 5 × 3,000 → quote 17,700, 1 subscription of 5 seats, invoice %', r->>'invoice_issued';
end $$;

-- G. Unpaid invoice, paid less 2% TDS (200 on 10,000)
do $$
declare r jsonb; v_inv text; t record;
begin
  select invoice_id into v_inv from public.quotes where id = 'Q-R1838-INV';
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183806', null, v_inv, 200, 2, '194J');
  select * into t from public.tds_receivable where payment_id = (r->>'payment_id')::uuid;
  if t.tds_amount is distinct from 200 or t.net_paid is distinct from 11600 or t.gross_amount is distinct from 10000 then
    raise exception 'FAIL G: tds % % %', t.tds_amount, t.net_paid, t.gross_amount; end if;
  if (select status from public.invoices where id = v_inv) is distinct from 'paid' then raise exception 'FAIL G: invoice not paid'; end if;
  if (select amount from public.payments where id = (r->>'payment_id')::uuid) is distinct from 11800 then raise exception 'FAIL G: payment amount'; end if;
  raise notice 'PASS G: invoice % paid with ₹200 TDS receivable, bank 11,600', v_inv;
end $$;

-- H. Overpayment → customer credit
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183807', 'Q-R1838-OVR');
  if (r->>'overpaid_credit')::int is distinct from 1100 then raise exception 'FAIL H: overpaid credit % (want 1100)', r->>'overpaid_credit'; end if;
  if not exists (select 1 from public.customer_credits where source_payment_id = (r->>'payment_id')::uuid and amount = 1100 and status = 'open') then
    raise exception 'FAIL H: no open customer credit of 1100'; end if;
  raise notice 'PASS H: ₹7,000 on a ₹5,900 quote → ₹1,100 customer credit';
end $$;

-- I. Guards
do $$
declare ok boolean;
begin
  ok := false;
  begin perform public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183801', 'Q-R1838-NEW1');
  exception when check_violation then ok := sqlerrm like '%already reconciled%'; end;
  if not ok then raise exception 'FAIL I: an already-reconciled line was not refused'; end if;

  ok := false;
  begin perform public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183808', 'Q-R1838-OTH');
  exception when invalid_parameter_value then ok := sqlerrm like '%money-in%'; end;
  if not ok then raise exception 'FAIL I: a money-out line was not refused'; end if;

  ok := false;
  begin perform public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183809', 'Q-R1838-OTH');
  exception when insufficient_privilege then ok := sqlerrm like '%not in your company%'; end;
  if not ok then raise exception 'FAIL I: another company''s line was not refused'; end if;

  ok := false;
  begin perform public.bank_credit_open_items('cccccccc-0000-0000-0000-000000183802');
        perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000183809', 'cccccccc-0000-0000-0000-000000183801',
                 '[{"name":"X","qty":1,"rate":100,"commitment":"one_time"}]'::jsonb);
  exception when insufficient_privilege then ok := sqlerrm like '%not in your company%'; end;
  if not ok then raise exception 'FAIL I: new sale on another company''s line was not refused'; end if;
  raise notice 'PASS I(owner): reconciled / money-out / other-company lines refused';
end $$;

-- A sales login: refused by the money-role gate (its own, not a nested one).
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000183802","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000183809', 'Q-R1838-OTH');
  exception when insufficient_privilege then ok := sqlerrm like '%reconcile a bank receipt%'; end;
  if not ok then raise exception 'FAIL I: sales role not refused by R-1838''s own gate'; end if;
  ok := false;
  begin perform public.bank_credit_open_items('cccccccc-0000-0000-0000-000000183801');
  exception when insufficient_privilege then ok := sqlerrm like '%reconcile a bank receipt%'; end;
  if not ok then raise exception 'FAIL I: sales role read open items'; end if;
  raise notice 'PASS I(sales): refused with 42501';
end $$;

-- A login with no company: fail closed (§17c).
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000183803","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000183809', 'cccccccc-0000-0000-0000-000000183802',
                 '[{"name":"X","qty":1,"rate":100,"commitment":"one_time"}]'::jsonb);
  exception when sqlstate '28000' then ok := sqlerrm like '%No company%'; end;
  if not ok then raise exception 'FAIL I: no-company login not refused (new sale)'; end if;
  ok := false;
  begin perform public.bank_credit_open_items('cccccccc-0000-0000-0000-000000183801');
  exception when sqlstate '28000' then ok := true; end;
  if not ok then raise exception 'FAIL I: no-company login read open items'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000183809') is not null then
    raise exception 'FAIL I: other company''s line changed'; end if;
  raise notice 'PASS I(no company): refused with 28000, nothing written';
end $$;

rollback;
