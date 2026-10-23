-- R-1707 (21 Oct 2026): the quotes list reads every quote's open balance in ONE call.
-- Migration 20261021031923_r1707_quote_open_balances.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. the owner's real record shape — #0020 (T-L5): quote invoiced ₹38,232, quotes.payment_amount 0,
--      invoice refunded + credit-noted → invoice status paid, net ₹0 — has open balance 0
--      (the list showed "₹38,232 due"). Fails without the migration (no quote_open_balances).
--   B. an invoiced quote part-paid ₹20,000 of ₹38,232 → 18,232; a not-invoiced quote part-paid
--      ₹5,000 of ₹11,800 → 6,800; an untouched sent quote → its amount.
--   C. every row equals quote_open_balance(id) — one rule, not a second copy.
--   D. only the caller's company's quotes; a no-company login is refused; anon cannot execute.

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address (supplier_invoice_problem).
-- Every company this test creates gets both unless the test sets them itself (an unregistered
-- one gets only the address). Rolled back with the test.
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
  ('dddddddd-0000-0000-0000-000000170701','R1707 Co','r1707@example.in','07','R1707'),
  ('dddddddd-0000-0000-0000-000000170702','R1707 Other','r1707b@example.in','07','R17B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000170701','owner1707@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000170702','nocompany1707@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000170701','dddddddd-0000-0000-0000-000000170701','owner1707@example.in','Owner 1707','owner', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code) values
  ('cccccccc-0000-0000-0000-000000170701','dddddddd-0000-0000-0000-000000170701','T-L5 1707','07'),
  ('cccccccc-0000-0000-0000-000000170702','dddddddd-0000-0000-0000-000000170702','Other 1707','07');

-- 38,232 = 32,400 + 18%; 11,800 = 10,000 + 18%.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items)
values
  ('Q-R1707-CN','dddddddd-0000-0000-0000-000000170701','cccccccc-0000-0000-0000-000000170701','T-L5 1707',
   38232, 32400, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Setup and migration","qty":1,"rate":32400,"one_time":true}]'::jsonb),
  ('Q-R1707-IP','dddddddd-0000-0000-0000-000000170701','cccccccc-0000-0000-0000-000000170701','T-L5 1707',
   38232, 32400, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Setup and migration","qty":1,"rate":32400,"one_time":true}]'::jsonb),
  ('Q-R1707-PP','dddddddd-0000-0000-0000-000000170701','cccccccc-0000-0000-0000-000000170701','T-L5 1707',
   11800, 10000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Setup and migration","qty":1,"rate":10000,"one_time":true}]'::jsonb),
  ('Q-R1707-S','dddddddd-0000-0000-0000-000000170701','cccccccc-0000-0000-0000-000000170701','T-L5 1707',
   11800, 10000, 0, 18, 'sent', 'none', 'yearly',
   '[{"name":"Setup and migration","qty":1,"rate":10000,"one_time":true}]'::jsonb),
  ('Q-R1707-X','dddddddd-0000-0000-0000-000000170702','cccccccc-0000-0000-0000-000000170702','Other 1707',
   11800, 10000, 0, 18, 'sent', 'none', 'yearly',
   '[{"name":"Setup and migration","qty":1,"rate":10000,"one_time":true}]'::jsonb);

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000170701","role":"authenticated"}', true);

-- The owner's #0020 shape: invoiced, then refunded + credit-noted → invoice paid, net 0,
-- quotes.payment_amount 0 (what the list subtracted).
do $$
declare v_inv text;
begin
  perform public.generate_invoice('Q-R1707-CN');
  select invoice_id into v_inv from public.quotes where id = 'Q-R1707-CN';
  insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, reason_code,
                                   amount, taxable_value, tax_amount, tax_rate)
    values ('CN-R1707-1','dddddddd-0000-0000-0000-000000170701', v_inv,
            'cccccccc-0000-0000-0000-000000170701','T-L5 1707','cancellation', 38232, 32400, 5832, 18);
  update public.invoices set status = 'paid', net_payable = 0, paid_amount = 0 where id = v_inv;

  perform public.generate_invoice('Q-R1707-IP');
  perform public.record_payment('Q-R1707-IP', 20000, 'upi', 'r1707-pay-ip');
  perform public.record_payment('Q-R1707-PP', 5000, 'upi', 'r1707-pay-pp');
end $$;

-- A + B + C
do $$
declare m jsonb; r record; n int := 0;
begin
  select jsonb_object_agg(quote_id, open_balance) into m from public.quote_open_balances();

  if (select payment_amount from public.quotes where id = 'Q-R1707-CN') <> 0
     or (select payment_status::text from public.quotes where id = 'Q-R1707-CN') <> 'invoiced' then
    raise exception 'FAIL setup: CN quote is not the owner''s shape'; end if;
  if (m->>'Q-R1707-CN')::int is distinct from 0 then
    raise exception 'FAIL A: credit-noted quote open balance % (want 0; the list showed 38,232 due)', m->>'Q-R1707-CN'; end if;
  raise notice 'PASS A: credit-noted / refunded quote → open balance 0';

  if (m->>'Q-R1707-IP')::int is distinct from 18232 then
    raise exception 'FAIL B: invoiced part-paid % (want 18232)', m->>'Q-R1707-IP'; end if;
  if (m->>'Q-R1707-PP')::int is distinct from 6800 then
    raise exception 'FAIL B: part-paid % (want 6800)', m->>'Q-R1707-PP'; end if;
  if (m->>'Q-R1707-S')::int is distinct from 11800 then
    raise exception 'FAIL B: sent quote % (want 11800)', m->>'Q-R1707-S'; end if;
  raise notice 'PASS B: part-paid invoiced 18232, part-paid 6800, sent 11800';

  for r in select * from public.quote_open_balances() loop
    n := n + 1;
    if r.open_balance is distinct from public.quote_open_balance(r.quote_id) then
      raise exception 'FAIL C: % batch % <> quote_open_balance %', r.quote_id, r.open_balance, public.quote_open_balance(r.quote_id); end if;
  end loop;
  raise notice 'PASS C: % rows, each = quote_open_balance(id)', n;

  if m ? 'Q-R1707-X' then raise exception 'FAIL D: another company''s quote returned'; end if;
  if n <> 4 then raise exception 'FAIL D: % rows (want this company''s 4)', n; end if;
  raise notice 'PASS D1: only the caller''s company';
end $$;

-- D2. No-company login
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000170702","role":"authenticated"}', true);
do $$
begin
  begin
    perform * from public.quote_open_balances();
    raise exception 'FAIL D2: a no-company login read balances';
  exception when sqlstate '28000' then
    null;
  end;
  raise notice 'PASS D2: no-company login refused (fail closed)';
end $$;

-- D3. anon
do $$
begin
  if has_function_privilege('anon', 'public.quote_open_balances()', 'execute') then
    raise exception 'FAIL D3: anon can execute quote_open_balances'; end if;
  if not has_function_privilege('authenticated', 'public.quote_open_balances()', 'execute') then
    raise exception 'FAIL D3: authenticated cannot execute quote_open_balances'; end if;
  raise notice 'PASS D3: authenticated yes, anon no';
end $$;

rollback;
