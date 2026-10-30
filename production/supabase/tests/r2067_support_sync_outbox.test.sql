-- R-2067 (29 Oct 2026) — the support-sync cron's two atomic steps.
--
-- support_sync_outbox rows were queued (trg_queue_support_sync) and never sent. The cron
-- /api/cron/support-sync now claims them with claim_support_sync_outbox and records each
-- send with finish_support_sync_outbox (migration 20261029000150).
--
-- CASES (self-asserting; every one raises on failure)
--   1. A new support subscription queues a row the claim returns, payload as the trigger built it.
--   2. A claimed row is leased: a second claim right after does not return it again.
--   3. One row per customer: a newer row for the same customer waits behind the older one.
--   4. 2xx → 'sent', sent_at set, last_error null; the customer's next row is then claimable.
--   5. A failure → still 'pending', attempts + 1, last_error kept, backed off (not due now).
--   6. The 5th failure → 'failed', not claimable again.
--   7. p_tenant_ids limits the claim to the companies the automation gate allows.
--   8. finish on a row that is not pending changes nothing (returns null).
--   9. Only service_role may call either function.
--
-- SAFETY: synthetic tenants, one transaction, ends in ROLLBACK.

begin;

select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

insert into public.tenants (id, name, email, doc_code, tier) values
  ('20670000-0000-4000-8000-0000000000a1', 'ZZ R2067 A', 'zz-r2067-a@example.invalid', 'ZZ2067A', 'reseller'),
  ('20670000-0000-4000-8000-0000000000b1', 'ZZ R2067 B', 'zz-r2067-b@example.invalid', 'ZZ2067B', 'reseller');

insert into public.customers (id, tenant_id, name, contact_email) values
  ('20670000-0000-4000-8000-0000000000c1', '20670000-0000-4000-8000-0000000000a1', 'ZZ R2067 Cust One', 'one@r2067.invalid'),
  ('20670000-0000-4000-8000-0000000000c2', '20670000-0000-4000-8000-0000000000a1', 'ZZ R2067 Cust Two', 'two@r2067.invalid'),
  ('20670000-0000-4000-8000-0000000000c3', '20670000-0000-4000-8000-0000000000b1', 'ZZ R2067 Cust Three', 'three@r2067.invalid');

-- Only these synthetic rows are looked at: anything already in the local outbox is parked.
update public.support_sync_outbox set next_attempt_at = now() + interval '1 day'
 where status = 'pending' and tenant_id not in ('20670000-0000-4000-8000-0000000000a1', '20670000-0000-4000-8000-0000000000b1');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date)
values
  ('20670000-0000-4000-8000-0000000000d1', '20670000-0000-4000-8000-0000000000a1', '20670000-0000-4000-8000-0000000000c1',
   'ZZ R2067 Cust One', 'Standard Support (Yearly)', 'support', 1, 833, 'active', current_date, (current_date + interval '1 year')::date),
  ('20670000-0000-4000-8000-0000000000d2', '20670000-0000-4000-8000-0000000000a1', '20670000-0000-4000-8000-0000000000c2',
   'ZZ R2067 Cust Two', 'Standard Support (Monthly)', 'support', 1, 999, 'active', current_date, (current_date + interval '1 month')::date),
  ('20670000-0000-4000-8000-0000000000d3', '20670000-0000-4000-8000-0000000000b1', '20670000-0000-4000-8000-0000000000c3',
   'ZZ R2067 Cust Three', 'Standard Support (Yearly)', 'support', 1, 833, 'active', current_date, (current_date + interval '1 year')::date);

do $$
declare
  v_a     uuid := '20670000-0000-4000-8000-0000000000a1';
  v_c1    uuid := '20670000-0000-4000-8000-0000000000c1';
  v_c2    uuid := '20670000-0000-4000-8000-0000000000c2';
  v_c3    uuid := '20670000-0000-4000-8000-0000000000c3';
  r       record;
  o       record;
  v_first uuid;
  v_newer uuid;
  v_c2row uuid;
  v_ids   uuid[];
  n       integer;
  v_st    text;
  i       integer;
