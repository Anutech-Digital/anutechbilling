\set ON_ERROR_STOP on
-- R-1681 (P1): a person's pause needs a reason; a pause "for this unpaid invoice" comes back on
-- when the invoice is paid (like the automatic pause), with a bell notice to turn licences on.
-- Migration: 20261019130206_r1681_manual_suspend_reason.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1681_manual_suspend_resume.test.sql
--
-- Expect "PASS r1681_manual_suspend_resume".
--
--   REASON    suspend_subscription with no reason → refused; a direct "status = paused" row
--             update by a signed-in person with no reason → refused; with one → kept, by 'user'
--   LINK      for_unpaid links the oldest unpaid invoice of the subscription; reason in the
--             activity log; none unpaid → refused with the next step
--   GUARDS    sales role, another company, a cancelled subscription → refused
--   RESUME    record_payment settles that invoice → subscription active, pause fields cleared,
--             ai_action_log row (paused_by user), bell notice to owner/billing
--   KEPT      a pause with a reason but NOT for an unpaid invoice stays paused after payment

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1681000-0000-4000-8000-0000000000a1', 'r1681-owner@example.test'),
  ('e1681000-0000-4000-8000-0000000000a2', 'r1681-billing@example.test'),
  ('e1681000-0000-4000-8000-0000000000a3', 'r1681-sales@example.test'),
  ('e1681000-0000-4000-8000-0000000000b1', 'r1681-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1681000-0000-0000-0000-0000000000a0', 'R1681 A', 'r1681a@example.in', '07', 'R18A'),
  ('e1681000-0000-0000-0000-0000000000b0', 'R1681 B', 'r1681b@example.in', '07', 'R18B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1681000-0000-4000-8000-0000000000a1', 'e1681000-0000-0000-0000-0000000000a0', 'r1681-owner@example.in',   'R1681 Owner',   'owner',   true),
  ('e1681000-0000-4000-8000-0000000000a2', 'e1681000-0000-0000-0000-0000000000a0', 'r1681-billing@example.in', 'R1681 Billing', 'billing', true),
  ('e1681000-0000-4000-8000-0000000000a3', 'e1681000-0000-0000-0000-0000000000a0', 'r1681-sales@example.in',   'R1681 Sales',   'sales',   true),
  ('e1681000-0000-4000-8000-0000000000b1', 'e1681000-0000-0000-0000-0000000000b0', 'r1681-owner-b@example.in', 'R1681 Owner B', 'owner',   true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1681000-0000-4000-8000-0000000000c1', 'e1681000-0000-0000-0000-0000000000a0', 'R1681 T-18', '07', 'India');

-- Two unpaid invoices on the subscription's quote: the OLDER one is linked.
insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, due_date, status, quote_id) values
  ('R18-OLD', 'e1681000-0000-0000-0000-0000000000a0', 'R1681 T-18', 'e1681000-0000-4000-8000-0000000000c1', 3823, 3823, 3240, '2026-09-01', '2026-09-15', 'overdue', null),
  ('R18-NEW', 'e1681000-0000-0000-0000-0000000000a0', 'R1681 T-18', 'e1681000-0000-4000-8000-0000000000c1', 1180, 1180, 1000, '2026-10-01', '2026-10-15', 'pending', null),
  ('R18-K',   'e1681000-0000-0000-0000-0000000000a0', 'R1681 T-18', 'e1681000-0000-4000-8000-0000000000c1', 1180, 1180, 1000, '2026-09-01', '2026-09-15', 'overdue', null);

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id) values
  ('Q-R18-OLD', 'e1681000-0000-0000-0000-0000000000a0', null, 'e1681000-0000-4000-8000-0000000000c1', 'R1681 T-18', 3823, 3240, 18, 'accepted', 'invoiced', '[]'::jsonb, 'R18-OLD'),
  ('Q-R18-K',   'e1681000-0000-0000-0000-0000000000a0', null, 'e1681000-0000-4000-8000-0000000000c1', 'R1681 T-18', 1180, 1000, 18, 'accepted', 'invoiced', '[]'::jsonb, 'R18-K');
update public.invoices set quote_id = 'Q-R18-OLD' where id = 'R18-OLD';
update public.invoices set quote_id = 'Q-R18-K' where id = 'R18-K';

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, quote_id) values
  ('e1681000-0000-4000-8000-0000000000d1', 'e1681000-0000-0000-0000-0000000000a0', 'e1681000-0000-4000-8000-0000000000c1', 'R1681 T-18', 'Business Starter', 'google', 5, 1350, 'active', 'Q-R18-OLD'),
  ('e1681000-0000-4000-8000-0000000000d2', 'e1681000-0000-0000-0000-0000000000a0', 'e1681000-0000-4000-8000-0000000000c1', 'R1681 T-18', 'Business Plus',    'google', 2, 1700, 'active', 'Q-R18-K'),
  ('e1681000-0000-4000-8000-0000000000d3', 'e1681000-0000-0000-0000-0000000000a0', 'e1681000-0000-4000-8000-0000000000c1', 'R1681 T-18', 'Vault',            'google', 1,  300, 'active', null),
  ('e1681000-0000-4000-8000-0000000000d4', 'e1681000-0000-0000-0000-0000000000a0', 'e1681000-0000-4000-8000-0000000000c1', 'R1681 T-18', 'Old plan',         'google', 1,  300, 'cancelled', null);
