-- R-2471 attack test — one login in two companies (tenant_memberships, slice 1).
-- Migration: 20261105000000_r2471_tenant_memberships.sql   Spec: docs/specs/memberships.md
--
-- Before the migration there is no tenant_memberships table and no switch_company(), so this
-- file FAILS at the fixture. With it:
--   1. Member of A and B, A selected: current_tenant_id() = A, sees only A's lead, role = A's role.
--   2. switch_company(B): only B's lead, role = B's role (users mirror follows); back to A works.
--   3. switch_company(C) without a membership → 42501 "not a member", nothing changes.
--   4. A direct UPDATE of my own users.tenant_id / role → refused, nothing changes.
--   5. Membership in the SELECTED company switched off → current_tenant_id() NULL, 0 rows,
--      users.is_active mirrored false (R-722 sign-out); on again → back.
--   6. Ended membership → switch refused; access_ends_on passed → switch refused.
--   7. Mirror says active but the membership is off (triggers bypassed) → NULL (fail closed).
--   8. MFA-enrolled login on an aal1 session → switch_company refused; aal2 → works.
--   9. A login moved by a server path (claim-merge style) → new membership, old one ended 'moved'.
--  10. Memberships RLS: I see my own + my selected company's; never another company's; no
--      INSERT/UPDATE from authenticated.
--  11. Backfill/trigger: every users row has a membership with the same tenant/role/active.
-- The app_runtime / app_jobs branches depend on session_user (a login role) and cannot be
-- entered with SET ROLE inside one transaction; they are covered by review + the spec.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2471_tenant_memberships.test.sql

begin;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2471000-0000-0000-0000-0000000000a1', 'r2471-owner-a@example.test'),
  ('c2471000-0000-0000-0000-0000000000a2', 'r2471-owner-b@example.test'),
  ('c2471000-0000-0000-0000-0000000000a3', 'r2471-member@example.test'),
  ('c2471000-0000-0000-0000-0000000000a4', 'r2471-mover@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2471000-0000-0000-0000-0000000000f1', 'R2471 A', 'r2471a@example.test', '07', 'R247A'),
  ('c2471000-0000-0000-0000-0000000000f2', 'R2471 B', 'r2471b@example.test', '07', 'R247B'),
  ('c2471000-0000-0000-0000-0000000000f3', 'R2471 C', 'r2471c@example.test', '07', 'R247C');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2471000-0000-0000-0000-0000000000a1', 'c2471000-0000-0000-0000-0000000000f1', 'r2471-owner-a@example.test', 'R2471 Owner A', 'owner',   true),
  ('c2471000-0000-0000-0000-0000000000a2', 'c2471000-0000-0000-0000-0000000000f2', 'r2471-owner-b@example.test', 'R2471 Owner B', 'owner',   true),
  ('c2471000-0000-0000-0000-0000000000a3', 'c2471000-0000-0000-0000-0000000000f1', 'r2471-member@example.test',  'R2471 Member',  'manager', true),
  ('c2471000-0000-0000-0000-0000000000a4', 'c2471000-0000-0000-0000-0000000000f1', 'r2471-mover@example.test',   'R2471 Mover',   'sales',   true);

-- The member also belongs to B, as sales (slice 3 will do this through an invite).
insert into public.tenant_memberships (user_id, tenant_id, role, is_active)
  values ('c2471000-0000-0000-0000-0000000000a3', 'c2471000-0000-0000-0000-0000000000f2', 'sales', true);

insert into public.leads (id, tenant_id, company) values
  ('R2471-LEAD-A', 'c2471000-0000-0000-0000-0000000000f1', 'R2471 Lead A'),
  ('R2471-LEAD-B', 'c2471000-0000-0000-0000-0000000000f2', 'R2471 Lead B');

-- ── 11 (first, as superuser): every users row has its membership ────────────────────
do $$
declare v_n int;
begin
  select count(*) into v_n from public.users u
   where not exists (select 1 from public.tenant_memberships m
                      where m.user_id = u.id and m.tenant_id = u.tenant_id
                        and m.role = u.role and m.is_active = u.is_active
                        and m.access_ends_on is not distinct from u.access_ends_on
                        and m.ended_at is null);
  if v_n <> 0 then raise exception 'FAIL 11: % users rows without a matching membership', v_n; end if;
  raise notice 'PASS 11: every users row (backfill + insert trigger) has its membership';
end $$;

set local role authenticated;

