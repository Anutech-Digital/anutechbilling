-- R-1684: "Correct details" changes seats / plan / price only through correct_subscription_terms —
-- reason required, seat cut / plan change = owner or manager, plan from the catalog, and the reason
-- lands on the amendment row. Migration 20261024030954_r1684_correct_subscription_terms.
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1684_correct_subscription.test.sql
--
-- Before the migration is applied: strip the migration's begin/commit and this file's
-- begin/rollback and pipe  begin; <migration> <this test> rollback;  — expect "PASS r1684".
-- Without the migration it FAILs at step 1 (no such function).
--
-- Proves:
--   1. a billing user cannot cut seats (42501) — the row stays 15 seats;
--   2. the owner without a reason is refused (22023);
--   3. a plan that is not an active catalog row of this company is refused (22023) — another
--      company's item, and free text has no way in at all (the RPC takes an item id);
--   4. the owner cuts 15 → 10 seats with MRR 16,200 → 10,800 and a reason: row updated, ONE
--      amendment row with seats 15→10, mrr 16200→10800 and note = the reason;
--   5. the owner picks the Plus catalog row: plan = the row's name, item_id = its id;
--   6. a billing user may correct the price only (with a reason); nothing changed = no write;
--   7. a plain table update afterwards gets note null (the setting is transaction-local and
--      cleared) — the ledger never carries a stale reason.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1684000-0000-4000-8000-00000000000a', 'r1684-owner@example.test'),
  ('e1684000-0000-4000-8000-00000000000b', 'r1684-billing@example.test');

insert into public.tenants (id, name, email, state_code, state, doc_code) values
  ('e1684000-0000-0000-0000-0000000000a1', 'R1684 Co',    'r1684@example.in',  '07', 'Delhi', 'R84A'),
  ('e1684000-0000-0000-0000-0000000000b1', 'R1684 Other', 'r1684o@example.in', '07', 'Delhi', 'R84B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1684000-0000-4000-8000-00000000000a', 'e1684000-0000-0000-0000-0000000000a1', 'r1684-owner@example.in',   'R1684 Owner',   'owner',   true),
  ('e1684000-0000-4000-8000-00000000000b', 'e1684000-0000-0000-0000-0000000000a1', 'r1684-billing@example.in', 'R1684 Billing', 'billing', true);

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('R1684-STD',  'e1684000-0000-0000-0000-0000000000a1', 'R1684 Workspace Standard', 'google', 864,  620),
  ('R1684-PLUS', 'e1684000-0000-0000-0000-0000000000a1', 'R1684 Workspace Plus',     'google', 1380, 1150),
  ('R1684-OTH',  'e1684000-0000-0000-0000-0000000000b1', 'R1684 Other Co Plan',      'google', 100,  50);

insert into public.subscriptions (id, tenant_id, customer_name, plan, item_id, vendor, seats, mrr, start_date, renewal_date, status, billing_cycle, term_months)
values ('e1684000-0000-4000-8000-0000000000c1', 'e1684000-0000-0000-0000-0000000000a1', 'R1684 Cust',
        'R1684 Workspace Standard', 'R1684-STD', 'google', 15, 16200, public.ist_today() - 60, public.ist_today() + 304,
        'active', 'yearly', 12);

create temp table r1684_out (step text, state text, msg text) on commit drop;
grant all on r1684_out to authenticated;

