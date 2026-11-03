-- R-2433 (G-NETWORK N1) — business connections: request → accept by verified GSTIN, per-side
-- scopes, revoke, suggestions, and partner metrics only with the reseller's consent.
-- Migration: 20261103193313_r2433_tenant_connections.sql. FAILS without it (the functions and
-- the table do not exist, and get_partner_metrics shows a child nobody connected).
--
--   1. no accepted connection → nothing readable (has_scope false, lists empty)
--   2. suggestions: a customer's / vendor's GSTIN = a VERIFIED business; never a personal
--      workspace, never an unverified GSTIN; owner only
--   3. request: owner only; refused to a personal / unverified / own GSTIN; a personal
--      workspace cannot ask; a deactivated owner is refused (28000)
--   4. wrong company: a third company (and the asker) cannot accept, revoke or change it
--   5. accept: scopes are per side and respected; the third company sees nothing
--   6. revoke stops everything new; a new request is possible afterwards
--   7. no direct table access, no grant on the internal check, nothing for anon
--   8. partner metrics: a child shows only while IT shares partner_metrics; never personal
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2433_tenant_connections.test.sql

begin;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('24330000-0000-4000-8000-0000000000a1', 'r2433-owner-a@example.test'),
  ('24330000-0000-4000-8000-0000000000a2', 'r2433-acct-a@example.test'),
  ('24330000-0000-4000-8000-0000000000a3', 'r2433-gone-a@example.test'),
  ('24330000-0000-4000-8000-0000000000b1', 'r2433-owner-b@example.test'),
  ('24330000-0000-4000-8000-0000000000c1', 'r2433-owner-c@example.test'),
  ('24330000-0000-4000-8000-0000000000e1', 'r2433-personal@example.test'),
  ('24330000-0000-4000-8000-0000000000d1', 'r2433-parent@example.test'),
  ('24330000-0000-4000-8000-0000000000f1', 'r2433-child@example.test');

insert into public.tenants (id, name, email, state_code, doc_code, gstin, gstin_verified_at, workspace_kind) values
  ('24330000-0000-4000-8000-00000000000a', 'R2433 A', 'r2433a@example.test', '07', 'R243A', '07ABCDE1234F1Z5', now(), 'business'),
  ('24330000-0000-4000-8000-00000000000b', 'R2433 B', 'r2433b@example.test', '29', 'R243B', '29ABCDE1234F1Z5', now(), 'business'),
  ('24330000-0000-4000-8000-00000000000c', 'R2433 C', 'r2433c@example.test', '27', 'R243C', '27ABCDE1234F1Z5', now(), 'business'),
  ('24330000-0000-4000-8000-00000000000e', 'R2433 Personal', 'r2433e@example.test', '07', 'R243E', '07AAACT1111A1ZB', now(), 'personal'),
  ('24330000-0000-4000-8000-000000000010', 'R2433 Unverified', 'r2433u@example.test', '07', 'R243U', '07AAKFM2335A1Z5', null, 'business'),
  ('24330000-0000-4000-8000-00000000000d', 'R2433 Parent', 'r2433d@example.test', '07', 'R243D', '07AAACA1234A1Z5', now(), 'business');
