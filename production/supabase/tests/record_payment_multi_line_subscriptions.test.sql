-- R-318 regression: paying a MULTI-LINE recurring quote must create one subscription
-- PER recurring line, not only for the first line. Otherwise the 2nd line (a support
-- plan next to Workspace, say) never shows in Renewals and never counts in MRR.
-- Run against a dev/test DB (NOT prod). Self-asserting, every block rolled back.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < record_payment_multi_line_subscriptions.test.sql
--
-- Proves:
--   A  Full payment on a 2-line annual quote (new customer, no lead) -> 2 subscriptions,
--      each with its own plan, seats and MRR (line amount / 12), both stamped with quote_id.
--   B  Both lines fall back to the SAME customer domain -> the 2nd still gets its own
--      subscription (domain nulled, no unique-index clash), outstanding sits only on the 1st.
--      A 2nd instalment creates NO further subscriptions.
--   C  A single-line quote still creates exactly 1 subscription (unchanged behaviour).

-- ── A: 2 annual lines, paid in full ─────────────────────────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000318a01','R318 A','r318a@example.in','07','RTA');
insert into public.quotes (id, tenant_id, customer_name, amount, status, payment_status, line_items)
  values ('Q-R318-A','dddddddd-0000-0000-0000-000000318a01','Multi Line Co',30000,'accepted','awaiting',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":1800,"commitment":"annual_yearly"},
            {"name":"Annual Support Plan","qty":1,"rate":12000,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare v_n int; v_ws record; v_sp record; v_total_mrr int;
begin
  perform public.record_payment('Q-R318-A', 30000, 'upi', 'r318_a_full');
  select count(*) into v_n from public.subscriptions where quote_id = 'Q-R318-A';
  if v_n <> 2 then raise exception 'FAIL A: expected 2 subscriptions for a 2-line quote, got %', v_n; end if;
  select * into v_ws from public.subscriptions where quote_id = 'Q-R318-A' and plan = 'Google Workspace Business Starter';
  select * into v_sp from public.subscriptions where quote_id = 'Q-R318-A' and plan = 'Annual Support Plan';
  if v_ws.id is null then raise exception 'FAIL A: Workspace line has no subscription'; end if;
  if v_sp.id is null then raise exception 'FAIL A: Support line has no subscription'; end if;
  if v_ws.seats <> 10 or v_ws.mrr <> 1500 or v_ws.status <> 'active' or v_ws.term_months <> 12 then
    raise exception 'FAIL A: Workspace sub wrong (seats %, mrr %, status %, term %)', v_ws.seats, v_ws.mrr, v_ws.status, v_ws.term_months;
  end if;
  if v_sp.seats <> 1 or v_sp.mrr <> 1000 or v_sp.status <> 'active' or v_sp.term_months <> 12 then
    raise exception 'FAIL A: Support sub wrong (seats %, mrr %, status %, term %)', v_sp.seats, v_sp.mrr, v_sp.status, v_sp.term_months;
  end if;
  if v_ws.renewal_date is null or v_sp.renewal_date is null then raise exception 'FAIL A: renewal_date missing'; end if;
  select sum(mrr) into v_total_mrr from public.subscriptions where quote_id = 'Q-R318-A' and status = 'active';
  if v_total_mrr <> 2500 then raise exception 'FAIL A: quote MRR expected 2500 (30000/12), got %', v_total_mrr; end if;
  raise notice 'PASS A: 2 lines -> 2 active subs, MRR 1500 + 1000 = 2500';
end $$;
rollback;

-- ── B: both lines share the customer's domain; partial then 2nd instalment ──
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000318b01','R318 B','r318b@example.in','07','RTB');
insert into public.customers (id, tenant_id, name, domain)
  values ('cccccccc-0000-0000-0000-000000318b01','dddddddd-0000-0000-0000-000000318b01','Shared Domain Co','shared-r318.in');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items)
  values ('Q-R318-B','dddddddd-0000-0000-0000-000000318b01','cccccccc-0000-0000-0000-000000318b01','Shared Domain Co',24000,'accepted','awaiting',
          '[{"name":"Google Workspace Business Standard","qty":5,"rate":2400,"commitment":"annual_yearly"},
            {"name":"Premium Support","qty":1,"rate":12000,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare v_n int; v_with_domain int; v_out int;
begin
  perform public.record_payment('Q-R318-B', 10000, 'upi', 'r318_b_part1');
  select count(*), count(domain), sum(outstanding_amount) into v_n, v_with_domain, v_out
    from public.subscriptions where quote_id = 'Q-R318-B';
  if v_n <> 2 then raise exception 'FAIL B: expected 2 subscriptions, got %', v_n; end if;
  if v_with_domain <> 1 then raise exception 'FAIL B: expected exactly 1 sub to keep the shared domain, got %', v_with_domain; end if;
  if v_out <> 14000 then raise exception 'FAIL B: outstanding should sit once (14000), got %', v_out; end if;

  perform public.record_payment('Q-R318-B', 14000, 'upi', 'r318_b_part2');
  select count(*), sum(outstanding_amount) into v_n, v_out from public.subscriptions where quote_id = 'Q-R318-B';
  if v_n <> 2 then raise exception 'FAIL B: 2nd instalment changed sub count to %', v_n; end if;
  if v_out <> 0 then raise exception 'FAIL B: outstanding after full payment should be 0, got %', v_out; end if;
  raise notice 'PASS B: shared domain -> still 2 subs; 2nd instalment adds none; outstanding 0';
end $$;
rollback;

-- ── C: single line unchanged ────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000318c01','R318 C','r318c@example.in','07','RTC');
insert into public.quotes (id, tenant_id, customer_name, amount, status, payment_status, line_items)
  values ('Q-R318-C','dddddddd-0000-0000-0000-000000318c01','Single Line Co',18000,'accepted','awaiting',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":1800,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare v_n int; v_mrr int;
begin
  perform public.record_payment('Q-R318-C', 18000, 'upi', 'r318_c_full');
  select count(*), sum(mrr) into v_n, v_mrr from public.subscriptions where quote_id = 'Q-R318-C';
  if v_n <> 1 or v_mrr <> 1500 then raise exception 'FAIL C: single line expected 1 sub / MRR 1500, got % / %', v_n, v_mrr; end if;
  raise notice 'PASS C: single line -> 1 sub, MRR 1500';
end $$;
rollback;
