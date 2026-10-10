-- Regression test: R-527 — an annual commitment billed quarterly owes only the instalments
-- that have fallen due (migration 20261009235800_split_billed_outstanding).
--
-- Self-asserting (RAISEs on failure), inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/split_billed_outstanding.test.sql
--
-- The shape is the one measured on 9 Oct 2026 (Q-FBB9-27-0020): Starter x 8, annual
-- commitment, billed quarterly, Rs 25,920 ex-GST, quotes.amount Rs 30,586.
--   1. quote_split_due: 4 quarters of Rs 6,480 + round(1,166.40) = Rs 7,646 each; Q1 due on
--      day one, Q1+Q2 = 15,292 once Q2's date arrives, the year = 30,584.
--   2. Paying Q1 (Rs 7,646) leaves the subscription owing Rs 0 — it was Rs 22,940.
--   3. The four schedule rows + raise_subscription_billing(Q1) give ONE paid invoice of
--      Rs 7,646 (taxable 6,480, tax 1,166) and mark that row invoiced; Q2..Q4 stay open.
--   4. When Q2's date has arrived sync_split_outstanding raises OWED to Rs 7,646; paying it
--      brings it back to 0 (record_payment's own 30,586-based figure is capped).
--   5. Monthly and half-yearly use the same rule; a YEARLY quote is untouched (owes
--      amount - paid exactly as before).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('e5270000-0000-0000-0000-0000000527d1', 'R527 TEST', 'r527@example.in', '07');
insert into public.customers (id, tenant_id, name, state_code)
  values ('cccccccc-0000-0000-0000-0000000527c1', 'e5270000-0000-0000-0000-0000000527d1', 'R527 Quarterly Co', '07'),
         ('cccccccc-0000-0000-0000-0000000527c2', 'e5270000-0000-0000-0000-0000000527d1', 'R527 Yearly Co', '07');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('e5270000-0000-0000-0000-0000000527d1', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 0);

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, discount_pct,
                           status, payment_status, billing_cycle, line_items)
values
  ('Q-R527-QTR', 'e5270000-0000-0000-0000-0000000527d1', 'cccccccc-0000-0000-0000-0000000527c1', 'R527 Quarterly Co',
   30586, 25920, 18, 0, 'sent', 'awaiting', 'quarterly',
   '[{"name":"Google Workspace Business Starter","qty":8,"rate":3240,"commitment":"annual_yearly"}]'::jsonb),
  ('Q-R527-MON', 'e5270000-0000-0000-0000-0000000527d1', null, 'R527 Monthly', 30586, 25920, 18, 0, 'draft', 'none', 'monthly',
   '[{"name":"Google Workspace Business Starter","qty":8,"rate":3240,"commitment":"annual_yearly"}]'::jsonb),
  ('Q-R527-HALF', 'e5270000-0000-0000-0000-0000000527d1', null, 'R527 Half', 30586, 25920, 18, 0, 'draft', 'none', 'half_yearly',
   '[{"name":"Google Workspace Business Starter","qty":8,"rate":3240,"commitment":"annual_yearly"}]'::jsonb),
  ('Q-R527-FLEX', 'e5270000-0000-0000-0000-0000000527d1', null, 'R527 Flex', 2549, 2160, 18, 0, 'draft', 'none', 'monthly',
   '[{"name":"Google Workspace Business Starter","qty":8,"rate":270,"commitment":"monthly"}]'::jsonb),
  ('Q-R527-YR', 'e5270000-0000-0000-0000-0000000527d1', 'cccccccc-0000-0000-0000-0000000527c2', 'R527 Yearly Co',
   30586, 25920, 18, 0, 'sent', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Starter","qty":8,"rate":3240,"commitment":"annual_yearly"}]'::jsonb);

-- ── 1. the due figure ────────────────────────────────────────────────────────
do $$
declare d date := date '2026-10-09';
begin
  if public.quote_split_due('Q-R527-QTR', d, d) <> 7646 then
    raise exception 'FAIL 1a: Q1 due on day one should be 7646, got %', public.quote_split_due('Q-R527-QTR', d, d); end if;
  if public.quote_split_due('Q-R527-QTR', d, date '2027-01-08') <> 7646 then
    raise exception 'FAIL 1b: the day before Q2 only Q1 is due'; end if;
  if public.quote_split_due('Q-R527-QTR', d, date '2027-01-09') <> 15292 then
    raise exception 'FAIL 1c: on Q2''s date Q1+Q2 = 15292, got %', public.quote_split_due('Q-R527-QTR', d, date '2027-01-09'); end if;
  if public.quote_split_due('Q-R527-QTR', d, date '2027-12-31') <> 30584 then
    raise exception 'FAIL 1d: the year of instalments is 4 x 7646 = 30584'; end if;
  -- monthly: 25920/12 = 2160 + round(388.8) = 2549 a month
  if public.quote_split_due('Q-R527-MON', d, d) <> 2549 then
    raise exception 'FAIL 1e: monthly first instalment should be 2549, got %', public.quote_split_due('Q-R527-MON', d, d); end if;
  -- half-yearly: 12960 + round(2332.8) = 15293
  if public.quote_split_due('Q-R527-HALF', d, d) <> 15293 then
    raise exception 'FAIL 1f: half-yearly first instalment should be 15293, got %', public.quote_split_due('Q-R527-HALF', d, d); end if;
  if public.quote_split_due('Q-R527-FLEX', d, d) is not null then
    raise exception 'FAIL 1g: a flex quote has nothing to split'; end if;
  if public.quote_split_due('Q-R527-YR', d, d) is not null then
    raise exception 'FAIL 1h: a yearly quote is not split-billed'; end if;
  raise notice 'PASS 1: quarterly 7646 / 15292 / 30584, monthly 2549, half-yearly 15293, flex + yearly null';
end $$;

-- ── 2. paying Q1 owes nothing more today ─────────────────────────────────────
do $$
declare v_out integer; v_sub uuid;
begin
  perform public.record_payment('Q-R527-QTR', 7646, 'upi', 'r527-q1');
  select id, outstanding_amount into v_sub, v_out from public.subscriptions where quote_id = 'Q-R527-QTR';
  if v_sub is null then raise exception 'FAIL 2a: no subscription was created'; end if;
  if v_out <> 0 then
    raise exception 'FAIL 2b: after paying Q1 the subscription owes % (was 22940 before R-527), expected 0', v_out; end if;
  raise notice 'PASS 2: Q1 paid -> OWED 0';
end $$;

-- ── 3. the schedule rows + Q1 invoice ────────────────────────────────────────
do $$
declare v_sub record; v_inv record; v_row record; n int;
begin
  select * into v_sub from public.subscriptions where quote_id = 'Q-R527-QTR';
  insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount)
  select v_sub.tenant_id, v_sub.id, v_sub.start_date, i + 1,
         (v_sub.start_date + make_interval(months => 3 * i))::date,
         (v_sub.start_date + make_interval(months => 3 * i))::date,
         (v_sub.start_date + make_interval(months => 3 * (i + 1)))::date,
         (v_sub.mrr * 12) / 4
    from generate_series(0, 3) i;
  select count(*) into n from public.subscription_billings where subscription_id = v_sub.id;
  if n <> 4 then raise exception 'FAIL 3a: expected 4 schedule rows, got %', n; end if;

  select * into v_row from public.subscription_billings where subscription_id = v_sub.id and period_index = 1;
  perform public.raise_subscription_billing(v_row.id);
  select i.* into v_inv from public.invoices i
    join public.subscription_billings b on b.invoice_id = i.id
   where b.id = v_row.id;
  if v_inv.id is null then raise exception 'FAIL 3b: Q1 row has no invoice'; end if;
  if v_inv.amount <> 7646 or v_inv.taxable_value <> 6480 or v_inv.tax_amount <> 1166 then
    raise exception 'FAIL 3c: Q1 invoice % / % / %, expected 7646 / 6480 / 1166', v_inv.amount, v_inv.taxable_value, v_inv.tax_amount; end if;
  if v_inv.status <> 'paid' then raise exception 'FAIL 3d: Q1 invoice is % — the Rs 7,646 received should settle it', v_inv.status; end if;
  select count(*) into n from public.subscription_billings where subscription_id = v_sub.id and invoice_id is null;
  if n <> 3 then raise exception 'FAIL 3e: expected Q2..Q4 still un-invoiced, got % open', n; end if;
  raise notice 'PASS 3: 4 rows, Q1 invoice 7646 paid, 3 open';
