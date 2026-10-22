\set ON_ERROR_STOP on
-- R-1762: a mistaken Won deal can be undone, but never one with money behind it.
-- Migration 20261022120019_r1762_won_deal_undo. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1762_won_deal_undo.test.sql
--
-- Expect "PASS r1762_won_deal_undo". On the old database it stops at
-- "FAIL 1 reopen: deal still won" (reopen_quote moved only the quote).
--
--   1. Reopen an accepted quote with no money → quote Sent, deal back to Quote, timeline line.
--   2. Won → Lost with no money → allowed; the accepted quote is Rejected with the lost reason.
--   3. Won → Lost with a received payment → refused with "<name> has a payment or invoice".
--   4. Reopen one quote while another quote of the same deal is paid → the deal stays Won.
--   5. lead_has_money: own company answers, another company / no company refused (42501).
--   6. The Won count drops by the two undone deals.
--   7. (follow-up 22 Oct) Mark accepted AGAIN after Reopen → the deal is Won again
--      (accept_quote set Won only when it converted the lead; the quote keeps its customer).
--   8. (follow-up) Mark lost from Quote with an accepted quote and no money → quote Rejected.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1762000-0000-4000-8000-00000000000a', 'r1762-owner-a@example.test'),
  ('e1762000-0000-4000-8000-00000000000b', 'r1762-owner-b@example.test'),
  ('e1762000-0000-4000-8000-00000000000f', 'r1762-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1762000-0000-0000-0000-0000000000a1', 'R1762 A', 'r1762a@example.in', '07', 'R76A'),
  ('e1762000-0000-0000-0000-0000000000b1', 'R1762 B', 'r1762b@example.in', '07', 'R76B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1762000-0000-4000-8000-00000000000a', 'e1762000-0000-0000-0000-0000000000a1', 'r1762-owner-a@example.in', 'R1762 Owner A', 'owner', true),
  ('e1762000-0000-4000-8000-00000000000b', 'e1762000-0000-0000-0000-0000000000b1', 'r1762-owner-b@example.in', 'R1762 Owner B', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1762000-0000-4000-8000-0000000000c1', 'e1762000-0000-0000-0000-0000000000a1', 'R1762 Cust', '07', 'India');

-- Four Won deals, the shape the owner has: lead → quote → Mark accepted → Won.
insert into public.leads (id, tenant_id, company, stage, value, customer_id) values
  ('L-R1762-MISTAKE', 'e1762000-0000-0000-0000-0000000000a1', 'Mistake Co',   'won', 10000, 'e1762000-0000-4000-8000-0000000000c1'),
  ('L-R1762-BACKOUT', 'e1762000-0000-0000-0000-0000000000a1', 'Backout Co',   'won', 10000, 'e1762000-0000-4000-8000-0000000000c1'),
  ('L-R1762-PAID',    'e1762000-0000-0000-0000-0000000000a1', 'Paid Co',      'won', 10000, 'e1762000-0000-4000-8000-0000000000c1'),
  ('L-R1762-UPSELL',  'e1762000-0000-0000-0000-0000000000a1', 'Upsell Co',    'won', 10000, 'e1762000-0000-4000-8000-0000000000c1'),
  ('L-R1762-OPEN',    'e1762000-0000-0000-0000-0000000000a1', 'Open Co',      'quote', 10000, 'e1762000-0000-4000-8000-0000000000c1');

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R1762-MISTAKE', 'e1762000-0000-0000-0000-0000000000a1', 'L-R1762-MISTAKE', 'e1762000-0000-4000-8000-0000000000c1', 'R1762 Cust', 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1762-BACKOUT', 'e1762000-0000-0000-0000-0000000000a1', 'L-R1762-BACKOUT', 'e1762000-0000-4000-8000-0000000000c1', 'R1762 Cust', 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1762-PAID',    'e1762000-0000-0000-0000-0000000000a1', 'L-R1762-PAID',    'e1762000-0000-4000-8000-0000000000c1', 'R1762 Cust', 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1762-UP-PAID', 'e1762000-0000-0000-0000-0000000000a1', 'L-R1762-UPSELL',  'e1762000-0000-4000-8000-0000000000c1', 'R1762 Cust', 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1762-UP-NEW',  'e1762000-0000-0000-0000-0000000000a1', 'L-R1762-UPSELL',  'e1762000-0000-4000-8000-0000000000c1', 'R1762 Cust', 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1762-OPEN',    'e1762000-0000-0000-0000-0000000000a1', 'L-R1762-OPEN',    'e1762000-0000-4000-8000-0000000000c1', 'R1762 Cust', 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb);

