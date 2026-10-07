-- R-370 (7 Oct 2026): "Activate now, pay later" is refused on a split-billed quote
-- (billing_cycle monthly / quarterly / half_yearly) — otherwise the whole-term credit invoice
-- AND the cron's instalment invoices both bill the customer. Migration
-- 20261007150000_credit_refuse_split_billing.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only:
--   begin; \i 20261007150000_credit_refuse_split_billing.sql; \i r370_credit_split_billing.sql; rollback;
--
-- Proves:
--   A. quarterly quote → refused with the instalment message; no invoice, no subscription,
--      quote not marked on credit.
--   B. half_yearly and monthly → refused too.
--   C. yearly quote → activates (invoice + subscription), as before.

-- R-380: own begin/rollback so scripts/test-sql.mjs (CI) runs it after the migrations are applied.
begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000037001','R370 Co','r370@example.in','07','R370A');
insert into public.customers (id, tenant_id, name, state_code, domain)
  values ('cccccccc-0000-0000-0000-000000037001','dddddddd-0000-0000-0000-000000037001','Acme 370','07','acme370.in');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000037001','owner370@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000037001','dddddddd-0000-0000-0000-000000037001','owner370@example.in','Owner 370','owner', now() - interval '1 day');

-- Rs 28,320 = 10 seats × Rs 2,400/yr + 18% GST (the audit's example).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, billing_cycle, line_items)
select v.id, 'dddddddd-0000-0000-0000-000000037001', 'cccccccc-0000-0000-0000-000000037001', 'Acme 370',
       28320, 24000, 0, 18, 'accepted', 'awaiting', v.cycle,
       jsonb_build_array(jsonb_build_object('name','Google Workspace Business Starter','qty',10,'rate',2400,
         'commitment','annual_yearly','domain', lower(v.id) || '.acme370.in'))
  from (values ('Q-R370-Q','quarterly'), ('Q-R370-H','half_yearly'), ('Q-R370-M','monthly'), ('Q-R370-Y','yearly')) v(id, cycle);

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000037001","role":"authenticated"}', true);

do $$
declare q text; msg text; n int;
begin
  foreach q in array array['Q-R370-Q','Q-R370-H','Q-R370-M'] loop
    msg := null;
    begin
      perform public.activate_quote_on_credit(q, 15, false, 'Customer for 6 years, always pays');
    exception when check_violation then
      msg := sqlerrm;
    end;
    if msg is null then raise exception 'FAIL %: split-billed quote was activated on credit', q; end if;
    if msg not like 'This quote is billed in instalments%record the first instalment instead, or switch billing to yearly.' then
      raise exception 'FAIL %: wrong refusal: %', q, msg;
    end if;
    select count(*) into n from public.invoices where quote_id = q;
    if n <> 0 then raise exception 'FAIL %: % invoice(s) created', q, n; end if;
    select count(*) into n from public.subscriptions where quote_id = q;
    if n <> 0 then raise exception 'FAIL %: % subscription(s) created', q, n; end if;
    if exists (select 1 from public.quotes where id = q and credit_activated_at is not null) then
      raise exception 'FAIL %: quote marked on credit', q;
    end if;
    raise notice 'PASS %: refused — %', q, msg;
  end loop;

  perform public.activate_quote_on_credit('Q-R370-Y', 15, false, 'Customer for 6 years, always pays');
  select count(*) into n from public.invoices where quote_id = 'Q-R370-Y';
  if n <> 1 then raise exception 'FAIL Y: yearly should raise 1 invoice, got %', n; end if;
  select count(*) into n from public.subscriptions where quote_id = 'Q-R370-Y' and status = 'active';
  if n <> 1 then raise exception 'FAIL Y: yearly should create 1 active subscription, got %', n; end if;
  if not exists (select 1 from public.quotes where id = 'Q-R370-Y' and credit_activated_at is not null) then
    raise exception 'FAIL Y: yearly quote not marked on credit';
  end if;
  raise notice 'PASS Y: yearly quote activates on credit as before';
end $$;

rollback;
