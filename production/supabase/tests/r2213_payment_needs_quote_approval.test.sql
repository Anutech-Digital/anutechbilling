-- R-2213 (31 Oct 2026): money on a BELOW-COST quote waits for the owner's approval.
-- July reconcile on staging (R-2094): Manage-seats quotes priced below cost showed 'Needs approval',
-- yet bank credits were reconciled to them and the quote then read 'Sent'. Pardeep's rule (card
-- decision, 31 Oct): block money only when the quote is below cost (quotes.below_cost, written by
-- the server from the TS lineEconomics) and not approved; Razorpay / website-checkout money is
-- never refused; a quote made in the same transaction (reconcile 'A new sale') is never below_cost.
-- Migration 20261031063739_r2213_payment_needs_quote_approval.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Owner's real path: an add-seats (Manage seats) quote, below cost, approval pending →
--      Banking → Reconcile (reconcile_bank_credit_to_item) is refused with the English reason,
--      and nothing is written (no payment, the bank line stays unreconciled).
--   B. record_payment ("Record payment" dialog) on the same quote is refused the same way.
--   C. A plain payments insert (any other path) is refused the same way — one guard.
--   D. Razorpay money on it is recorded (never refused); the quote stays pending (flagged).
--   E. After the owner approves, the same reconcile goes through.
--   F. A thin-margin quote that is NOT below cost (pending approval for a discount) is paid as before.

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
  ('dddddddd-0000-0000-0000-000000221301','R2213 Co','r2213@example.in','07','R2213');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000221301','owner2213@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000221302','owner2213b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000221301','dddddddd-0000-0000-0000-000000221301','owner2213@example.in','Owner 2213','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000221302','dddddddd-0000-0000-0000-000000221301','owner2213b@example.in','Owner B 2213','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000221301','dddddddd-0000-0000-0000-000000221301','Banbury 2213','07','banbury2213.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000221301','dddddddd-0000-0000-0000-000000221301','HDFC Current','HDFC');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  start_date, renewal_date, status, term_months, domain)
values ('eeeeeeee-0000-0000-0000-000000221301','dddddddd-0000-0000-0000-000000221301','cccccccc-0000-0000-0000-000000221301',
        'Banbury 2213','Google Workspace Business Standard','google',12,1000,'2026-04-01','2027-04-01','active',12,'banbury2213.in');

-- The staging shape (Q-0429): Manage seats → add 3 seats, pro-rata 3 × 500 = 1,500 + 18% = 1,770,
-- vendor cost 3 × 600 = 1,800 → BELOW COST. The server wrote approval pending (owner tier).
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, payment_status, billing_cycle, line_items,
                           is_add_seats, add_seats_subscription_id, is_one_off, created_date,
                           approval_status, approval_tier, approval_requested_by, approval_requested_at, below_cost)
values ('Q-R2213-SEATS','dddddddd-0000-0000-0000-000000221301','cccccccc-0000-0000-0000-000000221301','Banbury 2213',
        'Google Workspace Business Standard', 3, 1770, 1500, 1800, 0, 18, 'sent', 'awaiting', 'yearly',
        '[{"id":"add-seats-1","name":"Google Workspace Business Standard · +3 seats (pro-rata)","qty":3,"rate":500,"cost":600,"commitment":"annual_yearly"}]'::jsonb,
        true, 'eeeeeeee-0000-0000-0000-000000221301', false, '2026-07-10',
        'pending', 'owner', 'aaaaaaaa-0000-0000-0000-000000221301', now() - interval '1 hour', true);

-- F: thin margin (5%), pending for that reason — NOT below cost.
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, payment_status, billing_cycle, line_items,
                           is_add_seats, add_seats_subscription_id, is_one_off, created_date,
                           approval_status, approval_tier, approval_requested_by, approval_requested_at, below_cost)
values ('Q-R2213-THIN','dddddddd-0000-0000-0000-000000221301','cccccccc-0000-0000-0000-000000221301','Banbury 2213',
        'Google Workspace Business Standard', 2, 2360, 2000, 1900, 0, 18, 'sent', 'awaiting', 'yearly',
        '[{"id":"add-seats-1","name":"Google Workspace Business Standard · +2 seats (pro-rata)","qty":2,"rate":1000,"cost":950,"commitment":"annual_yearly"}]'::jsonb,
        true, 'eeeeeeee-0000-0000-0000-000000221301', false, '2026-07-11',
        'pending', 'owner', 'aaaaaaaa-0000-0000-0000-000000221301', now() - interval '1 hour', false);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000221301','dddddddd-0000-0000-0000-000000221301','bbbbbbbb-0000-0000-0000-000000221301','2026-07-15','NEFT BANBURY 2213 SEATS',0,1770,'UTR2213A','manual'),
  ('11111111-0000-0000-0000-000000221302','dddddddd-0000-0000-0000-000000221301','bbbbbbbb-0000-0000-0000-000000221301','2026-07-16','NEFT BANBURY 2213 THIN',0,2360,'UTR2213F','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000221301","role":"authenticated"}', true);

