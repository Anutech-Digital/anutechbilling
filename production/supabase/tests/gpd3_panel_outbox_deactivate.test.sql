\set ON_ERROR_STOP on
-- R-2142 (GP-D3, goal G-PERSONAL): a personal erase queues DMS customer.deactivate on the R-2103
-- panel outbox. Migration 20261030162816_gpd3_panel_outbox_deactivate.sql. Rolled back — safe anywhere.
--
--   1  a customer whose ensure row is done: queue → 'queued'; the row is a pending deactivate
--      (source personal-erase, email captured, attempts 0)
--   2  a second queue → 'already', the row is unchanged
--   3  the erase scrubs the customer's email: claim still returns op deactivate with the captured
--      email and does NOT turn the row needs_email
--   4  finish 'done' → done; queueing again → 'already'
--   5  a customer with no outbox row yet gets a new deactivate row
--   6  a customer with no email anywhere → 'no_email', no row
--   7  another company's customer → null, nothing written
--   8  mark_panel_account_linked never turns a deactivate row back into an ensure
--   9  staff "Try again" (requeue_panel_account) is redefined to retry a deactivate on its captured email
--  10  ensure rows are unchanged: op defaults to ensure; one with no email still turns needs_email
--  11  only service_role may queue a deactivate

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, doc_code, tier) values
  ('21420000-0000-4000-8000-0000000000a1', 'ZZ GPD3 A', 'zz-gpd3-a@example.invalid', 'ZZGD3A', 'reseller'),
  ('21420000-0000-4000-8000-0000000000b1', 'ZZ GPD3 B', 'zz-gpd3-b@example.invalid', 'ZZGD3B', 'reseller');

insert into public.customers (id, tenant_id, name, contact_email, customer_number) values
  ('21420000-0000-4000-8000-0000000000c1', '21420000-0000-4000-8000-0000000000a1', 'ZZ GPD3 Asha', 'Asha.GPD3@example.invalid', 'C-GD31'),
  ('21420000-0000-4000-8000-0000000000c2', '21420000-0000-4000-8000-0000000000a1', 'ZZ GPD3 Ravi', 'ravi.gpd3@example.invalid', null),
  ('21420000-0000-4000-8000-0000000000c3', '21420000-0000-4000-8000-0000000000a1', 'ZZ GPD3 No Email', null, null),
  ('21420000-0000-4000-8000-0000000000c4', '21420000-0000-4000-8000-0000000000b1', 'ZZ GPD3 Other Co', 'other.gpd3@example.invalid', null),
  ('21420000-0000-4000-8000-0000000000c5', '21420000-0000-4000-8000-0000000000a1', 'ZZ GPD3 Ensure', null, null);

-- Only these synthetic rows are looked at: anything already pending locally is parked.
update public.panel_account_outbox set next_attempt_at = now() + interval '1 day'
 where status = 'pending' and tenant_id not in ('21420000-0000-4000-8000-0000000000a1', '21420000-0000-4000-8000-0000000000b1');

insert into public.panel_account_outbox (tenant_id, customer_id, status, source, dms_user_id, done_at) values
  ('21420000-0000-4000-8000-0000000000a1', '21420000-0000-4000-8000-0000000000c1', 'done', 'personal-signup', 'dms-u1', now() - interval '1 day');

do $$
declare
  v_a  uuid := '21420000-0000-4000-8000-0000000000a1';
  v_c1 uuid := '21420000-0000-4000-8000-0000000000c1';
  v_c2 uuid := '21420000-0000-4000-8000-0000000000c2';
  v_c3 uuid := '21420000-0000-4000-8000-0000000000c3';
  v_c4 uuid := '21420000-0000-4000-8000-0000000000c4';
  v_c5 uuid := '21420000-0000-4000-8000-0000000000c5';
  o    record;
  o2   record;
  r    record;
  n    integer;
  v_st text;
