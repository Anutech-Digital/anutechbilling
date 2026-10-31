-- R-2154 (31 Oct 2026): the R-1708 dues-drift check (R-1823 repair report §7) compares like with
-- like — the quote's subscriptions SUMMED against what that quote still asks for — and a quote
-- billed in parts is compared with the parts that are due, not the whole year.
-- Migration 20261031023525_r2154_subscription_dues_drift.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Found on staging (31 Oct, R-1823 run): §7 listed 12 subscriptions, −₹22,52,838, all on quotes
-- with no invoice. Two causes in the report itself:
--   1. it put EACH subscription's stored balance next to the WHOLE quote's open balance — a quote
--      with two subscriptions came out twice (THE PROWRITE ₹5,82,188 on both; MOTION PHILM on both);
--      the quote's balance rides on its first subscription only (record_payment, R-2092);
--   2. quote_open_balance counts the whole contract (quotes.amount − receipts), but a quote billed
--      in parts owes only the parts whose date has come (split_outstanding_for, R-527/R-2044) —
--      MOTION PHILM stored ₹60 = Q1 ₹95,993 − ₹95,933 received, the report said ₹2,88,039.
--
-- Proves:
--   A. a yearly quote with TWO subscriptions, part-paid (₹5,000 of ₹11,800): balance ₹6,800 on the
--      first, 0 on the second → no row (the old rule listed the second one).
--   B. a quote billed quarterly with TWO subscriptions, Q1 paid ₹60 short (the staging MOTION
--      PHILM shape) → no row (the old rule listed both, ≈ ₹2,88,000 each).
--   C. a real drift — yearly quote ₹5,900 not paid, its one subscription says 0 → exactly ONE row,
--      difference −5,900, expected_from 'quote_open_balance'.
--   D. a quote whose only subscription is cancelled (cancel clears its due, R-1711) → no row.
--   E. the old per-subscription rule really listed A, B (twice), C and D (5 rows) — the bug this replaces.
--   F. only service_role (and the owner) may run it; anon / authenticated cannot.

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

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000215401','R2154 Co','r2154@example.in','07','R2154');

insert into public.customers (id, tenant_id, name, state_code, country)
select ('cccccccc-0000-0000-0000-00000021540' || n)::uuid, 'dddddddd-0000-0000-0000-000000215401',
       'Cust 2154-' || n, '07', 'India'
  from generate_series(1, 4) n;

-- A yearly 2 lines (₹11,800); B quarterly 2 lines (₹3,83,972 = 4 × ₹95,993); C yearly ₹5,900;
-- D yearly ₹5,900 (its subscription is cancelled).
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
select 'TESTQ-R2154-' || x.k, 'dddddddd-0000-0000-0000-000000215401', c.name, c.id, 18, x.amount, x.subtotal,
       x.cycle::billing_cycle, 'accepted', x.lines::jsonb
  from (values
    ('A', 1, 11800, 10000, 'yearly',
     '[{"name":"Google Workspace Business Starter","qty":2,"rate":3000,"commitment":"annual_yearly"},
       {"name":"Google Workspace Business Standard","qty":1,"rate":4000,"commitment":"annual_yearly"}]'),
    ('B', 2, 383972, 325400, 'quarterly',
     '[{"name":"Google Workspace Business Starter","qty":57,"rate":3200,"commitment":"annual_quarterly"},
       {"name":"Google Workspace Business Standard","qty":13,"rate":11000,"commitment":"annual_quarterly"}]'),
    ('C', 3, 5900, 5000, 'yearly',
     '[{"name":"Google Workspace Business Starter","qty":1,"rate":5000,"commitment":"annual_yearly"}]'),
    ('D', 4, 5900, 5000, 'yearly',
     '[{"name":"Google Workspace Business Starter","qty":1,"rate":5000,"commitment":"annual_yearly"}]')
  ) as x(k, n, amount, subtotal, cycle, lines)
  join public.customers c on c.id = ('cccccccc-0000-0000-0000-00000021540' || x.n)::uuid;

