\set ON_ERROR_STOP on
-- Regression test: platform-owned columns of tenants / tenant_domains cannot be written by a
-- workspace owner from the browser. Migration 20261011093000_r720_tenant_privileged_columns.sql
-- (R-720). Rolled back — safe anywhere.
--
--   BLOCKED  owner inserts a tenant_domains row already marked verified (domain squat → join-request leak)
--   BLOCKED  owner marks their unverified domain row verified
--   BLOCKED  owner swaps the domain on a verified row (carrying the verification to another domain)
--   ALLOWED  owner adds / removes an UNVERIFIED domain claim for their own workspace
--   BLOCKED  owner changes tenants.tier / parent_tenant_id (→ another distributor's partner prices)
--   BLOCKED  owner sets tenants.gstin_verified_at / gstin_verification
--   BLOCKED  owner points gmail_sender_user_id at a user of ANOTHER workspace
--   ALLOWED  owner edits name / address; Gmail sender = own member
--   CLEARED  owner changes the GSTIN → the old verification is dropped
--   BLOCKED  an authenticated login inserting a tenant (with or without tier / parent)
--   ALLOWED  service_role does all of the above

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code, gstin, gstin_verified_at, gstin_verification) values
  ('72000000-0000-4000-8000-000000000001', 'R720 OWNER CO', 'r720-a@example.in', '07', 'R72A',
   '07AAACR7200A1Z5', now(), '{"status":"Active"}'::jsonb),
  ('72000000-0000-4000-8000-000000000002', 'R720 OTHER',    'r720-b@example.in', '07', 'R72B', null, null, null);
insert into public.tenants (id, name, email, state_code, doc_code, tier) values
  ('72000000-0000-4000-8000-000000000003', 'R720 DISTRIBUTOR', 'r720-d@example.in', '07', 'R72D', 'distributor');

