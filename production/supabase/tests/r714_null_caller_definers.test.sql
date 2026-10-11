\set ON_ERROR_STOP on
-- R-714 (P0 SECURITY): quote/invoice/numbering SECURITY DEFINER functions refuse a
-- "null-caller" (signed-in login with no public.users row → current_tenant_id() NULL) and a
-- member of another company. Migration 20261011030000_r714_null_caller_definers (fixes
-- accept_project_quote + reopen_quote); the other five were fixed by R-454
-- (20261010190000) and are re-asserted here so a future regression is caught.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r714_null_caller_definers.test.sql
--
-- Expect "PASS r714_null_caller_definers". On the old bodies it stops at
-- "FAIL null-caller accept_project_quote: expected 42501, call succeeded" (proved 11 Oct 2026).
--
--   BLOCKED  null-caller on company A's rows — all seven functions; nothing changes
--   BLOCKED  owner of company B on company A's rows — all seven functions
--   ALLOWED  owner of company A on own rows — all seven
--   ALLOWED  service_role (admin client: public project-quote accept, cron, checkout)

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e7140000-0000-4000-8000-00000000000a', 'r714-owner-a@example.test'),
  ('e7140000-0000-4000-8000-00000000000b', 'r714-owner-b@example.test'),
  ('e7140000-0000-4000-8000-00000000000f', 'r714-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e7140000-0000-0000-0000-0000000000a1', 'R714 A', 'r714a@example.in', '07', 'R71A'),
  ('e7140000-0000-0000-0000-0000000000b1', 'R714 B', 'r714b@example.in', '07', 'R71B');

-- The null-caller has NO public.users row.
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e7140000-0000-4000-8000-00000000000a', 'e7140000-0000-0000-0000-0000000000a1', 'r714-owner-a@example.in', 'R714 Owner A', 'owner', true),
  ('e7140000-0000-4000-8000-00000000000b', 'e7140000-0000-0000-0000-0000000000b1', 'r714-owner-b@example.in', 'R714 Owner B', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e7140000-0000-4000-8000-0000000000c1', 'e7140000-0000-0000-0000-0000000000a1', 'R714 Cust', '07', 'India');

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R714-ACCEPT',  'e7140000-0000-0000-0000-0000000000a1', null, 'e7140000-0000-4000-8000-0000000000c1', 'R714 Cust', 1180, 1000, 18, 'sent',     'none',     '[]'::jsonb),
  ('Q-R714-INV',     'e7140000-0000-0000-0000-0000000000a1', null, 'e7140000-0000-4000-8000-0000000000c1', 'R714 Cust', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R714-REOPEN',  'e7140000-0000-0000-0000-0000000000a1', null, 'e7140000-0000-4000-8000-0000000000c1', 'R714 Cust', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R714-REOPEN2', 'e7140000-0000-0000-0000-0000000000a1', null, 'e7140000-0000-4000-8000-0000000000c1', 'R714 Cust', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb);

insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, status) values
  ('e7140000-0000-4000-8000-0000000000d1', 'e7140000-0000-0000-0000-0000000000a1', 'e7140000-0000-4000-8000-0000000000c1', 'R714 Cust', 'R714 Project own',     1000, 180, 1180, 'quoted'),
  ('e7140000-0000-4000-8000-0000000000d2', 'e7140000-0000-0000-0000-0000000000a1', 'e7140000-0000-4000-8000-0000000000c1', 'R714 Cust', 'R714 Project service', 1000, 180, 1180, 'quoted');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle) values
  ('e7140000-0000-4000-8000-0000000000e1', 'e7140000-0000-0000-0000-0000000000a1', 'e7140000-0000-4000-8000-0000000000c1',
   'R714 Cust', 'Workspace Starter', 'google'::vendor, 2, 1000, 'monthly'::billing_cycle);

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('e7140000-0000-4000-8000-0000000000f' || n)::uuid, 'e7140000-0000-0000-0000-0000000000a1',
       'e7140000-0000-4000-8000-0000000000e1', public.ist_today(), n, public.ist_today(),
       public.ist_today(), public.ist_today() + 29, 1000, 18
  from generate_series(1, 2) n;