insert into public.tenants (id, name, email, state_code, doc_code, gstin, gstin_verified_at, workspace_kind, parent_tenant_id) values
  ('24330000-0000-4000-8000-00000000000f', 'R2433 Child', 'r2433f@example.test', '07', 'R243F', '07AAACT1643F1Z5', now(), 'business',
   '24330000-0000-4000-8000-00000000000d'),
  ('24330000-0000-4000-8000-000000000011', 'R2433 Personal child', 'r2433g@example.test', '07', 'R243G', null, null, 'personal',
   '24330000-0000-4000-8000-00000000000d');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('24330000-0000-4000-8000-0000000000a1', '24330000-0000-4000-8000-00000000000a', 'r2433-owner-a@example.test', 'R2433 Owner A', 'owner', true),
  ('24330000-0000-4000-8000-0000000000a2', '24330000-0000-4000-8000-00000000000a', 'r2433-acct-a@example.test',  'R2433 Acct A',  'accountant', true),
  ('24330000-0000-4000-8000-0000000000a3', '24330000-0000-4000-8000-00000000000a', 'r2433-gone-a@example.test',  'R2433 Gone A',  'owner', false),
  ('24330000-0000-4000-8000-0000000000b1', '24330000-0000-4000-8000-00000000000b', 'r2433-owner-b@example.test', 'R2433 Owner B', 'owner', true),
  ('24330000-0000-4000-8000-0000000000c1', '24330000-0000-4000-8000-00000000000c', 'r2433-owner-c@example.test', 'R2433 Owner C', 'owner', true),
  ('24330000-0000-4000-8000-0000000000e1', '24330000-0000-4000-8000-00000000000e', 'r2433-personal@example.test','R2433 Personal','owner', true),
  ('24330000-0000-4000-8000-0000000000d1', '24330000-0000-4000-8000-00000000000d', 'r2433-parent@example.test',  'R2433 Parent',  'owner', true),
  ('24330000-0000-4000-8000-0000000000f1', '24330000-0000-4000-8000-00000000000f', 'r2433-child@example.test',   'R2433 Child',   'owner', true);

-- A's customers / vendors: B (verified), the personal workspace's GSTIN, an unverified one; vendor C
insert into public.customers (tenant_id, name, gstin) values
  ('24330000-0000-4000-8000-00000000000a', 'R2433 cust B', '29abcde1234f1z5 '),
  ('24330000-0000-4000-8000-00000000000a', 'R2433 cust personal', '07AAACT1111A1ZB'),
  ('24330000-0000-4000-8000-00000000000a', 'R2433 cust unverified', '07AAKFM2335A1Z5');
insert into public.vendors (tenant_id, name, gstin) values
  ('24330000-0000-4000-8000-00000000000a', 'R2433 vendor C', '27ABCDE1234F1Z5');

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
/* run p_sql; it must fail with p_state (and, if given, a word of its own message) */
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
-- the internal check, as the table owner (tests need it; request roles have no grant)
create function pg_temp.shares(p_sharer text, p_viewer text, p_scope text) returns boolean language sql as $$
  select exists (select 1 from public.tenant_connections c where c.status = 'accepted'
    and ((c.a_tenant_id = p_sharer::uuid and c.b_tenant_id = p_viewer::uuid and p_scope = any (c.a_scopes))
      or (c.b_tenant_id = p_sharer::uuid and c.a_tenant_id = p_viewer::uuid and p_scope = any (c.b_scopes))))
  and public.network_has_scope(p_sharer::uuid, p_viewer::uuid, p_scope);
$$;


grant execute on function pg_temp.as_user(uuid) to authenticated;
grant execute on function pg_temp.must_fail(text, text, text, text) to authenticated;

set local role authenticated;

do $$
declare
  A constant text := '24330000-0000-4000-8000-00000000000a';
  B constant text := '24330000-0000-4000-8000-00000000000b';
  C constant text := '24330000-0000-4000-8000-00000000000c';
  v_id  uuid;
  v_id2 uuid;
  v_n   int;
  v_s   text;
  v_arr text[];
