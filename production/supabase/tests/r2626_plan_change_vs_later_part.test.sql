-- R-2626 (9 Nov 2026, split from R-2617 b): billed in parts, a plan change is priced for the CURRENT
-- part only (later parts are laid again at the new rate by the billing run, R-527). A later part that
-- is already billed — a proforma raised ahead (Bill next part, R-2519b) or its tax invoice — keeps the
-- old plan's rate: under-billed. So paying the plan-change quote is refused while a later part is
-- billed; the owner cancels that proforma (or changes the plan once the part starts).
--
-- Migration 20261109064000_r2626_plan_change_vs_later_part (trigger subscriptions_r2626_plan_change_vs_later_part):
--   1.  the real path: record_payment of a plan-change quote while Q3 has a live tax invoice
--       → refused 'R-2626: plan change refused — Q3 (…) is already invoiced (INV…)…', nothing booked,
--       subscription unchanged.
--   2.  Q3 has an open proforma (status sent, linked by subscription_billing_id) → refused, names it.
--   3.  Q3 freed by credit notes (invoice_id null, credited_invoice_ids), the request spent on that
--       invoice, and a cancelled proforma (cancel_quote unlinks it) → goes through.
--   4.  Q3 laid but not billed → goes through (the billing run re-prices it).
--   5.  only the CURRENT part (Q2) and an earlier part (Q1) invoiced → goes through.
--   6.  Correct details (item_id changes, no plan-change quote linked) with Q3 invoiced → not this guard.
--   7.  R-2073-style upgrade (linked quote, extension_months 0, NO plan_change line) → not this guard.
--   8.  a renewal (renewal date moves on) with a new plan → not this guard.
--   9.  the plan-change quote of case 2 paid after its proforma was cancelled → goes through.
--   10. Q3 on a GROUP request (R-2092, only a line billing_id names it) + Q4's own request expired by
--       date but still linked → refused, both named, the latest first to cancel.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.

begin;

-- R-1643: tenants need a supplier address / GSTIN for the invoice record_payment makes.
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

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dd262600-0000-4000-8000-00000000a001', 'R2626 Tenant', 'r2626@test.invalid', '07', 'R2626');
insert into public.customers (id, tenant_id, name, state_code, country)
  values ('dd262600-0000-4000-8000-00000000c001', 'dd262600-0000-4000-8000-00000000a001', 'R2626 Cust', '07', 'India');
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, item_type, prices) values
  ('GW-START-r2626', 'dd262600-0000-4000-8000-00000000a001', 'R2626 Business Starter', 'google', 270, 220, 'subscription',
   '{"annual":{"msrp":270,"wholesale":220}}'),
  ('GW-STD-r2626', 'dd262600-0000-4000-8000-00000000a001', 'R2626 Business Standard', 'google', 864, 720, 'subscription',
   '{"annual":{"msrp":864,"wholesale":720}}'),
  ('SUP-STD-r2626', 'dd262600-0000-4000-8000-00000000a001', 'R2626 Support Standard', 'google', 500, 0, 'subscription',
   '{"annual":{"msrp":500,"wholesale":0}}');

-- subs 1..9: Starter, 10 seats, billed QUARTERLY, started 100 days ago → Q2 is the current part.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, item_id, vendor, seats, mrr, status,
                                  billing_cycle, term_months, start_date, renewal_date, renewal_state)
  select ('dd262600-0000-4000-8000-00000000b00' || n)::uuid, 'dd262600-0000-4000-8000-00000000a001',
         'dd262600-0000-4000-8000-00000000c001', 'R2626 Cust',
         'R2626 Business Starter', 'GW-START-r2626', 'google', 10, 2700, 'active',
         'quarterly', 12, current_date - 100, (current_date - 100 + interval '1 year')::date, 'pending'
    from generate_series(1, 9) n;

-- Q1..Q4 of every sub, laid, no bill yet (8100 = 2700 × 3).
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
  select ('dd262600-0000-4000-8000-0000000' || n || '0' || k || '00')::uuid, s.tenant_id, s.id, s.start_date, k,
         (s.start_date + make_interval(months => 3 * (k - 1)))::date,
         (s.start_date + make_interval(months => 3 * (k - 1)))::date,
         (s.start_date + make_interval(months => 3 * k))::date,
         8100, 18
    from generate_series(1, 9) n
    cross join generate_series(1, 4) k
    join public.subscriptions s on s.id = ('dd262600-0000-4000-8000-00000000b00' || n)::uuid;

