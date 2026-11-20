-- R-2951 (20 Nov 2026): "Activate now, pay later" WITHOUT a GST invoice — the credit limit counts
-- it, the owner gets four tasks, and the tasks close by themselves.
-- Self-asserting, ONE transaction, rolled back. Local / test DB only.
--
-- Proves:
--   A. a second no-invoice activation counts what the first still owes: a non-owner over the limit
--      is refused (message says "this quote", never "invoice"); the with-invoice call is refused too
--      (its message keeps "this invoice"). Nothing is written by a refusal.
--   B. the owner: without "Approve over limit" refused, with it allowed; owed_before counts the first.
--   C. a part payment on an uninvoiced activation lowers what it counts (only the unpaid rest).
--   D. once that quote has its GST invoice, the invoice counts and the quote does not (no double count).
--   E. the no-invoice path writes FOUR tasks: set up seats (today), send payment link (due − 3),
--      stop service? (due + 15), issue the GST invoice (the earlier of the due date and activation
--      + 30 days — with the 30-day cap that is the due date: 15 → +15, 29 → +29, 30 → +30). No task
--      names an invoice. The with-invoice path keeps its three tasks.
--   F. full payment → "send payment link" and "payment not in" are cancelled, the issue-invoice task
--      stays open (the GST invoice is still owed), the pay-by date is cleared; the invoice raised
--      afterwards closes the issue-invoice task (done).
--   G. part payment → nothing is closed, the pay-by date stays.
--   H. invoice raised BEFORE any payment → the issue-invoice task is done, the two reminders stay; the
--      full payment afterwards closes them (record_payment, as with an invoice from the start).
--   I. the trigger function is not callable by anon / PUBLIC; it ignores a quote not on credit.
--   K. a quote whose first line is bulk, paid in full, counts 0 (its subscriptions keep their
--      outstanding amount; the rule is quote amount − received payments). L. part-paid: only the rest.
begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address.
create function pg_temp.r2951_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2951_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r2951_fill_supplier();

-- ── Fixtures (no jwt yet: system writes) ─────────────────────────────────────
select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000295101','R2951 Co','r2951@example.in','07','R2951A');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000295101','owner2951@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000295102','sales2951@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000295101','dddddddd-0000-0000-0000-000000295101','owner2951@example.in','Owner 2951','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000295102','dddddddd-0000-0000-0000-000000295101','sales2951@example.in','Sales 2951','sales', now());

-- Customer X: Rs 10,000 limit (A–D). Customer Y: roomy (E–I).
insert into public.customers (id, tenant_id, name, state_code, domain, credit_limit) values
  ('cccccccc-0000-0000-0000-000000295101','dddddddd-0000-0000-0000-000000295101','Small 2951','07','small2951.in', 10000),
  ('cccccccc-0000-0000-0000-000000295102','dddddddd-0000-0000-0000-000000295101','Big 2951','07','big2951.in', 500000),
  ('cccccccc-0000-0000-0000-000000295103','dddddddd-0000-0000-0000-000000295101','Bulk Paid 2951','07','bulkpaid2951.in', 10000),
  ('cccccccc-0000-0000-0000-000000295104','dddddddd-0000-0000-0000-000000295101','Bulk Part 2951','07','bulkpart2951.in', 10000);

-- K / L: a no-invoice quote whose FIRST line is a bulk line (record_payment never lowers its
-- subscriptions' outstanding amount, R-2954) — 2 domains x Rs 2,400 + GST = Rs 5,664.
create function pg_temp.r2951_bulk(p_id text, p_customer uuid, p_tag text) returns void
language sql as $f$
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                             status, payment_status, billing_cycle, line_items)
  values (p_id, 'dddddddd-0000-0000-0000-000000295101', p_customer,
          (select name from public.customers where id = p_customer), 5664, 4800, 0, 18,
          'accepted', 'awaiting', 'yearly'::public.billing_cycle,
          jsonb_build_array(jsonb_build_object('name', 'Domain .in', 'qty', 2, 'rate', 2400, 'commitment', 'annual_yearly', 'bulk', true,
            'domains', jsonb_build_array(jsonb_build_object('domain', p_tag || '1-2951.in', 'seats', 1),
                                         jsonb_build_object('domain', p_tag || '2-2951.in', 'seats', 1)))));
