-- R-2158 (AI-02, goal G-ADS-AI, 30 Oct 2026): the ad agent's safety layer.
-- Migration 20261030084431_r2158_ad_agent_safety.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Pardeep's rule (D3, 30 Oct): the AI recommends; anything that RAISES spend (publish, budget_up,
-- new_creative) waits for the owner; lowering a budget or pausing may run alone inside a cap set
-- per company. Proves:
--   A. No caps set → spend-up is REFUSED, spend-down is HELD (fail closed; caps are Pardeep's call).
--   B. Caps: only the owner writes them; marketing can read, not write; other company sees nothing.
--   C. Idempotency: the same campaign/action/version twice → one row, the second call says replayed.
--   D. Spend-up is never auto, even if the caller passes mode auto.
--   E. Budget-down / pause inside the change-per-day cap → auto_ok; beyond it → held (never refused).
--   F. Hard caps on spend-up: daily spend cap, change per day, max active ads → refused.
--   G. Mode off (dial or kill switch) → refused.
--   H. Tenant: another company's plan → refused; request is server-only (authenticated has no EXECUTE).
--   I. Decide: only an active owner of THAT company; spend-up needs an approved marketing budget
--      (R-1792) for the same channel and month that covers the projected month; a decided row
--      cannot be decided again.
--   J. Finish: only an approved / auto_ok row can be finished.
--   K. Ledger RLS: no direct writes from a login; other company cannot read.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000215801','R2158 Co','r2158@example.in','07','R2158'),
  ('dddddddd-0000-0000-0000-000000215802','R2158 Other','r2158b@example.in','07','R2158B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000215801','owner2158@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000215802','mkt2158@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000215803','owner2158b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000215804','exowner2158@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000215801','dddddddd-0000-0000-0000-000000215801','owner2158@example.in','Owner 2158','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000215802','dddddddd-0000-0000-0000-000000215801','mkt2158@example.in','Mkt 2158','marketing', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000215803','dddddddd-0000-0000-0000-000000215802','owner2158b@example.in','Owner 2158B','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000215804','dddddddd-0000-0000-0000-000000215801','exowner2158@example.in','Ex 2158','owner', false, now() - interval '1 day');

insert into public.ad_plans (id, tenant_id, name, objective, platforms, prompt, status) values
  ('eeeeeeee-0000-0000-0000-000000215801','dddddddd-0000-0000-0000-000000215801','Workspace Delhi','sales', array['meta-ads','google-ads'], 'Workspace Delhi 500/day', 'ready'),
  ('eeeeeeee-0000-0000-0000-000000215803','dddddddd-0000-0000-0000-000000215801','Live plan','sales', array['meta-ads'], 'live', 'live'),
  ('eeeeeeee-0000-0000-0000-000000215802','dddddddd-0000-0000-0000-000000215802','Other plan','sales', array['google-ads'], 'other', 'ready');
-- Two ads already live for company 1.
insert into public.ad_creatives (tenant_id, plan_id, storage_path, mime_type, width, height, size_bytes) values
  ('dddddddd-0000-0000-0000-000000215801','eeeeeeee-0000-0000-0000-000000215803','t/a.png','image/png',1080,1080,1000),
  ('dddddddd-0000-0000-0000-000000215801','eeeeeeee-0000-0000-0000-000000215803','t/b.png','image/png',1080,1920,1000);
-- Yesterday company 1 spent ₹300 on Meta; this month so far ₹3,000.
insert into public.ad_accounts (id, tenant_id, platform, account_id, name) values
  ('bbbbbbbb-0000-0000-0000-000000215801','dddddddd-0000-0000-0000-000000215801','meta-ads','act_2158','Meta 2158');
insert into public.ad_spend_daily (tenant_id, ad_account_id, day, campaign_id, campaign_name, spend) values
  ('dddddddd-0000-0000-0000-000000215801','bbbbbbbb-0000-0000-0000-000000215801',
   (now() at time zone 'Asia/Kolkata')::date - 1, 'c1', 'C1', 300);

-- Helper: call the request RPC as the server would.
create function pg_temp.req(p_plan uuid, p_action text, p_version int, p_platform text, p_delta numeric,
                            p_daily numeric, p_ads int, p_mode text,
                            p_tenant uuid default 'dddddddd-0000-0000-0000-000000215801')
returns jsonb language sql as $$
  select public.ad_agent_action_request(p_tenant, p_plan, p_action, p_version, p_platform, p_delta, p_daily, p_ads, p_mode, 'test reason');
$$;

do $$
declare r jsonb; r2 jsonb; n int;
begin
  -- ── A. No caps yet ────────────────────────────────────────────────────────
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215801','publish',1,'meta-ads',500,500,2,'hold');
  if r->>'status' <> 'refused' or r->>'reason' not like '%caps%' then
    raise exception 'FAIL A1: publish with no caps must be refused, got %', r; end if;
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215803','budget_down',1,'meta-ads',-100,null,0,'auto');
  if r->>'status' <> 'held' then raise exception 'FAIL A2: budget_down with no caps must be held, got %', r; end if;
end $$;

-- ── B. Caps: only the owner writes ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215802","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into public.ad_agent_caps (tenant_id, daily_spend_cap_inr, max_change_per_day_inr, max_active_ads)
    values ('dddddddd-0000-0000-0000-000000215801', 99999, 99999, 99);
    raise exception 'FAIL B1: marketing wrote the caps';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215801","role":"authenticated"}', true);
set local role authenticated;
insert into public.ad_agent_caps (tenant_id, daily_spend_cap_inr, max_change_per_day_inr, max_active_ads)
values ('dddddddd-0000-0000-0000-000000215801', 1000, 400, 3);
do $$
begin
  begin
    insert into public.ad_agent_caps (tenant_id, daily_spend_cap_inr, max_change_per_day_inr, max_active_ads)
    values ('dddddddd-0000-0000-0000-000000215802', 99999, 99999, 99);
    raise exception 'FAIL B2: owner wrote another company''s caps';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215802","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.ad_agent_caps) <> 1 then raise exception 'FAIL B3: marketing must read its own caps'; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215803","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.ad_agent_caps) <> 0 then raise exception 'FAIL B4: other company sees the caps'; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare r jsonb; r2 jsonb; n int; held_up uuid; held_pub uuid;
