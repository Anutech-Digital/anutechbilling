\set ON_ERROR_STOP on
-- R-2710 (p0 money, Pratik 12 Nov): "Review renewal quote" makes the renewal quote as a DRAFT to
-- edit; a renewal quote whose domain line is changed to 3 years renews the subscription for 3 years.
-- Migration: 20261113060034_r2710_renewal_review_draft_and_years (create_renewal_quote status,
-- quotes_r2710_renewal_term_follows_years).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2710_renewal_review.test.sql
--
-- Expect "PASS r2710_renewal_review". Every check is collected and failures listed together.
--
--   DRAFT     p_quote.status = 'draft' → the new quote is a draft, linked to the subscription
--   ONCE      a second call (double click) returns the SAME quote, created = false, still a draft
--   SENT      no status (cron / Send now / Create quote) → 'sent' as before (regression)
--   YEARS     draft domain line 1 → 3 years: extension_months 12 → 36; 3 → 1 back to 12
--   PAID      3-year renewal paid in full → renewal_date + 36 months, mrr = subtotal / 36,
--             one subscription, nothing else rolled
--   OLD 24    an older 24-month renewal quote (no years on its line): 3 years → 36 (not 72); seats-only keeps 24
--   MIXED     a 3-year line next to other renewing lines is refused
--   MARK SENT the draft saved as 'sent' in the same update (Save & mark sent) still follows the years
--   LEFT      sent quote / extension quote / plan change (0 months) / month term / caller-set
--             extension_months → extension_months untouched
--   CONTROL   a 1-year renewal still rolls + 12 months (regression)

begin;
select set_config('request.jwt.claims', '', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2710000-0000-0000-0000-0000000000a0', 'R2710 A', 'r2710a@example.in', '07', 'R271A');

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2710000-0000-4000-8000-0000000000c1', 'e2710000-0000-0000-0000-0000000000a0', 'R2710 Cust', '07', 'India');

-- The roll-forward raises an automatic PO; seed the series high so its id cannot collide.
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('e2710000-0000-0000-0000-0000000000a0', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9700);

-- e1: draft + years + paid (domain)   e2: no status → sent   e3: 1-year control
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, renewal_date, start_date, status, domain)
select ('e2710000-0000-4000-8000-0000000000e' || n)::uuid, 'e2710000-0000-0000-0000-0000000000a0',
       'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 'Domain Registration .com', 'domain'::vendor,
       1, 100, 12, date '2026-11-30', date '2025-12-01', 'active', 'r2710-' || n || '.example'
  from generate_series(1, 3) n;

create temp table r2710_fail (msg text) on commit drop;

-- 1 year of a .com: ₹1,200 + 18% = ₹1,416.
create function pg_temp.r2710_q(p_status text) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'customer_name', 'R2710 Cust', 'plan', 'Domain Registration .com', 'seats', 1,
    'amount', 1416, 'subtotal', 1200, 'total_cost', 900, 'tax_rate', 18,
    'created_date', '2026-11-12', 'expires_date', '2026-12-15', 'extension_months', 12,
    'notes', 'Renewal quote (R-2710 test)',
    'line_items', '[{"id":"renewal-1","name":"Domain Registration .com","qty":1,"rate":1200,"cost":900,"commitment":"annual_yearly"}]'::jsonb)
  || case when p_status is null then '{}'::jsonb else jsonb_build_object('status', p_status) end
$$;

do $$
declare
  c_a   constant uuid := 'e2710000-0000-0000-0000-0000000000a0';
  c_e1  constant uuid := 'e2710000-0000-4000-8000-0000000000e1';
  c_e2  constant uuid := 'e2710000-0000-4000-8000-0000000000e2';
  c_e3  constant uuid := 'e2710000-0000-4000-8000-0000000000e3';
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_r4 jsonb;
  v_status text; v_link text; v_ext int; v_n int; v_d date; v_mrr int; v_state text;
