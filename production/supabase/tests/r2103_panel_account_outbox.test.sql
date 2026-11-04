-- R-2103 (29 Oct 2026) — every buyer gets a customer panel (DMS) account.
--
-- A received payment queues ONE panel_account_outbox row per customer (trigger on payments,
-- whichever RPC wrote it); the cron claims and finishes it; staff see needs_email / failed and
-- run the go-live backfill. Migration 20261029114000_r2103_panel_account_outbox.sql.
--
-- CASES (self-asserting; every one raises on failure)
--   1. A received payment on a quote (payments.customer_id null) queues the quote's customer, 'pending'.
--   2. A second payment for the same customer adds no row (one account per customer).
--   3. A customer without a valid email is queued as 'needs_email' and is not claimed.
--   4. Saving an email on that customer puts the row back to 'pending'.
--   5. A refunded-at-insert payment queues nothing.
--   6. claim returns the customer details and leases the row (second claim: nothing).
--   7. finish 'done' stores dms_user_id; 'retry' x5 → 'failed'; 'wait' keeps attempts.
--   8. p_tenant_ids / p_customer_id limit the claim.
--   9. mark_panel_account_linked turns a row done with the DMS user id (dms-panel order).
--  10. Backfill: dry run counts and writes nothing; the real run queues; a second run queues 0.
--  11. Staff RPCs refuse a non-staff role and see only their own company.
--  12. Only service_role may claim / finish / mark linked.
--
-- SAFETY: synthetic tenants, one transaction, ends in ROLLBACK.

begin;

select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

insert into public.tenants (id, name, email, doc_code, tier) values
  ('21030000-0000-4000-8000-0000000000a1', 'ZZ R2103 A', 'zz-r2103-a@example.invalid', 'ZZ2103A', 'reseller'),
  ('21030000-0000-4000-8000-0000000000b1', 'ZZ R2103 B', 'zz-r2103-b@example.invalid', 'ZZ2103B', 'reseller');

insert into public.customers (id, tenant_id, name, contact_email, contact_name, contact_mobile, gstin, customer_number) values
  ('21030000-0000-4000-8000-0000000000c1', '21030000-0000-4000-8000-0000000000a1', 'ZZ R2103 One Pvt Ltd', 'One@R2103.invalid', 'Asha Verma', '9876543210', null, 'C-2103'),
  ('21030000-0000-4000-8000-0000000000c2', '21030000-0000-4000-8000-0000000000a1', 'ZZ R2103 Two', null, null, null, null, null),
  ('21030000-0000-4000-8000-0000000000c3', '21030000-0000-4000-8000-0000000000b1', 'ZZ R2103 Three', 'three@r2103.invalid', null, null, null, null),
  ('21030000-0000-4000-8000-0000000000c4', '21030000-0000-4000-8000-0000000000a1', 'ZZ R2103 Four (old customer)', 'four@r2103.invalid', null, null, null, null),
  ('21030000-0000-4000-8000-0000000000c5', '21030000-0000-4000-8000-0000000000a1', 'ZZ R2103 Five (never paid)', 'five@r2103.invalid', null, null, null, null);

-- Only these synthetic rows are looked at: anything already in the local outbox is parked.
update public.panel_account_outbox set next_attempt_at = now() + interval '1 day'
 where status = 'pending' and tenant_id not in ('21030000-0000-4000-8000-0000000000a1', '21030000-0000-4000-8000-0000000000b1');

insert into public.quotes (id, tenant_id, customer_id, customer_name) values
  ('ZZ2103-Q1', '21030000-0000-4000-8000-0000000000a1', '21030000-0000-4000-8000-0000000000c1', 'ZZ R2103 One Pvt Ltd'),
  ('ZZ2103-Q2', '21030000-0000-4000-8000-0000000000a1', '21030000-0000-4000-8000-0000000000c2', 'ZZ R2103 Two'),
  ('ZZ2103-Q3', '21030000-0000-4000-8000-0000000000b1', '21030000-0000-4000-8000-0000000000c3', 'ZZ R2103 Three'),
  ('ZZ2103-Q5', '21030000-0000-4000-8000-0000000000a1', '21030000-0000-4000-8000-0000000000c5', 'ZZ R2103 Five');

do $$
declare
  v_a  uuid := '21030000-0000-4000-8000-0000000000a1';
  v_b  uuid := '21030000-0000-4000-8000-0000000000b1';
  v_c1 uuid := '21030000-0000-4000-8000-0000000000c1';
  v_c2 uuid := '21030000-0000-4000-8000-0000000000c2';
  v_c3 uuid := '21030000-0000-4000-8000-0000000000c3';
  v_c4 uuid := '21030000-0000-4000-8000-0000000000c4';
  v_c5 uuid := '21030000-0000-4000-8000-0000000000c5';
  o    record;
  r    record;
  n    integer;
  v_st text;
  v_j  jsonb;
  i    integer;
