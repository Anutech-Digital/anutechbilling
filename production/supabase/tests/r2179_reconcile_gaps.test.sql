-- R-2179 (7 Nov 2026, p1 money, G-RECON) — gaps from the August reconcile run on staging.
-- Migration 20261107183000_r2179_reconcile_gaps (bank_credit_pay_item, unreconcile_bank_receipt,
-- bank_sale_undo_preview). Self-asserting, ONE transaction, rolled back. RED without the migration
-- (A: no invoice on the part-paid add-seats quote; D: undo of an "A new sale" line refused).
--
--   A. Add-seats quote ₹35,400 (2 seats) paid ₹34,000 from a bank line → ONE GST invoice of ₹35,400 on
--      the bank date, ₹34,000 paid, ₹1,400 due. A second line of ₹1,400 → the invoice is paid, no
--      second invoice.
--   B. Renewal quote ₹35,400 paid ₹35,000 from a bank line → its GST invoice on the first receipt,
--      ₹400 due.
--   C. Add-seats quote paid ₹34,692 + ₹708 TDS → TDS counts: invoice issued and paid.
--   D. "A new sale" from a bank line (yearly subscription, 2% TDS) → un-reconcile with "undo the sale":
--      receipt removed (voucher kept as cancelled), invoice credit-noted in full, quote rejected, the
--      subscription it made cancelled, the TDS row gone, the line Unmatched. The preview listed it all.
--   E. Same for a half-yearly sale (billed in parts): the subscription cancelled, no part left unbilled.
--   F. A new sale whose subscription already billed a LATER part on its own invoice → preview blocked,
--      undo refused, nothing changed.
--   G. A sales login cannot undo a sale (owner / accountant only), as before.

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

insert into auth.users (id, email) values
  ('b2179000-0000-0000-0000-0000000000a1', 'r2179-owner@example.test'),
  ('b2179000-0000-0000-0000-0000000000a2', 'r2179-sales@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b2179000-0000-0000-0000-0000000000f0', 'R2179 T', 'r2179@example.test', '07', 'R2179');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('b2179000-0000-0000-0000-0000000000a1', 'b2179000-0000-0000-0000-0000000000f0', 'r2179-owner@example.test', 'Owner', 'owner', true, now() - interval '1 day'),
  ('b2179000-0000-0000-0000-0000000000a2', 'b2179000-0000-0000-0000-0000000000f0', 'r2179-sales@example.test', 'Sales', 'sales', true, now() - interval '1 day');
update public.tenants set books_start_date = '2025-04-01' where id = 'b2179000-0000-0000-0000-0000000000f0';

insert into public.customers (id, tenant_id, name, gstin, state_code, country, domain) values
  ('b2179000-0000-0000-0000-0000000000c1', 'b2179000-0000-0000-0000-0000000000f0', 'R2179 Seats Buyer', '07AAACR2179B1Z5', '07', 'India', 'seats2179.in'),
  ('b2179000-0000-0000-0000-0000000000c2', 'b2179000-0000-0000-0000-0000000000f0', 'R2179 Sale Buyer', '07AAACR2179C1Z5', '07', 'India', 'sale2179.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2179000-0000-0000-0000-0000000000d1', 'b2179000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '2179', '2025-04-01');

-- Two running annual subscriptions of the seats buyer: one gets 2 more seats, the other renews.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  start_date, renewal_date, status, term_months, domain) values
  ('b2179000-0000-0000-0000-0000000000b1', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000c1',
   'R2179 Seats Buyer', 'Google Workspace Business Starter', 'google', 10, 2500, '2025-11-01', '2026-11-01', 'active', 12, 'seats2179.in'),
  ('b2179000-0000-0000-0000-0000000000b2', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000c1',
   'R2179 Seats Buyer', 'Google Workspace Business Standard', 'google', 10, 2500, '2025-11-01', '2026-11-01', 'active', 12, 'two.seats2179.in');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_add_seats, add_seats_subscription_id, is_one_off, created_date) values
  ('Q-R2179-ADD', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000c1', 'R2179 Seats Buyer',
   35400, 30000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Starter · 2 more seats (pro-rata)","qty":2,"rate":15000,"commitment":"annual_yearly"}]'::jsonb,
   true, 'b2179000-0000-0000-0000-0000000000b1', false, '2026-08-01'),
  ('Q-R2179-ADDTDS', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000c1', 'R2179 Seats Buyer',
   35400, 30000, 0, 18, 'accepted', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Standard · 2 more seats (pro-rata)","qty":2,"rate":15000,"commitment":"annual_yearly"}]'::jsonb,
   true, 'b2179000-0000-0000-0000-0000000000b2', false, '2026-08-01');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_renewal, extension_months,
                           renewal_subscription_id, renewal_term_date, created_date) values
  ('Q-R2179-REN', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000c1', 'R2179 Seats Buyer',
   35400, 30000, 0, 18, 'sent', 'awaiting', 'yearly',
   '[{"name":"Google Workspace Business Standard","qty":10,"rate":3000,"commitment":"annual_yearly"}]'::jsonb,
   true, 12, 'b2179000-0000-0000-0000-0000000000b2', '2026-11-01', '2026-08-01');
