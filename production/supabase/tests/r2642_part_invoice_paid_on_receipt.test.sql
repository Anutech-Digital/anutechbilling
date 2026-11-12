-- R-2642 (9 Nov 2026, p2 paisa, R-2631 follow-up): a part / cron invoice (raise_subscription_billing) that is
-- settled when it is raised is PAID on the day the money came in (R-015's rule, like generate_invoice since
-- R-2631) - not on the invoice date that R-2631 moved to the first open day. Migration
-- 20261109220936_r2642_part_invoice_paid_on_receipt. Self-asserting, ONE transaction, rolled back. Local DB only.
-- RED without the migration (A: paid_date 2026-10-01, the shifted invoice date).
--
-- Rule: paid_date = the day the quote's receipts (sale quote + every part request of its subscriptions), spent
-- oldest first, covered this part - never before the part's own pre-shift day (invoice_receipt_day of its bill
-- date): money paid ahead is used on that day, so a part paid ahead keeps paid_date = its invoice date as before.
--
-- Company T1: GST filed up to Sep 2026. Quarterly parts, Rs 1,000 + 18% = Rs 1,180.
--   A. Part bill date 1 Sep, sale quote paid 5 Sep, billed by the cron's call (no login) -> invoice 1 Oct, paid 5 Sep.
--   B. Part 2 bill date 1 Sep, its part request (proforma) paid 5 Sep -> invoice 1 Oct, paid 5 Sep.
--   C. Part bill date 1 Sep paid late on 5 Oct (open month) -> invoice 1 Oct, paid 5 Oct (the real day).
--   D. Sale paid ahead on 10 Aug, part bill date 1 Sep -> invoice 1 Oct, paid 1 Sep (never before the part's day).
--   E. Open month: part bill date 1 Oct, sale paid 5 Sep -> invoice 1 Oct, paid 1 Oct (unchanged).
--   E2. Open month, paid late: part bill date 1 Oct, sale paid 5 Nov -> invoice 1 Oct, paid 5 Nov (R-1564's rule).
--   J. Two receipts on the sale quote (5 Sep for this part, 25 Sep for the next) -> paid 5 Sep, not 25 Sep.
--   K. Part 2's request paid Rs 2,360 on 7 Sep (its own part + this one) pays this part too -> paid 7 Sep.
--   F. Short pool (Rs 500 of Rs 1,180) -> pending, paid_date null (unchanged).
--   G. Credit-note re-bill (R-2095) of a cancelled 1 Sep part, sale paid 6 Sep -> new invoice 1 Oct, paid 6 Sep.
--   H. Cron retry on a billed part -> already invoiced, nothing rewritten.
--   I. An invoice raised before the migration keeps its paid_date (no data repair).

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
  ('b2642000-0000-0000-0000-0000000000f1', 'R2642 Filed Co', 'r2642a@example.test', '07', 'R42A');
update public.tenants set books_start_date = '2025-04-01', gst_filed_through = '2026-09-30'
 where id = 'b2642000-0000-0000-0000-0000000000f1';

-- An invoice raised before (paid, paid_date = its invoice date): must never change.
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('b2642000-0000-0000-0000-0000000000c0', 'b2642000-0000-0000-0000-0000000000f1', 'R2642 Old', '07', 'India');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status, invoice_date, due_date,
                             paid_date, taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items) values
  ('INV-R2642-OLD', 'b2642000-0000-0000-0000-0000000000f1', 'b2642000-0000-0000-0000-0000000000c0', 'R2642 Old',
   1180, 1180, 'paid', '2026-10-01', '2026-10-31', '2026-10-01', 1000, 180, 18, false, 1180, 'tax_invoice',
   '[{"name":"Old part","qty":1,"rate":1000}]'::jsonb);

/* One sale (customer + quarterly sale quote + subscription + one part). p_index 1 = the sale's first part;
   p_sale_paid = the IST day the sale quote was paid (null = unpaid), p_sale_amt = how much. */
create function pg_temp.mk(p_tag text, p_n int, p_bill date, p_index int, p_sale_paid date, p_sale_amt int,
                           p_taxable int default 1000) returns uuid language plpgsql as $f$
declare
  v_c uuid := ('b2642000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
  v_s uuid := ('b2642000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
  v_b uuid := ('b2642000-0000-0000-0000-0000000003' || lpad(p_n::text, 2, '0'))::uuid;
  v_term date := (p_bill - ((p_index - 1) * interval '3 months'))::date;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'b2642000-0000-0000-0000-0000000000f1', 'R2642 ' || p_tag, '07', 'India');
  insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
  values ('Q-R2642-' || p_tag, 'b2642000-0000-0000-0000-0000000000f1', 'R2642 ' || p_tag, v_c, 18, 4720, 4000, 'quarterly', 'accepted',
          '[{"name":"Google Workspace Business Starter","qty":1,"rate":4000,"commitment":"annual_quarterly"}]'::jsonb);
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id, start_date, status)
  values (v_s, 'b2642000-0000-0000-0000-0000000000f1', v_c, 'R2642 ' || p_tag, 'Google Workspace Business Starter',
          'google'::vendor, 1, 333, 'quarterly'::billing_cycle, 'Q-R2642-' || p_tag, v_term, 'active');
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
  values (v_b, 'b2642000-0000-0000-0000-0000000000f1', v_s, v_term, p_index, p_bill, p_bill,
          (p_bill + interval '3 months' - interval '1 day')::date, p_taxable, 18);
  if p_sale_paid is not null then
    insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
    values ('b2642000-0000-0000-0000-0000000000f1', 'Q-R2642-' || p_tag, p_sale_amt, 'bank_transfer', 'R2642-' || p_tag,
            'received', (p_sale_paid + time '11:00') at time zone 'Asia/Kolkata');
  end if;
  return v_b;
end $f$;

create function pg_temp.inv(p_b uuid) returns record language sql as $f$
  select i.invoice_date, i.paid_date, i.status::text from public.invoices i
   where i.id = (select b.invoice_id from public.subscription_billings b where b.id = p_b);
$f$;

-- ── A. Sale paid 5 Sep, part bill date 1 Sep (filed) → invoice 1 Oct, paid 5 Sep ───────────────────
do $$
declare v_b uuid; r jsonb; v record;
begin
  v_b := pg_temp.mk('A', 1, '2026-09-01', 1, '2026-09-05', 1180);
  r := public.bill_subscription_instalment(v_b, false);
  select i.invoice_date, i.paid_date, i.status::text as st into v from public.invoices i where i.id = r->>'invoice_id';
  if v.invoice_date is distinct from '2026-10-01' then raise exception 'FAIL A: invoice dated % (want 2026-10-01): %', v.invoice_date, r; end if;
  if v.st <> 'paid' or v.paid_date is distinct from '2026-09-05' then
    raise exception 'FAIL A: status % paid_date % (want paid on the receipt day 2026-09-05, not the shifted 1 Oct)', v.st, v.paid_date; end if;
  raise notice 'PASS A: part invoice % dated 1 Oct, paid 5 Sep (the receipt day)', r->>'invoice_id';
end $$;

-- ── B. Part 2's own payment request (proforma) paid 5 Sep → invoice 1 Oct, paid 5 Sep ─────────────
do $$
declare v_b uuid; v record;
begin
  v_b := pg_temp.mk('B', 2, '2026-09-01', 2, null, 0);
  insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status,
                             line_items, subscription_billing_id)
  values ('Q-R2642-B-REQ', 'b2642000-0000-0000-0000-0000000000f1', 'R2642 B', 'b2642000-0000-0000-0000-000000000102', 18, 1180, 1000,
          'quarterly', 'accepted', '[{"name":"Advance payment for Q2","qty":1,"rate":1000}]'::jsonb, v_b);
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2642000-0000-0000-0000-0000000000f1', 'Q-R2642-B-REQ', 1180, 'bank_transfer', 'R2642-B-REQ', 'received',
          timestamptz '2026-09-05 11:00:00+05:30');
  perform public.bill_subscription_instalment(v_b, false);   -- already invoiced by the payment trigger is fine too
  select * into v from pg_temp.inv(v_b) as x(invoice_date date, paid_date date, st text);
  if v.invoice_date is distinct from '2026-10-01' or v.st <> 'paid' or v.paid_date is distinct from '2026-09-05' then
    raise exception 'FAIL B: part request paid 5 Sep → invoice % status % paid_date % (want 2026-10-01 / paid / 2026-09-05)',
      v.invoice_date, v.st, v.paid_date; end if;
  raise notice 'PASS B: paid part request → invoice 1 Oct, paid 5 Sep';