begin
  -- ── 1 ─────────────────────────────────────────────────────────────────────
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status)
  values (v_a, 'ZZ2103-Q1', 1000, 'upi', 'ZZ2103-UTR1', 'received');
  select * into o from public.panel_account_outbox where customer_id = v_c1;
  if not found or o.status <> 'pending' or o.tenant_id <> v_a or o.source <> 'payment' then
    raise exception 'CASE 1 FAIL: a received payment on Q1 did not queue customer one as pending (got %)', o.status;
  end if;

  -- ── 2 ─────────────────────────────────────────────────────────────────────
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status)
  values (v_a, 'ZZ2103-Q1', 500, 'upi', 'ZZ2103-UTR1b', 'received');
  select count(*) into n from public.panel_account_outbox where customer_id = v_c1;
  if n <> 1 then raise exception 'CASE 2 FAIL: % rows for customer one, expected 1', n; end if;

  -- ── 3 ─────────────────────────────────────────────────────────────────────
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status)
  values (v_a, 'ZZ2103-Q2', 700, 'cash', 'ZZ2103-CASH2', 'received');
  select status into v_st from public.panel_account_outbox where customer_id = v_c2;
  if v_st is distinct from 'needs_email' then
    raise exception 'CASE 3 FAIL: customer without email queued as %, expected needs_email', v_st;
  end if;

  -- ── 5 ─────────────────────────────────────────────────────────────────────
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, refunded_at, refund_reason)
  values (v_a, 'ZZ2103-Q5', 300, 'upi', 'ZZ2103-UTR5', 'refunded', now(), 'test');
  if exists (select 1 from public.panel_account_outbox where customer_id = v_c5) then
    raise exception 'CASE 5 FAIL: a refunded payment queued a panel account';
  end if;

  insert into public.payments (tenant_id, quote_id, amount, method, reference, status)
  values (v_b, 'ZZ2103-Q3', 900, 'upi', 'ZZ2103-UTR3', 'received');

  -- ── 8: tenant + customer filter ───────────────────────────────────────────
  select count(*) into n from public.claim_panel_account_outbox(50, array[v_b], null);
  if n <> 1 then raise exception 'CASE 8 FAIL: claim for tenant B returned % rows, expected 1', n; end if;
  if exists (select 1 from public.panel_account_outbox where customer_id = v_c1 and next_attempt_at is not null) then
    raise exception 'CASE 8 FAIL: a claim for tenant B leased tenant A''s row';
  end if;

  -- ── 6 ─────────────────────────────────────────────────────────────────────
  select * into r from public.claim_panel_account_outbox(50, null, v_c1);
  if r.customer_id is distinct from v_c1 or r.email <> 'one@r2103.invalid' or r.phone <> '9876543210'
     or r.contact_name <> 'Asha Verma' or r.customer_number <> 'C-2103' then
    raise exception 'CASE 6 FAIL: claim did not return customer one''s details (got % / % / %)', r.email, r.phone, r.customer_number;
  end if;
  select count(*) into n from public.claim_panel_account_outbox(50, array[v_a], null);
  if n <> 0 then raise exception 'CASE 6/3 FAIL: second claim for tenant A returned % rows (leased row or needs_email row)', n; end if;

  -- ── 7 ─────────────────────────────────────────────────────────────────────
  v_st := public.finish_panel_account_outbox(r.id, 'done', 'dms-user-77', null);
  select * into o from public.panel_account_outbox where id = r.id;
  if v_st <> 'done' or o.dms_user_id <> 'dms-user-77' or o.done_at is null then
    raise exception 'CASE 7 FAIL: done did not store the DMS user (status %, user %)', v_st, o.dms_user_id;
  end if;
  if public.finish_panel_account_outbox(r.id, 'retry', null, 'late') is not null then
    raise exception 'CASE 7 FAIL: finish on a done row changed it';
  end if;

  select id into r from public.panel_account_outbox where customer_id = v_c3;
  v_st := public.finish_panel_account_outbox(r.id, 'wait', null, 'gate_closed: off');
  select * into o from public.panel_account_outbox where id = r.id;
  if v_st <> 'pending' or o.attempts <> 0 or o.next_attempt_at < now() + interval '50 minutes' then
    raise exception 'CASE 7 FAIL: wait should keep attempts 0 and wait an hour (status %, attempts %)', v_st, o.attempts;
  end if;
  for i in 1..5 loop
    update public.panel_account_outbox set next_attempt_at = null where id = r.id;
    v_st := public.finish_panel_account_outbox(r.id, 'retry', null, 'unreachable: down');
  end loop;
  select * into o from public.panel_account_outbox where id = r.id;
  if v_st <> 'failed' or o.attempts <> 5 or o.last_error not like 'unreachable%' then
    raise exception 'CASE 7 FAIL: 5 retries should end failed (status %, attempts %)', v_st, o.attempts;
  end if;

  -- ── 4 ─────────────────────────────────────────────────────────────────────
  update public.customers set contact_email = 'two@r2103.invalid' where id = v_c2;
  select status into v_st from public.panel_account_outbox where customer_id = v_c2;
  if v_st <> 'pending' then raise exception 'CASE 4 FAIL: saving an email left the row %', v_st; end if;

  -- ── 9 ─────────────────────────────────────────────────────────────────────
  v_st := public.mark_panel_account_linked(v_a, v_c2, 'dms-user-88');
  select * into o from public.panel_account_outbox where customer_id = v_c2;
  if v_st <> 'done' or o.status <> 'done' or o.dms_user_id <> 'dms-user-88' then
    raise exception 'CASE 9 FAIL: mark linked left status % user %', o.status, o.dms_user_id;
  end if;
  if public.mark_panel_account_linked(v_b, v_c1, 'x') is not null then
    raise exception 'CASE 9 FAIL: mark linked accepted a customer of another company';
  end if;

  -- old customer with an active subscription and no payment here
  insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date)
  values (v_a, v_c4, 'ZZ R2103 Four', 'Business Starter', 'google', 1, 100, 'active', current_date, (current_date + interval '1 year')::date);