-- R18-NEW bills d1 as an instalment (newer than R18-OLD, so not the one linked).
insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, invoice_id)
values ('e1681000-0000-0000-0000-0000000000a0', 'e1681000-0000-4000-8000-0000000000d1', '2026-10-01', 1, '2026-10-01', '2026-10-01', '2026-10-31', 1000, 18, 'R18-NEW');

create temp table r1681_fail (msg text) on commit drop;
grant all on r1681_fail to authenticated;

create function pg_temp.r1681_try(p_sub uuid, p_reason text, p_for_unpaid boolean) returns text language plpgsql as $$
begin
  perform public.suspend_subscription(p_sub, p_reason, p_for_unpaid);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r1681_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r1681_try(uuid, text, boolean) to authenticated;
grant execute on function pg_temp.r1681_as(text) to authenticated;

do $$
declare
  d1 constant uuid := 'e1681000-0000-4000-8000-0000000000d1';
  d2 constant uuid := 'e1681000-0000-4000-8000-0000000000d2';
  d3 constant uuid := 'e1681000-0000-4000-8000-0000000000d3';
  v_e text; v_r jsonb; v_s record; v_n int;
begin
  set local role authenticated;
  perform pg_temp.r1681_as('e1681000-0000-4000-8000-0000000000a2');

  -- ════ REASON ══════════════════════════════════════════════════════════════════════
  v_e := pg_temp.r1681_try(d1, '  ', true);
  if v_e is null or v_e not like '22023: Write why this subscription is being paused%' then
    insert into r1681_fail values ('pause without a reason not refused: ' || coalesce(v_e, 'ran'));
  end if;
  begin
    update public.subscriptions set status = 'paused' where id = d3;
    insert into r1681_fail values ('direct pause with no reason was allowed');
  exception when others then
    if sqlerrm not like 'Write why this subscription is being paused%' then
      insert into r1681_fail values ('direct pause refused with wrong message: ' || sqlerrm);
    end if;
  end;

  -- ════ GUARDS ══════════════════════════════════════════════════════════════════════
  v_e := pg_temp.r1681_try('e1681000-0000-4000-8000-0000000000d4', 'Customer asked', false);
  if v_e is null or v_e not like '22023: This subscription is cancelled%' then
    insert into r1681_fail values ('cancelled subscription paused: ' || coalesce(v_e, 'ran'));
  end if;
  v_e := pg_temp.r1681_try(d3, 'Unpaid', true);
  if v_e is null or v_e not like '22023: No unpaid invoice was found for this subscription%' then
    insert into r1681_fail values ('for_unpaid with no invoice not refused: ' || coalesce(v_e, 'ran'));
  end if;
  perform pg_temp.r1681_as('e1681000-0000-4000-8000-0000000000a3');
  v_e := pg_temp.r1681_try(d1, 'Unpaid invoice', true);
  if v_e is null or v_e not like '42501: Only an owner, manager, accountant or billing user%' then
    insert into r1681_fail values ('sales role paused: ' || coalesce(v_e, 'ran'));
  end if;
  perform pg_temp.r1681_as('e1681000-0000-4000-8000-0000000000b1');
  v_e := pg_temp.r1681_try(d1, 'Unpaid invoice', true);
  if v_e is null or v_e not like '42501: That subscription was not found in your company%' then
    insert into r1681_fail values ('other company paused it: ' || coalesce(v_e, 'ran'));
  end if;
  perform pg_temp.r1681_as('e1681000-0000-4000-8000-0000000000a2');

  -- ════ LINK ════════════════════════════════════════════════════════════════════════
  begin
    v_r := public.suspend_subscription(d1, 'INV R18-OLD 34 din se baaki', true);
    if v_r->>'invoice_id' is distinct from 'R18-OLD' or (v_r->>'invoice_due')::int <> 3823 then
      insert into r1681_fail values ('wrong invoice linked: ' || v_r::text);
    end if;
  exception when others then insert into r1681_fail values ('pause for unpaid raised: ' || sqlerrm);
  end;
  -- reason only, not tied to the invoice
  begin
    perform public.suspend_subscription(d2, 'Customer ne khud roka', false);
  exception when others then insert into r1681_fail values ('reason-only pause raised: ' || sqlerrm);
  end;
  -- direct update with a reason (Correct details on an old screen)
  begin
    update public.subscriptions set status = 'paused', suspend_reason = 'Galat entry thi' where id = d3;
  exception when others then insert into r1681_fail values ('direct pause with a reason refused: ' || sqlerrm);
  end;

  set local role postgres;
  select status::text as status, suspended_by, suspended_invoice_id, resume_when_paid, suspend_reason, suspended_at into v_s
    from public.subscriptions where id = d1;
  if v_s.status <> 'paused' or v_s.suspended_by <> 'user' or v_s.suspended_invoice_id <> 'R18-OLD'
     or not v_s.resume_when_paid or v_s.suspend_reason <> 'INV R18-OLD 34 din se baaki' or v_s.suspended_at is null then
    insert into r1681_fail values ('d1 pause fields wrong: ' || row_to_json(v_s)::text);
  end if;
  select status::text as status, suspended_by, suspended_invoice_id, resume_when_paid into v_s
    from public.subscriptions where id = d2;
  if v_s.status <> 'paused' or v_s.suspended_invoice_id is not null or v_s.resume_when_paid then
    insert into r1681_fail values ('d2 reason-only pause wrong: ' || row_to_json(v_s)::text);
  end if;
  select status::text as status, suspended_by, suspended_at into v_s from public.subscriptions where id = d3;
  if v_s.status <> 'paused' or v_s.suspended_by is distinct from 'user' or v_s.suspended_at is null then
    insert into r1681_fail values ('d3 direct pause not stamped user/at: ' || row_to_json(v_s)::text);
  end if;
  select count(*) into v_n from public.activity_log
   where entity = 'subscriptions' and entity_id = d1::text
     and changes->'suspend_reason'->>'new' = 'INV R18-OLD 34 din se baaki';
  if v_n < 1 then insert into r1681_fail values ('reason not in the activity log'); end if;

  -- ════ RESUME: the customer pays R18-OLD in full ═══════════════════════════════════
  set local role authenticated;
  begin
    perform public.record_payment('Q-R18-OLD', 3823, 'upi', '402312345678', null);
  exception when others then insert into r1681_fail values ('record_payment raised: ' || sqlerrm);
  end;
  -- and the other subscription's invoice too — its reason-only pause must stay
  begin
    perform public.record_payment('Q-R18-K', 1180, 'upi', '402312345679', null);
  exception when others then insert into r1681_fail values ('record_payment K raised: ' || sqlerrm);
  end;
  set local role postgres;

  select status::text as status, suspended_by, suspended_invoice_id, resume_when_paid, suspend_reason into v_s
    from public.subscriptions where id = d1;
  if v_s.status <> 'active' or v_s.suspended_by is not null or v_s.suspended_invoice_id is not null
     or v_s.resume_when_paid or v_s.suspend_reason is not null then
    insert into r1681_fail values ('paid invoice did not resume d1: ' || row_to_json(v_s)::text
      || ' invoice ' || (select status::text || '/' || coalesce(paid_amount, 0) from public.invoices where id = 'R18-OLD'));
  end if;
  if not exists (select 1 from public.ai_action_log where entity_id = d1::text and action = 'subscription.overdue_resume'
                  and facts->>'paused_by' = 'user' and facts->>'invoice_id' = 'R18-OLD') then
    insert into r1681_fail values ('no ai_action_log resume row for d1');
  end if;
  select count(*) into v_n from public.notifications
   where entity_id = d1::text and kind = 'subscription.resumed' and body like '%Turn the licences back on%';
  if v_n <> 2 then insert into r1681_fail values ('want 2 bell notices (owner + billing), got ' || v_n); end if;
  if exists (select 1 from public.notifications where entity_id = d1::text
              and user_id = 'e1681000-0000-4000-8000-0000000000a3') then
    insert into r1681_fail values ('sales user was notified');
  end if;

  -- ════ KEPT ════════════════════════════════════════════════════════════════════════
  if (select status::text from public.subscriptions where id = d2) <> 'paused' then
    insert into r1681_fail values ('a reason-only pause was undone by a payment');
  end if;

  -- resuming by hand clears the pause fields
  set local role authenticated;
  update public.subscriptions set status = 'active' where id = d3;
  set local role postgres;
  if exists (select 1 from public.subscriptions where id = d3 and (suspend_reason is not null or suspended_by is not null or suspended_at is not null)) then
    insert into r1681_fail values ('manual resume left pause fields behind');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r1681_fail;
  if v_msgs is not null then
    raise exception E'FAIL r1681_manual_suspend_resume:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r1681_manual_suspend_resume';
end $$;

rollback;
