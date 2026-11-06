-- R-2477 independent review (BLOCK) — the fixes in *_r2477_review_consent_email_guard.sql.
-- Spec: docs/specs/memberships.md §6.1.
--
-- Before that migration case R1 (the review's takeover proof) FAILS: B's owner changes the email
-- of A's owner once she works in B. With it:
--   R1. BLOCK repro: A's owner (Olga) accepts an invite to B and switches to B. B's owner's UPDATE of
--       her users.email is refused (42501) and the email is unchanged. Security review: a ONE-company
--       login that has signed in cannot be re-pointed by its owner either (pre-positioning); an owner
--       can still fix a teammate who never signed in, or re-align a profile email to the login's own
--       sign-in address.
--   R2. Consent: invite_existing_login writes a membership_invites row (the typed address only);
--       another owner / the invitee cannot read the table directly; another login cannot accept it;
--       an expired invite cannot be accepted; accepting twice is harmless.
--   R3. A workspace the login OWNS is never moved or deleted: a blank solo workspace owner accepts B's
--       invite → B becomes the selected company, the blank workspace and her owner membership stay;
--       a trusted (server) Claim of a blank-workspace OWNER adds a membership, never 'moved'.
--   R4. No rows of another company are deleted (A's accepted invite stays); prepare is gone; every
--       invite_existing_login call counts toward its hourly cap (31st → 54000).
--   R5. company_members().is_selected only for owners.
--   R6. (code review) an OPEN invite from another company also blocks an owner changing the email;
--       invitable roles only; accept refuses an invite whose sender is no longer an active owner, and
--       one sent to an address the login no longer signs in with.
--   R7. (code review) a pending join request to this company is the person's own agreement (Claim
--       works); a personal account that accepts a business invite starts working in the business.
--   R8. (re-review BLOCK) an owner re-points a never-signed-in teammate's profile email; another
--       company invites the real address → the login cannot accept (profile email ≠ sign-in
--       address); invite_existing_login answers 'plain' for "no login" and "no company" alike.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2477_review_consent_email_guard.test.sql

begin;

insert into auth.users (id, email, last_sign_in_at) values
  ('c2478000-0000-0000-0000-0000000000a1', 'r2477r-olga@example.test',   now() - interval '9 days'),
  ('c2478000-0000-0000-0000-0000000000b1', 'r2477r-owner-b@example.test', now() - interval '9 days'),
  ('c2478000-0000-0000-0000-0000000000b2', 'r2477r-sales-b@example.test', now() - interval '9 days'),
  ('c2478000-0000-0000-0000-0000000000c1', 'r2477r-solo@example.test',   now() - interval '9 days'),
  ('c2478000-0000-0000-0000-0000000000c2', 'r2477r-blank@example.test',  now() - interval '9 days'),
  ('c2478000-0000-0000-0000-0000000000e1', 'r2477r-owner-e@example.test', now() - interval '9 days');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2478000-0000-0000-0000-0000000000f1', 'R2477R Alpha Co', 'r2477ra@example.test', '07', 'R78A'),
  ('c2478000-0000-0000-0000-0000000000f2', 'R2477R Beta Co',  'r2477rb@example.test', '07', 'R78B'),
  ('c2478000-0000-0000-0000-0000000000f3', 'R2477R Solo Ws',  'r2477rc@example.test', '07', 'R78C'),
  ('c2478000-0000-0000-0000-0000000000f4', 'R2477R Blank Ws', 'r2477rd@example.test', '07', 'R78D'),
  ('c2478000-0000-0000-0000-0000000000f5', 'R2477R Eps Co',   'r2477re@example.test', '07', 'R78E');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2478000-0000-0000-0000-0000000000a1', 'c2478000-0000-0000-0000-0000000000f1', 'r2477r-olga@example.test',    'R2477R Olga',    'owner', true),
  ('c2478000-0000-0000-0000-0000000000b1', 'c2478000-0000-0000-0000-0000000000f2', 'r2477r-owner-b@example.test', 'R2477R Owner B', 'owner', true),
  ('c2478000-0000-0000-0000-0000000000b2', 'c2478000-0000-0000-0000-0000000000f2', 'r2477r-sales-b@example.test', 'R2477R Sales B', 'sales', true),
  ('c2478000-0000-0000-0000-0000000000c1', 'c2478000-0000-0000-0000-0000000000f3', 'r2477r-solo@example.test',    'R2477R Solo',    'owner', true),
  ('c2478000-0000-0000-0000-0000000000c2', 'c2478000-0000-0000-0000-0000000000f4', 'r2477r-blank@example.test',   'R2477R Blank',   'owner', true),
  ('c2478000-0000-0000-0000-0000000000e1', 'c2478000-0000-0000-0000-0000000000f5', 'r2477r-owner-e@example.test', 'R2477R Owner E', 'owner', true);

-- A is a real company (a record); A once invited Olga's address and it was accepted (history)
insert into public.leads (id, tenant_id, company) values ('R2477R-LEAD-A', 'c2478000-0000-0000-0000-0000000000f1', 'R2477R Lead A');
insert into public.team_invites (tenant_id, email, role, invited_by, created_at, accepted_at) values
  ('c2478000-0000-0000-0000-0000000000f1', 'r2477r-olga@example.test', 'owner', null, now() - interval '60 days', now() - interval '59 days');

set local role authenticated;

-- ── R2 + R4: B invites Olga (owner of A); RLS on membership_invites; cap ─────────────────
do $$
declare v text; v_n int; v_msg text; v_state text; v_inv uuid; j jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('R2477R-Olga@Example.test', 'sales');
  if v <> 'invited' then raise exception 'FAIL R2: invite said %', v; end if;
  v := public.invite_existing_login('r2477r-nobody@example.test', 'sales');
  if v <> 'plain' then raise exception 'FAIL R2: unknown address said %', v; end if;
  select count(*) into v_n from public.membership_invites i
   where i.email = 'r2477r-olga@example.test' and i.role = 'sales' and i.accepted_at is null;
  if v_n <> 1 then raise exception 'FAIL R2: B''s owner does not see its own invite (typed address)'; end if;

  -- E's owner cannot see B's invites; Olga cannot read the table directly either
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000e1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.membership_invites;
  if v_n <> 0 then raise exception 'FAIL R2: another company''s owner reads % membership invites', v_n; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.membership_invites;
  if v_n <> 0 then raise exception 'FAIL R2: the invitee reads the table directly (% rows)', v_n; end if;
  select i.invite_id into v_inv from public.my_company_invites() i where i.company_name = 'R2477R Beta Co';
  if v_inv is null then raise exception 'FAIL R2: Olga does not see B''s invite'; end if;

  -- B's sales (another login) cannot accept Olga's invite
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  begin perform public.accept_company_invite(v_inv);
  exception when others then get stacked diagnostics v_state = returned_sqlstate; end;
  if v_state is distinct from 'P0002' then raise exception 'FAIL R2: another login accepted Olga''s invite (%)', v_state; end if;

  -- Olga accepts; A stays selected (A is real); twice is harmless
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  j := public.accept_company_invite(v_inv);
  if (j->>'selected')::boolean or j->>'company_name' <> 'R2477R Beta Co' then raise exception 'FAIL R2: accept answered %', j; end if;
  j := public.accept_company_invite(v_inv);
  if not (j->>'already')::boolean then raise exception 'FAIL R2: second accept answered %', j; end if;
  if public.current_tenant_id() is distinct from 'c2478000-0000-0000-0000-0000000000f1'::uuid then
    raise exception 'FAIL R2: accepting moved Olga away from A';
  end if;
  raise notice 'PASS R2: membership invite (typed address only), RLS, only the invitee accepts, idempotent';
end $$;

reset role;
do $$
begin
  if not exists (select 1 from public.team_invites where tenant_id = 'c2478000-0000-0000-0000-0000000000f1' and email = 'r2477r-olga@example.test') then
    raise exception 'FAIL R4: B''s invite deleted A''s accepted invite row';
  end if;
  if to_regprocedure('public.prepare_invite_for_existing_login(text)') is not null then
    raise exception 'FAIL R4: prepare_invite_for_existing_login still exists';
  end if;
  raise notice 'PASS R4a: nothing deleted in A; prepare is gone';
end $$;
set local role authenticated;

-- ── R1: the review's takeover proof ─────────────────────────────────────────────────────
do $$
declare v_n int; v_msg text;
begin
  -- Olga switches to B (as the review did)
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  perform public.switch_company('c2478000-0000-0000-0000-0000000000f2');

  -- B's owner points her email at an address B controls
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  begin
    update public.users set email = 'attacker@r2477r-evil.test' where id = 'c2478000-0000-0000-0000-0000000000a1';
    get diagnostics v_n = row_count;
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null then raise exception 'FAIL R1: B''s owner changed Olga''s email (% rows) — takeover', v_n; end if;
  if v_msg not ilike '%only they can change their email%' then raise exception 'FAIL R1: refusal without a next step: %', v_msg; end if;

  -- security review: pre-positioning — a ONE-company login that has signed in (sales B) cannot be
  -- pointed at another address by its owner either (it would carry into any later company)
  v_msg := null;
  begin
    update public.users set email = 'attacker3@r2477r-evil.test' where id = 'c2478000-0000-0000-0000-0000000000b2';
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null then raise exception 'FAIL R1: owner re-pointed a signed-in one-company teammate''s email'; end if;
  raise notice 'PASS R1: no owner can change the sign-in email of a login that signed in or works elsewhere';
end $$;

reset role;
-- re-review: a teammate who has never signed in is NOT re-pointable any more (the lever); a profile
-- email that drifted from the login's own address can still be re-aligned by the owner
select set_config('request.jwt.claims', '', true);   -- a server path (no signed-in user) for the fixture
insert into auth.users (id, email) values ('c2478000-0000-0000-0000-0000000000b4', 'r2477r-new-b@example.test');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2478000-0000-0000-0000-0000000000b4', 'c2478000-0000-0000-0000-0000000000f2', 'r2477r-new-b@example.test', 'R2477R New B', 'support', true);
update public.users set email = 'r2477r-drifted@example.test' where id = 'c2478000-0000-0000-0000-0000000000b2';
set local role authenticated;
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  begin
    update public.users set email = 'r2477r-new-b-fixed@example.test' where id = 'c2478000-0000-0000-0000-0000000000b4';
    raise exception 'FAIL R1: owner re-pointed the email of a teammate who never signed in';
  exception when insufficient_privilege then null;
  end;
  update public.users set email = 'r2477r-sales-b@example.test' where id = 'c2478000-0000-0000-0000-0000000000b2';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL R1: owner cannot re-align a profile email to the login''s own address'; end if;
  raise notice 'PASS R1b: never-signed-in teammate not re-pointable; re-align to the sign-in address still works';
end $$;

reset role;
do $$
begin
  if not exists (select 1 from public.users where id = 'c2478000-0000-0000-0000-0000000000a1' and email = 'r2477r-olga@example.test') then
    raise exception 'FAIL R1: Olga''s email changed';
  end if;
  if exists (select 1 from public.users where lower(email) = 'attacker@r2477r-evil.test') then
    raise exception 'FAIL R1: a profile now carries the attacker address';
  end if;
end $$;
set local role authenticated;

-- ── R3: a workspace the login OWNS is never moved or deleted ────────────────────────────
do $$
declare v text; j jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('r2477r-solo@example.test', 'support');
  if v <> 'invited' then raise exception 'FAIL R3: invite of a blank-workspace owner said %', v; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  j := public.accept_company_invite((select i.invite_id from public.my_company_invites() i));
  if not (j->>'selected')::boolean then raise exception 'FAIL R3: blank own workspace — B not selected after accept: %', j; end if;
  if public.current_tenant_id() is distinct from 'c2478000-0000-0000-0000-0000000000f2'::uuid then
    raise exception 'FAIL R3: solo is not in B after accepting';
  end if;
end $$;

reset role;
-- a trusted server Claim (platform admin) of the OWNER of a blank workspace: a membership, never a move
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare j jsonb;
begin
  j := public.merge_stranded_user_into_tenant('r2477r-blank@example.test', 'c2478000-0000-0000-0000-0000000000f2', 'support');
  if j->>'action' <> 'added' or (j->>'old_tenant_deleted')::boolean then
    raise exception 'FAIL R3: trusted claim of a blank-workspace owner answered %', j;
  end if;
  if (select count(*) from public.tenants where id in ('c2478000-0000-0000-0000-0000000000f3', 'c2478000-0000-0000-0000-0000000000f4')) <> 2 then
    raise exception 'FAIL R3: an owned workspace was deleted';
  end if;
  if not exists (select 1 from public.tenant_memberships where user_id = 'c2478000-0000-0000-0000-0000000000c1'
                  and tenant_id = 'c2478000-0000-0000-0000-0000000000f3' and role = 'owner' and ended_at is null) then
    raise exception 'FAIL R3: solo''s owner membership of her own workspace was ended';
  end if;
  raise notice 'PASS R3: owned workspaces are kept (accept selects B for a blank one; trusted Claim adds a membership)';
end $$;
select set_config('request.jwt.claims', '', true);

-- ── R4b: every invite_existing_login call is counted ────────────────────────────────────
insert into public.activity_log (tenant_id, user_id, action, entity, label)
select 'c2478000-0000-0000-0000-0000000000f5', 'c2478000-0000-0000-0000-0000000000e1', 'team_invite.existing_login', 'team_invite', 'cap fixture'
  from generate_series(1, 30);
set local role authenticated;
do $$
declare v_state text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000e1', 'role', 'authenticated')::text, true);
  begin perform public.invite_existing_login('r2477r-nobody@example.test', 'sales');
  exception when others then get stacked diagnostics v_state = returned_sqlstate; end;
  if v_state is distinct from '54000' then raise exception 'FAIL R4: the 31st call in an hour was not capped (%)', v_state; end if;
  raise notice 'PASS R4b: invite_existing_login is capped at 30 calls an hour';
end $$;

-- ── R5: is_selected only for owners ─────────────────────────────────────────────────────
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.company_members() m where m.is_selected is not null;
  if v_n <> 0 then raise exception 'FAIL R5: a sales member sees who works elsewhere (% rows)', v_n; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.company_members() m where m.is_selected is null;
  if v_n <> 0 then raise exception 'FAIL R5: the owner misses is_selected on % rows', v_n; end if;
  raise notice 'PASS R5: is_selected for owners only';
end $$;


-- ── R6: open invites, roles, stale sender, changed address ─────────────────────────────
reset role;
insert into auth.users (id, email, last_sign_in_at) values
  ('c2478000-0000-0000-0000-0000000000d1', 'r2477r-dana@example.test', now() - interval '9 days'),
  ('c2478000-0000-0000-0000-0000000000d2', 'r2477r-pers@example.test', now() - interval '9 days'),
  ('c2478000-0000-0000-0000-0000000000d3', 'r2477r-joiner@example.test', now() - interval '9 days'),
  ('c2478000-0000-0000-0000-0000000000b3', 'r2477r-owner-b2@example.test', now() - interval '9 days');
insert into public.tenants (id, name, email, state_code, doc_code, workspace_kind) values
  ('c2478000-0000-0000-0000-0000000000f6', 'R2477R Personal Ws', 'r2477rf@example.test', '07', 'R78F', 'personal');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2478000-0000-0000-0000-0000000000d1', 'c2478000-0000-0000-0000-0000000000f5', 'r2477r-dana@example.test',   'R2477R Dana',   'sales',    true),
  ('c2478000-0000-0000-0000-0000000000d2', 'c2478000-0000-0000-0000-0000000000f6', 'r2477r-pers@example.test',   'R2477R Pers',   'personal', true),
  ('c2478000-0000-0000-0000-0000000000d3', 'c2478000-0000-0000-0000-0000000000f5', 'r2477r-joiner@example.test', 'R2477R Joiner', 'sales',    true),
  ('c2478000-0000-0000-0000-0000000000b3', 'c2478000-0000-0000-0000-0000000000f2', 'r2477r-owner-b2@example.test', 'R2477R Owner B2', 'owner', true);
insert into public.leads (id, tenant_id, company) values ('R2477R-LEAD-E', 'c2478000-0000-0000-0000-0000000000f5', 'R2477R Lead E');
set local role authenticated;

do $$
declare v text; v_msg text; v_state text; v_n int; v_inv uuid; j jsonb;
begin
  -- B's owner B2 invites Dana (works only in E); E's owner then tries to change Dana's email
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b3', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('r2477r-dana@example.test', 'owner');
  if v <> 'invited' then raise exception 'FAIL R6: invite of Dana said %', v; end if;
  begin perform public.invite_existing_login('r2477r-dana@example.test', 'personal');
  exception when others then get stacked diagnostics v_state = returned_sqlstate; end;
  if v_state is distinct from '22023' then raise exception 'FAIL R6: a personal-role invite was accepted (%)', v_state; end if;
  v_state := null;
  begin perform public.invite_existing_login('r2477r-dana@example.test', 'partner_agent');
  exception when others then get stacked diagnostics v_state = returned_sqlstate; end;
  if v_state is distinct from '22023' then raise exception 'FAIL R6: a partner_agent invite was accepted (%)', v_state; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000e1', 'role', 'authenticated')::text, true);
  begin
    update public.users set email = 'attacker2@r2477r-evil.test' where id = 'c2478000-0000-0000-0000-0000000000d1';
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null then raise exception 'FAIL R6: E''s owner changed the email of a login with an open invite elsewhere'; end if;

  -- B2 stops being an owner (B's owner demotes B2) → Dana can no longer accept B2's owner invite
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  perform public.update_company_member('c2478000-0000-0000-0000-0000000000b3', '{"role":"sales"}');
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000d1', 'role', 'authenticated')::text, true);
  select i.invite_id into v_inv from public.my_company_invites() i where i.company_name = 'R2477R Beta Co';
  v_msg := null;
  begin perform public.accept_company_invite(v_inv);
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text; end;
  if v_msg is null or v_msg not ilike '%no longer an owner%' then raise exception 'FAIL R6: accepted an invite whose sender was demoted: %', v_msg; end if;

  -- B's owner re-invites Dana (sales); her sign-in address changes before she accepts → refused
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('r2477r-dana@example.test', 'sales');
  if v <> 'invited' then raise exception 'FAIL R6: re-invite of Dana said %', v; end if;
end $$;

reset role;
update auth.users set email = 'r2477r-dana-new@example.test' where id = 'c2478000-0000-0000-0000-0000000000d1';
set local role authenticated;
do $$
declare v_msg text; v_inv uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000d1', 'role', 'authenticated')::text, true);
  select i.invite_id into v_inv from public.my_company_invites() i where i.company_name = 'R2477R Beta Co';
  begin perform public.accept_company_invite(v_inv);
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text; end;
  if v_msg is null or v_msg not ilike '%another email address%' then raise exception 'FAIL R6: accepted an invite sent to an old address: %', v_msg; end if;
  raise notice 'PASS R6: open invites block email changes; invitable roles only; stale sender / changed address refused';
end $$;

-- ── R7: join request = own agreement; a personal account accepting a business invite ─────
reset role;
insert into public.join_requests (tenant_id, auth_user_id, email, matched_by)
  values ('c2478000-0000-0000-0000-0000000000f2', 'c2478000-0000-0000-0000-0000000000d3', 'r2477r-joiner@example.test', 'manual');
set local role authenticated;
do $$
declare j jsonb; v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  j := public.merge_stranded_user_into_tenant('r2477r-joiner@example.test', 'c2478000-0000-0000-0000-0000000000f2', 'sales');
  if j->>'action' <> 'added' then raise exception 'FAIL R7: claim of a join requester answered %', j; end if;

  v := public.invite_existing_login('r2477r-pers@example.test', 'support');
  if v <> 'invited' then raise exception 'FAIL R7: invite of a personal account said %', v; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000d2', 'role', 'authenticated')::text, true);
  j := public.accept_company_invite((select i.invite_id from public.my_company_invites() i));
  if not (j->>'selected')::boolean then raise exception 'FAIL R7: personal account not moved into the business on accept: %', j; end if;
  if not public.current_user_has_role('support') then raise exception 'FAIL R7: personal account has no business role after accept'; end if;
  raise notice 'PASS R7: join request counts as agreement; personal account accepting works in the business';
end $$;


-- ── R8 (re-review BLOCK): an owner re-points a never-signed-in teammate's profile email, another
--    company invites the teammate's real address — the login cannot accept while its profile email
--    is not its sign-in address. invite_existing_login answers 'plain' for "no login" and "no company".
reset role;
select set_config('request.jwt.claims', '', true);
insert into auth.users (id, email) values
  ('c2478000-0000-0000-0000-0000000000e2', 'r2477r-tina@example.test');            -- never signed in
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2478000-0000-0000-0000-0000000000e2', 'c2478000-0000-0000-0000-0000000000f5', 'r2477r-tina@example.test', 'R2477R Tina', 'sales', true);
-- a profile email that ALREADY differs from her sign-in address (older data, re-pointed before this
-- guard existed) — a server path, as superuser
update public.users set email = 'tina-owned-by-e@r2477r-evil.test' where id = 'c2478000-0000-0000-0000-0000000000e2';
set local role authenticated;

do $$
declare v text; v_msg text; v_inv uuid; v_n int;
begin
  -- E's owner can no longer re-point Tina's profile email (the root fix) …
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000e1', 'role', 'authenticated')::text, true);
  begin
    update public.users set email = 'tina-again@r2477r-evil.test' where id = 'c2478000-0000-0000-0000-0000000000e2';
    raise exception 'FAIL R8: E''s owner re-pointed a never-signed-in teammate''s email';
  exception when insufficient_privilege then null;
  end;

  -- B invites Tina's real address
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('r2477r-tina@example.test', 'manager');
  if v <> 'invited' then raise exception 'FAIL R8: invite of Tina said %', v; end if;
  -- uniform answers: an unknown address and a login in no company look the same
  v := public.invite_existing_login('r2477r-nobody-at-all@example.test', 'sales');
  if v <> 'plain' then raise exception 'FAIL R8: unknown address said % (expected plain)', v; end if;

  -- whoever holds Tina's login now (E's owner via the re-pointed address) tries to accept
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2478000-0000-0000-0000-0000000000e2', 'role', 'authenticated')::text, true);
  select i.invite_id into v_inv from public.my_company_invites() i where i.company_name = 'R2477R Beta Co';
  begin perform public.accept_company_invite(v_inv);
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text; end;
  if v_msg is null or v_msg not ilike '%profile email is not the address you sign in with%' then
    raise exception 'FAIL R8: accepted while the profile email was re-pointed: %', v_msg;
  end if;
  if exists (select 1 from public.tenant_memberships m where m.user_id = 'c2478000-0000-0000-0000-0000000000e2'
              and m.tenant_id = 'c2478000-0000-0000-0000-0000000000f2') then
    raise exception 'FAIL R8: a membership in B was created';
  end if;
  raise notice 'PASS R8: re-pointed profile email → the invite cannot be accepted; uniform plain answer';
end $$;

rollback;