update public.subscriptions set renewal_quote_id = 'Q-R2179-REN' where id = 'b2179000-0000-0000-0000-0000000000b2';

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2179000-0000-0000-0000-0000000000e1', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000d1', '2026-08-12', 'NEFT SEATS 2179', 0, 34000, 'R2179UTRA1', 'manual'),
  ('b2179000-0000-0000-0000-0000000000e2', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000d1', '2026-08-20', 'NEFT SEATS 2179 BAL', 0, 1400, 'R2179UTRA2', 'manual'),
  ('b2179000-0000-0000-0000-0000000000e3', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000d1', '2026-08-13', 'NEFT RENEWAL 2179', 0, 35000, 'R2179UTRB', 'manual'),
  ('b2179000-0000-0000-0000-0000000000e4', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000d1', '2026-08-14', 'NEFT SEATS TDS 2179', 0, 34692, 'R2179UTRC', 'manual'),
  ('b2179000-0000-0000-0000-0000000000e5', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000d1', '2026-08-15', 'NEFT NEW SALE 2179', 0, 34692, 'R2179UTRD', 'manual'),
  ('b2179000-0000-0000-0000-0000000000e6', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000d1', '2026-06-19', 'NEFT HALF 2179', 0, 92925, 'R2179UTRE', 'manual'),
  ('b2179000-0000-0000-0000-0000000000e7', 'b2179000-0000-0000-0000-0000000000f0', 'b2179000-0000-0000-0000-0000000000d1', '2026-08-16', 'NEFT BILLED LATER 2179', 0, 11800, 'R2179UTRF', 'manual');

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

set local role authenticated;
select pg_temp.as_user('b2179000-0000-0000-0000-0000000000a1');

-- ── A. part-paid add-seats quote → invoice on the first receipt; balance paid later, no second invoice ──
do $$
declare r jsonb; q record; i record; n int;
begin
  r := public.reconcile_bank_credit_to_item('b2179000-0000-0000-0000-0000000000e1', 'Q-R2179-ADD', null, 0, null, null, null, null, null);
  select * into q from public.quotes where id = 'Q-R2179-ADD';
  if q.invoice_id is null then
    raise exception 'FAIL A: a part-paid add-seats quote paid from a bank line has no GST invoice (%)', r;
  end if;
  select * into i from public.invoices where id = q.invoice_id;
  if i.amount <> 35400 or i.status::text not in ('pending', 'overdue') or i.net_payable is distinct from 1400 then
    raise exception 'FAIL A: invoice % amount % status % due % (want 35,400 / pending / ₹1,400 due)', i.id, i.amount, i.status, i.net_payable;
  end if;
  if i.invoice_date is distinct from '2026-08-12'::date then
    raise exception 'FAIL A: invoice date % (want the bank date 12 Aug 2026)', i.invoice_date;
  end if;

  -- the balance from a second bank line, paid on the invoice
  r := public.reconcile_bank_credit_to_item('b2179000-0000-0000-0000-0000000000e2', null, q.invoice_id, 0, null, null, null, null, null);
  select * into i from public.invoices where id = q.invoice_id;
  if i.status::text <> 'paid' then raise exception 'FAIL A: after the ₹1,400 balance invoice % is % (want paid)', i.id, i.status; end if;
  select count(*) into n from public.invoices where quote_id = 'Q-R2179-ADD' and status::text <> 'void';
  if n <> 1 then raise exception 'FAIL A: % invoices on the add-seats quote (want 1)', n; end if;
  raise notice 'A PASS: add-seats part-paid → % on the bank date, ₹1,400 due; balance → paid, one invoice', i.id;
end $$;

-- ── B. part-paid renewal quote → invoice on the first receipt ─────────────────────────────────
do $$
declare r jsonb; q record; i record;
begin
  r := public.reconcile_bank_credit_to_item('b2179000-0000-0000-0000-0000000000e3', 'Q-R2179-REN', null, 0, null, null, null, null, null);
  select * into q from public.quotes where id = 'Q-R2179-REN';
  if q.invoice_id is null then
    raise exception 'FAIL B: a part-paid renewal quote paid from a bank line has no GST invoice (%)', r;
  end if;
  select * into i from public.invoices where id = q.invoice_id;
  if i.amount <> 35400 or i.status::text not in ('pending', 'overdue') or i.net_payable is distinct from 400 then
    raise exception 'FAIL B: invoice % amount % status % due % (want 35,400 / pending / ₹400 due)', i.id, i.amount, i.status, i.net_payable;
  end if;
  raise notice 'B PASS: renewal part-paid → % with ₹400 due', i.id;
end $$;

-- ── C. add-seats quote: bank + TDS = the whole → invoice issued and paid ─────────────────────
do $$
declare r jsonb; q record; i record;
begin
  r := public.reconcile_bank_credit_to_item('b2179000-0000-0000-0000-0000000000e4', 'Q-R2179-ADDTDS', null, 708, 2, '194J', null, null, null);
  select * into q from public.quotes where id = 'Q-R2179-ADDTDS';
  if q.invoice_id is null then raise exception 'FAIL C: no invoice (%)', r; end if;
  select * into i from public.invoices where id = q.invoice_id;
  if i.status::text <> 'paid' then raise exception 'FAIL C: invoice % is % (want paid — TDS counts)', i.id, i.status; end if;
  raise notice 'C PASS: add-seats bank + TDS → % paid', i.id;
end $$;

-- ── D. "A new sale" from a bank line, then Un-reconcile → undo the sale ─────────────────────
do $$
declare r jsonb; p jsonb; v_q text; v_inv text; v_pay uuid; v_voucher text; v_sub uuid; t record; s record; n int;
begin
  r := public.reconcile_bank_credit_new_sale('b2179000-0000-0000-0000-0000000000e5', 'b2179000-0000-0000-0000-0000000000c2',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":10,"rate":3000,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-08-15', null, 708, 2, '194J', 'yearly');
  v_q := r->>'quote_id';
  select invoice_id into v_inv from public.quotes where id = v_q;
  select id, receipt_voucher_no into v_pay, v_voucher from public.payments where quote_id = v_q and status = 'received' limit 1;
  select id into v_sub from public.subscriptions where quote_id = v_q limit 1;
  if v_inv is null or v_pay is null or v_sub is null then
    raise exception 'FAIL D setup: invoice % payment % subscription % (%)', v_inv, v_pay, v_sub, r;
  end if;
  if not exists (select 1 from public.tds_receivable where payment_id = v_pay) then
    raise exception 'FAIL D setup: no TDS row on the sale''s receipt';
  end if;

  -- the preview the dialog shows
  p := public.bank_sale_undo_preview('b2179000-0000-0000-0000-0000000000e5');
  if coalesce((p->>'is_new_sale')::boolean, false) is not true or coalesce((p->>'blocked')::boolean, true) then
    raise exception 'FAIL D: preview %', p;
  end if;
  if p->>'quote_id' is distinct from v_q or p->>'invoice_id' is distinct from v_inv
     or jsonb_array_length(coalesce(p->'subscriptions', '[]'::jsonb)) <> 1
     or (p->>'tds_amount')::int is distinct from 708 then
    raise exception 'FAIL D: preview does not list the quote / invoice / subscription / TDS: %', p;
  end if;

  r := public.unreconcile_bank_receipt('b2179000-0000-0000-0000-0000000000e5', true);
  select * into t from public.bank_transactions where id = 'b2179000-0000-0000-0000-0000000000e5';
  if t.matched_to_id is not null or t.matched_to_type is not null then raise exception 'FAIL D: the line is still matched (%)', t.matched_to_id; end if;
  if exists (select 1 from public.payments where id = v_pay) then raise exception 'FAIL D: the receipt is still there'; end if;
  if not exists (select 1 from public.cancelled_vouchers where payment_id = v_pay and doc_no = v_voucher) then
    raise exception 'FAIL D: receipt voucher % not kept as cancelled', v_voucher;
  end if;
  if r->>'invoice_credited' is distinct from v_inv
     or not exists (select 1 from public.credit_notes where invoice_id = v_inv) then
    raise exception 'FAIL D: invoice % not credit-noted (%)', v_inv, r;
  end if;
  if (select status::text from public.quotes where id = v_q) <> 'rejected' then raise exception 'FAIL D: quote not cancelled'; end if;
  select * into s from public.subscriptions where id = v_sub;
  if s.status::text <> 'cancelled' then raise exception 'FAIL D: subscription % is % (want cancelled)', v_sub, s.status; end if;
  select count(*) into n from public.subscription_billings where subscription_id = v_sub and invoice_id is null;
  if n <> 0 then raise exception 'FAIL D: % unbilled parts left on the subscription', n; end if;
  if exists (select 1 from public.tds_receivable where payment_id = v_pay) then raise exception 'FAIL D: TDS row left'; end if;
  if coalesce((r->>'subscriptions_cancelled')::int, 0) <> 1 then raise exception 'FAIL D: result %', r; end if;
  raise notice 'D PASS: new sale undone — receipt, TDS, invoice (credit note), quote, subscription; line Unmatched';
end $$;

-- ── E. a half-yearly new sale (billed in parts), undone ───────────────────────────────────
do $$
declare r jsonb; v_q text; v_sub uuid; n int;
begin
  r := public.reconcile_bank_credit_new_sale('b2179000-0000-0000-0000-0000000000e6', 'b2179000-0000-0000-0000-0000000000c2',
         '[{"item_id":null,"name":"Microsoft 365 Basic","qty":50,"rate":3150,"cost":0,"commitment":"annual_yearly","domain":"half.sale2179.in"}]'::jsonb,
         true, '2026-06-19', null, 0, null, null, 'half_yearly');
  v_q := r->>'quote_id';
  select id into v_sub from public.subscriptions where quote_id = v_q limit 1;
  if v_sub is null then raise exception 'FAIL E setup: no subscription (%)', r; end if;
  r := public.unreconcile_bank_receipt('b2179000-0000-0000-0000-0000000000e6', true);
  if (select status::text from public.subscriptions where id = v_sub) <> 'cancelled' then
    raise exception 'FAIL E: the half-yearly subscription was not cancelled (%)', r;
  end if;
  select count(*) into n from public.subscription_billings where subscription_id = v_sub and invoice_id is null;
  if n <> 0 then raise exception 'FAIL E: % unbilled parts left', n; end if;
  if exists (select 1 from public.payments where quote_id = v_q) then raise exception 'FAIL E: receipt left'; end if;
  raise notice 'E PASS: half-yearly sale undone';
end $$;

-- ── F. a later part already billed on its own invoice → blocked, nothing changes ──────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_new_sale('b2179000-0000-0000-0000-0000000000e7', 'b2179000-0000-0000-0000-0000000000c2',
         '[{"item_id":null,"name":"Google Workspace Business Plus","qty":1,"rate":10000,"cost":0,"commitment":"annual_yearly","domain":"later.sale2179.in"}]'::jsonb,
         true, '2026-08-16', null, 0, null, null, 'yearly');
  if r->>'quote_id' is null then raise exception 'FAIL F setup: %', r; end if;
end $$;
-- a later invoice billed for this subscription (stand-in: another invoice of the company), not the sale's own
reset role;
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate, invoice_id)
select gen_random_uuid(), s.tenant_id, s.id, '2027-08-16', 1, '2027-08-16', '2027-08-16', '2028-08-15', 10000, 18,
       (select invoice_id from public.quotes where id = 'Q-R2179-ADD')
  from public.subscriptions s
 where s.tenant_id = 'b2179000-0000-0000-0000-0000000000f0' and s.domain = 'later.sale2179.in';
set local role authenticated;
select pg_temp.as_user('b2179000-0000-0000-0000-0000000000a1');
do $$
declare p jsonb; v_q text; v_sub uuid; v_pay uuid; ok boolean := false;
begin
  select s.id, s.quote_id into v_sub, v_q from public.subscriptions s
   where s.tenant_id = 'b2179000-0000-0000-0000-0000000000f0' and s.domain = 'later.sale2179.in';
  select id into v_pay from public.payments where quote_id = v_q limit 1;
  p := public.bank_sale_undo_preview('b2179000-0000-0000-0000-0000000000e7');
  if not coalesce((p->>'blocked')::boolean, false) or p->>'block_message' is null then
    raise exception 'FAIL F: preview not blocked: %', p;
  end if;
  begin
    perform public.unreconcile_bank_receipt('b2179000-0000-0000-0000-0000000000e7', true);
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL F: undo ran over a later billed part'; end if;
  if not exists (select 1 from public.payments where id = v_pay)
     or (select status::text from public.subscriptions where id = v_sub) = 'cancelled' then
    raise exception 'FAIL F: something changed on a refused undo';
  end if;
  raise notice 'F PASS: later billed part → blocked, nothing changed';
end $$;

-- ── G. a sales login cannot undo a sale ─────────────────────────────────────────────────────
select pg_temp.as_user('b2179000-0000-0000-0000-0000000000a2');
do $$
declare ok boolean := false;
begin
  begin
    perform public.unreconcile_bank_receipt('b2179000-0000-0000-0000-0000000000e7', true);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FAIL G: a sales login undid a sale'; end if;
  raise notice 'G PASS: sales login refused';
end $$;

select 'R-2179 reconcile gaps: ALL PASS' as result;

rollback;
