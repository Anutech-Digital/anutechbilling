-- R-2477 — memberships slice 3: Invite / Claim / "Remove from this company" (R-2471).
-- Migration: *_r2477_membership_invite_claim_remove.sql   Spec: docs/specs/memberships.md §6
--
-- The owner's real path (card doneWhen): company B invites pratik while he is a manager in
-- company A; he accepts the invite himself → he is in A AND B. A removes him → he lands only in B,
-- his A records keep their author, his users row stays.
--
-- Before the migrations remove_company_member / company_members / invite_existing_login do not
-- exist, so this file FAILS (case 1). With them (R-2477 + its review fixes, 20261105192420):
--   1. grants: anon calls none of the new functions; the internal mover is callable by no app role;
--      every new definer function pins search_path.
--   2. Invite: B's owner gets 'invited' (a membership invite; nothing written or deleted in A);
--      A's owner gets 'already_member'; B's sales is refused.
--   3. Consent: B can neither list nor claim him, even after a routine sign-in; he sees B's invite
--      himself (my_company_invites) and accepts it → membership in B, his selected company stays A.
--   4. Cross-tenant: B's owner sees none of A's users / memberships / leads; company_members() of B
--      lists him (and nobody from A); his own company_members() (A selected) lists A only.
--   5. update_company_member: B's owner changes his B role — his A role (users mirror) stays; a sales
--      user is refused; someone not in B → not found; last owner cannot be demoted; a manager from
--      another company is refused.
--   6. Remove: sales refused; yourself refused; a non-member of my company → not found; an owner
--      on an aal1 session (MFA enrolled) refused. A's owner removes him: A membership ended
--      'removed' by A's owner, audit line in A, users row + his A lead's owner_id/created_by stay;
--      his selected company is B with B's role; he sees only B; B's log never names A.
--   7. Remove with no other company: membership ended, users row stays, inactive, no tenant.
--   8. Owner removes another owner (another owner left); the last owner cannot be removed/demoted.
--   9. users_tenant_delete is gone: an owner's DELETE of a teammate's users row deletes nothing.
--  10. Re-invite after Remove → he accepts (same membership row re-opened); he stays in B.
--  11. A login removed to "none" → invite_existing_login says no_company → plain invite + Claim
--      (listed with the address only) → 'rejoined' and that company is selected again.
--  12. switch_company still works both ways after all of this.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2477_membership_invite_claim_remove.test.sql

begin;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email, last_sign_in_at) values
  ('c2477000-0000-0000-0000-0000000000a1', 'r2477-owner-a@example.test',  now() - interval '9 days'),
  ('c2477000-0000-0000-0000-0000000000a2', 'r2477-owner-a2@example.test', now() - interval '9 days'),
  ('c2477000-0000-0000-0000-0000000000b1', 'r2477-owner-b@example.test',  now() - interval '9 days'),
  ('c2477000-0000-0000-0000-0000000000b2', 'r2477-sales-b@example.test',  now() - interval '9 days'),
  ('c2477000-0000-0000-0000-0000000000c1', 'r2477-pratik@example.test',   now() - interval '9 days'),
  ('c2477000-0000-0000-0000-0000000000c2', 'r2477-solo@example.test',     now() - interval '9 days'),
  ('c2477000-0000-0000-0000-0000000000c3', 'r2477-mism@example.test',     now() - interval '9 days');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2477000-0000-0000-0000-0000000000f1', 'R2477 Anu Co',   'r2477a@example.test', '07', 'R277A'),
  ('c2477000-0000-0000-0000-0000000000f2', 'R2477 Excel Co', 'r2477b@example.test', '07', 'R277B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2477000-0000-0000-0000-0000000000a1', 'c2477000-0000-0000-0000-0000000000f1', 'r2477-owner-a@example.test',  'R2477 Owner A',  'owner',   true),
  ('c2477000-0000-0000-0000-0000000000a2', 'c2477000-0000-0000-0000-0000000000f1', 'r2477-owner-a2@example.test', 'R2477 Owner A2', 'owner',   true),
  ('c2477000-0000-0000-0000-0000000000b1', 'c2477000-0000-0000-0000-0000000000f2', 'r2477-owner-b@example.test',  'R2477 Owner B',  'owner',   true),
  ('c2477000-0000-0000-0000-0000000000b2', 'c2477000-0000-0000-0000-0000000000f2', 'r2477-sales-b@example.test',  'R2477 Sales B',  'sales',   true),
  ('c2477000-0000-0000-0000-0000000000c1', 'c2477000-0000-0000-0000-0000000000f1', 'r2477-pratik@example.test',   'R2477 Pratik',   'manager', true),
  ('c2477000-0000-0000-0000-0000000000c2', 'c2477000-0000-0000-0000-0000000000f1', 'r2477-solo@example.test',     'R2477 Solo',     'support', true),
  -- users.email differs from the login email (case 13)
  ('c2477000-0000-0000-0000-0000000000c3', 'c2477000-0000-0000-0000-0000000000f2', 'r2477-mism-old@example.test', 'R2477 Mism',     'sales',   true);
