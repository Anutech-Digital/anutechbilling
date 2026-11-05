-- Regression test: merge_stranded_user_into_tenant() (migration 0243).
-- Every block is rolled back — safe to run against any database, including prod.
--
-- Proves, on real fixtures rather than mocks:
--   1. MOVE + DELETE  — a colleague in an accidental EMPTY workspace is moved, and
--                       that workspace is deleted.
--   2. ATTACH         — an auth account with no public.users row anywhere gets one.
--   3. KEEP (data)    — a workspace holding business data is not touched AT ALL:
--                       the user is NOT moved and the workspace is NOT deleted.
--                       R-2477 (memberships): the claim now ADDS a membership in the
--                       claiming company instead of refusing; they keep their workspace.
--   4. KEEP (people)  — a workspace with other members is a real company: same — a
--                       membership is added, nobody is moved, nothing named.
--   5. REFUSE (role)  — a non-owner cannot claim anyone.
--   6. NO CROSS-TENANT— an owner cannot claim into a tenant that is not theirs.
--
-- R-721 (11 Oct 2026): a signed-in owner may claim only someone with a pending join request
-- (or an invite they signed in after) to THEIR workspace, so cases 1–4 each open one first —
-- the legitimate shape. Refusals no longer name the other company or its tables
-- (supabase/tests/r721_stranded_users.test.sql covers the attack side).
--
-- Case 3 is the one that matters most. Prevention was never the hard part; the
-- repair tool quietly orphaning ₹21,240 of customer data would have recreated the
-- exact bug this whole migration set exists to answer.
--
-- Fixture note: auth.users needs only `id` (everything else has a default or is
-- nullable — checked, not assumed). UUIDs here are hex-only on purpose; a literal
-- like '...m001' is not a uuid and fails at the insert.
--
-- Run by hand — these are NOT in CI and NOT in the Stop hook (CLAUDE.md §25.2).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) MOVE + DELETE: empty accidental workspace is cleared away
-- ─────────────────────────────────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.tenants (id,name,email,state_code,doc_code) values
  ('2222aaaa-0000-0000-0000-000000000001','Main Co','main@m1.in','07','MG01'),
  ('2222aaaa-0000-0000-0000-000000000002','Accidental Co','acc@m1.in','07','MG02');
insert into auth.users (id,email) values
  ('3333bbbb-0000-0000-0000-000000000001','owner@m1.in'),
  ('3333bbbb-0000-0000-0000-000000000002','stray@m1.in');
insert into public.users (id,tenant_id,email,full_name,role) values
  ('3333bbbb-0000-0000-0000-000000000001','2222aaaa-0000-0000-0000-000000000001','owner@m1.in','Owner','owner'),
  ('3333bbbb-0000-0000-0000-000000000002','2222aaaa-0000-0000-0000-000000000002','stray@m1.in','Stray','owner');
insert into public.join_requests (tenant_id,auth_user_id,email,matched_by) values
  ('2222aaaa-0000-0000-0000-000000000001','3333bbbb-0000-0000-0000-000000000002','stray@m1.in','manual');

do $$ declare r jsonb; n int; t int; begin
  perform set_config('request.jwt.claims',
    '{"sub":"3333bbbb-0000-0000-0000-000000000001","role":"authenticated"}', true);

  r := public.merge_stranded_user_into_tenant(
         'stray@m1.in','2222aaaa-0000-0000-0000-000000000001','support');

  if r->>'action' <> 'moved' then
    raise exception 'FAIL 1: expected action=moved, got %', r->>'action'; end if;
  if (r->>'old_tenant_deleted')::boolean is not true then
    raise exception 'FAIL 1: expected the empty workspace to be deleted'; end if;

  select count(*) into n from public.users
   where id='3333bbbb-0000-0000-0000-000000000002'
     and tenant_id='2222aaaa-0000-0000-0000-000000000001' and role='support';
  if n<>1 then raise exception 'FAIL 1: user not moved with the requested role'; end if;

  select count(*) into t from public.tenants where id='2222aaaa-0000-0000-0000-000000000002';
  if t<>0 then raise exception 'FAIL 1: accidental tenant survived'; end if;

  raise notice 'PASS 1: moved + empty workspace deleted';
end $$;
rollback;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) ATTACH: an auth account with no profile anywhere (the stranded thirteen)
-- ─────────────────────────────────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.tenants (id,name,email,state_code,doc_code) values
  ('2222aaaa-0000-0000-0000-000000000003','Main Co','main@m3.in','07','MG03');
insert into auth.users (id,email,raw_user_meta_data) values
  ('3333bbbb-0000-0000-0000-000000000003','owner@m3.in','{}'::jsonb),
  ('3333bbbb-0000-0000-0000-000000000004','deepak@m3.in','{"full_name":"Deepak Sharma"}'::jsonb);
insert into public.users (id,tenant_id,email,full_name,role) values
  ('3333bbbb-0000-0000-0000-000000000003','2222aaaa-0000-0000-0000-000000000003','owner@m3.in','Owner','owner');
