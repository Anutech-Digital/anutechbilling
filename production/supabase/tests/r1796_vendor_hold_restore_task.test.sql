\set ON_ERROR_STOP on
-- R-1796: vendor renewal hold override ("Renew anyway", owner/manager, one term, logged) and
-- "Turn the service back on" task after a suspended subscription's renewal is paid.
-- Migration: 20261023134844_r1796_vendor_hold_restore_task.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1796_vendor_hold_restore_task.test.sql
--
-- Expect "PASS r1796_vendor_hold_restore_task".
--
--   OVERRIDE  billing refused (message); another company's owner refused; empty reason refused;
--             a renewal not yet due refused; manager → override_for = renewal_date + ONE
--             activity_log row; pressing again → "already", still one row; billing cannot
--             write vendor_hold_override_for directly
--   RESTORE   a suspended subscription paid (the record_payment update: status active,
--             renewal_state renewed, renewal_date rolled — run as the billing user) → ONE
--             "Turn the service back on — …" task (owner, vendor steps), term stamped;
--             a second payment → still one; suspended again for the same term and paid again
--             → still one; an active (never stopped) subscription paid → no restore task,
--             but its open "Stop service" task is closed; the override no longer matches the
--             new term (hold is term-scoped)

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1796000-0000-4000-8000-0000000000a1', 'r1796-owner@example.test'),
  ('e1796000-0000-4000-8000-0000000000a2', 'r1796-manager@example.test'),
  ('e1796000-0000-4000-8000-0000000000a3', 'r1796-billing@example.test'),
  ('e1796000-0000-4000-8000-0000000000b1', 'r1796-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1796000-0000-0000-0000-0000000000a0', 'R1796 A', 'r1796a@example.in', '07', 'R17A'),
  ('e1796000-0000-0000-0000-0000000000b0', 'R1796 B', 'r1796b@example.in', '07', 'R17B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1796000-0000-4000-8000-0000000000a1', 'e1796000-0000-0000-0000-0000000000a0', 'r1796-owner@example.in',   'R1796 Owner',   'owner',   true),
  ('e1796000-0000-4000-8000-0000000000a2', 'e1796000-0000-0000-0000-0000000000a0', 'r1796-manager@example.in', 'R1796 Manager', 'manager', true),
  ('e1796000-0000-4000-8000-0000000000a3', 'e1796000-0000-0000-0000-0000000000a0', 'r1796-billing@example.in', 'R1796 Billing', 'billing', true),
  ('e1796000-0000-4000-8000-0000000000b1', 'e1796000-0000-0000-0000-0000000000b0', 'r1796-owner-b@example.in', 'R1796 Owner B', 'owner',   true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1796000-0000-4000-8000-0000000000c1', 'e1796000-0000-0000-0000-0000000000a0', 'R1796 Late Co', '07', 'India');

-- d1: stopped by the owner (paused + suspended), renewal 10 days ago.
-- d2: active, renewal 10 days ago, grace over, owner's "Stop service" task open.
-- d3: renews in 5 days (not on hold).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status,
                                  renewal_date, renewal_state, suspended_by) values
  ('e1796000-0000-4000-8000-0000000000d1', 'e1796000-0000-0000-0000-0000000000a0', 'e1796000-0000-4000-8000-0000000000c1', 'R1796 Late Co', 'Business Starter', 'google', 5, 1350, 'paused',
   (now() at time zone 'Asia/Kolkata')::date - 10, 'suspended', 'user'),
  ('e1796000-0000-4000-8000-0000000000d2', 'e1796000-0000-0000-0000-0000000000a0', 'e1796000-0000-4000-8000-0000000000c1', 'R1796 Late Co', 'Business Plus',    'google', 2, 1700, 'active',
   (now() at time zone 'Asia/Kolkata')::date - 10, 'grace_period', null),
  ('e1796000-0000-4000-8000-0000000000d3', 'e1796000-0000-0000-0000-0000000000a0', 'e1796000-0000-4000-8000-0000000000c1', 'R1796 Late Co', 'Vault',            'google', 1,  300, 'active',
   (now() at time zone 'Asia/Kolkata')::date + 5, 'reminder_4', null);

-- d4: stopped by the owner; its renewal quote is paid through the REAL record_payment.
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('e1796000-0000-0000-0000-0000000000a0', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9700);
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, suspended_by) values
  ('e1796000-0000-4000-8000-0000000000d4', 'e1796000-0000-0000-0000-0000000000a0', 'e1796000-0000-4000-8000-0000000000c1', 'R1796 Late Co',
   'Google Workspace Business Starter', 'google', 5, 680, 'paused', 12,
   (now() at time zone 'Asia/Kolkata')::date - 375, (now() at time zone 'Asia/Kolkata')::date - 10, 'suspended', 'user');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, status, payment_status, line_items,
                           is_renewal, extension_months, renewal_subscription_id, renewal_term_date) values
  ('Q-R1796-REN', 'e1796000-0000-0000-0000-0000000000a0', 'e1796000-0000-4000-8000-0000000000c1', 'R1796 Late Co',
   9629, 8160, 'sent', 'awaiting',
   '[{"name":"Google Workspace Business Starter","qty":5,"rate":1632,"commitment":"annual_yearly"}]'::jsonb,
   true, 12, 'e1796000-0000-4000-8000-0000000000d4', (now() at time zone 'Asia/Kolkata')::date - 10);