-- ── 1–2. Member of A and B ──────────────────────────────────────────────────────────
do $$
declare
  v_a uuid := 'c2471000-0000-0000-0000-0000000000f1';
  v_b uuid := 'c2471000-0000-0000-0000-0000000000f2';
  v_n int;
  v_r text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);

  if public.current_tenant_id() is distinct from v_a then
    raise exception 'FAIL 1: current_tenant_id() = %, expected A', public.current_tenant_id();
  end if;
  select count(*) into v_n from public.leads where id like 'R2471-LEAD-%';
  if v_n <> 1 then raise exception 'FAIL 1: A selected sees % R2471 leads, expected 1', v_n; end if;
  if not exists (select 1 from public.leads where id = 'R2471-LEAD-A') then
    raise exception 'FAIL 1: A selected does not see lead A';
  end if;
  if not public.current_user_has_role('manager') or public.current_user_has_role('sales') then
    raise exception 'FAIL 1: role in A should be manager only';
  end if;
  raise notice 'PASS 1: A selected → only A rows, role manager';

  if public.switch_company(v_b) is distinct from v_b then
    raise exception 'FAIL 2: switch_company(B) did not return B';
  end if;
  if public.current_tenant_id() is distinct from v_b then
    raise exception 'FAIL 2: after switch current_tenant_id() = %, expected B', public.current_tenant_id();
  end if;
  select count(*) into v_n from public.leads where id like 'R2471-LEAD-%';
  if v_n <> 1 or not exists (select 1 from public.leads where id = 'R2471-LEAD-B') then
    raise exception 'FAIL 2: B selected sees % R2471 leads (want only lead B)', v_n;
  end if;
  if not public.current_user_has_role('sales') or public.current_user_has_role('manager') then
    raise exception 'FAIL 2: role in B should be sales only';
  end if;
  select role::text into v_r from public.users where id = public.current_user_id();
  if v_r <> 'sales' then raise exception 'FAIL 2: users.role mirror = %, expected sales', v_r; end if;

  perform public.switch_company(v_a);
  if public.current_tenant_id() is distinct from v_a or not public.current_user_has_role('manager') then
    raise exception 'FAIL 2: switching back to A did not restore A / manager';
  end if;
  raise notice 'PASS 2: switch to B shows only B as sales; back to A as manager';
end $$;

-- ── 3–4. No membership in C; direct PATCH ───────────────────────────────────────────
do $$
declare
  v_a uuid := 'c2471000-0000-0000-0000-0000000000f1';
  v_b uuid := 'c2471000-0000-0000-0000-0000000000f2';
  v_c uuid := 'c2471000-0000-0000-0000-0000000000f3';
  v_refused boolean;
  v_n int;
  v_i int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);

  v_refused := false;
  begin
    perform public.switch_company(v_c);
  exception when insufficient_privilege then
    if sqlerrm not like '%not a member%' then raise exception 'FAIL 3: wrong refusal: %', sqlerrm; end if;
    v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 3: switch into C (no membership) was allowed'; end if;
  if public.current_tenant_id() is distinct from v_a then raise exception 'FAIL 3: tenant moved'; end if;
  raise notice 'PASS 3: switch into a company without membership refused';

  foreach v_i in array array[1, 2, 3] loop
    v_refused := false;
    begin
      if v_i = 1 then
        update public.users set tenant_id = v_c where id = public.current_user_id();
      elsif v_i = 2 then
        update public.users set tenant_id = v_b, role = 'owner' where id = public.current_user_id();
      else
        update public.users set role = 'owner' where id = public.current_user_id();
      end if;
      get diagnostics v_n = row_count;
      if v_n = 0 then v_refused := true; end if;
    exception when insufficient_privilege then
      v_refused := true;
    end;
    if not v_refused then raise exception 'FAIL 4: direct users UPDATE % was allowed', v_i; end if;
  end loop;
  if public.current_tenant_id() is distinct from v_a or not public.current_user_has_role('manager')
     or public.current_user_has_role('owner') then
    raise exception 'FAIL 4: a direct UPDATE changed my company or role';
  end if;
  raise notice 'PASS 4: direct UPDATE of my tenant_id / role refused';
end $$;

-- ── 10. Memberships RLS ─────────────────────────────────────────────────────────────
do $$
declare
  v_n int;
  v_refused boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.tenant_memberships where user_id = public.current_user_id();
  if v_n <> 2 then raise exception 'FAIL 10: member sees % own memberships, expected 2', v_n; end if;
  -- A selected: A's members (owner A, member, mover) + own B row; never owner B's B row.
  if exists (select 1 from public.tenant_memberships where user_id = 'c2471000-0000-0000-0000-0000000000a2') then
    raise exception 'FAIL 10: member (A selected) sees owner B''s membership in B';
  end if;
  begin
    insert into public.tenant_memberships (user_id, tenant_id, role)
      values (public.current_user_id(), 'c2471000-0000-0000-0000-0000000000f3', 'owner');
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 10: authenticated could INSERT a membership'; end if;
  v_refused := false;
  begin
    update public.tenant_memberships set role = 'owner' where user_id = public.current_user_id();
    get diagnostics v_n = row_count;
    if v_n = 0 then v_refused := true; end if;
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 10: authenticated could UPDATE its membership role'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  if exists (select 1 from public.tenant_memberships where tenant_id = 'c2471000-0000-0000-0000-0000000000f2') then
    raise exception 'FAIL 10: owner A sees a membership in company B';
  end if;
  raise notice 'PASS 10: memberships RLS — own + selected company only, no writes';
