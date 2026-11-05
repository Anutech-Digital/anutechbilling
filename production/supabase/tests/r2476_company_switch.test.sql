-- R-2476 — company switcher (R-2471 slice 2): the list the switcher shows + the activity log a
-- switch leaves behind.
-- Migration: *_r2476_company_switcher.sql   Spec: docs/specs/memberships.md §2.5 / §4
--
-- Before the migration there is no my_companies() and switch_company() writes the old company's
-- uuid / role into the NEW company's activity log, so this file FAILS (case 1 / case 4). With it:
--   1. my_companies() for a member of A (manager) and B (sales): two rows, names + roles, A ticked.
--   2. A login in one company sees one row (the switcher stays hidden); an ended, a switched-off and
--      an expired membership are never listed; no session → no rows; anon cannot call it.
--   3. MFA-enrolled login on an aal1 session: my_companies() empty, switch_company() refused with
--      a next step (the authenticator code).
--   4. switch A → B: exactly one activity row in B (role sales, company B — no A uuid / name / role)
--      and one in A (company A / role manager — no B uuid / name / role).
--   5. switching to the company already selected writes no activity row.
--   6. my_companies() after the switch ticks B.
--   7. B → A → B in ONE transaction (a script, a self-test): still no row in either company carries
--      the other company's uuid / name / role.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2476_company_switch.test.sql

begin;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2476000-0000-0000-0000-0000000000a1', 'r2476-owner-a@example.test'),
  ('c2476000-0000-0000-0000-0000000000a3', 'r2476-member@example.test'),
  ('c2476000-0000-0000-0000-0000000000a5', 'r2476-mfa@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2476000-0000-0000-0000-0000000000f1', 'R2476 Alpha Co', 'r2476a@example.test', '07', 'R276A'),
  ('c2476000-0000-0000-0000-0000000000f2', 'R2476 Beta Co',  'r2476b@example.test', '07', 'R276B'),
  ('c2476000-0000-0000-0000-0000000000f3', 'R2476 Gamma Co', 'r2476c@example.test', '07', 'R276C'),
  ('c2476000-0000-0000-0000-0000000000f4', 'R2476 Delta Co', 'r2476d@example.test', '07', 'R276D'),
  ('c2476000-0000-0000-0000-0000000000f5', 'R2476 Eps Co',   'r2476e@example.test', '07', 'R276E');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2476000-0000-0000-0000-0000000000a1', 'c2476000-0000-0000-0000-0000000000f1', 'r2476-owner-a@example.test', 'R2476 Owner A', 'owner',   true),
  ('c2476000-0000-0000-0000-0000000000a3', 'c2476000-0000-0000-0000-0000000000f1', 'r2476-member@example.test',  'R2476 Member',  'manager', true),
  ('c2476000-0000-0000-0000-0000000000a5', 'c2476000-0000-0000-0000-0000000000f1', 'r2476-mfa@example.test',     'R2476 Mfa',     'sales',   true);

-- The member also belongs to B (sales, active), C (ended), D (switched off) and E (access ended yesterday).
insert into public.tenant_memberships (user_id, tenant_id, role, is_active, ended_at, end_reason, access_ends_on) values
  ('c2476000-0000-0000-0000-0000000000a3', 'c2476000-0000-0000-0000-0000000000f2', 'sales',   true,  null,  null,      null),
  ('c2476000-0000-0000-0000-0000000000a3', 'c2476000-0000-0000-0000-0000000000f3', 'support', true,  now(), 'removed', null),
  ('c2476000-0000-0000-0000-0000000000a3', 'c2476000-0000-0000-0000-0000000000f4', 'support', false, null,  null,      null),
  ('c2476000-0000-0000-0000-0000000000a3', 'c2476000-0000-0000-0000-0000000000f5', 'support', true,  null,  null,      public.ist_today() - 1),
  ('c2476000-0000-0000-0000-0000000000a5', 'c2476000-0000-0000-0000-0000000000f2', 'sales',   true,  null,  null,      null);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c2476000-0000-0000-0000-0000000000d1', 'c2476000-0000-0000-0000-0000000000a5', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());

-- anon may not call it (2)
do $$
begin
  if has_function_privilege('anon', 'public.my_companies()', 'execute') then
    raise exception 'FAIL 2: anon may execute my_companies()';
  end if;
  if not has_function_privilege('authenticated', 'public.my_companies()', 'execute') then
    raise exception 'FAIL 2: authenticated may not execute my_companies()';
  end if;
  raise notice 'PASS 2a: my_companies() is for signed-in logins only';
end $$;