/* Runs one call and checks how it ended. want = SQLSTATE expected, 'any', or 'ok'. */
create function pg_temp.r714_expect(label text, call text, want text) returns void
language plpgsql as $f$
declare v_state text; v_msg text;
begin
  begin
    execute call;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if want = 'ok' then
      raise exception 'FAIL %: expected success, got % (%)', label, v_state, v_msg;
    elsif want = 'any' or v_state = want then
      raise notice 'ok   %: refused % (%)', label, v_state, left(v_msg, 70);
      return;
    else
      raise exception 'FAIL %: expected %, got % (%)', label, want, v_state, v_msg;
    end if;
  end;
  if want <> 'ok' then
    raise exception 'FAIL %: expected %, call succeeded', label, want;
  end if;
  raise notice 'ok   %: succeeded', label;
end $f$;
grant execute on function pg_temp.r714_expect(text, text, text) to authenticated, service_role;

create temp table r714_series as
  select doc_type, last_number from public.document_series
   where tenant_id = 'e7140000-0000-0000-0000-0000000000a1';
create temp table r714_custseq as
  select last_number from public.customer_number_seq
   where tenant_id = 'e7140000-0000-0000-0000-0000000000a1';

/* Nothing of company A changed. */
create function pg_temp.r714_untouched(label text) returns void language plpgsql as $f$
begin
  if (select status from public.project_sales where id = 'e7140000-0000-4000-8000-0000000000d1') <> 'quoted' then
    raise exception 'FAIL %: project accepted', label;
  end if;
  if exists(select 1 from public.customers where tenant_id = 'e7140000-0000-0000-0000-0000000000a1'
              and id <> 'e7140000-0000-4000-8000-0000000000c1') then
    raise exception 'FAIL %: a customer was created in company A', label;
  end if;
  if (select status::text from public.quotes where id = 'Q-R714-ACCEPT') <> 'sent' then
    raise exception 'FAIL %: quote Q-R714-ACCEPT left ''sent''', label;
  end if;
  if (select status::text from public.quotes where id = 'Q-R714-REOPEN') <> 'accepted' then
    raise exception 'FAIL %: quote Q-R714-REOPEN reopened', label;
  end if;
  if exists(select 1 from public.invoices where tenant_id = 'e7140000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL %: an invoice was issued', label;
  end if;
  if exists(select doc_type, last_number from public.document_series where tenant_id = 'e7140000-0000-0000-0000-0000000000a1'
            except select * from r714_series)
     or exists(select last_number from public.customer_number_seq where tenant_id = 'e7140000-0000-0000-0000-0000000000a1'
               except select * from r714_custseq) then
    raise exception 'FAIL %: a document/customer number was burnt', label;
  end if;
end $f$;

-- ── 1. Null-caller (signed in, no company) ───────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e7140000-0000-4000-8000-00000000000f"}', true);
select pg_temp.r714_expect('null-caller accept_project_quote', $$select public.accept_project_quote('e7140000-0000-4000-8000-0000000000d1')$$, '42501');
select pg_temp.r714_expect('null-caller reopen_quote', $$select public.reopen_quote('Q-R714-REOPEN')$$, '42501');
select pg_temp.r714_expect('null-caller accept_quote', $$select public.accept_quote('Q-R714-ACCEPT')$$, '28000');
select pg_temp.r714_expect('null-caller generate_invoice', $$select * from public.generate_invoice('Q-R714-INV')$$, '28000');
select pg_temp.r714_expect('null-caller raise_subscription_billing', $$select * from public.raise_subscription_billing('e7140000-0000-4000-8000-0000000000f1')$$, '28000');
select pg_temp.r714_expect('null-caller next_document_number', $$select public.next_document_number('invoice', 'e7140000-0000-0000-0000-0000000000a1')$$, '28000');
select pg_temp.r714_expect('null-caller next_customer_number', $$select public.next_customer_number('e7140000-0000-0000-0000-0000000000a1')$$, '28000');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.r714_untouched('null-caller');
do $$ begin raise notice 'PASS 1 null-caller: all seven refused, nothing changed'; end $$;

-- ── 2. Other company (owner of B on A's rows) ────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e7140000-0000-4000-8000-00000000000b"}', true);
select pg_temp.r714_expect('other-company accept_project_quote', $$select public.accept_project_quote('e7140000-0000-4000-8000-0000000000d1')$$, '42501');
select pg_temp.r714_expect('other-company reopen_quote', $$select public.reopen_quote('Q-R714-REOPEN')$$, '42501');
select pg_temp.r714_expect('other-company accept_quote', $$select public.accept_quote('Q-R714-ACCEPT')$$, 'any');
select pg_temp.r714_expect('other-company generate_invoice', $$select * from public.generate_invoice('Q-R714-INV')$$, '42501');
select pg_temp.r714_expect('other-company raise_subscription_billing', $$select * from public.raise_subscription_billing('e7140000-0000-4000-8000-0000000000f1')$$, '42501');
select pg_temp.r714_expect('other-company next_document_number', $$select public.next_document_number('invoice', 'e7140000-0000-0000-0000-0000000000a1')$$, '42501');
select pg_temp.r714_expect('other-company next_customer_number', $$select public.next_customer_number('e7140000-0000-0000-0000-0000000000a1')$$, '42501');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.r714_untouched('other-company');
do $$ begin raise notice 'PASS 2 other company: all seven refused, nothing changed'; end $$;

-- ── 3. Own company (owner of A) ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e7140000-0000-4000-8000-00000000000a"}', true);
select pg_temp.r714_expect('own accept_project_quote', $$select public.accept_project_quote('e7140000-0000-4000-8000-0000000000d1')$$, 'ok');
select pg_temp.r714_expect('own reopen_quote', $$select public.reopen_quote('Q-R714-REOPEN')$$, 'ok');
select pg_temp.r714_expect('own accept_quote', $$select public.accept_quote('Q-R714-ACCEPT')$$, 'ok');
select pg_temp.r714_expect('own generate_invoice', $$select * from public.generate_invoice('Q-R714-INV')$$, 'ok');
select pg_temp.r714_expect('own raise_subscription_billing', $$select * from public.raise_subscription_billing('e7140000-0000-4000-8000-0000000000f1')$$, 'ok');
select pg_temp.r714_expect('own next_document_number', $$select public.next_document_number('quote')$$, 'ok');
select pg_temp.r714_expect('own next_customer_number', $$select public.next_customer_number('e7140000-0000-0000-0000-0000000000a1')$$, 'ok');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select status from public.project_sales where id = 'e7140000-0000-4000-8000-0000000000d1') <> 'active' then
    raise exception 'FAIL own: project not accepted';
  end if;
  if (select status::text from public.quotes where id = 'Q-R714-REOPEN') <> 'sent' then
    raise exception 'FAIL own: quote not reopened';
  end if;
  if (select status::text from public.quotes where id = 'Q-R714-ACCEPT') <> 'accepted' then
    raise exception 'FAIL own: quote not accepted';
  end if;
  if (select invoice_id from public.quotes where id = 'Q-R714-INV') is null then
    raise exception 'FAIL own: no invoice';
  end if;
  if (select invoice_id from public.subscription_billings where id = 'e7140000-0000-4000-8000-0000000000f1') is null then
    raise exception 'FAIL own: instalment 1 not raised';
  end if;
  raise notice 'PASS 3 own company: all seven work';
