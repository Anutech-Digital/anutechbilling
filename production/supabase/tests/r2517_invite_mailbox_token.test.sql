-- R-2517 — accepting an invite from another company needs the emailed link's token (proof of the
-- invited mailbox), not only the login. Migration: *_r2517_invite_mailbox_token.sql.
-- Spec: docs/specs/memberships.md §6.3.
--
-- The attack (R-2477 independent review, residual): Xena works in B (sales). B's owner once set a
-- temporary password for her that she never used (she signs in with Google). Company A invites
-- Xena's address. B's owner signs in AS Xena with the old password (a session as Xena here) and
-- accepts A's invite → B's owner holds A's role. Before the migration case 1 FAILS (the in-app
-- accept works with the login alone). With it:
--   1. The session as Xena WITHOUT the token: accept_company_invite(uuid) refused (names the email
--      link), accept_company_invite_by_token with no / a wrong / a made-up token → P0002; no
--      membership in A. The banner list shows the address + has_link, never the token or hash.
--   2. Only a hash is stored: no column holds the token itself.
--   3. company_invite_by_token: right token → 'open' (company, role, address); another login with
--      the right token → 'other_login'; garbage → 'not_found'.
--   4. Another login WITH the right token cannot accept (42501), no membership is made.
--   5. No two-step sign-in (aal1 with a verified factor) → refused.
--   6. Xena WITH the token accepts: membership in A (invited role), her selected company stays B.
--      The same token again → refused ('already used'), page state 'used'.
--   7. Expired token refused; a renewed invite replaces the hash → the old link 'not valid', the
--      new one works.
--   8. The 2-argument invite_existing_login makes an invite with no link (has_link false) that no
--      token can accept.
--   9. Grants: anon cannot run the new functions; authenticated cannot run r2517_token_hash /
--      r2517_invite_blocker.
--  10. (code review) the page answers 'blocked' + the reason when an R-2477 check would refuse the
--      accept (here: the sign-in address changed) — no Accept offered that then fails.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2517_invite_mailbox_token.test.sql

begin;

insert into auth.users (id, email, last_sign_in_at) values
  ('c2517000-0000-0000-0000-0000000000a1', 'r2517-owner-a@example.test', now() - interval '9 days'),
  ('c2517000-0000-0000-0000-0000000000b1', 'r2517-owner-b@example.test', now() - interval '9 days'),
  ('c2517000-0000-0000-0000-0000000000b2', 'r2517-xena@example.test',    now() - interval '9 days'),
  ('c2517000-0000-0000-0000-0000000000b3', 'r2517-mfa@example.test',     now() - interval '9 days'),
  ('c2517000-0000-0000-0000-0000000000c1', 'r2517-owner-c@example.test', now() - interval '9 days');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2517000-0000-0000-0000-0000000000f1', 'R2517 Alpha Co', 'r2517a@example.test', '07', 'R17A'),
  ('c2517000-0000-0000-0000-0000000000f2', 'R2517 Beta Co',  'r2517b@example.test', '07', 'R17B'),
  ('c2517000-0000-0000-0000-0000000000f3', 'R2517 Gamma Co', 'r2517c@example.test', '07', 'R17C');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2517000-0000-0000-0000-0000000000a1', 'c2517000-0000-0000-0000-0000000000f1', 'r2517-owner-a@example.test', 'R2517 Owner A', 'owner', true),
  ('c2517000-0000-0000-0000-0000000000b1', 'c2517000-0000-0000-0000-0000000000f2', 'r2517-owner-b@example.test', 'R2517 Owner B', 'owner', true),
  ('c2517000-0000-0000-0000-0000000000b2', 'c2517000-0000-0000-0000-0000000000f2', 'r2517-xena@example.test',    'R2517 Xena',    'sales', true),
  ('c2517000-0000-0000-0000-0000000000b3', 'c2517000-0000-0000-0000-0000000000f2', 'r2517-mfa@example.test',     'R2517 Mfa',     'support', true),
  ('c2517000-0000-0000-0000-0000000000c1', 'c2517000-0000-0000-0000-0000000000f3', 'r2517-owner-c@example.test', 'R2517 Owner C', 'owner', true);

-- B is a real company (a record), so accepting never moves Xena's selected company
insert into public.leads (id, tenant_id, company) values ('R2517-LEAD-B', 'c2517000-0000-0000-0000-0000000000f2', 'R2517 Lead B');

-- Mfa (a B login) has a verified authenticator → an aal1 session is not enough
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c2517000-0000-0000-0000-0000000000d1', 'c2517000-0000-0000-0000-0000000000b3', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());