begin
  -- DRAFT
  v_r1 := public.create_renewal_quote(c_e1, c_a, pg_temp.r2710_q('draft'));
  select status, extension_months into v_status, v_ext from public.quotes where id = v_r1->>'quote_id';
  select renewal_quote_id into v_link from public.subscriptions where id = c_e1;
  if v_status <> 'draft' then insert into r2710_fail values ('DRAFT: status ' || coalesce(v_status, 'null') || ', expected draft'); end if;
  if v_link is distinct from v_r1->>'quote_id' then insert into r2710_fail values ('DRAFT: subscription not linked to ' || (v_r1->>'quote_id')); end if;
  if (v_r1->>'created')::boolean is not true then insert into r2710_fail values ('DRAFT: created should be true'); end if;

  -- ONCE (double click)
  v_r2 := public.create_renewal_quote(c_e1, c_a, pg_temp.r2710_q('draft'));
  if v_r2->>'quote_id' is distinct from v_r1->>'quote_id' or (v_r2->>'created')::boolean then
    insert into r2710_fail values ('ONCE: second call made ' || (v_r2->>'quote_id') || ' created=' || (v_r2->>'created'));
  end if;
  select count(*) into v_n from public.quotes where renewal_subscription_id = c_e1;
  if v_n <> 1 then insert into r2710_fail values ('ONCE: ' || v_n || ' quotes for the subscription, expected 1'); end if;

  -- SENT (no status = old behaviour; 'sent' or junk → sent too)
  v_r3 := public.create_renewal_quote(c_e2, c_a, pg_temp.r2710_q(null));
  select status into v_status from public.quotes where id = v_r3->>'quote_id';
  if v_status <> 'sent' then insert into r2710_fail values ('SENT: no status gave ' || v_status || ', expected sent'); end if;

  -- YEARS: the editor saves the draft with the line at 3 years (rate = 3 x yearly, R-1445)
  update public.quotes
     set line_items = '[{"id":"renewal-1","name":"Domain Registration .com","qty":1,"rate":3600,"cost":2700,"commitment":"annual_yearly","years":3}]'::jsonb,
         subtotal = 3600, amount = 4248
   where id = v_r1->>'quote_id';
  select extension_months into v_ext from public.quotes where id = v_r1->>'quote_id';
  if v_ext <> 36 then insert into r2710_fail values ('YEARS: 3 years gave extension_months ' || v_ext || ', expected 36'); end if;
  -- back to 1 year, then 3 again
  update public.quotes
     set line_items = '[{"id":"renewal-1","name":"Domain Registration .com","qty":1,"rate":1200,"cost":900,"commitment":"annual_yearly"}]'::jsonb
   where id = v_r1->>'quote_id';
  select extension_months into v_ext from public.quotes where id = v_r1->>'quote_id';
  if v_ext <> 12 then insert into r2710_fail values ('YEARS: back to 1 year gave ' || v_ext || ', expected 12'); end if;
  update public.quotes
     set line_items = '[{"id":"renewal-1","name":"Domain Registration .com","qty":1,"rate":3600,"cost":2700,"commitment":"annual_yearly","years":3}]'::jsonb,
         subtotal = 3600, amount = 4248
   where id = v_r1->>'quote_id';

  -- PAID: the editor's Save & send flips it to sent, then the customer pays ₹4,248
  update public.quotes set status = 'sent' where id = v_r1->>'quote_id';
  perform public.record_payment(v_r1->>'quote_id', 4248, 'razorpay', 'rzp_r2710_3y');
  select count(*) into v_n from public.subscriptions where customer_id = 'e2710000-0000-4000-8000-0000000000c1';
  select renewal_date, mrr, renewal_state into v_d, v_mrr, v_state from public.subscriptions where id = c_e1;
  if v_n <> 3 then insert into r2710_fail values ('PAID: ' || v_n || ' subscriptions, expected 3 (no new one)'); end if;
  if v_d <> date '2029-11-30' then insert into r2710_fail values ('PAID: renewal_date ' || v_d || ', expected 2029-11-30 (+36 months)'); end if;
  if v_mrr <> 100 then insert into r2710_fail values ('PAID: mrr ' || v_mrr || ', expected 100 (3600 / 36)'); end if;
  if v_state <> 'renewed' then insert into r2710_fail values ('PAID: renewal_state ' || v_state || ', expected renewed'); end if;
  select renewal_date into v_d from public.subscriptions where id = c_e2;
  if v_d <> date '2026-11-30' then insert into r2710_fail values ('PAID: another subscription moved to ' || v_d); end if;

  -- CONTROL: a 1-year draft renewal, unchanged, paid → + 12 months
  v_r4 := public.create_renewal_quote(c_e3, c_a, pg_temp.r2710_q('draft'));
  update public.quotes set status = 'sent' where id = v_r4->>'quote_id';
  perform public.record_payment(v_r4->>'quote_id', 1416, 'razorpay', 'rzp_r2710_1y');
  select renewal_date, mrr into v_d, v_mrr from public.subscriptions where id = c_e3;
  if v_d <> date '2027-11-30' then insert into r2710_fail values ('CONTROL: 1-year renewal moved to ' || v_d || ', expected 2027-11-30'); end if;
  if v_mrr <> 100 then insert into r2710_fail values ('CONTROL: mrr ' || v_mrr || ', expected 100'); end if;
