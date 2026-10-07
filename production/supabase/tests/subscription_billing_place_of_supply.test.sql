-- R-372 (7 Oct 2026): instalment invoices — place of supply, export, due date.
-- Migration 20261007130000_subscription_billing_place_of_supply.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only:
--   begin; \i 20261007130000_subscription_billing_place_of_supply.sql; \i subscription_billing_place_of_supply.test.sql; rollback;
-- (the file itself does not begin/commit).
--
-- Proves:
--   A. customer with NO state and NO GSTIN → refused with a reason, instalment stays unbilled
--      (the old body issued it as CGST+SGST, inter_state = false).
--   B. no state_code but GSTIN 29… (Karnataka) vs seller 07 (Delhi) → IGST (inter_state true).
--   C. customer in the USA → zero-rated: tax 0, rate 0, gross = taxable, not inter-state.
--   D. same-state customer, no quote terms → due = issue + 30 (was issue day), 18% CGST+SGST.
--   E. seller with no state but a GSTIN → its prefix is used.

-- R-380: own begin/rollback so scripts/test-sql.mjs (CI) runs it after the migrations are applied.
begin;

select set_config('request.jwt.claims', '', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000037201','R372 Co','r372@example.in','07','R372A'),
         ('dddddddd-0000-0000-0000-000000037202','R372 NoState','r372b@example.in',null,'Q372B');
update public.tenants set gstin = '27AAAAA0000A1Z5' where id = 'dddddddd-0000-0000-0000-000000037202';

insert into public.customers (id, tenant_id, name, state_code, gstin, country) values
  ('cccccccc-0000-0000-0000-000000037201','dddddddd-0000-0000-0000-000000037201','NoState 372', null, null, 'India'),
  ('cccccccc-0000-0000-0000-000000037202','dddddddd-0000-0000-0000-000000037201','Karnataka 372', null, '29ABCDE1234F1Z5', 'India'),
  ('cccccccc-0000-0000-0000-000000037203','dddddddd-0000-0000-0000-000000037201','US 372', null, null, 'USA'),
  ('cccccccc-0000-0000-0000-000000037204','dddddddd-0000-0000-0000-000000037201','Delhi 372', '7', null, 'India'),
  ('cccccccc-0000-0000-0000-000000037205','dddddddd-0000-0000-0000-000000037202','Pune 372', '27', null, 'India');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle)
select ('eeeeeeee-0000-0000-0000-00000003720' || n)::uuid,
       case when n = 5 then 'dddddddd-0000-0000-0000-000000037202' else 'dddddddd-0000-0000-0000-000000037201' end::uuid,
       ('cccccccc-0000-0000-0000-00000003720' || n)::uuid,
       'Cust ' || n, 'Workspace Starter', 'google'::vendor, 2, 1000, 'monthly'::billing_cycle
  from generate_series(1, 5) n;

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-00000003720' || n)::uuid,
       case when n = 5 then 'dddddddd-0000-0000-0000-000000037202' else 'dddddddd-0000-0000-0000-000000037201' end::uuid,
       ('eeeeeeee-0000-0000-0000-00000003720' || n)::uuid,
       public.ist_today(), 1, public.ist_today(), public.ist_today(), public.ist_today() + 29, 1000, 18
  from generate_series(1, 5) n;

-- ── A. unknown state → refused, nothing issued ─────────────────────────────────
do $$
declare v_msg text; v_inv text;
begin
  begin
    perform * from public.raise_subscription_billing('bbbbbbbb-0000-0000-0000-000000037201');
    raise exception 'A FAIL: instalment for a customer with no state was issued';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
  end;
  if v_msg not like '%Cust 1 has no state%' or v_msg not like '%Customers%' then
    raise exception 'A FAIL: refusal does not name the customer / fixing screen: %', v_msg;
  end if;
  select invoice_id into v_inv from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000037201';
  if v_inv is not null then raise exception 'A FAIL: instalment marked billed after refusal'; end if;
  raise notice 'A PASS: no state → refused (%).', left(v_msg, 60);
end $$;

-- ── B. GSTIN prefix fallback → inter-state IGST ────────────────────────────────
do $$
declare r record; i record;
begin
  select * into r from public.raise_subscription_billing('bbbbbbbb-0000-0000-0000-000000037202');
  select * into i from public.invoices where id = r.invoice_id;
  if i.inter_state is distinct from true then raise exception 'B FAIL: GSTIN 29 vs seller 07 not inter-state (%)', i.inter_state; end if;
  if i.tax_amount <> 180 or i.tax_rate <> 18 or i.amount <> 1180 then
    raise exception 'B FAIL: tax %/% amount %', i.tax_amount, i.tax_rate, i.amount; end if;
  if i.pos_state_code is distinct from '29' then raise exception 'B FAIL: pos_state_code % (head and printed POS disagree)', i.pos_state_code; end if;
  raise notice 'B PASS: GSTIN 29… → IGST, POS 29.';
end $$;

-- ── C. export → zero-rated ─────────────────────────────────────────────────────
do $$
declare r record; i record;
begin
  select * into r from public.raise_subscription_billing('bbbbbbbb-0000-0000-0000-000000037203');
  select * into i from public.invoices where id = r.invoice_id;
  if i.tax_amount <> 0 or i.tax_rate <> 0 then raise exception 'C FAIL: export taxed %/%', i.tax_amount, i.tax_rate; end if;
  if i.amount <> 1000 or r.gross <> 1000 or i.net_payable <> 1000 then
    raise exception 'C FAIL: export gross % / returned % / net %', i.amount, r.gross, i.net_payable; end if;
  if i.inter_state is distinct from false then raise exception 'C FAIL: export marked inter-state'; end if;
  raise notice 'C PASS: export → zero-rated, ₹1,000.';
end $$;

-- ── D. same state ("7" = "07"), no terms → due +30, CGST+SGST ──────────────────
do $$
declare r record; i record;
begin
  select * into r from public.raise_subscription_billing('bbbbbbbb-0000-0000-0000-000000037204');
  select * into i from public.invoices where id = r.invoice_id;
  if i.inter_state is distinct from false then raise exception 'D FAIL: state 7 vs 07 treated as inter-state'; end if;
  if i.due_date <> i.invoice_date + 30 then
    raise exception 'D FAIL: due % vs issue % (want +30)', i.due_date, i.invoice_date; end if;
  if i.amount <> 1180 then raise exception 'D FAIL: amount %', i.amount; end if;
  -- idempotent second call
  select * into r from public.raise_subscription_billing('bbbbbbbb-0000-0000-0000-000000037204');
  if not r.already_raised then raise exception 'D FAIL: second call raised again'; end if;
  raise notice 'D PASS: intra-state, due +30, idempotent.';
end $$;

-- ── E. seller state from its GSTIN (27) → same-state customer 27 is intra ─────
do $$
declare r record; i record;
begin
  select * into r from public.raise_subscription_billing('bbbbbbbb-0000-0000-0000-000000037205');
  select * into i from public.invoices where id = r.invoice_id;
  if i.inter_state is distinct from false then raise exception 'E FAIL: seller GSTIN 27 vs customer 27 not intra'; end if;
  raise notice 'E PASS: seller state from GSTIN prefix.';
end $$;

select 'R-372 subscription billing place-of-supply: ALL PASS' as result;

rollback;