$f$;

create function pg_temp.r2951_q(p_id text, p_qty int, p_rate int, p_dom text,
                                p_customer uuid default 'cccccccc-0000-0000-0000-000000295101') returns void
language sql as $f$
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                             status, payment_status, billing_cycle, line_items)
  values (p_id, 'dddddddd-0000-0000-0000-000000295101', p_customer,
          (select name from public.customers where id = p_customer),
          round(p_qty * p_rate * 1.18)::int, p_qty * p_rate, 0, 18,
          'accepted', 'awaiting', 'yearly'::public.billing_cycle,
          jsonb_build_array(jsonb_build_object('name', 'Standard hosting (billed monthly)', 'qty', p_qty, 'rate', p_rate,
                                               'commitment', 'monthly', 'domain', p_dom)));
$f$;

select pg_temp.r2951_q('Q-R2951-A1', 10, 500, 'a1.small2951.in');   -- Rs 5,900
select pg_temp.r2951_q('Q-R2951-A2', 10, 500, 'a2.small2951.in');   -- Rs 5,900
select pg_temp.r2951_q('Q-R2951-C',  1, 100, 'c.small2951.in');     -- Rs 118
select pg_temp.r2951_q('Q-R2951-D',  1, 100, 'd.small2951.in');     -- Rs 118
select pg_temp.r2951_q('Q-R2951-E15', 1, 500, 'e15.big2951.in', 'cccccccc-0000-0000-0000-000000295102');  -- Rs 590
select pg_temp.r2951_q('Q-R2951-E29', 2, 500, 'e29.big2951.in', 'cccccccc-0000-0000-0000-000000295102');  -- Rs 1,180
select pg_temp.r2951_q('Q-R2951-E30', 1, 500, 'e30.big2951.in', 'cccccccc-0000-0000-0000-000000295102');  -- Rs 590
select pg_temp.r2951_q('Q-R2951-I',   1, 500, 'i.big2951.in',   'cccccccc-0000-0000-0000-000000295102');  -- Rs 590
select pg_temp.r2951_q('Q-R2951-J',   1, 500, 'j.big2951.in',   'cccccccc-0000-0000-0000-000000295102');  -- Rs 590, never on credit
select pg_temp.r2951_bulk('Q-R2951-K1', 'cccccccc-0000-0000-0000-000000295103', 'k');  -- Rs 5,664, bulk first line
select pg_temp.r2951_q('Q-R2951-K2', 10, 500, 'k2.bulkpaid2951.in', 'cccccccc-0000-0000-0000-000000295103');  -- Rs 5,900
select pg_temp.r2951_bulk('Q-R2951-L1', 'cccccccc-0000-0000-0000-000000295104', 'l');  -- Rs 5,664, bulk first line
select pg_temp.r2951_q('Q-R2951-L2', 1, 500, 'l2.bulkpart2951.in', 'cccccccc-0000-0000-0000-000000295104');   -- Rs 590

create function pg_temp.r2951_untouched(p_case text, p_quote text) returns void
language plpgsql as $f$
begin
  if exists (select 1 from public.subscriptions where quote_id = p_quote) then raise exception 'FAIL %: refusal left subscriptions', p_case; end if;
  if exists (select 1 from public.invoices where quote_id = p_quote) then raise exception 'FAIL %: refusal left an invoice', p_case; end if;
  if exists (select 1 from public.tasks where quote_id = p_quote) then raise exception 'FAIL %: refusal left tasks', p_case; end if;
  if (select credit_activated_at from public.quotes where id = p_quote) is not null then raise exception 'FAIL %: refusal stamped the quote', p_case; end if;