-- C and D: one subscription each, as filed. A's and B's two each are filed by record_payment below
-- (the Record payment sheet / reconcile path), B's capped by tg_subscriptions_split_outstanding.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status, outstanding_amount, created_at)
select ('eeeeeeee-0000-0000-0000-0000002154' || x.n || x.k)::uuid, q.tenant_id, q.customer_id, q.customer_name,
       x.plan, 'google'::vendor, x.seats, x.mrr, x.cycle::billing_cycle, q.id,
       public.ist_today() - 7, x.status::sub_status, 0,
       now() - interval '1 hour' + make_interval(secs => x.k)
  from (values
    ('C', 3, 1, 'Google Workspace Business Starter',  1,   417,   'yearly',    'active'),
    ('D', 4, 1, 'Google Workspace Business Starter',  1,   417,   'yearly',    'cancelled')
  ) as x(qk, n, k, plan, seats, mrr, cycle, status)
  join public.quotes q on q.id = 'TESTQ-R2154-' || x.qk;

-- The receipts through the real path (record_payment: the Record payment sheet / reconcile).
do $$
begin
  perform public.record_payment('TESTQ-R2154-A', 5000,  'upi', 'R2154-PAY-A');
  perform public.record_payment('TESTQ-R2154-B', 95933, 'upi', 'R2154-PAY-B');
end $$;

do $$
declare
  v_stored integer;
  v_n      integer;
  v_row    record;
  v_old    integer;
begin
  -- Setup is the staging shape: the quote's balance rides on its FIRST subscription.
  if (select count(*) from public.subscriptions where quote_id = 'TESTQ-R2154-A') <> 2
     or (select count(*) from public.subscriptions where quote_id = 'TESTQ-R2154-B') <> 2 then
    raise exception 'SETUP: A and B must each have two subscriptions';
  end if;
  select sum(coalesce(outstanding_amount, 0)) into v_stored from public.subscriptions where quote_id = 'TESTQ-R2154-A';
  if v_stored is distinct from 6800 then
    raise exception 'SETUP A: stored % on the yearly 2-subscription quote (want 6,800)', v_stored;
  end if;
  select sum(coalesce(outstanding_amount, 0)) into v_stored from public.subscriptions where quote_id = 'TESTQ-R2154-B';
  if v_stored is distinct from 60 then
    raise exception 'SETUP B: stored % on the quarterly quote (want 60 = Q1 95,993 − 95,933)', v_stored;
  end if;

  -- E. the old per-subscription rule (scripts/ops/r1708-dues-drift-report.sql before R-2154).
  select count(*) into v_old
    from public.subscriptions s
   where s.tenant_id = 'dddddddd-0000-0000-0000-000000215401'
     and s.quote_id is not null and s.written_off_at is null
     and abs(coalesce(s.outstanding_amount, 0) - public.quote_open_balance(s.quote_id)) >= 1;
  if v_old <> 5 then
    raise exception 'E: the old rule listed % rows here (want 5: A second, B both, C, D)', v_old;
  end if;

  -- A + B + D: no row. C: exactly one.
  select count(*) into v_n from public.subscription_dues_drift() d
   where d.tenant_id = 'dddddddd-0000-0000-0000-000000215401';
  if v_n <> 1 then
    raise exception 'FAIL: % row(s) (want 1 — only C): %', v_n,
      (select string_agg(d.quote_id || ' ' || d.difference, ', ') from public.subscription_dues_drift() d
        where d.tenant_id = 'dddddddd-0000-0000-0000-000000215401');
  end if;
  select * into v_row from public.subscription_dues_drift() d
   where d.tenant_id = 'dddddddd-0000-0000-0000-000000215401';
  if v_row.quote_id <> 'TESTQ-R2154-C' or v_row.difference <> -5900 or v_row.stored_outstanding <> 0
     or v_row.expected_outstanding <> 5900 or v_row.expected_from <> 'quote_open_balance'
     or v_row.subscriptions <> 1 or v_row.quote_invoiced then
    raise exception 'C FAIL: %', to_jsonb(v_row);
  end if;
end $$;

-- F. only service_role / the owner.
do $$
begin
  if has_function_privilege('anon', 'public.subscription_dues_drift()', 'execute')
     or has_function_privilege('authenticated', 'public.subscription_dues_drift()', 'execute') then
    raise exception 'F FAIL: anon/authenticated can run the all-company dues report';
  end if;
  if not has_function_privilege('service_role', 'public.subscription_dues_drift()', 'execute') then
    raise exception 'F FAIL: service_role cannot run it';
  end if;
end $$;

select 'R-2154 dues drift per quote: PASS' as result;

rollback;
