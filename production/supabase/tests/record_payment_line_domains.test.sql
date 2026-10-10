-- R-829 (10 Oct 2026): each quote line's OWN domain reaches ITS subscription.
-- Migration 20261011000500_r829_line_domain_kept.sql. Self-asserting, every block rolled back.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < record_payment_line_domains.test.sql
--
-- Proves:
--   A  Two Workspace lines, two DIFFERENT typed domains -> each subscription has its own.
--   B  Two Workspace lines (Starter + Business Standard), the SAME typed domain -> BOTH keep it
--      (failed before R-829: Business Standard was created with domain NULL).
--   C  The same plan twice on the same domain -> 2nd sub has no domain, but the result names it
--      in domain_conflicts (never a silent blank).
--   D  A line with NO domain still borrows the quote domain only when no other line used it
--      (Workspace + support: the support line stays NULL, as before).
--   E  activate_quote_on_credit follows the same rule (case B on credit).
--   F  Money unchanged: MRR per line = line amount / 12.

-- ── A: two different domains ───────────────────────────────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000829a01','R829 A','r829a@example.in','07','R829A');
insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-000000829a01','dddddddd-0000-0000-0000-000000829a01','Two Domains Co');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, domain, line_items)
  values ('Q-R829-A','dddddddd-0000-0000-0000-000000829a01','cccccccc-0000-0000-0000-000000829a01','Two Domains Co',21000,'accepted','awaiting','alpha829.in',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1800,"commitment":"annual_yearly","domain":"alpha829.in"},
            {"name":"Google Workspace Business Standard","qty":3,"rate":4000,"commitment":"annual_yearly","domain":"Beta829.in "}]'::jsonb);
do $$
declare v_st text; v_bs text; v_mrr_st int; v_mrr_bs int;
begin
  perform public.record_payment('Q-R829-A', 21000, 'upi', 'r829_a');
  select domain, mrr into v_st, v_mrr_st from public.subscriptions where quote_id = 'Q-R829-A' and plan = 'Google Workspace Business Starter';
  select domain, mrr into v_bs, v_mrr_bs from public.subscriptions where quote_id = 'Q-R829-A' and plan = 'Google Workspace Business Standard';
  if v_st is distinct from 'alpha829.in' then raise exception 'FAIL A: Starter domain %', v_st; end if;
  if v_bs is distinct from 'beta829.in'  then raise exception 'FAIL A: Standard domain %', v_bs; end if;
  if v_mrr_st <> 750 or v_mrr_bs <> 1000 then raise exception 'FAIL F: MRR changed (% / %)', v_mrr_st, v_mrr_bs; end if;
  raise notice 'PASS A+F: two domains -> alpha829.in / beta829.in, MRR 750 / 1000';
end $$;
rollback;

-- ── B: same domain on two different plans ──────────────────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000829b01','R829 B','r829b@example.in','07','R829B');
insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-000000829b01','dddddddd-0000-0000-0000-000000829b01','Mixed Licences Co');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, domain, line_items)
  values ('Q-R829-B','dddddddd-0000-0000-0000-000000829b01','cccccccc-0000-0000-0000-000000829b01','Mixed Licences Co',21000,'accepted','awaiting','mixed829.in',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1800,"commitment":"annual_yearly","domain":"mixed829.in"},
            {"name":"Google Workspace Business Standard","qty":3,"rate":4000,"commitment":"annual_yearly","domain":"mixed829.in"}]'::jsonb);
do $$
declare v_r jsonb; v_n int; v_with int;
begin
  v_r := public.record_payment('Q-R829-B', 21000, 'upi', 'r829_b');
  select count(*), count(*) filter (where domain = 'mixed829.in') into v_n, v_with
    from public.subscriptions where quote_id = 'Q-R829-B';
  if v_n <> 2 then raise exception 'FAIL B: expected 2 subs, got %', v_n; end if;
  if v_with <> 2 then raise exception 'FAIL B: both subs should carry mixed829.in, only % do', v_with; end if;
  if jsonb_array_length(v_r->'domain_conflicts') <> 0 then raise exception 'FAIL B: unexpected conflicts %', v_r->'domain_conflicts'; end if;
  -- A replay of the same payment creates nothing more.
  perform public.record_payment('Q-R829-B', 21000, 'upi', 'r829_b');
  select count(*) into v_n from public.subscriptions where quote_id = 'Q-R829-B';
  if v_n <> 2 then raise exception 'FAIL B: replay changed sub count to %', v_n; end if;
  raise notice 'PASS B: same domain on Starter + Standard -> both keep it';
