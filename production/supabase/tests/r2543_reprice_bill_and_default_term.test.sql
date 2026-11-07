-- R-2543 (6 Nov 2026, independent review rv-train3 — train blockers for R-2541 and R-2533).
-- Migration 20261106162400_r2543_freed_part_reprice_and_default_term.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. reprice_and_bill_part: a freed part 17 × ₹300 = ₹5,100 → ₹5,400 and its proforma in ONE call;
--      the proforma asks ₹6,372 (5,400 + 18%), reprice = applied.
--   B. the bill FAILS (proforma insert refused) → the whole call raises and the part keeps ₹5,100.
--   C. the bill makes no invoice / proforma (waiting: a sibling of the same quote has no parts) →
--      the old ₹5,100 is put back (reprice = restored).
--   D. a part with a proforma linked → not repriced (proforma_linked), answer request_open.
--   E. the part no longer holds p_from (re-synced meanwhile) → not repriced (amount_changed).
--   F. a sales user / another company's user is refused before anything is written.
--   G. the filer's default (start + 1 year) on a 36-month quarterly row from a quote whose line has
--      a too-short renewal date → start + 36 months − 1 day; the insert is NOT refused (red without
--      the migration: trg_subscriptions_zzz_split_term_covers refuses it). With no line date too.
--   H. a 12-month half-yearly row keeps start + 1 year (R-2533's H1 unchanged).

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

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000254301','R2543 Co','r2543@example.in','07','RB43'),
  ('dddddddd-0000-0000-0000-000000254302','R2543 Other','r2543o@example.in','07','RB44');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000254301','sales2543@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000254302','owner2543o@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000254301','dddddddd-0000-0000-0000-000000254301','sales2543@example.in','Sales 2543','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000254302','dddddddd-0000-0000-0000-000000254302','owner2543o@example.in','Owner 2543o','owner', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('cccccccc-0000-0000-0000-000000254301','dddddddd-0000-0000-0000-000000254301','Bit Labs 2543','27','India');

-- Subscriptions 1..5: monthly, 18 seats (₹300 a seat), parts laid at the OLD 17 seats (₹5,100).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, term_months, start_date, renewal_date, status, domain)
select ('eeeeeeee-0000-0000-0000-00000025430' || n)::uuid, 'dddddddd-0000-0000-0000-000000254301',
       'cccccccc-0000-0000-0000-000000254301', 'Bit Labs 2543', 'Google Workspace Business Starter', 'google'::vendor,
       18, 5400, 'monthly'::billing_cycle, 1, public.ist_today() - 35, public.ist_today() + 25, 'active', 'bit' || n || '.in'
  from generate_series(1, 5) n;
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-00000025430' || n)::uuid, 'dddddddd-0000-0000-0000-000000254301',
       ('eeeeeeee-0000-0000-0000-00000025430' || n)::uuid,
       public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 25, 5100, 18
  from generate_series(1, 5) n;

-- C: subscription 3 belongs to a quote with a second active monthly subscription that has NO parts.
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, status, payment_status, line_items, billing_cycle)
values ('TESTQ-R2543-C', 'dddddddd-0000-0000-0000-000000254301', 'Bit Labs 2543', 'cccccccc-0000-0000-0000-000000254301',
        18, 6372, 5400, 'accepted', 'received', '[]'::jsonb, 'monthly');
update public.subscriptions set quote_id = 'TESTQ-R2543-C' where id = 'eeeeeeee-0000-0000-0000-000000254303';
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, term_months, start_date, renewal_date, status, domain, quote_id)
values ('eeeeeeee-0000-0000-0000-000000254309', 'dddddddd-0000-0000-0000-000000254301', 'cccccccc-0000-0000-0000-000000254301',
        'Bit Labs 2543', 'Google Workspace Business Plus', 'google'::vendor, 2, 1200, 'monthly'::billing_cycle, 1,
        public.ist_today() - 35, public.ist_today() + 25, 'active', 'bit9.in', 'TESTQ-R2543-C');

