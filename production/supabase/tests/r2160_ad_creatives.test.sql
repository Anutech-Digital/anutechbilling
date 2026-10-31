-- R-2160 (30 Oct 2026, G-ADS-AI AI-04): the private ad-creatives bucket for generated ad images.
-- Migration 20261030122442_r2160_ad_creatives.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
-- Before the migration it FAILS at setup (no bucket 'ad-creatives' — storage.objects FK).
--
-- Proves:
--   A. The bucket is private, takes only png / jpeg / webp, and has a size limit.
--   B. Owner and marketing logins of the company read its {tenant}/… creatives.
--   C. Manager, sales, personal and a deactivated owner of the SAME company see nothing.
--   D. Another company's owner sees nothing of this company; a {tenant}-less or ../ path is refused.
--   E. No signed-in user can upload, overwrite or delete a creative (server only).
--   F. service_role reads and writes (the image provider stores through it).
--   G. anon sees nothing.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000216001', 'R2160 Co',    'r2160@example.in',  '07', 'R2160'),
  ('dddddddd-0000-0000-0000-000000216002', 'R2160 Other', 'r2160b@example.in', '07', 'R2160B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000216001', 'owner2160@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216002', 'mkt2160@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216003', 'mgr2160@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216004', 'sales2160@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216005', 'owner2160b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216006', 'exowner2160@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000216007', 'personal2160@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('aaaaaaaa-0000-0000-0000-000000216001', 'dddddddd-0000-0000-0000-000000216001', 'owner2160@example.in',    'R2160 Owner',    'owner',     true),
  ('aaaaaaaa-0000-0000-0000-000000216002', 'dddddddd-0000-0000-0000-000000216001', 'mkt2160@example.in',      'R2160 Mkt',      'marketing', true),
  ('aaaaaaaa-0000-0000-0000-000000216003', 'dddddddd-0000-0000-0000-000000216001', 'mgr2160@example.in',      'R2160 Mgr',      'manager',   true),
  ('aaaaaaaa-0000-0000-0000-000000216004', 'dddddddd-0000-0000-0000-000000216001', 'sales2160@example.in',    'R2160 Sales',    'sales',     true),
  ('aaaaaaaa-0000-0000-0000-000000216005', 'dddddddd-0000-0000-0000-000000216002', 'owner2160b@example.in',   'R2160 Other',    'owner',     true),
  ('aaaaaaaa-0000-0000-0000-000000216006', 'dddddddd-0000-0000-0000-000000216001', 'exowner2160@example.in',  'R2160 ExOwner',  'owner',     false),
  ('aaaaaaaa-0000-0000-0000-000000216007', 'dddddddd-0000-0000-0000-000000216001', 'personal2160@example.in', 'R2160 Personal', 'personal',  true);

-- Two creatives of company 1, one of company 2 (as the server stores them).
insert into storage.objects (bucket_id, name, owner) values
  ('ad-creatives', 'dddddddd-0000-0000-0000-000000216001/eeeeeeee-0000-0000-0000-000000216001/a-1x1.png',  null),
  ('ad-creatives', 'dddddddd-0000-0000-0000-000000216001/eeeeeeee-0000-0000-0000-000000216001/a-9x16.png', null),
  ('ad-creatives', 'dddddddd-0000-0000-0000-000000216002/eeeeeeee-0000-0000-0000-000000216002/b-1x1.png',  null);

create function pg_temp.r2160_seen() returns int
language sql as $$ select count(*)::int from storage.objects where bucket_id = 'ad-creatives' $$;

create function pg_temp.r2160_insert_refused(p_name text) returns boolean
language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner) values ('ad-creatives', p_name, auth.uid());
  return false;
exception when insufficient_privilege then
  return true;
end $$;

grant execute on function pg_temp.r2160_seen() to authenticated, anon, service_role;
grant execute on function pg_temp.r2160_insert_refused(text) to authenticated;

-- ── A. bucket config ──────────────────────────────────────────────────────────────
do $$
declare b record;
begin
  select public, file_size_limit, allowed_mime_types into b from storage.buckets where id = 'ad-creatives';
  if not found then raise exception 'FAIL A: no ad-creatives bucket'; end if;
  if b.public then raise exception 'FAIL A: ad-creatives is public'; end if;
  if b.file_size_limit is null or b.file_size_limit > 10485760 then raise exception 'FAIL A: size limit % (expected <= 10 MB)', b.file_size_limit; end if;
  if b.allowed_mime_types is null or not (b.allowed_mime_types <@ array['image/png', 'image/jpeg', 'image/webp']) or not ('image/png' = any (b.allowed_mime_types)) then
    raise exception 'FAIL A: mime list %', b.allowed_mime_types; end if;
  raise notice 'PASS A: ad-creatives is private, png/jpeg/webp, 10 MB';