-- the tokens the app would have emailed (base64url shape) and their hashes
create temp table r2517_tok (k text primary key, tok text, hash text);
insert into r2517_tok (k, tok) values
  ('xena_a',  'r2517-XenaA_tokentokentokentokentoken1'),
  ('mfa_a',   'r2517-MfaA_tokentokentokentokentokentok2'),
  ('xena_c1', 'r2517-XenaC1_tokentokentokentokentoken3'),
  ('xena_c2', 'r2517-XenaC2_tokentokentokentokentoken4'),
  ('mfa_c',   'r2517-MfaC_tokentokentokentokentokentok5');
update r2517_tok set hash = encode(sha256(convert_to(tok, 'UTF8')), 'hex');
grant select on r2517_tok to authenticated;

set local role authenticated;

-- A's owner invites Xena (with a link) and Mfa (with a link)
do $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('R2517-Xena@Example.test', 'manager', (select hash from r2517_tok where k = 'xena_a'));
  if v <> 'invited' then raise exception 'SETUP: invite of Xena said %', v; end if;
  v := public.invite_existing_login('r2517-mfa@example.test', 'sales', (select hash from r2517_tok where k = 'mfa_a'));
  if v <> 'invited' then raise exception 'SETUP: invite of Mfa said %', v; end if;
  begin
    perform public.invite_existing_login('r2517-mfa@example.test', 'sales', 'not-a-hash');
    raise exception 'FAIL setup: a malformed hash was stored';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- ── 1. the attacker: a session as Xena WITHOUT the token ────────────────────────────────
do $$
declare v_state text; v_msg text; v_inv uuid; v_email text; v_link boolean; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  select i.invite_id, i.email, i.has_link into v_inv, v_email, v_link
    from public.my_company_invites() i where i.company_name = 'R2517 Alpha Co';
  if v_inv is null or v_email <> 'r2517-xena@example.test' or not v_link then
    raise exception 'FAIL 1: banner list wrong (inv %, email %, link %)', v_inv, v_email, v_link;
  end if;

  begin perform public.accept_company_invite(v_inv);
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text; end;
  if v_state is distinct from '42501' or v_msg not ilike '%link in the invite email%' then
    raise exception 'FAIL 1: the old in-app accept still works or says the wrong thing (%: %)', v_state, v_msg;
  end if;

  foreach v_msg in array array['', 'short', 'r2517-made-up_tokentokentokentokentokenX', 'has spaces in it but is long enough to pass'] loop
    v_state := null;
    begin perform public.accept_company_invite_by_token(v_msg);
    exception when others then get stacked diagnostics v_state = returned_sqlstate; end;
    if v_state is distinct from 'P0002' then raise exception 'FAIL 1: token "%" gave % (expected P0002)', v_msg, v_state; end if;
  end loop;
  v_state := null;
  begin perform public.accept_company_invite_by_token(null);
  exception when others then get stacked diagnostics v_state = returned_sqlstate; end;
  if v_state is distinct from 'P0002' then raise exception 'FAIL 1: null token gave %', v_state; end if;

  select count(*) into v_n from public.my_companies() c where c.tenant_id = 'c2517000-0000-0000-0000-0000000000f1';
  if v_n <> 0 then raise exception 'FAIL 1: Xena joined A without the token'; end if;
  raise notice 'PASS 1: no token → no accept (old accept refused, empty/wrong/made-up token P0002)';
end $$;

-- ── 2. only a hash is stored ────────────────────────────────────────────────────────────
reset role;
do $$
declare v_n int;
begin
  select count(*) into v_n from public.membership_invites i, r2517_tok t
   where t.k = 'xena_a' and i.user_id = 'c2517000-0000-0000-0000-0000000000b2'
     and i.token_hash = t.hash;
  if v_n <> 1 then raise exception 'FAIL 2: the invite does not carry the token hash'; end if;
  select count(*) into v_n from public.membership_invites i, r2517_tok t
   where strpos(row_to_json(i)::text, t.tok) > 0;
  if v_n <> 0 then raise exception 'FAIL 2: a token is stored in membership_invites'; end if;
  raise notice 'PASS 2: only the sha256 of the token is stored';
end $$;
set local role authenticated;