end $$;

-- ── 4. Q2 falls due, then is paid ────────────────────────────────────────────
do $$
declare v_sub uuid; v_out integer;
begin
  select id into v_sub from public.subscriptions where quote_id = 'Q-R527-QTR';
  -- move the term back so Q2's bill date (start + 3 months) has arrived
  update public.subscriptions set start_date = (public.ist_today() - interval '3 months')::date where id = v_sub;
  v_out := public.sync_split_outstanding(v_sub);
  if v_out <> 7646 then raise exception 'FAIL 4a: with Q2 due the sync should write 7646, got %', v_out; end if;
  select outstanding_amount into v_out from public.subscriptions where id = v_sub;
  if v_out <> 7646 then raise exception 'FAIL 4b: OWED column is %, expected 7646', v_out; end if;

  perform public.record_payment('Q-R527-QTR', 7646, 'upi', 'r527-q2');
  select outstanding_amount into v_out from public.subscriptions where id = v_sub;
  if v_out <> 0 then raise exception 'FAIL 4c: after paying Q2 OWED is % (record_payment alone writes 15294), expected 0', v_out; end if;

  -- a write-off to 0 is kept by the sync
  update public.subscriptions set written_off_at = now() where id = v_sub;
  if public.sync_split_outstanding(v_sub) is not null then raise exception 'FAIL 4d: sync touched a written-off row'; end if;
  raise notice 'PASS 4: Q2 due -> 7646, paid -> 0, written-off rows left alone';
end $$;

-- ── 5. yearly is untouched ───────────────────────────────────────────────────
do $$
declare v_out integer;
begin
  perform public.record_payment('Q-R527-YR', 10000, 'upi', 'r527-yr');
  select outstanding_amount into v_out from public.subscriptions where quote_id = 'Q-R527-YR';
  if v_out <> 20586 then raise exception 'FAIL 5: a yearly part-payment should still owe 20586, got %', v_out; end if;
  raise notice 'PASS 5: yearly owes amount - paid, as before';
end $$;

rollback;
