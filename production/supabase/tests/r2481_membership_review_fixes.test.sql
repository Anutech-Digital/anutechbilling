-- R-2481 — fixes from the independent review of R-2471 (tenant_memberships, slice 1).
-- Migration: 20261105002009_r2481_membership_review_fixes.sql   Spec: docs/specs/memberships.md §8
-- Review: Anutech-HQ/drafts/REVIEWS/2026-11-05-r2471-memberships.md (F1, F3; F2 is in
-- wipe_tenant_transactions_r1775.test.sql).
--
-- Before the migration current_tenant_id() / current_user_has_role() are R-2471's SQL bodies and
-- repair_missing_tenant_memberships() does not exist, so this file FAILS at 1. With it:
--   1. Both helpers are plpgsql and still carry every marker the deploy peeks read
--      (R-722, R-731, R-1896, R-2471 / R-1556, R-1896, R-2471) plus R-2481.
--   2. Same answers as before for the signed-in path: active owner → company + owner role, not
--      sales; deactivated / past access_ends_on / ended membership → NULL + no role; users mirror
--      drifted from the membership (triggers bypassed) → no role (fail closed); MFA-enrolled login
--      on an aal1 session → NULL + no role, aal2 → back; no signed-in user → NULL.
--   3. Speed, RELATIVE (R-2486): current_user_has_role() ≤ 5x a baseline measured in the same run —
--      a plpgsql primary-key read of the signed-in users row (the least any role check must do).
--      Measured 5 Nov 2026 on a busy laptop (guard tests + parallel runs): this body 0.9–1.2x the
--      baseline; R-2471's SQL body 18–25x → FAIL 3. No fixed µs limit: 500 µs failed once at 670 µs
--      on a loaded laptop. To re-prove the FAIL side: paste R-2471's two helper bodies
--      (20261105000000, section 4) into a copy of this file just before case 3 and run it — never
--      \i a migration file here (it has its own begin/commit). Postgres ≤17 assumed (it re-plans a
--      SECURITY DEFINER SQL function on every call); re-check the FAIL side after a major upgrade.
--   4. Repair (F3): a users row with NO membership (made with triggers off, as in the deploy race)
--      gets exactly the backfill membership; a second run adds 0; an ENDED membership is left
--      alone; afterwards no users row lacks a membership row for its selected company; request
--      roles cannot run it.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2481_membership_review_fixes.test.sql

begin;

-- ── 1. plpgsql bodies, markers kept ──────────────────────────────────────────────────
do $$
declare v_lang text; v_src text; v_m text;
begin
  select l.lanname, p.prosrc into v_lang, v_src from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid = to_regprocedure('public.current_tenant_id()');
  if v_lang is distinct from 'plpgsql' then raise exception 'FAIL 1: current_tenant_id() is % (want plpgsql)', v_lang; end if;
  foreach v_m in array array['R-722', 'R-731', 'R-1896', 'R-2471', 'R-2481'] loop
    if v_src not like '%' || v_m || '%' then raise exception 'FAIL 1: current_tenant_id() lost marker %', v_m; end if;
  end loop;
  select l.lanname, p.prosrc into v_lang, v_src from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid = to_regprocedure('public.current_user_has_role(text[])');
  if v_lang is distinct from 'plpgsql' then raise exception 'FAIL 1: current_user_has_role() is % (want plpgsql)', v_lang; end if;
  foreach v_m in array array['R-1556', 'R-1896', 'R-2471', 'R-2481'] loop
    if v_src not like '%' || v_m || '%' then raise exception 'FAIL 1: current_user_has_role() lost marker %', v_m; end if;
  end loop;
  if to_regprocedure('public.repair_missing_tenant_memberships()') is null then
    raise exception 'FAIL 1: repair_missing_tenant_memberships() missing';
  end if;
  raise notice 'PASS 1: both helpers plpgsql with every marker; repair function present';
