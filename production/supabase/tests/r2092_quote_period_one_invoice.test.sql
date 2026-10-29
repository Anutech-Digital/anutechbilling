-- R-2092 (29 Oct 2026): a quote with TWO subscriptions billed in parts gets ONE tax invoice per
-- period (one line per subscription), totalling the quote's own period amount; receipts are
-- allocated truthfully; a short payment invoices nothing (R-2048) and is owed ONCE.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Found on staging (29 Oct): a quote of Business Starter 57 × ₹3,200/yr + Business Standard
-- 13 × ₹11,000/yr, annual commitment billed quarterly (₹3,83,972 = 4 × ₹95,993), paid ₹95,933
-- for Q1 (a ₹60 typo). The billing path raised TWO Q1 tax invoices (₹53,808 + ₹42,186 =
-- ₹95,994, ₹1 too many) and marked BOTH paid, though the receipt was short; each subscription
-- showed ₹60 due (₹120 on the customer).
--
-- Rows are laid as lib/billing/plannedInstalments lays them (taxable from mrr: 15,200 × 3 =
-- 45,600; 11,917 × 3 = 35,751) and billed one subscription after the other, as
-- raiseDueInstalmentsForQuote and /api/cron/billing do.
--   A. Q1 paid in full (₹95,993), same state → ONE invoice ₹95,993, taxable 81,350, two lines,
--      both parts linked to it, paid, CGST+SGST; billing again (cron re-run) → the same invoice
--   B. Q1 paid short (₹95,933) → NO invoice (R-2048: the open sale quote is the request);
--      the subscriptions owe ₹60 in all (not ₹60 each)
--   C. Q1 paid short, customer "Invoice on due date" ON → ONE invoice ₹95,993, pending,
--      paid_amount ₹95,933 (₹60 due) — never 'paid'
--   D. Seller Delhi (07), customer Maharashtra (27) → IGST (inter_state) — and A is CGST+SGST
--   E. Q2 due, unpaid → ONE payment request (₹95,993, two lines); paying it → ONE Q2 invoice
--   F. A single-subscription quote → its own invoice exactly as before (amount per part)

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

-- Tenant 1: Maharashtra seller. Tenant 2: Delhi seller.
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000209201','R2092 MH Co','r2092a@example.in','27','R92A'),
         ('dddddddd-0000-0000-0000-000000209202','R2092 DL Co','r2092b@example.in','07','R92B');

-- Customers (all Maharashtra). n: 1 A, 2 B, 3 C (due-date ON), 4 D (Delhi seller), 5 E, 6 F
insert into public.customers (id, tenant_id, name, state_code, country, invoice_parts_on_due_date)
select ('cccccccc-0000-0000-0000-00000020920' || n)::uuid,
       case when n = 4 then 'dddddddd-0000-0000-0000-000000209202' else 'dddddddd-0000-0000-0000-000000209201' end::uuid,
       'Cust 2092-' || n, '27', 'India', n = 3
  from generate_series(1, 6) n;

-- Sale quotes: 2 lines, annual commitment billed quarterly; quote 6 is one line (Starter only).
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
select 'TESTQ-R2092-' || n, c.tenant_id, c.name, c.id, 18,
       case when n = 6 then 215232 else 383972 end,
       case when n = 6 then 182400 else 325400 end,
       'quarterly', 'accepted',
       case when n = 6 then
         '[{"name":"Google Workspace Business Starter","qty":57,"rate":3200,"commitment":"annual_quarterly"}]'::jsonb
       else
         '[{"name":"Google Workspace Business Starter","qty":57,"rate":3200,"commitment":"annual_quarterly"},
           {"name":"Google Workspace Business Standard","qty":13,"rate":11000,"commitment":"annual_quarterly"}]'::jsonb
       end
  from generate_series(1, 6) n
  join public.customers c on c.id = ('cccccccc-0000-0000-0000-00000020920' || n)::uuid;