insert into auth.users (id, instance_id, aud, role, email) values
  ('72000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r720-owner@example.in'),
  ('72000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r720-mate@example.in'),
  ('72000000-0000-4000-8000-00000000000f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r720-other@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('72000000-0000-4000-8000-00000000000a', '72000000-0000-4000-8000-000000000001', 'r720-owner@example.in', 'owner',   true),
  ('72000000-0000-4000-8000-00000000000b', '72000000-0000-4000-8000-000000000001', 'r720-mate@example.in',  'manager', true),
  ('72000000-0000-4000-8000-00000000000f', '72000000-0000-4000-8000-000000000002', 'r720-other@example.in', 'owner',   true);

/* A domain the owner's workspace legitimately verified through the operator. */
insert into public.tenant_domains (id, tenant_id, domain, verified_at) values
  ('72000000-0000-4000-8000-0000000000d1', '72000000-0000-4000-8000-000000000001', 'r720-owner.example', now());

do $$
declare
  v_err boolean; v_msg text; v_n int; v_t record;
  c_me    constant uuid := '72000000-0000-4000-8000-000000000001';
  c_other constant uuid := '72000000-0000-4000-8000-000000000002';
  c_dist  constant uuid := '72000000-0000-4000-8000-000000000003';
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','72000000-0000-4000-8000-00000000000a','role','authenticated')::text, true);

  -- ── BLOCKED 1: insert a domain already "verified" ───────────────────────
  v_err := false;
  begin
    insert into public.tenant_domains (tenant_id, domain, verified_at) values (c_me, 'r720-victimcorp.example', now());
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 1: an owner inserted a domain with verified_at set (no DNS proof)'; end if;

  -- ── ALLOWED 2: an unverified claim for the own workspace ────────────────
  insert into public.tenant_domains (id, tenant_id, domain) values ('72000000-0000-4000-8000-0000000000d2', c_me, 'r720-claim.example');

  -- ── BLOCKED 3: mark that claim verified ─────────────────────────────────
  v_err := false;
  begin
    update public.tenant_domains set verified_at = now() where id = '72000000-0000-4000-8000-0000000000d2';
  exception when insufficient_privilege then v_err := true; end;
  if not v_err and exists (select 1 from public.tenant_domains where id = '72000000-0000-4000-8000-0000000000d2' and verified_at is not null) then
    raise exception 'FAIL 3: an owner marked their own domain claim verified';
  end if;

  -- ── BLOCKED 4: swap the domain on the verified row ──────────────────────
  v_err := false;
  begin
    update public.tenant_domains set domain = 'r720-victim2.example' where id = '72000000-0000-4000-8000-0000000000d1';
  exception when insufficient_privilege then v_err := true; end;
  if exists (select 1 from public.tenant_domains where id = '72000000-0000-4000-8000-0000000000d1' and domain <> 'r720-owner.example') then
    raise exception 'FAIL 4: an owner moved a verified domain row to another domain';
  end if;

  -- ── ALLOWED 5: remove the own unverified claim ──────────────────────────
  delete from public.tenant_domains where id = '72000000-0000-4000-8000-0000000000d2';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 5: an owner could not remove their own unverified domain claim'; end if;

  -- ── BLOCKED 6: tier ─────────────────────────────────────────────────────
  v_err := false;
  begin
    update public.tenants set tier = 'distributor' where id = c_me;
  exception when insufficient_privilege then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 6: an owner changed their own tier'; end if;
  if v_msg not like 'Workspace tier and parent%' then raise exception 'FAIL 6b: tier refused by something else: %', v_msg; end if;

  -- ── BLOCKED 7: parent_tenant_id (partner catalog of another distributor) ─
  v_err := false;
  begin
    update public.tenants set parent_tenant_id = c_dist where id = c_me;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 7: an owner attached their workspace to another distributor'; end if;

  -- ── BLOCKED 8: gstin_verified_at / gstin_verification ──────────────────
  update public.tenants set gstin_verified_at = null, gstin_verification = null where id = c_me;  -- clearing is fine
  v_err := false;
  begin
    update public.tenants set gstin_verified_at = now() where id = c_me;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 8: an owner stamped their own GSTIN as verified'; end if;
  v_err := false;
  begin
    update public.tenants set gstin_verification = '{"status":"Active","legal_name":"Forged"}'::jsonb where id = c_me;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 9: an owner wrote their own GSTIN verification result'; end if;

  -- ── BLOCKED 10: Gmail sender from another workspace ─────────────────────
  v_err := false;
  begin
    update public.tenants set gmail_sender_user_id = '72000000-0000-4000-8000-00000000000f' where id = c_me;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 10: an owner set another workspace''s user as their Gmail sender'; end if;

  -- ── ALLOWED 11: normal profile edits + own member as Gmail sender ───────
  update public.tenants set name = 'R720 RENAMED', address = 'R720 street',
                            gmail_sender_user_id = '72000000-0000-4000-8000-00000000000b'
   where id = c_me;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 11: an owner could not edit their own company profile'; end if;

  -- ── BLOCKED 12: authenticated tenant inserts ────────────────────────────
  v_err := false;
  begin
    insert into public.tenants (name, email, tier, parent_tenant_id) values ('R720 FORGED', 'r720-f@example.in', 'distributor', c_dist);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 12: an authenticated login inserted a tenant with tier / parent'; end if;
  v_err := false;
  begin
    insert into public.tenants (name, email) values ('R720 PLAIN', 'r720-p@example.in');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 13: an authenticated login inserted a tenant directly'; end if;

  -- ── service_role: the server can do everything ──────────────────────────
  reset role;
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  update public.tenants set gstin_verified_at = now(), gstin_verification = '{"status":"Active"}'::jsonb where id = c_me;
  update public.tenants set tier = 'distributor' where id = c_other;
  update public.tenants set parent_tenant_id = c_dist where id = c_me;
  update public.tenants set gmail_sender_user_id = null where id = c_me;
  insert into public.tenant_domains (tenant_id, domain, verified_at) values (c_other, 'r720-other.example', now());
  update public.tenant_domains set verified_at = now() where id = '72000000-0000-4000-8000-0000000000d1';
  insert into public.tenants (name, email, tier, parent_tenant_id, doc_code) values ('R720 SERVER', 'r720-s@example.in', 'reseller', c_dist, 'R72S');

  select tier, parent_tenant_id, gstin_verified_at into v_t from public.tenants where id = c_me;
  if v_t.parent_tenant_id is distinct from c_dist or v_t.gstin_verified_at is null then
    raise exception 'FAIL 14: service_role writes did not land';
  end if;

  -- ── CLEARED 15: owner changes the GSTIN → verification dropped ──────────
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','72000000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  update public.tenants set gstin = '07AAACR7200A1Z5' where id = c_me;  -- same number: kept
  if not exists (select 1 from public.tenants where id = c_me and gstin_verified_at is not null) then
    raise exception 'FAIL 15a: re-saving the same GSTIN dropped the verification';
  end if;
  update public.tenants set gstin = '07AAACR7201A1Z4' where id = c_me;
  if exists (select 1 from public.tenants where id = c_me and (gstin_verified_at is not null or gstin_verification is not null)) then
    raise exception 'FAIL 15b: a new GSTIN kept the old number''s verification';
  end if;

  reset role;
  raise notice 'r720_tenant_domain_fields: all checks passed';
end $$;

rollback;
