-- R-2095 (coordinator 30 Oct, P0 money): an existing subscription's commitment can be corrected —
-- Venus Infotech, Google Workspace ANNUAL commitment paid MONTHLY, booked as Flexible, licence cost
-- ₹318 (flex) instead of ₹264 (annual). Migration 20261030164727_r2095_correct_subscription_commitment.
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r2095_correct_subscription_commitment.test.sql
--
-- Without the migration it FAILs at step 1 (no such function).
--
-- Proves:
--   1. a sales user cannot change the commitment (42501);
--   2. no reason → refused (22023);
--   3. Flexible paid quarterly → refused (22023);
--   4. billing user: Flexible → Annual paid monthly, renewal → start + 12m − 1d: term_months 12,
--      billing_cycle monthly, licence cost 318 → 264 (annual tier), seats / mrr / domain / start
--      unchanged; ONE amendment row with term_months 1→12, cost 318→264, renewal, note = reason;
--   5. Annual → Flexible while the annual term runs → refused (22023), row unchanged;
--   6. payment frequency only (monthly → quarterly → half-yearly) is allowed, renewal kept, cost kept;
--   7. a vendor-confirmed cost (vendor_synced_at set) is not overwritten by the catalogue;
--   8. Annual → Flexible after the annual term ended: billing user refused (owner / manager only),
--      owner allowed, cost → flex tier 318.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2095c00-0000-4000-8000-00000000000a', 'r2095c-owner@example.test'),
  ('e2095c00-0000-4000-8000-00000000000b', 'r2095c-billing@example.test'),
  ('e2095c00-0000-4000-8000-00000000000c', 'r2095c-sales@example.test');

insert into public.tenants (id, name, email, state_code, state, doc_code) values
  ('e2095c00-0000-0000-0000-0000000000a1', 'R2095C Co', 'r2095c@example.in', '07', 'Delhi', 'R95C');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2095c00-0000-4000-8000-00000000000a', 'e2095c00-0000-0000-0000-0000000000a1', 'r2095c-owner@example.in',   'R2095C Owner',   'owner',   true),
  ('e2095c00-0000-4000-8000-00000000000b', 'e2095c00-0000-0000-0000-0000000000a1', 'r2095c-billing@example.in', 'R2095C Billing', 'billing', true),
  ('e2095c00-0000-4000-8000-00000000000c', 'e2095c00-0000-0000-0000-0000000000a1', 'r2095c-sales@example.in',   'R2095C Sales',   'sales',   true);

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices) values
  ('R2095C-STD', 'e2095c00-0000-0000-0000-0000000000a1', 'R2095C Workspace Standard', 'google', 300, 264,
   '{"annual":{"msrp":300,"wholesale":264},"monthly":{"msrp":360,"wholesale":318}}'::jsonb);

-- c1: Venus — booked Flexible, started ~4.5 months ago, current month ends in ~15 days.
insert into public.subscriptions (id, tenant_id, customer_name, plan, item_id, vendor, seats, mrr, domain,
                                  start_date, renewal_date, status, billing_cycle, term_months, vendor_cost_per_seat_month)
values ('e2095c00-0000-4000-8000-0000000000c1', 'e2095c00-0000-0000-0000-0000000000a1', 'R2095C Venus',
        'R2095C Workspace Standard', 'R2095C-STD', 'google', 10, 3000, 'venus-test.in',
        public.ist_today() - 135, public.ist_today() + 15, 'active', 'monthly', 1, 318);
-- c2: annual, vendor-confirmed cost 250 (a real Google bill), ended 10 days ago.
insert into public.subscriptions (id, tenant_id, customer_name, plan, item_id, vendor, seats, mrr,
                                  start_date, renewal_date, status, billing_cycle, term_months,
                                  vendor_cost_per_seat_month, vendor_synced_at)
values ('e2095c00-0000-4000-8000-0000000000c2', 'e2095c00-0000-0000-0000-0000000000a1', 'R2095C Ended',
        'R2095C Workspace Standard', 'R2095C-STD', 'google', 5, 1500,
        public.ist_today() - 375, public.ist_today() - 10, 'active', 'yearly', 12, 250, now());
-- c3: annual, catalogue cost, ended 10 days ago.
insert into public.subscriptions (id, tenant_id, customer_name, plan, item_id, vendor, seats, mrr,
                                  start_date, renewal_date, status, billing_cycle, term_months, vendor_cost_per_seat_month)
values ('e2095c00-0000-4000-8000-0000000000c3', 'e2095c00-0000-0000-0000-0000000000a1', 'R2095C Ended2',
        'R2095C Workspace Standard', 'R2095C-STD', 'google', 5, 1500,
        public.ist_today() - 375, public.ist_today() - 10, 'active', 'yearly', 12, 264);

create temp table r2095c_out (step text, state text, msg text) on commit drop;
grant all on r2095c_out to authenticated;
create temp table r2095c_dates (k text, d date) on commit drop;
grant all on r2095c_dates to authenticated;
insert into r2095c_dates
  select 'annual_end', ((s.start_date + interval '12 months')::date - 1) from public.subscriptions s
   where s.id = 'e2095c00-0000-4000-8000-0000000000c1';