end $f$;

-- Task of a quote by its title start; its IST day.
create function pg_temp.r2951_task(p_quote text, p_title text) returns public.tasks
language sql as $f$
  select t.* from public.tasks t where t.quote_id = p_quote and t.title like p_title || '%' order by t.created_at limit 1;
$f$;
create function pg_temp.r2951_day(p_quote text, p_title text) returns date
language sql as $f$
  select (t.due_at at time zone 'Asia/Kolkata')::date from public.tasks t where t.quote_id = p_quote and t.title like p_title || '%' limit 1;
$f$;

-- ── As the SALES user ────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000295102","role":"authenticated"}', true);

-- A. Second no-invoice activation counts the first
do $$
declare r jsonb; ok boolean; msg text;
begin
  r := public.activate_quote_on_credit('Q-R2951-A1', 15, false, null, false);
  if r->>'invoice_id' is not null or (r->>'owed_before')::int <> 0 then raise exception 'FAIL A: first activation %', r; end if;

  ok := false;
  begin perform public.activate_quote_on_credit('Q-R2951-A2', 15, false, null, false);
  exception when insufficient_privilege then ok := true; msg := sqlerrm; end;
  if not ok then raise exception 'FAIL A: the second no-invoice activation went past the limit (the first was not counted)'; end if;
  if msg not like '%already owes Rs 5900, this quote is Rs 5900, total Rs 11800 against a limit of Rs 10000%Only the owner%' then
    raise exception 'FAIL A: refusal text %', msg; end if;
  if msg ilike '%invoice%' then raise exception 'FAIL A: the no-invoice refusal speaks of an invoice: %', msg; end if;
  perform pg_temp.r2951_untouched('A', 'Q-R2951-A2');

  -- The with-invoice call counts it too, and keeps its own wording.
  ok := false;
  begin perform public.activate_quote_on_credit('Q-R2951-A2', 15, false, null);
  exception when insufficient_privilege then ok := true; msg := sqlerrm; end;
  if not ok then raise exception 'FAIL A: the with-invoice activation did not count the uninvoiced one'; end if;
  if msg not like '%already owes Rs 5900, this invoice is Rs 5900, total Rs 11800%' then raise exception 'FAIL A: with-invoice text %', msg; end if;
  perform pg_temp.r2951_untouched('A-inv', 'Q-R2951-A2');
  raise notice 'PASS A: second activation counts the first Rs 5,900; non-owner refused both ways ("this quote" / "this invoice")';
end $$;

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000295101","role":"authenticated"}', true);

-- B. Owner approves
do $$
declare r jsonb; ok boolean := false;
begin
  begin perform public.activate_quote_on_credit('Q-R2951-A2', 15, false, null, false);
  exception when check_violation then ok := sqlerrm like '%Rs 11800 against a limit of Rs 10000%Approve over limit%'; end;
  if not ok then raise exception 'FAIL B: owner without approval not refused'; end if;
  perform pg_temp.r2951_untouched('B', 'Q-R2951-A2');

  r := public.activate_quote_on_credit('Q-R2951-A2', 15, true, null, false);
  if not (r->>'over_limit')::boolean or (r->>'owed_before')::int <> 5900 or r->>'invoice_id' is not null then
    raise exception 'FAIL B: owner approval result %', r; end if;
  if (select credit_over_limit_approved_by from public.quotes where id = 'Q-R2951-A2') <> 'aaaaaaaa-0000-0000-0000-000000295101' then
    raise exception 'FAIL B: approval not stamped'; end if;
  raise notice 'PASS B: owner refused without approval, allowed with it; owed_before = Rs 5,900';
end $$;