insert into public.join_requests (tenant_id,auth_user_id,email,matched_by) values
  ('2222aaaa-0000-0000-0000-000000000003','3333bbbb-0000-0000-0000-000000000004','deepak@m3.in','manual');

do $$ declare r jsonb; nm text; begin
  perform set_config('request.jwt.claims',
    '{"sub":"3333bbbb-0000-0000-0000-000000000003","role":"authenticated"}', true);

  r := public.merge_stranded_user_into_tenant(
         'deepak@m3.in','2222aaaa-0000-0000-0000-000000000003','owner');

  if r->>'action' <> 'attached' then
    raise exception 'FAIL 2: expected action=attached, got %', r->>'action'; end if;
  if (r->>'old_tenant_deleted')::boolean is not false then
    raise exception 'FAIL 2: nothing existed to delete, but deletion was reported'; end if;

  select full_name into nm from public.users where id='3333bbbb-0000-0000-0000-000000000004';
  if nm is distinct from 'Deepak Sharma' then
    raise exception 'FAIL 2: name not carried from auth metadata, got %', nm; end if;

  raise notice 'PASS 2: stranded auth account attached';
end $$;
rollback;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) KEEP (data): THE IMPORTANT ONE — their workspace is not touched, not even the user
--    (R-2477: the claim adds a membership here instead of refusing)
-- ─────────────────────────────────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.tenants (id,name,email,state_code,doc_code) values
  ('2222aaaa-0000-0000-0000-000000000005','Main Co','main@m4.in','07','MG05'),
  ('2222aaaa-0000-0000-0000-000000000006','Has Data Co','data@m4.in','07','MG06');
insert into auth.users (id,email) values
  ('3333bbbb-0000-0000-0000-000000000005','owner@m4.in'),
  ('3333bbbb-0000-0000-0000-000000000006','ranjeet@m4.in');
insert into public.users (id,tenant_id,email,full_name,role) values
  ('3333bbbb-0000-0000-0000-000000000005','2222aaaa-0000-0000-0000-000000000005','owner@m4.in','Owner','owner'),
  ('3333bbbb-0000-0000-0000-000000000006','2222aaaa-0000-0000-0000-000000000006','ranjeet@m4.in','Ranjeet','owner');
insert into public.join_requests (tenant_id,auth_user_id,email,matched_by) values
  ('2222aaaa-0000-0000-0000-000000000005','3333bbbb-0000-0000-0000-000000000006','ranjeet@m4.in','manual');
-- One real customer is enough. This is the ₹21,240 shape.
insert into public.customers (id,tenant_id,name,contact_email) values
  ('4444cccc-0000-0000-0000-000000000006','2222aaaa-0000-0000-0000-000000000006','A IOTA TECHNOLOGIES','vinay@x.in');

do $$ declare r jsonb; tid uuid; t int; begin
  perform set_config('request.jwt.claims',
    '{"sub":"3333bbbb-0000-0000-0000-000000000005","role":"authenticated"}', true);

  r := public.merge_stranded_user_into_tenant(
    'ranjeet@m4.in','2222aaaa-0000-0000-0000-000000000005','support');
  if r->>'action' <> 'added' then
    raise exception 'FAIL 3: expected a membership to be added (R-2477), got %', r; end if;
  -- R-721: never names the other workspace.
  if r::text like '%Has Data Co%' or r->>'old_tenant_name' is not null or (r->>'old_tenant_deleted')::boolean then
    raise exception 'FAIL 3: result names / deletes the other workspace: %', r; end if;

  -- The whole point: their workspace and its data are untouched.
  select tenant_id into tid from public.users where id='3333bbbb-0000-0000-0000-000000000006';
  if tid <> '2222aaaa-0000-0000-0000-000000000006' then
    raise exception 'FAIL 3: user was moved — data is now orphaned'; end if;
  select count(*) into t from public.tenants where id='2222aaaa-0000-0000-0000-000000000006';
  if t<>1 then raise exception 'FAIL 3: workspace holding data was deleted'; end if;
  select count(*) into t from public.customers where id='4444cccc-0000-0000-0000-000000000006';
  if t<>1 then raise exception 'FAIL 3: the workspace''s customer is gone'; end if;
  select count(*) into t from public.tenant_memberships
   where user_id='3333bbbb-0000-0000-0000-000000000006' and tenant_id='2222aaaa-0000-0000-0000-000000000006'
     and ended_at is null and is_active;
  if t<>1 then raise exception 'FAIL 3: their own membership was ended'; end if;
  select count(*) into t from public.tenant_memberships
   where user_id='3333bbbb-0000-0000-0000-000000000006' and tenant_id='2222aaaa-0000-0000-0000-000000000005'
     and role='support' and ended_at is null and is_active;
  if t<>1 then raise exception 'FAIL 3: no active support membership in Main Co'; end if;

  raise notice 'PASS 3: membership added, their workspace and its data untouched';
