-- R-2108 (29 Oct 2026) — one customer email for the customer panel and the support desk.
--
-- The customer page shows the PRIMARY CONTACT's email (customer_contacts.is_primary →
-- contacts.email); the panel outbox and the support sync read only customers.contact_email,
-- so a customer whose email lives on the primary contact sat in "Needs email" and never got
-- a support desk account. Migration 20261029140553_r2108_customer_primary_email.sql.
--
-- CASES (self-asserting; every one raises on failure)
--   1. customer_primary_email: contact_email first; blank/invalid → the primary contact's
--      email; a NON-primary contact's email is never used; nothing → null.
--   2. A paying customer with blank contact_email but a primary contact email → panel row
--      'pending' (not needs_email); claim returns that email.
--   3. Same customer's licence turning active → a Free support_sync_outbox row with that email.
--   4. A needs_email customer: adding a primary contact link with an email → row 'pending'.
--   5. A needs_email customer whose primary contact has no email: saving the contact's
--      email → row 'pending'.
--   6. requeue_panel_account and queue_panel_account_backfill count the primary email as an email.
--   7. Only service_role may call customer_primary_email (it would read any company's email).
--
-- SAFETY: synthetic tenant, one transaction, ends in ROLLBACK.

begin;

select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

insert into public.tenants (id, name, email, doc_code, tier) values
  ('21080000-0000-4000-8000-0000000000a1', 'ZZ R2108 A', 'zz-r2108-a@example.invalid', 'ZZ2108A', 'reseller');

insert into public.customers (id, tenant_id, name, contact_email, customer_number, is_active) values
  ('21080000-0000-4000-8000-0000000000c1', '21080000-0000-4000-8000-0000000000a1', 'ZZ R2108 Own Email', 'Own@R2108.invalid', 'C-21081', true),
  ('21080000-0000-4000-8000-0000000000c2', '21080000-0000-4000-8000-0000000000a1', 'ZZ R2108 Contact Email', '  ', 'C-21082', true),
  ('21080000-0000-4000-8000-0000000000c3', '21080000-0000-4000-8000-0000000000a1', 'ZZ R2108 No Email', null, 'C-21083', true),
  ('21080000-0000-4000-8000-0000000000c4', '21080000-0000-4000-8000-0000000000a1', 'ZZ R2108 Blank Contact', null, 'C-21084', true),
  ('21080000-0000-4000-8000-0000000000c5', '21080000-0000-4000-8000-0000000000a1', 'ZZ R2108 Old Buyer', null, 'C-21085', true);

insert into public.contacts (id, tenant_id, full_name, email) values
  ('ZZ2108-P1', '21080000-0000-4000-8000-0000000000a1', 'Own Primary', 'own-primary@r2108.invalid'),
  ('ZZ2108-P2', '21080000-0000-4000-8000-0000000000a1', 'Priya Contact', 'Priya@R2108.invalid'),
  ('ZZ2108-N3', '21080000-0000-4000-8000-0000000000a1', 'Not Primary', 'not-primary@r2108.invalid'),
  ('ZZ2108-P3', '21080000-0000-4000-8000-0000000000a1', 'Late Primary', 'late@r2108.invalid'),
  ('ZZ2108-P4', '21080000-0000-4000-8000-0000000000a1', 'Blank Primary', null),
  ('ZZ2108-P5', '21080000-0000-4000-8000-0000000000a1', 'Old Buyer Primary', 'old@r2108.invalid');

insert into public.customer_contacts (tenant_id, customer_id, contact_id, is_primary) values
  ('21080000-0000-4000-8000-0000000000a1', '21080000-0000-4000-8000-0000000000c1', 'ZZ2108-P1', true),
  ('21080000-0000-4000-8000-0000000000a1', '21080000-0000-4000-8000-0000000000c2', 'ZZ2108-P2', true),
  ('21080000-0000-4000-8000-0000000000a1', '21080000-0000-4000-8000-0000000000c3', 'ZZ2108-N3', false),
  ('21080000-0000-4000-8000-0000000000a1', '21080000-0000-4000-8000-0000000000c4', 'ZZ2108-P4', true),
  ('21080000-0000-4000-8000-0000000000a1', '21080000-0000-4000-8000-0000000000c5', 'ZZ2108-P5', true);

-- Only these synthetic rows are looked at: anything already in the local outbox is parked.
update public.panel_account_outbox set next_attempt_at = now() + interval '1 day'
 where status = 'pending' and tenant_id <> '21080000-0000-4000-8000-0000000000a1';

insert into public.quotes (id, tenant_id, customer_id, customer_name) values
  ('ZZ2108-Q2', '21080000-0000-4000-8000-0000000000a1', '21080000-0000-4000-8000-0000000000c2', 'ZZ R2108 Contact Email'),
  ('ZZ2108-Q3', '21080000-0000-4000-8000-0000000000a1', '21080000-0000-4000-8000-0000000000c3', 'ZZ R2108 No Email'),
  ('ZZ2108-Q4', '21080000-0000-4000-8000-0000000000a1', '21080000-0000-4000-8000-0000000000c4', 'ZZ R2108 Blank Contact');

do $$
declare
  v_a  uuid := '21080000-0000-4000-8000-0000000000a1';
  v_c1 uuid := '21080000-0000-4000-8000-0000000000c1';
  v_c2 uuid := '21080000-0000-4000-8000-0000000000c2';
  v_c3 uuid := '21080000-0000-4000-8000-0000000000c3';
  v_c4 uuid := '21080000-0000-4000-8000-0000000000c4';
  r    record;
  v_st text;
  v_p  jsonb;
begin
  -- ── 1 ─────────────────────────────────────────────────────────────────────
  if public.customer_primary_email(v_c1) is distinct from 'Own@R2108.invalid' then
    raise exception 'CASE 1 FAIL: contact_email should win, got %', public.customer_primary_email(v_c1);
  end if;
  if public.customer_primary_email(v_c2) is distinct from 'Priya@R2108.invalid' then
    raise exception 'CASE 1 FAIL: blank contact_email should fall back to the primary contact, got %', public.customer_primary_email(v_c2);
  end if;
  if public.customer_primary_email(v_c3) is not null then
    raise exception 'CASE 1 FAIL: a non-primary contact''s email was used: %', public.customer_primary_email(v_c3);
  end if;
  if public.customer_primary_email(v_c4) is not null then
    raise exception 'CASE 1 FAIL: a primary contact without email gave %', public.customer_primary_email(v_c4);
  end if;

  -- ── 2 ─────────────────────────────────────────────────────────────────────
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status)
  values (v_a, 'ZZ2108-Q2', 1000, 'upi', 'ZZ2108-UTR2', 'received');
  select status into v_st from public.panel_account_outbox where customer_id = v_c2;
  if v_st is distinct from 'pending' then
    raise exception 'CASE 2 FAIL: customer with a primary contact email queued as %, expected pending', v_st;
  end if;
  select * into r from public.claim_panel_account_outbox(50, array[v_a], v_c2);
  if r.email is distinct from 'priya@r2108.invalid' then
    raise exception 'CASE 2 FAIL: claim returned email %, expected the primary contact''s', r.email;
  end if;

  -- ── 3 ─────────────────────────────────────────────────────────────────────
  insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date)
  values (v_a, v_c2, 'ZZ R2108 Contact Email', 'Business Starter', 'google', 1, 100, 'active', current_date, (current_date + interval '1 year')::date);
  select payload into v_p from public.support_sync_outbox where customer_id = v_c2 order by created_at desc limit 1;
  if v_p is null or v_p->'data'->>'email' is distinct from 'Priya@R2108.invalid' or v_p->'data'->>'plan_key' <> 'free' then
    raise exception 'CASE 3 FAIL: no Free support row with the primary contact email (got %)', v_p;
  end if;

  -- ── 4 ─────────────────────────────────────────────────────────────────────
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status)
  values (v_a, 'ZZ2108-Q3', 700, 'cash', 'ZZ2108-CASH3', 'received');
  select status into v_st from public.panel_account_outbox where customer_id = v_c3;
  if v_st is distinct from 'needs_email' then raise exception 'CASE 4 FAIL: setup — expected needs_email, got %', v_st; end if;
  insert into public.customer_contacts (tenant_id, customer_id, contact_id, is_primary)
  values (v_a, v_c3, 'ZZ2108-P3', true);
  select status into v_st from public.panel_account_outbox where customer_id = v_c3;
  if v_st is distinct from 'pending' then
    raise exception 'CASE 4 FAIL: adding a primary contact with an email left the row %', v_st;
  end if;

  -- ── 5 ─────────────────────────────────────────────────────────────────────
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status)
  values (v_a, 'ZZ2108-Q4', 500, 'cash', 'ZZ2108-CASH4', 'received');
  select status into v_st from public.panel_account_outbox where customer_id = v_c4;
  if v_st is distinct from 'needs_email' then raise exception 'CASE 5 FAIL: setup — expected needs_email, got %', v_st; end if;
  update public.contacts set email = 'blank-now-set@r2108.invalid' where id = 'ZZ2108-P4';
  select status into v_st from public.panel_account_outbox where customer_id = v_c4;
  if v_st is distinct from 'pending' then
    raise exception 'CASE 5 FAIL: saving the primary contact''s email left the row %', v_st;
  end if;
  -- (back to needs_email for case 6)
  update public.panel_account_outbox set status = 'failed' where customer_id = v_c4;

  -- old buyer: active licence before any payment trigger, no panel row
  insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date)
  values (v_a, '21080000-0000-4000-8000-0000000000c5', 'ZZ R2108 Old Buyer', 'Business Starter', 'google', 1, 100, 'active', current_date, (current_date + interval '1 year')::date);
