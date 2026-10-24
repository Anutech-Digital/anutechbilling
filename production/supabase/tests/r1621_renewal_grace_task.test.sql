\set ON_ERROR_STOP on
-- R-1621: renewal late payment — 7-day grace for new companies, trusted customer grace
-- (owner/manager only), and grace over → ONE owner task; the owner stops the service or
-- gives more days. Migration: 20261023131000_r1621_renewal_grace_task.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1621_renewal_grace_task.test.sql
--
-- Expect "PASS r1621_renewal_grace_task".
--
--   DEFAULT   a new company gets grace_period_days 7; an existing 0 stays 0
--   TRUSTED   billing / sales cannot set a customer's grace; a manager can; 61 is refused
--   RAISE     grace over → one "Stop service — …" task (owner, ₹ due, link); run again → still one;
--             the subscription is NOT paused; a trusted customer still in grace → no task;
--             a signed-in user cannot call it
--   DECIDE    sales / another company refused; +5 days moves grace_until and the task, and the
--             job then sees "in grace"; Stop → paused + suspended + reason, task done;
--             0 days and a not-yet-due renewal refused; billing cannot write grace_until directly

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1621000-0000-4000-8000-0000000000a1', 'r1621-owner@example.test'),
  ('e1621000-0000-4000-8000-0000000000a2', 'r1621-manager@example.test'),
  ('e1621000-0000-4000-8000-0000000000a3', 'r1621-billing@example.test'),
  ('e1621000-0000-4000-8000-0000000000a4', 'r1621-sales@example.test'),
  ('e1621000-0000-4000-8000-0000000000b1', 'r1621-owner-b@example.test');

-- A: created without a grace value (gets the new default). B: an existing company with 0.
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1621000-0000-0000-0000-0000000000a0', 'R1621 A', 'r1621a@example.in', '07', 'R16A');
insert into public.tenants (id, name, email, state_code, doc_code, grace_period_days) values
  ('e1621000-0000-0000-0000-0000000000b0', 'R1621 B', 'r1621b@example.in', '07', 'R16B', 0);

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1621000-0000-4000-8000-0000000000a1', 'e1621000-0000-0000-0000-0000000000a0', 'r1621-owner@example.in',   'R1621 Owner',   'owner',   true),
  ('e1621000-0000-4000-8000-0000000000a2', 'e1621000-0000-0000-0000-0000000000a0', 'r1621-manager@example.in', 'R1621 Manager', 'manager', true),
  ('e1621000-0000-4000-8000-0000000000a3', 'e1621000-0000-0000-0000-0000000000a0', 'r1621-billing@example.in', 'R1621 Billing', 'billing', true),
  ('e1621000-0000-4000-8000-0000000000a4', 'e1621000-0000-0000-0000-0000000000a0', 'r1621-sales@example.in',   'R1621 Sales',   'sales',   true),
  ('e1621000-0000-4000-8000-0000000000b1', 'e1621000-0000-0000-0000-0000000000b0', 'r1621-owner-b@example.in', 'R1621 Owner B', 'owner',   true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1621000-0000-4000-8000-0000000000c1', 'e1621000-0000-0000-0000-0000000000a0', 'R1621 Late Co',    '07', 'India'),
  ('e1621000-0000-4000-8000-0000000000c2', 'e1621000-0000-0000-0000-0000000000a0', 'R1621 Trusted Co', '07', 'India');

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R1621-REN', 'e1621000-0000-0000-0000-0000000000a0', null, 'e1621000-0000-4000-8000-0000000000c1', 'R1621 Late Co', 23823, 20189, 18, 'sent', 'none', '[]'::jsonb);

-- s1: Late Co, renewal 10 days ago (grace 7 → over). s2: Trusted Co, 10 days ago (trusted 30 → in grace).
-- s3: renews in 5 days.
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status,
                                  renewal_date, renewal_state, renewal_quote_id) values
  ('e1621000-0000-4000-8000-0000000000d1', 'e1621000-0000-0000-0000-0000000000a0', 'e1621000-0000-4000-8000-0000000000c1', 'R1621 Late Co',    'Business Starter', 'google', 5, 1350, 'active',
   (now() at time zone 'Asia/Kolkata')::date - 10, 'grace_period', 'Q-R1621-REN'),
  ('e1621000-0000-4000-8000-0000000000d2', 'e1621000-0000-0000-0000-0000000000a0', 'e1621000-0000-4000-8000-0000000000c2', 'R1621 Trusted Co', 'Business Plus',    'google', 2, 1700, 'active',
   (now() at time zone 'Asia/Kolkata')::date - 10, 'grace_period', null),
  ('e1621000-0000-4000-8000-0000000000d3', 'e1621000-0000-0000-0000-0000000000a0', 'e1621000-0000-4000-8000-0000000000c1', 'R1621 Late Co',    'Vault',            'google', 1,  300, 'active',
   (now() at time zone 'Asia/Kolkata')::date + 5, 'reminder_4', null);

