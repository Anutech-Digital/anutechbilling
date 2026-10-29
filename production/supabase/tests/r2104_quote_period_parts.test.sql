-- R-2104 (29 Oct 2026): what the Record payment sheet asks for a part IS the part's amount.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Found on localhost (checker-2101, cb774a574): 3 seats × ₹1,002 a year billed quarterly. The sheet
-- asked the quote's Q1 — ₹3,006 ÷ 4 = ₹751 + GST = ₹886; the part was laid from the MRR, ₹251 × 3 =
-- ₹753 → ₹889. Paid exactly ₹886 → no tax invoice.
--   ONE subscription: the app now lays ₹751 (lib/billing/instalments.ts quotePeriodTaxables; vitest
--   sync-instalments-r2104.test.ts) — case C below bills such a part as laid.
--   SEVERAL subscriptions: billing_part_group moved the group to the quote's period taxable only
--   when it was off by ≤ ₹1 a line (R-2092). Parts laid from MRR are off by more:
--   A. Starter 3 × ₹1,002 + Standard 3 × ₹1,002, quarterly: laid 753 + 753 = 1,506; the quote's Q1
--      is 1,503 (₹1,774 incl GST). Paid ₹1,774 → ONE invoice ₹1,774, taxable 1,503, paid.
--      Before: the group stayed 1,506 (₹1,777), ₹1,774 looked short → no invoice.
--   B. A seat change since the sale (Standard now 4 seats, MRR 334, part 1,002) is not rounding:
--      the group keeps its laid figures (753 + 1,002).
--   C. One subscription, part laid ₹751 (as the app now lays it), paid ₹886 → invoice ₹886, paid.

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
  values ('dddddddd-0000-0000-0000-000000210401','R2104 MH Co','r2104a@example.in','27','R04A');

insert into public.customers (id, tenant_id, name, state_code, country)
select ('cccccccc-0000-0000-0000-00000021040' || n)::uuid, 'dddddddd-0000-0000-0000-000000210401',
       'Cust 2104-' || n, '27', 'India'
  from generate_series(1, 3) n;

-- Quotes 1, 2: two lines; quote 3: one line (3 × ₹1,002).
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
select 'TESTQ-R2104-' || n, c.tenant_id, c.name, c.id, 18,
       case when n = 3 then 3547 else 7094 end,
       case when n = 3 then 3006 else 6012 end,
       'quarterly', 'accepted',
       case when n = 3 then
         '[{"name":"Google Workspace Business Starter","qty":3,"rate":1002,"commitment":"annual_quarterly"}]'::jsonb
       else
         '[{"name":"Google Workspace Business Starter","qty":3,"rate":1002,"commitment":"annual_quarterly"},
           {"name":"Google Workspace Business Standard","qty":3,"rate":1002,"commitment":"annual_quarterly"}]'::jsonb
       end
  from generate_series(1, 3) n
  join public.customers c on c.id = ('cccccccc-0000-0000-0000-00000021040' || n)::uuid;

-- sN1 Starter (first), sN2 Standard. Quote 2's Standard has 4 seats now (MRR 334). Quote 3: Starter only.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status, created_at)
select ('eeeeeeee-0000-0000-0000-0000002104' || n || k)::uuid, q.tenant_id, q.customer_id, q.customer_name,
       case k when 1 then 'Google Workspace Business Starter' else 'Google Workspace Business Standard' end,
       'google'::vendor, case when n = 2 and k = 2 then 4 else 3 end, case when n = 2 and k = 2 then 334 else 251 end,
       'quarterly'::billing_cycle, q.id, public.ist_today() - 7, 'active',
       now() - interval '1 hour' + make_interval(secs => k)
  from generate_series(1, 3) n
  cross join generate_series(1, 2) k
  join public.quotes q on q.id = 'TESTQ-R2104-' || n
 where not (n = 3 and k = 2);

-- Q1 parts as the app lays them: MRR × 3 for a quote with several subscriptions (753, or 1,002 for
-- 4 seats); the quote's own Q1 (751) for the one-subscription quote (R-2104).
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-000002104' || n || k || '1')::uuid, s.tenant_id, s.id,
       s.start_date, 1, s.start_date, s.start_date, (s.start_date + interval '3 months')::date,
       case when n = 3 then 751 else s.mrr * 3 end, 18
  from generate_series(1, 3) n
  cross join generate_series(1, 2) k
  join public.subscriptions s on s.id = ('eeeeeeee-0000-0000-0000-0000002104' || n || k)::uuid;

-- What the Record payment sheet asked (planForQuote): quotes 1, 2 → ₹1,774; quote 3 → ₹886.
do $$
begin
  perform public.record_payment('TESTQ-R2104-1', 1774, 'upi', 'R2104-PAY-1');
  perform public.record_payment('TESTQ-R2104-3', 886, 'upi', 'R2104-PAY-3');
end $$;

do $$
declare
  v_sum integer; v_n integer; v_i record; r1 jsonb;
begin
  -- A. two subscriptions, parts off by ₹3 in all → the group IS the quote's Q1 (1,503)
  select sum(taxable) into v_sum from public.billing_part_group('bbbbbbbb-0000-0000-0000-000002104111');
  if v_sum is distinct from 1503 then
    raise exception 'A FAIL: group taxable % (want the quote''s Q1 1,503 — what the sheet asked)', v_sum;
  end if;
  r1 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002104111', false);
  select count(distinct invoice_id), count(invoice_id) into v_n from public.subscription_billings
   where subscription_id in ('eeeeeeee-0000-0000-0000-000000210411', 'eeeeeeee-0000-0000-0000-000000210412');
  if v_n <> 1 or (select count(*) from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000210401') <> 1 then
    raise exception 'A FAIL: paid what the sheet asked, % invoice(s) (want 1): %', v_n, r1;
  end if;
  select * into v_i from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000210401';
  if v_i.amount <> 1774 or v_i.taxable_value <> 1503 or v_i.status::text <> 'paid' or v_i.paid_amount <> 1774 then
    raise exception 'A FAIL: invoice % taxable % % paid % (want 1,774 / 1,503 / paid 1,774)',
      v_i.amount, v_i.taxable_value, v_i.status, v_i.paid_amount;
  end if;

  -- B. a seat change is not rounding → the laid figures stand
  select sum(taxable) into v_sum from public.billing_part_group('bbbbbbbb-0000-0000-0000-000002104211');
  if v_sum is distinct from 1755 then
    raise exception 'B FAIL: group taxable % (want 753 + 1,002 = 1,755 — a seat change is not rounding)', v_sum;
  end if;

  -- C. one subscription, part laid at the quote's Q1 → paying ₹886 invoices it
  r1 := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002104311', false);
  select * into v_i from public.invoices where customer_id = 'cccccccc-0000-0000-0000-000000210403';
  if not found or v_i.amount <> 886 or v_i.status::text <> 'paid' then
    raise exception 'C FAIL: % (invoice % %)', r1, v_i.amount, v_i.status;
  end if;
end $$;

select 'R-2104 quote period parts: ALL PASS' as result;

rollback;
