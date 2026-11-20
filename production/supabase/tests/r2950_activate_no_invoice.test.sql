-- R-2950 (20 Nov 2026): "Activate now, pay later" without a GST invoice (database path).
-- A new 5-argument activate_quote_on_credit (p_issue_invoice, no defaults) holds the body; the
-- 4-argument function stays as a wrapper that calls it with p_issue_invoice => true.
-- Self-asserting, ONE transaction, rolled back. Local / test DB only.
--
-- Proves:
--   A. the old call shapes (2 and 4 arguments → the wrapper) and the new one with the flag true
--      or null → exactly the R-346 result: GST invoice, payment_status invoiced, three tasks
--      naming the invoice, no payment_due_date on the subscription.
--   B. flag false → subscriptions ACTIVE, draft POs, three tasks, credit_* stamps, ONE
--      provisioning row — and NO invoice row, no invoice number spent, invoice_id null,
--      payment_status awaiting, the whole quote outstanding on ONE subscription with
--      payment_due_date = the credit date. A second call (false or true) is a no-op.
--   C. flag false, first recurring line is a bulk line → the first bulk-domain subscription
--      carries the outstanding amount and the due date. Flag true keeps today's rows (0).
--   D. refusals on the no-invoice path: zero amount, more than 30 credit days, over the limit
--      (non-owner), annual without the owner's reason, split billing — nothing written.
--   E. another company's quote refused; exactly two functions (wrapper + body), both granted to
--      authenticated + service_role only (no anon, no PUBLIC); the 5-argument one has no default.
--   F. full payment later → subscriptions not filed again, outstanding 0, no second
--      provisioning row; the GST invoice raised afterwards is dated the payment day and paid.
--   G. part payment later → outstanding goes down, no invoice, payment_status partial.
begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address.
create function pg_temp.r2950_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2950_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r2950_fill_supplier();

-- ── Fixtures (no jwt yet: system writes) ─────────────────────────────────────
select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000295001','R2950 Co','r2950@example.in','07','R2950A'),
  ('dddddddd-0000-0000-0000-000000295002','R2950 Other Co','r2950b@example.in','07','R2950B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000295001','owner2950@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000295002','sales2950@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000295003','owner2950b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000295001','dddddddd-0000-0000-0000-000000295001','owner2950@example.in','Owner 2950','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000295002','dddddddd-0000-0000-0000-000000295001','sales2950@example.in','Sales 2950','sales', now()),
  ('aaaaaaaa-0000-0000-0000-000000295003','dddddddd-0000-0000-0000-000000295002','owner2950b@example.in','Owner 2950 B','owner', now());

-- Customer 1: roomy limit (the with-invoice quotes of A count against it). Customer 2: Rs 1,000.
insert into public.customers (id, tenant_id, name, state_code, domain, credit_limit) values
  ('cccccccc-0000-0000-0000-000000295001','dddddddd-0000-0000-0000-000000295001','Buyer 2950','07','buyer2950.in', 500000),
  ('cccccccc-0000-0000-0000-000000295002','dddddddd-0000-0000-0000-000000295001','Small 2950','07','small2950.in', 1000);

create function pg_temp.r2950_q(p_id text, p_amount int, p_subtotal int, p_lines jsonb,
                                p_customer uuid default 'cccccccc-0000-0000-0000-000000295001',
                                p_cycle text default null) returns void
language sql as $f$
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                             status, payment_status, billing_cycle, line_items)
  values (p_id, 'dddddddd-0000-0000-0000-000000295001', p_customer,
          (select name from public.customers where id = p_customer), p_amount, p_subtotal, 0, 18,
          'accepted', 'awaiting', coalesce(p_cycle, 'yearly')::public.billing_cycle, p_lines);
$f$;