end $$;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2481000-0000-0000-0000-0000000000a1', 'r2481-owner@example.test'),
  ('c2481000-0000-0000-0000-0000000000a2', 'r2481-sales@example.test'),
  ('c2481000-0000-0000-0000-0000000000a3', 'r2481-orphan@example.test'),
  ('c2481000-0000-0000-0000-0000000000a4', 'r2481-ended@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2481000-0000-0000-0000-0000000000f1', 'R2481 A', 'r2481a@example.test', '07', 'R248A'),
  ('c2481000-0000-0000-0000-0000000000f2', 'R2481 B', 'r2481b@example.test', '07', 'R248B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2481000-0000-0000-0000-0000000000a1', 'c2481000-0000-0000-0000-0000000000f1', 'r2481-owner@example.test', 'R2481 Owner', 'owner', true),
  ('c2481000-0000-0000-0000-0000000000a2', 'c2481000-0000-0000-0000-0000000000f1', 'r2481-sales@example.test', 'R2481 Sales', 'sales', true),
  ('c2481000-0000-0000-0000-0000000000a4', 'c2481000-0000-0000-0000-0000000000f2', 'r2481-ended@example.test', 'R2481 Ended', 'sales', true);

-- ── 2. same answers on the signed-in path ───────────────────────────────────────────
create or replace function pg_temp.r2481_as(p_user uuid, p_aal text) returns void language sql as $f$
  select set_config('request.jwt.claims',
    case when p_user is null then '' else
      json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text end, true);
$f$;

do $$
declare
  a constant uuid := 'c2481000-0000-0000-0000-0000000000f1';
  owner_id constant uuid := 'c2481000-0000-0000-0000-0000000000a1';
  sales_id constant uuid := 'c2481000-0000-0000-0000-0000000000a2';
begin
  perform pg_temp.r2481_as(owner_id, 'aal2');
  if public.current_tenant_id() is distinct from a then raise exception 'FAIL 2: owner has no company'; end if;
  if not public.current_user_has_role('owner') then raise exception 'FAIL 2: owner lacks owner'; end if;
  if not public.current_user_has_role('manager', 'owner') then raise exception 'FAIL 2: variadic owner failed'; end if;
  if public.current_user_has_role('sales') then raise exception 'FAIL 2: owner matched sales'; end if;
  if not public.current_user_is_owner() then raise exception 'FAIL 2: current_user_is_owner() false for owner'; end if;

  perform pg_temp.r2481_as(sales_id, 'aal2');
  if not public.current_user_has_role('sales') or public.current_user_has_role('owner', 'manager') then
    raise exception 'FAIL 2: sales role wrong';
  end if;

  -- deactivated (mirror + membership follow each other through the R-2471 triggers)
  perform pg_temp.r2481_as(null, null);   -- a server write (the owner guard needs no signed-in caller)
  update public.users set is_active = false where id = sales_id;
  perform pg_temp.r2481_as(sales_id, 'aal2');
  if public.current_tenant_id() is not null or public.current_user_has_role('sales') then
    raise exception 'FAIL 2: deactivated login kept company/role';
  end if;
  perform pg_temp.r2481_as(null, null);
  update public.users set is_active = true where id = sales_id;
  perform pg_temp.r2481_as(sales_id, 'aal2');
  if public.current_tenant_id() is distinct from a then raise exception 'FAIL 2: reactivated login has no company'; end if;

  -- past access_ends_on (R-1896)
  perform pg_temp.r2481_as(null, null);
  update public.users set access_ends_on = public.ist_today() - 1 where id = sales_id;
  perform pg_temp.r2481_as(sales_id, 'aal2');
  if public.current_tenant_id() is not null or public.current_user_has_role('sales') then
    raise exception 'FAIL 2: login past access_ends_on kept company/role';
  end if;
  perform pg_temp.r2481_as(null, null);
  update public.users set access_ends_on = null where id = sales_id;
  perform pg_temp.r2481_as(sales_id, 'aal2');

  -- the membership itself ended (users mirror untouched: triggers off for this one write)
  set local session_replication_role = replica;
  update public.tenant_memberships set ended_at = now(), end_reason = 'removed'
   where user_id = sales_id and tenant_id = a;
  set local session_replication_role = origin;
  if public.current_tenant_id() is not null or public.current_user_has_role('sales') then
    raise exception 'FAIL 2: ended membership kept company/role';
  end if;
  set local session_replication_role = replica;
  update public.tenant_memberships set ended_at = null, end_reason = null
   where user_id = sales_id and tenant_id = a;
  -- users mirror drifted from the membership (role) → no role, fail closed
  update public.users set role = 'owner' where id = sales_id;
  set local session_replication_role = origin;
  if public.current_user_has_role('owner') or public.current_user_has_role('sales') then
    raise exception 'FAIL 2: drifted mirror gave a role';
  end if;
  set local session_replication_role = replica;
  update public.users set role = 'sales' where id = sales_id;
  set local session_replication_role = origin;
  if not public.current_user_has_role('sales') then raise exception 'FAIL 2: role not back after drift fixed'; end if;

  -- MFA enrolled: aal1 → nothing, aal2 → back (R-731 / R-1556)
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values ('c2481000-0000-0000-0000-0000000000e1', owner_id, 'r2481', 'totp', 'verified', now(), now());
  perform pg_temp.r2481_as(owner_id, 'aal1');
  if public.current_tenant_id() is not null or public.current_user_has_role('owner') then
    raise exception 'FAIL 2: aal1 session of an MFA login kept company/role';
  end if;
  perform pg_temp.r2481_as(owner_id, 'aal2');
  if public.current_tenant_id() is distinct from a or not public.current_user_has_role('owner') then
    raise exception 'FAIL 2: aal2 session of an MFA login lost company/role';
  end if;

  -- nobody signed in
  perform pg_temp.r2481_as(null, null);
  if public.current_tenant_id() is not null or public.current_user_has_role('owner', 'manager', 'sales') then
    raise exception 'FAIL 2: no signed-in user got a company/role';
  end if;
  raise notice 'PASS 2: same answers (owner/sales, deactivated, end date, ended membership, drift, MFA, anonymous)';