create temp table r1621_fail (msg text) on commit drop;
grant all on r1621_fail to authenticated, service_role;

create function pg_temp.r1621_as(p_sub text, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role)::text, true);
end $$;
create function pg_temp.r1621_decide(p_sub uuid, p_action text, p_days int) returns text language plpgsql as $$
begin
  perform public.renewal_grace_decide(p_sub, p_action, p_days);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.r1621_as(text, text) to authenticated, service_role;
grant execute on function pg_temp.r1621_decide(uuid, text, int) to authenticated, service_role;

do $$
declare
  a  constant uuid := 'e1621000-0000-0000-0000-0000000000a0';
  d1 constant uuid := 'e1621000-0000-4000-8000-0000000000d1';
  d2 constant uuid := 'e1621000-0000-4000-8000-0000000000d2';
  d3 constant uuid := 'e1621000-0000-4000-8000-0000000000d3';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_e text; v_r jsonb; v_s record; v_n int; v_t record;
begin
  -- ════ DEFAULT ═════════════════════════════════════════════════════════════════════
  if (select grace_period_days from public.tenants where id = a) <> 7 then
    insert into r1621_fail values ('new company did not get 7 grace days');
  end if;
  if (select grace_period_days from public.tenants where id = 'e1621000-0000-0000-0000-0000000000b0') <> 0 then
    insert into r1621_fail values ('an existing 0 was changed');
  end if;

  -- ════ TRUSTED ═════════════════════════════════════════════════════════════════════
  set local role authenticated;
  perform pg_temp.r1621_as('e1621000-0000-4000-8000-0000000000a3');  -- billing
  begin
    update public.customers set trusted_grace_days = 30 where id = 'e1621000-0000-4000-8000-0000000000c2';
    insert into r1621_fail values ('billing set trusted grace');
  exception when others then
    if sqlerrm not like 'Only the owner or a manager can give a customer extra grace days%' then
      insert into r1621_fail values ('billing refused with wrong message: ' || sqlerrm);
    end if;
  end;
  perform pg_temp.r1621_as('e1621000-0000-4000-8000-0000000000a2');  -- manager
  begin
    update public.customers set trusted_grace_days = 61 where id = 'e1621000-0000-4000-8000-0000000000c2';
    insert into r1621_fail values ('61 trusted days allowed');
  exception when check_violation then null;
  end;
  begin
    update public.customers set trusted_grace_days = 30 where id = 'e1621000-0000-4000-8000-0000000000c2';
  exception when others then insert into r1621_fail values ('manager could not set trusted grace: ' || sqlerrm);
  end;
  -- billing may still edit the customer's other fields
  perform pg_temp.r1621_as('e1621000-0000-4000-8000-0000000000a3');
  begin
    update public.customers set notes = 'r1621 note' where id = 'e1621000-0000-4000-8000-0000000000c2';
  exception when others then insert into r1621_fail values ('billing blocked from a normal customer edit: ' || sqlerrm);
  end;

  -- ════ RAISE ═══════════════════════════════════════════════════════════════════════
  begin
    perform public.raise_renewal_grace_task(d1);
    insert into r1621_fail values ('a signed-in user raised a grace task');
  exception when others then null;
  end;

  set local role service_role;
  perform pg_temp.r1621_as(null, 'service_role');
  v_r := public.raise_renewal_grace_task(d1);
  if not coalesce((v_r->>'raised')::boolean, false) then
    insert into r1621_fail values ('grace over but no task: ' || v_r::text);
  end if;
  v_r := public.raise_renewal_grace_task(d1);
  if v_r->>'why' is distinct from 'already_raised' then
    insert into r1621_fail values ('second run not idempotent: ' || v_r::text);
  end if;
  v_r := public.raise_renewal_grace_task(d2);
  if v_r->>'why' is distinct from 'in_grace' then
    insert into r1621_fail values ('trusted customer (30 days) got a task on day 10: ' || v_r::text);
  end if;
  v_r := public.raise_renewal_grace_task(d3);
  if coalesce((v_r->>'raised')::boolean, false) then
    insert into r1621_fail values ('not-yet-due renewal got a task');
  end if;
  set local role postgres;

  select count(*) into v_n from public.tasks where subscription_id = d1;
  if v_n <> 1 then insert into r1621_fail values ('want 1 task for d1, got ' || v_n); end if;
  select * into v_t from public.tasks where subscription_id = d1;
  if v_t.title <> 'Stop service — R1621 Late Co · Business Starter · ₹23,823 due'
     or v_t.owner_id is distinct from 'e1621000-0000-4000-8000-0000000000a1'
     or v_t.notes not like '%/renewals?view=grace%' or v_t.notes not like '%Google Admin%'
     or v_t.status::text <> 'pending' then
    insert into r1621_fail values ('task wrong: ' || row_to_json(v_t)::text);
  end if;
  if (select count(*) from public.tasks where subscription_id in (d2, d3)) <> 0 then
    insert into r1621_fail values ('d2/d3 got a task');
  end if;
  select status::text as status, renewal_state::text as rs, grace_task_for into v_s from public.subscriptions where id = d1;
  if v_s.status <> 'active' or v_s.rs <> 'grace_period' or v_s.grace_task_for <> v_today - 10 then
    insert into r1621_fail values ('raise changed more than the stamp: ' || row_to_json(v_s)::text);
  end if;

  -- ════ DECIDE ══════════════════════════════════════════════════════════════════════
  set local role authenticated;
  perform pg_temp.r1621_as('e1621000-0000-4000-8000-0000000000a4');  -- sales
  v_e := pg_temp.r1621_decide(d1, 'stop', null);
  if v_e is null or v_e not like '42501: Only the owner or a manager can stop a service%' then
    insert into r1621_fail values ('sales stopped the service: ' || coalesce(v_e, 'ran'));
  end if;
  perform pg_temp.r1621_as('e1621000-0000-4000-8000-0000000000a3');  -- billing, direct write
  begin
    update public.subscriptions set grace_until = v_today + 20 where id = d1;
    insert into r1621_fail values ('billing wrote grace_until directly');
  exception when others then
    if sqlerrm not like 'Only the owner or a manager can give a subscription more grace days%' then
      insert into r1621_fail values ('direct grace_until refused with wrong message: ' || sqlerrm);
    end if;
  end;
  perform pg_temp.r1621_as('e1621000-0000-4000-8000-0000000000b1');  -- other company
  v_e := pg_temp.r1621_decide(d1, 'extend', 5);
  if v_e is null or v_e not like '42501: That subscription was not found in your company%' then
    insert into r1621_fail values ('other company extended it: ' || coalesce(v_e, 'ran'));
  end if;

  perform pg_temp.r1621_as('e1621000-0000-4000-8000-0000000000a2');  -- manager
  v_e := pg_temp.r1621_decide(d1, 'extend', 0);
  if v_e is null or v_e not like '22023: Give between 1 and 30 more days%' then
    insert into r1621_fail values ('0 days accepted: ' || coalesce(v_e, 'ran'));
  end if;
  v_e := pg_temp.r1621_decide(d3, 'stop', null);
  if v_e is null or v_e not like '22023: This renewal is not overdue%' then
    insert into r1621_fail values ('not-yet-due renewal stopped: ' || coalesce(v_e, 'ran'));
  end if;
  v_e := pg_temp.r1621_decide(d1, 'extend', 5);
  if v_e is not null then insert into r1621_fail values ('manager +5 days failed: ' || v_e); end if;

  set local role postgres;
  if (select grace_until from public.subscriptions where id = d1) <> v_today + 5 then
    insert into r1621_fail values ('grace_until want today+5, got ' || (select grace_until from public.subscriptions where id = d1));
  end if;
  select * into v_t from public.tasks where subscription_id = d1;
  if (v_t.due_at at time zone 'Asia/Kolkata')::date <> v_today + 6 or v_t.status::text <> 'pending'
     or v_t.notes not like '%+5 days given on%' then
    insert into r1621_fail values ('task not moved: ' || row_to_json(v_t)::text);
  end if;
  set local role service_role;
  perform pg_temp.r1621_as(null, 'service_role');
  -- a NEW term would get a new task: clear the stamp and ask again — still in grace now
  update public.subscriptions set grace_task_for = null where id = d1;
  v_r := public.raise_renewal_grace_task(d1);
  if v_r->>'why' is distinct from 'in_grace' then
    insert into r1621_fail values ('extended grace not honoured by the job: ' || v_r::text);
  end if;
  update public.subscriptions set grace_task_for = v_today - 10 where id = d1;

  set local role authenticated;
  perform pg_temp.r1621_as('e1621000-0000-4000-8000-0000000000a1');  -- owner
  v_e := pg_temp.r1621_decide(d1, 'stop', null);
  if v_e is not null then insert into r1621_fail values ('owner stop failed: ' || v_e); end if;
  set local role postgres;
  select status::text as status, renewal_state::text as rs, suspended_by, suspend_reason, suspended_at
    into v_s from public.subscriptions where id = d1;
  if v_s.status <> 'paused' or v_s.rs <> 'suspended' or v_s.suspended_by <> 'user'
     or v_s.suspend_reason not like 'Renewal due % not paid after grace%' or v_s.suspended_at is null then
    insert into r1621_fail values ('stop did not pause like before: ' || row_to_json(v_s)::text);
  end if;
  select * into v_t from public.tasks where subscription_id = d1;
  if v_t.status::text <> 'done' or v_t.completed_by is distinct from 'e1621000-0000-4000-8000-0000000000a1' then
    insert into r1621_fail values ('task not closed by the owner: ' || row_to_json(v_t)::text);
  end if;
  set local role authenticated;
  v_e := pg_temp.r1621_decide(d1, 'stop', null);
  if v_e is null or v_e not like '22023: This subscription is already paused%' then
    insert into r1621_fail values ('stopping twice not refused: ' || coalesce(v_e, 'ran'));
  end if;
  set local role postgres;
  select count(*) into v_n from public.activity_log
   where entity = 'subscriptions' and entity_id = d1::text and changes ? 'suspend_reason';
  if v_n < 1 then insert into r1621_fail values ('stop not in the activity log'); end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n') into v_list from r1621_fail;
  if v_list is not null then
    raise exception E'FAIL r1621_renewal_grace_task:\n%', v_list;
  end if;
  raise notice 'PASS r1621_renewal_grace_task';
end $$;

rollback;
