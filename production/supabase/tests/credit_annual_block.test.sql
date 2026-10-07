-- R-368 (7 Oct 2026): annual plans need payment first. Migration 20261007123000_credit_annual_block_udyam
-- (on top of R-346's 20261007073000_activate_on_credit).
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only:
--   begin; \i 20261007073000_activate_on_credit.sql; \i 20261007123000_credit_annual_block_udyam.sql;
--          \i credit_annual_block.test.sql; rollback;
--
-- Proves:
--   A. a monthly-only quote activates for a SALES user with no reason (unchanged from R-346).
--   B. a quote with an annual line: sales refused ("Annual plans need payment first"), nothing written.
--   C. owner without a reason (or a 2-letter one) refused; owner with a reason → active, reason + owner kept.
--   D. the old 3-argument signature is gone; tenants.udyam_number rejects a bad format.

-- R-380: own begin/rollback so scripts/test-sql.mjs (CI) runs it after the migrations are applied.
begin;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000036801','R368 Co','r368@example.in','07','R368A');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000036801','owner368@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000036802','sales368@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000036801','dddddddd-0000-0000-0000-000000036801','owner368@example.in','Owner 368','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000036802','dddddddd-0000-0000-0000-000000036801','sales368@example.in','Sales 368','sales', now());
insert into public.customers (id, tenant_id, name, state_code, domain)
  values ('cccccccc-0000-0000-0000-000000036801','dddddddd-0000-0000-0000-000000036801','Acme 368','07','acme368.in');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
  values
  ('Q-R368-M','dddddddd-0000-0000-0000-000000036801','cccccccc-0000-0000-0000-000000036801','Acme 368',
   590, 500, 0, 18, 'accepted', 'awaiting',
   '[{"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"m.acme368.in"}]'::jsonb),
  ('Q-R368-A','dddddddd-0000-0000-0000-000000036801','cccccccc-0000-0000-0000-000000036801','Acme 368',
   1770, 1500, 0, 18, 'accepted', 'awaiting',
   '[{"name":"Google Workspace Business Starter","qty":1,"rate":1000,"commitment":"annual_yearly"},
     {"name":"Standard hosting (billed monthly)","qty":1,"rate":500,"commitment":"monthly","domain":"a.acme368.in"}]'::jsonb);

-- ── SALES user ──
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000036802","role":"authenticated"}', true);
do $$
declare r jsonb; ok boolean := false;
begin
  r := public.activate_quote_on_credit('Q-R368-M', 15);
  if (r->>'already_active')::boolean then raise exception 'FAIL A: monthly quote reported already active'; end if;
  if (select count(*) from public.subscriptions where quote_id = 'Q-R368-M' and status = 'active') <> 1 then
    raise exception 'FAIL A: monthly quote made no subscription'; end if;
  if (select credit_annual_override_reason from public.quotes where id = 'Q-R368-M') is not null then
    raise exception 'FAIL A: monthly quote got an override reason'; end if;
  raise notice 'PASS A: monthly-only quote activates for sales, no reason needed';

  begin
    perform public.activate_quote_on_credit('Q-R368-A', 15, false, 'I want to');
  exception when insufficient_privilege then ok := sqlerrm like 'Annual plans need payment first%';
  end;
  if not ok then raise exception 'FAIL B: sales activated an annual plan on credit'; end if;
  if exists (select 1 from public.invoices where quote_id = 'Q-R368-A') then raise exception 'FAIL B: refusal left an invoice'; end if;
  if exists (select 1 from public.subscriptions where quote_id = 'Q-R368-A') then raise exception 'FAIL B: refusal left subscriptions'; end if;
  raise notice 'PASS B: annual line refused for sales, nothing written';
end $$;

-- ── OWNER ──
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000036801","role":"authenticated"}', true);
do $$
declare r jsonb; ok boolean;
begin
  ok := false;
  begin
    perform public.activate_quote_on_credit('Q-R368-A', 15);
  exception when check_violation then ok := sqlerrm like '%write the reason%';
  end;
  if not ok then raise exception 'FAIL C: owner without a reason was not stopped'; end if;

  ok := false;
  begin
    perform public.activate_quote_on_credit('Q-R368-A', 15, false, ' ok ');
  exception when check_violation then ok := sqlerrm like '%write the reason%';
  end;
  if not ok then raise exception 'FAIL C: a 2-letter reason was accepted'; end if;

  r := public.activate_quote_on_credit('Q-R368-A', 15, false, '  Customer for 6 years, always pays  ');
  if (select count(*) from public.subscriptions where quote_id = 'Q-R368-A' and status = 'active') <> 2 then
    raise exception 'FAIL C: owner override made no subscriptions'; end if;
  if (select credit_annual_override_reason from public.quotes where id = 'Q-R368-A') <> 'Customer for 6 years, always pays' then
    raise exception 'FAIL C: reason not kept (trimmed)'; end if;
  if (select credit_annual_override_by from public.quotes where id = 'Q-R368-A') <> 'aaaaaaaa-0000-0000-0000-000000036801' then
    raise exception 'FAIL C: overriding owner not kept'; end if;
  raise notice 'PASS C: owner must write a reason; then active and recorded';
end $$;

do $$
declare ok boolean := false;
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'activate_quote_on_credit' and p.pronargs = 3
  ) then raise exception 'FAIL D: the 3-argument activate_quote_on_credit still exists'; end if;

  begin
    update public.tenants set udyam_number = 'UDYAM-12345' where id = 'dddddddd-0000-0000-0000-000000036801';
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL D: bad Udyam number accepted'; end if;
  raise notice 'PASS D: no way around the check; Udyam format enforced';
end $$;

rollback;
