-- R-2445 (G-NETWORK) — a company must PROVE it owns its GSTIN before it can connect.
-- Migration: 2026110*_r2445_gstin_owner_verified.sql. FAILS without it (no owner columns, no
-- claim / decide functions, and R-2433 connected anyone whose GSTIN was merely REGISTERED).
--
--   1. registered-only (gstin_verified_at) is not enough: never suggested, cannot request,
--      cannot accept, cannot be asked; the caller itself must be owner-verified too
--   2. the owner cannot set the owner columns from the app (REST update / insert refused)
--   3. claim → platform decision: owner only; personal / unverified GSTIN refused; a pending
--      claim is updated, not duplicated; request roles cannot decide or list claims
--   4. two companies on one GSTIN can't block each other: a squatter's pending claim does not
--      stop the real owner's approval; after approval the squatter's claim is rejected, its new
--      claim is refused with the next step, and requests to that GSTIN reach the real owner
--   5. changing the GSTIN drops the ownership proof at once (and frees the GSTIN)
--   6. revoke by the platform stops the connection flowing
--   7. backfilled parent links keep working (origin parent_link), owner-verified or not
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2445_gstin_owner_verified.test.sql

begin;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
-- A = real owner of 07AAACR2445A1Z5 (proved), B = real owner of 29AAACR2445B1Z5 (NOT proved yet),
-- S = squatter who saved + "verified" B's public GSTIN, C = third company (proved),
-- P = personal workspace, D/F = operator-set parent/child (parent link).
insert into auth.users (id, email) values
  ('24450000-0000-4000-8000-0000000000a1', 'r2445-owner-a@example.test'),
  ('24450000-0000-4000-8000-0000000000a2', 'r2445-acct-a@example.test'),
  ('24450000-0000-4000-8000-0000000000b1', 'r2445-owner-b@example.test'),
  ('24450000-0000-4000-8000-0000000000c1', 'r2445-owner-c@example.test'),
  ('24450000-0000-4000-8000-0000000000e1', 'r2445-personal@example.test'),
  ('24450000-0000-4000-8000-0000000000f1', 'r2445-squat@example.test'),
  ('24450000-0000-4000-8000-0000000000d1', 'r2445-parent@example.test'),
  ('24450000-0000-4000-8000-0000000000d2', 'r2445-child@example.test');

insert into public.tenants (id, name, email, state_code, doc_code, gstin, gstin_verified_at, gstin_verification, workspace_kind) values
  ('24450000-0000-4000-8000-00000000000a', 'R2445 A', 'r2445a@example.test', '07', 'R245A', '07AAACR2445A1Z5', now(),
   '{"legal_name": "R2445 A PRIVATE LIMITED", "status": "Active"}'::jsonb, 'business'),
  ('24450000-0000-4000-8000-00000000000b', 'R2445 B', 'r2445b@example.test', '29', 'R245B', '29AAACR2445B1Z5', now(),
   '{"legal_name": "R2445 B PRIVATE LIMITED", "status": "Active"}'::jsonb, 'business'),
  ('24450000-0000-4000-8000-00000000000c', 'R2445 C', 'r2445c@example.test', '27', 'R245C', '27AAACR2445C1Z5', now(), null, 'business'),
  ('24450000-0000-4000-8000-00000000000e', 'R2445 Personal', 'r2445e@example.test', '07', 'R245E', '07AAACR2445E1Z5', now(), null, 'personal'),
  ('24450000-0000-4000-8000-0000000000ff', 'R2445 Squatter', 'r2445s@example.test', '29', 'R245S', '29aaacr2445b1z5', now(), null, 'business'),
  ('24450000-0000-4000-8000-00000000000d', 'R2445 Parent', 'r2445d@example.test', '07', 'R245D', '07AAACR2445D1Z5', now(), null, 'business');
insert into public.tenants (id, name, email, state_code, doc_code, gstin, gstin_verified_at, workspace_kind, parent_tenant_id) values
  ('24450000-0000-4000-8000-0000000000df', 'R2445 Child', 'r2445f@example.test', '07', 'R245F', '07AAACR2445F1Z5', now(), 'business',
   '24450000-0000-4000-8000-00000000000d');