-- Tax invoices (pending) for: Q3 of subs 1, 6, 7, 8 (billed ahead and paid — as Bill next part leaves it);
-- Q1 + Q2 of sub 5 (earlier + current part).
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date)
  select 'INV-R2626-' || n || '-' || k, 'dd262600-0000-4000-8000-00000000a001', 'dd262600-0000-4000-8000-00000000c001',
         'R2626 Cust', 9558, 'pending', current_date
    from (values (1, 3), (6, 3), (7, 3), (8, 3), (5, 1), (5, 2)) v(n, k);
update public.subscription_billings b set invoice_id = 'INV-R2626-' || v.n || '-' || v.k
  from (values (1, 3), (6, 3), (7, 3), (8, 3), (5, 1), (5, 2)) v(n, k)
 where b.id = ('dd262600-0000-4000-8000-0000000' || v.n || '0' || v.k || '00')::uuid;
-- sub 3: Q3 was invoiced and credit notes cancelled that invoice in full (R-2095: link dropped, kept in history).
update public.subscription_billings set credited_invoice_ids = array['INV-R2626-OLD-3']
 where id = 'dd262600-0000-4000-8000-000000030300';

-- The invoice credit notes cancelled (sub 3's old Q3 invoice).
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date)
values ('INV-R2626-OLD-3', 'dd262600-0000-4000-8000-00000000a001', 'dd262600-0000-4000-8000-00000000c001',
        'R2626 Cust', 9558, 'pending', current_date);

-- Proformas (payment requests):
--   sub 2 Q3 open (sent);
--   sub 3 Q3: one cancelled (cancel_quote unlinks it: rejected, cancelled_part_billing_id) and one spent on the
--     invoice credit notes cancelled (R-2095) — neither is Q3's request any more;
--   sub 9 Q3: a GROUP request (R-2092) linked through sub 6's Q4 row, naming sub 9's Q3 in a line billing_id;
--   sub 9 Q4: its own request, expired by date but still linked (the billing job still treats it as Q4's request).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           line_items, billing_cycle, subscription_billing_id, invoice_id)
values
  ('PI-R2626-2', 'dd262600-0000-4000-8000-00000000a001', 'dd262600-0000-4000-8000-00000000c001', 'R2626 Cust',
   9558, 8100, 18, 'sent', 'awaiting', '[{"name":"R2626 Business Starter Q3","qty":10,"rate":810}]', 'quarterly',
   'dd262600-0000-4000-8000-000000020300', null),
  ('PI-R2626-3B', 'dd262600-0000-4000-8000-00000000a001', 'dd262600-0000-4000-8000-00000000c001', 'R2626 Cust',
   9558, 8100, 18, 'accepted', 'received', '[{"name":"R2626 Business Starter Q3","qty":10,"rate":810}]', 'quarterly',
   'dd262600-0000-4000-8000-000000030300', 'INV-R2626-OLD-3'),
  ('PI-R2626-G9', 'dd262600-0000-4000-8000-00000000a001', 'dd262600-0000-4000-8000-00000000c001', 'R2626 Cust',
   19116, 16200, 18, 'sent', 'awaiting',
   '[{"name":"Lead Q4","qty":10,"rate":810,"billing_id":"dd262600-0000-4000-8000-000000060400"},{"name":"Sub 9 Q3","qty":10,"rate":810,"billing_id":"dd262600-0000-4000-8000-000000090300"}]',
   'quarterly', 'dd262600-0000-4000-8000-000000060400', null),
  ('PI-R2626-9-4', 'dd262600-0000-4000-8000-00000000a001', 'dd262600-0000-4000-8000-00000000c001', 'R2626 Cust',
   9558, 8100, 18, 'expired', 'awaiting', '[{"name":"R2626 Business Starter Q4","qty":10,"rate":810}]', 'quarterly',
   'dd262600-0000-4000-8000-000000090400', null);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           line_items, billing_cycle, cancelled_part_billing_id)
values ('PI-R2626-3', 'dd262600-0000-4000-8000-00000000a001', 'dd262600-0000-4000-8000-00000000c001', 'R2626 Cust',
        9558, 8100, 18, 'rejected', 'none', '[{"name":"R2626 Business Starter Q3","qty":10,"rate":810}]', 'quarterly',
        'dd262600-0000-4000-8000-000000030300');

