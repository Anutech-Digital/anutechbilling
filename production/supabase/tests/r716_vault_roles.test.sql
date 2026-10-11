\set ON_ERROR_STOP on
-- Regression test: customer console credentials (vault_passwords) belong to the tenant's
-- owner / manager only. Migration 20261011031600_r716_vault_owner_manager.sql (R-716).
-- Rolled back — safe anywhere.
--
--   BLOCKED  a `sales` login reading vault rows straight through PostgREST (0 rows, not the list)
--   BLOCKED  a `support` login reading vault rows
--   BLOCKED  a `sales` login inserting a credential (RLS refuses)
--   BLOCKED  a `sales` login updating / deleting an existing credential (0 rows)
--   BLOCKED  a deactivated manager (is_active = false)
--   BLOCKED  anon touching the table at all
--   ALLOWED  our owner reading and adding a credential
--   ALLOWED  our manager reading the credential
--   BLOCKED  an owner of ANOTHER tenant seeing our credential (tenant isolation still holds)

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('71600000-0000-4000-8000-000000000001', 'R716 SELLER', 'r716-a@example.in', '07', 'R71A'),
  ('71600000-0000-4000-8000-000000000002', 'R716 OTHER',  'r716-b@example.in', '07', 'R71B');

insert into auth.users (id, instance_id, aud, role, email) values
  ('71600000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r716-owner@example.in'),
  ('71600000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r716-sales@example.in'),
  ('71600000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r716-support@example.in'),
  ('71600000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r716-manager@example.in'),
  ('71600000-0000-4000-8000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r716-exmgr@example.in'),
  ('71600000-0000-4000-8000-00000000000f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r716-other@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('71600000-0000-4000-8000-00000000000a', '71600000-0000-4000-8000-000000000001', 'r716-owner@example.in',   'owner',   true),
  ('71600000-0000-4000-8000-00000000000b', '71600000-0000-4000-8000-000000000001', 'r716-sales@example.in',   'sales',   true),
  ('71600000-0000-4000-8000-00000000000c', '71600000-0000-4000-8000-000000000001', 'r716-support@example.in', 'support', true),
  ('71600000-0000-4000-8000-00000000000d', '71600000-0000-4000-8000-000000000001', 'r716-manager@example.in', 'manager', true),
  ('71600000-0000-4000-8000-00000000000e', '71600000-0000-4000-8000-000000000001', 'r716-exmgr@example.in',   'manager', false),
  ('71600000-0000-4000-8000-00000000000f', '71600000-0000-4000-8000-000000000002', 'r716-other@example.in',   'owner',   true);

/* One stored credential of our tenant. The ciphertext is a dummy string — never a real secret. */
insert into public.vault_passwords (id, tenant_id, title, category, password_ciphertext, password_fingerprint)
  values ('71600000-0000-4000-8000-0000000000f1', '71600000-0000-4000-8000-000000000001',
          'R716 Google Admin', 'google_admin', 'dummy-ciphertext', 'r716print');

do $$
declare
  v_err boolean; v_n int;
  c_seller constant uuid := '71600000-0000-4000-8000-000000000001';
  c_row    constant uuid := '71600000-0000-4000-8000-0000000000f1';
begin
  set local role authenticated;

  -- ── BLOCKED: sales reads the vault list ─────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','71600000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  select count(*) into v_n from public.vault_passwords where id = c_row;
  if v_n <> 0 then raise exception 'FAIL 1: a sales login can see % vault row(s)', v_n; end if;

  -- ── BLOCKED: sales adds a credential ────────────────────────────────────
  v_err := false;
  begin
    insert into public.vault_passwords (tenant_id, title, category, password_ciphertext)
      values (c_seller, 'R716 sales insert', 'other', 'dummy');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 2: a sales login inserted a vault row'; end if;

  -- ── BLOCKED: sales changes / removes the credential (RLS → 0 rows) ─────
  update public.vault_passwords set title = 'R716 hijack' where id = c_row;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 3: a sales login updated % vault row(s)', v_n; end if;
  delete from public.vault_passwords where id = c_row;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: a sales login deleted % vault row(s)', v_n; end if;

  -- ── BLOCKED: support reads ──────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','71600000-0000-4000-8000-00000000000c','role','authenticated')::text, true);
  select count(*) into v_n from public.vault_passwords where id = c_row;
  if v_n <> 0 then raise exception 'FAIL 5: a support login can see % vault row(s)', v_n; end if;

  -- ── BLOCKED: a deactivated manager ──────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','71600000-0000-4000-8000-00000000000e','role','authenticated')::text, true);
  select count(*) into v_n from public.vault_passwords where id = c_row;
  if v_n <> 0 then raise exception 'FAIL 6: a deactivated manager can see % vault row(s)', v_n; end if;

  -- ── BLOCKED: another tenant's owner ─────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','71600000-0000-4000-8000-00000000000f','role','authenticated')::text, true);
  select count(*) into v_n from public.vault_passwords where id = c_row;
  if v_n <> 0 then raise exception 'FAIL 7: another tenant''s owner can see our vault row'; end if;

  -- ── ALLOWED: our manager reads ──────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','71600000-0000-4000-8000-00000000000d','role','authenticated')::text, true);
  select count(*) into v_n from public.vault_passwords where id = c_row;
  if v_n <> 1 then raise exception 'FAIL 8: our manager cannot see the vault row (% rows)', v_n; end if;

  -- ── ALLOWED: our owner reads, adds and renames ──────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','71600000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  select count(*) into v_n from public.vault_passwords where id = c_row;
  if v_n <> 1 then raise exception 'FAIL 9: our owner cannot see the vault row (% rows)', v_n; end if;
  insert into public.vault_passwords (tenant_id, title, category, password_ciphertext)
    values (c_seller, 'R716 owner insert', 'other', 'dummy');
  update public.vault_passwords set title = 'R716 Google Admin (main)' where id = c_row;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 10: our owner could not update the vault row (% rows)', v_n; end if;

  -- ── BLOCKED: anon ───────────────────────────────────────────────────────
  reset role;
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  v_err := false;
  begin
    perform 1 from public.vault_passwords limit 1;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 11: anon can still read vault_passwords'; end if;
  reset role;

  select count(*) into v_n from public.vault_passwords where tenant_id = c_seller;
  if v_n <> 2 then raise exception 'FAIL 12: expected 2 vault rows for the seller (seed + owner), found %', v_n; end if;

  raise notice 'r716_vault_roles: all 12 checks passed';
end $$;

rollback;
