-- R-454 (P0 SECURITY): the tenant guards of accept_quote, generate_invoice,
-- raise_subscription_billing, next_document_number and next_customer_number fail CLOSED.
-- Migration 20261010190000_tenant_guard_fail_closed. Asserts the LIVE functions.
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/tenant_guard_fail_closed.test.sql
--
-- Expect "PASS tenant_guard_fail_closed". On the old bodies it stops at
-- "FAIL no-company accept_quote: expected 28000, call succeeded" (proved 10 Oct 2026).
--
-- Proves:
--   1. NO COMPANY  — a signed-in user with no public.users row (customer-portal login,
--      apprentice, mid-signup) is refused with SQLSTATE 28000 by all five functions, and
--      nothing changes: the quote stays 'sent', no invoice, no number burnt.
--   2. OTHER COMPANY — a user of company B is refused on company A's rows (as before).
--   3. OWN COMPANY  — company A's owner accepts, invoices, raises an instalment, numbers.
--   4. SERVICE ROLE — the admin client (cron/billing, checkout, webhooks) raises an
--      instalment and allocates numbers for an explicit tenant with no session.
--   5. PUBLIC ACCEPT — /api/public/quote/<id>/accept calls accept_quote through the admin
--      client (service_role, no user): it still accepts and converts the lead.
--   6. DB SESSION   — psql/scripts with no request role at all still work.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e4540000-0000-4000-8000-00000000000a', 'r454-owner-a@example.test'),
  ('e4540000-0000-4000-8000-00000000000b', 'r454-owner-b@example.test'),
  ('e4540000-0000-4000-8000-00000000000f', 'r454-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e4540000-0000-0000-0000-0000000000a1', 'R454 A', 'r454a@example.in', '07', 'R54A'),
  ('e4540000-0000-0000-0000-0000000000b1', 'R454 B', 'r454b@example.in', '07', 'R54B');