-- C. Part payment lowers what an uninvoiced activation counts
do $$
declare r jsonb;
begin
  perform public.record_payment('Q-R2951-A1', 2000, 'upi', 'r2951-part-a1');
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000295102","role":"authenticated"}', true);
  -- 3,900 (A1 rest) + 5,900 (A2) + 118 = 9,918 ≤ 10,000 → the sales user may.
  r := public.activate_quote_on_credit('Q-R2951-C', 15, false, null, false);
  if (r->>'owed_before')::int <> 9800 or (r->>'over_limit')::boolean then raise exception 'FAIL C: %', r; end if;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000295101","role":"authenticated"}', true);
  raise notice 'PASS C: after Rs 2,000 paid on the first, only its Rs 3,900 rest counts (owed_before 9,800)';
end $$;

-- D + H. The GST invoice raised on A2 before any payment: counted once, closes the issue-invoice task only
do $$
declare r jsonb; v_inv text; t public.tasks;
begin
  select g.invoice_id into v_inv from public.generate_invoice('Q-R2951-A2') g;
  if v_inv is null or (select invoice_id from public.quotes where id = 'Q-R2951-A2') is distinct from v_inv then
    raise exception 'FAIL D: no invoice on A2'; end if;
  t := pg_temp.r2951_task('Q-R2951-A2', 'Credit: due date reached');
  if t.status <> 'done' or t.completed_at is null then raise exception 'FAIL H: issue-invoice task % after the invoice', t.status; end if;
  if (select count(*) from public.tasks where quote_id = 'Q-R2951-A2' and status = 'pending'
        and (title like 'Credit: send payment link%' or title like 'Credit: payment not in%' or title like 'Set up seats%')) <> 3 then
    raise exception 'FAIL H: the invoice closed tasks other than the issue-invoice one'; end if;

  -- invoice 5,900 + A1 rest 3,900 + C 118 = 9,918; A2's subscription still says 5,900 but must not count again.
  r := public.activate_quote_on_credit('Q-R2951-D', 15, true, null, false);
  if (r->>'owed_before')::int <> 9918 then raise exception 'FAIL D: owed_before % (want 9918 — invoice once, not invoice + quote)', r->>'owed_before'; end if;

  -- Full payment of A2 now: the old R-346 rule (invoice paid) closes the two reminders.
  perform public.record_payment('Q-R2951-A2', 5900, 'upi', 'r2951-pay-a2');
  if (select count(*) from public.tasks where quote_id = 'Q-R2951-A2' and title like 'Credit:%' and status in ('pending', 'snoozed')) <> 0 then
    raise exception 'FAIL H: Credit tasks still open after the invoice was paid'; end if;
  if (pg_temp.r2951_task('Q-R2951-A2', 'Credit: due date reached')).status <> 'done' then
    raise exception 'FAIL H: the payment turned the done issue-invoice task into something else'; end if;
  if exists (select 1 from public.subscriptions where quote_id = 'Q-R2951-A2' and (outstanding_amount <> 0 or payment_due_date is not null)) then
    raise exception 'FAIL H: invoice first, then paid — pay-by date / outstanding left on the subscription'; end if;
  raise notice 'PASS D/H: invoice before payment closes only the issue-invoice task; the invoice counts once (owed_before 9,918); paid → reminders closed';
end $$;

