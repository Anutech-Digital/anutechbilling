\set ON_ERROR_STOP on
-- R-2225: "Won't renew" → Non-renewing (set_subscription_non_renewing) + the sidebar Renewals badge.
-- Migration: 20261101135056_r2225_non_renewing.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2225_non_renewing.test.sql
--
-- Expect "PASS r2225_non_renewing".
--
--   ROLES     billing refused (message); another company's owner refused
--   INPUT     a short reason refused; a future "told on" date refused; no renewal date refused;
--             a cancelled one refused; an expired one refused
--   WON'T     manager → auto_renew false, reason + date said + who stored, status still active,
--             renewal_date unchanged, ONE 'subscription.non_renewing' activity_log row
--   BADGE     nav_badges().renewals for the owner leaves the non-renewing one out (2 → 1)
--   UNDO      accountant → auto_renew true, reason fields cleared, ONE '..._undo' row; the badge
--             counts it again; Undo on a renewing one → already, no row
--   CANCEL    cancel_subscription still works on a non-renewing one (Now)

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2225000-0000-4000-8000-0000000000a1', 'r2225-owner@example.test'),
  ('e2225000-0000-4000-8000-0000000000a2', 'r2225-manager@example.test'),
  ('e2225000-0000-4000-8000-0000000000a3', 'r2225-billing@example.test'),
  ('e2225000-0000-4000-8000-0000000000a4', 'r2225-accountant@example.test'),
  ('e2225000-0000-4000-8000-0000000000b1', 'r2225-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2225000-0000-0000-0000-0000000000a0', 'R2225 A', 'r2225a@example.in', '07', 'R22A'),
  ('e2225000-0000-0000-0000-0000000000b0', 'R2225 B', 'r2225b@example.in', '07', 'R22B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2225000-0000-4000-8000-0000000000a1', 'e2225000-0000-0000-0000-0000000000a0', 'r2225-owner@example.in',      'R2225 Owner',      'owner',      true),
  ('e2225000-0000-4000-8000-0000000000a2', 'e2225000-0000-0000-0000-0000000000a0', 'r2225-manager@example.in',    'R2225 Manager',    'manager',    true),
  ('e2225000-0000-4000-8000-0000000000a3', 'e2225000-0000-0000-0000-0000000000a0', 'r2225-billing@example.in',    'R2225 Billing',    'billing',    true),
  ('e2225000-0000-4000-8000-0000000000a4', 'e2225000-0000-0000-0000-0000000000a0', 'r2225-accountant@example.in', 'R2225 Accountant', 'accountant', true),
  ('e2225000-0000-4000-8000-0000000000b1', 'e2225000-0000-0000-0000-0000000000b0', 'r2225-owner-b@example.in',    'R2225 Owner B',    'owner',      true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2225000-0000-4000-8000-0000000000c1', 'e2225000-0000-0000-0000-0000000000a0', 'R2225 Leaving Co', '07', 'India');

-- d1: renews in 5 days (urgent).  d2: renews in 3 days (urgent).  d3: no renewal date.
-- d4: cancelled.  d5: expired.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date) values
  ('e2225000-0000-4000-8000-0000000000d1', 'e2225000-0000-0000-0000-0000000000a0', 'e2225000-0000-4000-8000-0000000000c1', 'R2225 Leaving Co', 'Business Starter', 'google', 5, 1350, 'active',
   (now() at time zone 'Asia/Kolkata')::date + 5),
  ('e2225000-0000-4000-8000-0000000000d2', 'e2225000-0000-0000-0000-0000000000a0', 'e2225000-0000-4000-8000-0000000000c1', 'R2225 Leaving Co', 'Business Plus',    'google', 2, 1700, 'active',
   (now() at time zone 'Asia/Kolkata')::date + 3),
  ('e2225000-0000-4000-8000-0000000000d3', 'e2225000-0000-0000-0000-0000000000a0', 'e2225000-0000-4000-8000-0000000000c1', 'R2225 Leaving Co', 'Vault',            'google', 1,  300, 'active', null),
  ('e2225000-0000-4000-8000-0000000000d4', 'e2225000-0000-0000-0000-0000000000a0', 'e2225000-0000-4000-8000-0000000000c1', 'R2225 Leaving Co', 'Archive',          'google', 1,  300, 'cancelled',
   (now() at time zone 'Asia/Kolkata')::date + 20),
  ('e2225000-0000-4000-8000-0000000000d5', 'e2225000-0000-0000-0000-0000000000a0', 'e2225000-0000-4000-8000-0000000000c1', 'R2225 Leaving Co', 'Old plan',         'google', 1,  300, 'expired',
   (now() at time zone 'Asia/Kolkata')::date - 40);

