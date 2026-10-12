-- Regression test: merge_stranded_user_into_tenant() (migration 0243).
-- Every block is rolled back — safe to run against any database, including prod.
--
-- Proves, on real fixtures rather than mocks:
--   1. MOVE + DELETE  — a colleague in an accidental EMPTY workspace is moved, and
--                       that workspace is deleted.
--   2. ATTACH         — an auth account with no public.users row anywhere gets one.
--   3. REFUSE (data)  — a workspace holding business data is not touched AT ALL:
--                       the user is NOT moved and the workspace is NOT deleted.
--   4. REFUSE (people)— a workspace with other members is refused before that.
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
-- 3) REFUSE (data): THE IMPORTANT ONE — nothing is touched, not even the user
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

do $$ declare msg text; tid uuid; t int; begin
  perform set_config('request.jwt.claims',
    '{"sub":"3333bbbb-0000-0000-0000-000000000005","role":"authenticated"}', true);

  begin
    perform public.merge_stranded_user_into_tenant(
      'ranjeet@m4.in','2222aaaa-0000-0000-0000-000000000005','support');
    raise exception 'FAIL 3: the call SUCCEEDED against a workspace holding data';
  exception when others then
    msg := sqlerrm;
    if msg like 'FAIL 3:%' then raise; end if;
  end;

  if msg not like '%still holds%' then
    raise exception 'FAIL 3: refusal did not state what was in the way: %', msg; end if;
  -- R-721: the refusal no longer names the other workspace or lists its tables.
  if msg like '%Has Data Co%' or msg like '%customers%' then
    raise exception 'FAIL 3: refusal leaks the other workspace''s name or contents: %', msg; end if;

  -- The whole point: the refusal is total. No partial application.
  select tenant_id into tid from public.users where id='3333bbbb-0000-0000-0000-000000000006';
  if tid <> '2222aaaa-0000-0000-0000-000000000006' then
    raise exception 'FAIL 3: user was moved anyway — data is now orphaned'; end if;
  select count(*) into t from public.tenants where id='2222aaaa-0000-0000-0000-000000000006';
  if t<>1 then raise exception 'FAIL 3: workspace holding data was deleted'; end if;

  raise notice 'PASS 3: refused, and NOTHING was changed';
end $$;
rollback;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4) REFUSE (people): a workspace with other members is somebody's real company
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

do $$ declare msg text; begin
  perform set_config('request.jwt.claims',
    '{"sub":"3333bbbb-0000-0000-0000-000000000007","role":"authenticated"}', true);
  begin
    perform public.merge_stranded_user_into_tenant(
      'a@m6.in','2222aaaa-0000-0000-0000-000000000007','support');
    raise exception 'FAIL 4: claimed a user out of a multi-person company';
  exception when others then
    msg := sqlerrm;
    if msg like 'FAIL 4:%' then raise; end if;
  end;
  if msg not like '%people in it%' then
    raise exception 'FAIL 4: wrong refusal reason: %', msg; end if;
  if msg like '%Real Other Co%' then
    raise exception 'FAIL 4: refusal leaks the other company''s name: %', msg; end if;
  raise notice 'PASS 4: refused — separate company, not an accident';
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
