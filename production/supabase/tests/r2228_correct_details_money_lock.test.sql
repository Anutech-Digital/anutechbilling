-- R-2228 (Zoho Billing audit A4): "Correct details" no longer changes seats / MRR; the owner's
-- "Data correction" is the one record-fix door. Migration 20261101145415_r2228_correct_details_money_lock.
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r2228_correct_details_money_lock.test.sql
--
-- Without the migration it FAILs at step 1 (the owner's seat change is accepted) — or, run on a
-- DB without correct_subscription_data, at step 3.
--
-- Proves:
--   1. correct_subscription_terms refuses a seat change (42501), even for the owner, with a reason;
--   2. correct_subscription_terms refuses an MRR change (42501);
--   3. correct_subscription_data: a manager and an accountant are refused (42501);
--   4. the owner without a 10+ character reason is refused (22023);
--   5. another company's subscription is refused (42501);
--   6. the owner fixes 15 → 12 seats, MRR 16,200 → 12,960 with a reason: row updated, ONE
--      activity_log row 'subscription.data_correction' with old → new and the reason, the
--      amendment note carries the reason; NO invoice, quote, credit note or payment is written;
--   7. nothing changed → changed = false, no second activity row;
--   8. a plan typo fix through correct_subscription_terms still works (owner, catalog row).

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2228000-0000-4000-8000-00000000000a', 'r2228-owner@example.test'),
  ('e2228000-0000-4000-8000-00000000000b', 'r2228-manager@example.test'),
  ('e2228000-0000-4000-8000-00000000000c', 'r2228-accountant@example.test');

insert into public.tenants (id, name, email, state_code, state, doc_code) values
  ('e2228000-0000-0000-0000-0000000000a1', 'R2228 Co',    'r2228@example.in',  '07', 'Delhi', 'R28A'),
  ('e2228000-0000-0000-0000-0000000000b1', 'R2228 Other', 'r2228o@example.in', '07', 'Delhi', 'R28B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2228000-0000-4000-8000-00000000000a', 'e2228000-0000-0000-0000-0000000000a1', 'r2228-owner@example.in',      'R2228 Owner',      'owner',      true),
  ('e2228000-0000-4000-8000-00000000000b', 'e2228000-0000-0000-0000-0000000000a1', 'r2228-manager@example.in',    'R2228 Manager',    'manager',    true),
  ('e2228000-0000-4000-8000-00000000000c', 'e2228000-0000-0000-0000-0000000000a1', 'r2228-accountant@example.in', 'R2228 Accountant', 'accountant', true);

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('R2228-STD',  'e2228000-0000-0000-0000-0000000000a1', 'R2228 Workspace Standard', 'google', 864,  620),
  ('R2228-PLUS', 'e2228000-0000-0000-0000-0000000000a1', 'R2228 Workspace Plus',     'google', 1380, 1150);

insert into public.subscriptions (id, tenant_id, customer_name, plan, item_id, vendor, seats, mrr, start_date, renewal_date, status, billing_cycle, term_months)
values
  ('e2228000-0000-4000-8000-0000000000c1', 'e2228000-0000-0000-0000-0000000000a1', 'R2228 Cust',
   'R2228 Workspace Standard', 'R2228-STD', 'google', 15, 16200, public.ist_today() - 60, public.ist_today() + 305,
   'active', 'yearly', 12),
  ('e2228000-0000-4000-8000-0000000000d1', 'e2228000-0000-0000-0000-0000000000b1', 'R2228 Other Cust',
   'Other plan', null, 'google', 5, 5000, public.ist_today() - 60, public.ist_today() + 305,
   'active', 'yearly', 12);

create temp table r2228_out (step text, state text, msg text) on commit drop;
grant all on r2228_out to authenticated;

set local role authenticated;

-- ── as the manager, then the accountant ──────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2228000-0000-4000-8000-00000000000b')::text, true);
do $$
declare v_state text; v_msg text;
begin
  begin
    perform public.correct_subscription_data('e2228000-0000-4000-8000-0000000000c1', 12, 12960, 'Zoho reconcile: Google shows 12');
    insert into r2228_out values ('3m', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2228_out values ('3m', v_state, v_msg);
  end;
end $$;
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2228000-0000-4000-8000-00000000000c')::text, true);
do $$
declare v_state text; v_msg text;
begin
  begin
    perform public.correct_subscription_data('e2228000-0000-4000-8000-0000000000c1', 12, 12960, 'Zoho reconcile: Google shows 12');
    insert into r2228_out values ('3a', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2228_out values ('3a', v_state, v_msg);
  end;
end $$;

-- ── as the owner ─────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2228000-0000-4000-8000-00000000000a')::text, true);
do $$
declare v_state text; v_msg text; v_res jsonb;
begin
  begin
    perform public.correct_subscription_terms('e2228000-0000-4000-8000-0000000000c1', null, 12, null, 'Customer removed 3 users');
    insert into r2228_out values ('1', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2228_out values ('1', v_state, v_msg);
  end;
  begin
    perform public.correct_subscription_terms('e2228000-0000-4000-8000-0000000000c1', null, null, 15000, 'Typo in price');
    insert into r2228_out values ('2', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2228_out values ('2', v_state, v_msg);
  end;
  begin
    perform public.correct_subscription_data('e2228000-0000-4000-8000-0000000000c1', 12, 12960, 'too short');
    insert into r2228_out values ('4', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2228_out values ('4', v_state, v_msg);
  end;
  begin
    perform public.correct_subscription_data('e2228000-0000-4000-8000-0000000000d1', 1, 1000, 'Zoho reconcile: other company');
    insert into r2228_out values ('5', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2228_out values ('5', v_state, v_msg);
  end;
  v_res := public.correct_subscription_data('e2228000-0000-4000-8000-0000000000c1', 12, 12960, '  Zoho reconcile: Google shows 12 seats  ');
  insert into r2228_out values ('6', null, v_res::text);
  v_res := public.correct_subscription_data('e2228000-0000-4000-8000-0000000000c1', 12, 12960, null);
  insert into r2228_out values ('7', null, v_res::text);
  perform public.correct_subscription_terms('e2228000-0000-4000-8000-0000000000c1', 'R2228-PLUS', 12, 12960, 'Sold Plus, typed Standard');
  insert into r2228_out values ('8', null, 'accepted');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  r record; s record; a record; n integer;
begin
  select * into r from r2228_out where step = '1';
  if r.state is distinct from '42501' then raise exception 'FAIL r2228 step 1: Correct details changed the seats (%: %)', r.state, r.msg; end if;
  select * into r from r2228_out where step = '2';
  if r.state is distinct from '42501' then raise exception 'FAIL r2228 step 2: Correct details changed the MRR (%: %)', r.state, r.msg; end if;
  select * into r from r2228_out where step = '3m';
  if r.state is distinct from '42501' then raise exception 'FAIL r2228 step 3: manager made a data correction (%: %)', r.state, r.msg; end if;
  select * into r from r2228_out where step = '3a';
  if r.state is distinct from '42501' then raise exception 'FAIL r2228 step 3: accountant made a data correction (%: %)', r.state, r.msg; end if;
  select * into r from r2228_out where step = '4';
  if r.state is distinct from '22023' then raise exception 'FAIL r2228 step 4: short reason accepted (%: %)', r.state, r.msg; end if;
  select * into r from r2228_out where step = '5';
  if r.state is distinct from '42501' then raise exception 'FAIL r2228 step 5: other company''s subscription corrected (%: %)', r.state, r.msg; end if;
  select * into r from r2228_out where step = '7';
  if (r.msg::jsonb ->> 'changed') <> 'false' then raise exception 'FAIL r2228 step 7: no-op answered %', r.msg; end if;

  select * into s from public.subscriptions where id = 'e2228000-0000-4000-8000-0000000000c1';
  if s.seats <> 12 or s.mrr <> 12960 or s.item_id <> 'R2228-PLUS' or s.plan <> 'R2228 Workspace Plus' then
    raise exception 'FAIL r2228 step 6/8: row is seats % mrr % plan % item %', s.seats, s.mrr, s.plan, s.item_id;
  end if;
  select * into s from public.subscriptions where id = 'e2228000-0000-4000-8000-0000000000d1';
  if s.seats <> 5 or s.mrr <> 5000 then raise exception 'FAIL r2228 step 5: other company row changed'; end if;

  select count(*) into n from public.activity_log
   where entity = 'subscription' and entity_id = 'e2228000-0000-4000-8000-0000000000c1' and action = 'subscription.data_correction';
  if n <> 1 then raise exception 'FAIL r2228 step 6/7: expected 1 data_correction activity row, got %', n; end if;
  select * into a from public.activity_log
   where entity = 'subscription' and entity_id = 'e2228000-0000-4000-8000-0000000000c1' and action = 'subscription.data_correction';
  if a.user_id is distinct from 'e2228000-0000-4000-8000-00000000000a'::uuid
     or (a.changes #>> '{seats,from}') <> '15' or (a.changes #>> '{seats,to}') <> '12'
     or (a.changes #>> '{mrr,from}') <> '16200' or (a.changes #>> '{mrr,to}') <> '12960'
     or (a.changes ->> 'reason') <> 'Zoho reconcile: Google shows 12 seats' then
    raise exception 'FAIL r2228 step 6: activity row % %', a.user_id, a.changes;
  end if;

  select * into a from public.contract_amendments
   where subscription_id = 'e2228000-0000-4000-8000-0000000000c1' and seats_to = 12;
  if a.note is distinct from 'Data correction: Zoho reconcile: Google shows 12 seats' then
    raise exception 'FAIL r2228 step 6: amendment note %', a.note;
  end if;

  select count(*) into n from public.invoices where tenant_id = 'e2228000-0000-0000-0000-0000000000a1';
  if n <> 0 then raise exception 'FAIL r2228 step 6: % invoices written by a data correction', n; end if;
  select count(*) into n from public.quotes where tenant_id = 'e2228000-0000-0000-0000-0000000000a1';
  if n <> 0 then raise exception 'FAIL r2228 step 6: % quotes written by a data correction', n; end if;
  select count(*) into n from public.credit_notes where tenant_id = 'e2228000-0000-0000-0000-0000000000a1';
  if n <> 0 then raise exception 'FAIL r2228 step 6: % credit notes written by a data correction', n; end if;
  select count(*) into n from public.payments where tenant_id = 'e2228000-0000-0000-0000-0000000000a1';
  if n <> 0 then raise exception 'FAIL r2228 step 6: % payments written by a data correction', n; end if;

  raise notice 'PASS r2228 — Correct details refuses seats/MRR; owner-only data correction with reason, logged, no money';
end $$;

rollback;