set local role authenticated;

-- ── 1–2. What the switcher lists ────────────────────────────────────────────────────
do $$
declare
  v_rows jsonb;
  v_n int;
begin
  perform set_config('request.jwt.claims', '', true);
  select count(*) into v_n from public.my_companies();
  if v_n <> 0 then raise exception 'FAIL 2: no session sees % companies', v_n; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2476000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  select jsonb_agg(jsonb_build_object('t', c.tenant_id, 'name', c.company_name, 'role', c.role, 'cur', c.is_current))
    into v_rows from public.my_companies() c;
  if jsonb_array_length(coalesce(v_rows, '[]')) <> 2 then
    raise exception 'FAIL 2: member sees % companies, expected 2 (A, B — never ended / off / expired): %',
      jsonb_array_length(coalesce(v_rows, '[]')), v_rows;
  end if;
  if not v_rows @> '[{"t":"c2476000-0000-0000-0000-0000000000f1","name":"R2476 Alpha Co","role":"manager","cur":true}]'::jsonb
     or not v_rows @> '[{"t":"c2476000-0000-0000-0000-0000000000f2","name":"R2476 Beta Co","role":"sales","cur":false}]'::jsonb then
    raise exception 'FAIL 1: wrong rows %', v_rows;
  end if;
  if (v_rows->0->>'cur')::boolean is not true then
    raise exception 'FAIL 1: the current company is not listed first: %', v_rows;
  end if;
  raise notice 'PASS 1: member of A + B sees both with names and roles, A ticked and first';

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2476000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.my_companies();
  if v_n <> 1 then raise exception 'FAIL 2: owner of A only sees % companies, expected 1', v_n; end if;
  raise notice 'PASS 2: one company → one row; ended / switched-off / expired never listed; no session → none';
end $$;

-- ── 3. MFA-enrolled login on aal1 ───────────────────────────────────────────────────
do $$
declare
  v_msg text;
  v_n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2476000-0000-0000-0000-0000000000a5', 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into v_n from public.my_companies();
  if v_n <> 0 then raise exception 'FAIL 3: aal1 session lists % companies before two-step sign-in', v_n; end if;
  begin
    perform public.switch_company('c2476000-0000-0000-0000-0000000000f2');
  exception when insufficient_privilege then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null then raise exception 'FAIL 3: aal1 session could switch company'; end if;
  if v_msg not ilike '%authenticator app%' then
    raise exception 'FAIL 3: MFA refusal has no next step: %', v_msg;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2476000-0000-0000-0000-0000000000a5', 'role', 'authenticated', 'aal', 'aal2')::text, true);
  select count(*) into v_n from public.my_companies();
  if v_n <> 2 then raise exception 'FAIL 3: aal2 session lists % companies, expected 2', v_n; end if;
  raise notice 'PASS 3: MFA login lists and switches only after the code; refusal names the next step';
end $$;

-- ── 4–6. Switch A → B: each company's log holds only its own facts ─────────────────
reset role;
create temp table r2476_mark as select coalesce(max(id), 0) as last_id from public.activity_log;
grant select on r2476_mark to authenticated;
set local role authenticated;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2476000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  perform public.switch_company('c2476000-0000-0000-0000-0000000000f2');
  if public.current_tenant_id() is distinct from 'c2476000-0000-0000-0000-0000000000f2'::uuid then
    raise exception 'FAIL 4: switch to B did not land in B';
  end if;
end $$;

reset role;
do $$
declare
  v_a uuid := 'c2476000-0000-0000-0000-0000000000f1';
  v_b uuid := 'c2476000-0000-0000-0000-0000000000f2';
  v_last bigint := (select last_id from r2476_mark);
  v_inb jsonb;
  v_ina jsonb;
  v_n int;