begin
  -- ── C. Idempotency + E. down inside cap is auto ──────────────────────────
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215803','budget_down',2,'meta-ads',-100,200,0,'auto');
  if r->>'status' <> 'auto_ok' then raise exception 'FAIL E1: budget_down inside cap must be auto_ok, got %', r; end if;
  if (r->>'replayed')::boolean then raise exception 'FAIL C0: first call is not a replay'; end if;
  r2 := pg_temp.req('eeeeeeee-0000-0000-0000-000000215803','budget_down',2,'meta-ads',-100,200,0,'auto');
  if r2->>'id' <> r->>'id' or not (r2->>'replayed')::boolean then
    raise exception 'FAIL C1: same campaign/action/version must replay the first row, got %', r2; end if;
  select count(*) into n from public.ad_agent_actions
   where idempotency_key = 'eeeeeeee-0000-0000-0000-000000215803:budget_down:v2';
  if n <> 1 then raise exception 'FAIL C2: % rows for one key', n; end if;

  -- ── E. down beyond the change-per-day cap (used 100 of 400) is HELD, not refused ──
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215803','pause',1,'meta-ads',-350,null,0,'auto');
  if r->>'status' <> 'held' then raise exception 'FAIL E2: pause beyond today''s cap must be held, got %', r; end if;

  -- ── D. spend-up never auto ───────────────────────────────────────────────
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215803','budget_up',1,'meta-ads',100,400,0,'auto');
  if r->>'status' <> 'held' then raise exception 'FAIL D1: budget_up must be held even when asked auto, got %', r; end if;
  held_up := (r->>'id')::uuid;

  -- ── F. hard caps on spend-up ─────────────────────────────────────────────
  -- daily spend: yesterday 300 + 800 new > 1000
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215801','publish',2,'meta-ads',800,800,1,'hold');
  if r->>'status' <> 'refused' or r->>'reason' not like '%daily%' then
    raise exception 'FAIL F1: publish above the daily spend cap must be refused, got %', r; end if;
  -- max ads: 2 live + 2 new > 3
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215801','publish',3,'meta-ads',200,200,2,'hold');
  if r->>'status' <> 'refused' or r->>'reason' not like '%ads%' then
    raise exception 'FAIL F2: publish above max ads must be refused, got %', r; end if;
  -- change per day: 100 used (auto down) + 100 held-up does not count; 350 more up > 400
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215803','budget_up',2,'meta-ads',350,650,0,'hold');
  if r->>'status' <> 'refused' or r->>'reason' not like '%change%' then
    raise exception 'FAIL F3: budget_up above change-per-day must be refused, got %', r; end if;
  -- inside every cap → held
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215801','publish',4,'meta-ads',200,200,1,'hold');
  if r->>'status' <> 'held' then raise exception 'FAIL F4: publish inside caps must be held, got %', r; end if;
  held_pub := (r->>'id')::uuid;

  -- ── G. mode off ──────────────────────────────────────────────────────────
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215803','budget_down',3,'meta-ads',-10,null,0,'off');
  if r->>'status' <> 'refused' then raise exception 'FAIL G1: mode off must refuse, got %', r; end if;

  -- ── H. another company's plan ────────────────────────────────────────────
  begin
    r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215802','budget_down',1,'google-ads',-10,null,0,'auto');
    raise exception 'FAIL H1: request on another company''s plan went through: %', r;
  exception when foreign_key_violation then
    if sqlerrm not like 'Campaign not found%' then raise exception 'FAIL H1b: wrong message %', sqlerrm; end if;
  end;

  -- bad direction is a programming error, refused loudly
  begin
    r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215803','budget_up',9,'meta-ads',-10,null,0,'hold');
    raise exception 'FAIL H2: budget_up with a negative delta went through';
  exception when invalid_parameter_value then null;
  end;

  perform set_config('r2158.held_up', held_up::text, true);
  perform set_config('r2158.held_pub', held_pub::text, true);