-- The no-company user has NO public.users row: current_tenant_id() is NULL for them.
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e4540000-0000-4000-8000-00000000000a', 'e4540000-0000-0000-0000-0000000000a1', 'r454-owner-a@example.in', 'R454 Owner A', 'owner', true),
  ('e4540000-0000-4000-8000-00000000000b', 'e4540000-0000-0000-0000-0000000000b1', 'r454-owner-b@example.in', 'R454 Owner B', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e4540000-0000-4000-8000-0000000000c1', 'e4540000-0000-0000-0000-0000000000a1', 'R454 Cust', '07', 'India');

insert into public.leads (id, tenant_id, company, contact_name, contact_email, stage, source, priority, state_code, state) values
  ('L-R454-1', 'e4540000-0000-0000-0000-0000000000a1', 'R454 Lead One', 'Raj', 'raj@r454.in', 'quote', 'manual', 'medium', '27', 'Maharashtra'),
  ('L-R454-2', 'e4540000-0000-0000-0000-0000000000a1', 'R454 Lead Two', 'Ria', 'ria@r454.in', 'quote', 'manual', 'medium', '27', 'Maharashtra');

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R454-TARGET', 'e4540000-0000-0000-0000-0000000000a1', null, 'e4540000-0000-4000-8000-0000000000c1', 'R454 Cust', 1180, 1000, 18, 'sent', 'none', '[]'::jsonb),
  ('Q-R454-PUBLIC', 'e4540000-0000-0000-0000-0000000000a1', 'L-R454-2', null, 'R454 Lead Two', 1180, 1000, 18, 'sent', 'none', '[]'::jsonb),
  ('Q-R454-INV',    'e4540000-0000-0000-0000-0000000000a1', null, 'e4540000-0000-4000-8000-0000000000c1', 'R454 Cust', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle) values
  ('e4540000-0000-4000-8000-0000000000e1', 'e4540000-0000-0000-0000-0000000000a1', 'e4540000-0000-4000-8000-0000000000c1',
   'R454 Cust', 'Workspace Starter', 'google'::vendor, 2, 1000, 'monthly'::billing_cycle);

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('e4540000-0000-4000-8000-0000000000f' || n)::uuid, 'e4540000-0000-0000-0000-0000000000a1',
       'e4540000-0000-4000-8000-0000000000e1', public.ist_today(), n, public.ist_today(),
       public.ist_today(), public.ist_today() + 29, 1000, 18
  from generate_series(1, 2) n;

/* Runs one call and checks how it ended. want = SQLSTATE expected, or 'ok'. Invoker
   rights, so it runs as whatever role the block below has set. */
create function pg_temp.r454_expect(label text, call text, want text, msg text default null) returns void
language plpgsql as $f$
declare v_state text; v_msg text;
begin
  begin
    execute call;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if want = 'ok' then
      raise exception 'FAIL %: expected success, got % (%)', label, v_state, v_msg;
    elsif (want = 'any' or v_state = want) and (msg is null or v_msg like '%' || msg || '%') then
      raise notice 'ok   %: refused % (%)', label, v_state, left(v_msg, 70);
      return;
    else
      raise exception 'FAIL %: expected % "%", got % (%)', label, want, coalesce(msg, ''), v_state, v_msg;
    end if;
  end;
  if want <> 'ok' then
    raise exception 'FAIL %: expected %, call succeeded', label, want;
  end if;
  raise notice 'ok   %: succeeded', label;
end $f$;
grant execute on function pg_temp.r454_expect(text, text, text, text) to authenticated, service_role;

create temp table r454_series as
  select doc_type, last_number from public.document_series
   where tenant_id = 'e4540000-0000-0000-0000-0000000000a1';
create temp table r454_custseq as
  select last_number from public.customer_number_seq
   where tenant_id = 'e4540000-0000-0000-0000-0000000000a1';

-- ── 1. No company (signed in, current_tenant_id() IS NULL) ───────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e4540000-0000-4000-8000-00000000000f"}', true);
select pg_temp.r454_expect('no-company accept_quote', $$select public.accept_quote('Q-R454-TARGET')$$, '28000', 'can accept it');
select pg_temp.r454_expect('no-company generate_invoice', $$select * from public.generate_invoice('Q-R454-INV')$$, '28000', 'can issue its invoice');
select pg_temp.r454_expect('no-company raise_subscription_billing', $$select * from public.raise_subscription_billing('e4540000-0000-4000-8000-0000000000f1')$$, '28000', 'can raise its invoice');
select pg_temp.r454_expect('no-company next_document_number', $$select public.next_document_number('invoice', 'e4540000-0000-0000-0000-0000000000a1')$$, '28000', 'cannot allocate a document number');
select pg_temp.r454_expect('no-company next_customer_number', $$select public.next_customer_number('e4540000-0000-0000-0000-0000000000a1')$$, '28000', 'cannot allocate a customer number');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select status::text from public.quotes where id = 'Q-R454-TARGET') <> 'sent' then
    raise exception 'FAIL no-company: quote Q-R454-TARGET left ''sent''';
  end if;
  if (select stage::text from public.leads where id = 'L-R454-1') = 'won' then
    raise exception 'FAIL no-company: lead converted';
  end if;
  if exists(select 1 from public.invoices where tenant_id = 'e4540000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL no-company: an invoice was issued';
  end if;
  if exists(select doc_type, last_number from public.document_series where tenant_id = 'e4540000-0000-0000-0000-0000000000a1'
            except select * from r454_series)
     or exists(select last_number from public.customer_number_seq where tenant_id = 'e4540000-0000-0000-0000-0000000000a1'
               except select * from r454_custseq) then
    raise exception 'FAIL no-company: a document/customer number was burnt';
  end if;
  raise notice 'PASS 1 no company: all five refused (28000), nothing changed';
end $$;

-- ── 2. Other company (owner of B on A's rows) ────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e4540000-0000-4000-8000-00000000000b"}', true);
select pg_temp.r454_expect('other-company accept_quote', $$select public.accept_quote('Q-R454-TARGET')$$, 'any');
select pg_temp.r454_expect('other-company generate_invoice', $$select * from public.generate_invoice('Q-R454-INV')$$, '42501');
select pg_temp.r454_expect('other-company raise_subscription_billing', $$select * from public.raise_subscription_billing('e4540000-0000-4000-8000-0000000000f1')$$, '42501');
select pg_temp.r454_expect('other-company next_document_number', $$select public.next_document_number('invoice', 'e4540000-0000-0000-0000-0000000000a1')$$, '42501');
select pg_temp.r454_expect('other-company next_customer_number', $$select public.next_customer_number('e4540000-0000-0000-0000-0000000000a1')$$, '42501');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select status::text from public.quotes where id = 'Q-R454-TARGET') <> 'sent' then
    raise exception 'FAIL other-company: quote Q-R454-TARGET left ''sent''';
  end if;
  raise notice 'PASS 2 other company: all five refused';