-- A. reconcile is refused, nothing written
do $$
declare v_msg text; n int;
begin
  begin
    perform public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000221301', 'Q-R2213-SEATS');
    raise exception 'FAIL A: reconcile on a below-cost quote waiting for approval went through';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'This quote is below cost and waits for the owner''s approval. Approve it first (Quotes → Q-R2213-SEATS → Approve), then record the payment.%' then
      raise exception 'FAIL A: wrong refusal: %', v_msg;
    end if;
  end;
  select count(*) into n from public.payments where quote_id = 'Q-R2213-SEATS';
  if n <> 0 then raise exception 'FAIL A: % payment(s) written', n; end if;
  if (select matched_at is not null from public.bank_transactions where id = '11111111-0000-0000-0000-000000221301') then
    raise exception 'FAIL A: bank line marked reconciled';
  end if;
  raise notice 'PASS A: reconcile refused with the approval reason, nothing written';
end $$;

-- B. Record payment dialog (record_payment) is refused the same way
do $$
declare v_msg text;
begin
  begin
    perform public.record_payment('Q-R2213-SEATS', 1770, 'bank_transfer', 'UTR2213B');
    raise exception 'FAIL B: record_payment went through';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'This quote is below cost and waits for the owner''s approval.%' then
      raise exception 'FAIL B: wrong refusal: %', v_msg;
    end if;
  end;
  raise notice 'PASS B: record_payment refused';
end $$;

-- C. any other insert path meets the same guard
do $$
declare v_msg text;
begin
  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference)
    values ('dddddddd-0000-0000-0000-000000221301', 'Q-R2213-SEATS', 'cccccccc-0000-0000-0000-000000221301', 1770, 'cash', 'C2213');
    raise exception 'FAIL C: plain insert went through';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'This quote is below cost and waits for the owner''s approval.%' then
      raise exception 'FAIL C: wrong refusal: %', v_msg;
    end if;
  end;
  raise notice 'PASS C: one guard on payments';
end $$;

-- D. Razorpay money is recorded, the quote stays pending (flagged for the owner)
do $$
declare n int;
begin
  insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference)
  values ('dddddddd-0000-0000-0000-000000221301', 'Q-R2213-SEATS', 'cccccccc-0000-0000-0000-000000221301', 100, 'razorpay', 'pay_R2213D');
  select count(*) into n from public.payments where quote_id = 'Q-R2213-SEATS' and method = 'razorpay';
  if n <> 1 then raise exception 'FAIL D: razorpay payment not recorded'; end if;
  if (select approval_status::text from public.quotes where id = 'Q-R2213-SEATS') <> 'pending' then
    raise exception 'FAIL D: quote no longer pending';
  end if;
  delete from public.payments where reference = 'pay_R2213D';
  raise notice 'PASS D: razorpay money never refused';
end $$;

-- F. thin margin, not below cost → paid as before
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000221302', 'Q-R2213-THIN');
  if not exists (select 1 from public.payments where quote_id = 'Q-R2213-THIN' and status = 'received') then
    raise exception 'FAIL F: thin-margin quote not paid: %', r;
  end if;
  raise notice 'PASS F: thin margin (not below cost) is not blocked';
end $$;

-- E. the other owner approves → the same reconcile goes through
select set_config('request.jwt.claims', '', true);
update public.quotes
   set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000221302', approved_at = now(),
       approved_margin_bps = -2000, approved_discount_bps = 0
 where id = 'Q-R2213-SEATS';
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000221301","role":"authenticated"}', true);
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000221301', 'Q-R2213-SEATS');
  if not exists (select 1 from public.payments where quote_id = 'Q-R2213-SEATS' and status = 'received' and amount = 1770) then
    raise exception 'FAIL E: approved quote not paid: %', r;
  end if;
  if (select matched_at is null from public.bank_transactions where id = '11111111-0000-0000-0000-000000221301') then
    raise exception 'FAIL E: bank line not reconciled';
  end if;
  raise notice 'PASS E: after approval the reconcile works';
end $$;

rollback;
