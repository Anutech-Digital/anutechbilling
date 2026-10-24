\set ON_ERROR_STOP on
-- R-1574 (P1 money): a renewal quote is made AND linked to its subscription in one transaction,
-- once per subscription term; paying a renewal quote that lost its link still renews the
-- subscription it was made for, and a quote for a term already renewed is refused, never a
-- second subscription.
-- Migration: 20261018162355_r1574_renewal_quote_once (create_renewal_quote, quotes
-- renewal_subscription_id/renewal_term_date + unique index, record_payment fallback).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1574_renewal_quote_once.test.sql
--
-- Expect "PASS r1574_renewal_quote_once". Every check is collected and failures listed together.
--
--   ONCE      two calls for one subscription → ONE quote, linked, second returns it (created=false)
--   RELINK    link cleared → the next call links the SAME quote again, makes none
--   UNIQUE    a second quote for the same subscription term cannot be stored at all
--   LOST LINK paying the term's quote while the subscription points elsewhere → that
--             subscription renews (+12 months), no new subscription, renewal_link_lost = true
--   STALE     a quote for a term already renewed → first payment refused with the next step,
--             nothing recorded, no new subscription
--   LINKED    the normal linked renewal still rolls forward (regression)
--   REFUSED   another company's user; signed-in user with no company; sales role; service
--             caller naming the wrong company; a quote with no price — each makes nothing
--   ALLOWED   a billing user of the same company

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1574000-0000-4000-8000-0000000000a2', 'r1574-billing@example.test'),
  ('e1574000-0000-4000-8000-0000000000a3', 'r1574-sales@example.test'),
  ('e1574000-0000-4000-8000-0000000000b1', 'r1574-owner-b@example.test'),
  ('e1574000-0000-4000-8000-0000000000d9', 'r1574-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1574000-0000-0000-0000-0000000000a0', 'R1574 A', 'r1574a@example.in', '07', 'R174A'),
  ('e1574000-0000-0000-0000-0000000000b0', 'R1574 B', 'r1574b@example.in', '07', 'R174B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1574000-0000-4000-8000-0000000000a2', 'e1574000-0000-0000-0000-0000000000a0', 'r1574-billing@example.in', 'R1574 Billing', 'billing', true),
  ('e1574000-0000-4000-8000-0000000000a3', 'e1574000-0000-0000-0000-0000000000a0', 'r1574-sales@example.in',   'R1574 Sales',   'sales',   true),
  ('e1574000-0000-4000-8000-0000000000b1', 'e1574000-0000-0000-0000-0000000000b0', 'r1574-owner-b@example.in', 'R1574 Owner B', 'owner',   true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1574000-0000-4000-8000-0000000000c1', 'e1574000-0000-0000-0000-0000000000a0', 'R1574 Cust', '07', 'India');

-- e1: ONCE / RELINK / UNIQUE / LOST LINK   e2: STALE   e3: LINKED   e4: refusals / billing user
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, renewal_date, start_date, status)
select ('e1574000-0000-4000-8000-0000000000e' || n)::uuid, 'e1574000-0000-0000-0000-0000000000a0',
       'e1574000-0000-4000-8000-0000000000c1', 'R1574 Cust', 'Workspace Starter', 'google'::vendor,
       2, 300, 12, date '2026-11-01', date '2025-11-01', 'active'
  from generate_series(1, 4) n;

create temp table r1574_fail (msg text) on commit drop;
grant all on r1574_fail to authenticated;

-- The quote the TypeScript helpers price and hand over: 2 seats × ₹3,600 = ₹7,200 + 18%.
create function pg_temp.r1574_q() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'customer_name', 'R1574 Cust', 'plan', 'Workspace Starter', 'seats', 2,
    'amount', 8496, 'subtotal', 7200, 'total_cost', 2640, 'tax_rate', 18,
    'created_date', '2026-10-18', 'expires_date', '2026-11-08', 'extension_months', 12,
    'notes', 'Renewal quote (R-1574 test)',
    'line_items', '[{"id":"renewal-1","name":"Workspace Starter","qty":2,"rate":3600,"cost":1320,"commitment":"annual_yearly"}]'::jsonb)