end $$;

-- ── 3. Own company (owner of A) ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e4540000-0000-4000-8000-00000000000a"}', true);
select pg_temp.r454_expect('own accept_quote', $$select public.accept_quote('Q-R454-TARGET')$$, 'ok');
select pg_temp.r454_expect('own generate_invoice', $$select * from public.generate_invoice('Q-R454-INV')$$, 'ok');
select pg_temp.r454_expect('own raise_subscription_billing', $$select * from public.raise_subscription_billing('e4540000-0000-4000-8000-0000000000f1')$$, 'ok');
select pg_temp.r454_expect('own next_document_number', $$select public.next_document_number('quote')$$, 'ok');
select pg_temp.r454_expect('own next_customer_number', $$select public.next_customer_number('e4540000-0000-0000-0000-0000000000a1')$$, 'ok');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select status::text from public.quotes where id = 'Q-R454-TARGET') <> 'accepted' then
    raise exception 'FAIL own: quote not accepted';
  end if;
  if (select invoice_id from public.quotes where id = 'Q-R454-INV') is null then
    raise exception 'FAIL own: no invoice on Q-R454-INV';
  end if;
  if (select invoice_id from public.subscription_billings where id = 'e4540000-0000-4000-8000-0000000000f1') is null then
    raise exception 'FAIL own: instalment 1 not raised';
  end if;
  raise notice 'PASS 3 own company: accept, invoice, instalment, numbers all work';
end $$;

-- ── 4 + 5. Service role (admin client: cron/billing, public quote-accept) ────
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.r454_expect('service raise_subscription_billing', $$select * from public.raise_subscription_billing('e4540000-0000-4000-8000-0000000000f2')$$, 'ok');
select pg_temp.r454_expect('service next_document_number(tenant)', $$select public.next_document_number('quote', 'e4540000-0000-0000-0000-0000000000a1')$$, 'ok');
select pg_temp.r454_expect('service next_customer_number(tenant)', $$select public.next_customer_number('e4540000-0000-0000-0000-0000000000a1')$$, 'ok');
select pg_temp.r454_expect('public accept (service) accept_quote', $$select public.accept_quote('Q-R454-PUBLIC')$$, 'ok');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select invoice_id from public.subscription_billings where id = 'e4540000-0000-4000-8000-0000000000f2') is null then
    raise exception 'FAIL service: instalment 2 not raised';
  end if;
  if (select status::text from public.quotes where id = 'Q-R454-PUBLIC') <> 'accepted'
     or (select customer_id from public.quotes where id = 'Q-R454-PUBLIC') is null
     or (select stage::text from public.leads where id = 'L-R454-2') <> 'won' then
    raise exception 'FAIL public accept: quote not accepted / lead not converted';
  end if;
  raise notice 'PASS 4+5 service role + public accept: instalment raised, numbers, lead converted';
end $$;

-- ── 6. Direct DB session (psql, scripts): no request role at all ─────────────
select pg_temp.r454_expect('db-session next_document_number(tenant)', $$select public.next_document_number('invoice', 'e4540000-0000-0000-0000-0000000000a1')$$, 'ok');
select pg_temp.r454_expect('db-session next_customer_number(tenant)', $$select public.next_customer_number('e4540000-0000-0000-0000-0000000000a1')$$, 'ok');

do $$ begin raise notice 'PASS tenant_guard_fail_closed'; end $$;

rollback;
