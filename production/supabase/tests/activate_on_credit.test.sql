-- R-346 (7 Oct 2026): Activate now, pay later. Migration 20261007073000_activate_on_credit.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only:
--   begin; \i 20261007073000_activate_on_credit.sql; \i activate_on_credit.test.sql; rollback;
-- (the file itself does not begin/commit, so it can sit inside the migration's transaction).
--
-- Proves:
--   A. activate → GST invoice due today+15, every recurring line's subscription ACTIVE,
--      three owner tasks, quote marked; a second call is a no-op.
--   B. the payment afterwards → books against that invoice, the subscriptions are NOT created
--      again (fails on the old record_payment: 4 subscriptions instead of 2), the two
--      "Credit:" tasks close, the set-up task stays.
--   C. over the limit → a non-owner is refused; the owner must tick approve; then allowed.
--   D. a quote on a trial is refused; Pay later off is refused; only the owner changes it.

-- ── Fixtures (no jwt yet: system writes) ─────────────────────────────────────
select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000034601','R346 Co','r346@example.in','07','R346A');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000034601','owner346@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000034602','sales346@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000034601','dddddddd-0000-0000-0000-000000034601','owner346@example.in','Owner 346','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000034602','dddddddd-0000-0000-0000-000000034601','sales346@example.in','Sales 346','sales', now());

-- Customer A: defaults (pay later on, limit empty = Rs 50,000).
insert into public.customers (id, tenant_id, name, state_code, domain)
  values ('cccccccc-0000-0000-0000-000000034601','dddddddd-0000-0000-0000-000000034601','Acme 346','07','acme346.in');
-- Customer B: limit Rs 10,000.
insert into public.customers (id, tenant_id, name, state_code, credit_limit)
  values ('cccccccc-0000-0000-0000-000000034602','dddddddd-0000-0000-0000-000000034601','Big 346','07', 10000);