-- A and C proved ownership earlier (the platform admin approved them)
update public.tenants
   set gstin_owner_verified_at = now(), gstin_owner_verified_gstin = upper(btrim(gstin)),
       gstin_owner_verified_how = 'platform_admin', gstin_owner_verified_by = 'admin@example.test'
 where id in ('24450000-0000-4000-8000-00000000000a', '24450000-0000-4000-8000-00000000000c');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('24450000-0000-4000-8000-0000000000a1', '24450000-0000-4000-8000-00000000000a', 'r2445-owner-a@example.test', 'R2445 Owner A', 'owner', true),
  ('24450000-0000-4000-8000-0000000000a2', '24450000-0000-4000-8000-00000000000a', 'r2445-acct-a@example.test',  'R2445 Acct A',  'accountant', true),
  ('24450000-0000-4000-8000-0000000000b1', '24450000-0000-4000-8000-00000000000b', 'r2445-owner-b@example.test', 'R2445 Owner B', 'owner', true),
  ('24450000-0000-4000-8000-0000000000c1', '24450000-0000-4000-8000-00000000000c', 'r2445-owner-c@example.test', 'R2445 Owner C', 'owner', true),
  ('24450000-0000-4000-8000-0000000000e1', '24450000-0000-4000-8000-00000000000e', 'r2445-personal@example.test','R2445 Personal','owner', true),
  ('24450000-0000-4000-8000-0000000000f1', '24450000-0000-4000-8000-0000000000ff', 'r2445-squat@example.test',   'R2445 Squat',   'owner', true),
  ('24450000-0000-4000-8000-0000000000d1', '24450000-0000-4000-8000-00000000000d', 'r2445-parent@example.test',  'R2445 Parent',  'owner', true),
  ('24450000-0000-4000-8000-0000000000d2', '24450000-0000-4000-8000-0000000000df', 'r2445-child@example.test',   'R2445 Child',   'owner', true);

-- A's customer = B's GSTIN (held by B AND the squatter); C's customer = A
insert into public.customers (tenant_id, name, gstin) values
  ('24450000-0000-4000-8000-00000000000a', 'R2445 cust B', '29AAACR2445B1Z5'),
  ('24450000-0000-4000-8000-00000000000c', 'R2445 cust A', '07AAACR2445A1Z5');

-- the operator-set parent link, as R-2433's backfill made it
insert into public.tenant_connections (a_tenant_id, b_tenant_id, a_gstin, b_gstin, status, a_scopes, b_scopes, origin)
  values ('24450000-0000-4000-8000-00000000000d', '24450000-0000-4000-8000-0000000000df', '07AAACR2445D1Z5', '07AAACR2445F1Z5',
          'accepted', array['catalogue'], array['partner_metrics'], 'parent_link');

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.must_fail(p_label text, p_sql text, p_state text, p_word text default null) returns void
language plpgsql as $$
declare v_st text; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text;
    if v_st <> p_state or (p_word is not null and position(p_word in v_msg) = 0) then
      raise exception 'FAIL %: wrong refusal % %', p_label, v_st, v_msg;
    end if;
    return;
  end;
  raise exception 'FAIL %: passed but must be refused', p_label;
end $$;
create function pg_temp.owned(p text) returns boolean language sql as $$
  select public.network_gstin_owned(p::uuid);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;
grant execute on function pg_temp.must_fail(text, text, text, text) to authenticated, service_role;

-- ── 1. registered is not owned ────────────────────────────────────────────────────────
set local role authenticated;
do $$
declare v_n int; v_id uuid;
begin
  -- A (proved) sees no suggestion for B's GSTIN: B and the squatter only REGISTERED it
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000a1');
  select count(*) into v_n from public.network_suggestions();
  if v_n <> 0 then raise exception 'FAIL 1: A got % suggestions for an unproved GSTIN', v_n; end if;
  perform pg_temp.must_fail('1 A asks an unproved GSTIN', $q$select public.network_request_connection('29AAACR2445B1Z5')$q$, 'P0002', 'Prove you own');

  -- B (registered only) cannot ask C, and sees no suggestions
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000b1');
  perform pg_temp.must_fail('1 unproved B asks', $q$select public.network_request_connection('27AAACR2445C1Z5')$q$, '22023', 'Prove you own');
  -- C (proved) is suggested to nobody who has not proved: C's customer is A → A suggested to C
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000c1');
  if not exists (select 1 from public.network_suggestions() s where s.tenant_id = '24450000-0000-4000-8000-00000000000a') then
    raise exception 'FAIL 1: proved A not suggested to proved C';
  end if;

  -- what the owner sees about itself
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000b1');
  if (select owner_verified from public.network_my_gstin_ownership()) then
    raise exception 'FAIL 1: B is shown as owner-verified';
  end if;
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000a2');   -- accountant reads A's status
  if not (select owner_verified from public.network_my_gstin_ownership()) then
    raise exception 'FAIL 1: A''s accountant does not see A as owner-verified';
  end if;