create temp table r2225_fail (msg text) on commit drop;
grant all on r2225_fail to authenticated, service_role;

create function pg_temp.r2225_as(p_sub text, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role)::text, true);
end $$;
create function pg_temp.r2225_set(p_sub uuid, p_on boolean, p_reason text, p_said date) returns text language plpgsql as $$
begin
  perform public.set_subscription_non_renewing(p_sub, p_on, p_reason, p_said);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r2225_badge() returns int language plpgsql as $$
begin
  return (public.nav_badges('{}')->>'renewals')::int;
end $$;
grant execute on function pg_temp.r2225_as(text, text) to authenticated, service_role;
grant execute on function pg_temp.r2225_set(uuid, boolean, text, date) to authenticated, service_role;
grant execute on function pg_temp.r2225_badge() to authenticated, service_role;

do $$
declare
  a  constant uuid := 'e2225000-0000-0000-0000-0000000000a0';
  d1 constant uuid := 'e2225000-0000-4000-8000-0000000000d1';
  d2 constant uuid := 'e2225000-0000-4000-8000-0000000000d2';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_e text; v_n int; v_s record; v_r jsonb;
begin
  set local role authenticated;

  -- ════ ROLES ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.r2225_as('e2225000-0000-4000-8000-0000000000a3');  -- billing
  v_e := pg_temp.r2225_set(d1, true, 'moving to Microsoft', v_today);
  if v_e is null or v_e not like '42501: Only an owner, manager or accountant can mark a subscription Won''t renew%' then
    insert into r2225_fail values ('billing not refused properly: ' || coalesce(v_e, 'allowed'));
  end if;
  perform pg_temp.r2225_as('e2225000-0000-4000-8000-0000000000b1');  -- other company's owner
  v_e := pg_temp.r2225_set(d1, true, 'moving to Microsoft', v_today);
  if v_e is null or v_e not like '%Subscription not%' then
    insert into r2225_fail values ('other company not refused: ' || coalesce(v_e, 'allowed'));
  end if;

  -- ════ BADGE before ══════════════════════════════════════════════════════════════════
  perform pg_temp.r2225_as('e2225000-0000-4000-8000-0000000000a1');  -- owner
  v_n := pg_temp.r2225_badge();
  if v_n <> 3 then insert into r2225_fail values ('badge before = ' || v_n || ' (want 3: d1, d2, d5 expired)'); end if;

  -- ════ INPUT ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.r2225_as('e2225000-0000-4000-8000-0000000000a2');  -- manager
  v_e := pg_temp.r2225_set(d1, true, 'no', v_today);
  if v_e is null or v_e not like '22023: Write why the customer will not renew%' then
    insert into r2225_fail values ('short reason not refused: ' || coalesce(v_e, 'allowed'));
  end if;
  v_e := pg_temp.r2225_set(d1, true, 'moving to Microsoft', v_today + 1);
  if v_e is null or v_e not like '22023: The date the customer told you%future%' then
    insert into r2225_fail values ('future date not refused: ' || coalesce(v_e, 'allowed'));
  end if;
  v_e := pg_temp.r2225_set('e2225000-0000-4000-8000-0000000000d3', true, 'moving to Microsoft', v_today);
  if v_e is null or v_e not like '22023: This subscription has no renewal date%' then
    insert into r2225_fail values ('no renewal date not refused: ' || coalesce(v_e, 'allowed'));
  end if;
  v_e := pg_temp.r2225_set('e2225000-0000-4000-8000-0000000000d4', true, 'moving to Microsoft', v_today);
  if v_e is null or v_e not like '22023: This subscription is already cancelled%' then
    insert into r2225_fail values ('cancelled not refused: ' || coalesce(v_e, 'allowed'));
  end if;
  v_e := pg_temp.r2225_set('e2225000-0000-4000-8000-0000000000d5', true, 'moving to Microsoft', v_today);
  if v_e is null or v_e not like '22023: This subscription has already ended%' then
    insert into r2225_fail values ('expired not refused: ' || coalesce(v_e, 'allowed'));
  end if;

  -- ════ WON'T RENEW ═══════════════════════════════════════════════════════════════════
  v_e := pg_temp.r2225_set(d1, true, '  moving to Microsoft  ', v_today - 2);
  if v_e is not null then insert into r2225_fail values ('manager Won''t renew failed: ' || v_e); end if;

  reset role;
  perform pg_temp.r2225_as(null, 'service_role');
  select * into v_s from public.subscriptions where id = d1;
  if v_s.auto_renew then insert into r2225_fail values ('auto_renew still on'); end if;
  if v_s.status::text <> 'active' then insert into r2225_fail values ('status changed to ' || v_s.status); end if;
  if v_s.renewal_date <> v_today + 5 then insert into r2225_fail values ('renewal_date moved'); end if;
  if v_s.non_renew_reason is distinct from 'moving to Microsoft' then
    insert into r2225_fail values ('reason not stored trimmed: ' || coalesce(v_s.non_renew_reason, 'null'));
  end if;
  if v_s.non_renew_said_on is distinct from v_today - 2 then insert into r2225_fail values ('said_on not stored'); end if;
  if v_s.non_renew_set_by is distinct from 'e2225000-0000-4000-8000-0000000000a2'::uuid or v_s.non_renew_set_at is null then
    insert into r2225_fail values ('who / when not stored');
  end if;
  select count(*) into v_n from public.activity_log
   where tenant_id = a and entity = 'subscription' and entity_id = d1::text and action = 'subscription.non_renewing'
     and user_id = 'e2225000-0000-4000-8000-0000000000a2' and changes->>'reason' = 'moving to Microsoft';
  if v_n <> 1 then insert into r2225_fail values ('non_renewing activity rows = ' || v_n || ' (want 1)'); end if;

  -- ════ BADGE after ═══════════════════════════════════════════════════════════════════
  set local role authenticated;
  perform pg_temp.r2225_as('e2225000-0000-4000-8000-0000000000a1');
  v_n := pg_temp.r2225_badge();
  if v_n <> 2 then insert into r2225_fail values ('badge after Won''t renew = ' || v_n || ' (want 2)'); end if;

  -- ════ UNDO ══════════════════════════════════════════════════════════════════════════
  perform pg_temp.r2225_as('e2225000-0000-4000-8000-0000000000a4');  -- accountant
  v_e := pg_temp.r2225_set(d1, false, null, null);
  if v_e is not null then insert into r2225_fail values ('Undo failed: ' || v_e); end if;
  v_e := pg_temp.r2225_set(d2, false, null, null);   -- renewing already → no-op
  if v_e is not null then insert into r2225_fail values ('Undo on a renewing one failed: ' || v_e); end if;

  perform pg_temp.r2225_as('e2225000-0000-4000-8000-0000000000a1');
  v_n := pg_temp.r2225_badge();
  if v_n <> 3 then insert into r2225_fail values ('badge after Undo = ' || v_n || ' (want 3)'); end if;

  reset role;
  perform pg_temp.r2225_as(null, 'service_role');
  select * into v_s from public.subscriptions where id = d1;
  if not v_s.auto_renew or v_s.non_renew_reason is not null or v_s.non_renew_said_on is not null
     or v_s.non_renew_set_by is not null or v_s.non_renew_set_at is not null then
    insert into r2225_fail values ('Undo did not restore auto_renew / clear the fields');
  end if;
  select count(*) into v_n from public.activity_log
   where tenant_id = a and action = 'subscription.non_renewing_undo' and entity_id = d1::text
     and user_id = 'e2225000-0000-4000-8000-0000000000a4' and changes->>'was_reason' = 'moving to Microsoft';
  if v_n <> 1 then insert into r2225_fail values ('undo activity rows = ' || v_n || ' (want 1)'); end if;
  select count(*) into v_n from public.activity_log
   where tenant_id = a and action like 'subscription.non_renewing%' and entity_id = d2::text;
  if v_n <> 0 then insert into r2225_fail values ('a no-op Undo wrote an activity row'); end if;

  -- ════ CANCEL a non-renewing one (Now) still works ═══════════════════════════════════
  set local role authenticated;
  perform pg_temp.r2225_as('e2225000-0000-4000-8000-0000000000a2');
  perform public.set_subscription_non_renewing(d2, true, 'closing the business', null);
  v_r := public.cancel_subscription(d2, v_today, 'closing the business', false);
  if v_r->>'status' <> 'cancelled' then insert into r2225_fail values ('cancel after Won''t renew: ' || v_r::text); end if;
  reset role;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n') into v_msgs from r2225_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2225_non_renewing:\n%', v_msgs;
  end if;
  raise notice 'PASS r2225_non_renewing';
end $$;

rollback;