begin
  -- ── 1. nothing connected → nothing readable ──
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a1');
  select count(*) into v_n from public.network_my_connections();
  if v_n <> 0 then raise exception 'FAIL 1: A lists % connections before any', v_n; end if;

  -- ── 2. suggestions ──
  select count(*) into v_n from public.network_suggestions();
  if v_n <> 2 then raise exception 'FAIL 2: A got % suggestions (want 2: B as customer, C as vendor)', v_n; end if;
  if not exists (select 1 from public.network_suggestions() s where s.tenant_id = B::uuid and s.matched_as = 'customer') then
    raise exception 'FAIL 2: customer B (verified) not suggested';
  end if;
  if not exists (select 1 from public.network_suggestions() s where s.tenant_id = C::uuid and s.matched_as = 'vendor') then
    raise exception 'FAIL 2: vendor C (verified) not suggested';
  end if;
  if exists (select 1 from public.network_suggestions() s
              where s.tenant_id in ('24330000-0000-4000-8000-00000000000e', '24330000-0000-4000-8000-000000000010')) then
    raise exception 'FAIL 2: a personal workspace or an unverified GSTIN was suggested';
  end if;
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a2');   -- accountant
  select count(*) into v_n from public.network_suggestions();
  if v_n <> 0 then raise exception 'FAIL 2: a non-owner got % suggestions', v_n; end if;
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000e1');   -- personal owner
  select count(*) into v_n from public.network_suggestions();
  if v_n <> 0 then raise exception 'FAIL 2: a personal workspace got % suggestions', v_n; end if;

  -- ── 3. request ──
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a2');
  perform pg_temp.must_fail('3 accountant asks', $q$select public.network_request_connection('29ABCDE1234F1Z5')$q$, '42501', 'Only the workspace owner');
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a3');
  perform pg_temp.must_fail('3 deactivated owner', $q$select public.network_request_connection('29ABCDE1234F1Z5')$q$, '28000');
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000e1');
  perform pg_temp.must_fail('3 personal asks', $q$select public.network_request_connection('29ABCDE1234F1Z5')$q$, '42501', 'personal workspace');
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a1');
  perform pg_temp.must_fail('3 to personal', $q$select public.network_request_connection('07AAACT1111A1ZB')$q$, 'P0002');
  perform pg_temp.must_fail('3 to unverified', $q$select public.network_request_connection('07AAKFM2335A1Z5')$q$, 'P0002');
  perform pg_temp.must_fail('3 to self', $q$select public.network_request_connection('07ABCDE1234F1Z5')$q$, '22023', 'own GSTIN');
  perform pg_temp.must_fail('3 unknown scope', $q$select public.network_request_connection('29ABCDE1234F1Z5', array['everything'])$q$, '22023', 'Unknown sharing choice');

  v_id := public.network_request_connection(' 29abcde1234f1z5', array['invoices']);
  v_id2 := public.network_request_connection('29ABCDE1234F1Z5', array['invoices', 'statements'], true);
  if v_id2 <> v_id then raise exception 'FAIL 3: asking twice made a second request'; end if;
  if (select my_scopes from public.network_my_connections() where id = v_id) <> array['invoices', 'statements']
     or not (select related_party from public.network_my_connections() where id = v_id) then
    raise exception 'FAIL 3: asking again dropped the new choices';
  end if;
  perform public.network_request_connection('29ABCDE1234F1Z5', array['invoices'], false);
  select direction into v_s from public.network_my_connections() where id = v_id;
  if v_s <> 'sent' then raise exception 'FAIL 3: A sees direction %', v_s; end if;
  if exists (select 1 from public.network_suggestions() s where s.tenant_id = B::uuid) then
    raise exception 'FAIL 3: B still suggested while a request is open';
  end if;

  -- ── 4. wrong company ──
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000c1');
  perform pg_temp.must_fail('4 C accepts', format('select public.network_respond_connection(%L, true)', v_id), 'P0002');
  perform pg_temp.must_fail('4 C revokes', format('select public.network_revoke_connection(%L)', v_id), 'P0002');
  perform pg_temp.must_fail('4 C scopes', format('select public.network_set_my_scopes(%L, array[''invoices''])', v_id), 'P0002');
  select count(*) into v_n from public.network_my_connections();
  if v_n <> 0 then raise exception 'FAIL 4: C lists the A–B request'; end if;
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a1');
  perform pg_temp.must_fail('4 asker accepts own request', format('select public.network_respond_connection(%L, true)', v_id), 'P0002');
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000b1');
  perform pg_temp.must_fail('4 B asks back while open', $q$select public.network_request_connection('07ABCDE1234F1Z5')$q$, '23505', 'Requests received');
end $$;

-- requested is not accepted: nothing readable yet
reset role;
do $$ begin
  if pg_temp.shares('24330000-0000-4000-8000-00000000000a', '24330000-0000-4000-8000-00000000000b', 'invoices') then
    raise exception 'FAIL 1: a REQUESTED connection already shares invoices';
  end if;
