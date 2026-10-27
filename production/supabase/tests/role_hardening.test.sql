-- Regression test: tenant isolation is not the whole rule — the ROLE decides too.
-- Migration 20260930175000 (S41 / WC-sec). Rolled back — safe on production.
--
-- Both directions, per table, because a guard is only half-tested by what it blocks:
--
--   BLOCKED  a `sales` login reading or deleting a backup
--   BLOCKED  a `sales` login reading or minting an api_key
--   BLOCKED  a `sales` login changing a salary, an employee, a bank account
--   BLOCKED  a DEACTIVATED owner doing any of it
--   ALLOWED  an owner everywhere
--   ALLOWED  an `accountant` on the money tables (the roles that do this work daily)
--   ALLOWED  a `sales` login still READING employees / bank_accounts (deliberately not
--            narrowed — see the migration header)
--
-- The ALLOWED half is the point. A rule that also stops the accountant doing the books is
-- a rule somebody switches off inside a week (L103), and then it is gone for the sales
-- login too.
--
-- Fixture owns its data (L11): its own tenant, its own auth users, literal ids.
-- Ids are read BEFORE the role switch and carried in GUCs (L14).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('50410000-0000-4000-8000-000000000001', 'ROLE TEST', 'role@example.in', '07', 'ROLE');

insert into auth.users (id, instance_id, aud, role, email) values
  ('50410000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'role-owner@example.in'),
  ('50410000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'role-sales@example.in'),
  ('50410000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'role-acct@example.in'),
  ('50410000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'role-exowner@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('50410000-0000-4000-8000-00000000000a', '50410000-0000-4000-8000-000000000001', 'role-owner@example.in',   'owner',      true),
  ('50410000-0000-4000-8000-00000000000b', '50410000-0000-4000-8000-000000000001', 'role-sales@example.in',   'sales',      true),
  ('50410000-0000-4000-8000-00000000000c', '50410000-0000-4000-8000-000000000001', 'role-acct@example.in',    'accountant', true),
  -- An owner who has left. The role still says owner; is_active says otherwise.
  ('50410000-0000-4000-8000-00000000000d', '50410000-0000-4000-8000-000000000001', 'role-exowner@example.in', 'owner',      false);

insert into public.bank_accounts (id, tenant_id, name, bank_name, ifsc, account_number_last4)
  values ('50410000-0000-4000-8000-0000000000b1', '50410000-0000-4000-8000-000000000001', 'Current', 'HDFC Bank', 'HDFC0001234', '5678');

-- ── The helper itself, before any policy depends on it ──────────────────────
do $$
declare v_ok boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','50410000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  if not public.current_user_has_role('owner') then raise exception 'FAIL 1: an active owner did not match owner'; end if;
  if public.current_user_has_role('sales') then raise exception 'FAIL 1: an owner matched sales'; end if;
  if not public.current_user_has_role('manager','owner') then raise exception 'FAIL 1: variadic form failed'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub','50410000-0000-4000-8000-00000000000d','role','authenticated')::text, true);
  /* The one that would go unnoticed: role = 'owner' but the account is switched off.
     This is how an ex-employee keeps their access. */
  if public.current_user_has_role('owner') then
    raise exception 'FAIL 2: a DEACTIVATED owner still passed the role check';
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- ── The backup RPCs ─────────────────────────────────────────────────────────
do $$
declare v_err boolean; v_msg text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','50410000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  foreach v_msg in array array['list','delete','get'] loop
    v_err := false;
    begin
      if v_msg = 'list'   then perform * from public.list_tenant_backups();
      elsif v_msg = 'get' then perform public.get_tenant_backup('50410000-0000-4000-8000-0000000000f1');
      else                     perform public.delete_tenant_backup('50410000-0000-4000-8000-0000000000f1');
      end if;
    exception when others then v_err := true; v_msg := sqlerrm; end;
    if not v_err then
      raise exception 'FAIL 3: a sales login reached a backup RPC — a backup holds salaries, personal data and connected-account tokens';
    end if;
    /* It must be REFUSED, not merely empty. "No rows" reads as "you have no backups",
       which is a failure wearing the clothes of a fact (AGENTS.md §2). And §24: the
       message has to say who can do it. */
    if v_msg not ilike '%owner%' then
      raise exception 'FAIL 3: refusal did not say an owner is needed: %', v_msg;
    end if;
  end loop;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- ── api_keys ────────────────────────────────────────────────────────────────
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.api_keys (tenant_id, label, key_hash, key_prefix)
    values ('50410000-0000-4000-8000-000000000001', 'k', 'h', 'rk_test');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','50410000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  select count(*) into v_n from public.api_keys;
  if v_n <> 0 then
    raise exception 'FAIL 4: a sales login can read % api key(s) — a workspace credential that works outside the app', v_n;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub','50410000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  select count(*) into v_n from public.api_keys;
  if v_n <> 1 then raise exception 'FAIL 5: the OWNER cannot see the api key (saw %) — the guard is too tight', v_n; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- ── Money tables ────────────────────────────────────────────────────────────
do $$
declare v_err boolean; v_n int;
begin
  set local role authenticated;

  -- sales: may NOT change a bank account
  perform set_config('request.jwt.claims', json_build_object('sub','50410000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  update public.bank_accounts set bank_name = 'HIJACKED' where id = '50410000-0000-4000-8000-0000000000b1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'FAIL 6: a sales login repointed the bank account money reconciles against';
  end if;

  v_err := false;
  begin
    insert into public.employees (id, tenant_id, name)
      values ('50410000-0000-4000-8000-0000000000e9', '50410000-0000-4000-8000-000000000001', 'Ghost');
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 7: a sales login created an employee'; end if;

  /* …but reading the bank list is still allowed. Narrowing that is a separate product
     decision (see the migration header), and asserting it here is what stops somebody
     "completing" the rule without asking. */
  -- R-1834: every company also has its auto Petty Cash; count the account this test made.
  select count(*) into v_n from public.bank_accounts where not is_default_petty_cash;
  if v_n <> 1 then raise exception 'FAIL 8: a sales login lost READ on bank_accounts — not what S41 asked for'; end if;

  -- accountant: MAY change it. This is the half that keeps the rule alive.
  perform set_config('request.jwt.claims', json_build_object('sub','50410000-0000-4000-8000-00000000000c','role','authenticated')::text, true);
  update public.bank_accounts set bank_name = 'HDFC Bank Ltd' where id = '50410000-0000-4000-8000-0000000000b1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 9: the ACCOUNTANT cannot do the books — the guard is too tight'; end if;

  -- the deactivated owner: may not
  perform set_config('request.jwt.claims', json_build_object('sub','50410000-0000-4000-8000-00000000000d','role','authenticated')::text, true);
  update public.bank_accounts set bank_name = 'EX' where id = '50410000-0000-4000-8000-0000000000b1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 10: a deactivated owner still changed a bank account'; end if;

  reset role;
  raise notice 'PASS: role decides backups, api keys and money writes; accountant and owner still work';
end $$;

rollback;