update public.users set manager_id = 'c2477000-0000-0000-0000-0000000000b1', gets_new_leads = true
 where id = 'c2477000-0000-0000-0000-0000000000c3';

-- A invited pratik long ago and he accepted (the row that used to block every other company).
insert into public.team_invites (tenant_id, email, role, invited_by, created_at, accepted_at) values
  ('c2477000-0000-0000-0000-0000000000f1', 'r2477-pratik@example.test', 'manager',
   'c2477000-0000-0000-0000-0000000000a1', now() - interval '30 days', now() - interval '29 days'),
  -- solo joined A by an invite too: Remove must clear it, or "invite again" is blocked (case 10/11)
  ('c2477000-0000-0000-0000-0000000000f1', 'r2477-solo@example.test', 'support',
   'c2477000-0000-0000-0000-0000000000a1', now() - interval '30 days', now() - interval '29 days');

insert into public.leads (id, tenant_id, company, owner_id, created_by) values
  ('R2477-LEAD-A', 'c2477000-0000-0000-0000-0000000000f1', 'R2477 Lead A',
   'c2477000-0000-0000-0000-0000000000c1', 'c2477000-0000-0000-0000-0000000000c1'),
  ('R2477-LEAD-B', 'c2477000-0000-0000-0000-0000000000f2', 'R2477 Lead B', null, null);

-- MFA-enrolled owner A2 (case 6: aal1 refused)
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c2477000-0000-0000-0000-0000000000d1', 'c2477000-0000-0000-0000-0000000000a2', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());

create temp table r2477_mark as select coalesce(max(id), 0) as last_id from public.activity_log;
grant select on r2477_mark to authenticated;

-- ── 1. grants + search_path ─────────────────────────────────────────────────────────
do $$
declare
  f text;
begin
  foreach f in array array['public.invite_existing_login(text,public.user_role)', 'public.remove_company_member(uuid)',
                           'public.company_members()', 'public.update_company_member(uuid,jsonb)',
                           'public.my_company_invites()', 'public.accept_company_invite(uuid)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception 'FAIL 1: anon may execute %', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception 'FAIL 1: authenticated may not execute %', f; end if;
  end loop;
  if has_function_privilege('authenticated', 'public.r2477_select_membership(uuid,uuid)', 'execute')
     or has_function_privilege('anon', 'public.r2477_select_membership(uuid,uuid)', 'execute') then
    raise exception 'FAIL 1: the internal mover is callable by an app role';
  end if;
  if exists (select 1 from pg_proc p
              where p.oid in ('public.invite_existing_login(text,public.user_role)'::regprocedure,
                              'public.my_company_invites()'::regprocedure,
                              'public.accept_company_invite(uuid)'::regprocedure,
                              'public.remove_company_member(uuid)'::regprocedure,
                              'public.company_members()'::regprocedure,
                              'public.update_company_member(uuid,jsonb)'::regprocedure,
                              'public.r2477_select_membership(uuid,uuid)'::regprocedure,
                              'public.merge_stranded_user_into_tenant(text,uuid,public.user_role)'::regprocedure,
                              'public.guard_privileged_user_columns()'::regprocedure)
                and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))) then
    raise exception 'FAIL 1: a definer function without a pinned search_path';
  end if;
  raise notice 'PASS 1: grants + pinned search_path';
end $$;

set local role authenticated;

-- ── 2. Invite of a login that works in another company ──────────────────────────────
do $$
declare
  v text;
  v_msg text;