end $$;
rollback;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4) KEEP (people): a workspace with other members is somebody's real company
--    (R-2477: a membership is added; nobody is moved out of it)
-- ─────────────────────────────────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.tenants (id,name,email,state_code,doc_code) values
  ('2222aaaa-0000-0000-0000-000000000007','Main Co','main@m6.in','07','MG07'),
  ('2222aaaa-0000-0000-0000-000000000008','Real Other Co','other@m6.in','07','MG08');
insert into auth.users (id,email) values
  ('3333bbbb-0000-0000-0000-000000000007','owner@m6.in'),
  ('3333bbbb-0000-0000-0000-000000000008','a@m6.in'),
  ('3333bbbb-0000-0000-0000-000000000009','b@m6.in');
insert into public.users (id,tenant_id,email,full_name,role) values
  ('3333bbbb-0000-0000-0000-000000000007','2222aaaa-0000-0000-0000-000000000007','owner@m6.in','Owner','owner'),
  ('3333bbbb-0000-0000-0000-000000000008','2222aaaa-0000-0000-0000-000000000008','a@m6.in','A','owner'),
  ('3333bbbb-0000-0000-0000-000000000009','2222aaaa-0000-0000-0000-000000000008','b@m6.in','B','support');
insert into public.join_requests (tenant_id,auth_user_id,email,matched_by) values
  ('2222aaaa-0000-0000-0000-000000000007','3333bbbb-0000-0000-0000-000000000008','a@m6.in','manual');

do $$ declare r jsonb; t int; begin
  perform set_config('request.jwt.claims',
    '{"sub":"3333bbbb-0000-0000-0000-000000000007","role":"authenticated"}', true);
  r := public.merge_stranded_user_into_tenant(
    'a@m6.in','2222aaaa-0000-0000-0000-000000000007','support');
  if r->>'action' <> 'added' then
    raise exception 'FAIL 4: expected a membership to be added (R-2477), got %', r; end if;
  if r::text like '%Real Other Co%' then
    raise exception 'FAIL 4: result leaks the other company''s name: %', r; end if;
  select count(*) into t from public.users
   where id='3333bbbb-0000-0000-0000-000000000008' and tenant_id='2222aaaa-0000-0000-0000-000000000008';
  if t<>1 then raise exception 'FAIL 4: claimed a user out of a multi-person company'; end if;
  select count(*) into t from public.tenants where id='2222aaaa-0000-0000-0000-000000000008';
  if t<>1 then raise exception 'FAIL 4: their company was deleted'; end if;
  raise notice 'PASS 4: membership added — separate company kept, nobody moved';
end $$;
rollback;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5 + 6) REFUSE: non-owner, and owner aiming at a tenant that is not theirs
-- ─────────────────────────────────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.tenants (id,name,email,state_code,doc_code) values
  ('2222aaaa-0000-0000-0000-00000000000a','Main Co','main@m8.in','07','MG09'),
  ('2222aaaa-0000-0000-0000-00000000000b','Not Yours Co','ny@m8.in','07','MG10');
insert into auth.users (id,email) values
  ('3333bbbb-0000-0000-0000-00000000000a','owner@m8.in'),
  ('3333bbbb-0000-0000-0000-00000000000b','manager@m8.in'),
  ('3333bbbb-0000-0000-0000-00000000000c','target@m8.in');
insert into public.users (id,tenant_id,email,full_name,role) values
  ('3333bbbb-0000-0000-0000-00000000000a','2222aaaa-0000-0000-0000-00000000000a','owner@m8.in','Owner','owner'),
  ('3333bbbb-0000-0000-0000-00000000000b','2222aaaa-0000-0000-0000-00000000000a','manager@m8.in','Manager','manager');

do $$ declare msg text; begin
  -- 5) a manager is not an owner
  perform set_config('request.jwt.claims',
    '{"sub":"3333bbbb-0000-0000-0000-00000000000b","role":"authenticated"}', true);
  begin
    perform public.merge_stranded_user_into_tenant(
      'target@m8.in','2222aaaa-0000-0000-0000-00000000000a','support');
    raise exception 'FAIL 5: a manager was allowed to claim someone';
  exception when others then
    msg := sqlerrm;
    if msg like 'FAIL 5:%' then raise; end if;
  end;
  if msg not like '%Only the owner%' then
    raise exception 'FAIL 5: wrong refusal reason: %', msg; end if;
  raise notice 'PASS 5: non-owner refused';

  -- 6) an owner cannot claim INTO a tenant that is not theirs
  perform set_config('request.jwt.claims',
    '{"sub":"3333bbbb-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  begin
    perform public.merge_stranded_user_into_tenant(
      'target@m8.in','2222aaaa-0000-0000-0000-00000000000b','support');
    raise exception 'FAIL 6: claimed a user into someone else''s tenant';
  exception when others then
    msg := sqlerrm;
    if msg like 'FAIL 6:%' then raise; end if;
  end;
  if msg not like '%Only the owner%' then
    raise exception 'FAIL 6: wrong refusal reason: %', msg; end if;
  raise notice 'PASS 6: cross-tenant claim refused';
end $$;
rollback;
