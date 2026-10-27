-- R-1985 (27 Oct 2026): a MONTHLY Workspace plan + a NEW domain, paid in ONE Razorpay payment,
-- with the domain on its own GST invoice (Pardeep, 26 Oct: "usi payment me, alag invoice").
--
-- Option A — no new SQL. The checkout raises TWO quotes for the one order:
--   Q1  the Workspace flex quote, exactly as a monthly order without a domain (R-1967/R-1974);
--   Q2  the domain quote — one one-time domain line carrying the registrant (R-1977's line).
-- One Razorpay order for the sum. When the money lands, TWO payments rows carry the SAME
-- Razorpay payment id: record_payment(Q1, Workspace share) and record_payment(Q2, domain share).
-- Q1 invoices itself through raise_subscription_billing (month 1, quote_id NULL — R-1974), Q2
-- through generate_invoice, as a cart domain does. This pins what the database does for that,
-- with the owner's numbers: Standard monthly ₹1,300 × 2 users = ₹2,600 + ₹468 GST; domain TEST
-- price ₹649 → ₹766 incl GST (₹649 + ₹117). One payment of ₹3,834.
--
-- Proves:
--   A. one payment reference → 2 payments rows (₹3,068 on Q1, ₹766 on Q2), ONE customer for both
--      (Q2 reuses the customer Q1's payment created from the same lead), no customer credit;
--   B. Q1's month-1 instalment invoice is PAID ₹3,068 (2,600 + 468), quote_id NULL;
--   C. Q2's domain invoice is issued by generate_invoice: ₹766, PAID, linked to Q2;
--   D. month 2 is PENDING ₹3,068, paid 0 — neither the Workspace nor the domain money is
--      credited to it a second time, and no customer credit exists;
--   E. a repeat record_payment of either share answers already_recorded (no third row);
--   F. the derived Trial Balance (Dr − Cr) does not move across the whole flow.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.

begin;

-- R-1643 / R-1803: a Tax Invoice needs the company's own GSTIN + address. Rolled back with the test.
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

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('19850000-0000-4000-8000-000000000001', 'R1985 Co', 'r1985@example.in', '07', 'R1985');
insert into auth.users (id, instance_id, aud, role, email) values
  ('19850000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1985-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('19850000-0000-4000-8000-0000000000a1', '19850000-0000-4000-8000-000000000001', 'r1985-user@example.in', 'owner');

-- The lead the checkout writes (state = place of supply, R-173).
insert into public.leads (id, tenant_id, company, contact_name, contact_email, contact_phone, plan, seats,
                          value, stage, source, domain, state_code, state)
  values ('L-R1985TEST', '19850000-0000-4000-8000-000000000001', 'R1985 Buyer Pvt Ltd', 'Asha Rao',
          'asha@r1985buyer.in', '9876543210', 'google-workspace-standard', 2, 2600, 'quote',
          'buy-workspace-direct', 'r1985buyer.in', '07', 'Delhi');

-- Q1: the Workspace flex quote, as the route writes it today.
insert into public.quotes (id, tenant_id, customer_name, lead_id, plan, seats, line_items, subtotal, total_cost,
                           discount_pct, tax_rate, amount, status, payment_status, domain, billing_cycle,
                           payment_reference)
  values ('TESTQ-R1985-WS', '19850000-0000-4000-8000-000000000001', 'R1985 Buyer Pvt Ltd', 'L-R1985TEST',
          'google-workspace-standard', 2,
          '[{"name":"Google Workspace Standard — monthly (flex)","qty":2,"rate":1300,"cost":0,"commitment":"monthly"}]'::jsonb,
          2600, 0, 0, 18, 3068, 'sent', 'awaiting', 'r1985buyer.in', 'monthly', 'order_R1985TEST');

-- Q2: the domain quote — R-1977's line (priceDomainLines + registrant), billed once.
insert into public.quotes (id, tenant_id, customer_name, lead_id, plan, seats, line_items, subtotal, total_cost,
                           discount_pct, tax_rate, amount, status, payment_status, domain, payment_reference)
  values ('TESTQ-R1985-DOM', '19850000-0000-4000-8000-000000000001', 'R1985 Buyer Pvt Ltd', 'L-R1985TEST',
          'domain-registration', 1,
          '[{"id":"d1","name":"Domain r1985buyer.in — registration, 1 year (TEST price)","qty":1,"rate":649,"cost":0,"domain":"r1985buyer.in","years":1,"registrant":{"firstName":"Asha","lastName":"Rao","email":"asha@r1985buyer.in"}}]'::jsonb,
          649, 0, 0, 18, 766, 'sent', 'awaiting', 'r1985buyer.in', 'order_R1985TEST');

/* Month 1 and month 2 of the Workspace subscription, as the server's billing schedule
   (sync-instalments) writes them — so as the table owner, not the user. Both due today so the
   RPC raises them; what is under test is the money, not the date. */
create function pg_temp.r1985_billings(v_sub uuid) returns void language plpgsql security definer as $fn$
begin
  update public.subscriptions set billing_cycle = 'monthly'::billing_cycle where id = v_sub;
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                            period_start, period_end, taxable_amount, tax_rate)
  values
    ('19850000-0000-4000-8000-0000000000b1', '19850000-0000-4000-8000-000000000001', v_sub,
     public.ist_today(), 1, public.ist_today(), public.ist_today(), (public.ist_today() + interval '1 month')::date, 2600, 18),
    ('19850000-0000-4000-8000-0000000000b2', '19850000-0000-4000-8000-000000000001', v_sub,
     (public.ist_today() + interval '1 month')::date, 1, public.ist_today(),
     (public.ist_today() + interval '1 month')::date, (public.ist_today() + interval '2 months')::date, 2600, 18);
end $fn$;
grant execute on function pg_temp.r1985_billings(uuid) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '19850000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);

/* Dr − Cr of the derived Trial Balance — same formula as tb_money_events_balanced.test.sql. */
create function pg_temp.tb_gap() returns bigint language plpgsql as $$
declare
  b record; p record;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_fy date;
  v_dues bigint; v_gst bigint; v_assets bigint; v_liab bigint; v_profit bigint;
begin
  select * into b from public.report_balance_sheet(null);
  v_fy := make_date(b.fy_start_year, 4, 1);
  select * into p from public.report_pnl(v_fy, v_today);
  v_dues := b.dues_salary_tds + b.dues_pf + b.dues_esi + b.dues_vendor_tds
          - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(b.dues_paid) x), 0);
  v_gst  := b.gst_output - b.bills_gst
          - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(b.tax_payments) x where x->>'kind' = 'gst'), 0);
  v_assets := b.cash_and_bank + b.undeposited_funds + b.receivables + b.project_receivable + b.tds_receivable
            + b.employee_loans + b.prepaid_advances + b.emi_unregistered_cost
            - b.expenses_paid_unbanked;
  v_liab   := b.credit_card_payable + b.payables + b.advances_from_customers + b.salary_payable + v_dues
            + b.reimbursements_payable + b.emi_loans_payable + b.business_loans_payable + v_gst
            + b.expenses_payable + b.salary_other_deductions;
  v_profit := (p.inv_taxable - p.cn_taxable + p.dn_taxable) - p.cogs - p.commissions
            - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(p.expense_groups) x), 0);
  return v_assets - v_liab - v_profit;
