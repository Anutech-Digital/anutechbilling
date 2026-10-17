-- R-731 attack test — two-step sign-in must hold on the DATA path, not only /api.
-- Migrations: 20261016103000_r731_session_mfa_ok.sql + 20261016103100_r731_mfa_tenant.sql.
--
-- Before the fix no policy looked at the session's aal: an MFA-enrolled user with a
-- password-only token (aal1) read every tenant row. This file FAILS on the old
-- current_tenant_id() (case 2) and PASSES on the new one.
--
--   1. User WITHOUT a factor, aal1 token: tenant found, sees the lead.          (no over-block)
--   2. User WITH a verified factor, aal1 token: current_tenant_id() IS NULL, 0 leads,
--      INSERT refused.                                                           ← the hole
--   3. The same user, aal2 token: tenant found, sees the lead, can write.
--   4. Gateway shape (app.user_id / app.aal, no JWT): session_mfa_ok() is false for '' and
--      'aal1', true for 'aal2'; true for the non-MFA user whatever the level.
--   5. service_role still reads the rows (trusted, R-454).
--
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c7310000-0000-0000-0000-0000000000a1', 'r731-plain@example.test'),
  ('c7310000-0000-0000-0000-0000000000a2', 'r731-mfa@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c7310000-0000-0000-0000-0000000000f0', 'R731 T', 'r731@example.test', '07', 'R731');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c7310000-0000-0000-0000-0000000000a1', 'c7310000-0000-0000-0000-0000000000f0', 'r731-plain@example.test', 'R731 Plain', 'owner',   true),
  ('c7310000-0000-0000-0000-0000000000a2', 'c7310000-0000-0000-0000-0000000000f0', 'r731-mfa@example.test',   'R731 Mfa',   'manager', true);

insert into public.leads (id, tenant_id, company)
  values ('c7310000-0000-0000-0000-0000000000e1', 'c7310000-0000-0000-0000-0000000000f0', 'R731 Lead');

-- the second user has finished enrolling an authenticator
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c7310000-0000-0000-0000-0000000000d1', 'c7310000-0000-0000-0000-0000000000a2', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());

set local role authenticated;

do $$
declare
  v_plain uuid := 'c7310000-0000-0000-0000-0000000000a1';
  v_mfa   uuid := 'c7310000-0000-0000-0000-0000000000a2';
  v_t     uuid := 'c7310000-0000-0000-0000-0000000000f0';
  v_n int;
  v_tid uuid;
begin
  -- ── 1. no factor, aal1 ───────────────────────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_plain, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select public.current_tenant_id() into v_tid;
  if v_tid is distinct from v_t then
    raise exception 'FAIL 1: non-MFA user lost their tenant (got %)', v_tid;
  end if;
  select count(*) into v_n from public.leads where id = 'c7310000-0000-0000-0000-0000000000e1';
  if v_n <> 1 then raise exception 'FAIL 1: non-MFA user cannot see the lead'; end if;

  -- ── 2. verified factor, aal1 — the hole ──────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_mfa, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select public.current_tenant_id() into v_tid;
  if v_tid is not null then
    raise exception 'FAIL 2: half-signed-in MFA user still has a tenant (%) — data path ignores aal', v_tid;
  end if;
  select count(*) into v_n from public.leads where tenant_id = v_t;
  if v_n <> 0 then raise exception 'FAIL 2: half-signed-in MFA user reads % lead(s)', v_n; end if;
  begin
    insert into public.leads (id, tenant_id, company)
      values ('c7310000-0000-0000-0000-0000000000e2', v_t, 'R731 Sneak');
    raise exception 'FAIL 2: half-signed-in MFA user inserted a lead';
  exception
    when insufficient_privilege then null;       -- RLS refused — correct
    when raise_exception then raise;
    when others then null;                       -- a definer guard refused — also fine
  end;

  -- ── 3. verified factor, aal2 ─────────────────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_mfa, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  select public.current_tenant_id() into v_tid;
  if v_tid is distinct from v_t then
    raise exception 'FAIL 3: MFA user with aal2 has no tenant (got %)', v_tid;
  end if;
  select count(*) into v_n from public.leads where id = 'c7310000-0000-0000-0000-0000000000e1';
  if v_n <> 1 then raise exception 'FAIL 3: MFA user with aal2 cannot see the lead'; end if;
  update public.leads set company = 'R731 Lead 2' where id = 'c7310000-0000-0000-0000-0000000000e1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 3: MFA user with aal2 cannot write'; end if;

  -- ── 4. gateway shape: app.user_id + app.aal, no JWT ──────────────────────
  perform set_config('request.jwt.claims', '', true);
  perform set_config('app.user_id', v_mfa::text, true);
  perform set_config('app.aal', '', true);
  if public.session_mfa_ok() then raise exception 'FAIL 4: unknown aal passed for an MFA user'; end if;
  perform set_config('app.aal', 'aal1', true);
  if public.session_mfa_ok() then raise exception 'FAIL 4: aal1 passed for an MFA user'; end if;
  perform set_config('app.aal', 'aal2', true);
  if not public.session_mfa_ok() then raise exception 'FAIL 4: aal2 refused for an MFA user'; end if;
  perform set_config('app.user_id', v_plain::text, true);
  perform set_config('app.aal', '', true);
  if not public.session_mfa_ok() then raise exception 'FAIL 4: non-MFA user refused on the gateway path'; end if;
  perform set_config('app.user_id', '', true);
end $$;

reset role;

-- ── 5. service_role still trusted ───────────────────────────────────────────
set local role service_role;
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  select count(*) into v_n from public.leads where id = 'c7310000-0000-0000-0000-0000000000e1';
  if v_n <> 1 then raise exception 'FAIL 5: service_role cannot read the lead'; end if;
end $$;
reset role;

do $$ begin raise notice 'R-731 PASS: MFA second step enforced on the data path'; end $$;

rollback;
