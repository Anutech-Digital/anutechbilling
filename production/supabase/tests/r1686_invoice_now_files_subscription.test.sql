-- R-1686 (19 Oct 2026): "Invoice now (before payment)" on an annual quote files the subscription,
-- with the unpaid invoice as its dues. Migration 20261019162652_r1686_invoice_now_files_subscriptions.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. generate_invoice on an accepted, unpaid annual quote → exactly 1 ACTIVE subscription (the
--      one-time line files none, R-1668), its outstanding = the invoice amount (so it is in
--      Payments → Subscription dues), a draft PO. Fails on the old generate_invoice: 0 subscriptions.
--   B. record_payment in full afterwards → still 1 subscription (no second set), dues 0.
--   C. quote_open_balance (used by "Re-create subscription from quote") = the unpaid invoice
--      amount, and goes down with a part payment; a no-company login is refused (§17c).
--   D. "Activate now, pay later" still files ONE set (generate_invoice nested inside it files none).
--   E. a recurring direct invoice still files nothing until paid (create_direct_invoice nested).
--   F. a quote PAID first, then invoiced → still the 1 subscription record_payment made.

begin;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000168601','R1686 Co','r1686@example.in','07','R1686');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000168601','owner1686@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000168602','nocompany1686@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000168601','dddddddd-0000-0000-0000-000000168601','owner1686@example.in','Owner 1686','owner', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code, domain)
  values ('cccccccc-0000-0000-0000-000000168601','dddddddd-0000-0000-0000-000000168601','Acme 1686','07','acme1686.in');

