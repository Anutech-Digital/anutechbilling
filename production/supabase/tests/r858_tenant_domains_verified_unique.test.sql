\set ON_ERROR_STOP on
-- Regression test: an UNVERIFIED domain claim can no longer block the real company.
-- Migration 20261023173000_r858_tenant_domains_verified_unique.sql (R-858). Rolled back — safe anywhere.
--
--   ALLOWED  tenant A claims x.com unverified, tenant B claims x.com unverified (both rows exist)
--   BLOCKED  the same tenant claiming the same domain twice (one claim per company)
--   ALLOWED  service_role verifies A's claim
--   BLOCKED  service_role verifies B's claim while A's is verified (only one verified owner, ever)
--   ALLOWED  after A's verification, a third unverified claim still inserts (it routes nobody)
--   ALLOWED  an owner (authenticated) adds an unverified claim for a domain another company already
--            claimed unverified — the case that used to fail with 23505
--   CATALOG  tenant_domains_domain_unique is partial (verified rows only)

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('85800000-0000-4000-8000-000000000001', 'R858 REAL CO',   'r858-a@example.in', '07', 'R85A'),
  ('85800000-0000-4000-8000-000000000002', 'R858 SQUATTER',  'r858-b@example.in', '07', 'R85B'),
  ('85800000-0000-4000-8000-000000000003', 'R858 THIRD',     'r858-c@example.in', '07', 'R85C');

insert into auth.users (id, instance_id, aud, role, email) values
  ('85800000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r858-owner-c@example.in');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('85800000-0000-4000-8000-00000000000c', '85800000-0000-4000-8000-000000000003', 'r858-owner-c@example.in', 'owner', true);

do $$
declare
  v_err boolean; v_n int;
  c_a constant uuid := '85800000-0000-4000-8000-000000000001';
  c_b constant uuid := '85800000-0000-4000-8000-000000000002';
  c_c constant uuid := '85800000-0000-4000-8000-000000000003';
begin
  -- ── ALLOWED 1: squatter claims first, real company claims after ─────────
  insert into public.tenant_domains (id, tenant_id, domain) values ('85800000-0000-4000-8000-0000000000d2', c_b, 'r858-x.example');
  begin
    insert into public.tenant_domains (id, tenant_id, domain) values ('85800000-0000-4000-8000-0000000000d1', c_a, 'r858-x.example');
  exception when unique_violation then
    raise exception 'FAIL 1: an unverified claim by another company blocked the real company''s claim';
  end;
  select count(*) into v_n from public.tenant_domains where domain = 'r858-x.example';
  if v_n <> 2 then raise exception 'FAIL 1b: expected 2 unverified claims, got %', v_n; end if;

  -- ── BLOCKED 2: the same company claiming the same domain twice ──────────
  v_err := false;
  begin
    insert into public.tenant_domains (tenant_id, domain) values (c_a, 'r858-x.example');
  exception when unique_violation then v_err := true; end;
  if not v_err then raise exception 'FAIL 2: one company could claim the same domain twice'; end if;

  -- ── ALLOWED 3: the platform verifies the real company ───────────────────
  update public.tenant_domains set verified_at = now() where id = '85800000-0000-4000-8000-0000000000d1';

  -- ── BLOCKED 4: a second verified owner of the same domain ───────────────
  v_err := false;
  begin
    update public.tenant_domains set verified_at = now() where id = '85800000-0000-4000-8000-0000000000d2';
  exception when unique_violation then v_err := true; end;
  if not v_err then raise exception 'FAIL 4: two companies are verified for the same domain'; end if;

  -- ── BLOCKED 4b: case does not dodge it (the index is on lower(domain)) ──
  v_err := false;
  begin
    insert into public.tenant_domains (tenant_id, domain, verified_at) values (c_c, 'r858-x.example', now());
  exception when unique_violation then v_err := true; end;
  if not v_err then raise exception 'FAIL 4b: a verified duplicate was inserted directly'; end if;

  -- ── ALLOWED 5: an owner (request role) adds an unverified claim ─────────
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','85800000-0000-4000-8000-00000000000c','role','authenticated')::text, true);
  begin
    insert into public.tenant_domains (tenant_id, domain) values (c_c, 'r858-x.example');
  exception when unique_violation then
    raise exception 'FAIL 5: an owner could not add an unverified claim because another company holds one';
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select count(*) into v_n from public.tenant_domains where domain = 'r858-x.example' and verified_at is not null;
  if v_n <> 1 then raise exception 'FAIL 6: expected exactly 1 verified owner, got %', v_n; end if;

  -- ── CATALOG: the unique index covers verified rows only ──────────────────
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'tenant_domains'
                    and indexname = 'tenant_domains_domain_unique'
                    and indexdef ilike '%unique%' and indexdef ilike '%where (verified_at is not null)%') then
    raise exception 'FAIL 0: tenant_domains_domain_unique is not a partial unique index on verified rows';
  end if;

  raise notice 'R-858 tenant_domains verified-only unique: ALL PASS';
end $$;

rollback;
