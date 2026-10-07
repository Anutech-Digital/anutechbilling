-- Regression test: R-096 — a portal customer's commercial change no longer dies on
-- contract_amendments_changed_by_fkey (migration 20261007040000). Self-asserting; rolled back.
--
-- record_contract_amendment() (trigger on subscriptions, 20260816170000) wrote
-- changed_by = auth.uid(). changed_by references public.users(id), but a portal
-- customer signs in as a customer_users row — NOT a public.users row. So the day a
-- portal/DMS customer changes seats, price or plan through a SECURITY DEFINER RPC, the
-- amendment insert fails the FK and the customer's whole change rolls back. Same bug
-- R-016 fixed for activity_log.
--
-- Proves:
--   1. Customer JWT changes seats → the update survives, one amendment row with
--      changed_by null, actor_label 'Customer Cust A', source 'user'.
--      (Without the migration this block raises the FK error.)
--   2. Staff JWT changes mrr → changed_by = the staff id, actor_label null (unchanged).
--   3. No JWT (service role / cron) → changed_by null, source 'system' (unchanged).
--
-- Owns all its fixtures (AGENTS.md L11).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('ffffffff-0000-0000-0000-000000096001','AMEND T','amend@example.in','07','R096');
insert into public.customers (id, tenant_id, name, contact_email)
  values ('cccccccc-0000-0000-0000-000000096001','ffffffff-0000-0000-0000-000000096001','Cust A','a@amend.example');
insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-000000096001','r096-customer@example.test'),
  ('dddddddd-0000-0000-0000-000000096002','r096-staff@example.test');
insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role)
  values ('dddddddd-0000-0000-0000-000000096001','cccccccc-0000-0000-0000-000000096001',
          'ffffffff-0000-0000-0000-000000096001','a@amend.example','admin');
insert into public.users (id, tenant_id, email, role)
  values ('dddddddd-0000-0000-0000-000000096002','ffffffff-0000-0000-0000-000000096001','r096-staff@example.test','owner');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date, auto_renew)
  values ('aaaaaaaa-0000-0000-0000-000000096001','ffffffff-0000-0000-0000-000000096001','cccccccc-0000-0000-0000-000000096001',
          'Cust A','Google Workspace Standard','google',10,8640,'active',current_date,current_date+365,true);

do $$
declare v_row record; v_n int; v_seats int;
begin
  -- 1. portal customer changes seats (what a future portal RPC would do)
  perform set_config('request.jwt.claims',
    json_build_object('sub','dddddddd-0000-0000-0000-000000096001','role','authenticated')::text, true);
  update public.subscriptions set seats = 12 where id = 'aaaaaaaa-0000-0000-0000-000000096001';

  select seats into v_seats from public.subscriptions where id = 'aaaaaaaa-0000-0000-0000-000000096001';
  if v_seats <> 12 then raise exception 'FAIL: customer seat change did not stick (seats=%)', v_seats; end if;
  select count(*) into v_n from public.contract_amendments where subscription_id = 'aaaaaaaa-0000-0000-0000-000000096001';
  if v_n <> 1 then raise exception 'FAIL: expected 1 amendment after customer change, got %', v_n; end if;
  select * into v_row from public.contract_amendments where subscription_id = 'aaaaaaaa-0000-0000-0000-000000096001';
  if v_row.changed_by is not null then raise exception 'FAIL: changed_by should be null for a customer, got %', v_row.changed_by; end if;
  if v_row.actor_label is distinct from 'Customer Cust A' then raise exception 'FAIL: actor_label expected "Customer Cust A", got %', v_row.actor_label; end if;
  if v_row.source <> 'user' then raise exception 'FAIL: source expected user, got %', v_row.source; end if;
  if v_row.seats_from <> 10 or v_row.seats_to <> 12 then raise exception 'FAIL: seats % -> % expected 10 -> 12', v_row.seats_from, v_row.seats_to; end if;

  -- 2. staff changes price → attributed to the staff user, as before
  perform set_config('request.jwt.claims',
    json_build_object('sub','dddddddd-0000-0000-0000-000000096002','role','authenticated')::text, true);
  update public.subscriptions set mrr = 9000 where id = 'aaaaaaaa-0000-0000-0000-000000096001';
  select * into v_row from public.contract_amendments
   where subscription_id = 'aaaaaaaa-0000-0000-0000-000000096001' and mrr_to = 9000;
  if v_row.changed_by is distinct from 'dddddddd-0000-0000-0000-000000096002'::uuid then
    raise exception 'FAIL: staff changed_by expected staff id, got %', v_row.changed_by; end if;
  if v_row.actor_label is not null then raise exception 'FAIL: staff actor_label should be null, got %', v_row.actor_label; end if;
  if v_row.source <> 'user' then raise exception 'FAIL: staff source expected user, got %', v_row.source; end if;

  -- 3. no JWT (cron / service role) → system, unattributed
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.subscriptions set plan = 'Google Workspace Plus' where id = 'aaaaaaaa-0000-0000-0000-000000096001';
  select * into v_row from public.contract_amendments
   where subscription_id = 'aaaaaaaa-0000-0000-0000-000000096001' and kind = 'plan_changed';
  if v_row.changed_by is not null or v_row.actor_label is not null or v_row.source <> 'system' then
    raise exception 'FAIL: system row expected null/null/system, got %/%/%', v_row.changed_by, v_row.actor_label, v_row.source; end if;

  raise notice 'PASS: customer change kept + labelled "Customer Cust A", staff attributed, cron = system';
end $$;
rollback;