end $$;

-- A proved; C asks A; then A's proof is cleared in the DB → A cannot accept, nothing flows
do $$
declare v_id uuid;
begin
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000c1');
  v_id := public.network_request_connection('07AAACR2445A1Z5', array['invoices']);
  perform set_config('r2445.req', v_id::text, true);
end $$;
reset role;
update public.tenants set gstin_owner_verified_at = null where id = '24450000-0000-4000-8000-00000000000a';
set local role authenticated;
do $$
begin
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000a1');
  perform pg_temp.must_fail('1 unproved A accepts', format('select public.network_respond_connection(%L, true)', current_setting('r2445.req')),
    '22023', 'Prove you own');
  if (select other_owner_verified from public.network_my_connections() where id = current_setting('r2445.req')::uuid) is not true then
    raise exception 'FAIL 1: A''s list does not show that C has proved its GSTIN';
  end if;
end $$;
reset role;
update public.tenants set gstin_owner_verified_at = now() where id = '24450000-0000-4000-8000-00000000000a';
set local role authenticated;
do $$
begin
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000a1');
  perform public.network_respond_connection(current_setting('r2445.req')::uuid, true, array['payments']);
end $$;
reset role;
do $$ begin
  if not public.network_has_scope('24450000-0000-4000-8000-00000000000c', '24450000-0000-4000-8000-00000000000a', 'invoices') then
    raise exception 'FAIL 1: proved C → proved A invoices not flowing';
  end if;
  update public.tenants set gstin_owner_verified_at = null where id = '24450000-0000-4000-8000-00000000000a';
  if public.network_has_scope('24450000-0000-4000-8000-00000000000c', '24450000-0000-4000-8000-00000000000a', 'invoices') then
    raise exception 'FAIL 1: A lost its ownership proof but still receives C''s invoices';
  end if;
  update public.tenants set gstin_owner_verified_at = now() where id = '24450000-0000-4000-8000-00000000000a';
end $$;

-- ── 2. the app cannot write the owner columns ─────────────────────────────────────────
set local role authenticated;
do $$
begin
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000b1');
  perform pg_temp.must_fail('2 owner sets owner_verified_at',
    $q$update public.tenants set gstin_owner_verified_at = now(), gstin_owner_verified_gstin = '29AAACR2445B1Z5' where id = '24450000-0000-4000-8000-00000000000b'$q$,
    '42501', 'ownership');
  perform pg_temp.must_fail('2 owner reads claims table', 'select count(*) from public.gstin_ownership_claims', '42501');
  perform pg_temp.must_fail('2 owner decides', $q$select public.platform_decide_gstin_claim(gen_random_uuid(), true, 'x@example.test', null)$q$, '42501');
  perform pg_temp.must_fail('2 owner lists claims', $q$select * from public.platform_gstin_claims('pending')$q$, '42501');
  perform pg_temp.must_fail('2 internal check', $q$select public.network_gstin_owned('24450000-0000-4000-8000-00000000000b')$q$, '42501');
end $$;