end $$;

-- ── 10 + 11: staff RPCs as a signed-in owner of tenant A ─────────────────────
-- Staff RPCs read current_tenant_id() / current_user_has_role() from the JWT; build an owner.
insert into auth.users (id, email, instance_id, aud, role)
values ('21030000-0000-4000-8000-0000000000e1', 'zz-r2103-owner@example.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.users (id, tenant_id, email, role, is_active)
values ('21030000-0000-4000-8000-0000000000e1', '21030000-0000-4000-8000-0000000000a1', 'zz-r2103-owner@example.invalid', 'owner', true);

select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', '21030000-0000-4000-8000-0000000000e1')::text, true);
set local role authenticated;

do $$
declare
  v_j jsonb;
  n   integer;
begin
  -- ── 10 ────────────────────────────────────────────────────────────────────
  v_j := public.queue_panel_account_backfill(true);
  if (v_j->>'with_email')::int <> 1 or (v_j->>'without_email')::int <> 0 or (v_j->>'queued')::int <> 0 then
    raise exception 'CASE 10 FAIL: dry run should count customer four only, got %', v_j;
  end if;
  v_j := public.queue_panel_account_backfill(false);
  if (v_j->>'queued')::int <> 1 then raise exception 'CASE 10 FAIL: real run queued %', v_j; end if;
  v_j := public.queue_panel_account_backfill(false);
  if (v_j->>'queued')::int <> 0 or (v_j->>'with_email')::int <> 0 then
    raise exception 'CASE 10 FAIL: second run should queue nothing, got %', v_j;
  end if;

  -- ── 11: overview shows own company only ───────────────────────────────────
  v_j := public.panel_account_overview();
  if (v_j->'counts'->>'done')::int <> 2 or (v_j->'counts'->>'pending')::int <> 1 or (v_j->'counts'->>'failed')::int <> 0 then
    raise exception 'CASE 11 FAIL: overview counts for tenant A wrong: %', v_j->'counts';
  end if;
  if public.requeue_panel_account('21030000-0000-4000-8000-0000000000c3') is not null then
    raise exception 'CASE 11 FAIL: requeue touched another company''s row';
  end if;

  -- ── 12 ────────────────────────────────────────────────────────────────────
  begin
    perform public.claim_panel_account_outbox(50, null, null);
    raise exception 'CASE 12 FAIL: authenticated could claim';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- 11b: a sales person (no owner/manager/support role) is refused the overview
update public.users set role = 'sales' where id = '21030000-0000-4000-8000-0000000000e1';
set local role authenticated;
do $$
begin
  begin
    perform public.panel_account_overview();
    raise exception 'CASE 11b FAIL: a sales user could read the overview';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'R-2103 panel_account_outbox: all cases passed' as result;

rollback;