-- Money on two of them (a received payment — the trigger-free way the tests elsewhere do it).
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at) values
  (gen_random_uuid(), 'e1762000-0000-0000-0000-0000000000a1', 'Q-R1762-PAID',    'e1762000-0000-4000-8000-0000000000c1', 11800, 'upi', 'received', now(), now()),
  (gen_random_uuid(), 'e1762000-0000-0000-0000-0000000000a1', 'Q-R1762-UP-PAID', 'e1762000-0000-4000-8000-0000000000c1', 11800, 'upi', 'received', now(), now());
-- Recording a payment may move the deal on its own; the case under test is "Won with money".
update public.leads set stage = 'won' where id in ('L-R1762-PAID', 'L-R1762-UPSELL') and stage <> 'won';

/* want = SQLSTATE expected or 'ok'; msg = text the refusal must contain. */
create function pg_temp.r1762_expect(label text, call text, want text, msg text default null) returns void
language plpgsql as $f$
declare v_state text; v_msg text;
begin
  begin
    execute call;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if want = 'ok' then
      raise exception 'FAIL %: expected success, got % (%)', label, v_state, v_msg;
    elsif v_state = want and (msg is null or position(msg in v_msg) > 0) then
      raise notice 'ok   %: refused % (%)', label, v_state, left(v_msg, 90);
      return;
    else
      raise exception 'FAIL %: expected % "%", got % (%)', label, want, msg, v_state, v_msg;
    end if;
  end;
  if want <> 'ok' then
    raise exception 'FAIL %: expected %, call succeeded', label, want;
  end if;
  raise notice 'ok   %: succeeded', label;
end $f$;
grant execute on function pg_temp.r1762_expect(text, text, text, text) to authenticated;

-- ── As the owner of company A, through RLS, like the app ─────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e1762000-0000-4000-8000-00000000000a"}', true);

-- 1. Reopen the mistaken accept.
select pg_temp.r1762_expect('1 reopen no money', $$select public.reopen_quote('Q-R1762-MISTAKE')$$, 'ok');
do $$
begin
  if (select status::text from public.quotes where id = 'Q-R1762-MISTAKE') <> 'sent' then
    raise exception 'FAIL 1 reopen: quote not back to sent';
  end if;
  if (select stage::text from public.leads where id = 'L-R1762-MISTAKE') <> 'quote' then
    raise exception 'FAIL 1 reopen: deal still % — reopen moved only the quote',
      (select stage from public.leads where id = 'L-R1762-MISTAKE');
  end if;
  if not exists (select 1 from public.lead_activities
                  where lead_id = 'L-R1762-MISTAKE' and kind = 'stage' and detail like 'Accept undone — quote Q-R1762-MISTAKE reopened%') then
    raise exception 'FAIL 1 reopen: no "Accept undone" timeline line';
  end if;
  if (select customer_id from public.leads where id = 'L-R1762-MISTAKE') is distinct from 'e1762000-0000-4000-8000-0000000000c1' then
    raise exception 'FAIL 1 reopen: the customer link was dropped';
  end if;
  raise notice 'PASS 1 reopen → quote Sent, deal Quote, timeline line, customer kept';
end $$;

-- 2. Won → Lost without money.
select pg_temp.r1762_expect('2 won→lost no money',
  $$update public.leads set stage = 'lost', lost_reason = 'price', lost_note = 'Customer backed out', lost_at = now() where id = 'L-R1762-BACKOUT'$$, 'ok');
do $$
declare q record;
begin
  if (select stage::text from public.leads where id = 'L-R1762-BACKOUT') <> 'lost' then
    raise exception 'FAIL 2: deal not lost (RLS hid the row?)';
  end if;
  select status::text as status, payment_status::text as pay, rejected_reason, rejected_note into q
    from public.quotes where id = 'Q-R1762-BACKOUT';
  if q.status <> 'rejected' or q.pay <> 'none' or q.rejected_reason is distinct from 'price'
     or q.rejected_note is distinct from 'Customer backed out' then
    raise exception 'FAIL 2: accepted quote not rejected with the lost reason (%, %, %, %)', q.status, q.pay, q.rejected_reason, q.rejected_note;
  end if;
  if not exists (select 1 from public.lead_activities
                  where lead_id = 'L-R1762-BACKOUT' and detail = 'Won undone — marked Lost; quote Q-R1762-BACKOUT rejected') then
    raise exception 'FAIL 2: no "Won undone" timeline line';
  end if;
  raise notice 'PASS 2 won → lost without money; quote rejected with the reason';
end $$;

-- 3. Won → Lost (and Won → anything) with money is refused, by the database.
select pg_temp.r1762_expect('3 won→lost with payment',
  $$update public.leads set stage = 'lost', lost_reason = 'price' where id = 'L-R1762-PAID'$$,
  '23514', 'Paid Co has a payment or invoice — refund or credit-note it first, then mark it lost.');