end $$;

-- ── 6: staff RPCs as a signed-in owner ────────────────────────────────────────
insert into auth.users (id, email, instance_id, aud, role)
values ('21080000-0000-4000-8000-0000000000e1', 'zz-r2108-owner@example.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.users (id, tenant_id, email, role, is_active)
values ('21080000-0000-4000-8000-0000000000e1', '21080000-0000-4000-8000-0000000000a1', 'zz-r2108-owner@example.invalid', 'owner', true);

select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', '21080000-0000-4000-8000-0000000000e1')::text, true);
set local role authenticated;

do $$
declare
  v_st text;
  v_j  jsonb;
begin
  v_st := public.requeue_panel_account('21080000-0000-4000-8000-0000000000c4');
  if v_st is distinct from 'pending' then
    raise exception 'CASE 6 FAIL: requeue of a customer with a primary contact email gave %', v_st;
  end if;
  v_j := public.queue_panel_account_backfill(true);
  if (v_j->>'with_email')::int <> 1 or (v_j->>'without_email')::int <> 0 then
    raise exception 'CASE 6 FAIL: backfill should count the old buyer as having an email, got %', v_j;
  end if;

  -- ── 7 ─────────────────────────────────────────────────────────────────────
  begin
    perform public.customer_primary_email('21080000-0000-4000-8000-0000000000c1');
    raise exception 'CASE 7 FAIL: authenticated could call customer_primary_email';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

select 'R-2108 customer_primary_email: all cases passed' as result;

rollback;