end $$;

do $$
declare
  g0 bigint; g1 bigint;
  r jsonb; r1 record; r2 record; i record;
  v_cust uuid; v_cust2 uuid; v_sub uuid; v_n int; v_credit int; v_dom_inv text;
begin
  g0 := pg_temp.tb_gap();

  -- The payment lands: two shares of ONE Razorpay payment, Workspace first (the webhook's order).
  r := public.record_payment('TESTQ-R1985-WS', 3068, 'razorpay', 'pay_R1985TEST', 'Razorpay payment.captured · order order_R1985TEST');
  v_cust := (r->>'customer_id')::uuid;
  r := public.record_payment('TESTQ-R1985-DOM', 766, 'razorpay', 'pay_R1985TEST', 'Razorpay payment.captured · order order_R1985TEST');
  v_cust2 := (r->>'customer_id')::uuid;

  -- A. two rows, one reference, one customer, no credit
  select count(*) into v_n from public.payments
   where tenant_id = '19850000-0000-4000-8000-000000000001' and reference = 'pay_R1985TEST' and status = 'received';
  if v_n <> 2 then raise exception 'A FAIL: % payments rows for the one Razorpay payment (want 2)', v_n; end if;
  if (select amount from public.payments where quote_id = 'TESTQ-R1985-WS' and reference = 'pay_R1985TEST') <> 3068
     or (select amount from public.payments where quote_id = 'TESTQ-R1985-DOM' and reference = 'pay_R1985TEST') <> 766 then
    raise exception 'A FAIL: shares are not 3,068 (Workspace) + 766 (domain)'; end if;
  if v_cust is null or v_cust2 is distinct from v_cust then
    raise exception 'A FAIL: Workspace payment customer % vs domain payment customer % (want one customer)', v_cust, v_cust2; end if;
  select count(*) into v_n from public.customers where tenant_id = '19850000-0000-4000-8000-000000000001';
  if v_n <> 1 then raise exception 'A FAIL: % customers for one buyer (want 1)', v_n; end if;
  raise notice 'A PASS: pay_R1985TEST → 2 payments (3,068 + 766), one customer %', v_cust;

  -- E. a repeat delivery of either share writes nothing more
  r := public.record_payment('TESTQ-R1985-WS', 3068, 'razorpay', 'pay_R1985TEST', null);
  if not coalesce((r->>'already_recorded')::boolean, false) then raise exception 'E FAIL: Workspace share recorded twice'; end if;
  r := public.record_payment('TESTQ-R1985-DOM', 766, 'razorpay', 'pay_R1985TEST', null);
  if not coalesce((r->>'already_recorded')::boolean, false) then raise exception 'E FAIL: domain share recorded twice'; end if;
  select count(*) into v_n from public.payments where reference = 'pay_R1985TEST' and status = 'received';
  if v_n <> 2 then raise exception 'E FAIL: % rows after the repeat (want 2)', v_n; end if;
  raise notice 'E PASS: a repeat of either share answers already_recorded; still 2 rows';

  -- B. month 1 of the Workspace subscription record_payment filed (R-1974's instalment path)
  select id into v_sub from public.subscriptions where quote_id = 'TESTQ-R1985-WS';
  if v_sub is null then raise exception 'B FAIL: no subscription filed for the Workspace quote'; end if;
  if exists (select 1 from public.subscriptions where quote_id = 'TESTQ-R1985-DOM' and vendor <> 'domain') then
    raise exception 'B FAIL: the domain quote filed a non-domain subscription'; end if;
  perform pg_temp.r1985_billings(v_sub);
  select * into r1 from public.raise_subscription_billing('19850000-0000-4000-8000-0000000000b1');
  select * into i from public.invoices where id = r1.invoice_id;
  if i.amount <> 3068 or i.status::text <> 'paid' or i.paid_amount <> 3068 or i.quote_id is not null then
    raise exception 'B FAIL: month 1 amount % status % paid % quote_id % (want 3068 paid 3068 NULL)',
      i.amount, i.status, i.paid_amount, i.quote_id; end if;
  raise notice 'B PASS: month 1 % — Rs % (2,600 + 468) paid, quote_id NULL', i.id, i.amount;

  -- C. the domain's own GST invoice, from the domain quote
  select (x->>'invoice_id') into v_dom_inv
    from (select to_jsonb(g) x from public.generate_invoice('TESTQ-R1985-DOM') g) s;
  select * into i from public.invoices where id = v_dom_inv;
  if i.id is null or i.amount <> 766 or i.quote_id is distinct from 'TESTQ-R1985-DOM' or i.status::text <> 'paid' then
    raise exception 'C FAIL: domain invoice % amount % quote % status % (want 766, TESTQ-R1985-DOM, paid)',
      i.id, i.amount, i.quote_id, i.status; end if;
  if i.customer_id is distinct from v_cust then
    raise exception 'C FAIL: domain invoice on customer % (want %)', i.customer_id, v_cust; end if;
  raise notice 'C PASS: domain invoice % — Rs % paid, on the domain quote', i.id, i.amount;

  -- D. month 2: invoiced, demanded, no money reused; no customer credit anywhere
  select * into r2 from public.raise_subscription_billing('19850000-0000-4000-8000-0000000000b2');
  select * into i from public.invoices where id = r2.invoice_id;
  if r2.invoice_id is null or r2.invoice_id = r1.invoice_id then
    raise exception 'D FAIL: month 2 not invoiced on its own (got %)', r2.invoice_id; end if;
  if i.amount <> 3068 or i.status::text <> 'pending' or coalesce(i.paid_amount, 0) <> 0 then
    raise exception 'D FAIL: month 2 amount % status % paid % (want 3068 pending 0 — money credited twice?)',
      i.amount, i.status, i.paid_amount; end if;
  select coalesce(sum(amount), 0) into v_credit from public.customer_credits where customer_id = v_cust;
  if v_credit <> 0 then raise exception 'D FAIL: Rs % customer credit appeared (want 0)', v_credit; end if;
  raise notice 'D PASS: month 2 % — Rs % pending, paid 0; no customer credit', i.id, i.amount;

  -- F. the books tally across the whole flow
  g1 := pg_temp.tb_gap();
  if g1 <> g0 then raise exception 'F FAIL: Trial Balance moved by % (Dr − Cr % → %)', g1 - g0, g0, g1; end if;
  raise notice 'F PASS: Trial Balance Dr − Cr unchanged (%)', g1;
end $$;

select 'R-1985 monthly + new domain, one payment split over two quotes: ALL PASS' as result;

rollback;