-- Subscriptions: sN1 = Starter (created first), sN2 = Standard. Quote 6 has Starter only.
-- E's term began 100 days ago (Q2 due); the rest 7 days ago.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status, created_at)
select ('eeeeeeee-0000-0000-0000-0000002092' || n || k)::uuid, q.tenant_id, q.customer_id, q.customer_name,
       case k when 1 then 'Google Workspace Business Starter' else 'Google Workspace Business Standard' end,
       'google'::vendor, case k when 1 then 57 else 13 end, case k when 1 then 15200 else 11917 end,
       'quarterly'::billing_cycle, q.id,
       public.ist_today() - case when n = 5 then 100 else 7 end, 'active',
       now() - interval '1 hour' + make_interval(secs => k)
  from generate_series(1, 6) n
  cross join generate_series(1, 2) k
  join public.quotes q on q.id = 'TESTQ-R2092-' || n
 where not (n = 6 and k = 2);

-- Billing rows as plannedInstalments lays them (Q1, Q2 for E). Starter 45,600 / Standard 35,751.
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-000002092' || n || k || p)::uuid, s.tenant_id, s.id,
       s.start_date, p, (s.start_date + make_interval(months => 3 * (p - 1)))::date,
       (s.start_date + make_interval(months => 3 * (p - 1)))::date,
       (s.start_date + make_interval(months => 3 * p))::date,
       case k when 1 then 45600 else 35751 end, 18
  from generate_series(1, 6) n
  cross join generate_series(1, 2) k
  cross join generate_series(1, 2) p
  join public.subscriptions s on s.id = ('eeeeeeee-0000-0000-0000-0000002092' || n || k)::uuid
 where (p = 1 or n = 5);

-- The sale receipts (record_payment: the Record payment sheet / online / reconcile path).
do $$
begin
  perform public.record_payment('TESTQ-R2092-1', 95993, 'upi', 'R2092-PAY-1');
  perform public.record_payment('TESTQ-R2092-2', 95933, 'upi', 'R2092-PAY-2');
  perform public.record_payment('TESTQ-R2092-3', 95933, 'upi', 'R2092-PAY-3');
  perform public.record_payment('TESTQ-R2092-4', 95993, 'upi', 'R2092-PAY-4');
  perform public.record_payment('TESTQ-R2092-5', 95993, 'upi', 'R2092-PAY-5');
  perform public.record_payment('TESTQ-R2092-6', 53808, 'upi', 'R2092-PAY-6');
end $$;

do $$
declare
  r1 jsonb; r2 jsonb; v_i record; v_n integer; v_owed integer; v_req record; v_inv text;