-- A: four identical monthly quotes (Rs 500 + GST = Rs 590).
select pg_temp.r2950_q('Q-R2950-A1', 590, 500, '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"a1.buyer2950.in"}]');
select pg_temp.r2950_q('Q-R2950-A2', 590, 500, '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"a2.buyer2950.in"}]');
select pg_temp.r2950_q('Q-R2950-A3', 590, 500, '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"a3.buyer2950.in"}]');
select pg_temp.r2950_q('Q-R2950-A4', 590, 500, '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"a4.buyer2950.in"}]');
-- B: annual 10 seats (Rs 10,000) + monthly hosting (Rs 500) → Rs 12,390 with GST.
select pg_temp.r2950_q('Q-R2950-B', 12390, 10500,
  '[{"name":"Google Workspace Business Starter","qty":10,"rate":1000,"commitment":"annual_yearly"},
    {"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"shop.buyer2950.in"}]');
-- C: FIRST recurring line is a bulk line (2 domains), then a plain monthly line → Rs 6,254.
select pg_temp.r2950_q('Q-R2950-C', 6254, 5300,
  '[{"name":"Domain .in","qty":2,"rate":2400,"commitment":"annual_yearly","bulk":true,
     "domains":[{"domain":"c1-2950.in","seats":1},{"domain":"c2-2950.in","seats":1}]},
    {"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"c3.buyer2950.in"}]');
select pg_temp.r2950_q('Q-R2950-C2', 6254, 5300,
  '[{"name":"Domain .in","qty":2,"rate":2400,"commitment":"annual_yearly","bulk":true,
     "domains":[{"domain":"c4-2950.in","seats":1},{"domain":"c5-2950.in","seats":1}]},
    {"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"c6.buyer2950.in"}]');
-- D: refusals.
select pg_temp.r2950_q('Q-R2950-D1', 0, 0, '[{"name":"Free plan (billed monthly)","qty":1,"rate":0,"commitment":"monthly","domain":"d1.buyer2950.in"}]');
select pg_temp.r2950_q('Q-R2950-D2', 590, 500, '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"d2.buyer2950.in"}]');
select pg_temp.r2950_q('Q-R2950-D3', 2360, 2000, '[{"name":"Standard hosting (billed monthly)","qty":4,"rate":500,"commitment":"monthly","domain":"d3.small2950.in"}]',
  'cccccccc-0000-0000-0000-000000295002');
select pg_temp.r2950_q('Q-R2950-D4', 1180, 1000, '[{"name":"Google Workspace Business Starter","qty":1,"rate":1000,"commitment":"annual_yearly","domain":"d4.buyer2950.in"}]');
select pg_temp.r2950_q('Q-R2950-D5', 590, 500, '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"d5.buyer2950.in"}]',
  'cccccccc-0000-0000-0000-000000295001', 'quarterly');
-- G: part payment later.
select pg_temp.r2950_q('Q-R2950-G', 1180, 1000, '[{"name":"Standard hosting (billed monthly)","qty":2,"rate":500,"commitment":"monthly","domain":"g1.buyer2950.in"}]');

create function pg_temp.r2950_untouched(p_case text, p_quote text) returns void
language plpgsql as $f$
begin
  if exists (select 1 from public.subscriptions where quote_id = p_quote) then raise exception 'FAIL %: refusal left subscriptions', p_case; end if;
  if exists (select 1 from public.invoices where quote_id = p_quote) then raise exception 'FAIL %: refusal left an invoice', p_case; end if;
  if exists (select 1 from public.tasks where quote_id = p_quote) then raise exception 'FAIL %: refusal left tasks', p_case; end if;
  if exists (select 1 from public.provisioning_tasks where quote_id = p_quote) then raise exception 'FAIL %: refusal left a provisioning row', p_case; end if;
  if (select credit_activated_at from public.quotes where id = p_quote) is not null then raise exception 'FAIL %: refusal stamped the quote', p_case; end if;
end $f$;

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000295001","role":"authenticated"}', true);

-- A. Old call shapes (wrapper) and flag true / null = today's result
do $$
declare r jsonb; v_q record; v_inv record; v_id text; v_i int := 0;
begin
  foreach v_id in array array['Q-R2950-A1','Q-R2950-A2','Q-R2950-A3','Q-R2950-A4'] loop
    v_i := v_i + 1;
    if v_i = 1 then r := public.activate_quote_on_credit(v_id, 15);                          -- 2 arguments → the wrapper
    elsif v_i = 2 then r := public.activate_quote_on_credit(v_id, 15, false, null);          -- 4 arguments → the wrapper
    elsif v_i = 3 then r := public.activate_quote_on_credit(v_id, 15, false, null, true);    -- 5 arguments, true
    else r := public.activate_quote_on_credit(v_id, 15, false, null, null);                  -- 5 arguments, null = true
    end if;
    select * into v_inv from public.invoices where id = r->>'invoice_id';
    if v_inv.id is null then raise exception 'FAIL A%: no invoice', v_i; end if;
    if v_inv.quote_id <> v_id or v_inv.amount <> 590 or v_inv.status <> 'pending'
       or v_inv.taxable_value <> 500 or v_inv.tax_amount <> 90
       or v_inv.due_date <> public.ist_today() + 15 then
      raise exception 'FAIL A%: invoice not as R-346 (% % % % %)', v_i, v_inv.amount, v_inv.status, v_inv.taxable_value, v_inv.tax_amount, v_inv.due_date; end if;
    select * into v_q from public.quotes where id = v_id;
    if v_q.invoice_id <> v_inv.id or v_q.payment_status <> 'invoiced' or v_q.credit_activated_at is null
       or v_q.credit_due_date <> public.ist_today() + 15 or v_q.payment_terms_days <> 15 then
      raise exception 'FAIL A%: quote not marked as R-346', v_i; end if;
    if (select count(*) from public.subscriptions where quote_id = v_id and status = 'active') <> 1 then
      raise exception 'FAIL A%: expected 1 active subscription', v_i; end if;
    if (select outstanding_amount from public.subscriptions where quote_id = v_id) <> 590 then
      raise exception 'FAIL A%: outstanding not the whole quote', v_i; end if;
    if (select payment_due_date from public.subscriptions where quote_id = v_id) is not null then
      raise exception 'FAIL A%: payment_due_date written on the with-invoice path (today it is empty)', v_i; end if;
    if (select count(*) from public.tasks where quote_id = v_id and status = 'pending') <> 3 then
      raise exception 'FAIL A%: expected 3 tasks', v_i; end if;
    if (select count(*) from public.tasks where quote_id = v_id and notes like '%Invoice ' || v_inv.id || '%') <> 3 then
      raise exception 'FAIL A%: the tasks no longer name the invoice', v_i; end if;
    if (select count(*) from public.provisioning_tasks where quote_id = v_id) <> 1 then
      raise exception 'FAIL A%: expected 1 provisioning row', v_i; end if;
    if (select count(*) from public.purchase_orders po join public.subscriptions s on s.id = po.subscription_id where s.quote_id = v_id and po.status = 'draft') <> 1 then
      raise exception 'FAIL A%: expected 1 draft PO', v_i; end if;
    if (r->>'amount_due')::int <> 590 or (r->>'tasks_created')::int <> 3 or (r->>'subscriptions_created')::int <> 1 then
      raise exception 'FAIL A%: result changed %', v_i, r; end if;
  end loop;
  raise notice 'PASS A: 2-argument, 4-argument, flag true and flag null all give the R-346 result (invoice, invoiced, 3 tasks naming it)';
end $$;

-- B. Flag false: subscription only
do $$
declare r jsonb; v_q record; n int; v_series_before int; v_series_after int; v_sub record;
begin
  select coalesce(sum(last_number), 0) into v_series_before from public.document_series
   where tenant_id = 'dddddddd-0000-0000-0000-000000295001' and doc_type = 'invoice';
  r := public.activate_quote_on_credit('Q-R2950-B', 15, false, 'Customer of 6 years, always pays', false);

  if exists (select 1 from public.invoices where quote_id = 'Q-R2950-B') then raise exception 'FAIL B: an invoice row was written'; end if;
  select coalesce(sum(last_number), 0) into v_series_after from public.document_series
   where tenant_id = 'dddddddd-0000-0000-0000-000000295001' and doc_type = 'invoice';
  if v_series_after <> v_series_before then raise exception 'FAIL B: an invoice number was spent (% → %)', v_series_before, v_series_after; end if;
  if r->>'invoice_id' is not null then raise exception 'FAIL B: result carries an invoice id %', r->>'invoice_id'; end if;
  if (r->>'amount_due')::int <> 12390 or (r->>'due_date')::date <> public.ist_today() + 15
     or (r->>'subscriptions_created')::int <> 2 or (r->>'tasks_created')::int <> 4 or (r->>'already_active')::boolean then  -- R-2951: 4 tasks
    raise exception 'FAIL B: result %', r; end if;

  select * into v_q from public.quotes where id = 'Q-R2950-B';
  if v_q.invoice_id is not null then raise exception 'FAIL B: quotes.invoice_id set'; end if;
  if v_q.payment_status <> 'awaiting' then raise exception 'FAIL B: payment_status % (want awaiting)', v_q.payment_status; end if;
  if v_q.credit_activated_at is null or v_q.credit_activated_by <> 'aaaaaaaa-0000-0000-0000-000000295001'
     or v_q.credit_due_date <> public.ist_today() + 15
     or v_q.credit_annual_override_reason <> 'Customer of 6 years, always pays' then
    raise exception 'FAIL B: credit stamps missing'; end if;

  select count(*) into n from public.subscriptions where quote_id = 'Q-R2950-B' and status = 'active';
  if n <> 2 then raise exception 'FAIL B: expected 2 active subscriptions, got %', n; end if;
  if (select mrr from public.subscriptions where quote_id = 'Q-R2950-B' and term_months = 12) <> 833
     or (select mrr from public.subscriptions where quote_id = 'Q-R2950-B' and term_months = 1) <> 500 then
    raise exception 'FAIL B: subscription amounts changed'; end if;
  select count(*) into n from public.subscriptions where quote_id = 'Q-R2950-B' and outstanding_amount > 0;
  if n <> 1 then raise exception 'FAIL B: outstanding on % subscriptions (want 1)', n; end if;
  select * into v_sub from public.subscriptions where quote_id = 'Q-R2950-B' and outstanding_amount > 0;
  if v_sub.outstanding_amount <> 12390 then raise exception 'FAIL B: outstanding % <> 12390', v_sub.outstanding_amount; end if;
  if v_sub.payment_due_date::date is distinct from public.ist_today() + 15 then
    raise exception 'FAIL B: payment_due_date % <> credit date', v_sub.payment_due_date; end if;
  if exists (select 1 from public.subscriptions where quote_id = 'Q-R2950-B' and outstanding_amount = 0 and payment_due_date is not null) then
    raise exception 'FAIL B: a due date on a subscription that owes nothing'; end if;

  if (select count(*) from public.purchase_orders po join public.subscriptions s on s.id = po.subscription_id
       where s.quote_id = 'Q-R2950-B' and po.status = 'draft') <> 2 then raise exception 'FAIL B: expected 2 draft POs'; end if;

  if (select count(*) from public.tasks where quote_id = 'Q-R2950-B' and status = 'pending') <> 4 then raise exception 'FAIL B: expected 4 tasks (R-2951: + issue the GST invoice)'; end if;
  if exists (select 1 from public.tasks where quote_id = 'Q-R2950-B' and (notes is null or notes not like '%Q-R2950-B%' or notes ~ 'Invoice\s*(\(|,|was|$)')) then
    raise exception 'FAIL B: a task note is empty or names an invoice that does not exist'; end if;
  if (select count(*) from public.tasks where quote_id = 'Q-R2950-B' and title like 'Credit:%') <> 3  -- R-2951: + issue the GST invoice
     or not exists (select 1 from public.tasks where quote_id = 'Q-R2950-B' and title like 'Set up seats%') then
    raise exception 'FAIL B: task titles changed'; end if;
  if (select (due_at at time zone 'Asia/Kolkata')::date from public.tasks where quote_id = 'Q-R2950-B' and title like 'Credit: send%') <> public.ist_today() + 12
     or (select (due_at at time zone 'Asia/Kolkata')::date from public.tasks where quote_id = 'Q-R2950-B' and title like 'Credit: payment not in%') <> public.ist_today() + 30 then
    raise exception 'FAIL B: task days changed'; end if;

  if (select count(*) from public.provisioning_tasks where quote_id = 'Q-R2950-B' and status = 'pending'
        and tenant_id = 'dddddddd-0000-0000-0000-000000295001') <> 1 then
    raise exception 'FAIL B: expected exactly 1 provisioning row'; end if;
  raise notice 'PASS B: no invoice, no number spent, awaiting; 2 active subscriptions, Rs 12,390 due on one of them by the credit date; 4 tasks; 1 provisioning row';
end $$;

-- B2. Second click: with the flag false again, then true — nothing more is written
do $$
declare r jsonb;
begin
  r := public.activate_quote_on_credit('Q-R2950-B', 15, false, 'Customer of 6 years, always pays', false);
  if not (r->>'already_active')::boolean then raise exception 'FAIL B2: second call not idempotent'; end if;
  r := public.activate_quote_on_credit('Q-R2950-B', 15, false, 'Customer of 6 years, always pays', true);
  if not (r->>'already_active')::boolean or r->>'invoice_id' is not null then raise exception 'FAIL B2: a later call with the flag true did something %', r; end if;
  if (select count(*) from public.subscriptions where quote_id = 'Q-R2950-B') <> 2 then raise exception 'FAIL B2: subscriptions doubled'; end if;
  if exists (select 1 from public.invoices where quote_id = 'Q-R2950-B') then raise exception 'FAIL B2: an invoice appeared'; end if;
  if (select count(*) from public.tasks where quote_id = 'Q-R2950-B') <> 4 then raise exception 'FAIL B2: tasks doubled'; end if;
  if (select count(*) from public.provisioning_tasks where quote_id = 'Q-R2950-B') <> 1 then raise exception 'FAIL B2: provisioning doubled'; end if;
  raise notice 'PASS B2: a second call (false or true) is a no-op';
end $$;

-- C. First recurring line is a bulk line
do $$
declare r jsonb; n int; v_sub record;
begin
  r := public.activate_quote_on_credit('Q-R2950-C', 10, false, 'Bulk domains, known customer', false);
  if (select count(*) from public.subscriptions where quote_id = 'Q-R2950-C' and status = 'active') <> 3 then
    raise exception 'FAIL C: expected 3 active subscriptions'; end if;
  select count(*) into n from public.subscriptions where quote_id = 'Q-R2950-C' and outstanding_amount > 0;
  if n <> 1 then raise exception 'FAIL C: outstanding on % subscriptions (want exactly 1) — bulk first line', n; end if;
  select * into v_sub from public.subscriptions where quote_id = 'Q-R2950-C' and outstanding_amount > 0;
  if v_sub.outstanding_amount <> 6254 then raise exception 'FAIL C: outstanding % <> 6254', v_sub.outstanding_amount; end if;
  if v_sub.domain <> 'c1-2950.in' then raise exception 'FAIL C: the due is on % (want the first bulk domain)', v_sub.domain; end if;
  if v_sub.payment_due_date::date is distinct from public.ist_today() + 10 then raise exception 'FAIL C: due date %', v_sub.payment_due_date; end if;
  if exists (select 1 from public.invoices where quote_id = 'Q-R2950-C') then raise exception 'FAIL C: an invoice row was written'; end if;

  -- With the invoice the rows stay as they are today: the invoice carries the due.
  r := public.activate_quote_on_credit('Q-R2950-C2', 10, false, 'Bulk domains, known customer', true);
  if r->>'invoice_id' is null then raise exception 'FAIL C2: no invoice with the flag true'; end if;
  if (select coalesce(sum(outstanding_amount), 0) from public.subscriptions where quote_id = 'Q-R2950-C2') <> 0 then
    raise exception 'FAIL C2: the with-invoice path changed for a bulk first line'; end if;
  raise notice 'PASS C: bulk first line → Rs 6,254 due on the first bulk domain by the credit date; with-invoice path unchanged';
end $$;

-- D. Refusals on the no-invoice path
do $$
declare ok boolean;
begin
  ok := false;
  begin perform public.activate_quote_on_credit('Q-R2950-D1', 15, false, null, false);
  exception when check_violation then ok := sqlerrm like '%has no amount%'; end;
  if not ok then raise exception 'FAIL D1: a Rs 0 quote was not refused'; end if;
  perform pg_temp.r2950_untouched('D1', 'Q-R2950-D1');

  ok := false;
  begin perform public.activate_quote_on_credit('Q-R2950-D2', 31, false, null, false);
  exception when check_violation then ok := sqlerrm like '%1 to 30%'; end;
  if not ok then raise exception 'FAIL D2: 31 credit days without an invoice was not refused'; end if;
  perform pg_temp.r2950_untouched('D2', 'Q-R2950-D2');

  ok := false;
  begin perform public.activate_quote_on_credit('Q-R2950-D4', 15, false, null, false);
  exception when check_violation then ok := sqlerrm like '%write the reason%'; end;
  if not ok then raise exception 'FAIL D4: annual without a reason was not refused'; end if;
  perform pg_temp.r2950_untouched('D4', 'Q-R2950-D4');

  ok := false;
  begin perform public.activate_quote_on_credit('Q-R2950-D5', 15, false, null, false);
  exception when check_violation then ok := sqlerrm like '%billed in instalments%'; end;
  if not ok then raise exception 'FAIL D5: split billing was not refused'; end if;
  perform pg_temp.r2950_untouched('D5', 'Q-R2950-D5');

  -- 31 days WITH the invoice is still allowed (up to 180, as before).
  perform public.activate_quote_on_credit('Q-R2950-D2', 31, false, null, true);
  if (select due_date from public.invoices where quote_id = 'Q-R2950-D2') <> public.ist_today() + 31 then
    raise exception 'FAIL D2: 31 days with an invoice no longer works'; end if;
  raise notice 'PASS D1/D2/D4/D5: zero amount, 31 days, annual without reason, split billing refused; nothing written';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000295002","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin perform public.activate_quote_on_credit('Q-R2950-D3', 15, false, null, false);
  exception when insufficient_privilege then ok := sqlerrm like '%Only the owner%'; end;
  if not ok then raise exception 'FAIL D3: a non-owner over the limit was not refused'; end if;
  perform pg_temp.r2950_untouched('D3', 'Q-R2950-D3');
  raise notice 'PASS D3: non-owner over the limit refused on the no-invoice path too';
end $$;

-- E. Other company, grants, signature
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000295003","role":"authenticated"}', true);
do $$
declare ok boolean := false; v_sig text;
begin
  begin perform public.activate_quote_on_credit('Q-R2950-G', 15, false, null, false);
  exception when insufficient_privilege then ok := sqlerrm like '%does not belong to your tenant%'; end;
  if not ok then raise exception 'FAIL E: another company activated this quote'; end if;
  perform pg_temp.r2950_untouched('E', 'Q-R2950-G');

  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'activate_quote_on_credit') <> 2 then
    raise exception 'FAIL E: expected exactly two activate_quote_on_credit functions (wrapper + body)'; end if;
  foreach v_sig in array array['public.activate_quote_on_credit(text,integer,boolean,text)',
                               'public.activate_quote_on_credit(text,integer,boolean,text,boolean)'] loop
    if to_regprocedure(v_sig) is null then raise exception 'FAIL E: % is missing', v_sig; end if;
    if has_function_privilege('anon', v_sig, 'execute') then raise exception 'FAIL E: anon may execute %', v_sig; end if;
    if exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = to_regprocedure(v_sig) and a.grantee = 0)
       or (select proacl is null from pg_proc where oid = to_regprocedure(v_sig)) then
      raise exception 'FAIL E: PUBLIC may execute %', v_sig; end if;
    if not has_function_privilege('authenticated', v_sig, 'execute') or not has_function_privilege('service_role', v_sig, 'execute') then
      raise exception 'FAIL E: authenticated / service_role cannot execute %', v_sig; end if;
  end loop;
  -- No default on the 5-argument function: a request never matches both (PostgREST picks by argument names).
  if (select pronargdefaults from pg_proc where oid = to_regprocedure('public.activate_quote_on_credit(text,integer,boolean,text,boolean)')) <> 0 then
    raise exception 'FAIL E: the 5-argument function has a default — a call without the flag would match both'; end if;
  if (select pronargdefaults from pg_proc where oid = to_regprocedure('public.activate_quote_on_credit(text,integer,boolean,text)')) <> 2 then
    raise exception 'FAIL E: the 4-argument function lost its two defaults'; end if;
  -- The 4-argument one is only the wrapper; it does not run with the owner's rights.
  if (select length(prosrc) > 400 or prosecdef or prosrc not like '%p_annual_override_reason, true)%'
        from pg_proc where oid = to_regprocedure('public.activate_quote_on_credit(text,integer,boolean,text)')) then
    raise exception 'FAIL E: the 4-argument function is not the thin with-invoice wrapper'; end if;
  raise notice 'PASS E: other company refused; wrapper + body, both authenticated + service_role only; no default on the 5-argument one';
end $$;

-- F. Full payment later on B (as the owner), then the GST invoice
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000295001","role":"authenticated"}', true);
do $$
declare v_q record; v_inv record; v_id text;
begin
  perform public.record_payment('Q-R2950-B', 12390, 'upi', 'r2950-pay-b');
  if (select count(*) from public.subscriptions where quote_id = 'Q-R2950-B') <> 2 then
    raise exception 'FAIL F: the payment filed the subscriptions again'; end if;
  if (select sum(outstanding_amount) from public.subscriptions where quote_id = 'Q-R2950-B') <> 0 then
    raise exception 'FAIL F: outstanding not cleared by the full payment'; end if;
  select * into v_q from public.quotes where id = 'Q-R2950-B';
  if v_q.payment_status <> 'received' or v_q.invoice_id is not null then
    raise exception 'FAIL F: after payment status % invoice %', v_q.payment_status, v_q.invoice_id; end if;
  if (select count(*) from public.provisioning_tasks where quote_id = 'Q-R2950-B') <> 1 then
    raise exception 'FAIL F: the payment raised a second provisioning row'; end if;

  select g.invoice_id into v_id from public.generate_invoice('Q-R2950-B') g;
  select * into v_inv from public.invoices where id = v_id;
  if v_inv.status <> 'paid' or v_inv.amount <> 12390 or v_inv.net_payable <> 0
     or v_inv.taxable_value <> 10500 or v_inv.tax_amount <> 1890 then
    raise exception 'FAIL F: invoice after payment % % % % %', v_inv.status, v_inv.amount, v_inv.net_payable, v_inv.taxable_value, v_inv.tax_amount; end if;
  if v_inv.invoice_date <> public.ist_today() or v_inv.paid_date <> public.ist_today() then
    raise exception 'FAIL F: invoice dated % paid % (want the payment day %)', v_inv.invoice_date, v_inv.paid_date, public.ist_today(); end if;
  if (select count(*) from public.subscriptions where quote_id = 'Q-R2950-B') <> 2 then
    raise exception 'FAIL F: the invoice filed the subscriptions again'; end if;
  if (select sum(outstanding_amount) from public.subscriptions where quote_id = 'Q-R2950-B') <> 0 then
    raise exception 'FAIL F: the invoice put a due back on the subscriptions'; end if;
  if (select count(*) from public.invoices where quote_id = 'Q-R2950-B') <> 1 then raise exception 'FAIL F: more than one invoice'; end if;
  if (select count(*) from public.provisioning_tasks where quote_id = 'Q-R2950-B') <> 1 then
    raise exception 'FAIL F: the invoice raised a second provisioning row'; end if;
  raise notice 'PASS F: full payment → same 2 subscriptions, nothing due; invoice raised after it is dated the payment day and paid';
end $$;

-- G. Part payment later (the SALES user activates: any active member may, as before)
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000295002","role":"authenticated"}', true);
do $$
declare r jsonb;
begin
  r := public.activate_quote_on_credit('Q-R2950-G', 30, false, null, false);
  if r->>'invoice_id' is not null or (r->>'due_date')::date <> public.ist_today() + 30 then raise exception 'FAIL G: %', r; end if;
end $$;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000295001","role":"authenticated"}', true);
do $$
declare v_q record;
begin
  perform public.record_payment('Q-R2950-G', 500, 'upi', 'r2950-pay-g');
  if (select count(*) from public.subscriptions where quote_id = 'Q-R2950-G') <> 1 then raise exception 'FAIL G: subscriptions filed again'; end if;
  if (select outstanding_amount from public.subscriptions where quote_id = 'Q-R2950-G') <> 680 then
    raise exception 'FAIL G: outstanding % (want 680)', (select outstanding_amount from public.subscriptions where quote_id = 'Q-R2950-G'); end if;
  if (select payment_due_date::date from public.subscriptions where quote_id = 'Q-R2950-G') is distinct from public.ist_today() + 30 then
    raise exception 'FAIL G: the part payment moved the due date'; end if;
  select * into v_q from public.quotes where id = 'Q-R2950-G';
  if v_q.payment_status <> 'partial' or v_q.invoice_id is not null then raise exception 'FAIL G: status % invoice %', v_q.payment_status, v_q.invoice_id; end if;
  if exists (select 1 from public.invoices where quote_id = 'Q-R2950-G') then raise exception 'FAIL G: a part payment raised an invoice'; end if;
  raise notice 'PASS G: part payment → Rs 680 still due on the same subscription, no invoice';
end $$;

rollback;