end $$;

-- ── 5. Membership in the selected company switched off ─────────────────────────────
do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  perform public.switch_company('c2471000-0000-0000-0000-0000000000f2');
end $$;

reset role;
select set_config('request.jwt.claims', '', true);
update public.tenant_memberships set is_active = false
 where user_id = 'c2471000-0000-0000-0000-0000000000a3' and tenant_id = 'c2471000-0000-0000-0000-0000000000f2';
set local role authenticated;

do $$
declare v_n int; v_active boolean;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is not null then
    raise exception 'FAIL 5: switched-off membership still gives tenant %', public.current_tenant_id();
  end if;
  select count(*) into v_n from public.leads where id like 'R2471-LEAD-%';
  if v_n <> 0 then raise exception 'FAIL 5: switched-off member sees % leads', v_n; end if;
  if public.current_user_has_role('sales') then raise exception 'FAIL 5: switched-off member holds a role'; end if;
  select is_active into v_active from public.users where id = public.current_user_id();
  if v_active then raise exception 'FAIL 5: users.is_active mirror not switched off (R-722 sign-out would miss it)'; end if;
  -- Company A is still theirs: they may switch there.
  perform public.switch_company('c2471000-0000-0000-0000-0000000000f1');
  if public.current_tenant_id() is distinct from 'c2471000-0000-0000-0000-0000000000f1'::uuid then
    raise exception 'FAIL 5: could not switch to the still-active company A';
  end if;
  raise notice 'PASS 5: switched-off membership → NULL in B; A still works';
end $$;

-- ── 6. Ended membership; access_ends_on passed ─────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '', true);
update public.tenant_memberships set is_active = true, ended_at = now(), end_reason = 'removed'
 where user_id = 'c2471000-0000-0000-0000-0000000000a3' and tenant_id = 'c2471000-0000-0000-0000-0000000000f2';
set local role authenticated;

do $$
declare v_refused boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  begin
    perform public.switch_company('c2471000-0000-0000-0000-0000000000f2');
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 6: switch into an ENDED membership allowed'; end if;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);
update public.tenant_memberships set ended_at = null, end_reason = null, access_ends_on = public.ist_today() - 1
 where user_id = 'c2471000-0000-0000-0000-0000000000a3' and tenant_id = 'c2471000-0000-0000-0000-0000000000f2';
set local role authenticated;

do $$
declare v_refused boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  begin
    perform public.switch_company('c2471000-0000-0000-0000-0000000000f2');
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 6: switch into a membership past access_ends_on allowed'; end if;
  if public.current_tenant_id() is distinct from 'c2471000-0000-0000-0000-0000000000f1'::uuid then
    raise exception 'FAIL 6: company A lost after a refused switch';
  end if;
  raise notice 'PASS 6: ended / expired membership cannot be switched into';
end $$;

-- ── 7. Mirror and membership disagree → fail closed ────────────────────────────────
reset role;
select set_config('request.jwt.claims', '', true);
set local session_replication_role = replica;   -- bypass the sync triggers on purpose
update public.tenant_memberships set is_active = false
 where user_id = 'c2471000-0000-0000-0000-0000000000a3' and tenant_id = 'c2471000-0000-0000-0000-0000000000f1';
set local session_replication_role = origin;
set local role authenticated;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  if not exists (select 1 from public.users where id = public.current_user_id() and is_active) then
    raise exception 'FAIL 7 setup: users mirror should still say active';
  end if;
  if public.current_tenant_id() is not null or public.current_user_has_role('manager')
     or public.current_user_is_owner() then
    raise exception 'FAIL 7: users says active but the membership is off — access still granted';
  end if;
  raise notice 'PASS 7: membership off + mirror on → no tenant, no role (fail closed)';
end $$;

reset role;
select set_config('request.jwt.claims', '', true);
update public.tenant_memberships set is_active = true
 where user_id = 'c2471000-0000-0000-0000-0000000000a3' and tenant_id = 'c2471000-0000-0000-0000-0000000000f1';
update public.tenant_memberships set access_ends_on = null
 where user_id = 'c2471000-0000-0000-0000-0000000000a3' and tenant_id = 'c2471000-0000-0000-0000-0000000000f2';

