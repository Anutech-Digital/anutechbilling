-- R-2344 (1 Nov 2026): a BELOW-COST quote waiting for the owner's approval can no longer be
-- invoiced or activated on credit. R-2213 (tg_payments_quote_approval) refused only payments, so
-- after "Mark accepted" the quote page still offered "Invoice now" and "Activate now, pay later"
-- and the server took both — the owner's margin control was bypassed on credit.
-- Migration 20261101062059_r2344_invoice_activation_need_quote_approval: one rule
-- (quote_waits_cost_approval) used by the payments trigger AND new BEFORE INSERT triggers on
-- invoices and subscriptions linked to the quote.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Invoice now (generate_invoice) on an accepted, below-cost, pending quote is refused with the
--      R-2213 wording ("… then raise the invoice."), and no invoice is written.
--   B. Activate now, pay later (activate_quote_on_credit) on the same kind of quote is refused,
--      and no invoice / subscription is written, the quote is not marked on credit.
--   C. A plain subscriptions insert linked to the quote is refused ("… then activate it.").
--   D. Payments keep R-2213's exact refusal (the trigger now reads the shared rule).
--   E. Razorpay money already in → its invoice is raised (never lose the gateway's record).
--   F. A part payment request (R-2054, subscription_billing_id set) is never blocked.
--   G. A thin-margin quote (pending, NOT below cost) is invoiced as before.
--   H. After the other owner approves, Invoice now and Activate now, pay later both work.

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
  ('dddddddd-0000-0000-0000-000000234401','R2344 Co','r2344@example.in','07','R2344');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000234401','owner2344@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000234402','owner2344b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000234401','dddddddd-0000-0000-0000-000000234401','owner2344@example.in','Owner 2344','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000234402','dddddddd-0000-0000-0000-000000234401','owner2344b@example.in','Owner B 2344','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain, allow_pay_later, credit_limit) values
  ('cccccccc-0000-0000-0000-000000234401','dddddddd-0000-0000-0000-000000234401','Banbury 2344','07','banbury2344.in', true, 10000000);

-- Accepted quotes, 10 seats at ₹500 against a vendor cost of ₹600 → below cost, owner approval pending.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, total_cost, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items,
                           approval_status, approval_tier, approval_requested_by, approval_requested_at, below_cost)
select q, 'dddddddd-0000-0000-0000-000000234401', 'cccccccc-0000-0000-0000-000000234401', 'Banbury 2344',
       case when q = 'Q-R2344-THIN' then 11800 else 5900 end,
       case when q = 'Q-R2344-THIN' then 10000 else 5000 end,
       6000, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name','Google Workspace Business Standard','qty',10,
                         'rate', case when q = 'Q-R2344-THIN' then 1000 else 500 end,'cost',600,
                         'commitment','annual_yearly','domain', lower(q) || '.banbury2344.in')),
       'pending', 'owner', 'aaaaaaaa-0000-0000-0000-000000234401', now() - interval '1 hour',
       q <> 'Q-R2344-THIN'
  from unnest(array['Q-R2344-INV','Q-R2344-CREDIT','Q-R2344-RZP','Q-R2344-THIN']) q;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000234401","role":"authenticated"}', true);

-- A. Invoice now is refused, nothing written
do $$
declare v_msg text;
begin
  begin
    perform public.generate_invoice('Q-R2344-INV');
    raise exception 'FAIL A: Invoice now on a below-cost quote waiting for approval went through';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'This quote is below cost and waits for the owner''s approval. Approve it first (Quotes → Q-R2344-INV → Approve), then raise the invoice.%' then
      raise exception 'FAIL A: wrong refusal: %', v_msg;
    end if;
  end;
  if exists (select 1 from public.invoices where quote_id = 'Q-R2344-INV') then
    raise exception 'FAIL A: an invoice was written';
  end if;
  raise notice 'PASS A: Invoice now refused with the approval reason';
end $$;

-- B. Activate now, pay later is refused, nothing written
do $$
declare v_msg text;
begin
  begin
    perform public.activate_quote_on_credit('Q-R2344-CREDIT', 15, false, 'Old customer, pays on time');
    raise exception 'FAIL B: Activate now, pay later on a below-cost quote waiting for approval went through';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'This quote is below cost and waits for the owner''s approval. Approve it first (Quotes → Q-R2344-CREDIT → Approve), then %' then
      raise exception 'FAIL B: wrong refusal: %', v_msg;
    end if;
  end;
  if exists (select 1 from public.invoices where quote_id = 'Q-R2344-CREDIT')
     or exists (select 1 from public.subscriptions where quote_id = 'Q-R2344-CREDIT')
     or (select credit_activated_at is not null from public.quotes where id = 'Q-R2344-CREDIT') then
    raise exception 'FAIL B: something was written';
  end if;
  raise notice 'PASS B: Activate now, pay later refused';
end $$;

