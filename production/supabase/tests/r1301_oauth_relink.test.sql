\set ON_ERROR_STOP on
-- R-1301 (P1, launch safety): a first Google sign-in must leave an existing person's profile on
-- its own id, with every linked row intact. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1301_oauth_relink.test.sql
--
-- Expect "PASS r1301_oauth_relink".
--
-- The scene: an existing owner (profile A) with activity_log + leads rows signs in with Google for
-- the first time through the GoTrue path, which hands the callback a NEW auth uid (B).
--   1. The OLD callback statement (`update users set id = B where id = A`) is proved to FAIL on
--      the FKs (no ON UPDATE CASCADE) — the error the old code never read, which stranded people.
--   2. The NEW callback's only write — the activity_log "link refused" row, as service_role
--      (the admin client) — succeeds under RLS + the R-1002 secret-strip trigger.
--   3. Afterwards: profile A still exists with the same id/tenant/role, no profile under B, the
--      activity_log + leads rows still point at A, and the refusal row carries old/new id + provider.

begin;
select set_config('request.jwt.claims', '', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1301000-0000-0000-0000-0000000000a0', 'R1301 Co', 'r1301@example.in', '07', 'R13A');

insert into auth.users (id, email, email_confirmed_at, last_sign_in_at) values
  ('e1301000-0000-4000-8000-0000000000a1', 'r1301-owner@example.test', now(), now() - interval '3 days');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1301000-0000-4000-8000-0000000000a1', 'e1301000-0000-0000-0000-0000000000a0',
   'r1301-owner@example.test', 'R1301 Owner', 'owner', true);

insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label) values
  ('e1301000-0000-0000-0000-0000000000a0', 'e1301000-0000-4000-8000-0000000000a1',
   'lead.created', 'lead', 'x', 'R1301 seeded history');

insert into public.leads (id, tenant_id, company, owner_id, created_by) values
  ('e1301000-0000-4000-8000-00000000c001', 'e1301000-0000-0000-0000-0000000000a0', 'R1301 Lead Co',
   'e1301000-0000-4000-8000-0000000000a1', 'e1301000-0000-4000-8000-0000000000a1');

-- GoTrue made a second login (B) for the same address on the first Google sign-in.
insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, raw_app_meta_data) values
  ('e1301000-0000-4000-8000-0000000000b2', 'r1301-google@example.test', now(), now(),
   '{"provider":"google","providers":["google"]}'::jsonb);

create temp table r1301_fail (msg text) on commit drop;

-- 1. The old statement fails — proof that the old code (which ignored this error) stranded people.
do $$
declare v_failed boolean := false;
begin
  begin
    update public.users set id = 'e1301000-0000-4000-8000-0000000000b2'
     where id = 'e1301000-0000-4000-8000-0000000000a1';
  exception when foreign_key_violation then
    v_failed := true;
  end;
  if not v_failed then
    insert into r1301_fail values ('old re-link UPDATE did not fail: expected a foreign_key_violation (users.id has linked rows)');
  end if;
end $$;

-- 2. The new callback's write: the refusal row, through the admin client (service_role).
set local role service_role;
insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, actor_label, changes) values
  ('e1301000-0000-0000-0000-0000000000a0', 'e1301000-0000-4000-8000-0000000000a1',
   'auth.oauth_link_refused', 'user', 'e1301000-0000-4000-8000-0000000000a1',
   'Google sign-in not linked to existing profile (id unchanged)', 'system: oauth callback',
   jsonb_build_object('old_id', 'e1301000-0000-4000-8000-0000000000a1',
                      'new_id', 'e1301000-0000-4000-8000-0000000000b2',
                      'provider', 'google', 'layer', 'gotrue',
                      'outcome', 'refused_id_unchanged', 'card', 'R-1301'));
reset role;

-- 3. Everything is where it was.
do $$
begin
  if not exists (select 1 from public.users
                  where id = 'e1301000-0000-4000-8000-0000000000a1'
                    and tenant_id = 'e1301000-0000-0000-0000-0000000000a0'
                    and role = 'owner' and is_active) then
    insert into r1301_fail values ('profile A lost its id / tenant / role');
  end if;
  if exists (select 1 from public.users where id = 'e1301000-0000-4000-8000-0000000000b2') then
    insert into r1301_fail values ('a profile appeared under the new Google login id');
  end if;
  if (select count(*) from public.activity_log
       where user_id = 'e1301000-0000-4000-8000-0000000000a1' and label = 'R1301 seeded history') <> 1 then
    insert into r1301_fail values ('seeded activity_log row no longer points at profile A');
  end if;
  if not exists (select 1 from public.leads
                  where id = 'e1301000-0000-4000-8000-00000000c001'
                    and owner_id = 'e1301000-0000-4000-8000-0000000000a1'
                    and created_by = 'e1301000-0000-4000-8000-0000000000a1') then
    insert into r1301_fail values ('lead no longer owned / created by profile A');
  end if;
  if not exists (select 1 from public.activity_log
                  where action = 'auth.oauth_link_refused'
                    and user_id = 'e1301000-0000-4000-8000-0000000000a1'
                    and changes->>'old_id' = 'e1301000-0000-4000-8000-0000000000a1'
                    and changes->>'new_id' = 'e1301000-0000-4000-8000-0000000000b2'
                    and changes->>'provider' = 'google') then
    insert into r1301_fail values ('link-refused activity_log row missing or without old_id/new_id/provider');
  end if;
end $$;

do $$
declare v text;
begin
  select string_agg(msg, E'\n  - ') into v from r1301_fail;
  if v is not null then
    raise exception E'FAIL r1301_oauth_relink:\n  - %', v;
  end if;
  raise notice 'PASS r1301_oauth_relink';
end $$;

rollback;