-- ── as the billing user ──────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e1684000-0000-4000-8000-00000000000b')::text, true);
do $$
declare v_state text; v_msg text;
begin
  begin
    perform public.correct_subscription_terms('e1684000-0000-4000-8000-0000000000c1', null, 10, 10800, 'Customer asked');
    insert into r1684_out values ('1', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r1684_out values ('1', v_state, v_msg);
  end;
  -- 6. price only, with a reason → allowed for billing
  begin
    perform public.correct_subscription_terms('e1684000-0000-4000-8000-0000000000c1', null, null, 16000, 'Typo in price');
    insert into r1684_out values ('6a', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r1684_out values ('6a', v_state, v_msg);
  end;
  -- 6b. nothing changed → no write, no reason needed
  perform public.correct_subscription_terms('e1684000-0000-4000-8000-0000000000c1', 'R1684-STD', 15, 16000, null);
  insert into r1684_out values ('6b', null, 'accepted');
end $$;

-- ── as the owner ─────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e1684000-0000-4000-8000-00000000000a')::text, true);
do $$
declare v_state text; v_msg text;
begin
  begin
    perform public.correct_subscription_terms('e1684000-0000-4000-8000-0000000000c1', null, 10, 10800, '  ');
    insert into r1684_out values ('2', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r1684_out values ('2', v_state, v_msg);
  end;
  begin
    perform public.correct_subscription_terms('e1684000-0000-4000-8000-0000000000c1', 'R1684-OTH', null, null, 'Wrong plan');
    insert into r1684_out values ('3', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r1684_out values ('3', v_state, v_msg);
  end;
  perform public.correct_subscription_terms('e1684000-0000-4000-8000-0000000000c1', null, 10, 10800, 'Customer dropped 5 users; credit note CN-1 issued');
  insert into r1684_out values ('4', null, 'accepted');
  perform public.correct_subscription_terms('e1684000-0000-4000-8000-0000000000c1', 'R1684-PLUS', null, null, 'Sold Plus, typed Standard');
  insert into r1684_out values ('5', null, 'accepted');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- 7. a plain table write afterwards (same transaction) carries no reason
update public.subscriptions set seats = 11 where id = 'e1684000-0000-4000-8000-0000000000c1';

do $$
declare
  r record; s record; a record; n integer;
begin
  select * into r from r1684_out where step = '1';
  if r.state is distinct from '42501' then raise exception 'FAIL r1684 step 1: billing user cut seats (%: %)', r.state, r.msg; end if;
  select * into r from r1684_out where step = '6a';
  if r.state is not null then raise exception 'FAIL r1684 step 6a: price-only correction refused (%: %)', r.state, r.msg; end if;
  select * into r from r1684_out where step = '2';
  if r.state is distinct from '22023' then raise exception 'FAIL r1684 step 2: no reason accepted (%: %)', r.state, r.msg; end if;
  select * into r from r1684_out where step = '3';
  if r.state is distinct from '22023' then raise exception 'FAIL r1684 step 3: other company''s item accepted (%: %)', r.state, r.msg; end if;

  select * into s from public.subscriptions where id = 'e1684000-0000-4000-8000-0000000000c1';
  if s.seats <> 11 or s.mrr <> 10800 or s.plan <> 'R1684 Workspace Plus' or s.item_id <> 'R1684-PLUS' then
    raise exception 'FAIL r1684 step 4/5/7: row is seats % mrr % plan % item %', s.seats, s.mrr, s.plan, s.item_id;
  end if;

  select count(*) into n from public.contract_amendments where subscription_id = s.id;
  if n <> 4 then raise exception 'FAIL r1684: expected 4 amendment rows (price, seats, plan, table), got %', n; end if;

  select * into a from public.contract_amendments where subscription_id = s.id and seats_to = 10;
  if a.seats_from <> 15 or a.mrr_from <> 16000 or a.mrr_to <> 10800
     or a.note is distinct from 'Customer dropped 5 users; credit note CN-1 issued' then
    raise exception 'FAIL r1684 step 4: amendment % → % / % → % note %', a.seats_from, a.seats_to, a.mrr_from, a.mrr_to, a.note;
  end if;
  select * into a from public.contract_amendments where subscription_id = s.id and mrr_to = 16000;
  if a.note is distinct from 'Typo in price' then raise exception 'FAIL r1684 step 6a: note %', a.note; end if;
  select * into a from public.contract_amendments where subscription_id = s.id and seats_to = 11;
  if a.note is not null then raise exception 'FAIL r1684 step 7: table write carried note %', a.note; end if;

  raise notice 'PASS r1684 — reason required, seat cut owner/manager only, plan from catalog, reason on the ledger';
end $$;

rollback;
