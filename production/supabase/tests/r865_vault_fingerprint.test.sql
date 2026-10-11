\set ON_ERROR_STOP on
-- Regression test: R-865 (20261011100500_r865_vault_fingerprint_check.sql).
-- The vault create route writes password_fingerprint = HMAC-SHA256 hex (64 chars) with the
-- admin client (service_role). The old check (<= 32) refused every save. Rolled back — safe
-- anywhere; the ciphertexts are dummy strings, the fingerprint a dummy 64-hex value.
--
--   ALLOWED  service_role inserting a row with a 64-char hex fingerprint (failed before R-865)
--   ALLOWED  a NULL fingerprint (no master key → route stores NULL)
--   BLOCKED  a fingerprint longer than 64 chars (65) — garbage is still refused
--   BLOCKED  a much longer value (500 chars)

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('86500000-0000-4000-8000-000000000001', 'R865 SELLER', 'r865@example.in', '07', 'R865');

do $$
declare
  v_err boolean; v_n int;
  c_t constant uuid := '86500000-0000-4000-8000-000000000001';
  c_fp constant text := repeat('a1b2c3d4', 8);  -- 64 hex chars
begin
  set local role service_role;

  -- 1. 64-char fingerprint saves
  begin
    insert into public.vault_passwords (id, tenant_id, title, category, password_ciphertext, password_fingerprint)
      values ('86500000-0000-4000-8000-0000000000f1', c_t, 'R865 Google Admin', 'google_admin', 'r865-dummy-ct', c_fp);
  exception when check_violation then
    raise exception 'FAIL 1: a 64-char fingerprint was refused (%)', sqlerrm;
  end;
  select count(*) into v_n from public.vault_passwords where id = '86500000-0000-4000-8000-0000000000f1' and length(password_fingerprint) = 64;
  if v_n <> 1 then raise exception 'FAIL 1b: the 64-char fingerprint row is not there'; end if;

  -- 2. NULL fingerprint still allowed
  insert into public.vault_passwords (id, tenant_id, title, category, password_ciphertext, password_fingerprint)
    values ('86500000-0000-4000-8000-0000000000f2', c_t, 'R865 no key', 'google_admin', 'r865-dummy-ct', null);

  -- 3. 65 chars refused
  v_err := false;
  begin
    insert into public.vault_passwords (id, tenant_id, title, category, password_ciphertext, password_fingerprint)
      values ('86500000-0000-4000-8000-0000000000f3', c_t, 'R865 too long', 'google_admin', 'r865-dummy-ct', c_fp || 'f');
  exception when check_violation then v_err := true;
  end;
  if not v_err then raise exception 'FAIL 3: a 65-char fingerprint was accepted'; end if;

  -- 4. long garbage refused
  v_err := false;
  begin
    update public.vault_passwords set password_fingerprint = repeat('x', 500)
      where id = '86500000-0000-4000-8000-0000000000f1';
  exception when check_violation then v_err := true;
  end;
  if not v_err then raise exception 'FAIL 4: a 500-char fingerprint was accepted'; end if;

  reset role;
  raise notice 'r865_vault_fingerprint: all 4 checks passed';
end $$;

rollback;