-- ── 3 + 4 + 5: the accept page, another login, MFA ──────────────────────────────────────
do $$
declare j jsonb; v_state text; v_msg text; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  j := public.company_invite_by_token((select tok from r2517_tok where k = 'xena_a'));
  if j->>'state' <> 'open' or j->>'company_name' <> 'R2517 Alpha Co' or j->>'role' <> 'manager'
     or j->>'email' <> 'r2517-xena@example.test' then
    raise exception 'FAIL 3: page answer for Xena %', j;
  end if;
  j := public.company_invite_by_token('garbage');
  if j->>'state' <> 'not_found' then raise exception 'FAIL 3: garbage token answered %', j; end if;

  -- B's owner (another login) holds Xena's token
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  j := public.company_invite_by_token((select tok from r2517_tok where k = 'xena_a'));
  if j->>'state' <> 'other_login' or j ? 'company_name' then raise exception 'FAIL 3: another login sees %', j; end if;
  begin perform public.accept_company_invite_by_token((select tok from r2517_tok where k = 'xena_a'));
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text; end;
  if v_state is distinct from '42501' or v_msg not ilike '%sent to another email address%' then
    raise exception 'FAIL 4: another login with the token: % %', v_state, v_msg;
  end if;
  select count(*) into v_n from public.tenant_memberships m
   where m.user_id = 'c2517000-0000-0000-0000-0000000000b1' and m.tenant_id = 'c2517000-0000-0000-0000-0000000000f1';
  if v_n <> 0 then raise exception 'FAIL 4: B''s owner got a membership in A'; end if;

  -- Mfa on aal1 (verified factor) → refused, also the page
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000b3', 'role', 'authenticated', 'aal', 'aal1')::text, true);
  v_state := null;
  begin perform public.accept_company_invite_by_token((select tok from r2517_tok where k = 'mfa_a'));
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text; end;
  if v_state is distinct from '42501' or v_msg not ilike '%two-step%' then raise exception 'FAIL 5: aal1 accept: % %', v_state, v_msg; end if;
  v_state := null;
  begin perform public.company_invite_by_token((select tok from r2517_tok where k = 'mfa_a'));
  exception when others then get stacked diagnostics v_state = returned_sqlstate; end;
  if v_state is distinct from '42501' then raise exception 'FAIL 5: aal1 page read gave %', v_state; end if;
  -- aal2 → accepts
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000b3', 'role', 'authenticated', 'aal', 'aal2')::text, true);
  j := public.accept_company_invite_by_token((select tok from r2517_tok where k = 'mfa_a'));
  if j->>'role' <> 'sales' then raise exception 'FAIL 5: aal2 accept answered %', j; end if;
  raise notice 'PASS 3+4+5: page states, another login refused, aal1 refused / aal2 accepts';
end $$;

-- ── 6: Xena with the token; single use ──────────────────────────────────────────────────
do $$
declare j jsonb; v_state text; v_msg text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  j := public.accept_company_invite_by_token((select tok from r2517_tok where k = 'xena_a'));
  if j->>'company_name' <> 'R2517 Alpha Co' or j->>'role' <> 'manager' or (j->>'selected')::boolean then
    raise exception 'FAIL 6: accept answered %', j;
  end if;
  if not exists (select 1 from public.my_companies() c where c.tenant_id = 'c2517000-0000-0000-0000-0000000000f1' and c.role = 'manager') then
    raise exception 'FAIL 6: no manager membership in A after accept';
  end if;
  if public.current_tenant_id() is distinct from 'c2517000-0000-0000-0000-0000000000f2'::uuid then
    raise exception 'FAIL 6: accepting moved Xena away from B';
  end if;
  begin perform public.accept_company_invite_by_token((select tok from r2517_tok where k = 'xena_a'));
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text; end;
  if v_state is distinct from '42501' or v_msg not ilike '%already used%' then raise exception 'FAIL 6: second use: % %', v_state, v_msg; end if;
  j := public.company_invite_by_token((select tok from r2517_tok where k = 'xena_a'));
  if j->>'state' <> 'used' then raise exception 'FAIL 6: page after use says %', j; end if;
  raise notice 'PASS 6: the invitee with the token joins as the invited role; the link is single-use';
end $$;

-- ── 7: expired; renewed invite replaces the link ────────────────────────────────────────
do $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('r2517-xena@example.test', 'support', (select hash from r2517_tok where k = 'xena_c1'));
  if v <> 'invited' then raise exception 'SETUP 7: C invite said %', v; end if;
end $$;
reset role;
update public.membership_invites set expires_at = now() - interval '1 minute'
 where tenant_id = 'c2517000-0000-0000-0000-0000000000f3' and user_id = 'c2517000-0000-0000-0000-0000000000b2';