end $$;

-- ── C. Paid late on 5 Oct (open month) for a 1 Sep part → invoice 1 Oct, paid 1 Oct ───────────────
do $$
declare v_b uuid; v record;
begin
  v_b := pg_temp.mk('C', 3, '2026-09-01', 1, '2026-10-05', 1180);
  perform public.bill_subscription_instalment(v_b, false);
  select * into v from pg_temp.inv(v_b) as x(invoice_date date, paid_date date, st text);
  if v.invoice_date is distinct from '2026-10-01' or v.paid_date is distinct from '2026-10-05' then
    raise exception 'FAIL C: invoice % paid_date % (want 2026-10-01 / 2026-10-05 - the day the money came)', v.invoice_date, v.paid_date; end if;
  raise notice 'PASS C: late money → invoice 1 Oct, paid 5 Oct';
end $$;

-- ── D. Sale paid ahead on 10 Aug, part bill date 1 Sep → invoice 1 Oct, paid 1 Sep ────────────────
do $$
declare v_b uuid; v record;
begin
  v_b := pg_temp.mk('D', 4, '2026-09-01', 1, '2026-08-10', 1180);
  perform public.bill_subscription_instalment(v_b, false);
  select * into v from pg_temp.inv(v_b) as x(invoice_date date, paid_date date, st text);
  if v.invoice_date is distinct from '2026-10-01' or v.paid_date is distinct from '2026-09-01' then
    raise exception 'FAIL D: invoice % paid_date % (want 2026-10-01 / 2026-09-01 - never before the part''s own day)', v.invoice_date, v.paid_date; end if;
  raise notice 'PASS D: money ahead → paid on the part''s bill day 1 Sep';
