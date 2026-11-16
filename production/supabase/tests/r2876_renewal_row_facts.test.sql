\set ON_ERROR_STOP on
-- R-2876: public.renewal_row_facts(uuid[], text[]) — the rows behind the Renewals page's Status / Last bill in ONE read.
-- Migration: *_r2876_renewal_row_facts. Self-asserting, ONE transaction, rolled back — LOCAL DB only:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2876_renewal_row_facts.test.sql
--
-- Expect "PASS r2876_renewal_row_facts". RED without the migration (the function does not exist).
--
--   1. shape: read-only (stable), SECURITY INVOKER, executable by authenticated, not by anon / public.
--   2. owner of company A, asking for A's subscriptions: exactly the rows the page's old reads could ask for —
--        s1  own quote QA1 (invoice A1, a credit + a debit note, a received + a refunded payment, a payment on the invoice),
--            renewal quote QR1, add-seats quote QS1
--        s2  billed in parts: part b2 → proforma QP2 (names invoice A2P); the part's own invoice A2, raised from QX
--            (QX is linked to nothing else → comes back with main = false, for its lines only)
--        s3  member of a together quote QT (link) + a RELEASED link to QTOLD (still returned — the page leaves it out)
--        s4  NOT asked for: its renewal quote QN and its billing part never come back
--        s5  made from QA1 too → comes back as a sibling subscription ("covers N subscriptions")
--   3. TENANT ISOLATION: the same owner asking for company B's subscription + quote ids gets NOTHING; and B's rows
--      never ride along when A's and B's ids are asked for together.
--   4. ROLE: a sales user of company A who owns none of the customers gets no invoices and no payments (RLS:
--      invoices_select / payments_select) — the function hands out nothing a plain read would not.
--   5. a signed-out caller (anon) may not call it at all.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2876000-0000-4000-8000-0000000000a1', 'r2876-owner-a@example.test'),
  ('e2876000-0000-4000-8000-0000000000a2', 'r2876-sales-a@example.test'),
  ('e2876000-0000-4000-8000-0000000000b1', 'r2876-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2876000-0000-0000-0000-0000000000a0', 'R2876 A', 'r2876a@example.in', '07', 'R76A'),
  ('e2876000-0000-0000-0000-0000000000b0', 'R2876 B', 'r2876b@example.in', '07', 'R76B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2876000-0000-4000-8000-0000000000a1', 'e2876000-0000-0000-0000-0000000000a0', 'r2876-owner-a@example.in', 'R2876 Owner A', 'owner', true),
  ('e2876000-0000-4000-8000-0000000000a2', 'e2876000-0000-0000-0000-0000000000a0', 'r2876-sales-a@example.in', 'R2876 Sales A', 'sales', true),
  ('e2876000-0000-4000-8000-0000000000b1', 'e2876000-0000-0000-0000-0000000000b0', 'r2876-owner-b@example.in', 'R2876 Owner B', 'owner', true);

-- the customers belong to the OWNER (account manager), so the sales user owns none of them
insert into public.customers (id, tenant_id, name, state_code, country, account_manager_id) values
  ('e2876000-0000-4000-8000-0000000000c1', 'e2876000-0000-0000-0000-0000000000a0', 'R2876 Co A', '07', 'India', 'e2876000-0000-4000-8000-0000000000a1'),
  ('e2876000-0000-4000-8000-0000000000c2', 'e2876000-0000-0000-0000-0000000000b0', 'R2876 Co B', '07', 'India', 'e2876000-0000-4000-8000-0000000000b1');

insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, currency, invoice_id) values
  ('R2876A-QA1',   'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 'accepted', 'invoiced', 118000, 'INR', null),
  ('R2876A-QX',    'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 'accepted', 'invoiced', 118000, 'INR', null),
  ('R2876A-QT',    'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 'sent',     'awaiting', 236000, 'USD', null),
  ('R2876A-QTOLD', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 'sent',     'awaiting', 236000, 'INR', null),
  ('R2876B-QB1',   'e2876000-0000-0000-0000-0000000000b0', 'e2876000-0000-4000-8000-0000000000c2', 'R2876 Co B', 'accepted', 'invoiced', 118000, 'INR', null);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date, term_months, billing_cycle, auto_renew, renewal_state, quote_id) values
  ('e2876000-0000-4000-8000-0000000000d1', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 's1', 'google', 1, 1000, 'active', current_date - 350, current_date + 15, 12, 'yearly',  true, 'pending', 'R2876A-QA1'),
  ('e2876000-0000-4000-8000-0000000000d2', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 's2', 'google', 1, 1000, 'active', current_date - 350, current_date + 15, 12, 'monthly', true, 'pending', null),
  ('e2876000-0000-4000-8000-0000000000d3', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 's3', 'google', 1, 1000, 'active', current_date - 350, current_date + 15, 12, 'yearly',  true, 'pending', null),
  ('e2876000-0000-4000-8000-0000000000d4', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 's4', 'google', 1, 1000, 'active', current_date - 350, current_date + 15, 12, 'monthly', true, 'pending', null),
  ('e2876000-0000-4000-8000-0000000000d5', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 's5', 'google', 1, 1000, 'active', current_date - 350, current_date + 200, 12, 'yearly', true, 'pending', 'R2876A-QA1'),
  ('e2876000-0000-4000-8000-0000000000db', 'e2876000-0000-0000-0000-0000000000b0', 'e2876000-0000-4000-8000-0000000000c2', 'R2876 Co B', 'sb', 'google', 1, 1000, 'active', current_date - 350, current_date + 15, 12, 'monthly', true, 'pending', 'R2876B-QB1');

insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, currency, renewal_subscription_id, add_seats_subscription_id) values
  ('R2876A-QR1', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 'sent', 'awaiting', 118000, 'INR', 'e2876000-0000-4000-8000-0000000000d1', null),
  ('R2876A-QS1', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 'sent', 'awaiting',  11800, 'INR', null, 'e2876000-0000-4000-8000-0000000000d1'),
  ('R2876A-QN',  'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 'sent', 'awaiting', 118000, 'INR', 'e2876000-0000-4000-8000-0000000000d4', null),
  ('R2876B-QR',  'e2876000-0000-0000-0000-0000000000b0', 'e2876000-0000-4000-8000-0000000000c2', 'R2876 Co B', 'sent', 'awaiting', 118000, 'INR', 'e2876000-0000-4000-8000-0000000000db', null);

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount) values
  ('e2876000-0000-4000-8000-0000000000e2', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000d2', current_date - 20, 1, current_date - 20, current_date - 20, current_date + 10, 100000),
  ('e2876000-0000-4000-8000-0000000000e4', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000d4', current_date - 20, 1, current_date - 20, current_date - 20, current_date + 10, 100000),
  ('e2876000-0000-4000-8000-0000000000eb', 'e2876000-0000-0000-0000-0000000000b0', 'e2876000-0000-4000-8000-0000000000db', current_date - 20, 1, current_date - 20, current_date - 20, current_date + 10, 100000);

insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, currency, subscription_billing_id, invoice_id) values
  ('R2876A-QP2', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 'sent', 'awaiting', 118000, 'INR', 'e2876000-0000-4000-8000-0000000000e2', null),
  ('R2876A-QP4', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 'sent', 'awaiting', 118000, 'INR', 'e2876000-0000-4000-8000-0000000000e4', null),
  ('R2876B-QP',  'e2876000-0000-0000-0000-0000000000b0', 'e2876000-0000-4000-8000-0000000000c2', 'R2876 Co B', 'sent', 'awaiting', 118000, 'INR', 'e2876000-0000-4000-8000-0000000000eb', null);

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, quote_id) values
  ('R2876A-INV-A1',  'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 118000, 'pending', 'R2876A-QA1'),
  ('R2876A-INV-A2',  'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 118000, 'pending', 'R2876A-QX'),
  ('R2876A-INV-A2P', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 118000, 'pending', null),
  ('R2876A-INV-QN',  'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 'R2876 Co A', 118000, 'pending', 'R2876A-QN'),
  ('R2876B-INV-B1',  'e2876000-0000-0000-0000-0000000000b0', 'e2876000-0000-4000-8000-0000000000c2', 'R2876 Co B', 118000, 'pending', 'R2876B-QB1');
update public.quotes set invoice_id = 'R2876A-INV-A1' where id = 'R2876A-QA1';
update public.quotes set invoice_id = 'R2876B-INV-B1' where id = 'R2876B-QB1';
update public.quotes set invoice_id = 'R2876A-INV-A2P' where id = 'R2876A-QP2';
update public.subscription_billings set invoice_id = 'R2876A-INV-A2' where id = 'e2876000-0000-4000-8000-0000000000e2';
update public.subscription_billings set invoice_id = 'R2876B-INV-B1' where id = 'e2876000-0000-4000-8000-0000000000eb';

insert into public.renewal_quote_subscriptions (tenant_id, quote_id, subscription_id, renewal_term_date, subtotal, line_no, released_at) values
  ('e2876000-0000-0000-0000-0000000000a0', 'R2876A-QT',    'e2876000-0000-4000-8000-0000000000d3', current_date + 15, 100000, 1, null),
  ('e2876000-0000-0000-0000-0000000000a0', 'R2876A-QTOLD', 'e2876000-0000-4000-8000-0000000000d3', current_date + 15, 100000, 1, now()),
  ('e2876000-0000-0000-0000-0000000000b0', 'R2876B-QR',    'e2876000-0000-4000-8000-0000000000db', current_date + 15, 100000, 1, null);

insert into public.credit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount) values
  ('R2876A-CN1', 'e2876000-0000-0000-0000-0000000000a0', 'R2876A-INV-A1', 11800, 10000, 1800),
  ('R2876A-CNN', 'e2876000-0000-0000-0000-0000000000a0', 'R2876A-INV-QN', 11800, 10000, 1800),
  ('R2876B-CN1', 'e2876000-0000-0000-0000-0000000000b0', 'R2876B-INV-B1', 11800, 10000, 1800);
insert into public.debit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount) values
  ('R2876A-DN1', 'e2876000-0000-0000-0000-0000000000a0', 'R2876A-INV-A1', 5900, 5000, 900),
  ('R2876B-DN1', 'e2876000-0000-0000-0000-0000000000b0', 'R2876B-INV-B1', 5900, 5000, 900);

-- Fixture only: a payment that sits on an invoice alone (no quote) is normally allowed only for an invoice imported from
-- Zoho (tg_payments_opening_invoice); the triggers are skipped for these rolled-back fixture rows, then switched back on.
set local session_replication_role = replica;
insert into public.payments (id, tenant_id, customer_id, amount, method, status, quote_id, invoice_id, reference) values
  ('e2876000-0000-4000-8000-0000000000f1', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 50000, 'bank_transfer', 'received', 'R2876A-QA1', null, 'r2876-on-quote'),
  ('e2876000-0000-4000-8000-0000000000f2', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 20000, 'bank_transfer', 'received', null, 'R2876A-INV-A2P', 'r2876-on-part-invoice'),
  ('e2876000-0000-4000-8000-0000000000f3', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 10000, 'bank_transfer', 'refunded', 'R2876A-QA1', null, 'r2876-refunded'),
  ('e2876000-0000-4000-8000-0000000000f4', 'e2876000-0000-0000-0000-0000000000a0', 'e2876000-0000-4000-8000-0000000000c1', 10000, 'bank_transfer', 'received', 'R2876A-QN', null, 'r2876-not-asked'),
  ('e2876000-0000-4000-8000-0000000000fb', 'e2876000-0000-0000-0000-0000000000b0', 'e2876000-0000-4000-8000-0000000000c2', 50000, 'bank_transfer', 'received', null, 'R2876B-INV-B1', 'r2876-b');
set local session_replication_role = origin;

create temp table r2876_fail (msg text) on commit drop;
grant all on r2876_fail to authenticated, anon, service_role;

create function pg_temp.ids(p jsonb, p_key text) returns text language sql as $f$
  select coalesce(string_agg(coalesce(x->>'id', x #>> '{}'), ',' order by coalesce(x->>'id', x #>> '{}')), '') from jsonb_array_elements(p->p_key) x
$f$;
grant execute on function pg_temp.ids(jsonb, text) to authenticated, anon;

-- 1. shape
do $$
declare v record;
begin
  select p.prosecdef, p.provolatile into v from pg_proc p where p.oid = to_regprocedure('public.renewal_row_facts(uuid[],text[])');
  if v is null then raise exception 'R-2876 1: public.renewal_row_facts(uuid[], text[]) does not exist'; end if;
  if v.prosecdef then insert into r2876_fail values ('1: the function is SECURITY DEFINER — it must be INVOKER so RLS decides'); end if;
  if v.provolatile <> 's' then insert into r2876_fail values ('1: the function is not STABLE (read-only): ' || v.provolatile); end if;
  if not has_function_privilege('authenticated', 'public.renewal_row_facts(uuid[],text[])', 'execute') then insert into r2876_fail values ('1: authenticated may not execute it'); end if;
  if has_function_privilege('anon', 'public.renewal_row_facts(uuid[],text[])', 'execute') then insert into r2876_fail values ('1: anon may execute it'); end if;
end $$;

-- 2 + 3. owner of company A
do $$
declare
  f jsonb;
  v text;
  a_subs uuid[] := array['e2876000-0000-4000-8000-0000000000d1', 'e2876000-0000-4000-8000-0000000000d2', 'e2876000-0000-4000-8000-0000000000d3']::uuid[];
  b_subs uuid[] := array['e2876000-0000-4000-8000-0000000000db']::uuid[];
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2876000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;

  f := public.renewal_row_facts(a_subs, array['R2876A-QA1']);
  v := pg_temp.ids(f, 'quotes');
  if v <> 'R2876A-QA1,R2876A-QP2,R2876A-QR1,R2876A-QS1,R2876A-QT,R2876A-QTOLD,R2876A-QX' then insert into r2876_fail values ('2: quotes = ' || v); end if;
  select string_agg(x->>'id', ',' order by x->>'id') into v from jsonb_array_elements(f->'quotes') x where not (x->>'main')::boolean;
  if v is distinct from 'R2876A-QX' then insert into r2876_fail values ('2: quotes with main = false = ' || coalesce(v, '(none)') || ' (want only R2876A-QX, the quote an invoice came from)'); end if;
  v := pg_temp.ids(f, 'billings');
  if v <> 'e2876000-0000-4000-8000-0000000000e2' then insert into r2876_fail values ('2: billings = ' || v); end if;
  if jsonb_array_length(f->'links') <> 2 then insert into r2876_fail values ('2: links = ' || (f->'links')::text || ' (want the live AND the released link of s3)'); end if;
  v := pg_temp.ids(f, 'invoices');
  if v <> 'R2876A-INV-A1,R2876A-INV-A2,R2876A-INV-A2P' then insert into r2876_fail values ('2: invoices = ' || v); end if;
  v := pg_temp.ids(f, 'invoice_ids');
  if v <> 'R2876A-INV-A1,R2876A-INV-A2,R2876A-INV-A2P' then insert into r2876_fail values ('2: invoice_ids = ' || v); end if;
  v := pg_temp.ids(f, 'credit_notes');
  if v <> 'R2876A-CN1' then insert into r2876_fail values ('2: credit_notes = ' || v); end if;
  v := pg_temp.ids(f, 'debit_notes');
  if v <> 'R2876A-DN1' then insert into r2876_fail values ('2: debit_notes = ' || v); end if;
  v := pg_temp.ids(f, 'subscriptions');
  if v <> 'e2876000-0000-4000-8000-0000000000d1,e2876000-0000-4000-8000-0000000000d5' then insert into r2876_fail values ('2: subscriptions = ' || v); end if;
  v := pg_temp.ids(f, 'payments');
  if v <> 'e2876000-0000-4000-8000-0000000000f1,e2876000-0000-4000-8000-0000000000f2' then insert into r2876_fail values ('2: payments = ' || v || ' (want the received one on the quote and the one on the part invoice; not the refunded one, not s4''s)'); end if;
  -- rows, not totals: the amounts are the stored ones
  if (select (x->>'amount')::int from jsonb_array_elements(f->'credit_notes') x) <> 11800 then insert into r2876_fail values ('2: credit note amount changed'); end if;
  if (select x->>'currency' from jsonb_array_elements(f->'quotes') x where x->>'id' = 'R2876A-QT') <> 'USD' then insert into r2876_fail values ('2: quote currency not returned as stored'); end if;
  -- every column the page's reads select is there
  if not (f->'quotes'->0) ?& array['id','status','payment_status','created_at','created_date','expires_date','invoice_id','renewal_subscription_id','add_seats_subscription_id','subscription_billing_id','superseded_by','revision_of','amount','currency','exchange_rate','line_items','is_renewal','is_extension','is_add_seats','is_one_off','extension_months','renewal_term_date','main'] then insert into r2876_fail values ('2: a quote column is missing: ' || (f->'quotes'->0)::text); end if;
  if not (f->'invoices'->0) ?& array['id','quote_id','invoice_date','status','amount','paid_amount','currency','created_at','due_date','net_payable','adjusted_advances','written_off_at','fx_rate'] then insert into r2876_fail values ('2: an invoice column is missing'); end if;
  if not (f->'billings'->0) ?& array['id','subscription_id','invoice_id','term_start','period_index','due_on','period_start','period_end','taxable_amount'] then insert into r2876_fail values ('2: a billing column is missing'); end if;
  if not (f->'links'->0) ?& array['id','quote_id','subscription_id','renewal_term_date','subtotal','renewed_at','released_at'] then insert into r2876_fail values ('2: a link column is missing'); end if;
  if not (f->'payments'->0) ?& array['id','amount','method','status','received_at','refunded_at','quote_id','invoice_id','receipt_voucher_no','reference'] then insert into r2876_fail values ('2: a payment column is missing'); end if;

  -- 3. tenant isolation: company B's ids, asked by company A's owner
  f := public.renewal_row_facts(b_subs, array['R2876B-QB1', 'R2876B-QR', 'R2876B-QP']);
  if f <> '{"quotes":[],"billings":[],"links":[],"invoices":[],"credit_notes":[],"debit_notes":[],"subscriptions":[],"payments":[],"invoice_ids":[]}'::jsonb then
    insert into r2876_fail values ('3: company A''s owner got rows for company B''s ids: ' || f::text);
  end if;
  f := public.renewal_row_facts(a_subs || b_subs, array['R2876A-QA1', 'R2876B-QB1']);
  if f::text like '%R2876B%' or f::text like '%00000000db%' or f::text like '%00000000eb%' or f::text like '%00000000fb%' then
    insert into r2876_fail values ('3: company B''s rows rode along with company A''s: ' || f::text);
  end if;
  if pg_temp.ids(f, 'quotes') <> 'R2876A-QA1,R2876A-QP2,R2876A-QR1,R2876A-QS1,R2876A-QT,R2876A-QTOLD,R2876A-QX' then insert into r2876_fail values ('3: mixed ask changed company A''s own quotes'); end if;

  -- nothing asked → nothing
  f := public.renewal_row_facts('{}'::uuid[]);
  if jsonb_array_length(f->'quotes') <> 0 or jsonb_array_length(f->'payments') <> 0 then insert into r2876_fail values ('2: empty ask returned rows'); end if;
  reset role;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- 3b. company B's owner sees B's rows for the same call (the fixture is real — isolation, not an empty table)
do $$
declare f jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2876000-0000-4000-8000-0000000000b1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  f := public.renewal_row_facts(array['e2876000-0000-4000-8000-0000000000db']::uuid[], array['R2876B-QB1']);
  if pg_temp.ids(f, 'quotes') <> 'R2876B-QB1,R2876B-QP,R2876B-QR' or pg_temp.ids(f, 'invoices') <> 'R2876B-INV-B1' or jsonb_array_length(f->'payments') <> 1 then
    insert into r2876_fail values ('3b: company B''s owner does not get B''s own rows: ' || f::text);
  end if;
  reset role;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- 4. a sales user who owns none of the customers: no invoices, no payments
do $$
declare f jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2876000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  set local role authenticated;
  if exists (select 1 from public.invoices) or exists (select 1 from public.payments) then
    insert into r2876_fail values ('4: fixture — the sales user can read invoices / payments directly, so this case proves nothing');
  end if;
  f := public.renewal_row_facts(array['e2876000-0000-4000-8000-0000000000d1', 'e2876000-0000-4000-8000-0000000000d2', 'e2876000-0000-4000-8000-0000000000d3']::uuid[], array['R2876A-QA1']);
  if jsonb_array_length(f->'invoices') <> 0 then insert into r2876_fail values ('4: a role without invoice read got invoices: ' || (f->'invoices')::text); end if;
  if jsonb_array_length(f->'payments') <> 0 then insert into r2876_fail values ('4: a role without payment read got payments: ' || (f->'payments')::text); end if;
  -- the billing parts are tenant-readable, as in a plain read
  if pg_temp.ids(f, 'billings') <> 'e2876000-0000-4000-8000-0000000000e2' then insert into r2876_fail values ('4: billings = ' || pg_temp.ids(f, 'billings')); end if;
  reset role;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- 5. signed out
do $$
begin
  set local role anon;
  begin
    perform public.renewal_row_facts(array['e2876000-0000-4000-8000-0000000000d1']::uuid[]);
    insert into r2876_fail values ('5: anon could call the function');
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;
reset role;

do $$
declare v text;
begin
  select string_agg(msg, E'\n') into v from r2876_fail;
  if v is not null then raise exception E'FAIL r2876_renewal_row_facts:\n%', v; end if;
end $$;

select 'PASS r2876_renewal_row_facts';
rollback;