set local role authenticated;
do $$
declare j jsonb; v text; v_state text; v_msg text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  j := public.company_invite_by_token((select tok from r2517_tok where k = 'xena_c1'));
  if j->>'state' <> 'expired' then raise exception 'FAIL 7: expired page state %', j; end if;
  begin perform public.accept_company_invite_by_token((select tok from r2517_tok where k = 'xena_c1'));
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text; end;
  if v_state is distinct from '42501' or v_msg not ilike '%expired%invite you again%' then raise exception 'FAIL 7: expired accept: % %', v_state, v_msg; end if;

  -- C invites again → new link; the old one is dead
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('r2517-xena@example.test', 'support', (select hash from r2517_tok where k = 'xena_c2'));
  if v <> 'invited' then raise exception 'FAIL 7: renew said %', v; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
  v_state := null;
  begin perform public.accept_company_invite_by_token((select tok from r2517_tok where k = 'xena_c1'));
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text; end;
  if v_state is distinct from 'P0002' or v_msg not ilike '%newer invite%' then raise exception 'FAIL 7: old link after renew: % %', v_state, v_msg; end if;
  j := public.accept_company_invite_by_token((select tok from r2517_tok where k = 'xena_c2'));
  if j->>'company_name' <> 'R2517 Gamma Co' then raise exception 'FAIL 7: new link answered %', j; end if;
  raise notice 'PASS 7: expired refused with a next step; a renewed invite kills the old link';
end $$;

-- ── 8: the 2-argument form makes an invite without a link ───────────────────────────────
do $$
declare v text; v_link boolean; v_state text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('r2517-owner-a@example.test', 'sales');
  if v <> 'invited' then raise exception 'FAIL 8: 2-arg invite said %', v; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  select i.has_link into v_link from public.my_company_invites() i where i.company_name = 'R2517 Gamma Co';
  if v_link is distinct from false then raise exception 'FAIL 8: has_link is % for a link-less invite', v_link; end if;
  begin perform public.accept_company_invite_by_token('r2517-anything_tokentokentokentokentokentok');
  exception when others then get stacked diagnostics v_state = returned_sqlstate; end;
  if v_state is distinct from 'P0002' then raise exception 'FAIL 8: link-less invite accepted (%)', v_state; end if;
  raise notice 'PASS 8: an invite without a link cannot be accepted';
end $$;

-- ── 10: the page says 'blocked' with the same reason the accept gives ──────────────────
do $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
  v := public.invite_existing_login('r2517-mfa@example.test', 'support', (select hash from r2517_tok where k = 'mfa_c'));
  if v <> 'invited' then raise exception 'SETUP 10: C invite of Mfa said %', v; end if;
end $$;
reset role;
update auth.users set email = 'r2517-mfa-new@example.test' where id = 'c2517000-0000-0000-0000-0000000000b3';
set local role authenticated;
do $$
declare j jsonb; v_state text; v_msg text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c2517000-0000-0000-0000-0000000000b3', 'role', 'authenticated', 'aal', 'aal2')::text, true);
  j := public.company_invite_by_token((select tok from r2517_tok where k = 'mfa_c'));
  if j->>'state' <> 'blocked' or j->>'reason' not ilike '%sent to another email address%' then
    raise exception 'FAIL 10: page answered % (expected blocked + reason)', j;
  end if;
  begin perform public.accept_company_invite_by_token((select tok from r2517_tok where k = 'mfa_c'));
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text; end;
  if v_state is distinct from '42501' or v_msg is distinct from j->>'reason' then
    raise exception 'FAIL 10: accept refused differently (% %) from the page reason %', v_state, v_msg, j->>'reason';
  end if;
  raise notice 'PASS 10: blocked invite shown as blocked with the accept''s own reason';
end $$;

-- ── 9: grants ───────────────────────────────────────────────────────────────────────────
reset role;
do $$
begin
  if has_function_privilege('anon', 'public.accept_company_invite_by_token(text)', 'execute')
     or has_function_privilege('anon', 'public.company_invite_by_token(text)', 'execute')
     or has_function_privilege('anon', 'public.invite_existing_login(text,public.user_role,text)', 'execute')
     or has_function_privilege('anon', 'public.my_company_invites()', 'execute') then
    raise exception 'FAIL 9: anon may run an invite function';
  end if;
  if has_function_privilege('authenticated', 'public.r2517_token_hash(text)', 'execute')
     or has_function_privilege('authenticated', 'public.r2517_invite_blocker(uuid,uuid)', 'execute')
     or has_function_privilege('anon', 'public.r2517_invite_blocker(uuid,uuid)', 'execute') then
    raise exception 'FAIL 9: an app role may run an internal R-2517 helper';
  end if;
  if not has_function_privilege('authenticated', 'public.accept_company_invite_by_token(text)', 'execute') then
    raise exception 'FAIL 9: authenticated cannot accept';
  end if;
  raise notice 'PASS 9: grants';
end $$;

rollback;