-- ── 8. MFA-enrolled login ───────────────────────────────────────────────────────────
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c2471000-0000-0000-0000-0000000000d1', 'c2471000-0000-0000-0000-0000000000a3', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());
set local role authenticated;

do $$
declare v_refused boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated', 'aal', 'aal1')::text, true);
  begin
    perform public.switch_company('c2471000-0000-0000-0000-0000000000f2');
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 8: MFA login on aal1 could switch company'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a3', 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform public.switch_company('c2471000-0000-0000-0000-0000000000f2');
  if public.current_tenant_id() is distinct from 'c2471000-0000-0000-0000-0000000000f2'::uuid then
    raise exception 'FAIL 8: MFA login on aal2 could not switch';
  end if;
  raise notice 'PASS 8: MFA login switches only on aal2';
end $$;

-- ── 9. A server path moves a login to a company it is not a member of ──────────────
reset role;
select set_config('request.jwt.claims', '', true);
update public.users set tenant_id = 'c2471000-0000-0000-0000-0000000000f3'
 where id = 'c2471000-0000-0000-0000-0000000000a4';

do $$
declare v_old public.tenant_memberships; v_new public.tenant_memberships;
begin
  select * into v_old from public.tenant_memberships
   where user_id = 'c2471000-0000-0000-0000-0000000000a4' and tenant_id = 'c2471000-0000-0000-0000-0000000000f1';
  select * into v_new from public.tenant_memberships
   where user_id = 'c2471000-0000-0000-0000-0000000000a4' and tenant_id = 'c2471000-0000-0000-0000-0000000000f3';
  if v_new.id is null or not v_new.is_active or v_new.role <> 'sales' or v_new.ended_at is not null then
    raise exception 'FAIL 9: moved login has no active sales membership in C';
  end if;
  if v_old.ended_at is null or v_old.end_reason <> 'moved' then
    raise exception 'FAIL 9: old membership in A not ended as moved (ended_at %, reason %)', v_old.ended_at, v_old.end_reason;
  end if;
  raise notice 'PASS 9: a server move keeps one-company behaviour (new membership, old ended)';
end $$;

-- ── 12. Removed from the SELECTED company: turning users.is_active back on is refused ─
-- (the member has B selected since case 8)
update public.tenant_memberships set ended_at = now(), end_reason = 'removed'
 where user_id = 'c2471000-0000-0000-0000-0000000000a3' and tenant_id = 'c2471000-0000-0000-0000-0000000000f2';

do $$
declare v_refused boolean := false; v_active boolean;
begin
  select is_active into v_active from public.users where id = 'c2471000-0000-0000-0000-0000000000a3';
  if v_active then raise exception 'FAIL 12: ended selected membership left users.is_active on'; end if;
  begin
    update public.users set is_active = true where id = 'c2471000-0000-0000-0000-0000000000a3';
  exception when insufficient_privilege then
    if sqlerrm not like '%removed from this company%Invite them again%' then
      raise exception 'FAIL 12: wrong refusal: %', sqlerrm;
    end if;
    v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 12: re-activating a removed member was silently accepted'; end if;
  raise notice 'PASS 12: removed member cannot be switched back on by users.is_active (next step given)';
end $$;

-- ── 13. MFA owner on aal1 is not an owner; aal2 is ─────────────────────────────────
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c2471000-0000-0000-0000-0000000000d2', 'c2471000-0000-0000-0000-0000000000a1', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());
set local role authenticated;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a1', 'role', 'authenticated', 'aal', 'aal1')::text, true);
  if public.current_user_is_owner() then raise exception 'FAIL 13: MFA owner on aal1 counted as owner'; end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a1', 'role', 'authenticated', 'aal', 'aal2')::text, true);
  if not public.current_user_is_owner() then raise exception 'FAIL 13: MFA owner on aal2 not an owner'; end if;
  raise notice 'PASS 13: current_user_is_owner() needs MFA like current_user_has_role()';
end $$;

-- ── 14. users.role mirror drifts from the membership → no role (fail closed) ────────
reset role;
select set_config('request.jwt.claims', '', true);
set local session_replication_role = replica;
update public.tenant_memberships set role = 'sales'
 where user_id = 'c2471000-0000-0000-0000-0000000000a1' and tenant_id = 'c2471000-0000-0000-0000-0000000000f1';
set local session_replication_role = origin;
set local role authenticated;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2471000-0000-0000-0000-0000000000a1', 'role', 'authenticated', 'aal', 'aal2')::text, true);
  if public.current_user_has_role('owner') or public.current_user_has_role('sales')
     or public.current_user_is_owner() then
    raise exception 'FAIL 14: users.role (owner) and membership role (sales) disagree — a role was still granted';
  end if;
  raise notice 'PASS 14: role drift between users and membership → no role';
end $$;

rollback;