-- ── 3 + 4. claims; two companies on one GSTIN ─────────────────────────────────────────
do $$
declare v_s uuid; v_b uuid; v_b2 uuid;
begin
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000a2');
  perform pg_temp.must_fail('3 accountant claims', $q$select public.network_claim_gstin_ownership('x')$q$, '42501', 'Only the workspace owner');
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000e1');
  perform pg_temp.must_fail('3 personal claims', $q$select public.network_claim_gstin_ownership('x')$q$, '42501', 'personal workspace');
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000a1');
  perform pg_temp.must_fail('3 already proved', $q$select public.network_claim_gstin_ownership('x')$q$, '22023', 'already proved');

  -- the squatter asks FIRST
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000f1');
  v_s := public.network_claim_gstin_ownership('please approve');
  -- then the real owner B; asking twice keeps one pending claim with the new note
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000b1');
  v_b := public.network_claim_gstin_ownership('call our GST-registered mobile');
  v_b2 := public.network_claim_gstin_ownership('call 98xxxxxx on the GST certificate');
  if v_b2 <> v_b then raise exception 'FAIL 3: a second pending claim was made'; end if;
  if (select claim_status from public.network_my_gstin_ownership()) <> 'pending' then
    raise exception 'FAIL 3: B does not see its pending claim';
  end if;
  perform set_config('r2445.s', v_s::text, true);
  perform set_config('r2445.b', v_b::text, true);
end $$;

reset role;   -- the platform route runs as service_role
set local role service_role;
do $$
declare v_n int; v_r text;
begin
  select count(*) into v_n from public.platform_gstin_claims('pending') c where c.gstin = '29AAACR2445B1Z5';
  if v_n <> 2 then raise exception 'FAIL 4: the admin sees % pending claims on B''s GSTIN (want 2)', v_n; end if;
  if (select same_gstin_tenants from public.platform_gstin_claims('pending') c where c.claim_id = current_setting('r2445.b')::uuid) <> 2 then
    raise exception 'FAIL 4: the admin is not told two companies hold this GSTIN';
  end if;
  if (select gstn_legal_name from public.platform_gstin_claims('pending') c where c.claim_id = current_setting('r2445.b')::uuid)
       is distinct from 'R2445 B PRIVATE LIMITED' then
    raise exception 'FAIL 4: the admin does not see the GSTN legal name';
  end if;
  perform pg_temp.must_fail('4 approve without admin email',
    format('select public.platform_decide_gstin_claim(%L, true, %L, null)', current_setting('r2445.b'), ''), '22023');
  -- not first-come: the admin approves B although the squatter asked first
  v_r := public.platform_decide_gstin_claim(current_setting('r2445.b')::uuid, true, 'admin@example.test', 'GST certificate matched');
  if v_r <> 'approved' then raise exception 'FAIL 4: approve returned %', v_r; end if;
  if (select status from public.gstin_ownership_claims where id = current_setting('r2445.s')::uuid) <> 'rejected' then
    raise exception 'FAIL 4: the squatter''s pending claim stayed open after B was approved';
  end if;
  perform pg_temp.must_fail('4 approve the squatter now',
    format('select public.platform_decide_gstin_claim(%L, true, %L, null)', current_setting('r2445.s'), 'admin@example.test'), '22023');
end $$;
reset role;
do $$ begin
  if not pg_temp.owned('24450000-0000-4000-8000-00000000000b') then raise exception 'FAIL 4: B not owner-verified after approval'; end if;
  if pg_temp.owned('24450000-0000-4000-8000-0000000000ff') then raise exception 'FAIL 4: the squatter is owner-verified'; end if;
  if (select gstin_owner_verified_by from public.tenants where id = '24450000-0000-4000-8000-00000000000b') <> 'admin@example.test'
     or (select gstin_owner_verified_how from public.tenants where id = '24450000-0000-4000-8000-00000000000b') <> 'platform_admin' then
    raise exception 'FAIL 4: who / how of the approval not recorded';
  end if;
end $$;

set local role authenticated;
do $$
declare v_n int; v_id uuid;
begin
  -- the squatter: a new claim is refused with the next step; it sees why; cannot connect
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000f1');
  perform pg_temp.must_fail('4 squatter claims again', $q$select public.network_claim_gstin_ownership('mine')$q$, '23505', 'support');
  if not (select held_by_other from public.network_my_gstin_ownership()) then
    raise exception 'FAIL 4: the squatter is not told another business proved this GSTIN';
  end if;
  perform pg_temp.must_fail('4 squatter asks A', $q$select public.network_request_connection('07AAACR2445A1Z5')$q$, '22023', 'Prove you own');

  -- A: B is now suggested, and a request reaches B (never "more than one business")
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000a1');
  select count(*) into v_n from public.network_suggestions() s where s.tenant_id = '24450000-0000-4000-8000-00000000000b';
  if v_n <> 1 then raise exception 'FAIL 4: proved B not suggested to A'; end if;
  if exists (select 1 from public.network_suggestions() s where s.tenant_id = '24450000-0000-4000-8000-0000000000ff') then
    raise exception 'FAIL 4: the squatter is suggested';
  end if;
  v_id := public.network_request_connection('29AAACR2445B1Z5', array['invoices']);
  if (select other_tenant_id from public.network_my_connections() where id = v_id) <> '24450000-0000-4000-8000-00000000000b' then
    raise exception 'FAIL 4: the request did not go to the proved owner';
  end if;
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000b1');
  perform public.network_respond_connection(v_id, true, array['payments']);
  perform set_config('r2445.ab', v_id::text, true);