begin
  -- B's owner
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  v := public.release_stale_team_invite('r2477-pratik@example.test');
  if v <> 'member_elsewhere' then raise exception 'FAIL 2: release said % (expected member_elsewhere)', v; end if;
  v := public.invite_existing_login('  R2477-Pratik@Example.test ', 'sales');
  if v <> 'invited' then raise exception 'FAIL 2: invite_existing_login said % (expected invited)', v; end if;

  -- A's owner: already a member there
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('r2477-pratik@example.test', 'manager');
  if v <> 'already_member' then raise exception 'FAIL 2: A''s owner got % (expected already_member)', v; end if;

  -- B's sales
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  begin
    perform public.invite_existing_login('r2477-pratik@example.test', 'sales');
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null then raise exception 'FAIL 2: a sales user could invite'; end if;
  raise notice 'PASS 2: invite of a login in another company → membership invite; already_member; non-owner refused';
end $$;

reset role;
do $$
begin
  -- R-2477 review: nothing written or deleted in A (A's accepted invite row stays: its history)
  if exists (select 1 from public.activity_log a, r2477_mark k
              where a.id > k.last_id and a.tenant_id = 'c2477000-0000-0000-0000-0000000000f1'
                and a.action not in ('team_invite.address_checked', 'team_invite.existing_login')) then
    raise exception 'FAIL 2: the invite wrote a line in A (tells A another company invited their member)';
  end if;
  if not exists (select 1 from public.team_invites where tenant_id = 'c2477000-0000-0000-0000-0000000000f1' and email = 'r2477-pratik@example.test') then
    raise exception 'FAIL 2: A''s accepted invite row was deleted by B''s invite';
  end if;
end $$;
set local role authenticated;

-- ── 3. Claim activates the membership ───────────────────────────────────────────────
do $$
declare
  v_msg text;
  v jsonb;
  v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.list_stranded_auth_users() s where s.email = 'r2477-pratik@example.test';
  if v_n <> 0 then raise exception 'FAIL 3: a login of another company is offered for Claim'; end if;
end $$;

reset role;
-- R-2477 review: even after a routine sign-in, B cannot claim him — he accepts himself.
update auth.users set last_sign_in_at = now() + interval '1 second' where id = 'c2477000-0000-0000-0000-0000000000c1';
-- the R-721 path's own precondition, as if written straight through the API (the route uses
-- membership_invites for him): an open team_invites row in B (A's old row moved out of the way)
delete from public.team_invites where email = 'r2477-pratik@example.test';
insert into public.team_invites (tenant_id, email, role, invited_by, created_at)
  values ('c2477000-0000-0000-0000-0000000000f2', 'r2477-pratik@example.test', 'sales', 'c2477000-0000-0000-0000-0000000000b1', now() - interval '1 hour');
set local role authenticated;

do $$
declare
  v jsonb;
  v_n int;
  v_msg text;
  v_inv uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.list_stranded_auth_users() s where s.email = 'r2477-pratik@example.test';
  if v_n <> 0 then raise exception 'FAIL 3: listed for Claim after a routine sign-in (% rows)', v_n; end if;
  begin
    perform public.merge_stranded_user_into_tenant('r2477-pratik@example.test', 'c2477000-0000-0000-0000-0000000000f2', 'sales');
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not ilike '%accept it themselves%' then
    raise exception 'FAIL 3: B claimed a login of another company without his agreement: %', v_msg;
  end if;

  -- pratik himself sees the invite and accepts it
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  select i.invite_id into v_inv from public.my_company_invites() i
   where i.company_name = 'R2477 Excel Co' and i.role = 'sales';
  if v_inv is null then raise exception 'FAIL 3: pratik does not see B''s invite'; end if;
  v := public.accept_company_invite(v_inv);
  if (v->>'selected')::boolean then raise exception 'FAIL 3: accepting moved his selected company away from A: %', v; end if;
  select count(*) into v_n from public.my_company_invites();
  if v_n <> 0 then raise exception 'FAIL 3: the accepted invite is still listed'; end if;
  raise notice 'PASS 3: B cannot claim him (no list, refused); he sees and accepts the invite himself';
end $$;

reset role;
do $$
begin
  if not exists (select 1 from public.tenant_memberships where user_id = 'c2477000-0000-0000-0000-0000000000c1'
                  and tenant_id = 'c2477000-0000-0000-0000-0000000000f2' and role = 'sales' and is_active and ended_at is null) then
    raise exception 'FAIL 3: no active sales membership in B';
  end if;
  if not exists (select 1 from public.users where id = 'c2477000-0000-0000-0000-0000000000c1'
                  and tenant_id = 'c2477000-0000-0000-0000-0000000000f1' and role = 'manager' and is_active) then
    raise exception 'FAIL 3: his selected company / role in A changed';
  end if;
  if not exists (select 1 from public.tenant_memberships where user_id = 'c2477000-0000-0000-0000-0000000000c1'
                  and tenant_id = 'c2477000-0000-0000-0000-0000000000f1' and ended_at is null and is_active) then
    raise exception 'FAIL 3: his A membership was ended by the claim';
  end if;
  if exists (select 1 from public.membership_invites where tenant_id = 'c2477000-0000-0000-0000-0000000000f2' and accepted_at is null) then
    raise exception 'FAIL 3: B''s invite still open after he accepted';
  end if;
end $$;
set local role authenticated;

-- ── 4. Cross-tenant: inviting/claiming never opens another company's data ───────────
do $$
declare
  v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.users where tenant_id = 'c2477000-0000-0000-0000-0000000000f1' or id = 'c2477000-0000-0000-0000-0000000000c1';
  if v_n <> 0 then raise exception 'FAIL 4: B''s owner reads % users rows of A / pratik''s row', v_n; end if;
  select count(*) into v_n from public.tenant_memberships where tenant_id <> 'c2477000-0000-0000-0000-0000000000f2';
  if v_n <> 0 then raise exception 'FAIL 4: B''s owner reads % memberships of other companies', v_n; end if;
  select count(*) into v_n from public.leads where id = 'R2477-LEAD-A';
  if v_n <> 0 then raise exception 'FAIL 4: B''s owner reads A''s lead'; end if;
  select count(*) into v_n from public.company_members() m where m.id = 'c2477000-0000-0000-0000-0000000000c1' and m.role = 'sales' and not m.is_selected;
  if v_n <> 1 then raise exception 'FAIL 4: B''s company_members() does not list pratik as sales (working elsewhere right now)'; end if;
  select count(*) into v_n from public.company_members() m where m.id in ('c2477000-0000-0000-0000-0000000000a1', 'c2477000-0000-0000-0000-0000000000a2', 'c2477000-0000-0000-0000-0000000000c2');
  if v_n <> 0 then raise exception 'FAIL 4: B''s company_members() lists % people of A', v_n; end if;

  -- pratik himself (A selected): A only
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is distinct from 'c2477000-0000-0000-0000-0000000000f1'::uuid then
    raise exception 'FAIL 4: pratik''s tenant is not A';
  end if;
  select count(*) into v_n from public.company_members() m where m.id = 'c2477000-0000-0000-0000-0000000000b1';
  if v_n <> 0 then raise exception 'FAIL 4: pratik (A selected) sees B''s owner in company_members()'; end if;
  select count(*) into v_n from public.leads where id = 'R2477-LEAD-B';
  if v_n <> 0 then raise exception 'FAIL 4: pratik (A selected) reads B''s lead'; end if;

  -- no session → nothing
  perform set_config('request.jwt.claims', '', true);
  select count(*) into v_n from public.company_members();
  if v_n <> 0 then raise exception 'FAIL 4: company_members() without a session returns % rows', v_n; end if;
  raise notice 'PASS 4: each owner sees only their own company; company_members lists memberships of the selected company only';
end $$;

-- ── 5. update_company_member ────────────────────────────────────────────────────────
do $$
declare
  v_msg text;
  v_state text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  perform public.update_company_member('c2477000-0000-0000-0000-0000000000c1', '{"role":"billing","gets_new_leads":true}');

  begin
    perform public.update_company_member('c2477000-0000-0000-0000-0000000000a1', '{"role":"sales"}');
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  if v_state is distinct from 'P0002' then raise exception 'FAIL 5: B''s owner editing A''s owner gave %', v_state; end if;

  v_state := null;
  begin
    perform public.update_company_member('c2477000-0000-0000-0000-0000000000b1', '{"role":"manager"}');
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not ilike '%last active owner%' then raise exception 'FAIL 5: last owner demoted: %', v_msg; end if;

  v_msg := null;
  begin
    perform public.update_company_member('c2477000-0000-0000-0000-0000000000c1', '{"manager_id":"c2477000-0000-0000-0000-0000000000a1"}');
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  if v_state is distinct from '22023' then raise exception 'FAIL 5: a manager from another company was accepted (%)', v_state; end if;

  v_msg := null;
  begin
    perform public.update_company_member('c2477000-0000-0000-0000-0000000000c1', '{"tenant_id":"c2477000-0000-0000-0000-0000000000f2"}');
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  if v_state is distinct from '22023' then raise exception 'FAIL 5: an unknown key was accepted (%)', v_state; end if;

  v_state := null;
  begin
    perform public.update_company_member('c2477000-0000-0000-0000-0000000000c1', '{"role":"boss"}');
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '22023' or v_msg not ilike '%Pick a role%' then
    raise exception 'FAIL 5: an unknown role gave % %', v_state, v_msg;
  end if;
  v_msg := null;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  begin
    perform public.update_company_member('c2477000-0000-0000-0000-0000000000c1', '{"role":"owner"}');
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null then raise exception 'FAIL 5: a sales user changed a role'; end if;
end $$;

reset role;
do $$
begin
  if not exists (select 1 from public.tenant_memberships where user_id = 'c2477000-0000-0000-0000-0000000000c1'
                  and tenant_id = 'c2477000-0000-0000-0000-0000000000f2' and role = 'billing' and gets_new_leads) then
    raise exception 'FAIL 5: B membership not updated';
  end if;
  if not exists (select 1 from public.users where id = 'c2477000-0000-0000-0000-0000000000c1' and role = 'manager' and not gets_new_leads) then
    raise exception 'FAIL 5: editing his B membership changed his A role on users';
  end if;
  raise notice 'PASS 5: owner edits the B membership only; non-owner / other company / last owner / foreign manager / unknown key refused';
end $$;
set local role authenticated;

-- ── 6. Remove from this company ─────────────────────────────────────────────────────
do $$
declare
  v_msg text;
  v_state text;
  v_n int;
begin
  -- B's sales: not an owner
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  begin perform public.remove_company_member('c2477000-0000-0000-0000-0000000000c1');
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text; end;
  if v_msg is null then raise exception 'FAIL 6: a sales user removed someone'; end if;

  -- A's owner removing themself
  v_msg := null;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  begin perform public.remove_company_member('c2477000-0000-0000-0000-0000000000a1');
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text; end;
  if v_msg is null or v_msg not ilike '%yourself%' then raise exception 'FAIL 6: owner removed themself: %', v_msg; end if;

  -- B's owner removing A's owner (not a member of B)
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  begin perform public.remove_company_member('c2477000-0000-0000-0000-0000000000a1');
  exception when others then get stacked diagnostics v_state = returned_sqlstate; end;
  if v_state is distinct from 'P0002' then raise exception 'FAIL 6: B''s owner on A''s owner gave %', v_state; end if;

  -- A2 (MFA enrolled) on aal1
  v_msg := null;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000a2', 'role', 'authenticated', 'aal', 'aal1')::text, true);
  begin perform public.remove_company_member('c2477000-0000-0000-0000-0000000000c1');
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text; end;
  if v_msg is null then raise exception 'FAIL 6: an aal1 session of an MFA owner removed someone'; end if;

  -- A's owner removes pratik
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  perform public.remove_company_member('c2477000-0000-0000-0000-0000000000c1');
  select count(*) into v_n from public.company_members() m where m.id = 'c2477000-0000-0000-0000-0000000000c1';
  if v_n <> 0 then raise exception 'FAIL 6: removed member still on A''s list'; end if;

  -- pratik now works only in B, with B's role
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is distinct from 'c2477000-0000-0000-0000-0000000000f2'::uuid then
    raise exception 'FAIL 6: after Remove his company is % (expected B)', public.current_tenant_id();
  end if;
  if not public.current_user_has_role('billing') or public.current_user_has_role('manager') then
    raise exception 'FAIL 6: after Remove his role is not B''s billing';
  end if;
  select count(*) into v_n from public.leads where id = 'R2477-LEAD-A';
  if v_n <> 0 then raise exception 'FAIL 6: removed member still reads A''s lead'; end if;
  begin
    perform public.switch_company('c2477000-0000-0000-0000-0000000000f1');
    raise exception 'FAIL 6: removed member switched back into A';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS 6: owner-only, never yourself, MFA, other company → not found; Remove lands him in B only';
end $$;

reset role;
do $$
begin
  if not exists (select 1 from public.tenant_memberships where user_id = 'c2477000-0000-0000-0000-0000000000c1'
                  and tenant_id = 'c2477000-0000-0000-0000-0000000000f1' and end_reason = 'removed'
                  and ended_at is not null and ended_by = 'c2477000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 6: A membership not ended as removed by A''s owner';
  end if;
  if not exists (select 1 from public.users where id = 'c2477000-0000-0000-0000-0000000000c1'
                  and tenant_id = 'c2477000-0000-0000-0000-0000000000f2' and role = 'billing' and is_active and gets_new_leads) then
    raise exception 'FAIL 6: users row does not carry B''s membership';
  end if;
  if not exists (select 1 from public.leads where id = 'R2477-LEAD-A'
                  and owner_id = 'c2477000-0000-0000-0000-0000000000c1' and created_by = 'c2477000-0000-0000-0000-0000000000c1') then
    raise exception 'FAIL 6: his A lead lost its author';
  end if;
  if not exists (select 1 from public.activity_log a, r2477_mark k where a.id > k.last_id
                  and a.tenant_id = 'c2477000-0000-0000-0000-0000000000f1' and a.action = 'member_removed'
                  and a.entity_id = 'c2477000-0000-0000-0000-0000000000c1' and a.user_id = 'c2477000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 6: no audit line in A';
  end if;
  if exists (select 1 from public.activity_log a, r2477_mark k where a.id > k.last_id
              and a.tenant_id = 'c2477000-0000-0000-0000-0000000000f2'
              and (coalesce(a.changes::text, '') || coalesce(a.label, '')) ~* '(c2477000-0000-0000-0000-0000000000f1|R2477 Anu)') then
    raise exception 'FAIL 6: B''s activity log names company A';
  end if;
  if exists (select 1 from public.activity_log a, r2477_mark k where a.id > k.last_id
              and a.tenant_id = 'c2477000-0000-0000-0000-0000000000f1' and a.action = 'member_removed'
              and coalesce(a.label, '') ~* 'R2477 Excel') then
    raise exception 'FAIL 6: A''s audit line names company B';
  end if;
end $$;
set local role authenticated;

-- ── 7. Remove with no other company: none ───────────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  perform public.remove_company_member('c2477000-0000-0000-0000-0000000000c2');
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is not null then raise exception 'FAIL 7: removed solo member still has a company'; end if;
end $$;

reset role;
do $$
begin
  if not exists (select 1 from public.users where id = 'c2477000-0000-0000-0000-0000000000c2' and not is_active) then
    raise exception 'FAIL 7: users row gone or still active';
  end if;
  raise notice 'PASS 7: Remove with no other company → users row stays, inactive, no company';
end $$;
set local role authenticated;

-- ── 8. Owners ───────────────────────────────────────────────────────────────────────
do $$
declare v_msg text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  perform public.remove_company_member('c2477000-0000-0000-0000-0000000000a2');
  begin perform public.update_company_member('c2477000-0000-0000-0000-0000000000a1', '{"role":"manager"}');
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text; end;
  if v_msg is null then raise exception 'FAIL 8: the last owner of A was demoted'; end if;
  raise notice 'PASS 8: an owner removes another owner; the last owner stays';
end $$;

-- ── 13. Claim of a member whose users.email differs from the login email: role fix only ──
reset role;
insert into public.team_invites (tenant_id, email, role, invited_by, created_at)
  values ('c2477000-0000-0000-0000-0000000000f2', 'r2477-mism@example.test', 'sales', 'c2477000-0000-0000-0000-0000000000b1', now() - interval '1 day');
update auth.users set last_sign_in_at = now() where id = 'c2477000-0000-0000-0000-0000000000c3';
set local role authenticated;
do $$
declare j jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  j := public.merge_stranded_user_into_tenant('r2477-mism@example.test', 'c2477000-0000-0000-0000-0000000000f2', 'sales');
  if j->>'action' <> 'already_member' then raise exception 'FAIL 13: action % (expected already_member)', j; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from public.tenant_memberships where user_id = 'c2477000-0000-0000-0000-0000000000c3'
                  and tenant_id = 'c2477000-0000-0000-0000-0000000000f2' and manager_id = 'c2477000-0000-0000-0000-0000000000b1' and gets_new_leads) then
    raise exception 'FAIL 13: claim reset the existing member''s manager / new-lead turn';
  end if;
  raise notice 'PASS 13: Claim of an existing member (other users.email) only fixes the role';
end $$;
set local role authenticated;

-- ── 9. users_tenant_delete is gone ──────────────────────────────────────────────────
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  delete from public.users where id = 'c2477000-0000-0000-0000-0000000000b2';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 9: an owner deleted a teammate''s users row'; end if;
  raise notice 'PASS 9: a teammate''s users row cannot be deleted from the app';
end $$;

-- ── 10. Re-invite after Remove → he accepts (rejoined); solo → Claim ───────────────────────────────────
do $$
declare v text; j jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  -- pratik works in B now: a membership invite he accepts; solo works nowhere: invite + Claim
  v := public.invite_existing_login('r2477-pratik@example.test', 'sales');
  if v <> 'invited' then raise exception 'FAIL 10: re-invite of pratik said %', v; end if;
  v := public.invite_existing_login('r2477-solo@example.test', 'support');
  if v <> 'no_company' then raise exception 'FAIL 11: re-invite of solo said % (expected no_company)', v; end if;
  insert into public.team_invites (tenant_id, email, role, invited_by)
    values ('c2477000-0000-0000-0000-0000000000f1', 'r2477-solo@example.test', 'support', 'c2477000-0000-0000-0000-0000000000a1');
end $$;

reset role;
update auth.users set last_sign_in_at = now() + interval '2 seconds'
 where id in ('c2477000-0000-0000-0000-0000000000c1', 'c2477000-0000-0000-0000-0000000000c2');
set local role authenticated;

do $$
declare j jsonb; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.list_stranded_auth_users() s
   where s.email = 'r2477-solo@example.test' and s.full_name is null and s.last_sign_in_at is null and s.created_at is null;
  if v_n <> 1 then raise exception 'FAIL 11: solo (works nowhere) not listed for Claim with the address only'; end if;
  select count(*) into v_n from public.list_stranded_auth_users() s where s.email = 'r2477-pratik@example.test';
  if v_n <> 0 then raise exception 'FAIL 10: pratik (works in B) listed for Claim'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  j := public.accept_company_invite((select i.invite_id from public.my_company_invites() i where i.company_name = 'R2477 Anu Co'));
  if (j->>'selected')::boolean then raise exception 'FAIL 10: accepting A moved him away from B'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  j := public.merge_stranded_user_into_tenant('r2477-solo@example.test', 'c2477000-0000-0000-0000-0000000000f1', 'support');
  if j->>'action' <> 'rejoined' then raise exception 'FAIL 11: solo action % (expected rejoined)', j; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is distinct from 'c2477000-0000-0000-0000-0000000000f2'::uuid then
    raise exception 'FAIL 10: rejoin moved his selected company away from B';
  end if;
  -- 12. switch both ways
  perform public.switch_company('c2477000-0000-0000-0000-0000000000f1');
  if public.current_tenant_id() is distinct from 'c2477000-0000-0000-0000-0000000000f1'::uuid
     or not public.current_user_has_role('sales') then
    raise exception 'FAIL 12: switch to A after rejoin';
  end if;
  perform public.switch_company('c2477000-0000-0000-0000-0000000000f2');
  if not public.current_user_has_role('billing') then raise exception 'FAIL 12: switch back to B'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c2477000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is distinct from 'c2477000-0000-0000-0000-0000000000f1'::uuid then
    raise exception 'FAIL 11: re-claimed solo login has no company';
  end if;
  raise notice 'PASS 10-12: re-invite → he accepts (same membership re-opened); solo (works nowhere) → Claim; switch works';
end $$;

reset role;
do $$
begin
  if (select count(*) from public.tenant_memberships where user_id = 'c2477000-0000-0000-0000-0000000000c1') <> 2 then
    raise exception 'FAIL 10: rejoin made a second row instead of re-opening';
  end if;
end $$;

rollback;