-- E. Four tasks and their days
do $$
declare r jsonb; v_q text; v_days int; v_due date; v_today date := public.ist_today();
begin
  foreach v_q in array array['Q-R2951-E15','Q-R2951-E29','Q-R2951-E30'] loop
    v_days := substring(v_q from '..$')::int;
    v_due := v_today + v_days;
    r := public.activate_quote_on_credit(v_q, v_days, false, null, false);
    if (r->>'tasks_created')::int <> 4 then raise exception 'FAIL E %: tasks_created %', v_q, r->>'tasks_created'; end if;
    if (select count(*) from public.tasks where quote_id = v_q and status = 'pending') <> 4 then raise exception 'FAIL E %: want 4 pending tasks', v_q; end if;
    if (select count(*) from public.tasks where quote_id = v_q and title like 'Credit:%') <> 3 then raise exception 'FAIL E %: want 3 Credit: tasks', v_q; end if;
    if pg_temp.r2951_day(v_q, 'Set up seats (DNS, users) · Big 2951') <> v_today then raise exception 'FAIL E %: set-up day', v_q; end if;
    if pg_temp.r2951_day(v_q, 'Credit: send payment link · Big 2951') <> v_due - 3 then raise exception 'FAIL E %: link day', v_q; end if;
    if pg_temp.r2951_day(v_q, 'Credit: payment not in — stop service? · Big 2951') <> v_due + 15 then raise exception 'FAIL E %: stop day', v_q; end if;
    if pg_temp.r2951_day(v_q, 'Credit: due date reached — issue the GST invoice · Big 2951') <> least(v_due, v_today + 30) then
      raise exception 'FAIL E %: issue-invoice day % (want %)', v_q, pg_temp.r2951_day(v_q, 'Credit: due date reached'), least(v_due, v_today + 30); end if;
    if (pg_temp.r2951_task(v_q, 'Credit: due date reached')).kind <> 'custom' then raise exception 'FAIL E %: issue-invoice task kind', v_q; end if;
    if exists (select 1 from public.tasks where quote_id = v_q and (notes is null or notes not like '%' || v_q || '%')) then
      raise exception 'FAIL E %: a task note does not name the quote', v_q; end if;
    if exists (select 1 from public.tasks where quote_id = v_q and (notes ~ 'Invoice\s' or notes ~ 'INV')) then
      raise exception 'FAIL E %: a task note names an invoice that does not exist', v_q; end if;
  end loop;
  raise notice 'PASS E: four tasks; issue-invoice task on the earlier of due / activation + 30 (15 → +15, 29 → +29, 30 → +30)';
end $$;

-- F. Full payment on E30, then its invoice
do $$
declare v_inv text;
begin
  perform public.record_payment('Q-R2951-E30', 590, 'upi', 'r2951-pay-e30');
  if (pg_temp.r2951_task('Q-R2951-E30', 'Credit: send payment link')).status <> 'cancelled'
     or (pg_temp.r2951_task('Q-R2951-E30', 'Credit: payment not in')).status <> 'cancelled' then
    raise exception 'FAIL F: the two reminders are still open after full payment'; end if;
  if (pg_temp.r2951_task('Q-R2951-E30', 'Credit: due date reached')).status <> 'pending' then
    raise exception 'FAIL F: the issue-invoice task closed on payment — the GST invoice is still owed'; end if;
  if (pg_temp.r2951_task('Q-R2951-E30', 'Set up seats')).status <> 'pending' then
    raise exception 'FAIL F: the payment closed the set-up task'; end if;
  if exists (select 1 from public.subscriptions where quote_id = 'Q-R2951-E30' and (outstanding_amount <> 0 or payment_due_date is not null)) then
    raise exception 'FAIL F: pay-by date / outstanding left on the paid subscription'; end if;

  select g.invoice_id into v_inv from public.generate_invoice('Q-R2951-E30') g;
  if (pg_temp.r2951_task('Q-R2951-E30', 'Credit: due date reached')).status <> 'done' then
    raise exception 'FAIL F: the invoice did not close the issue-invoice task'; end if;
  raise notice 'PASS F: full payment closes the 2 reminders and clears the pay-by date; issue-invoice task waits for the invoice, then done';
end $$;

-- G. Part payment on E29: nothing closes
do $$
begin
  perform public.record_payment('Q-R2951-E29', 500, 'upi', 'r2951-part-e29');
  if (select count(*) from public.tasks where quote_id = 'Q-R2951-E29' and status = 'pending') <> 4 then
    raise exception 'FAIL G: a part payment closed a task'; end if;
  if (select payment_due_date::date from public.subscriptions where quote_id = 'Q-R2951-E29') is distinct from public.ist_today() + 29 then
    raise exception 'FAIL G: the part payment moved the pay-by date'; end if;
  raise notice 'PASS G: part payment closes nothing; pay-by date stays';