select pg_temp.r1762_expect('3 won→quote with payment',
  $$update public.leads set stage = 'quote' where id = 'L-R1762-PAID'$$, '23514', 'has a payment or invoice');
do $$
begin
  if (select stage::text from public.leads where id = 'L-R1762-PAID') <> 'won'
     or (select status::text from public.quotes where id = 'Q-R1762-PAID') <> 'accepted' then
    raise exception 'FAIL 3: the paid deal or its quote changed';
  end if;
  if not public.lead_has_money('L-R1762-PAID') or public.lead_has_money('L-R1762-MISTAKE') then
    raise exception 'FAIL 3: lead_has_money wrong (paid %, mistake %)',
      public.lead_has_money('L-R1762-PAID'), public.lead_has_money('L-R1762-MISTAKE');
  end if;
  raise notice 'PASS 3 paid Won deal stays Won; lead_has_money true/false right';
end $$;

-- 4. Reopen the unpaid quote of a deal whose other quote is paid — deal stays Won.
select pg_temp.r1762_expect('4 reopen unpaid upsell', $$select public.reopen_quote('Q-R1762-UP-NEW')$$, 'ok');
do $$
begin
  if (select status::text from public.quotes where id = 'Q-R1762-UP-NEW') <> 'sent' then
    raise exception 'FAIL 4: upsell quote not reopened';
  end if;
  if (select stage::text from public.leads where id = 'L-R1762-UPSELL') <> 'won' then
    raise exception 'FAIL 4: a paid deal left Won through Reopen';
  end if;
  raise notice 'PASS 4 reopen on a paid deal keeps it Won';
end $$;

-- 6. Won count for company A: 4 → 2.
do $$
begin
  if (select count(*) from public.leads where tenant_id = 'e1762000-0000-0000-0000-0000000000a1' and stage = 'won') <> 2 then
    raise exception 'FAIL 6: won count is %, expected 2',
      (select count(*) from public.leads where tenant_id = 'e1762000-0000-0000-0000-0000000000a1' and stage = 'won');
  end if;
  raise notice 'PASS 6 won count dropped from 4 to 2';
end $$;

-- 7. Mark accepted again after the Reopen in step 1 (the quote kept its customer).
select pg_temp.r1762_expect('7 re-accept after reopen', $$select public.accept_quote('Q-R1762-MISTAKE')$$, 'ok');
do $$
begin
  if (select status::text from public.quotes where id = 'Q-R1762-MISTAKE') <> 'accepted' then
    raise exception 'FAIL 7: quote not accepted again';
  end if;
  if (select stage::text from public.leads where id = 'L-R1762-MISTAKE') <> 'won' then
    raise exception 'FAIL 7 re-accept: deal stayed % — accept_quote set Won only when converting the lead',
      (select stage from public.leads where id = 'L-R1762-MISTAKE');
  end if;
  raise notice 'PASS 7 reopen → accept again → deal Won again';
end $$;

-- 8. Mark lost from Quote with an accepted quote and no money.
select pg_temp.r1762_expect('8 quote→lost with accepted quote',
  $$update public.leads set stage = 'lost', lost_reason = 'timing', lost_note = 'Next year', lost_at = now() where id = 'L-R1762-OPEN'$$, 'ok');
do $$
declare q record;
begin
  select status::text as status, payment_status::text as pay, rejected_reason, rejected_note into q
    from public.quotes where id = 'Q-R1762-OPEN';
  if q.status <> 'rejected' or q.pay <> 'none' or q.rejected_reason is distinct from 'timing'
     or q.rejected_note is distinct from 'Next year' then
    raise exception 'FAIL 8: accepted quote left on a lost deal (%, %, %, %)', q.status, q.pay, q.rejected_reason, q.rejected_note;
  end if;
  if not exists (select 1 from public.lead_activities
                  where lead_id = 'L-R1762-OPEN' and detail = 'Marked Lost; accepted quote Q-R1762-OPEN rejected') then
    raise exception 'FAIL 8: no "Marked Lost" timeline line';
  end if;
  raise notice 'PASS 8 quote → lost rejects the accepted quote with the reason';
end $$;

-- 5. Another company, and a login with no company.
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e1762000-0000-4000-8000-00000000000b"}', true);
select pg_temp.r1762_expect('5 other company lead_has_money', $$select public.lead_has_money('L-R1762-PAID')$$, '42501');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e1762000-0000-4000-8000-00000000000f"}', true);
select pg_temp.r1762_expect('5 no-company lead_has_money', $$select public.lead_has_money('L-R1762-PAID')$$, '42501');
select pg_temp.r1762_expect('5 app role cannot call the raw rule', $$select public.r1762_lead_money('L-R1762-PAID')$$, '42501');
reset role;
select set_config('request.jwt.claims', '', true);

do $$ begin raise notice 'PASS r1762_won_deal_undo'; end $$;

rollback;