end $$;

-- LEFT: rows the trigger must not touch
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, is_renewal, is_extension, extension_months) values
  ('Q-R2710-SENT',  'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 1416, 'sent',  'awaiting', '[{"name":".com","qty":1,"rate":1200,"commitment":"annual_yearly"}]'::jsonb, true, false, 12),
  ('Q-R2710-EXT',   'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 1416, 'draft', 'none',     '[{"name":".com","qty":1,"rate":1200,"commitment":"annual_yearly"}]'::jsonb, true, true,  24),
  ('Q-R2710-PLAN',  'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 1416, 'draft', 'none',     '[{"name":".com","qty":1,"rate":1200,"commitment":"annual_yearly"}]'::jsonb, true, false, 0),
  ('Q-R2710-MONTH', 'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 1416, 'draft', 'none',     '[{"name":".com","qty":1,"rate":1200,"commitment":"monthly"}]'::jsonb,       true, false, 1),
  ('Q-R2710-SET',   'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 1416, 'draft', 'none',     '[{"name":".com","qty":1,"rate":1200,"commitment":"annual_yearly"}]'::jsonb, true, false, 12),
  ('Q-R2710-NEW',   'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 1416, 'draft', 'none',     '[{"name":".com","qty":1,"rate":1200,"commitment":"annual_yearly"}]'::jsonb, false, false, 12);

update public.quotes set line_items = jsonb_set(line_items, '{0,years}', '3')
 where id in ('Q-R2710-SENT', 'Q-R2710-EXT', 'Q-R2710-PLAN', 'Q-R2710-MONTH', 'Q-R2710-NEW');
update public.quotes set line_items = jsonb_set(line_items, '{0,years}', '3'), extension_months = 24 where id = 'Q-R2710-SET';

insert into r2710_fail
select 'LEFT: ' || id || ' extension_months became ' || coalesce(extension_months::text, 'null')
  from public.quotes
 where (id, coalesce(extension_months, -1)) in (values ('Q-R2710-SENT', 36), ('Q-R2710-EXT', 72), ('Q-R2710-PLAN', 1), ('Q-R2710-MONTH', 3), ('Q-R2710-SET', 36), ('Q-R2710-NEW', 36))
    or (id = 'Q-R2710-SENT'  and extension_months <> 12)
    or (id = 'Q-R2710-EXT'   and extension_months <> 24)
    or (id = 'Q-R2710-PLAN'  and extension_months <> 0)
    or (id = 'Q-R2710-MONTH' and extension_months <> 1)
    or (id = 'Q-R2710-SET'   and extension_months <> 24)
    or (id = 'Q-R2710-NEW'   and extension_months <> 12);

-- MARK SENT: "Save & mark sent" (no customer email) saves the draft as 'sent' in the SAME update
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, is_renewal, is_extension, extension_months) values
  ('Q-R2710-MARK', 'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 1416, 'draft', 'none', '[{"name":".com","qty":1,"rate":1200,"commitment":"annual_yearly"}]'::jsonb, true, false, 12);
update public.quotes set line_items = jsonb_set(line_items, '{0,years}', '3'), status = 'sent' where id = 'Q-R2710-MARK';
insert into r2710_fail
select 'MARK SENT: draft saved as sent with 3 years gave extension_months ' || extension_months || ', expected 36'
  from public.quotes where id = 'Q-R2710-MARK' and extension_months <> 36;

-- OLD 24: a renewal quote made before R-2710 for a 24-month term (no years on its line) — its revision
-- picks 3 years → 36 (never 24 × 3 = 72); a seats-only edit keeps 24; 1 year → 12
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, is_renewal, is_extension, extension_months) values
  ('Q-R2710-OLD24',  'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 2832, 'draft', 'none', '[{"name":".com","qty":1,"rate":2400,"commitment":"annual_yearly"}]'::jsonb, true, false, 24),
  ('Q-R2710-SEATS',  'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 2832, 'draft', 'none', '[{"name":"Workspace","qty":5,"rate":2400,"commitment":"annual_yearly"}]'::jsonb, true, false, 24),
  ('Q-R2710-ONE',    'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 2832, 'draft', 'none', '[{"name":".com","qty":1,"rate":2400,"commitment":"annual_yearly","years":2}]'::jsonb, true, false, 24);
update public.quotes set line_items = jsonb_set(line_items, '{0,years}', '3') where id = 'Q-R2710-OLD24';
update public.quotes set line_items = jsonb_set(line_items, '{0,qty}', '6') where id = 'Q-R2710-SEATS';
update public.quotes set line_items = line_items #- '{0,years}' where id = 'Q-R2710-ONE';
insert into r2710_fail
select 'OLD 24: ' || id || ' extension_months ' || extension_months
  from public.quotes
 where (id = 'Q-R2710-OLD24' and extension_months <> 36)
    or (id = 'Q-R2710-SEATS' and extension_months <> 24)
    or (id = 'Q-R2710-ONE'   and extension_months <> 12);

-- MIXED: a 3-year domain line next to yearly seats on one renewal quote → refused with the way out
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items, is_renewal, is_extension, extension_months) values
  ('Q-R2710-MIX', 'e2710000-0000-0000-0000-0000000000a0', 'e2710000-0000-4000-8000-0000000000c1', 'R2710 Cust', 2832, 'draft', 'none',
   '[{"name":".com","qty":1,"rate":1200,"commitment":"annual_yearly"},{"name":"Workspace","qty":5,"rate":1200,"commitment":"annual_yearly"}]'::jsonb, true, false, 12);
do $$
declare v_err text;
begin
  begin
    update public.quotes set line_items = jsonb_set(line_items, '{0,years}', '3') where id = 'Q-R2710-MIX';
  exception when check_violation then v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%must be the only renewing line%' then
    insert into r2710_fail values ('MIXED: 3-year domain + seats was not refused (' || coalesce(v_err, 'saved') || ')');
  end if;
end $$;

do $$
declare v_all text;
begin
  select string_agg(msg, E'\n') into v_all from r2710_fail;
  if v_all is not null then
    raise exception E'FAIL r2710_renewal_review:\n%', v_all;
  end if;
  raise notice 'PASS r2710_renewal_review';
end $$;

rollback;
