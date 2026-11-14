-- R-2806 (14 Nov 2026, p1 money) — part 1 of R-2805 "Bill together". Migration 20261114103500_r2806_bill_group_pool.
-- Self-asserting, ONE transaction, rolled back. Local DB only. RED without the migration (no bill_group_id; the
-- second subscription's own Bill next part makes a second proforma; its pool goes below zero).
--
-- Two subscriptions of ONE customer, on no common sale quote (ITBUZZ shape: Business Standard + Business Starter,
-- Zoho-imported), each with its next renewal part laid and R-2735-marked, periods differ (1 Oct / 15 Oct).
-- They are one bill group, and ONE together part request names both parts (what R-2810's RPC makes).
--   H. Bill next part on EITHER subscription → request_open with the together proforma (never a second bill)
--   A. The proforma paid in full → ONE tax invoice, two lines, both parts point at it, paid
--   F. Each line shows ITS part's period (1 Oct–1 Nov / 15 Oct–15 Nov)
--   R. R-2735: each subscription renews by its own mark, exactly once
--   P. Both subscriptions' pools are 0 afterwards (not below zero)
--   E. Billing again (cron / webhook retry) → already_invoiced, still one invoice, no second roll
--   N. B's NEXT own part request, paid → its tax invoice is PAID (before: 'pending', the customer chased again)
--   G. Full credit note on the together invoice → both parts freed, each subscription moves back once (R-2749),
--      and the note's credit sits in the shared pool ONCE
--   D. A short payment on a together request → no invoice, nothing renews
--   Z. No group → billing_pool_subscriptions = the sub + its sale quote's subs (the old pool); grants

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
  ('b2806000-0000-0000-0000-0000000000f1', 'R2806 Together Co', 'r2806@example.test', '07', 'R806');
update public.tenants set books_start_date = '2025-04-01' where id = 'b2806000-0000-0000-0000-0000000000f1';

create function pg_temp.cust(p_n int) returns uuid language plpgsql as $f$
declare v_c uuid := ('b2806000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'b2806000-0000-0000-0000-0000000000f1', 'R2806 C' || p_n, '07', 'India');
  return v_c;
end $f$;

create function pg_temp.sub(p_n int, p_c uuid, p_plan text, p_seats int, p_start date, p_renewal date, p_group uuid)
returns uuid language plpgsql as $f$
declare v_s uuid := ('b2806000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status, bill_group_id)
  values (v_s, 'b2806000-0000-0000-0000-0000000000f1', p_c, (select name from public.customers where id = p_c), p_plan,
          'google'::vendor, p_seats, 1000, 'monthly'::billing_cycle, 12, p_start, p_renewal, 'grace_period', 2, 'active', p_group);
  return v_s;
end $f$;

create function pg_temp.part(p_s uuid, p_k int, p_start date, p_taxable int, p_from date default null, p_to date default null)
returns uuid language plpgsql as $f$
declare v_b uuid := ('b2806000-0000-0000-0000-0000000003' || lpad(p_k::text, 2, '0'))::uuid;
begin
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                            period_end, taxable_amount, tax_rate, renews_from, renews_to)
  values (v_b, 'b2806000-0000-0000-0000-0000000000f1', p_s, p_start, 1, p_start, p_start,
          (p_start + interval '1 month')::date, p_taxable, 18, p_from, p_to);
  return v_b;
end $f$;

-- The together request as R-2810's bill_parts_together makes it: one proforma, a line per part (billing_id).
create function pg_temp.together(p_id text, p_c uuid, p_lead uuid, p_parts uuid[]) returns text language plpgsql as $f$
declare v_lines jsonb := '[]'::jsonb; v_sub integer := 0; v_p record;
begin
  for v_p in select b.id, b.taxable_amount, s.plan, s.seats from unnest(p_parts) with ordinality u(id, n)
               join public.subscription_billings b on b.id = u.id join public.subscriptions s on s.id = b.subscription_id
              order by u.n loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('id', 'part-' || v_p.id, 'name', v_p.plan,
                 'billing_id', v_p.id::text, 'qty', v_p.seats, 'rate', v_p.taxable_amount / v_p.seats));
    v_sub := v_sub + v_p.taxable_amount;
  end loop;
  perform set_config('app.r2519_write', 'on', true);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, subtotal, tax_rate,
                             line_items, subscription_billing_id, created_date, expires_date)
  values (p_id, 'b2806000-0000-0000-0000-0000000000f1', p_c, (select name from public.customers where id = p_c), 'sent', 'none',
          v_sub + round(v_sub * 18 / 100.0)::int, v_sub, 18, v_lines, p_lead, public.ist_today(), public.ist_today() + 15);
  perform set_config('app.r2519_write', '', true);
  return p_id;
end $f$;

create function pg_temp.pay(p_q text, p_amt int, p_ref text) returns void language sql as $f$
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2806000-0000-0000-0000-0000000000f1', p_q, p_amt, 'bank_transfer', p_ref, 'received', now());
$f$;

create function pg_temp.st(p_s uuid) returns text language sql as $f$
  select s.renewal_date::text || ' ' || s.renewal_state::text from public.subscriptions s where s.id = p_s;
$f$;

-- ── H A F R P E N G — one customer, two subscriptions, one together proforma ───────────────────────────────
do $$
declare
  v_c uuid; v_a uuid; v_b uuid; pa uuid; pb uuid; pb2 uuid; v_g uuid := 'b2806000-0000-0000-0000-0000000009a1';
  r jsonb; v_t text; v_inv record; v_n integer; v_line_b jsonb; v_line_a jsonb; v_r2 text; v_cn integer;
begin
  v_c := pg_temp.cust(1);
  v_a := pg_temp.sub(1, v_c, 'Google Workspace Business Standard', 161, '2025-10-01', '2026-10-01', v_g);
  v_b := pg_temp.sub(2, v_c, 'Google Workspace Business Starter', 49, '2025-10-15', '2026-10-15', v_g);
  pa := pg_temp.part(v_a, 1, '2026-10-01', 161 * 1585, '2026-10-01', '2027-10-01');
  pb := pg_temp.part(v_b, 2, '2026-10-15', 49 * 450, '2026-10-15', '2027-10-15');
  v_t := pg_temp.together('TESTQ-R2806-T1', v_c, pa, array[pa, pb]);

  -- H. Bill next part on either subscription → the together proforma, no second bill
  r := public.bill_subscription_instalment(pb, false);
  if r->>'action' <> 'request_open' or r->>'quote_id' <> v_t then
    raise exception 'FAIL H: Bill next part on B → % (want request_open %)', r, v_t; end if;
  r := public.bill_subscription_instalment(pa, false);
  if r->>'action' <> 'request_open' or r->>'quote_id' <> v_t then
    raise exception 'FAIL H: Bill next part on A → % (want request_open %)', r, v_t; end if;
  if (select count(*) from public.quotes where customer_id = v_c) <> 1 then
    raise exception 'FAIL H: % quotes for the customer (want only the together proforma)', (select count(*) from public.quotes where customer_id = v_c); end if;
  raise notice 'PASS H: Bill next part on either subscription answers with the together proforma';

  -- A. paid in full → ONE tax invoice for both parts
  perform pg_temp.pay(v_t, (select amount from public.quotes where id = v_t), 'R2806-T1');
  select count(distinct invoice_id) into v_n from public.subscription_billings where id in (pa, pb);
  if v_n <> 1 or (select invoice_id from public.subscription_billings where id = pa) is null
     or (select count(*) from public.invoices where customer_id = v_c) <> 1 then
    raise exception 'FAIL A: % invoice id(s) on the parts / % invoices (want ONE)', v_n, (select count(*) from public.invoices where customer_id = v_c); end if;
  select * into v_inv from public.invoices where customer_id = v_c;
  if v_inv.taxable_value <> 161 * 1585 + 49 * 450 or v_inv.amount <> (select amount from public.quotes where id = v_t)
     or jsonb_array_length(v_inv.line_items) <> 2 or v_inv.status::text <> 'paid' or v_inv.paid_amount <> v_inv.amount then
    raise exception 'FAIL A: invoice % taxable % amount % lines % status % paid %',
      v_inv.id, v_inv.taxable_value, v_inv.amount, jsonb_array_length(v_inv.line_items), v_inv.status, v_inv.paid_amount; end if;
  raise notice 'PASS A: one tax invoice % for both subscriptions, two lines, paid', v_inv.id;

  -- F. each line its own period
  select l into v_line_a from jsonb_array_elements(v_inv.line_items) l where l->>'name' like '%Standard';
  select l into v_line_b from jsonb_array_elements(v_inv.line_items) l where l->>'name' like '%Starter';
  if v_line_a->>'description' not like '%01 Oct 2026 to 01 Nov 2026%' or v_line_b->>'description' not like '%15 Oct 2026 to 15 Nov 2026%'
     or (v_line_a->>'qty')::int <> 161 or (v_line_a->>'rate')::int <> 1585 or (v_line_b->>'qty')::int <> 49 or (v_line_b->>'rate')::int <> 450 then
    raise exception 'FAIL F: lines % / %', v_line_a, v_line_b; end if;
  raise notice 'PASS F: each line carries its own seats × rate and period';

  -- R. R-2735 — each renews by its own mark
  if pg_temp.st(v_a) <> '2027-10-01 renewed' or pg_temp.st(v_b) <> '2027-10-15 renewed' then
    raise exception 'FAIL R: A % / B % (want 2027-10-01 / 2027-10-15 renewed)', pg_temp.st(v_a), pg_temp.st(v_b); end if;
  if (select count(*) from public.subscription_renewal_moves where subscription_id in (v_a, v_b) and direction = 'forward') <> 2 then
    raise exception 'FAIL R: forward moves %', (select count(*) from public.subscription_renewal_moves where subscription_id in (v_a, v_b)); end if;
  raise notice 'PASS R: each subscription renewed once by its own term';

  -- P. both pools 0
  if (select base from public.instalment_credit_parts(v_a)) <> 0 or (select base from public.instalment_credit_parts(v_b)) <> 0 then
    raise exception 'FAIL P: pool A % / B % (want 0 / 0)', (select base from public.instalment_credit_parts(v_a)),
      (select base from public.instalment_credit_parts(v_b)); end if;
  raise notice 'PASS P: the together invoice is absorbed once — both pools 0';

  -- E. retries
  r := public.bill_subscription_instalment(pa, false);
  if r->>'action' <> 'already_invoiced' then raise exception 'FAIL E: A again → %', r; end if;
  r := public.bill_subscription_instalment(pb, false);
  if r->>'action' <> 'already_invoiced' or r->>'invoice_id' <> v_inv.id then raise exception 'FAIL E: B again → %', r; end if;
  if (select count(*) from public.invoices where customer_id = v_c) <> 1 or pg_temp.st(v_b) <> '2027-10-15 renewed' then
    raise exception 'FAIL E: retry made a second invoice or moved B again'; end if;
  raise notice 'PASS E: billing again changes nothing';

  -- N. B's next own part: its own request, paid → its invoice is PAID
  pb2 := pg_temp.part(v_b, 3, '2026-11-15', 49 * 450);
  r := public.bill_subscription_instalment(pb2, false);
  if r->>'action' <> 'request' and r->>'action' <> 'request_open' then raise exception 'FAIL N: B next part → %', r; end if;
  v_r2 := coalesce(r->>'quote_id', (select id from public.quotes where subscription_billing_id = pb2));
  if v_r2 is null or v_r2 = v_t then raise exception 'FAIL N: B next part request % (want its own)', r; end if;
  perform pg_temp.pay(v_r2, (select amount from public.quotes where id = v_r2), 'R2806-N');
  if (select i.status::text from public.invoices i join public.subscription_billings b on b.invoice_id = i.id where b.id = pb2) is distinct from 'paid' then
    raise exception 'FAIL N: B next part invoice % (want paid — the together invoice must not eat its money)',
      (select i.status::text || ' paid ' || i.paid_amount from public.invoices i join public.subscription_billings b on b.invoice_id = i.id where b.id = pb2); end if;
  raise notice 'PASS N: B''s next paid part is invoiced paid';

  -- G. full credit note on the together invoice → both parts freed, each moves back once, credit once in the pool
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.issue_credit_note(v_inv.id, v_inv.amount, 'cancellation', 'R2806 test full CN', null);
  perform set_config('request.jwt.claims', '', true);
  if (select count(*) from public.subscription_billings where id in (pa, pb) and invoice_id is null and v_inv.id = any(credited_invoice_ids)) <> 2 then
    raise exception 'FAIL G: credit note freed % part(s) (want 2)', (select count(*) from public.subscription_billings where id in (pa, pb) and invoice_id is null); end if;
  if pg_temp.st(v_a) <> '2026-10-01 pending' or pg_temp.st(v_b) <> '2026-10-15 pending' then
    raise exception 'FAIL G: after credit note A % / B % (want back to 2026-10-01 / 2026-10-15 pending)', pg_temp.st(v_a), pg_temp.st(v_b); end if;
  select coalesce(sum(c.amount), 0) into v_cn from public.customer_credits c
   where c.source = 'credit_note' and c.status = 'open' and c.source_invoice_id = v_inv.id;
  if public.instalment_credit(v_a) <> v_cn or public.instalment_credit(v_b) <> v_cn then
    raise exception 'FAIL G: pool A % / B % (want the note''s open credit % once each, one shared pool)',
      public.instalment_credit(v_a), public.instalment_credit(v_b), v_cn; end if;
  raise notice 'PASS G: credit note frees both parts, both move back once, credit counted once';
end $$;

-- ── D. short payment on a together request → nothing ─────────────────────────────────────────────────────
do $$
declare v_c uuid; v_a uuid; v_b uuid; pa uuid; pb uuid; v_t text; v_g uuid := 'b2806000-0000-0000-0000-0000000009a2';
begin
  v_c := pg_temp.cust(2);
  v_a := pg_temp.sub(3, v_c, 'Google Workspace Business Standard', 10, '2025-10-01', '2026-10-01', v_g);
  v_b := pg_temp.sub(4, v_c, 'Google Workspace Business Starter', 5, '2025-10-01', '2026-10-01', v_g);
  pa := pg_temp.part(v_a, 11, '2026-10-01', 10 * 1585, '2026-10-01', '2027-10-01');
  pb := pg_temp.part(v_b, 12, '2026-10-01', 5 * 450, '2026-10-01', '2027-10-01');
  v_t := pg_temp.together('TESTQ-R2806-T2', v_c, pa, array[pa, pb]);
  perform pg_temp.pay(v_t, (select amount from public.quotes where id = v_t) - 100, 'R2806-D');
  if (select count(*) from public.invoices where customer_id = v_c) <> 0
     or pg_temp.st(v_a) <> '2026-10-01 grace_period' or pg_temp.st(v_b) <> '2026-10-01 grace_period' then
    raise exception 'FAIL D: short payment → % invoice(s), A % / B %', (select count(*) from public.invoices where customer_id = v_c),
      pg_temp.st(v_a), pg_temp.st(v_b); end if;
  raise notice 'PASS D: short payment invoices nothing and renews nothing';
end $$;

-- ── O. A request line naming a part OUTSIDE the pool (another customer's group) never bills that part ────
do $$
declare v_c uuid; v_c2 uuid; v_a uuid; v_x uuid; pa uuid; px uuid; v_t text; r jsonb;
begin
  v_c := pg_temp.cust(4); v_c2 := pg_temp.cust(5);
  v_a := pg_temp.sub(8, v_c, 'Google Workspace Business Standard', 2, '2025-10-01', '2026-10-01', 'b2806000-0000-0000-0000-0000000009a4');
  v_x := pg_temp.sub(9, v_c2, 'Google Workspace Business Starter', 2, '2025-10-01', '2026-10-01', 'b2806000-0000-0000-0000-0000000009a5');
  pa := pg_temp.part(v_a, 21, '2026-10-01', 2 * 1585, '2026-10-01', '2027-10-01');
  px := pg_temp.part(v_x, 22, '2026-10-01', 2 * 450, '2026-10-01', '2027-10-01');
  v_t := pg_temp.together('TESTQ-R2806-T3', v_c, pa, array[pa, px]);   -- broken by hand: px is another pool
  perform pg_temp.pay(v_t, (select amount from public.quotes where id = v_t), 'R2806-O');
  if (select invoice_id from public.subscription_billings where id = px) is not null
     or pg_temp.st(v_x) <> '2026-10-01 grace_period' then
    raise exception 'FAIL O: the other pool''s part was billed / renewed: % %', (select invoice_id from public.subscription_billings where id = px), pg_temp.st(v_x); end if;
  if (select invoice_id from public.subscription_billings where id = pa) is null or pg_temp.st(v_a) <> '2027-10-01 renewed' then
    raise exception 'FAIL O: own part not billed: %', pg_temp.st(v_a); end if;
  raise notice 'PASS O: a part outside the pool is never billed on the group''s invoice';
end $$;

-- ── Z. No group = the old pool; grants ────────────────────────────────────────────────────────────────────
do $$
declare v_c uuid; v_s1 uuid; v_s2 uuid; v_s3 uuid; v_n integer;
begin
  v_c := pg_temp.cust(3);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, amount, subtotal, tax_rate, line_items)
  values ('TESTQ-R2806-SALE', 'b2806000-0000-0000-0000-0000000000f1', v_c, 'R2806 C3', 'accepted', 1180, 1000, 18, '[]'::jsonb);
  v_s1 := pg_temp.sub(5, v_c, 'Plan 1', 1, '2026-01-01', '2027-01-01', null);
  v_s2 := pg_temp.sub(6, v_c, 'Plan 2', 1, '2026-01-01', '2027-01-01', null);
  v_s3 := pg_temp.sub(7, v_c, 'Plan 3', 1, '2026-01-01', '2027-01-01', null);
  update public.subscriptions set quote_id = 'TESTQ-R2806-SALE' where id in (v_s1, v_s2);
  select count(*) into v_n from public.billing_pool_subscriptions(v_s1) p where p.subscription_id in (v_s1, v_s2);
  if v_n <> 2 or (select count(*) from public.billing_pool_subscriptions(v_s1)) <> 2 then
    raise exception 'FAIL Z: quote pool of s1 = % (want s1 + s2)', (select array_agg(subscription_id) from public.billing_pool_subscriptions(v_s1)); end if;
  if (select array_agg(subscription_id) from public.billing_pool_subscriptions(v_s3)) <> array[v_s3] then
    raise exception 'FAIL Z: lone sub pool %', (select array_agg(subscription_id) from public.billing_pool_subscriptions(v_s3)); end if;
  /* closure: s1 + s2 share the sale quote; s2 + s3 a bill group → s1's pool reaches s3, and all three agree */
  update public.subscriptions set bill_group_id = 'b2806000-0000-0000-0000-0000000009a3' where id in (v_s2, v_s3);
  if (select count(*) from public.billing_pool_subscriptions(v_s1)) <> 3
     or (select count(*) from public.billing_pool_subscriptions(v_s3)) <> 3
     or exists (select subscription_id from public.billing_pool_subscriptions(v_s1)
                except select subscription_id from public.billing_pool_subscriptions(v_s3)) then
    raise exception 'FAIL Z: closure s1 % / s3 %', (select array_agg(subscription_id) from public.billing_pool_subscriptions(v_s1)),
      (select array_agg(subscription_id) from public.billing_pool_subscriptions(v_s3)); end if;
  update public.subscriptions set bill_group_id = null where id in (v_s2, v_s3);
  if has_function_privilege('authenticated', 'public.billing_pool_subscriptions(uuid)', 'execute')
     or has_function_privilege('anon', 'public.billing_pool_subscriptions(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.instalment_credit_parts(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.billing_part_group(uuid)', 'execute')
     or has_function_privilege('anon', 'public.raise_subscription_billing(uuid)', 'execute') then
    raise exception 'FAIL Z: a pool / group function is callable by a browser role'; end if;
  raise notice 'PASS Z: no group = the sale quote''s pool as before; functions are server-only';
end $$;

rollback;