end $$;

-- ── 4. Service role (admin client: public project-quote accept, cron, checkout) ─
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.r714_expect('service accept_project_quote', $$select public.accept_project_quote('e7140000-0000-4000-8000-0000000000d2')$$, 'ok');
select pg_temp.r714_expect('service reopen_quote', $$select public.reopen_quote('Q-R714-REOPEN2')$$, 'ok');
select pg_temp.r714_expect('service raise_subscription_billing', $$select * from public.raise_subscription_billing('e7140000-0000-4000-8000-0000000000f2')$$, 'ok');
select pg_temp.r714_expect('service next_document_number(tenant)', $$select public.next_document_number('quote', 'e7140000-0000-0000-0000-0000000000a1')$$, 'ok');
select pg_temp.r714_expect('service next_customer_number(tenant)', $$select public.next_customer_number('e7140000-0000-0000-0000-0000000000a1')$$, 'ok');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select status from public.project_sales where id = 'e7140000-0000-4000-8000-0000000000d2') <> 'active' then
    raise exception 'FAIL service: project not accepted';
  end if;
  if (select status::text from public.quotes where id = 'Q-R714-REOPEN2') <> 'sent' then
    raise exception 'FAIL service: quote not reopened';
  end if;
  raise notice 'PASS 4 service role: project accept, reopen, instalment, numbers work';
end $$;

do $$ begin raise notice 'PASS r714_null_caller_definers'; end $$;

rollback;