-- Plan-change quotes as Change plan writes them (period = the rest of Q2), linked; subs 1..5 and 9.
-- Sub 7: an R-2073-style upgrade (no plan_change line). Sub 6, 8: nothing linked.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           line_items, is_renewal, extension_months, billing_cycle)
  select 'Q-R2626-PC' || n, 'dd262600-0000-4000-8000-00000000a001', 'dd262600-0000-4000-8000-00000000c001', 'R2626 Cust',
         11800, 10000, 18, 'draft', 'awaiting',
         jsonb_build_array(jsonb_build_object(
           'id', 'plan-change-1', 'item_id', 'GW-STD-r2626', 'name', 'R2626 Business Standard · change', 'qty', 1,
           'rate', 10000, 'cost', 0, 'commitment', 'annual_yearly',
           'plan_change', jsonb_build_object('subscription_id', 'dd262600-0000-4000-8000-00000000b00' || n,
                                             'to_item_id', 'GW-STD-r2626', 'seats', 10, 'new_mrr', 8640,
                                             'cost_per_seat_month', 720, 'from_seats', 10, 'from_mrr', 2700,
                                             'from_plan', 'R2626 Business Starter',
                                             'period_from', to_char(current_date, 'YYYY-MM-DD'),
                                             'period_to', to_char((current_date - 100 + interval '6 months')::date - 1, 'YYYY-MM-DD')))),
         true, 0, 'yearly'
    from (select n from generate_series(1, 5) n union all select 9) s(n);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           line_items, is_renewal, extension_months, billing_cycle)
values ('Q-R2626-UP7', 'dd262600-0000-4000-8000-00000000a001', 'dd262600-0000-4000-8000-00000000c001', 'R2626 Cust',
        590, 500, 18, 'draft', 'awaiting',
        '[{"id":"up-1","item_id":"SUP-STD-r2626","name":"R2626 Support Standard","qty":1,"rate":500}]', true, 0, 'yearly');
update public.subscriptions set renewal_quote_id = 'Q-R2626-PC' || right(id::text, 1)
 where id in (select ('dd262600-0000-4000-8000-00000000b00' || n)::uuid from (select n from generate_series(1, 5) n union all select 9) s(n));
update public.subscriptions set renewal_quote_id = 'Q-R2626-UP7' where id = 'dd262600-0000-4000-8000-00000000b007';

create temp table r2626_fail (msg text) on commit drop;

do $$
declare
  v_msg text; v_sub record; v_n int;
  v_s1 constant uuid := 'dd262600-0000-4000-8000-00000000b001';
  v_s2 constant uuid := 'dd262600-0000-4000-8000-00000000b002';
  v_s3 constant uuid := 'dd262600-0000-4000-8000-00000000b003';
  v_s4 constant uuid := 'dd262600-0000-4000-8000-00000000b004';
  v_s5 constant uuid := 'dd262600-0000-4000-8000-00000000b005';
  v_s6 constant uuid := 'dd262600-0000-4000-8000-00000000b006';
  v_s7 constant uuid := 'dd262600-0000-4000-8000-00000000b007';
  v_s8 constant uuid := 'dd262600-0000-4000-8000-00000000b008';