end $$;
set local role authenticated;

do $$
declare
  v_id uuid;
  v_s  text;
  v_n  int;
begin
  -- ── 5. B accepts, sharing payments ──
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000b1');
  select id into v_id from public.network_my_connections() where direction = 'received' and status = 'requested'
     and other_tenant_id = '24330000-0000-4000-8000-00000000000a';
  if v_id is null then raise exception 'FAIL 5: B does not see the request'; end if;
  v_s := public.network_respond_connection(v_id, true, array['payments']);
  if v_s <> 'accepted' then raise exception 'FAIL 5: respond returned %', v_s; end if;
  perform pg_temp.must_fail('5 accept twice', format('select public.network_respond_connection(%L, true)', v_id), '22023', 'no longer open');
end $$;

reset role;
do $$ begin
  if not pg_temp.shares('24330000-0000-4000-8000-00000000000a', '24330000-0000-4000-8000-00000000000b', 'invoices') then
    raise exception 'FAIL 5: A shares invoices with B but the check says no'; end if;
  if not pg_temp.shares('24330000-0000-4000-8000-00000000000b', '24330000-0000-4000-8000-00000000000a', 'payments') then
    raise exception 'FAIL 5: B shares payments with A but the check says no'; end if;
  if pg_temp.shares('24330000-0000-4000-8000-00000000000b', '24330000-0000-4000-8000-00000000000a', 'invoices') then
    raise exception 'FAIL 5: B never shared invoices — scope not respected'; end if;
  if pg_temp.shares('24330000-0000-4000-8000-00000000000a', '24330000-0000-4000-8000-00000000000b', 'payments') then
    raise exception 'FAIL 5: A never shared payments — scope not respected'; end if;
  if pg_temp.shares('24330000-0000-4000-8000-00000000000a', '24330000-0000-4000-8000-00000000000c', 'invoices') then
    raise exception 'FAIL 5: C (not connected) can read A'; end if;
  -- B loses its verified GSTIN → nothing flows to or from it until it is verified again
  update public.tenants set gstin_verified_at = null where id = '24330000-0000-4000-8000-00000000000b';
  if pg_temp.shares('24330000-0000-4000-8000-00000000000a', '24330000-0000-4000-8000-00000000000b', 'invoices') then
    raise exception 'FAIL 5: B''s GSTIN is no longer verified but A still shares with it'; end if;
  update public.tenants set gstin_verified_at = now() where id = '24330000-0000-4000-8000-00000000000b';
  if not pg_temp.shares('24330000-0000-4000-8000-00000000000a', '24330000-0000-4000-8000-00000000000b', 'invoices') then
    raise exception 'FAIL 5: re-verified B does not get A''s invoices again'; end if;
end $$;
set local role authenticated;

do $$
declare
  v_id uuid;
  v_n  int;
begin
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a1');
  select id into v_id from public.network_my_connections() where status = 'accepted';
  if (select their_scopes from public.network_my_connections() where id = v_id) <> array['payments'] then
    raise exception 'FAIL 5: A does not see what B shares';
  end if;
  -- A narrows its own side to nothing
  perform public.network_set_my_scopes(v_id, '{}');

  -- ── 6. revoke ──
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000b1');
  perform public.network_revoke_connection(v_id);
  perform pg_temp.must_fail('6 scopes after revoke', format('select public.network_set_my_scopes(%L, array[''payments''])', v_id), '22023');
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a1');
  if (select revoked_by_me from public.network_my_connections() where id = v_id) then
    raise exception 'FAIL 6: A is told it revoked B''s revoke';
  end if;
end $$;

reset role;
do $$ begin
  if pg_temp.shares('24330000-0000-4000-8000-00000000000b', '24330000-0000-4000-8000-00000000000a', 'payments') then
    raise exception 'FAIL 6: revoked connection still shares payments'; end if;
end $$;
set local role authenticated;