begin
  -- ── 7 first: tenant A only ───────────────────────────────────────────────
  select array_agg(c.id), count(*) into v_ids, n
    from public.claim_support_sync_outbox(50, array[v_a]) c;
  if n <> 2 then
    raise exception 'CASE 7 FAIL: claim for tenant A returned % rows, expected 2 (cust one + two)', n;
  end if;
  if exists (select 1 from public.support_sync_outbox where id = any(v_ids) and tenant_id <> v_a) then
    raise exception 'CASE 7 FAIL: a claim limited to tenant A returned another company''s row';
  end if;
  if exists (select 1 from public.support_sync_outbox where customer_id = v_c3 and next_attempt_at is not null) then
    raise exception 'CASE 7 FAIL: tenant B''s row was leased by a claim that did not ask for it';
  end if;

  -- ── 1: the payload as the trigger built it ───────────────────────────────
  select * into o from public.support_sync_outbox where customer_id = v_c1;
  v_first := o.id;
  if o.payload->>'event_type' <> 'subscription.updated'
     or o.payload->'data'->>'email' <> 'one@r2067.invalid'
     or o.payload->'data'->>'plan' <> 'Standard Support (Yearly)'
     or o.payload->'data'->>'plan_status' <> 'active'
     or (o.payload->'data'->>'plan_expiry')::date <> (current_date + interval '1 year')::date then
    raise exception 'CASE 1 FAIL: payload not as the trigger builds it: %', o.payload;
  end if;

  -- ── 2: leased ────────────────────────────────────────────────────────────
  select count(*) into n from public.claim_support_sync_outbox(50, array[v_a]);
  if n <> 0 then
    raise exception 'CASE 2 FAIL: a second claim right after returned % leased rows again', n;
  end if;

  -- ── 3: one row per customer, oldest first ────────────────────────────────
  update public.subscriptions set renewal_date = renewal_date + 365
   where id = '20670000-0000-4000-8000-0000000000d1';
  select id into v_newer from public.support_sync_outbox
   where customer_id = v_c1 and id <> v_first;
  if v_newer is null then
    raise exception 'CASE 3 SETUP: the renewal change queued no second row';
  end if;
  -- one transaction = one now(): give the newer row the later time it has in real life
  update public.support_sync_outbox set created_at = created_at + interval '1 second' where id = v_newer;
  update public.support_sync_outbox set next_attempt_at = null where id = v_first;  -- lease ran out
  select array_agg(c.id) into v_ids from public.claim_support_sync_outbox(50, array[v_a]) c;
  if not (v_first = any(v_ids)) or v_newer = any(coalesce(v_ids, '{}')) then
    raise exception 'CASE 3 FAIL: claim returned % — expected the OLDER row % and not the newer %', v_ids, v_first, v_newer;
  end if;

  -- ── 4: 2xx → sent; the newer row is now next ─────────────────────────────
  v_st := public.finish_support_sync_outbox(v_first, true, null);
  select * into o from public.support_sync_outbox where id = v_first;
  if v_st <> 'sent' or o.status <> 'sent' or o.sent_at is null or o.last_error is not null or o.attempts <> 0 then
    raise exception 'CASE 4 FAIL: after ok → status %/% sent_at % last_error % attempts %', v_st, o.status, o.sent_at, o.last_error, o.attempts;
  end if;
  select array_agg(c.id) into v_ids from public.claim_support_sync_outbox(50, array[v_a]) c;
  if not (v_newer = any(coalesce(v_ids, '{}'))) then
    raise exception 'CASE 4 FAIL: after the older row was sent, the newer row % was not claimable (got %)', v_newer, v_ids;
  end if;

  -- ── 5: one failure ───────────────────────────────────────────────────────
  select id into v_c2row from public.support_sync_outbox where customer_id = v_c2;
  v_st := public.finish_support_sync_outbox(v_c2row, false, 'HTTP 500: Sync failed');
  select * into o from public.support_sync_outbox where id = v_c2row;
  if v_st <> 'pending' or o.status <> 'pending' or o.attempts <> 1 or o.last_error <> 'HTTP 500: Sync failed' then
    raise exception 'CASE 5 FAIL: after one failure → %/% attempts % last_error %', v_st, o.status, o.attempts, o.last_error;
  end if;
  if o.next_attempt_at is null or o.next_attempt_at <= now() then
    raise exception 'CASE 5 FAIL: a failed row is due again at once (next_attempt_at %) — no back-off', o.next_attempt_at;
  end if;
  if exists (select 1 from public.claim_support_sync_outbox(50, array[v_a]) c where c.id = v_c2row) then
    raise exception 'CASE 5 FAIL: a backed-off row was claimed before its time';
  end if;

  -- ── 6: the 5th failure → failed ──────────────────────────────────────────
  for i in 2 .. 5 loop
    v_st := public.finish_support_sync_outbox(v_c2row, false, 'HTTP 503 try ' || i);
  end loop;
  select * into o from public.support_sync_outbox where id = v_c2row;
  if v_st <> 'failed' or o.status <> 'failed' or o.attempts <> 5 or o.last_error <> 'HTTP 503 try 5' then
    raise exception 'CASE 6 FAIL: after 5 failures → %/% attempts % last_error %', v_st, o.status, o.attempts, o.last_error;
  end if;
  update public.support_sync_outbox set next_attempt_at = null where id = v_c2row;
  if exists (select 1 from public.claim_support_sync_outbox(50, array[v_a]) c where c.id = v_c2row) then
    raise exception 'CASE 6 FAIL: a failed row was claimed again';
  end if;

  -- ── 8: finish on a non-pending row is a no-op ────────────────────────────
  v_st := public.finish_support_sync_outbox(v_c2row, true, null);
  select * into o from public.support_sync_outbox where id = v_c2row;
  if v_st is not null or o.status <> 'failed' then
    raise exception 'CASE 8 FAIL: finish on a failed row returned % and left status %', v_st, o.status;
  end if;

  -- ── 7b: null tenant list = every company ─────────────────────────────────
  select count(*) into n from public.claim_support_sync_outbox(50, null) c where c.customer_id = v_c3;
  if n <> 1 then
    raise exception 'CASE 7 FAIL: a claim with no tenant list did not return tenant B''s row (% rows)', n;
  end if;

  raise notice 'R-2067: cases 1-8 pass';
end $$;

-- ── 9: only service_role ───────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.claim_support_sync_outbox(integer,uuid[])', 'execute')
     or has_function_privilege('anon', 'public.claim_support_sync_outbox(integer,uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.finish_support_sync_outbox(uuid,boolean,text)', 'execute')
     or has_function_privilege('anon', 'public.finish_support_sync_outbox(uuid,boolean,text)', 'execute') then
    raise exception 'CASE 9 FAIL: a signed-in user or anon can call the support-sync outbox functions';
  end if;
  if not has_function_privilege('service_role', 'public.claim_support_sync_outbox(integer,uuid[])', 'execute')
     or not has_function_privilege('service_role', 'public.finish_support_sync_outbox(uuid,boolean,text)', 'execute') then
    raise exception 'CASE 9 FAIL: service_role cannot call the support-sync outbox functions';
  end if;
  raise notice 'R-2067: case 9 pass';
end $$;

select 'PASS' as result;

rollback;
