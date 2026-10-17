-- Regression test for 20261017131246_r1515_payment_followups.sql (R-1515)
--
-- WHAT IT PROVES (self-asserting; whole file rolls back)
--   1. Owner of company A adds a follow-up for A's customer — allowed, and reads it back.
--   2. Owner A cannot READ company B's follow-up.                       ← cross-tenant read
--   3. Owner A cannot INSERT a row stamped with company B.               ← cross-tenant write
--   4. Owner A cannot point A's row at company B's customer.             ← same-tenant FK
--   5. A login with NO company (NULL current_tenant_id) reads nothing and writes nothing.
--   6. A negative promised_amount is refused (whole rupees, never < 0).
--   7. created_by cannot be forged as somebody else.
--   8. A promise-to-pay without a date is refused.
--
-- Run it in one rollback with the migration (CLAUDE.md §17c):
--   begin; <migration without begin/commit> <this file without begin/rollback> rollback;

begin;

insert into auth.users (id, email) values
  ('f1515000-0000-0000-0000-0000000000a1', 'pf-owner-a@example.test'),
  ('f1515000-0000-0000-0000-0000000000b1', 'pf-owner-b@example.test'),
  ('f1515000-0000-0000-0000-0000000000c1', 'pf-nobody@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('f1515000-0000-0000-0000-00000000aaaa', 'PF A', 'pf-a@example.test', '07', 'PFA1'),
  ('f1515000-0000-0000-0000-00000000bbbb', 'PF B', 'pf-b@example.test', '07', 'PFB1');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('f1515000-0000-0000-0000-0000000000a1', 'f1515000-0000-0000-0000-00000000aaaa', 'pf-owner-a@example.test', 'PF Owner A', 'owner', true),
  ('f1515000-0000-0000-0000-0000000000b1', 'f1515000-0000-0000-0000-00000000bbbb', 'pf-owner-b@example.test', 'PF Owner B', 'owner', true);
-- pf-nobody has an auth login but NO users row → current_tenant_id() is NULL.

insert into public.customers (id, tenant_id, name, account_manager_id) values
  ('f1515000-0000-0000-0000-0000000000ca', 'f1515000-0000-0000-0000-00000000aaaa', 'PF Customer A', 'f1515000-0000-0000-0000-0000000000a1'),
  ('f1515000-0000-0000-0000-0000000000cb', 'f1515000-0000-0000-0000-00000000bbbb', 'PF Customer B', 'f1515000-0000-0000-0000-0000000000b1');

-- Company B's follow-up, written as the table owner (no RLS).
insert into public.payment_followups (id, tenant_id, customer_id, kind, note, created_by)
values ('f1515000-0000-0000-0000-0000000000fb', 'f1515000-0000-0000-0000-00000000bbbb',
        'f1515000-0000-0000-0000-0000000000cb', 'call', 'B private note', 'f1515000-0000-0000-0000-0000000000b1');

set local role authenticated;

do $$
declare
  v_a      uuid := 'f1515000-0000-0000-0000-00000000aaaa';
  v_b      uuid := 'f1515000-0000-0000-0000-00000000bbbb';
  v_owner  uuid := 'f1515000-0000-0000-0000-0000000000a1';
  v_nobody uuid := 'f1515000-0000-0000-0000-0000000000c1';
  v_cust_a uuid := 'f1515000-0000-0000-0000-0000000000ca';
  v_cust_b uuid := 'f1515000-0000-0000-0000-0000000000cb';
  v_n int;
  v_refused boolean;
  v_msg text;
begin
  -- ── 1. owner A adds a follow-up for A's customer ──────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  insert into public.payment_followups
    (tenant_id, customer_id, kind, note, promised_amount, promised_on, next_follow_up_on, assigned_to)
  values (v_a, v_cust_a, 'promise', 'Will pay Friday', 11800, current_date + 3, current_date + 4, v_owner);

  select count(*) into v_n from public.payment_followups
   where customer_id = v_cust_a and created_by = v_owner;
  if v_n <> 1 then
    raise exception 'FAIL 1: owner A could not add/read a follow-up for their own customer (saw %)', v_n;
  end if;

  -- ── 2. owner A cannot read B's follow-up ─────────────────────────────────
  select count(*) into v_n from public.payment_followups where tenant_id = v_b;
  if v_n <> 0 then
    raise exception 'FAIL 2: owner A read % follow-up(s) of company B — cross-tenant read open', v_n;
  end if;

  -- ── 3. owner A cannot insert a row stamped with company B ────────────────
  v_refused := false;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note)
    values (v_b, v_cust_b, 'note', 'planted');
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL 3: owner A wrote a follow-up into company B — cross-tenant insert open';
  end if;

  -- ── 4. A's row pointing at B's customer is refused by the same-tenant guard ─
  v_refused := false;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note)
    values (v_a, v_cust_b, 'note', 'wrong customer');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    v_refused := v_msg like '%customer is not in this company%';
  end;
  if not v_refused then
    raise exception 'FAIL 4: a company-A follow-up was linked to company B''s customer (msg: %)', coalesce(v_msg, 'none');
  end if;

  -- ── 6. negative promised_amount ──────────────────────────────────────────
  v_refused := false;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, promised_amount, promised_on)
    values (v_a, v_cust_a, 'promise', -1, current_date);
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL 6: a negative promised_amount was accepted';
  end if;

  -- ── 7. created_by cannot be forged ───────────────────────────────────────
  v_refused := false;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note, created_by)
    values (v_a, v_cust_a, 'note', 'forged', 'f1515000-0000-0000-0000-0000000000b1');
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL 7: a follow-up was written with someone else as created_by';
  end if;

  -- ── 8. a promise needs a date ────────────────────────────────────────────
  v_refused := false;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, promised_amount)
    values (v_a, v_cust_a, 'promise', 500);
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL 8: a promise-to-pay without a date was accepted';
  end if;

  -- ── 5. NULL tenant: reads nothing, writes nothing ────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);

  if public.current_tenant_id() is not null then
    raise exception 'SETUP: the no-company login has a tenant — test 5 would prove nothing';
  end if;

  select count(*) into v_n from public.payment_followups;
  if v_n <> 0 then
    raise exception 'FAIL 5a: a login with no company read % follow-up(s) — guard fails open', v_n;
  end if;

  v_refused := false;
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note)
    values (v_a, v_cust_a, 'note', 'from nowhere');
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL 5b: a login with no company wrote a follow-up into company A';
  end if;

  raise notice 'PASS: payment_followups — same-tenant ok, cross-tenant read/insert refused, NULL tenant refused, cross-tenant customer refused, negative amount refused';
end $$;

rollback;