-- Quote A: Workspace 10 seats annual (Rs 10,000) + hosting monthly (Rs 500) → Rs 12,390 with GST.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
  values ('Q-R346-A','dddddddd-0000-0000-0000-000000034601','cccccccc-0000-0000-0000-000000034601','Acme 346',
          12390, 10500, 0, 18, 'accepted', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":1000,"commitment":"annual_yearly"},
            {"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"shop.acme346.in"}]'::jsonb);
-- Quote B: Rs 11,800 for customer B (limit 10,000).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
  values ('Q-R346-B','dddddddd-0000-0000-0000-000000034601','cccccccc-0000-0000-0000-000000034602','Big 346',
          11800, 10000, 0, 18, 'accepted', 'awaiting',
          '[{"name":"Google Workspace Business Standard","qty":5,"rate":2000,"commitment":"annual_yearly"}]'::jsonb);
-- Quote T: on a running trial.
insert into public.leads (id, tenant_id, company, stage, trial_started_at, trial_expires_at)
  values ('L-R346-T','dddddddd-0000-0000-0000-000000034601','Trial 346','trial', now(), now() + interval '14 days');
insert into public.quotes (id, tenant_id, customer_id, lead_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R346-T','dddddddd-0000-0000-0000-000000034601','cccccccc-0000-0000-0000-000000034601','L-R346-T','Acme 346',
          1180, 1000, 18, 'accepted', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":1,"rate":1000,"commitment":"annual_yearly"}]'::jsonb);

-- ── As the SALES user from here ──────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000034602","role":"authenticated"}', true);

-- A. Activate
do $$
declare r jsonb; v_inv record; n int; n_tasks int; v_q record; v_out int; v_owner uuid;
begin
  r := public.activate_quote_on_credit('Q-R346-A', 15);
  select * into v_inv from public.invoices where id = r->>'invoice_id';
  if v_inv.id is null then raise exception 'FAIL A: no invoice'; end if;
  if v_inv.due_date <> public.ist_today() + 15 then
    raise exception 'FAIL A: due_date % <> today+15 %', v_inv.due_date, public.ist_today() + 15; end if;
  if v_inv.amount <> 12390 or v_inv.status <> 'pending' then
    raise exception 'FAIL A: invoice amount/status % %', v_inv.amount, v_inv.status; end if;
  if v_inv.taxable_value <> 10500 or v_inv.tax_amount <> 1890 then
    raise exception 'FAIL A: tax changed % %', v_inv.taxable_value, v_inv.tax_amount; end if;

  select count(*) into n from public.subscriptions where quote_id = 'Q-R346-A' and status = 'active';
  if n <> 2 then raise exception 'FAIL A: expected 2 active subscriptions, got %', n; end if;
  if (select mrr from public.subscriptions where quote_id = 'Q-R346-A' and term_months = 12) <> 833 then
    raise exception 'FAIL A: annual mrr not 10000/12'; end if;
  if (select mrr from public.subscriptions where quote_id = 'Q-R346-A' and term_months = 1) <> 500 then
    raise exception 'FAIL A: monthly mrr not 500'; end if;
  select sum(outstanding_amount) into v_out from public.subscriptions where quote_id = 'Q-R346-A';
  if v_out <> 12390 then raise exception 'FAIL A: outstanding % <> 12390', v_out; end if;

  select count(*) into n_tasks from public.tasks where quote_id = 'Q-R346-A' and status = 'pending';
  if n_tasks <> 3 then raise exception 'FAIL A: expected 3 tasks, got %', n_tasks; end if;
  select owner_id into v_owner from public.tasks where quote_id = 'Q-R346-A' and title like 'Set up seats%';
  if v_owner <> 'aaaaaaaa-0000-0000-0000-000000034601' then raise exception 'FAIL A: task not for the owner'; end if;
  if (select (due_at at time zone 'Asia/Kolkata')::date from public.tasks where quote_id = 'Q-R346-A' and title like 'Credit: send%')
     <> public.ist_today() + 12 then raise exception 'FAIL A: payment-link task not due-3'; end if;
  if (select (due_at at time zone 'Asia/Kolkata')::date from public.tasks where quote_id = 'Q-R346-A' and title like 'Credit: payment not in%')
     <> public.ist_today() + 30 then raise exception 'FAIL A: stop-service task not due+15'; end if;

  select * into v_q from public.quotes where id = 'Q-R346-A';
  if v_q.credit_activated_at is null or v_q.credit_due_date <> public.ist_today() + 15
     or v_q.invoice_id <> v_inv.id or v_q.payment_status <> 'invoiced' then
    raise exception 'FAIL A: quote not marked'; end if;

  -- second call = no-op
  r := public.activate_quote_on_credit('Q-R346-A', 15);
  if not (r->>'already_active')::boolean then raise exception 'FAIL A: second call not idempotent'; end if;
  select count(*) into n from public.subscriptions where quote_id = 'Q-R346-A';
  if n <> 2 then raise exception 'FAIL A: second call created subscriptions'; end if;
  if (select count(*) from public.invoices where quote_id = 'Q-R346-A') <> 1 then raise exception 'FAIL A: second invoice'; end if;
  raise notice 'PASS A: invoice due today+15, 2 active subscriptions, 3 owner tasks, idempotent';
end $$;

-- B. Payment later: one set of subscriptions, invoice paid, credit tasks closed
do $$
declare n int; v_inv record;
begin
  perform public.record_payment('Q-R346-A', 12390, 'upi', 'r346-pay-1');
  select count(*) into n from public.subscriptions where quote_id = 'Q-R346-A';
  if n <> 2 then raise exception 'FAIL B: subscriptions created again — expected 2, got %', n; end if;
  select * into v_inv from public.invoices where quote_id = 'Q-R346-A';
  if v_inv.status <> 'paid' or v_inv.paid_amount <> 12390 then
    raise exception 'FAIL B: invoice not paid (% %)', v_inv.status, v_inv.paid_amount; end if;
  if (select sum(outstanding_amount) from public.subscriptions where quote_id = 'Q-R346-A') <> 0 then
    raise exception 'FAIL B: outstanding not cleared'; end if;
  if exists (select 1 from public.tasks where quote_id = 'Q-R346-A' and title like 'Credit:%' and status = 'pending') then
    raise exception 'FAIL B: credit tasks still open'; end if;
  if not exists (select 1 from public.tasks where quote_id = 'Q-R346-A' and title like 'Set up seats%' and status = 'pending') then
    raise exception 'FAIL B: set-up task was closed'; end if;
  raise notice 'PASS B: payment → same 2 subscriptions, invoice paid, credit tasks closed';
end $$;

-- C. Over the limit
do $$
declare r jsonb; ok boolean;
begin
  ok := false;
  begin
    perform public.activate_quote_on_credit('Q-R346-B', 15);
  exception when insufficient_privilege then
    ok := sqlerrm like '%Only the owner%';
  end;
  if not ok then raise exception 'FAIL C: non-owner was not refused over the limit'; end if;
  if exists (select 1 from public.subscriptions where quote_id = 'Q-R346-B') then raise exception 'FAIL C: refusal left subscriptions'; end if;
  raise notice 'PASS C1: sales user refused over limit';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000034601","role":"authenticated"}', true);

do $$
declare r jsonb; ok boolean;
begin
  ok := false;
  begin
    perform public.activate_quote_on_credit('Q-R346-B', 15, false);
  exception when check_violation then
    ok := sqlerrm like '%Approve over limit%';
  end;
  if not ok then raise exception 'FAIL C: owner without approve was not stopped'; end if;
  r := public.activate_quote_on_credit('Q-R346-B', 15, true);
  if not (r->>'over_limit')::boolean then raise exception 'FAIL C: over_limit not reported'; end if;
  if (select credit_over_limit_approved_by from public.quotes where id = 'Q-R346-B') <> 'aaaaaaaa-0000-0000-0000-000000034601' then
    raise exception 'FAIL C: approver not recorded'; end if;
  if (select count(*) from public.subscriptions where quote_id = 'Q-R346-B' and status = 'active') <> 1 then
    raise exception 'FAIL C: owner-approved activation made no subscription'; end if;
  raise notice 'PASS C2: owner must tick approve, then allowed and recorded';
end $$;

-- D. Trial quote refused; Pay later off refused; only the owner flips it
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000034602","role":"authenticated"}', true);
do $$
declare ok boolean;
begin
  ok := false;
  begin
    perform public.activate_quote_on_credit('Q-R346-T', 15);
  exception when check_violation then ok := sqlerrm like '%trial%';
  end;
  if not ok then raise exception 'FAIL D: trial quote was not refused'; end if;

  ok := false;
  begin
    update public.customers set credit_limit = 999999 where id = 'cccccccc-0000-0000-0000-000000034601';
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FAIL D: sales user raised a credit limit'; end if;
  -- unrelated edits by a non-owner still work
  update public.customers set notes = 'r346 note' where id = 'cccccccc-0000-0000-0000-000000034601';
  raise notice 'PASS D1: trial refused; non-owner cannot change credit terms';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000034601","role":"authenticated"}', true);
update public.customers set allow_pay_later = false where id = 'cccccccc-0000-0000-0000-000000034601';
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R346-C','dddddddd-0000-0000-0000-000000034601','cccccccc-0000-0000-0000-000000034601','Acme 346',
          1180, 1000, 18, 'accepted', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":1,"rate":1000,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare ok boolean := false;
begin
  begin
    perform public.activate_quote_on_credit('Q-R346-C', 15);
  exception when check_violation then ok := sqlerrm like '%Pay later is off%';
  end;
  if not ok then raise exception 'FAIL D: Pay later off was not refused'; end if;
  if exists (select 1 from public.invoices where quote_id = 'Q-R346-C') then raise exception 'FAIL D: refusal left an invoice'; end if;
  raise notice 'PASS D2: owner turned Pay later off; activation refused, nothing written';
end $$;