$$;
-- returns null on success, else 'SQLSTATE: message'
create function pg_temp.r1574_try(p_sub uuid, p_tenant uuid, p_q jsonb) returns text language plpgsql as $$
begin
  perform public.create_renewal_quote(p_sub, p_tenant, p_q);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r1574_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r1574_q() to authenticated;
grant execute on function pg_temp.r1574_try(uuid, uuid, jsonb) to authenticated;
grant execute on function pg_temp.r1574_as(text) to authenticated;

do $$
declare
  c_a   constant uuid := 'e1574000-0000-0000-0000-0000000000a0';
  c_b   constant uuid := 'e1574000-0000-0000-0000-0000000000b0';
  c_e1  constant uuid := 'e1574000-0000-4000-8000-0000000000e1';
  c_e2  constant uuid := 'e1574000-0000-4000-8000-0000000000e2';
  c_e3  constant uuid := 'e1574000-0000-4000-8000-0000000000e3';
  c_e4  constant uuid := 'e1574000-0000-4000-8000-0000000000e4';
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_p jsonb; v_e text; v_n int; v_d date; v_link text; v_subs int;
begin
  -- ── ONCE ───────────────────────────────────────────────────────────────
  v_r1 := public.create_renewal_quote(c_e1, c_a, pg_temp.r1574_q());
  v_r2 := public.create_renewal_quote(c_e1, c_a, pg_temp.r1574_q());
  if not (v_r1->>'created')::boolean then insert into r1574_fail values ('ONCE: first call did not create'); end if;
  if (v_r2->>'created')::boolean or (v_r2->>'relinked')::boolean then insert into r1574_fail values ('ONCE: second call created another quote'); end if;
  if v_r1->>'quote_id' is distinct from v_r2->>'quote_id' then
    insert into r1574_fail values ('ONCE: two different quotes ' || (v_r1->>'quote_id') || ' / ' || (v_r2->>'quote_id'));
  end if;
  select count(*) into v_n from public.quotes where renewal_subscription_id = c_e1;
  if v_n <> 1 then insert into r1574_fail values ('ONCE: ' || v_n || ' quotes for the subscription, want 1'); end if;
  select renewal_quote_id into v_link from public.subscriptions where id = c_e1;
  if v_link is distinct from v_r1->>'quote_id' then insert into r1574_fail values ('ONCE: subscription not linked: ' || coalesce(v_link, 'null')); end if;
  select count(*) into v_n from public.quotes
   where id = v_r1->>'quote_id' and tenant_id = c_a and is_renewal and status = 'sent' and payment_status = 'awaiting'
     and amount = 8496 and subtotal = 7200 and tax_rate = 18 and extension_months = 12
     and renewal_term_date = date '2026-11-01' and customer_id = 'e1574000-0000-4000-8000-0000000000c1'
     and id like 'Q-R174-%';   -- the company's own quote series (next_document_number)
  if v_n <> 1 then insert into r1574_fail values ('ONCE: quote fields/number not as handed over'); end if;

  -- ── RELINK ─────────────────────────────────────────────────────────────
  update public.subscriptions set renewal_quote_id = null where id = c_e1;
  v_r3 := public.create_renewal_quote(c_e1, c_a, pg_temp.r1574_q());
  if (v_r3->>'created')::boolean or not (v_r3->>'relinked')::boolean or v_r3->>'quote_id' is distinct from v_r1->>'quote_id' then
    insert into r1574_fail values ('RELINK: ' || v_r3::text);
  end if;
  select renewal_quote_id into v_link from public.subscriptions where id = c_e1;
  if v_link is distinct from v_r1->>'quote_id' then insert into r1574_fail values ('RELINK: not linked again'); end if;

  -- ── UNIQUE ─────────────────────────────────────────────────────────────
  begin
    insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, status, is_renewal, renewal_subscription_id, renewal_term_date)
      values ('Q-R1574-DUP', c_a, 'R1574 Cust', 8496, 7200, 'sent', true, c_e1, date '2026-11-01');
    insert into r1574_fail values ('UNIQUE: a second quote for the same term was stored');
  exception when unique_violation then null;
  end;

  -- ── LOST LINK: the subscription points at another (extension-style) quote ─
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, is_renewal, line_items)
    values ('Q-R1574-OTHER', c_a, 'e1574000-0000-4000-8000-0000000000c1', 'R1574 Cust', 8496, 7200, 18, 'sent', 'awaiting', true, '[]'::jsonb);
  update public.subscriptions set renewal_quote_id = 'Q-R1574-OTHER' where id = c_e1;
  select count(*) into v_subs from public.subscriptions where tenant_id = c_a;
  v_p := public.record_payment(v_r1->>'quote_id', 8496, 'upi', 'r1574-lost-link');
  select renewal_date into v_d from public.subscriptions where id = c_e1;
  if v_d is distinct from date '2027-11-01' then insert into r1574_fail values ('LOST LINK: renewal_date ' || coalesce(v_d::text, 'null') || ', want 2027-11-01'); end if;
  select count(*) into v_n from public.subscriptions where tenant_id = c_a;
  if v_n <> v_subs then insert into r1574_fail values ('LOST LINK: a new subscription was created (' || v_subs || ' → ' || v_n || ')'); end if;
  if not coalesce((v_p->>'is_renewal_quote')::boolean, false) or not coalesce((v_p->>'renewal_link_lost')::boolean, false)
     or not coalesce((v_p->>'renewal_rolled_forward')::boolean, false) then
    insert into r1574_fail values ('LOST LINK: result ' || v_p::text);
  end if;
  -- the next term gets its own quote (new term date → no clash with the paid one)
  v_r3 := public.create_renewal_quote(c_e1, c_a, pg_temp.r1574_q());
  if not (v_r3->>'created')::boolean or v_r3->>'quote_id' = v_r1->>'quote_id' then
    insert into r1574_fail values ('NEXT TERM: no fresh quote: ' || v_r3::text);
  end if;
  -- a further payment on the quote already paid is NOT refused (old behaviour: recorded, no roll)
  begin
    perform public.record_payment(v_r1->>'quote_id', 100, 'upi', 'r1574-extra');
  exception when others then
    insert into r1574_fail values ('LOST LINK: an extra payment on the paid quote was refused: ' || sqlerrm);
  end;
  select renewal_date into v_d from public.subscriptions where id = c_e1;
  if v_d is distinct from date '2027-11-01' then insert into r1574_fail values ('LOST LINK: extra payment moved the date to ' || v_d); end if;

  -- ── STALE: term renewed by something else since the quote was made ─────
  v_r1 := public.create_renewal_quote(c_e2, c_a, pg_temp.r1574_q());
  update public.subscriptions set renewal_date = date '2027-11-01', renewal_quote_id = null where id = c_e2;
  select count(*) into v_subs from public.subscriptions where tenant_id = c_a;
  begin
    perform public.record_payment(v_r1->>'quote_id', 8496, 'upi', 'r1574-stale');
    insert into r1574_fail values ('STALE: payment on a renewed term was accepted');
  exception when others then
    if sqlerrm not like '%already renewed%' or sqlerrm not like '%Nothing was recorded%' or sqlerrm not like '%Open the subscription%' then
      insert into r1574_fail values ('STALE: message without the next step: ' || sqlerrm);
    end if;
  end;
  select count(*) into v_n from public.payments where quote_id = v_r1->>'quote_id';
  if v_n <> 0 then insert into r1574_fail values ('STALE: a payment row was left'); end if;
  select count(*) into v_n from public.subscriptions where tenant_id = c_a;
  if v_n <> v_subs then insert into r1574_fail values ('STALE: a new subscription was created'); end if;

  -- ── LINKED: the normal renewal still rolls forward ─────────────────────
  v_r1 := public.create_renewal_quote(c_e3, c_a, pg_temp.r1574_q());
  v_p := public.record_payment(v_r1->>'quote_id', 8496, 'upi', 'r1574-linked');
  select renewal_date, renewal_quote_id into v_d, v_link from public.subscriptions where id = c_e3;
  if v_d is distinct from date '2027-11-01' or v_link is not null or coalesce((v_p->>'renewal_link_lost')::boolean, true) then
    insert into r1574_fail values ('LINKED: ' || coalesce(v_d::text, 'null') || ' / ' || coalesce(v_link, 'null') || ' / ' || v_p::text);
  end if;

  -- ── REFUSED: service caller naming the wrong company; no price ─────────
  v_e := pg_temp.r1574_try(c_e4, c_b, pg_temp.r1574_q());
  if v_e is null or v_e not like '42501:%another company%' then insert into r1574_fail values ('wrong p_tenant_id not refused: ' || coalesce(v_e, 'accepted')); end if;
  v_e := pg_temp.r1574_try(c_e4, c_a, pg_temp.r1574_q() || '{"amount": 0}');
  if v_e is null or v_e not like '22023:%no price%' then insert into r1574_fail values ('zero amount not refused: ' || coalesce(v_e, 'accepted')); end if;
  v_e := pg_temp.r1574_try(c_e4, c_a, pg_temp.r1574_q() || '{"line_items": []}');
  if v_e is null or v_e not like '22023:%no line%' then insert into r1574_fail values ('no lines not refused: ' || coalesce(v_e, 'accepted')); end if;

  -- ── REFUSED / ALLOWED as signed-in users ───────────────────────────────
  set local role authenticated;
  perform pg_temp.r1574_as('e1574000-0000-4000-8000-0000000000b1');   -- owner of company B
  v_e := pg_temp.r1574_try(c_e4, c_a, pg_temp.r1574_q());
  if v_e is null or v_e not like '42501:%another company%' then insert into r1574_fail values ('other company owner not refused: ' || coalesce(v_e, 'accepted')); end if;
  perform pg_temp.r1574_as('e1574000-0000-4000-8000-0000000000d9');   -- no company (NULL tenant)
  v_e := pg_temp.r1574_try(c_e4, c_a, pg_temp.r1574_q());
  -- this function's OWN guard (§17c), not the nested next_document_number one
  if v_e is null or v_e not like '28000:%generate the renewal quote%' then insert into r1574_fail values ('no-company user not refused: ' || coalesce(v_e, 'accepted')); end if;
  perform pg_temp.r1574_as('e1574000-0000-4000-8000-0000000000a3');   -- sales, company A
  v_e := pg_temp.r1574_try(c_e4, c_a, pg_temp.r1574_q());
  if v_e is null or v_e not like '42501:%Only an owner%' then insert into r1574_fail values ('sales user not refused: ' || coalesce(v_e, 'accepted')); end if;
  set local role postgres;
  select count(*) into v_n from public.quotes where renewal_subscription_id = c_e4;
  if v_n <> 0 then insert into r1574_fail values ('a refused call left ' || v_n || ' quote(s)'); end if;

  set local role authenticated;
  perform pg_temp.r1574_as('e1574000-0000-4000-8000-0000000000a2');   -- billing, company A
  v_e := pg_temp.r1574_try(c_e4, c_a, pg_temp.r1574_q());
  if v_e is not null then insert into r1574_fail values ('billing user refused: ' || v_e); end if;
  set local role postgres;
  select count(*) into v_n from public.quotes q join public.subscriptions s on s.renewal_quote_id = q.id
   where q.renewal_subscription_id = c_e4 and s.id = c_e4;
  if v_n <> 1 then insert into r1574_fail values ('billing user: quote not made + linked'); end if;
end $$;

select set_config('request.jwt.claims', '', true);
do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  ') into v_msgs from r1574_fail;
  if v_msgs is not null then raise exception E'FAIL r1574_renewal_quote_once:\n  %', v_msgs; end if;
  raise notice 'PASS r1574_renewal_quote_once';
end $$;

rollback;
