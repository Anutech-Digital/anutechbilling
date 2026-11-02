-- R-2017 attack test — a logged-out caller (anon) cannot write storage, and nobody can TRUNCATE it.
-- Migration: 20261101211500_r2017_storage_anon_grants.sql.
--
-- Before the fix 20261002191000_storage_grants.sql gave anon ALL rights on storage.objects and
-- storage.buckets; only RLS stopped an upload, and TRUNCATE (which RLS never checks) was open
-- to anon and to every signed-in user. This file FAILS on the old grants (cases 1, 2, 3) and
-- PASSES on the new ones.
--
--   1. grants: anon has SELECT only on objects/buckets; anon and authenticated have no
--      TRUNCATE/REFERENCES/TRIGGER; authenticated keeps SELECT/INSERT/UPDATE/DELETE;
--      service_role keeps everything.
--   2. anon INSERT of a logo / UPDATE / DELETE is refused with "permission denied for table"
--      (the grant, not an RLS policy that a future migration could loosen).
--   3. anon TRUNCATE is refused.
--   4. the reads public pages need still work: anon can SELECT storage.objects / buckets
--      without an error (RLS decides rows, as before).
--   5. a signed-in owner still uploads into its own tenant's logo folder (RLS insert policy, as
--      before — no change for logged-in users) and cannot TRUNCATE.
--
-- SAFETY: synthetic tenant + identity, one transaction ending in ROLLBACK.

begin;

-- ── 1. grants ────────────────────────────────────────────────────────────────────────
do $$
declare t text; p text;
begin
  foreach t in array array['storage.objects', 'storage.buckets'] loop
    if not has_table_privilege('anon', t, 'SELECT') then
      raise exception 'FAIL 1: anon lost SELECT on % (public reads need it)', t; end if;
    foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', t, p) then
        raise exception 'FAIL 1: anon still has % on %', p, t; end if;
    end loop;
    foreach p in array array['TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('authenticated', t, p) then
        raise exception 'FAIL 1: authenticated still has % on % (TRUNCATE skips RLS)', p, t; end if;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('authenticated', t, p) then
        raise exception 'FAIL 1: authenticated lost % on % (signed-in uploads would break)', p, t; end if;
      if not has_table_privilege('service_role', t, p) then
        raise exception 'FAIL 1: service_role lost % on %', p, t; end if;
    end loop;
  end loop;
  raise notice 'PASS 1: anon SELECT only; no TRUNCATE/REFERENCES/TRIGGER; authenticated + service_role keep their rights';
end $$;

insert into auth.users (id, email) values
  ('c2017000-0000-0000-0000-0000000000a1', 'r2017-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2017000-0000-0000-0000-0000000000f0', 'R2017 T', 'r2017@example.test', '07', 'R217');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2017000-0000-0000-0000-0000000000a1', 'c2017000-0000-0000-0000-0000000000f0', 'r2017-owner@example.test', 'R2017 Owner', 'owner', true);
insert into storage.objects (bucket_id, name, owner) values
  ('logos', 'c2017000-0000-0000-0000-0000000000f0/logo.png', 'c2017000-0000-0000-0000-0000000000a1');

-- ── 2–4. anon ────────────────────────────────────────────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

do $$
declare v_n int; v_msg text;
begin
  -- 2. writes
  begin
    insert into storage.objects (bucket_id, name) values ('logos', 'c2017000-0000-0000-0000-0000000000f0/evil.png');
    raise exception 'FAIL 2: anon inserted a logo';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'permission denied for table objects%' then
      raise exception 'FAIL 2: anon insert refused only by RLS (%), the grant is still there', v_msg; end if;
  end;
  begin
    update storage.objects set name = name || 'x' where bucket_id = 'logos';
    raise exception 'FAIL 2: anon UPDATE ran';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'permission denied for table objects%' then
      raise exception 'FAIL 2: anon update: unexpected error %', v_msg; end if;
  end;
  begin
    delete from storage.objects where bucket_id = 'logos';
    raise exception 'FAIL 2: anon DELETE ran';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'permission denied for table objects%' then
      raise exception 'FAIL 2: anon delete: unexpected error %', v_msg; end if;
  end;
  begin
    insert into storage.buckets (id, name, public) values ('r2017-evil', 'r2017-evil', true);
    raise exception 'FAIL 2: anon created a bucket';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'permission denied for table buckets%' then
      raise exception 'FAIL 2: anon bucket insert refused only by RLS (%)', v_msg; end if;
  end;
  raise notice 'PASS 2: anon insert/update/delete refused by the grant';

  -- 3. truncate
  begin
    truncate storage.objects;
    raise exception 'FAIL 3: anon TRUNCATED storage.objects';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS 3: anon cannot truncate';

  -- 4. reads still work (no error; RLS decides rows)
  select count(*) into v_n from storage.objects where bucket_id = 'logos';
  select count(*) into v_n from storage.buckets;
  raise notice 'PASS 4: anon SELECT on objects/buckets runs';
end $$;

reset role;

-- ── 5. signed-in owner, unchanged ────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c2017000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);

do $$
declare v_n int; v_msg text;
begin
  insert into storage.objects (bucket_id, name, owner)
    values ('logos', 'c2017000-0000-0000-0000-0000000000f0/logo-new.png', 'c2017000-0000-0000-0000-0000000000a1');
  -- (The insert running is the proof: logos has an INSERT policy for the tenant folder but no
  --  SELECT policy for signed-in users — the app writes logos with the admin client and serves
  --  them from the public bucket, so UPDATE/DELETE as a signed-in user match 0 rows, before
  --  and after this card.)
  begin
    truncate storage.objects;
    raise exception 'FAIL 5: a signed-in user TRUNCATED storage.objects';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS 5: owner still uploads into its own tenant logo folder; cannot truncate';
end $$;

reset role;
rollback;