end $$;

-- H. request is server-only
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215801","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.ad_agent_action_request('dddddddd-0000-0000-0000-000000215801','eeeeeeee-0000-0000-0000-000000215803',
      'budget_down', 7, 'meta-ads', -1, null, 0, 'auto', 'x');
    raise exception 'FAIL H3: a login could call the request RPC';
  exception when insufficient_privilege then null;
  end;
  -- K. no direct ledger writes
  begin
    insert into public.ad_agent_actions (tenant_id, plan_id, action, version, idempotency_key, mode, status, reason)
    values ('dddddddd-0000-0000-0000-000000215801','eeeeeeee-0000-0000-0000-000000215803','pause',8,'k','auto','auto_ok','x');
    raise exception 'FAIL K1: a login wrote the ledger directly';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.ad_agent_actions) < 5 then raise exception 'FAIL K2: owner must read the ledger'; end if;
end $$;
reset role;

-- ── I. Decide ─────────────────────────────────────────────────────────────
-- marketing cannot approve
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215802","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.ad_agent_action_decide(current_setting('r2158.held_up')::uuid, 'approve', null, null, null);
    raise exception 'FAIL I1: marketing approved a spend-up';
  exception when insufficient_privilege then
    if sqlerrm not like 'Only the owner%' then raise exception 'FAIL I1b: wrong message %', sqlerrm; end if;
  end;
end $$;
reset role;
-- another company's owner cannot see / decide it
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215803","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.ad_agent_actions) <> 0 then raise exception 'FAIL K3: other company reads the ledger'; end if;
  begin
    perform public.ad_agent_action_decide(current_setting('r2158.held_up')::uuid, 'approve', null, null, null);
    raise exception 'FAIL I2: another company''s owner decided';
  exception when insufficient_privilege or no_data_found then null;
  end;
end $$;
reset role;
-- the server cannot approve in the name of an inactive owner
do $$
begin
  begin
    perform public.ad_agent_action_decide(current_setting('r2158.held_up')::uuid, 'approve', null, null,
      'aaaaaaaa-0000-0000-0000-000000215804');
    raise exception 'FAIL I3: inactive owner approved';
  exception when insufficient_privilege then null;
  end;
end $$;

-- the owner, without an approved marketing budget → refused (R-1792 bridge)
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215801","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.ad_agent_action_decide(current_setting('r2158.held_up')::uuid, 'approve', null, null, null);
    raise exception 'FAIL I4: spend-up approved with no marketing budget';
  exception when check_violation then
    if sqlerrm not like '%marketing budget%' then raise exception 'FAIL I4b: wrong message %', sqlerrm; end if;
  end;
  -- a down action that was held (over cap) is approved without a budget
  perform public.ad_agent_action_decide(
    (select id from public.ad_agent_actions where idempotency_key = 'eeeeeeee-0000-0000-0000-000000215803:pause:v1'),
    'approve', null, 'ok to pause', null);