end $$;

-- storage.protect_delete blocks every DELETE unless this is set — then only RLS decides (as in r724).
do $$ begin perform set_config('storage.allow_delete_query', 'true', true); end $$;

set local role authenticated;

-- ── B–E. signed-in users ──────────────────────────────────────────────────────────
do $$
declare
  t1   text := 'dddddddd-0000-0000-0000-000000216001';
  p1   text := 'eeeeeeee-0000-0000-0000-000000216001';
  v_n  int;
  who  text;
  ids  text[] := array['aaaaaaaa-0000-0000-0000-000000216001', 'aaaaaaaa-0000-0000-0000-000000216002'];
begin
  -- B. owner + marketing
  foreach who in array ids loop
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    v_n := pg_temp.r2160_seen();
    if v_n <> 2 then raise exception 'FAIL B: % sees % creatives, expected its company''s 2', who, v_n; end if;
    if exists (select 1 from storage.objects where bucket_id = 'ad-creatives' and name not like t1 || '/%') then
      raise exception 'FAIL B/D: % sees another company''s creative', who; end if;
  end loop;
  raise notice 'PASS B: owner and marketing read their company''s creatives (2), nothing else';

  -- C. manager, sales, deactivated owner, personal of the same company
  foreach who in array array['aaaaaaaa-0000-0000-0000-000000216003', 'aaaaaaaa-0000-0000-0000-000000216004',
                             'aaaaaaaa-0000-0000-0000-000000216006', 'aaaaaaaa-0000-0000-0000-000000216007'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    v_n := pg_temp.r2160_seen();
    if v_n <> 0 then raise exception 'FAIL C: % (not owner/marketing or inactive) sees % creatives', who, v_n; end if;
  end loop;
  raise notice 'PASS C: manager, sales, personal and an inactive owner see nothing';

  -- D. other company's owner sees only its own; odd paths refused by the rule itself
  perform set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000216005', 'role', 'authenticated')::text, true);
  if exists (select 1 from storage.objects where bucket_id = 'ad-creatives' and name like t1 || '/%') then
    raise exception 'FAIL D: another company''s owner sees company 1 creatives'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ids[1], 'role', 'authenticated')::text, true);
  if public.ad_creative_object_allowed(t1 || '/../x.png', 'select')
     or public.ad_creative_object_allowed(t1, 'select')
     or public.ad_creative_object_allowed('dddddddd-0000-0000-0000-000000216002/' || p1 || '/b-1x1.png', 'select')
     or public.ad_creative_object_allowed(t1 || '/' || p1 || '/a-1x1.png', 'insert') then
    raise exception 'FAIL D: the rule allows a ../ path, a bare tenant folder, another company or a write'; end if;
  if not public.ad_creative_object_allowed(t1 || '/' || p1 || '/a-1x1.png', 'select') then
    raise exception 'FAIL D: the rule refuses the owner''s own creative'; end if;
  raise notice 'PASS D: other company sees nothing; ../, bare folder and other-tenant paths refused';

  -- E. no browser writes — owner and marketing included
  foreach who in array ids loop
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    if not pg_temp.r2160_insert_refused(t1 || '/' || p1 || '/fake.png') then
      raise exception 'FAIL E: % uploaded into ad-creatives directly', who; end if;
    update storage.objects set name = name || '.x' where bucket_id = 'ad-creatives';
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL E: % renamed % creatives', who, v_n; end if;
    delete from storage.objects where bucket_id = 'ad-creatives';
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL E: % deleted % creatives', who, v_n; end if;
  end loop;
  raise notice 'PASS E: no signed-in user uploads, renames or deletes a creative';
end $$;

-- ── F. service_role ───────────────────────────────────────────────────────────────
reset role;
set local role service_role;
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  v_n := pg_temp.r2160_seen();
  if v_n <> 3 then raise exception 'FAIL F: service_role sees % creatives, expected 3', v_n; end if;
  insert into storage.objects (bucket_id, name) values ('ad-creatives', 'dddddddd-0000-0000-0000-000000216001/eeeeeeee-0000-0000-0000-000000216001/c-1x1.png');
  raise notice 'PASS F: service_role reads all and stores a creative';
end $$;

-- ── G. anon ───────────────────────────────────────────────────────────────────────
reset role;
set local role anon;
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  v_n := pg_temp.r2160_seen();
  if v_n <> 0 then raise exception 'FAIL G: anon sees % creatives', v_n; end if;
  raise notice 'PASS G: anon sees nothing';
  raise notice 'r2160_ad_creatives: all checks passed';
end $$;

rollback;