begin
  -- A. paid in full → ONE invoice for the quote's Q1
  r1 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092111', false);
  r2 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092121', false);
  select count(distinct invoice_id) into v_n from public.subscription_billings
   where subscription_id in ('eeeeeeee-0000-0000-0000-000000209211', 'eeeeeeee-0000-0000-0000-000000209212');
  if v_n <> 1 or (select count(*) from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000209201') <> 1 then
    raise exception 'A FAIL: % invoice(s) for one quote period (want 1): % / %', v_n, r1, r2;
  end if;
  select * into v_i from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000209201';
  if v_i.amount <> 95993 or v_i.taxable_value <> 81350 or v_i.tax_amount <> 14643 then
    raise exception 'A FAIL: invoice % / taxable % / tax % (want 95,993 / 81,350 / 14,643)', v_i.amount, v_i.taxable_value, v_i.tax_amount;
  end if;
  if jsonb_array_length(v_i.line_items) <> 2
     or (select sum((l->>'rate')::int * (l->>'qty')::int) from jsonb_array_elements(v_i.line_items) l) <> 81350 then
    raise exception 'A FAIL: lines %', v_i.line_items;
  end if;
  /* The rupee of rounding comes off the line that was rounded up (13 × 11,000 ÷ 4 = 35,750). */
  if (select (l->>'rate')::int from jsonb_array_elements(v_i.line_items) l where l->>'name' like '%Standard') <> 35750
     or (select (l->>'rate')::int from jsonb_array_elements(v_i.line_items) l where l->>'name' like '%Starter') <> 45600
     or (select taxable_amount from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000002092121') <> 35750 then
    raise exception 'A FAIL: rounding on the wrong line: %', v_i.line_items;
  end if;
  if v_i.status::text <> 'paid' or v_i.paid_amount <> 95993 then
    raise exception 'A FAIL: % paid % (want paid 95,993)', v_i.status, v_i.paid_amount;
  end if;
  if v_i.inter_state is distinct from false then raise exception 'D FAIL: MH seller + MH customer got IGST'; end if;
  -- the cron again → nothing new
  r1 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092111', false);
  r2 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092121', false);
  if r1->>'action' <> 'already_invoiced' or r2->>'action' <> 'already_invoiced' or r2->>'invoice_id' <> v_i.id
     or (select count(*) from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000209201') <> 1 then
    raise exception 'A FAIL: re-run % / %', r1, r2;
  end if;
  raise notice 'A PASS: one Q1 invoice % ₹95,993, two lines, paid, CGST+SGST; re-run makes none', v_i.id;

  -- B. short → no invoice; owed once
  r1 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092211', false);
  r2 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092221', false);
  if (select count(*) from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000209202') <> 0 then
    raise exception 'B FAIL: a short Q1 got tax invoice(s): % / %', r1, r2;
  end if;
  if r1->>'action' <> 'request_open' or r1->>'quote_id' <> 'TESTQ-R2092-2' then raise exception 'B FAIL: %', r1; end if;
  /* What record_payment / activation write on every subscription of the sale: quote amount −
     received (₹3,83,972 − ₹95,933); the trigger caps it at the quote's owed figure. Staging
     showed ₹60 on EACH subscription. */
  update public.subscriptions set outstanding_amount = 288039 where quote_id = 'TESTQ-R2092-2';
  perform public.sync_split_outstanding('eeeeeeee-0000-0000-0000-000000209221');
  perform public.sync_split_outstanding('eeeeeeee-0000-0000-0000-000000209222');
  select coalesce(sum(outstanding_amount), 0) into v_owed from public.subscriptions
   where quote_id = 'TESTQ-R2092-2';
  if v_owed <> 60 then raise exception 'B FAIL: the subscriptions owe ₹% in all (want ₹60 once)', v_owed; end if;
  raise notice 'B PASS: short Q1 → no invoice; owed ₹60 once';

  -- C. short + Invoice on due date → ONE invoice, pending, ₹60 due
  r1 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092311', false);
  r2 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092321', false);
  select count(*) into v_n from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000209203';
  select * into v_i from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000209203' order by id limit 1;
  if v_n <> 1 or v_i.amount <> 95993 then raise exception 'C FAIL: % invoice(s), first ₹%', v_n, v_i.amount; end if;
  if v_i.status::text = 'paid' or v_i.paid_amount <> 95933 or coalesce(v_i.net_payable, v_i.amount) - v_i.paid_amount <> 60 then
    raise exception 'C FAIL: % paid_amount % (want not paid, 95,933, ₹60 due)', v_i.status, v_i.paid_amount;
  end if;
  raise notice 'C PASS: due-date customer → one invoice, partly paid, ₹60 due';

  -- D. Delhi seller, Maharashtra customer → IGST
  r1 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092411', false);
  r2 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092421', false);
  select * into v_i from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000209204' order by id limit 1;
  if v_i.inter_state is distinct from true then raise exception 'D FAIL: DL seller + MH customer not IGST'; end if;
  raise notice 'D PASS: other state → IGST; same state (A) → CGST+SGST';

  -- E. Q1 invoiced, Q2 due and unpaid → ONE request for both; paid → ONE Q2 invoice
  perform public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092511', false);
  perform public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092521', false);
  r1 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092512', false);
  r2 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092522', false);
  select count(*) into v_n from public.quotes where customer_id = 'cccccccc-0000-0000-0000-000000209205'
     and subscription_billing_id is not null;
  if v_n <> 1 then raise exception 'E FAIL: % payment requests for one Q2 (want 1): % / %', v_n, r1, r2; end if;
  select * into v_req from public.quotes where customer_id = 'cccccccc-0000-0000-0000-000000209205'
     and subscription_billing_id is not null;
  if v_req.amount <> 95993 or jsonb_array_length(v_req.line_items) <> 2 then
    raise exception 'E FAIL: request ₹% lines %', v_req.amount, v_req.line_items;
  end if;
  if r2->>'action' <> 'request_open' or r2->>'quote_id' <> v_req.id then raise exception 'E FAIL: second part %', r2; end if;
  perform public.record_payment(v_req.id, 95993, 'upi', 'R2092-PAY-5Q2');
  select count(distinct invoice_id), min(invoice_id) into v_n, v_inv from public.subscription_billings
   where id in ('bbbbbbbb-0000-0000-0000-000002092512', 'bbbbbbbb-0000-0000-0000-000002092522');
  if v_n <> 1 or v_inv is null then raise exception 'E FAIL: Q2 paid → % invoice(s)', v_n; end if;
  select * into v_i from public.invoices where id = v_inv;
  if v_i.amount <> 95993 or v_i.status::text <> 'paid' then raise exception 'E FAIL: Q2 invoice % %', v_i.amount, v_i.status; end if;
  if (select count(*) from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000209205') <> 2 then
    raise exception 'E FAIL: want 2 invoices (Q1, Q2) for the quote';
  end if;
  raise notice 'E PASS: one Q2 request ₹95,993 → paid → one Q2 invoice %', v_inv;

  -- F. single-subscription quote → as before
  r1 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092611', false);
  select * into v_i from public.invoices where id = r1->>'invoice_id';
  if v_i.amount <> 53808 or v_i.status::text <> 'paid' or jsonb_array_length(v_i.line_items) <> 1 then
    raise exception 'F FAIL: % % %', v_i.amount, v_i.status, v_i.line_items;
  end if;
  raise notice 'F PASS: single-subscription quote unchanged (₹53,808, paid, one line)';
end $$;

-- G. (migration 20261029052411, localhost 29 Oct) the Starter's parts laid, the Standard's NOT
--    yet (the order the billing code ran in on localhost) → the Starter is NOT billed alone:
--    'waiting', no invoice, the pending list says 'not_laid'; once the Standard's parts are laid,
--    ONE invoice for both. Same with ₹60 short: never a Starter-only 'Paid' invoice.
insert into public.customers (id, tenant_id, name, state_code, country)
  values ('cccccccc-0000-0000-0000-000000209207','dddddddd-0000-0000-0000-000000209201','Cust 2092-7','27','India');
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
select 'TESTQ-R2092-' || n, 'dddddddd-0000-0000-0000-000000209201', 'Cust 2092-7', 'cccccccc-0000-0000-0000-000000209207',
       18, 383972, 325400, 'quarterly', 'accepted',
       '[{"name":"Google Workspace Business Starter","qty":57,"rate":3200,"commitment":"annual_quarterly"},
         {"name":"Google Workspace Business Standard","qty":13,"rate":11000,"commitment":"annual_quarterly"}]'::jsonb
  from generate_series(7, 8) n;
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status, created_at)
select ('eeeeeeee-0000-0000-0000-0000002092' || n || k)::uuid, 'dddddddd-0000-0000-0000-000000209201',
       'cccccccc-0000-0000-0000-000000209207', 'Cust 2092-7',
       case k when 1 then 'Google Workspace Business Starter' else 'Google Workspace Business Standard' end,
       'google'::vendor, case k when 1 then 57 else 13 end, case k when 1 then 15200 else 11917 end,
       'quarterly'::billing_cycle, 'TESTQ-R2092-' || n, public.ist_today(), 'active', now()
  from generate_series(7, 8) n cross join generate_series(1, 2) k;
-- Only the Starters' Q1 is laid.
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-000002092' || n || '11')::uuid, 'dddddddd-0000-0000-0000-000000209201',
       ('eeeeeeee-0000-0000-0000-0000002092' || n || '1')::uuid,
       public.ist_today(), 1, public.ist_today(), public.ist_today(), (public.ist_today() + interval '3 months')::date, 45600, 18
  from generate_series(7, 8) n;

do $$
declare
  r jsonb; v_i record; v_n integer; v_st record;
begin
  perform public.record_payment('TESTQ-R2092-7', 95993, 'upi', 'R2092-PAY-7');
  perform public.record_payment('TESTQ-R2092-8', 95933, 'upi', 'R2092-PAY-8');

  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092711', false);
  if r->>'action' <> 'waiting' or exists (select 1 from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000209207') then
    raise exception 'G FAIL: the Starter was billed while the Standard had no parts: %', r;
  end if;
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092811', false);
  if r->>'action' <> 'waiting' then raise exception 'G FAIL (short): %', r; end if;
  select * into v_st from public.split_sale_invoice_status(array['TESTQ-R2092-7']);
  if v_st.state <> 'not_laid' then raise exception 'G FAIL: pending list says % (want not_laid)', v_st.state; end if;

  -- the Standard's Q1 is laid now (its billing run) → ONE invoice for the quote
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                            period_start, period_end, taxable_amount, tax_rate)
  select ('bbbbbbbb-0000-0000-0000-000002092' || n || '21')::uuid, 'dddddddd-0000-0000-0000-000000209201',
         ('eeeeeeee-0000-0000-0000-0000002092' || n || '2')::uuid,
         public.ist_today(), 1, public.ist_today(), public.ist_today(), (public.ist_today() + interval '3 months')::date, 35751, 18
    from generate_series(7, 8) n;
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092721', false);
  if r->>'action' <> 'invoice' then raise exception 'G FAIL: %', r; end if;
  select * into v_i from public.invoices where id = r->>'invoice_id';
  if v_i.amount <> 95993 or v_i.status::text <> 'paid' or jsonb_array_length(v_i.line_items) <> 2
     or (select count(distinct invoice_id) from public.subscription_billings
          where id in ('bbbbbbbb-0000-0000-0000-000002092711', 'bbbbbbbb-0000-0000-0000-000002092721')) <> 1 then
    raise exception 'G FAIL: % % %', v_i.amount, v_i.status, v_i.line_items;
  end if;
  select * into v_st from public.split_sale_invoice_status(array['TESTQ-R2092-7']);
  if v_st.state <> 'invoiced' or v_st.invoice_id <> v_i.id then raise exception 'G FAIL: pending list % %', v_st.state, v_st.invoice_id; end if;

  -- ₹60 short: still no invoice once both are laid; the pending list says 'short' for the quote's ₹95,993
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002092811', false);
  select count(*) into v_n from public.invoices where id in (select invoice_id from public.subscription_billings
    where subscription_id in ('eeeeeeee-0000-0000-0000-000000209281', 'eeeeeeee-0000-0000-0000-000000209282'));
  if v_n <> 0 or r->>'action' <> 'request_open' then raise exception 'G FAIL (short): % invoice(s), %', v_n, r; end if;
  select * into v_st from public.split_sale_invoice_status(array['TESTQ-R2092-8']);
  if v_st.state <> 'short' or v_st.gross <> 95993 then raise exception 'G FAIL (short): pending % %', v_st.state, v_st.gross; end if;
  raise notice 'G PASS: no Starter-alone invoice while the Standard is not laid; then one ₹95,993 invoice; short → none, pending ''short''';
end $$;

select 'R-2092 quote period one invoice: ALL PASS' as result;

rollback;