end $$;
reset role;

-- Budget bridge, only where R-1792's table exists (it lives in prisma/migrations; the CI SQL DB may not have it).
do $$
declare r jsonb; v_month date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
        v_small uuid := gen_random_uuid(); v_big uuid := gen_random_uuid(); v_google uuid := gen_random_uuid();
begin
  if to_regclass('public.marketing_budgets') is null then
    raise notice 'SKIP I5-I8: marketing_budgets not on this DB';
    return;
  end if;
  insert into public.marketing_budgets (id, tenant_id, requested_by, channel, month, amount_requested) values
    (v_small,  'dddddddd-0000-0000-0000-000000215801','aaaaaaaa-0000-0000-0000-000000215802','meta-ads',   v_month, 1000),
    (v_big,    'dddddddd-0000-0000-0000-000000215801','aaaaaaaa-0000-0000-0000-000000215802','meta-ads',   v_month, 100000),
    (v_google, 'dddddddd-0000-0000-0000-000000215801','aaaaaaaa-0000-0000-0000-000000215802','google-ads', v_month, 100000);
  update public.marketing_budgets set status = 'approved', amount_approved = amount_requested where id in (v_small, v_big, v_google);
  perform set_config('r2158.small', v_small::text, true);
  perform set_config('r2158.big', v_big::text, true);
  perform set_config('r2158.google', v_google::text, true);
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215801","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r jsonb;
begin
  if current_setting('r2158.big', true) is null or current_setting('r2158.big', true) = '' then return; end if;
  -- wrong channel
  begin
    perform public.ad_agent_action_decide(current_setting('r2158.held_up')::uuid, 'approve', current_setting('r2158.google')::uuid, null, null);
    raise exception 'FAIL I5: google budget approved a meta spend-up';
  exception when check_violation then null;
  end;
  -- too small for the projected month
  begin
    perform public.ad_agent_action_decide(current_setting('r2158.held_up')::uuid, 'approve', current_setting('r2158.small')::uuid, null, null);
    raise exception 'FAIL I6: a budget too small for the month approved the spend-up';
  exception when check_violation then
    if sqlerrm not like '%left%' then raise exception 'FAIL I6b: wrong message %', sqlerrm; end if;
  end;
  r := public.ad_agent_action_decide(current_setting('r2158.held_up')::uuid, 'approve', current_setting('r2158.big')::uuid, 'go', null);
  if r->>'status' <> 'approved' then raise exception 'FAIL I7: approve failed %', r; end if;
  if (select decided_by from public.ad_agent_actions where id = current_setting('r2158.held_up')::uuid)
     <> 'aaaaaaaa-0000-0000-0000-000000215801' then raise exception 'FAIL I7b: decided_by not the owner'; end if;
  begin
    perform public.ad_agent_action_decide(current_setting('r2158.held_up')::uuid, 'reject', null, null, null);
    raise exception 'FAIL I8: decided twice';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;

-- reject works without a budget
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215801","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r jsonb;
begin
  r := public.ad_agent_action_decide(current_setting('r2158.held_pub')::uuid, 'reject', null, 'not now', null);
  if r->>'status' <> 'rejected' then raise exception 'FAIL I9: reject failed %', r; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ── J. Finish ─────────────────────────────────────────────────────────────
do $$
declare r jsonb;
begin
  begin
    perform public.ad_agent_action_finish(current_setting('r2158.held_pub')::uuid, true, null);
    raise exception 'FAIL J1: a rejected action was finished';
  exception when invalid_parameter_value then null;
  end;
  r := public.ad_agent_action_finish(
    (select id from public.ad_agent_actions where idempotency_key = 'eeeeeeee-0000-0000-0000-000000215803:budget_down:v2'), true, 'Meta ok');
  if r->>'status' <> 'done' then raise exception 'FAIL J2: finish failed %', r; end if;
  -- replaying the same key after it is done still returns the same row and does nothing new
  r := pg_temp.req('eeeeeeee-0000-0000-0000-000000215803','budget_down',2,'meta-ads',-100,200,0,'auto');
  if r->>'status' <> 'done' or not (r->>'replayed')::boolean then raise exception 'FAIL J3: replay after done %', r; end if;
end $$;

select 'r2158_ad_agent_safety: all assertions passed' as result;

rollback;