-- D: part 4 has a proforma linked.
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, status, payment_status, line_items, subscription_billing_id)
values ('TESTQ-R2543-D', 'dddddddd-0000-0000-0000-000000254301', 'Bit Labs 2543', 'cccccccc-0000-0000-0000-000000254301',
        18, 6018, 5100, 'sent', 'awaiting', '[]'::jsonb, 'bbbbbbbb-0000-0000-0000-000000254304');

-- F (first, before anything is billed): a sales user and another company's owner are refused.
do $$
begin
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000254301","role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform public.reprice_and_bill_part('bbbbbbbb-0000-0000-0000-000000254301', 5100, 5400);
    raise exception 'F1: a sales user repriced and billed a part';
  exception when sqlstate '42501' then null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000254302","role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform public.reprice_and_bill_part('bbbbbbbb-0000-0000-0000-000000254301', 5100, 5400);
    raise exception 'F2: another company''s owner repriced and billed a part';
  exception when sqlstate '42501' then null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if (select taxable_amount from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000254301') <> 5100 then
    raise exception 'F: a refused call changed the part';
  end if;
end $$;

-- A. reprice + bill in one call.
do $$
declare v jsonb; v_q record;
begin
  v := public.reprice_and_bill_part('bbbbbbbb-0000-0000-0000-000000254301', 5100, 5400);
  if v->>'action' <> 'request' or v->>'reprice' <> 'applied' then
    raise exception 'A: expected a proforma with reprice applied, got %', v;
  end if;
  if (select taxable_amount from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000254301') <> 5400 then
    raise exception 'A: the part was not repriced to 5400';
  end if;
  select q.amount into v_q from public.quotes q where q.subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000254301';
  if v_q.amount <> 6372 then
    raise exception 'A: the proforma asks % (want 6372 = 5400 + 18%%)', v_q.amount;
  end if;
end $$;

-- B. the bill fails → nothing stays (the reprice is rolled back with it).
create function pg_temp.r2543_refuse_quote() returns trigger language plpgsql as $f$
begin
  raise exception 'R2543 test: proforma refused' using errcode = 'P0001';
end $f$;
create trigger zz_r2543_refuse before insert on public.quotes
  for each row execute function pg_temp.r2543_refuse_quote();
do $$
begin
  begin
    perform public.reprice_and_bill_part('bbbbbbbb-0000-0000-0000-000000254302', 5100, 5400);
    raise exception 'B: the bill was expected to fail';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%proforma refused%' then raise; end if;
  end;
  if (select taxable_amount from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000254302') <> 5100 then
    raise exception 'B: the bill failed but the part kept the new amount';
  end if;
end $$;
drop trigger zz_r2543_refuse on public.quotes;

-- C. waiting (a sibling has no parts) → old amount back.
do $$
declare v jsonb;
begin
  v := public.reprice_and_bill_part('bbbbbbbb-0000-0000-0000-000000254303', 5100, 5400);
  if v->>'action' <> 'waiting' or v->>'reprice' <> 'restored' then
    raise exception 'C: expected waiting + restored, got %', v;
  end if;
  if (select taxable_amount from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000254303') <> 5100 then
    raise exception 'C: nothing was billed but the part kept the new amount';
  end if;
end $$;

-- D. a proforma linked → not repriced. E. the amount moved meanwhile → not repriced.
do $$
declare v jsonb;
begin
  v := public.reprice_and_bill_part('bbbbbbbb-0000-0000-0000-000000254304', 5100, 5400);
  if v->>'reprice' <> 'proforma_linked' or v->>'action' <> 'request_open' then
    raise exception 'D: expected proforma_linked + request_open, got %', v;
  end if;
  if (select taxable_amount from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000254304') <> 5100 then
    raise exception 'D: a part with a proforma linked was repriced';
  end if;
  update public.subscription_billings set taxable_amount = 5250 where id = 'bbbbbbbb-0000-0000-0000-000000254305';
  v := public.reprice_and_bill_part('bbbbbbbb-0000-0000-0000-000000254305', 5100, 5400);
  if v->>'reprice' <> 'amount_changed' then
    raise exception 'E: expected amount_changed, got %', v;
  end if;
  if (select taxable_amount from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000254305') <> 5250 then
    raise exception 'E: a part whose amount moved meanwhile was overwritten';
  end if;
end $$;

-- G / H. the filer's default renewal date on a split-billed row.
insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle, status, line_items)
values
  ('TESTQ-R2543-G1', 'dddddddd-0000-0000-0000-000000254301', 'cccccccc-0000-0000-0000-000000254301', 'Bit Labs 2543',
   18, 3540, 3000, 'quarterly', 'accepted',
   '[{"name":"Workspace G1","qty":1,"rate":3000,"start_date":"2026-06-19","renewal_date":"2027-06-19"}]'::jsonb),
  ('TESTQ-R2543-G2', 'dddddddd-0000-0000-0000-000000254301', 'cccccccc-0000-0000-0000-000000254301', 'Bit Labs 2543',
   18, 3540, 3000, 'quarterly', 'accepted',
   '[{"name":"Workspace G2","qty":1,"rate":3000}]'::jsonb),
  ('TESTQ-R2543-H', 'dddddddd-0000-0000-0000-000000254301', 'cccccccc-0000-0000-0000-000000254301', 'Bit Labs 2543',
   18, 3540, 3000, 'half_yearly', 'accepted',
   '[{"name":"Workspace H","qty":1,"rate":3000}]'::jsonb);

insert into public.subscriptions
  (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle, start_date, renewal_date, quote_id)
values
  ('eeeeeeee-0000-0000-0000-0000002543a1', 'dddddddd-0000-0000-0000-000000254301', 'cccccccc-0000-0000-0000-000000254301',
   'Bit Labs 2543', 'Workspace G1', 'google', 1, 250, 36, 'quarterly', '2026-06-19', '2027-06-19', 'TESTQ-R2543-G1'),
  ('eeeeeeee-0000-0000-0000-0000002543a2', 'dddddddd-0000-0000-0000-000000254301', 'cccccccc-0000-0000-0000-000000254301',
   'Bit Labs 2543', 'Workspace G2', 'google', 1, 250, 36, 'quarterly', '2026-03-31', '2027-03-31', 'TESTQ-R2543-G2'),
  ('eeeeeeee-0000-0000-0000-0000002543a3', 'dddddddd-0000-0000-0000-000000254301', 'cccccccc-0000-0000-0000-000000254301',
   'Bit Labs 2543', 'Workspace H', 'google', 1, 250, 12, 'half_yearly', '2026-06-19', '2027-06-19', 'TESTQ-R2543-H');

do $$
declare v_g1 date; v_g2 date; v_h date;
begin
  select renewal_date into v_g1 from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-0000002543a1';
  select renewal_date into v_g2 from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-0000002543a2';
  select renewal_date into v_h  from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-0000002543a3';
  if v_g1 <> '2029-06-18' then
    raise exception 'G1: 36-month quarterly default (line date 1 year) should be 18 Jun 2029, got %', v_g1;
  end if;
  if v_g2 <> '2029-03-30' then
    raise exception 'G2: 36-month quarterly default from 31 Mar 2026 (no line date) should be 30 Mar 2029, got %', v_g2;
  end if;
  if v_h <> '2027-06-19' then
    raise exception 'H: a 12-month half-yearly row must keep start + 1 year (19 Jun 2027), got %', v_h;
  end if;
  raise notice 'PASS R-2543: freed part repriced + billed in one transaction (failed bill rolls back, no bill restores, proforma / moved amount untouched, wrong caller refused); a split-billed default renewal never fails the guard';
end $$;

rollback;
