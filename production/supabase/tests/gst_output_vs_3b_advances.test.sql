-- Regression test: R-521 (9 Oct 2026, AI flow test #1 on localhost ANUTECH, October 2026).
-- No migration. Self-asserting; rolled back.
--
-- /accounting/gst showed Output GST ₹1,11,073 (= the GSTR-1 invoice rows) but the GSTR-3B
-- worksheet / head-wise table showed ₹1,12,930 — ₹1,857 tax / ₹10,320 taxable with no name
-- on the page. Cause: three receipt vouchers (RV-…-0003 ₹708, RV-…-0006 ₹7,646,
-- RV-…-0007 ₹3,823 = ₹12,177 gross) were received in October on quotes with NO invoice yet.
-- That is tax on advances: GSTR-1 Table 11A, and it IS part of GSTR-3B 3.1(a). The number
-- was right; the page just never said where it came from. The page now shows the bridge
-- (src/app/(app)/accounting/gst/cash-to-pay.ts outputTaxBridge). This test pins the rules
-- the bridge relies on, with the same data shape as the ANUTECH case:
--
--   1. Output GST card = invoices dated in the IST month (status pending/paid/overdue).
--   2. Advances for 11A = payments whose IST receive date is in the month, and whose quote
--      has no invoice yet OR an invoice dated after the month. Advance taxable is
--      round(gross × 100 / (100 + rate)) — the receipt voucher's own formula.
--   3. An advance whose invoice is dated in the SAME month is neither 11A nor 11B
--      (the invoice already carries the tax).
--   4. IST boundaries: 30 Sep 19:00 UTC is 1 Oct IST (counts in October);
--      31 Oct 19:00 UTC is 1 Nov IST (does not). A UTC-date filter gets both wrong.
--   5. 3B 3.1(a) tax = invoices + 11A − 11B, and equals card + the named advances line.
--   6. Issued invoice amounts are not touched by any of this.
--
-- Fixture owns its data: its own tenant, customer, quotes, invoices, payments. Literal ids.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('52100000-0000-4000-8000-000000000001', 'R521 TEST', 'r521@example.in', '07', 'R521');

insert into public.customers (id, tenant_id, name, contact_email, gstin, state_code, state, country) values
  ('52100000-0000-4000-8000-0000000000c1', '52100000-0000-4000-8000-000000000001', 'Delhi Buyer', 'a@db.in', null, '07', 'Delhi', 'India');

-- Q1: invoiced in October (its advance is adjusted in the same month)
-- Q2: accepted, no invoice yet (open advance)        Q3: invoiced in November (open in October)
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R521-1', '52100000-0000-4000-8000-000000000001', '52100000-0000-4000-8000-0000000000c1', 'Delhi Buyer', 11800, 10000, 18, 'accepted', 'awaiting', '[{"name":"Thing","qty":1,"rate":10000}]'::jsonb),
  ('Q-R521-2', '52100000-0000-4000-8000-000000000001', '52100000-0000-4000-8000-0000000000c1', 'Delhi Buyer',  1298,  1100, 18, 'accepted', 'awaiting', '[{"name":"Thing","qty":1,"rate":1100}]'::jsonb),
  ('Q-R521-3', '52100000-0000-4000-8000-000000000001', '52100000-0000-4000-8000-0000000000c1', 'Delhi Buyer',  7646,  6480, 18, 'accepted', 'awaiting', '[{"name":"Thing","qty":1,"rate":6480}]'::jsonb);

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, taxable_value, tax_amount, tax_rate, inter_state, status, invoice_date) values
  ('INV-R521-1', '52100000-0000-4000-8000-000000000001', '52100000-0000-4000-8000-0000000000c1', 'Delhi Buyer', 11800, 10000, 1800, 18, false, 'paid',    '2026-10-05'),
  ('INV-R521-3', '52100000-0000-4000-8000-000000000001', '52100000-0000-4000-8000-0000000000c1', 'Delhi Buyer',  7646,  6480, 1166, 18, false, 'pending', '2026-11-03');
update public.quotes set invoice_id = 'INV-R521-1' where id = 'Q-R521-1';
update public.quotes set invoice_id = 'INV-R521-3' where id = 'Q-R521-3';

insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at) values
  -- adjusted on INV-R521-1 (dated 5 Oct): same month -> not 11A, not 11B
  ('52100000-0000-4000-8000-0000000000a1', '52100000-0000-4000-8000-000000000001', 'Q-R521-1', '52100000-0000-4000-8000-0000000000c1', 11800, 'bank_transfer', 'received', '2026-10-02T06:00:00Z'),
  -- 30 Sep 19:00 UTC = 1 Oct 00:30 IST -> October 11A
  ('52100000-0000-4000-8000-0000000000a2', '52100000-0000-4000-8000-000000000001', 'Q-R521-2', '52100000-0000-4000-8000-0000000000c1',   708, 'bank_transfer', 'received', '2026-09-30T19:00:00Z'),
  -- 31 Oct 19:00 UTC = 1 Nov 00:30 IST -> NOT October
  ('52100000-0000-4000-8000-0000000000a3', '52100000-0000-4000-8000-000000000001', 'Q-R521-2', '52100000-0000-4000-8000-0000000000c1',   590, 'bank_transfer', 'received', '2026-10-31T19:00:00Z'),
  -- received 20 Oct, invoiced 3 Nov -> October 11A (7646 at 18%: 6479.66 rounds to 6480, as the voucher prints)
  ('52100000-0000-4000-8000-0000000000a4', '52100000-0000-4000-8000-000000000001', 'Q-R521-3', '52100000-0000-4000-8000-0000000000c1',  7646, 'bank_transfer', 'received', '2026-10-20T05:00:00Z');

do $$
declare
  t constant uuid := '52100000-0000-4000-8000-000000000001';
  v_inv_taxable bigint; v_inv_tax bigint;
  v_adv_n int; v_adv_taxable bigint; v_adv_tax bigint;
  v_utc_n int;
  v_amt numeric;
begin
  -- 1. Output GST card: invoices dated in October
  select coalesce(sum(taxable_value), 0), coalesce(sum(tax_amount), 0) into v_inv_taxable, v_inv_tax
    from public.invoices
   where tenant_id = t and invoice_date between '2026-10-01' and '2026-10-31'
     and status in ('pending', 'paid', 'overdue');
  if v_inv_taxable <> 10000 or v_inv_tax <> 1800 then
    raise exception 'R-521 #1: October invoices should be taxable 10000 / tax 1800, got % / %', v_inv_taxable, v_inv_tax;
  end if;

  -- 2-4. 11A: received in the IST month, no invoice yet or invoiced after the month
  with adv as (
    select p.amount::numeric as gross, coalesce(q.tax_rate, 18)::numeric as rate
      from public.payments p
      join public.quotes q on q.id = p.quote_id
      left join public.invoices i on i.id = q.invoice_id
     where p.tenant_id = t and p.status = 'received'
       and (p.received_at at time zone 'Asia/Kolkata')::date between '2026-10-01' and '2026-10-31'
       and (i.id is null or i.invoice_date > '2026-10-31')
  )
  select count(*), coalesce(sum(round(gross * 100 / (100 + rate))), 0),
         coalesce(sum(gross - round(gross * 100 / (100 + rate))), 0)
    into v_adv_n, v_adv_taxable, v_adv_tax
    from adv;
  if v_adv_n <> 2 or v_adv_taxable <> 7080 or v_adv_tax <> 1274 then
    raise exception 'R-521 #2: October 11A should be 2 advances, taxable 7080, tax 1274 — got %, %, %', v_adv_n, v_adv_taxable, v_adv_tax;
  end if;

  -- 4. the same filter on UTC dates picks the wrong rows (misses 1 Oct IST, takes 1 Nov IST)
  select count(*) into v_utc_n
    from public.payments p
    join public.quotes q on q.id = p.quote_id
    left join public.invoices i on i.id = q.invoice_id
   where p.tenant_id = t and p.status = 'received'
     and (p.received_at at time zone 'UTC')::date between '2026-10-01' and '2026-10-31'
     and (i.id is null or i.invoice_date > '2026-10-31')
     and p.id in ('52100000-0000-4000-8000-0000000000a2', '52100000-0000-4000-8000-0000000000a3');
  if v_utc_n <> 1 then
    raise exception 'R-521 #4: fixture should show the UTC filter taking only the 1 Nov IST payment, got %', v_utc_n;
  end if;

  -- 5. 3B 3.1(a) = card + named advances line (no 11B in this fixture)
  if v_inv_tax + v_adv_tax <> 3074 or v_inv_taxable + v_adv_taxable <> 17080 then
    raise exception 'R-521 #5: 3B 3.1(a) should be taxable 17080 / tax 3074, got % / %', v_inv_taxable + v_adv_taxable, v_inv_tax + v_adv_tax;
  end if;

  -- 6. issued invoice amounts untouched
  select amount into v_amt from public.invoices where id = 'INV-R521-1';
  if v_amt <> 11800 then
    raise exception 'R-521 #6: issued invoice amount changed: %', v_amt;
  end if;

  raise notice 'R-521 OK: card 1800 + advances 11A 1274 = 3B 3.1(a) 3074; IST month boundaries hold';
end $$;

rollback;