update public.subscriptions set renewal_quote_id = 'Q-R1796-REN' where id = 'e1796000-0000-4000-8000-0000000000d4';

insert into public.tasks (tenant_id, owner_id, title, kind, due_at, subscription_id) values
  ('e1796000-0000-0000-0000-0000000000a0', 'e1796000-0000-4000-8000-0000000000a1', 'Stop service — R1796 Late Co · Business Plus · ₹2,000 due', 'followup', now(), 'e1796000-0000-4000-8000-0000000000d2');

create temp table r1796_fail (msg text) on commit drop;
grant all on r1796_fail to authenticated, service_role;

create function pg_temp.r1796_as(p_sub text, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role)::text, true);
end $$;
create function pg_temp.r1796_renew(p_sub uuid, p_reason text) returns text language plpgsql as $$
begin
  perform public.renew_anyway(p_sub, p_reason);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.r1796_as(text, text) to authenticated, service_role;
grant execute on function pg_temp.r1796_renew(uuid, text) to authenticated, service_role;

do $$
declare
  a  constant uuid := 'e1796000-0000-0000-0000-0000000000a0';
  d1 constant uuid := 'e1796000-0000-4000-8000-0000000000d1';
  d2 constant uuid := 'e1796000-0000-4000-8000-0000000000d2';
  d3 constant uuid := 'e1796000-0000-4000-8000-0000000000d3';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_term  date := (now() at time zone 'Asia/Kolkata')::date - 10;
  v_e text; v_r jsonb; v_n int; v_t record;