do $$
declare v_id uuid;
begin
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a1');
  v_id := public.network_request_connection('29ABCDE1234F1Z5', array['statements'], true);
  if not (select related_party from public.network_my_connections() where id = v_id) then
    raise exception 'FAIL 6: group link lost its related_party flag';
  end if;

  -- ── 7. no direct access ──
  perform pg_temp.must_fail('7 select table', 'select count(*) from public.tenant_connections', '42501');
  perform pg_temp.must_fail('7 insert table', format(
    'insert into public.tenant_connections (a_tenant_id, b_tenant_id, status, origin) values (%L, %L, ''accepted'', ''parent_link'')',
    '24330000-0000-4000-8000-00000000000c', '24330000-0000-4000-8000-00000000000a'), '42501');
  perform pg_temp.must_fail('7 internal check', $q$select public.network_has_scope('24330000-0000-4000-8000-00000000000a', '24330000-0000-4000-8000-00000000000b', 'invoices')$q$, '42501');
end $$;

reset role;
do $$ begin
  if has_function_privilege('anon', 'public.network_request_connection(text, text[], boolean)', 'execute')
     or has_function_privilege('anon', 'public.network_my_connections()', 'execute')
     or has_function_privilege('anon', 'public.network_suggestions()', 'execute')
     or has_function_privilege('anon', 'public.network_respond_connection(uuid, boolean, text[])', 'execute')
     or has_function_privilege('anon', 'public.network_revoke_connection(uuid)', 'execute')
     or has_function_privilege('anon', 'public.network_set_my_scopes(uuid, text[])', 'execute')
     or has_table_privilege('anon', 'public.tenant_connections', 'select') then
    raise exception 'FAIL 7: anon can reach the network functions or table';
  end if;
end $$;

-- ── 8. partner metrics need the child's consent ──
set local role authenticated;
do $$
declare v_n int; v_id uuid;
begin
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000d1');
  select count(*) into v_n from public.get_partner_metrics();
  if v_n <> 0 then raise exception 'FAIL 8: parent sees % children with no connection (operator link only)', v_n; end if;

  -- parent asks; child accepts sharing partner metrics
  perform public.network_request_connection('07AAACT1643F1Z5', array['catalogue']);
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000f1');
  select id into v_id from public.network_my_connections() where direction = 'received';
  perform public.network_respond_connection(v_id, true, array['partner_metrics']);

  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000d1');
  select count(*) into v_n from public.get_partner_metrics() where tenant_id = '24330000-0000-4000-8000-00000000000f';
  if v_n <> 1 then raise exception 'FAIL 8: parent does not see the consenting child'; end if;
  if exists (select 1 from public.get_partner_metrics() where tenant_id = '24330000-0000-4000-8000-000000000011') then
    raise exception 'FAIL 8: a personal child shows in partner metrics';
  end if;

  -- the child switches it off → gone
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000f1');
  perform public.network_set_my_scopes(v_id, '{}');
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000d1');
  select count(*) into v_n from public.get_partner_metrics();
  if v_n <> 0 then raise exception 'FAIL 8: child switched partner metrics off but the parent still sees it'; end if;

  -- no parent link needed: C asks B, B shares partner metrics → C sees B
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000c1');
  perform public.network_request_connection('29ABCDE1234F1Z5');
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000b1');
  select id into v_id from public.network_my_connections() where direction = 'received' and status = 'requested'
     and other_tenant_id = '24330000-0000-4000-8000-00000000000c';
  perform public.network_respond_connection(v_id, true, array['partner_metrics']);
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000c1');
  if not exists (select 1 from public.get_partner_metrics() where tenant_id = '24330000-0000-4000-8000-00000000000b') then
    raise exception 'FAIL 8: B shares partner metrics with C on a connection but C does not see it';
  end if;
  perform pg_temp.as_user('24330000-0000-4000-8000-0000000000a1');
  if exists (select 1 from public.get_partner_metrics() where tenant_id = '24330000-0000-4000-8000-00000000000b') then
    raise exception 'FAIL 8: A sees B''s partner metrics without B sharing them with A';
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);
select 'R-2433 tenant connections: all checks passed' as result;

rollback;