end $$;

-- I. With the invoice: three tasks, as before; trigger function closed to anon / PUBLIC; non-credit quote ignored
do $$
declare r jsonb; v_fn regprocedure;
begin
  r := public.activate_quote_on_credit('Q-R2951-I', 15);
  if (r->>'tasks_created')::int <> 3 or (select count(*) from public.tasks where quote_id = 'Q-R2951-I') <> 3 then
    raise exception 'FAIL I: with-invoice path task count changed %', r; end if;
  if exists (select 1 from public.tasks where quote_id = 'Q-R2951-I' and title like 'Credit: due date reached%') then
    raise exception 'FAIL I: with-invoice path got the issue-invoice task'; end if;
  perform public.record_payment('Q-R2951-I', 590, 'upi', 'r2951-pay-i');
  if (select count(*) from public.tasks where quote_id = 'Q-R2951-I' and title like 'Credit:%' and status = 'cancelled') <> 2 then
    raise exception 'FAIL I: with-invoice full payment no longer closes the two reminders'; end if;

  perform public.record_payment('Q-R2951-J', 590, 'upi', 'r2951-pay-j');
  if exists (select 1 from public.tasks where quote_id = 'Q-R2951-J' and status = 'cancelled') then
    raise exception 'FAIL I: a quote not on credit had tasks cancelled'; end if;

  v_fn := to_regprocedure('public.r2951_credit_quote_closes_tasks()');
  if v_fn is null then raise exception 'FAIL I: trigger function missing'; end if;
  if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = v_fn and a.grantee = 0) then
    raise exception 'FAIL I: the trigger function is callable by anon / authenticated / PUBLIC'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'quotes_r2951_credit_closes_tasks' and tgrelid = 'public.quotes'::regclass) then
    raise exception 'FAIL I: trigger missing'; end if;
  raise notice 'PASS I: with-invoice path keeps 3 tasks and its close rule; non-credit quote untouched; trigger function closed';
end $$;

-- K / L. Bulk first line (owner activates, an annual line needs the reason), then a SALES user activates the next.
do $$
begin
  perform public.activate_quote_on_credit('Q-R2951-K1', 15, false, 'Bulk domains, known customer', false);
  perform public.record_payment('Q-R2951-K1', 5664, 'upi', 'r2951-pay-k1');            -- paid in full
  perform public.activate_quote_on_credit('Q-R2951-L1', 15, false, 'Bulk domains, known customer', false);
  perform public.record_payment('Q-R2951-L1', 2000, 'upi', 'r2951-part-l1');           -- part-paid
end $$;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000295102","role":"authenticated"}', true);
do $$
declare r jsonb;
begin
  -- Paid in full: counts 0 → Rs 5,900 fits the Rs 10,000 limit and a non-owner may activate it.
  r := public.activate_quote_on_credit('Q-R2951-K2', 15, false, null, false);
  if (r->>'owed_before')::int <> 0 or (r->>'over_limit')::boolean then
    raise exception 'FAIL K: a bulk-first quote paid in full still counts (owed_before %)', r->>'owed_before'; end if;
  -- Part-paid: only the unpaid Rs 3,664 counts (not its subscriptions' Rs 5,664 outstanding).
  r := public.activate_quote_on_credit('Q-R2951-L2', 15, false, null, false);
  if (r->>'owed_before')::int <> 3664 then
    raise exception 'FAIL L: part-paid bulk-first quote counts % (want 3664 = 5664 - 2000)', r->>'owed_before'; end if;
  raise notice 'PASS K/L: bulk-first quote paid in full counts 0; part-paid counts only the Rs 3,664 still unpaid';
end $$;

rollback;