begin
  -- ── 1 ──
  v_st := public.queue_panel_account_deactivate(v_a, v_c1);
  select * into o from public.panel_account_outbox where customer_id = v_c1;
  if v_st is distinct from 'queued' or o.op <> 'deactivate' or o.status <> 'pending' or o.source <> 'personal-erase'
     or o.dms_email <> 'asha.gpd3@example.invalid' or o.attempts <> 0 or o.done_at is not null then
    raise exception 'CASE 1 FAIL: got %, row op % status % source % email %', v_st, o.op, o.status, o.source, o.dms_email;
  end if;

  -- ── 2 ──
  v_st := public.queue_panel_account_deactivate(v_a, v_c1);
  select * into o2 from public.panel_account_outbox where customer_id = v_c1;
  if v_st is distinct from 'already' or o2.updated_at <> o.updated_at then
    raise exception 'CASE 2 FAIL: second queue returned % / row changed', v_st;
  end if;

  -- ── 3 ──
  update public.customers set contact_email = null where id = v_c1;
  select count(*) into n from public.claim_panel_account_outbox(50, array[v_a], v_c1);
  select * into o from public.panel_account_outbox where customer_id = v_c1;
  if o.status <> 'pending' then raise exception 'CASE 3 FAIL: deactivate row turned %', o.status; end if;
  update public.panel_account_outbox set next_attempt_at = null where customer_id = v_c1;
  select * into r from public.claim_panel_account_outbox(50, array[v_a], v_c1);
  if r.op is distinct from 'deactivate' or r.email is distinct from 'asha.gpd3@example.invalid' or r.customer_number <> 'C-GD31' then
    raise exception 'CASE 3 FAIL: claim returned op % email %', r.op, r.email;
  end if;

  -- ── 4 ──
  v_st := public.finish_panel_account_outbox(r.id, 'done', 'dms-u1', null);
  if v_st is distinct from 'done' then raise exception 'CASE 4 FAIL: finish gave %', v_st; end if;
  if public.queue_panel_account_deactivate(v_a, v_c1) is distinct from 'already' then
    raise exception 'CASE 4 FAIL: queue after done was not already';
  end if;

  -- ── 5 ──
  v_st := public.queue_panel_account_deactivate(v_a, v_c2);
  select * into o from public.panel_account_outbox where customer_id = v_c2;
  if v_st is distinct from 'queued' or not found or o.op <> 'deactivate' or o.dms_email <> 'ravi.gpd3@example.invalid' then
    raise exception 'CASE 5 FAIL: got % / row %', v_st, o;
  end if;

  -- ── 6 ──
  v_st := public.queue_panel_account_deactivate(v_a, v_c3);
  select count(*) into n from public.panel_account_outbox where customer_id = v_c3;
  if v_st is distinct from 'no_email' or n <> 0 then raise exception 'CASE 6 FAIL: got % with % rows', v_st, n; end if;

  -- ── 7 ──
  v_st := public.queue_panel_account_deactivate(v_a, v_c4);
  select count(*) into n from public.panel_account_outbox where customer_id = v_c4;
  if v_st is not null or n <> 0 then raise exception 'CASE 7 FAIL: other company gave % with % rows', v_st, n; end if;

  -- ── 8 ──
  v_st := public.mark_panel_account_linked(v_a, v_c2, 'dms-u2');
  select * into o from public.panel_account_outbox where customer_id = v_c2;
  if v_st is not null or o.op <> 'deactivate' or o.status <> 'pending' or o.dms_user_id is not null then
    raise exception 'CASE 8 FAIL: mark linked gave %, row op % status %', v_st, o.op, o.status;
  end if;

  -- ── 9 ──
  -- requeue needs a staff session (current_tenant_id); its deactivate rule is pinned by its text.
  if not exists (select 1 from pg_proc where proname = 'requeue_panel_account' and prosrc like '%R-2142%') then
    raise exception 'CASE 9 FAIL: requeue_panel_account was not redefined for deactivate rows';
  end if;

  -- ── 10 ──
  insert into public.panel_account_outbox (tenant_id, customer_id, status, source)
  values (v_a, v_c5, 'pending', 'payment');
  select * into o from public.panel_account_outbox where customer_id = v_c5;
  if o.op <> 'ensure' then raise exception 'CASE 10 FAIL: default op is %', o.op; end if;
  select count(*) into n from public.claim_panel_account_outbox(50, array[v_a], v_c5);
  select * into o from public.panel_account_outbox where customer_id = v_c5;
  if n <> 0 or o.status <> 'needs_email' then
    raise exception 'CASE 10 FAIL: ensure row with no email claimed % / status %', n, o.status;
  end if;

  -- ── 11 ──
  if has_function_privilege('authenticated', 'public.queue_panel_account_deactivate(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.queue_panel_account_deactivate(uuid, uuid)', 'execute') then
    raise exception 'CASE 11 FAIL: authenticated/anon can queue a deactivate';
  end if;

  raise notice 'gpd3_panel_outbox_deactivate: all checks passed';
end;
$$;

rollback;