end $$;

-- ── E. Open month: part bill date 1 Oct, sale paid 5 Sep → invoice 1 Oct, paid 1 Oct (unchanged) ─
do $$
declare v_b uuid; v record;
begin
  v_b := pg_temp.mk('E', 5, '2026-10-01', 1, '2026-09-05', 1180);
  perform public.bill_subscription_instalment(v_b, false);
  select * into v from pg_temp.inv(v_b) as x(invoice_date date, paid_date date, st text);
  if v.invoice_date is distinct from '2026-10-01' or v.paid_date is distinct from '2026-10-01' then
    raise exception 'FAIL E: open-month part invoice % paid_date % (want 2026-10-01 / 2026-10-01, as before)', v.invoice_date, v.paid_date; end if;
  raise notice 'PASS E: open month unchanged (paid on the invoice date)';
end $$;

-- ── E2. Open month, paid late on 5 Nov → invoice 1 Oct, paid 5 Nov ───────────────────────────────
do $$
declare v_b uuid; v record;
begin
  v_b := pg_temp.mk('E2', 8, '2026-10-01', 1, '2026-11-05', 1180);
  perform public.bill_subscription_instalment(v_b, false);
  select * into v from pg_temp.inv(v_b) as x(invoice_date date, paid_date date, st text);
  if v.invoice_date is distinct from '2026-10-01' or v.paid_date is distinct from '2026-11-05' then
    raise exception 'FAIL E2: invoice % paid_date % (want 2026-10-01 / 2026-11-05)', v.invoice_date, v.paid_date; end if;
  raise notice 'PASS E2: open month, late money → paid 5 Nov';
end $$;

-- ── J. Two receipts on the sale quote: 5 Sep pays this part, 25 Sep is the next part's → paid 5 Sep ─
do $$
declare v_b uuid; v record;
begin
  v_b := pg_temp.mk('J', 9, '2026-09-01', 1, '2026-09-05', 1180);
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2642000-0000-0000-0000-0000000000f1', 'Q-R2642-J', 1180, 'bank_transfer', 'R2642-J-2', 'received',
          timestamptz '2026-09-25 11:00:00+05:30');
  perform public.bill_subscription_instalment(v_b, false);
  select * into v from pg_temp.inv(v_b) as x(invoice_date date, paid_date date, st text);
  if v.invoice_date is distinct from '2026-10-01' or v.paid_date is distinct from '2026-09-05' then
    raise exception 'FAIL J: invoice % paid_date % (want 2026-10-01 / 2026-09-05 - the oldest money pays first)', v.invoice_date, v.paid_date; end if;
  raise notice 'PASS J: two receipts → paid on the first (5 Sep)';
end $$;