end $$;

-- ── 5. a GSTIN change drops the proof and frees the GSTIN ─────────────────────────────
do $$
begin
  perform pg_temp.as_user('24450000-0000-4000-8000-0000000000b1');
  update public.tenants set gstin = '29AAACR2445X1Z5' where id = '24450000-0000-4000-8000-00000000000b';
end $$;
reset role;
do $$ begin
  if (select gstin_owner_verified_at from public.tenants where id = '24450000-0000-4000-8000-00000000000b') is not null then
    raise exception 'FAIL 5: GSTIN changed but the ownership proof stayed';
  end if;
  if public.network_has_scope('24450000-0000-4000-8000-00000000000a', '24450000-0000-4000-8000-00000000000b', 'invoices') then
    raise exception 'FAIL 5: B changed its GSTIN but still receives A''s invoices';
  end if;
  -- back to the old GSTIN (re-verified, re-proved by the admin) for the next steps
  update public.tenants set gstin = '29AAACR2445B1Z5', gstin_verified_at = now(),
         gstin_owner_verified_at = now(), gstin_owner_verified_gstin = '29AAACR2445B1Z5',
         gstin_owner_verified_how = 'platform_admin', gstin_owner_verified_by = 'admin@example.test'
   where id = '24450000-0000-4000-8000-00000000000b';
  if not public.network_has_scope('24450000-0000-4000-8000-00000000000a', '24450000-0000-4000-8000-00000000000b', 'invoices') then
    raise exception 'FAIL 5: re-proved B does not get A''s invoices again';
  end if;
end $$;

-- ── 6. platform revoke stops the flow ─────────────────────────────────────────────────
set local role service_role;
do $$ begin
  perform pg_temp.must_fail('6 revoke without a reason',
    $q$select public.platform_revoke_gstin_owner('24450000-0000-4000-8000-00000000000b', 'admin@example.test', '')$q$, '22023');
  perform public.platform_revoke_gstin_owner('24450000-0000-4000-8000-00000000000b', 'admin@example.test', 'Approved the wrong company');
end $$;
reset role;
do $$ begin
  if public.network_has_scope('24450000-0000-4000-8000-00000000000a', '24450000-0000-4000-8000-00000000000b', 'invoices') then
    raise exception 'FAIL 6: revoked owner still receives invoices';
  end if;
  if not exists (select 1 from public.gstin_ownership_claims where tenant_id = '24450000-0000-4000-8000-00000000000b'
                  and status = 'revoked' and decided_by = 'admin@example.test') then
    raise exception 'FAIL 6: revoke not recorded';
  end if;
end $$;

-- ── 7. operator-set parent links keep working ─────────────────────────────────────────
do $$ begin
  if not public.network_has_scope('24450000-0000-4000-8000-0000000000df', '24450000-0000-4000-8000-00000000000d', 'partner_metrics') then
    raise exception 'FAIL 7: the backfilled parent link stopped working';
  end if;
  if has_function_privilege('anon', 'public.network_claim_gstin_ownership(text)', 'execute')
     or has_function_privilege('anon', 'public.network_my_gstin_ownership()', 'execute')
     or has_function_privilege('authenticated', 'public.platform_decide_gstin_claim(uuid, boolean, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.platform_revoke_gstin_owner(uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.platform_gstin_claims(text)', 'execute')
     or has_table_privilege('authenticated', 'public.gstin_ownership_claims', 'select') then
    raise exception 'FAIL 7: request roles can reach the platform functions or the claims table';
  end if;
end $$;

select set_config('request.jwt.claims', '', true);
select 'R-2445 GSTIN ownership: all checks passed' as result;

rollback;
