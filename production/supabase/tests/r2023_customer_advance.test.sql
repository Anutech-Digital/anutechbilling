-- R-2023 (27 Oct 2026): a customer ADVANCE (R-1863 ₹0 "Advance on account" holder quote + receipt
-- voucher + open customer credit) is not a sale.
-- Migrations 20261027110130_r2023_customer_advance + 20261027110131_r2023_nav_badges_advance.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves (the owner's path: Banking → Reconcile → "Advance — nothing to invoice yet", then bill):
--   A. generate_invoice on the advance holder is REFUSED with a plain "customer advance … Use
--      advance" message — no invoice, no number taken, the quote unchanged.
--   B. The Payments Received badge (nav_badges().payments — "paid, GST invoice not raised")
--      does not count the advance; an ordinary paid quote still counts.
--   C. "Use advance" on the customer's next quote covers it in FULL with ₹0 cash
--      (record_desk_payment → redeem_customer_credits): quote paid, its GST invoice can be
--      raised, the advance drops to ₹0 and the Balance Sheet's advances fall by the same amount.
--   D. Partial use: a second advance used for part of a bill — the rest stays open.

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
  ('dddddddd-0000-0000-0000-000000202301','R2023 Co','r2023@example.in','07','R2023');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000202301','owner2023@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000202301','dddddddd-0000-0000-0000-000000202301','owner2023@example.in','Owner 2023','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000202301','dddddddd-0000-0000-0000-000000202301','Links 2023','07','links2023.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000202301','dddddddd-0000-0000-0000-000000202301','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000202301','dddddddd-0000-0000-0000-000000202301','bbbbbbbb-0000-0000-0000-000000202301','2026-10-23','NEFT LINKS 2023',0,47348,'UTR2023ADV','manual'),
  ('11111111-0000-0000-0000-000000202302','dddddddd-0000-0000-0000-000000202301','bbbbbbbb-0000-0000-0000-000000202301','2026-10-24','NEFT LINKS 2023 B',0,10000,'UTR2023ADV2','manual');

-- The customer's next sale (47,348 = 40,125 + 18%) and a later one for the partial case (5,900).
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
values
  ('Q-R2023-NEXT','dddddddd-0000-0000-0000-000000202301','cccccccc-0000-0000-0000-000000202301','Links 2023','Support',
   47348, 40125, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Support","qty":1,"rate":40125,"one_time":true}]'::jsonb, true, '2026-10-25'),
  ('Q-R2023-PART','dddddddd-0000-0000-0000-000000202301','cccccccc-0000-0000-0000-000000202301','Links 2023','Support',
   5900, 5000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Support","qty":1,"rate":5000,"one_time":true}]'::jsonb, true, '2026-10-25'),
  ('Q-R2023-PAID','dddddddd-0000-0000-0000-000000202301','cccccccc-0000-0000-0000-000000202301','Links 2023','Support',
   1180, 1000, 0, 18, 'accepted', 'received', 'yearly',
   '[{"name":"Support","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-10-25');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000202301","role":"authenticated"}', true);

create temp table r2023_ctx (k text primary key, v text);
grant all on r2023_ctx to public;

-- Book the advance, as the bank page does.
do $$
declare r jsonb; adv0 bigint;
begin
  select advances_from_customers into adv0 from public.report_balance_sheet('2026-10-31');
  r := public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000202301', 'cccccccc-0000-0000-0000-000000202301');
  insert into r2023_ctx values ('adv_quote', r->>'quote_id'), ('adv0', adv0::text);
end $$;

-- A. No invoice on an advance.
do $$
declare q text := (select v from r2023_ctx where k = 'adv_quote'); ok boolean := false; msg text;
        n_inv int; n_inv2 int;
begin
  select count(*) into n_inv from public.invoices where tenant_id = 'dddddddd-0000-0000-0000-000000202301';
  begin
    perform public.generate_invoice(q);
  exception when check_violation then
    msg := sqlerrm;
    ok := msg like '%is a customer advance%' and msg like '%47348%' and msg like '%Use advance%';
  end;
  if not ok then raise exception 'FAIL A: generate_invoice on advance % not refused with the advance message (got: %)', q, msg; end if;
  select count(*) into n_inv2 from public.invoices where tenant_id = 'dddddddd-0000-0000-0000-000000202301';
  if n_inv2 <> n_inv or (select invoice_id from public.quotes where id = q) is not null
     or (select payment_status::text from public.quotes where id = q) <> 'received' then
    raise exception 'FAIL A: something changed'; end if;
  if not public.is_customer_advance_quote('Advance on account', 0, null, '[]'::jsonb)
     or public.is_customer_advance_quote('Advance on account', 100, null, '[]'::jsonb)
     or public.is_customer_advance_quote('Support', 0, null, '[]'::jsonb) then
    raise exception 'FAIL A: is_customer_advance_quote rule'; end if;
  raise notice 'PASS A: advance % — no GST invoice, refused with the Use-advance message, nothing changed', q;
end $$;

-- B. Payments badge: the advance is not "paid, invoice not raised"; a paid quote is.
do $$
declare q text := (select v from r2023_ctx where k = 'adv_quote'); n_with int; n_without int;
begin
  n_with := (public.nav_badges('{}')->>'payments')::int;
  update public.quotes set payment_status = 'none' where id = q;
  n_without := (public.nav_badges('{}')->>'payments')::int;
  update public.quotes set payment_status = 'received' where id = q;
  if n_with <> n_without then
    raise exception 'FAIL B: the advance counts in the Payments badge (% with it, % without)', n_with, n_without; end if;
  update public.quotes set payment_status = 'none' where id = 'Q-R2023-PAID';
  if (public.nav_badges('{}')->>'payments')::int <> n_with - 1 then
    raise exception 'FAIL B: an ordinary paid quote is no longer counted'; end if;
  update public.quotes set payment_status = 'received' where id = 'Q-R2023-PAID';
  raise notice 'PASS B: Payments badge leaves the advance out (%), still counts a paid quote', n_with;
end $$;

-- C. Use advance in full on the next quote, ₹0 cash.
do $$
declare r jsonb; n int; adv0 bigint := (select v::bigint from r2023_ctx where k = 'adv0'); adv1 bigint; adv2 bigint; inv record;
begin
  select advances_from_customers into adv1 from public.report_balance_sheet('2026-10-31');
  if adv1 - adv0 <> 47348 then raise exception 'FAIL C: BS advances after booking % → % (want +47348)', adv0, adv1; end if;
  r := public.record_desk_payment('Q-R2023-NEXT', 0, 'other', 'ADV-USE-2023', null,
         'cccccccc-0000-0000-0000-000000202301', 47348);
  if (r->>'is_fully_paid')::boolean is not true then raise exception 'FAIL C: next quote not paid: %', r; end if;
  if (select credit_applied from public.payments where id = (r->>'payment_id')::uuid) is distinct from 47348 then
    raise exception 'FAIL C: credit_applied (want 47348)'; end if;
  select coalesce(sum(amount), 0) into n from public.customer_credits
   where customer_id = 'cccccccc-0000-0000-0000-000000202301' and status = 'open';
  if n <> 0 then raise exception 'FAIL C: advance left % (want 0)', n; end if;
  select * into inv from public.generate_invoice('Q-R2023-NEXT');
  if inv.invoice_id is null or inv.net_payable <> 0 then raise exception 'FAIL C: invoice % net %', inv.invoice_id, inv.net_payable; end if;
  select advances_from_customers into adv2 from public.report_balance_sheet('2026-10-31');
  if adv2 <> adv0 then raise exception 'FAIL C: BS advances % after use (want back to %)', adv2, adv0; end if;
  raise notice 'PASS C: Use advance ₹47,348 paid Q-R2023-NEXT with ₹0 cash, invoice % paid, advance ₹0, BS advances back to %', inv.invoice_id, adv0;
end $$;

-- D. Partial: a ₹10,000 advance, ₹4,000 used on a ₹5,900 bill (₹1,900 cash) — ₹6,000 stays open.
do $$
declare r jsonb; n int;
begin
  perform public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000202302', 'cccccccc-0000-0000-0000-000000202301');
  r := public.record_desk_payment('Q-R2023-PART', 1900, 'cash', 'CASH-2023', null,
         'cccccccc-0000-0000-0000-000000202301', 4000);
  if (r->>'is_fully_paid')::boolean is not true then raise exception 'FAIL D: not paid: %', r; end if;
  select coalesce(sum(amount), 0) into n from public.customer_credits
   where customer_id = 'cccccccc-0000-0000-0000-000000202301' and status = 'open';
  if n <> 6000 then raise exception 'FAIL D: open advance % (want 6000)', n; end if;
  raise notice 'PASS D: partial use ₹4,000 + ₹1,900 cash; ₹6,000 advance still open';
end $$;

rollback;