-- Annual Workspace 10 x 3,000 + one-time setup 2,000 = 32,000 + 18% = 37,760.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items)
values
  ('Q-R1686-A','dddddddd-0000-0000-0000-000000168601','cccccccc-0000-0000-0000-000000168601','Acme 1686',
   37760, 32000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Starter","qty":10,"rate":3000,"commitment":"annual_yearly"},
     {"name":"Setup and migration","qty":1,"rate":2000,"commitment":"one_time"}]'::jsonb),
  ('Q-R1686-C','dddddddd-0000-0000-0000-000000168601','cccccccc-0000-0000-0000-000000168601','Acme 1686',
   11800, 10000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Standard","qty":5,"rate":2000,"commitment":"annual_yearly","domain":"c.acme1686.in"}]'::jsonb),
  ('Q-R1686-D','dddddddd-0000-0000-0000-000000168601','cccccccc-0000-0000-0000-000000168601','Acme 1686',
   11800, 10000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Standard","qty":5,"rate":2000,"commitment":"annual_yearly","domain":"d.acme1686.in"}]'::jsonb),
  ('Q-R1686-F','dddddddd-0000-0000-0000-000000168601','cccccccc-0000-0000-0000-000000168601','Acme 1686',
   11800, 10000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Standard","qty":5,"rate":2000,"commitment":"annual_yearly","domain":"f.acme1686.in"}]'::jsonb);

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000168601","role":"authenticated"}', true);

-- A. Invoice now (before payment)
do $$
declare v_inv record; n int; v_sub record;
begin
  perform public.generate_invoice('Q-R1686-A');
  select * into v_inv from public.invoices where quote_id = 'Q-R1686-A';
  if v_inv.status <> 'pending' or v_inv.net_payable <> 37760 then
    raise exception 'FAIL A: invoice % / %', v_inv.status, v_inv.net_payable; end if;

  select count(*) into n from public.subscriptions where quote_id = 'Q-R1686-A';
  if n <> 1 then raise exception 'FAIL A: expected 1 subscription after Invoice now, got %', n; end if;
  select * into v_sub from public.subscriptions where quote_id = 'Q-R1686-A';
  if v_sub.status <> 'active' then raise exception 'FAIL A: status % (want active)', v_sub.status; end if;
  if v_sub.plan <> 'Google Workspace Business Starter' or v_sub.seats <> 10 or v_sub.term_months <> 12
     or v_sub.mrr <> 2500 or v_sub.renewal_date <> v_sub.start_date + interval '1 year' then
    raise exception 'FAIL A: subscription shape % % % % %', v_sub.plan, v_sub.seats, v_sub.term_months, v_sub.mrr, v_sub.renewal_date; end if;
  if v_sub.outstanding_amount <> 37760 then
    raise exception 'FAIL A: dues % <> invoice 37760', v_sub.outstanding_amount; end if;
  if not exists (select 1 from public.purchase_orders where subscription_id = v_sub.id and status = 'draft') then
    raise exception 'FAIL A: no draft PO'; end if;
  raise notice 'PASS A: Invoice now → 1 active subscription, dues % = invoice, one-time line filed none', v_sub.outstanding_amount;
end $$;

-- B. Full payment afterwards
do $$
declare n int; v_out int; v_inv record;
begin
  perform public.record_payment('Q-R1686-A', 37760, 'upi', 'r1686-pay-a');
  select count(*), sum(outstanding_amount) into n, v_out from public.subscriptions where quote_id = 'Q-R1686-A';
  if n <> 1 then raise exception 'FAIL B: payment filed subscriptions again — expected 1, got %', n; end if;
  if v_out <> 0 then raise exception 'FAIL B: dues % after full payment (want 0)', v_out; end if;
  select * into v_inv from public.invoices where quote_id = 'Q-R1686-A';
  if v_inv.status <> 'paid' then raise exception 'FAIL B: invoice %', v_inv.status; end if;
  raise notice 'PASS B: full payment → still 1 subscription, dues 0, invoice paid';
end $$;

-- C. quote_open_balance (the rebuild route's outstanding)
do $$
declare v int;
begin
  perform public.generate_invoice('Q-R1686-C');
  v := public.quote_open_balance('Q-R1686-C');
  if v <> 11800 then raise exception 'FAIL C: open balance % <> unpaid invoice 11800', v; end if;
  if (select outstanding_amount from public.subscriptions where quote_id = 'Q-R1686-C') <> 11800 then
    raise exception 'FAIL C: filed dues not 11800'; end if;
  perform public.record_payment('Q-R1686-C', 5000, 'upi', 'r1686-pay-c');
  v := public.quote_open_balance('Q-R1686-C');
  if v <> 6800 then raise exception 'FAIL C: open balance % after part payment (want 6800)', v; end if;
  if (select outstanding_amount from public.subscriptions where quote_id = 'Q-R1686-C') <> 6800 then
    raise exception 'FAIL C: dues not 6800 after part payment'; end if;
  if public.quote_open_balance('Q-R1686-A') <> 0 then raise exception 'FAIL C: paid quote has a balance'; end if;
  raise notice 'PASS C: quote_open_balance = unpaid invoice (11800 → 6800 after part payment)';
end $$;

-- D. Activate now, pay later: still one set
do $$
declare r jsonb; n int; v_out int;
begin
  r := public.activate_quote_on_credit('Q-R1686-D', 15, false, 'Old customer, pays on time');
  select count(*), sum(outstanding_amount) into n, v_out from public.subscriptions where quote_id = 'Q-R1686-D';
  if n <> 1 then raise exception 'FAIL D: pay later filed % subscriptions (want 1)', n; end if;
  if v_out <> 11800 then raise exception 'FAIL D: pay-later dues % (want 11800)', v_out; end if;
  perform public.record_payment('Q-R1686-D', 11800, 'upi', 'r1686-pay-d');
  select count(*), sum(outstanding_amount) into n, v_out from public.subscriptions where quote_id = 'Q-R1686-D';
  if n <> 1 or v_out <> 0 then raise exception 'FAIL D: after payment % subs, dues %', n, v_out; end if;
  raise notice 'PASS D: pay later → 1 subscription, dues 11800 → 0 on payment';
end $$;

-- E. Recurring direct invoice: unchanged (filed on payment)
do $$
declare r record; n int;
begin
  select * into r from public.create_direct_invoice('cccccccc-0000-0000-0000-000000168601',
    '[{"name":"Website AMC","qty":1,"rate":12000}]'::jsonb, 'r1686', true);
  select count(*) into n from public.subscriptions where quote_id = r.quote_id;
  if n <> 0 then raise exception 'FAIL E: direct invoice filed % subscriptions before payment', n; end if;
  raise notice 'PASS E: recurring direct invoice files nothing before payment';
end $$;

-- F. Paid first, invoiced afterwards → no second subscription
do $$
declare n int;
begin
  perform public.record_payment('Q-R1686-F', 11800, 'upi', 'r1686-pay-f');
  perform public.generate_invoice('Q-R1686-F');
  select count(*) into n from public.subscriptions where quote_id = 'Q-R1686-F';
  if n <> 1 then raise exception 'FAIL F: paid-then-invoiced has % subscriptions (want 1)', n; end if;
  raise notice 'PASS F: paid first then invoiced → 1 subscription';
end $$;

-- §17c: a login with no company may not read a quote's balance.
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000168602","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin
    perform public.quote_open_balance('Q-R1686-C');
  exception when sqlstate '28000' then
    ok := sqlerrm like 'No company on this login%';
  end;
  if not ok then raise exception 'FAIL G: no-company login was not refused'; end if;
  raise notice 'PASS G: quote_open_balance refuses a login with no company';
end $$;

select 'PASS' as r1686_invoice_now_files_subscription;

rollback;