-- C. any other path that switches the service on meets the same guard
do $$
declare v_msg text;
begin
  begin
    insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                      start_date, renewal_date, status, term_months, domain, quote_id)
    values ('dddddddd-0000-0000-0000-000000234401','cccccccc-0000-0000-0000-000000234401','Banbury 2344',
            'Google Workspace Business Standard','google',10,417,'2026-11-01','2027-11-01','active',12,
            'c.banbury2344.in','Q-R2344-CREDIT');
    raise exception 'FAIL C: plain subscription insert went through';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'This quote is below cost and waits for the owner''s approval. Approve it first (Quotes → Q-R2344-CREDIT → Approve), then activate it.%' then
      raise exception 'FAIL C: wrong refusal: %', v_msg;
    end if;
  end;
  raise notice 'PASS C: one guard on subscriptions';
end $$;

-- D. payments keep R-2213's exact refusal
do $$
declare v_msg text;
begin
  begin
    perform public.record_payment('Q-R2344-INV', 5900, 'bank_transfer', 'UTR2344D');
    raise exception 'FAIL D: record_payment went through';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'This quote is below cost and waits for the owner''s approval. Approve it first (Quotes → Q-R2344-INV → Approve), then record the payment.%' then
      raise exception 'FAIL D: wrong refusal: %', v_msg;
    end if;
  end;
  raise notice 'PASS D: payment refusal unchanged';
end $$;

-- E. Razorpay money already in → the invoice for it is raised
do $$
begin
  perform public.record_payment('Q-R2344-RZP', 5900, 'razorpay', 'pay_R2344E');
  if not exists (select 1 from public.payments where quote_id = 'Q-R2344-RZP' and method = 'razorpay' and status = 'received') then
    raise exception 'FAIL E: razorpay payment not recorded';
  end if;
  if not exists (select 1 from public.invoices where quote_id = 'Q-R2344-RZP') then
    perform public.generate_invoice('Q-R2344-RZP');
  end if;
  if not exists (select 1 from public.invoices where quote_id = 'Q-R2344-RZP') then
    raise exception 'FAIL E: no invoice for the razorpay money';
  end if;
  raise notice 'PASS E: razorpay money is invoiced';
end $$;

-- F. a part payment request (R-2054, subscription_billing_id set) is never blocked by the rule
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  start_date, renewal_date, status, term_months, domain)
values ('eeeeeeee-0000-0000-0000-000000234401','dddddddd-0000-0000-0000-000000234401','cccccccc-0000-0000-0000-000000234401',
        'Banbury 2344','Google Workspace Business Standard','google',10,417,'2026-11-01','2027-11-01','active',12,'f.banbury2344.in');
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount)
values ('ffffffff-0000-0000-0000-000000234401','dddddddd-0000-0000-0000-000000234401','eeeeeeee-0000-0000-0000-000000234401',
        '2026-11-01', 2, '2027-02-01', '2027-02-01', '2027-04-30', 1250);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, total_cost, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, subscription_billing_id,
                           approval_status, below_cost)
values ('Q-R2344-PART','dddddddd-0000-0000-0000-000000234401','cccccccc-0000-0000-0000-000000234401','Banbury 2344',
        1475, 1250, 1500, 0, 18, 'sent', 'awaiting', 'yearly',
        '[{"name":"Google Workspace Business Standard","qty":10,"rate":125,"cost":150}]'::jsonb,
        'ffffffff-0000-0000-0000-000000234401', 'pending', true);
do $$
begin
  if public.quote_waits_cost_approval('Q-R2344-INV') is not true then
    raise exception 'FAIL F0: the pending below-cost quote does not wait';
  end if;
  if public.quote_waits_cost_approval('Q-R2344-PART') is not false then
    raise exception 'FAIL F: a part payment request waits for approval';
  end if;
  if public.quote_waits_cost_approval('Q-R2344-THIN') is not false then
    raise exception 'FAIL F: a thin-margin quote (not below cost) waits';
  end if;
  raise notice 'PASS F: part payment requests and thin margins are exempt';
end $$;

-- G. thin margin (not below cost) is invoiced as before
do $$
begin
  perform public.generate_invoice('Q-R2344-THIN');
  if not exists (select 1 from public.invoices where quote_id = 'Q-R2344-THIN') then
    raise exception 'FAIL G: thin-margin quote not invoiced';
  end if;
  raise notice 'PASS G: thin margin (not below cost) is not blocked';
end $$;

-- H. the other owner approves → Invoice now and Activate now, pay later both work
select set_config('request.jwt.claims', '', true);
update public.quotes
   set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000234402', approved_at = now(),
       approved_margin_bps = -2000, approved_discount_bps = 0
 where id in ('Q-R2344-INV','Q-R2344-CREDIT');
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000234401","role":"authenticated"}', true);
do $$
begin
  perform public.generate_invoice('Q-R2344-INV');
  if not exists (select 1 from public.invoices where quote_id = 'Q-R2344-INV') then
    raise exception 'FAIL H: approved quote not invoiced';
  end if;
  perform public.activate_quote_on_credit('Q-R2344-CREDIT', 15, false, 'Old customer, pays on time');
  if not exists (select 1 from public.subscriptions where quote_id = 'Q-R2344-CREDIT')
     or (select credit_activated_at is null from public.quotes where id = 'Q-R2344-CREDIT') then
    raise exception 'FAIL H: approved quote not activated on credit';
  end if;
  raise notice 'PASS H: after approval both work';
end $$;

rollback;