end $$;

-- ── 3. speed, relative to a same-run baseline (R-2486) ──────────────────────────────
-- R-2471's SQL body: 18–25x the baseline; this body: 0.9–1.2x. Limit 5x — generous both ways.
-- Baseline is SECURITY DEFINER + SET search_path like the helpers, so call overhead is on both sides.
create or replace function pg_temp.r2486_baseline() returns uuid
  language plpgsql stable security definer set search_path = '' as $f$
declare v uuid;
begin
  select u.tenant_id into v from public.users u where u.id = public.current_user_id();
  return v;
end $f$;

do $$
declare t0 timestamptz; i int; r int; b boolean; x uuid;
  v_role numeric; v_base numeric; v_ratio numeric; b_role numeric; b_base numeric;
begin
  perform pg_temp.r2481_as('c2481000-0000-0000-0000-0000000000a1', 'aal2');
  b := public.current_user_has_role('owner', 'manager');   -- warm both plan caches
  x := pg_temp.r2486_baseline();
  -- 3 rounds of 1,000 calls each, baseline and role check side by side in every round; the
  -- round with the LOWEST ratio counts (each ratio from one round, so load slows both of its
  -- sides) — the ratio holds where a fixed µs limit did not
  for r in 1..3 loop
    t0 := clock_timestamp();
    for i in 1..1000 loop x := pg_temp.r2486_baseline(); end loop;
    v_base := extract(epoch from clock_timestamp() - t0) * 1e6 / 1000;
    t0 := clock_timestamp();
    for i in 1..1000 loop b := public.current_user_has_role('owner', 'manager'); end loop;
    v_role := extract(epoch from clock_timestamp() - t0) * 1e6 / 1000;
    if v_ratio is null or v_role / v_base < v_ratio then
      v_ratio := v_role / v_base; b_role := v_role; b_base := v_base;
    end if;
  end loop;
  perform pg_temp.r2481_as(null, null);
  if not b then raise exception 'FAIL 3: owner lost the role in the loop'; end if;
  if x is distinct from 'c2481000-0000-0000-0000-0000000000f1'::uuid then
    raise exception 'FAIL 3: baseline read the wrong row (%)', x;
  end if;
  if v_ratio > 5 then
    raise exception 'FAIL 3: current_user_has_role() % µs per call = %x the baseline (% µs; want ≤ 5x)',
      round(b_role), round(v_ratio, 1), round(b_base);
  end if;
  raise notice 'PASS 3: current_user_has_role() % µs per call = %x the baseline (% µs)',
    round(b_role), round(v_ratio, 1), round(b_base);