begin
  select count(*) into v_n from public.activity_log
   where id > v_last and entity = 'users' and entity_id = 'c2476000-0000-0000-0000-0000000000a3' and tenant_id = v_b;
  if v_n <> 1 then raise exception 'FAIL 4: % activity rows in B for the switch, expected 1', v_n; end if;
  select to_jsonb(a) into v_inb from public.activity_log a
   where id > v_last and entity = 'users' and entity_id = 'c2476000-0000-0000-0000-0000000000a3' and tenant_id = v_b;
  if v_inb::text like '%' || v_a::text || '%' or v_inb::text like '%R2476 Alpha Co%' or (v_inb->'changes')::text like '%manager%' then
    raise exception 'FAIL 4: B''s activity row carries company A''s facts: %', v_inb;
  end if;
  if v_inb->'changes'->'role'->>'new' is distinct from 'sales'
     or v_inb->'changes'->'company'->>'new' is distinct from 'R2476 Beta Co'
     or (v_inb->>'user_id')::uuid is distinct from 'c2476000-0000-0000-0000-0000000000a3'::uuid then
    raise exception 'FAIL 4: B''s activity row does not say who switched in, as what: %', v_inb;
  end if;

  select count(*) into v_n from public.activity_log
   where id > v_last and entity = 'users' and entity_id = 'c2476000-0000-0000-0000-0000000000a3' and tenant_id = v_a;
  if v_n <> 1 then raise exception 'FAIL 4: % activity rows in A for the switch, expected 1', v_n; end if;
  select to_jsonb(a) into v_ina from public.activity_log a
   where id > v_last and entity = 'users' and entity_id = 'c2476000-0000-0000-0000-0000000000a3' and tenant_id = v_a;
  if v_ina::text like '%' || v_b::text || '%' or v_ina::text like '%R2476 Beta Co%' or (v_ina->'changes')::text like '%sales%' then
    raise exception 'FAIL 4: A''s activity row carries company B''s facts: %', v_ina;
  end if;
  if v_ina->'changes'->'company'->>'old' is distinct from 'R2476 Alpha Co'
     or v_ina->'changes'->'role'->>'old' is distinct from 'manager' then
    raise exception 'FAIL 4: A''s activity row does not say who left, as what: %', v_ina;
  end if;

  select count(*) into v_n from public.activity_log
   where id > v_last and tenant_id not in (v_a, v_b)
     and entity = 'users' and entity_id = 'c2476000-0000-0000-0000-0000000000a3';
  if v_n <> 0 then raise exception 'FAIL 4: % switch rows landed in a third company', v_n; end if;
  raise notice 'PASS 4: switch A → B logs one row in each company, each with only its own company / role';

  update r2476_mark set last_id = (select max(id) from public.activity_log);
end $$;

set local role authenticated;
do $$
declare v_cur uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2476000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  perform public.switch_company('c2476000-0000-0000-0000-0000000000f2');   -- already there
  select c.tenant_id into v_cur from public.my_companies() c where c.is_current;
  if v_cur is distinct from 'c2476000-0000-0000-0000-0000000000f2'::uuid then
    raise exception 'FAIL 6: my_companies() ticks % after the switch, expected B', v_cur;
  end if;
  raise notice 'PASS 6: my_companies() ticks B after the switch';
end $$;

reset role;
do $$
declare v_n int;
begin
  select count(*) into v_n from public.activity_log
   where id > (select last_id from r2476_mark) and entity = 'users'
     and entity_id = 'c2476000-0000-0000-0000-0000000000a3';
  if v_n <> 0 then raise exception 'FAIL 5: switching to the selected company wrote % activity rows', v_n; end if;
  raise notice 'PASS 5: switching to the company already selected writes nothing';
end $$;

-- ── 7. several switches in one transaction ──────────────────────────────────────────
set local role authenticated;
do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2476000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  perform public.switch_company('c2476000-0000-0000-0000-0000000000f1');
  perform public.switch_company('c2476000-0000-0000-0000-0000000000f2');
end $$;
reset role;
do $$
declare
  v_a uuid := 'c2476000-0000-0000-0000-0000000000f1';
  v_b uuid := 'c2476000-0000-0000-0000-0000000000f2';
  v_bad int;
  v_n int;
begin
  select count(*) into v_bad from public.activity_log a
   where a.id > (select last_id from r2476_mark) and a.entity = 'users'
     and a.entity_id = 'c2476000-0000-0000-0000-0000000000a3'
     and ((a.tenant_id = v_b and (to_jsonb(a)::text like '%' || v_a::text || '%' or a.changes::text like '%R2476 Alpha Co%'))
       or (a.tenant_id = v_a and (to_jsonb(a)::text like '%' || v_b::text || '%' or a.changes::text like '%R2476 Beta Co%')));
  if v_bad <> 0 then raise exception 'FAIL 7: % rows carry the other company''s facts after B → A → B', v_bad; end if;
  select count(*) into v_n from public.activity_log a
   where a.id > (select last_id from r2476_mark) and a.entity = 'users'
     and a.entity_id = 'c2476000-0000-0000-0000-0000000000a3';
  if v_n <> 4 then raise exception 'FAIL 7: % rows for two switches, expected 4 (in + out each)', v_n; end if;
  raise notice 'PASS 7: B → A → B in one transaction — every row holds only its own company''s facts';
end $$;

rollback;