-- ── as the sales user ────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2095c00-0000-4000-8000-00000000000c')::text, true);
do $$
declare v_state text; v_msg text;
begin
  begin
    perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c1', 12, 'monthly',
      (select d from r2095c_dates where k = 'annual_end'), 'Annual commitment, paid monthly');
    insert into r2095c_out values ('1', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2095c_out values ('1', v_state, v_msg);
  end;
end $$;

-- ── as the billing user ──────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2095c00-0000-4000-8000-00000000000b')::text, true);
do $$
declare v_state text; v_msg text; v_end date := (select d from r2095c_dates where k = 'annual_end');
begin
  begin
    perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c1', 12, 'monthly', v_end, ' ');
    insert into r2095c_out values ('2', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2095c_out values ('2', v_state, v_msg);
  end;
  begin
    perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c1', 1, 'quarterly', null, 'Flex quarterly');
    insert into r2095c_out values ('3', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2095c_out values ('3', v_state, v_msg);
  end;
  -- 4. the Venus fix
  perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c1', 12, 'monthly', v_end,
    'Venus is annual commitment paid monthly; booked as Flexible');
  insert into r2095c_out values ('4', null, 'accepted');
  -- 5. back to Flexible mid-term
  begin
    perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c1', 1, 'monthly', null, 'Try flex again');
    insert into r2095c_out values ('5', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2095c_out values ('5', v_state, v_msg);
  end;
  -- 6. payment frequency only
  perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c1', 12, 'quarterly', null, 'Customer pays quarterly now');
  perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c1', 12, 'half_yearly', null, 'Customer pays half-yearly now');
  insert into r2095c_out values ('6', null, 'accepted');
  -- 8a. ended annual → flex as billing: owner/manager only
  begin
    perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c3', 1, 'monthly', null, 'Moved to Flexible at renewal');
    insert into r2095c_out values ('8a', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2095c_out values ('8a', v_state, v_msg);
  end;
end $$;

-- ── as the owner ─────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2095c00-0000-4000-8000-00000000000a')::text, true);
do $$
begin
  -- 7. vendor-confirmed cost stays
  perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c2', 1, 'monthly', null, 'Moved to Flexible at renewal');
  -- 8b. owner may shorten an ENDED annual term
  perform public.correct_subscription_commitment('e2095c00-0000-4000-8000-0000000000c3', 1, 'monthly', null, 'Moved to Flexible at renewal');
  insert into r2095c_out values ('8b', null, 'accepted');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  r record; s record; a record; n integer; v_end date := (select d from r2095c_dates where k = 'annual_end');
begin
  select * into r from r2095c_out where step = '1';
  if r.state is distinct from '42501' then raise exception 'FAIL r2095c step 1: sales user changed the commitment (%: %)', r.state, r.msg; end if;
  select * into r from r2095c_out where step = '2';
  if r.state is distinct from '22023' then raise exception 'FAIL r2095c step 2: no reason accepted (%: %)', r.state, r.msg; end if;
  select * into r from r2095c_out where step = '3';
  if r.state is distinct from '22023' then raise exception 'FAIL r2095c step 3: Flexible quarterly accepted (%: %)', r.state, r.msg; end if;
  select * into r from r2095c_out where step = '5';
  if r.state is distinct from '22023' or r.msg not like '%cannot be reduced mid-term%' then
    raise exception 'FAIL r2095c step 5: annual → flex mid-term not refused (%: %)', r.state, r.msg;
  end if;
  select * into r from r2095c_out where step = '8a';
  if r.state is distinct from '42501' then raise exception 'FAIL r2095c step 8a: billing user shortened a commitment (%: %)', r.state, r.msg; end if;

  select * into s from public.subscriptions where id = 'e2095c00-0000-4000-8000-0000000000c1';
  if s.term_months <> 12 or s.billing_cycle <> 'half_yearly' or s.vendor_cost_per_seat_month <> 264
     or s.renewal_date <> v_end or s.seats <> 10 or s.mrr <> 3000 or s.domain <> 'venus-test.in'
     or s.start_date <> public.ist_today() - 135 then
    raise exception 'FAIL r2095c step 4/6: row term % cycle % cost % renewal % (want %) seats % mrr % domain %',
      s.term_months, s.billing_cycle, s.vendor_cost_per_seat_month, s.renewal_date, v_end, s.seats, s.mrr, s.domain;
  end if;

  select count(*) into n from public.contract_amendments where subscription_id = s.id;
  if n <> 3 then raise exception 'FAIL r2095c: expected 3 amendment rows on Venus (commitment, quarterly, half-yearly), got %', n; end if;
  select * into a from public.contract_amendments where subscription_id = s.id and kind like '%commitment_changed%';
  if (a.changes -> 'term_months' ->> 'from')::int <> 1 or (a.changes -> 'term_months' ->> 'to')::int <> 12
     or (a.changes -> 'vendor_cost_per_seat_month' ->> 'from')::int <> 318
     or (a.changes -> 'vendor_cost_per_seat_month' ->> 'to')::int <> 264
     or (a.changes -> 'renewal_date' ->> 'to')::date <> v_end
     or a.note is distinct from 'Venus is annual commitment paid monthly; booked as Flexible' then
    raise exception 'FAIL r2095c step 4: amendment % note %', a.changes, a.note;
  end if;

  select * into s from public.subscriptions where id = 'e2095c00-0000-4000-8000-0000000000c2';
  if s.term_months <> 1 or s.vendor_cost_per_seat_month <> 250 then
    raise exception 'FAIL r2095c step 7: vendor-confirmed cost overwritten (term % cost %)', s.term_months, s.vendor_cost_per_seat_month;
  end if;
  select * into s from public.subscriptions where id = 'e2095c00-0000-4000-8000-0000000000c3';
  if s.term_months <> 1 or s.vendor_cost_per_seat_month <> 318 or s.renewal_date <> public.ist_today() - 10 then
    raise exception 'FAIL r2095c step 8b: ended annual → flex: term % cost % renewal %', s.term_months, s.vendor_cost_per_seat_month, s.renewal_date;
  end if;

  raise notice 'PASS r2095c — commitment + payment frequency corrected, cost from the catalogue tier, no mid-term reduction, ledger keeps old → new';
end $$;

rollback;