begin
  -- ════ OVERRIDE ════════════════════════════════════════════════════════════════════
  set local role authenticated;
  perform pg_temp.r1796_as('e1796000-0000-4000-8000-0000000000a3');  -- billing
  v_e := pg_temp.r1796_renew(d2, 'customer pays Friday');
  if v_e is null or v_e not like '42501: Only the owner or a manager can renew before payment%' then
    insert into r1796_fail values ('billing renew_anyway not refused properly: ' || coalesce(v_e, 'allowed'));
  end if;
  begin
    update public.subscriptions set vendor_hold_override_for = v_term where id = d2;
    if found then insert into r1796_fail values ('billing wrote vendor_hold_override_for directly'); end if;
  exception when others then
    if sqlerrm not like 'Only the owner or a manager can override a vendor renewal hold%' then
      insert into r1796_fail values ('billing direct write refused with wrong message: ' || sqlerrm);
    end if;
  end;

  perform pg_temp.r1796_as('e1796000-0000-4000-8000-0000000000b1');  -- other company's owner
  v_e := pg_temp.r1796_renew(d2, 'customer pays Friday');
  if v_e is null or v_e not like '42501: That subscription was not found in your company%' then
    insert into r1796_fail values ('other company renew_anyway not refused: ' || coalesce(v_e, 'allowed'));
  end if;

  perform pg_temp.r1796_as('e1796000-0000-4000-8000-0000000000a2');  -- manager
  v_e := pg_temp.r1796_renew(d2, '  ');
  if v_e is null or v_e not like '22023: Write why you are renewing before payment%' then
    insert into r1796_fail values ('empty reason not refused: ' || coalesce(v_e, 'allowed'));
  end if;
  v_e := pg_temp.r1796_renew(d3, 'early');
  if v_e is null or v_e not like '22023: This renewal is not on hold%' then
    insert into r1796_fail values ('not-due renewal not refused: ' || coalesce(v_e, 'allowed'));
  end if;
  v_e := pg_temp.r1796_renew(d2, 'customer pays Friday');
  if v_e is not null then insert into r1796_fail values ('manager renew_anyway failed: ' || v_e); end if;
  v_e := pg_temp.r1796_renew(d2, 'pressed twice');
  if v_e is not null then insert into r1796_fail values ('second renew_anyway failed: ' || v_e); end if;

  reset role;
  perform pg_temp.r1796_as(null, 'service_role');
  if (select vendor_hold_override_for from public.subscriptions where id = d2) is distinct from v_term then
    insert into r1796_fail values ('override_for not set to the term');
  end if;
  select count(*) into v_n from public.activity_log
   where tenant_id = a and entity = 'subscription' and entity_id = d2::text and action = 'subscription.renew_anyway';
  if v_n <> 1 then insert into r1796_fail values ('activity_log rows for renew_anyway = ' || v_n || ' (want 1)'); end if;
  select count(*) into v_n from public.activity_log
   where tenant_id = a and action = 'subscription.renew_anyway'
     and user_id = 'e1796000-0000-4000-8000-0000000000a2' and changes->>'reason' = 'customer pays Friday';
  if v_n <> 1 then insert into r1796_fail values ('activity_log row lacks who/why'); end if;

  -- ════ RESTORE ═════════════════════════════════════════════════════════════════════
  -- The record_payment roll-forward, as the billing user (record_payment is SECURITY DEFINER,
  -- so the row write runs as the owner role with the caller's auth.uid()).
  perform pg_temp.r1796_as('e1796000-0000-4000-8000-0000000000a3');
  update public.subscriptions
     set renewal_state = 'renewed', renewal_date = (renewal_date + interval '12 months')::date,
         reminder_count = 0, status = 'active'
   where id = d1;

  select count(*) into v_n from public.tasks
   where tenant_id = a and subscription_id = d1 and title like 'Turn the service back on — %';
  if v_n <> 1 then insert into r1796_fail values ('restore tasks after payment = ' || v_n || ' (want 1)'); end if;
  select * into v_t from public.tasks
   where tenant_id = a and subscription_id = d1 and title like 'Turn the service back on — %' limit 1;
  if v_t.owner_id is distinct from 'e1796000-0000-4000-8000-0000000000a1'::uuid then
    insert into r1796_fail values ('restore task not given to the owner');
  end if;
  if v_t.title <> 'Turn the service back on — R1796 Late Co · Business Starter' then
    insert into r1796_fail values ('restore task title: ' || v_t.title);
  end if;
  if v_t.notes not like '%Google Admin%reactivate%' then
    insert into r1796_fail values ('restore task lacks the Google steps: ' || coalesce(v_t.notes, 'null'));
  end if;
  if (select service_restore_task_for from public.subscriptions where id = d1) is distinct from v_term then
    insert into r1796_fail values ('restore term not stamped');
  end if;

  -- paid twice (the sub is active already) → still one
  update public.subscriptions set renewal_date = (renewal_date + interval '12 months')::date where id = d1;
  -- stopped again for the SAME term and paid again (a re-run) → still one
  perform pg_temp.r1796_as(null, 'service_role');
  update public.subscriptions set status = 'paused', renewal_state = 'suspended', renewal_date = v_term where id = d1;
  perform pg_temp.r1796_as('e1796000-0000-4000-8000-0000000000a3');
  update public.subscriptions
     set renewal_state = 'renewed', renewal_date = (renewal_date + interval '12 months')::date, status = 'active'
   where id = d1;
  select count(*) into v_n from public.tasks
   where tenant_id = a and subscription_id = d1 and title like 'Turn the service back on — %';
  if v_n <> 1 then insert into r1796_fail values ('restore tasks after twice-paid / re-run = ' || v_n || ' (want 1)'); end if;

  -- an active (never stopped) subscription is paid → no restore task; its Stop service task closes
  update public.subscriptions
     set renewal_state = 'renewed', renewal_date = (renewal_date + interval '12 months')::date, status = 'active'
   where id = d2;
  select count(*) into v_n from public.tasks
   where tenant_id = a and subscription_id = d2 and title like 'Turn the service back on — %';
  if v_n <> 0 then insert into r1796_fail values ('restore task for a never-stopped subscription'); end if;
  select count(*) into v_n from public.tasks
   where tenant_id = a and subscription_id = d2 and title like 'Stop service — %' and status = 'pending';
  if v_n <> 0 then insert into r1796_fail values ('Stop service task still open after payment'); end if;
  -- the override was for the old term only
  if (select vendor_hold_override_for = renewal_date from public.subscriptions where id = d2) then
    insert into r1796_fail values ('override carried into the new term');
  end if;

  -- the REAL record_payment on a stopped subscription's renewal quote → one restore task
  perform pg_temp.r1796_as(null, 'service_role');
  v_r := public.record_payment('Q-R1796-REN', 9629, 'bank_transfer', 'r1796-ren');
  if not coalesce((v_r->>'renewal_rolled_forward')::boolean, false) then
    insert into r1796_fail values ('record_payment did not roll the renewal: ' || v_r::text);
  end if;
  if (select status::text from public.subscriptions where id = 'e1796000-0000-4000-8000-0000000000d4') <> 'active' then
    insert into r1796_fail values ('record_payment left the stopped subscription inactive');
  end if;
  select count(*) into v_n from public.tasks
   where tenant_id = a and subscription_id = 'e1796000-0000-4000-8000-0000000000d4' and title like 'Turn the service back on — %';
  if v_n <> 1 then insert into r1796_fail values ('restore tasks after record_payment = ' || v_n || ' (want 1)'); end if;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n') into v_msgs from r1796_fail;
  if v_msgs is not null then
    raise exception E'FAIL r1796_vendor_hold_restore_task:\n%', v_msgs;
  end if;
  raise notice 'PASS r1796_vendor_hold_restore_task';
end $$;

rollback;