end $$;
rollback;

-- ── C: same plan twice, same domain -> conflict reported ───────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000829c01','R829 C','r829c@example.in','07','R829C');
insert into public.quotes (id, tenant_id, customer_name, amount, status, payment_status, line_items)
  values ('Q-R829-C','dddddddd-0000-0000-0000-000000829c01','Dup Plan Co',17500,'accepted','awaiting',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1800,"commitment":"annual_yearly","domain":"dup829.in"},
            {"name":"Google Workspace Business Starter","qty":5,"rate":1700,"commitment":"annual_yearly","domain":"dup829.in"}]'::jsonb);
do $$
declare v_r jsonb; v_n int; v_with int;
begin
  v_r := public.record_payment('Q-R829-C', 17500, 'upi', 'r829_c');
  select count(*), count(domain) into v_n, v_with from public.subscriptions where quote_id = 'Q-R829-C';
  if v_n <> 2 or v_with <> 1 then raise exception 'FAIL C: expected 2 subs / 1 with domain, got % / %', v_n, v_with; end if;
  if jsonb_array_length(v_r->'domain_conflicts') <> 1
     or v_r->'domain_conflicts'->0->>'domain' <> 'dup829.in'
     or (v_r->'domain_conflicts'->0->>'line')::int <> 2 then
    raise exception 'FAIL C: conflict not reported: %', v_r->'domain_conflicts';
  end if;
  raise notice 'PASS C: same plan + same domain -> line 2 reported in domain_conflicts';
end $$;
rollback;

-- ── D: borrowed quote domain still goes on one subscription only ────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000829d01','R829 D','r829d@example.in','07','R829D');
insert into public.quotes (id, tenant_id, customer_name, amount, status, payment_status, domain, line_items)
  values ('Q-R829-D','dddddddd-0000-0000-0000-000000829d01','Support Co',30000,'accepted','awaiting','support829.in',
          '[{"name":"Google Workspace Business Starter","qty":10,"rate":1800,"commitment":"annual_yearly"},
            {"name":"Annual Support Plan","qty":1,"rate":12000,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare v_ws text; v_sp text;
begin
  perform public.record_payment('Q-R829-D', 30000, 'upi', 'r829_d');
  select domain into v_ws from public.subscriptions where quote_id = 'Q-R829-D' and plan = 'Google Workspace Business Starter';
  select domain into v_sp from public.subscriptions where quote_id = 'Q-R829-D' and plan = 'Annual Support Plan';
  if v_ws is distinct from 'support829.in' then raise exception 'FAIL D: Workspace should borrow the quote domain, got %', v_ws; end if;
  if v_sp is not null then raise exception 'FAIL D: support line should stay NULL, got %', v_sp; end if;
  raise notice 'PASS D: borrowed domain on the first line only';
end $$;
rollback;

-- ── E: activate on credit, same domain on two plans ────────────────────────
begin;
select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000829e01','R829 E','r829e@example.in','07','R829E');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000829e01','owner829@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000829e01','dddddddd-0000-0000-0000-000000829e01','owner829@example.in','Owner 829','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, credit_limit)
  values ('cccccccc-0000-0000-0000-000000829e01','dddddddd-0000-0000-0000-000000829e01','Credit Mixed Co','07', 100000);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status, line_items)
  values ('Q-R829-E','dddddddd-0000-0000-0000-000000829e01','cccccccc-0000-0000-0000-000000829e01','Credit Mixed Co',
          24780, 21000, 0, 18, 'accepted', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":5,"rate":1800,"commitment":"annual_yearly","domain":"credit829.in"},
            {"name":"Google Workspace Business Standard","qty":3,"rate":4000,"commitment":"annual_yearly","domain":"credit829.in"}]'::jsonb);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000829e01","role":"authenticated"}', true);
do $$
declare v_r jsonb; v_n int; v_with int;
begin
  v_r := public.activate_quote_on_credit('Q-R829-E', 15, false, 'R-829 test: annual on credit');
  select count(*), count(*) filter (where domain = 'credit829.in') into v_n, v_with
    from public.subscriptions where quote_id = 'Q-R829-E';
  if v_n <> 2 or v_with <> 2 then raise exception 'FAIL E: expected 2 subs both on credit829.in, got % / %', v_n, v_with; end if;
  raise notice 'PASS E: activate on credit keeps the domain on both plans';
end $$;
rollback;