-- ── K. Part 2's request asked (and got) Rs 2,360 on 7 Sep - its own Rs 1,180 + this part's → this part paid 7 Sep ─────────────
do $$
declare v_b uuid; v record; r jsonb;
begin
  v_b := pg_temp.mk('K', 10, '2026-09-01', 1, null, 0);
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
  values ('b2642000-0000-0000-0000-000000000399', 'b2642000-0000-0000-0000-0000000000f1', 'b2642000-0000-0000-0000-000000000210',
          '2026-09-01', 2, '2026-12-01', '2026-12-01', '2027-02-28', 1000, 18);
  insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status,
                             line_items, subscription_billing_id)
  values ('Q-R2642-K-REQ2', 'b2642000-0000-0000-0000-0000000000f1', 'R2642 K', 'b2642000-0000-0000-0000-000000000110', 18, 2360, 2000,
          'quarterly', 'accepted', '[{"name":"Advance payment for Q2","qty":1,"rate":1000}]'::jsonb, 'b2642000-0000-0000-0000-000000000399');
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2642000-0000-0000-0000-0000000000f1', 'Q-R2642-K-REQ2', 2360, 'bank_transfer', 'R2642-K-REQ2', 'received',
          timestamptz '2026-09-07 11:00:00+05:30');
  r := public.bill_subscription_instalment(v_b, false);
  select * into v from pg_temp.inv(v_b) as x(invoice_date date, paid_date date, st text);
  if v.invoice_date is distinct from '2026-10-01' or v.st is distinct from 'paid' or v.paid_date is distinct from '2026-09-07' then
    raise exception 'FAIL K: invoice % status % paid_date % (want 2026-10-01 / paid / 2026-09-07): % pool %', v.invoice_date, v.st, v.paid_date, r, public.instalment_credit('b2642000-0000-0000-0000-000000000210'); end if;
  raise notice 'PASS K: money from another part''s request → paid 7 Sep';
end $$;

-- ── F. Short pool → pending, no paid_date ──────────────────────────────────────────────────────
do $$
declare v_b uuid; v record;
begin
  v_b := pg_temp.mk('F', 6, '2026-09-01', 1, '2026-09-05', 500);
  update public.quotes set invoice_on_receipt = true where id = 'Q-R2642-F';   -- R-2095: first receipt invoices the part
  perform public.bill_subscription_instalment(v_b, false);
  select * into v from pg_temp.inv(v_b) as x(invoice_date date, paid_date date, st text);
  if v.st is distinct from 'pending' or v.paid_date is not null then
    raise exception 'FAIL F: short pool → status % paid_date % (want pending / null)', v.st, v.paid_date; end if;
  raise notice 'PASS F: short pool → pending, no paid date';
end $$;

-- ── G. Credit-note re-bill (R-2095): the cancelled part is billed again from the note credit → paid on the
--      sale receipt day 6 Sep, not the shifted 1 Oct ─────────────────────────────────────────────────────
do $$
declare v_b uuid; v record; r jsonb; v_old text;
begin
  v_b := pg_temp.mk('G', 7, '2026-09-01', 1, '2026-09-06', 1180);
  r := public.bill_subscription_instalment(v_b, false);
  v_old := r->>'invoice_id';
  perform public.issue_credit_note(v_old, 1180, 'other', 'Re-issue part', null);
  r := public.bill_subscription_instalment(v_b, false);
  if r->>'action' <> 'invoice' or r->>'invoice_id' = v_old then raise exception 'FAIL G: re-bill gave %', r; end if;
  select i.invoice_date, i.paid_date, i.status::text as st into v from public.invoices i where i.id = r->>'invoice_id';
  if v.invoice_date is distinct from '2026-10-01' or v.st <> 'paid' or v.paid_date is distinct from '2026-09-06' then
    raise exception 'FAIL G: re-billed part → invoice % status % paid_date % (want 2026-10-01 / paid / 2026-09-06)', v.invoice_date, v.st, v.paid_date; end if;
  raise notice 'PASS G: credit-note re-bill paid on the sale receipt day 6 Sep';
end $$;

-- ── H. Cron retry → already invoiced, nothing rewritten ──────────────────────────────────────────
do $$
declare r jsonb; v_before record; v_after record;
begin
  select i.* into v_before from public.invoices i where i.customer_name = 'R2642 A';
  r := public.bill_subscription_instalment('b2642000-0000-0000-0000-000000000301', false);
  if r->>'action' <> 'already_invoiced' then raise exception 'FAIL H: retry did %', r; end if;
  perform public.raise_subscription_billing('b2642000-0000-0000-0000-000000000301');
  select i.* into v_after from public.invoices i where i.customer_name = 'R2642 A';
  if (select count(*) from public.invoices where customer_name = 'R2642 A') <> 1
     or v_after.paid_date is distinct from v_before.paid_date or v_after.invoice_date is distinct from v_before.invoice_date then
    raise exception 'FAIL H: a retry changed the invoice or raised a second one'; end if;
  raise notice 'PASS H: retry left the invoice alone';
end $$;

-- ── I. An invoice raised before keeps its paid_date ─────────────────────────────────────────────
do $$
begin
  if (select paid_date from public.invoices where id = 'INV-R2642-OLD') is distinct from '2026-10-01' then
    raise exception 'FAIL I: an existing invoice''s paid_date changed'; end if;
  raise notice 'PASS I: existing invoice untouched';
end $$;

select 'R-2642 part / cron invoice paid on the receipt day: ALL PASS' as result;

rollback;