end $$;

-- ── 4. repair (F3) ──────────────────────────────────────────────────────────────────
do $$
declare
  b constant uuid := 'c2481000-0000-0000-0000-0000000000f2';
  orphan constant uuid := 'c2481000-0000-0000-0000-0000000000a3';
  ended_id constant uuid := 'c2481000-0000-0000-0000-0000000000a4';
  v_n int; m public.tenant_memberships;
begin
  -- the deploy race: a users row committed after the backfill, before the sync trigger existed
  set local session_replication_role = replica;
  insert into public.users (id, tenant_id, email, full_name, role, is_active, access_ends_on, can_view_deals)
    values (orphan, b, 'r2481-orphan@example.test', 'R2481 Orphan', 'manager', true, public.ist_today() + 30, true);
  -- and a membership someone ENDED on purpose (it stays ended)
  update public.tenant_memberships set ended_at = now(), end_reason = 'removed', is_active = false
   where user_id = ended_id and tenant_id = b;
  set local session_replication_role = origin;

  if exists (select 1 from public.tenant_memberships where user_id = orphan) then
    raise exception 'FAIL 4: fixture orphan already has a membership';
  end if;
  perform pg_temp.r2481_as(orphan, 'aal2');
  if public.current_tenant_id() is not null then raise exception 'FAIL 4: orphan has a company before the repair'; end if;
  perform pg_temp.r2481_as(null, null);

  v_n := public.repair_missing_tenant_memberships();
  if v_n < 1 then raise exception 'FAIL 4: repair added % rows (want ≥ 1)', v_n; end if;
  select * into m from public.tenant_memberships where user_id = orphan and tenant_id = b;
  if m.user_id is null or m.role <> 'manager' or not m.is_active or m.ended_at is not null
     or m.access_ends_on is distinct from public.ist_today() + 30 or not m.can_view_deals then
    raise exception 'FAIL 4: repaired membership does not match the users row: %', to_jsonb(m);
  end if;
  perform pg_temp.r2481_as(orphan, 'aal2');
  if public.current_tenant_id() is distinct from b or not public.current_user_has_role('manager') then
    raise exception 'FAIL 4: repaired login still has no company/role';
  end if;
  perform pg_temp.r2481_as(null, null);

  v_n := public.repair_missing_tenant_memberships();
  if v_n <> 0 then raise exception 'FAIL 4: second repair added % rows (want 0 — idempotent)', v_n; end if;
  if exists (select 1 from public.tenant_memberships where user_id = ended_id and tenant_id = b and ended_at is null) then
    raise exception 'FAIL 4: repair revived an ended membership';
  end if;
  -- the post-train check (spec §8): no users row without a membership row for its selected company
  select count(*) into v_n from public.users u
   where not exists (select 1 from public.tenant_memberships x where x.user_id = u.id and x.tenant_id = u.tenant_id);
  if v_n <> 0 then raise exception 'FAIL 4: % users rows still without a membership row', v_n; end if;
  raise notice 'PASS 4: repair gives the missing membership once, leaves ended ones, post-train check = 0';
end $$;

-- request roles cannot run the repair
set local role authenticated;
do $$
begin
  perform public.repair_missing_tenant_memberships();
  raise exception 'FAIL 4: authenticated ran repair_missing_tenant_memberships()';
exception when insufficient_privilege then
  raise notice 'PASS 4b: authenticated may not run the repair';
end $$;
reset role;

rollback;