begin
  -- 1. the real path: the plan-change quote is paid while Q3 is already invoiced at the old rate.
  begin
    perform public.record_payment('Q-R2626-PC1', 11800, 'bank_transfer', 'r2626-pc1');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r2626_fail values ('1: plan-change quote paid while Q3 is already invoiced at the old rate');
  elsif v_msg not like 'R-2626: plan change refused — Q3 (% – %) is already invoiced (INV-R2626-1-3) at the current plan''s rate.%' then
    insert into r2626_fail values ('1: refusal message: ' || v_msg);
  end if;
  select item_id, seats, mrr, renewal_quote_id into v_sub from public.subscriptions where id = v_s1;
  if v_sub.item_id <> 'GW-START-r2626' or v_sub.mrr <> 2700 or v_sub.renewal_quote_id is distinct from 'Q-R2626-PC1' then
    insert into r2626_fail values ('1: subscription changed to ' || to_jsonb(v_sub)::text);
  end if;
  select count(*) into v_n from public.payments where quote_id = 'Q-R2626-PC1';
  if v_n <> 0 then insert into r2626_fail values ('1: ' || v_n || ' payment row(s) kept for the refused plan change'); end if;

  -- 2. Q3 has an open proforma → refused, names it.
  v_msg := null;
  begin
    update public.subscriptions
       set item_id = 'GW-STD-r2626', plan = 'R2626 Business Standard', mrr = 8640, renewal_quote_id = null
     where id = v_s2;
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r2626_fail values ('2: plan changed while Q3 has an open proforma at the old rate');
  elsif v_msg not like 'R-2626: plan change refused — Q3 (%) already has proforma PI-R2626-2 at the current plan''s rate. Cancel that proforma first%' then
    insert into r2626_fail values ('2: refusal message: ' || v_msg);
  end if;

  -- 3. Q3 credited in full + its proforma cancelled → goes through.
  begin
    perform public.record_payment('Q-R2626-PC3', 11800, 'bank_transfer', 'r2626-pc3');
  exception when others then insert into r2626_fail values ('3: refused although Q3 was credited and its proforma cancelled: ' || sqlerrm); end;
  if (select item_id from public.subscriptions where id = v_s3) <> 'GW-STD-r2626' then
    insert into r2626_fail values ('3: plan not changed');
  end if;

  -- 4. Q3 laid but not billed → goes through.
  begin
    update public.subscriptions
       set item_id = 'GW-STD-r2626', plan = 'R2626 Business Standard', mrr = 8640, renewal_quote_id = null
     where id = v_s4;
  exception when others then insert into r2626_fail values ('4: refused although no later part is billed: ' || sqlerrm); end;

  -- 5. only Q1 (earlier) and Q2 (current) invoiced → goes through.
  begin
    update public.subscriptions
       set item_id = 'GW-STD-r2626', plan = 'R2626 Business Standard', mrr = 8640, renewal_quote_id = null
     where id = v_s5;
  exception when others then insert into r2626_fail values ('5: refused for an earlier / current part invoice: ' || sqlerrm); end;

  -- 6. Correct details (no plan-change quote linked) with Q3 invoiced → not this guard.
  begin
    update public.subscriptions set item_id = 'GW-STD-r2626', plan = 'R2626 Business Standard' where id = v_s6;
  exception when others then insert into r2626_fail values ('6: Correct details refused by the plan-change guard: ' || sqlerrm); end;

  -- 7. an upgrade quote with no plan_change line, Q3 invoiced → not this guard.
  begin
    update public.subscriptions set item_id = 'SUP-STD-r2626', plan = 'R2626 Support Standard', renewal_quote_id = null where id = v_s7;
  exception when others then insert into r2626_fail values ('7: upgrade without plan_change refused: ' || sqlerrm); end;

  -- 8. a renewal with a new plan (date moves on), Q3 invoiced → not this guard.
  begin
    update public.subscriptions
       set item_id = 'GW-STD-r2626', plan = 'R2626 Business Standard', renewal_date = renewal_date + interval '1 year'
     where id = v_s8;
  exception when others then insert into r2626_fail values ('8: renewal with a new plan refused: ' || sqlerrm); end;

  -- 9. sub 2's proforma cancelled (as cancel_quote leaves it) → the plan-change payment goes through.
  update public.quotes set subscription_billing_id = null, status = 'rejected', payment_status = 'none'
   where id = 'PI-R2626-2';
  begin
    perform public.record_payment('Q-R2626-PC2', 11800, 'bank_transfer', 'r2626-pc2');
  exception when others then insert into r2626_fail values ('9: payment refused after the proforma was cancelled: ' || sqlerrm); end;
  if (select item_id from public.subscriptions where id = v_s2) <> 'GW-STD-r2626' then
    insert into r2626_fail values ('9: plan not changed after the proforma was cancelled');
  end if;

  -- 10. group request names sub 9's Q3; Q4's expired-but-linked request → refused, both named.
  v_msg := null;
  begin
    perform public.record_payment('Q-R2626-PC9', 11800, 'bank_transfer', 'r2626-pc9');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r2626_fail values ('10: plan-change quote paid while Q3 (group request) and Q4 are billed');
  elsif v_msg not like 'R-2626: plan change refused — Q3 (%) and Q4 (%) already have proformas PI-R2626-G9, PI-R2626-9-4 at the current plan''s rate. Cancel them first, the latest first%' then
    insert into r2626_fail values ('10: refusal message: ' || v_msg);
  end if;
  if (select item_id from public.subscriptions where id = 'dd262600-0000-4000-8000-00000000b009') <> 'GW-START-r2626' then
    insert into r2626_fail values ('10: plan changed');
  end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2626_fail;
  if v_list is not null then
    raise exception E'FAIL r2626_plan_change_vs_later_part:\n  %', v_list;
  end if;
  raise notice 'PASS r2626_plan_change_vs_later_part';
end $$;

rollback;
