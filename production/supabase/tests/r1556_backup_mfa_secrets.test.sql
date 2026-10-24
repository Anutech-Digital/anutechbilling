-- R-1556 + R-1557 attack test — backup RPCs honour R-731 (MFA) / R-722 (inactive), and the
-- downloaded backup carries no secret column.
-- Migration: 20261018173040_r1556_backup_mfa_tenant.sql
--
-- Before the fix every backup RPC took the tenant from `users where id = auth.uid()`:
--   • an MFA owner on a password-only (aal1) session downloaded / reset / restored the company,
--   • a deactivated owner could create / reset / restore,
--   • get_tenant_backup returned employees.pin_hash, vault ciphertext, tokens to the browser.
-- This file FAILS on the old bodies (cloudsql/07 + role_hardening) and PASSES on the new ones.
--
--   1. MFA owner, aal1: get/list/delete/create/restore/reset refused with 28000 and that
--      function's own message; auto_backup_if_stale creates nothing; current_user_has_role false.
--   2. Deactivated owner: same refusals.
--   3. Active manager (not owner): get/restore/reset refused (role gate still there).
--   4. Owner of another company: cannot read this company's snapshot.
--   5. Plain owner: list, get (no secret keys, ordinary data kept), create, reset, restore work;
--      restore brings back the secret column from the server-side copy.
--   6. MFA owner, aal2: get works.
--
-- The `backup` schema is missing on local Supabase (Cloud SQL gets it from cloudsql/06+07):
-- when it is, this file builds the same schema/table/_take/_resettable inside its transaction.
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

-- ── fixture: backup schema (only where missing) ─────────────────────────────────────
do $do$
begin
  if to_regnamespace('backup') is null then
    execute 'create schema backup';
  end if;
  if to_regclass('backup.snapshots') is null then
    execute $t$create table backup.snapshots (
      id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
      label text, table_count int, payload jsonb not null, tenant_id uuid, kind text)$t$;
  end if;
  if to_regprocedure('backup._resettable()') is null then
    execute $fn$
create function backup._resettable() returns table(key text, tbl text, statutory boolean)
 language sql immutable as $f$
  values ('leads','leads',false), ('leads','lead_activities',false), ('quotes','quotes',false),
         ('tasks','tasks',false), ('expenses','expense_claims',false),
         ('invoices','invoices',true), ('attendance','attendance',true)
$f$$fn$;
  end if;
  if to_regprocedure('backup._take(uuid,text,text)') is null then
    execute $fn$
create function backup._take(p_tenant uuid, p_label text, p_kind text) returns jsonb
 language plpgsql security definer set search_path to 'public' as $f$
declare r record; result jsonb := '{}'::jsonb; tbl_json jsonb; n int := 0; v_id uuid;
begin
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into tbl_json from public.tenants t where t.id = p_tenant;
  result := jsonb_build_object('tenants', tbl_json); n := 1;
  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id' and c.table_name not in ('tenant_secrets')
    group by c.table_name order by c.table_name
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t where t.tenant_id = $1', r.table_name)
      into tbl_json using p_tenant;
    result := result || jsonb_build_object(r.table_name, tbl_json);
    n := n + 1;
  end loop;
  insert into backup.snapshots(tenant_id, label, kind, table_count, payload)
  values (p_tenant, coalesce(nullif(btrim(p_label), ''), 'Backup'), p_kind, n, result) returning id into v_id;
  return jsonb_build_object('id', v_id, 'table_count', n, 'bytes', length(result::text), 'created_at', now());
end $f$$fn$;
  end if;
end $do$;

-- ── fixture: two companies, five identities ─────────────────────────────────────────
insert into auth.users (id, email) values
  ('c1556000-0000-0000-0000-0000000000a1', 'r1556-plain@example.test'),
  ('c1556000-0000-0000-0000-0000000000a2', 'r1556-mfa@example.test'),
  ('c1556000-0000-0000-0000-0000000000a3', 'r1556-gone@example.test'),
  ('c1556000-0000-0000-0000-0000000000a4', 'r1556-mgr@example.test'),
  ('c1556000-0000-0000-0000-0000000000b1', 'r1556-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1556000-0000-0000-0000-0000000000f0', 'R1556 A', 'r1556a@example.test', '07', 'R156A'),
  ('c1556000-0000-0000-0000-0000000000f1', 'R1556 B', 'r1556b@example.test', '07', 'R156B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c1556000-0000-0000-0000-0000000000a1', 'c1556000-0000-0000-0000-0000000000f0', 'r1556-plain@example.test', 'R1556 Plain', 'owner',   true),
  ('c1556000-0000-0000-0000-0000000000a2', 'c1556000-0000-0000-0000-0000000000f0', 'r1556-mfa@example.test',   'R1556 Mfa',   'owner',   true),
  ('c1556000-0000-0000-0000-0000000000a3', 'c1556000-0000-0000-0000-0000000000f0', 'r1556-gone@example.test',  'R1556 Gone',  'owner',   false),
  ('c1556000-0000-0000-0000-0000000000a4', 'c1556000-0000-0000-0000-0000000000f0', 'r1556-mgr@example.test',   'R1556 Mgr',   'manager', true),
  ('c1556000-0000-0000-0000-0000000000b1', 'c1556000-0000-0000-0000-0000000000f1', 'r1556-other@example.test', 'R1556 Other', 'owner',   true);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c1556000-0000-0000-0000-0000000000d1', 'c1556000-0000-0000-0000-0000000000a2', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());

insert into public.leads (id, tenant_id, company)
  values ('c1556000-0000-0000-0000-0000000000e1', 'c1556000-0000-0000-0000-0000000000f0', 'R1556 Lead');
insert into public.employees (id, tenant_id, name, pin_hash)
  values ('c1556000-0000-0000-0000-0000000000c1', 'c1556000-0000-0000-0000-0000000000f0', 'R1556 Staff', 'R1556-SECRET-PIN-HASH');

-- snapshot S1 (real _take) + S2 (hand-made, every secret column present)
select set_config('r1556.s1', (backup._take('c1556000-0000-0000-0000-0000000000f0', 'R1556 seed', 'manual')->>'id'), false);
with s as (
  insert into backup.snapshots (tenant_id, label, kind, table_count, payload)
  values ('c1556000-0000-0000-0000-0000000000f0', 'R1556 secrets', 'manual', 6, jsonb_build_object(
    'attendance_settings', jsonb_build_array(jsonb_build_object('tenant_id', 'x', 'presence_secret', 'R1556-S', 'ingest_key', 'R1556-S', 'radius_m', 100)),
    'employees',           jsonb_build_array(jsonb_build_object('name', 'Keep Me', 'pin_hash', 'R1556-S')),
    'ad_accounts',         jsonb_build_array(jsonb_build_object('name', 'Ads', 'access_token', 'R1556-S')),
    'user_google_tokens',  jsonb_build_array(jsonb_build_object('user_id', 'u', 'access_token', 'R1556-S', 'refresh_token', 'R1556-S', 'sync_token', 'R1556-S')),
    'email_verifications', jsonb_build_array(jsonb_build_object('email', 'e', 'token_hash', 'R1556-S')),
    'vault_passwords',     jsonb_build_array(jsonb_build_object('label', 'Console', 'username_ciphertext', 'R1556-S', 'password_ciphertext', 'R1556-S', 'notes_ciphertext', 'R1556-S')),
    'leads',               jsonb_build_array(jsonb_build_object('company', 'Plain Lead'))))
  returning id)
select set_config('r1556.s2', (select id::text from s), false);

set local role authenticated;

-- ── 1–4. refusals ───────────────────────────────────────────────────────────────────
do $$
declare
  v_s1   uuid := current_setting('r1556.s1')::uuid;
  v_who  record;
  v_call text;
  v_msg  text;
  v_st   text;
  v_j    jsonb;
  v_n    int;
  /* function call → a word from ITS OWN refusal message (proves its own guard fired) */
  v_calls constant text[][] := array[
    array['select public.get_tenant_backup(%L::uuid)',                                 'download'],
    array['select count(*) from public.list_tenant_backups()',                          'Backups need'],
    array['select public.delete_tenant_backup(%L::uuid)',                               'Deleting a backup'],
    array['select public.create_tenant_backup(''R1556 sneak'')',                        'Taking a backup'],
    array['select public.restore_tenant_backup(%L::uuid)',                              'Restoring a backup'],
    array['select public.reset_tenant_selected_tables(array[''leads''], ''R1556'', false)', 'Resetting data']
  ];
  i int;
begin
  for v_who in
    select * from (values
      ('c1556000-0000-0000-0000-0000000000a2'::uuid, 'aal1', 'MFA owner on aal1'),
      ('c1556000-0000-0000-0000-0000000000a3'::uuid, 'aal1', 'deactivated owner')) as w(uid, aal, label)
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_who.uid, 'role', 'authenticated', 'aal', v_who.aal)::text, true);

    for i in 1 .. array_length(v_calls, 1) loop
      v_call := format(v_calls[i][1], v_s1);
      begin
        execute v_call;
        raise exception 'FAIL 1/2: % ran "%" — backup RPC ignores MFA / is_active', v_who.label, v_call;
      exception
        when others then
          get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text;
          if v_msg like 'FAIL%' then raise; end if;
          if v_st <> '28000' or position(v_calls[i][2] in v_msg) = 0 then
            raise exception 'FAIL 1/2: % on "%" refused by the wrong guard: % %', v_who.label, v_call, v_st, v_msg;
          end if;
      end;
    end loop;

    select public.auto_backup_if_stale() into v_j;
    if (v_j->>'created')::boolean then
      raise exception 'FAIL 1/2: % got an auto backup', v_who.label;
    end if;
    if public.current_user_has_role('owner') then
      raise exception 'FAIL 1/2: current_user_has_role(owner) true for %', v_who.label;
    end if;
  end loop;

  -- nothing above touched the data
  perform set_config('request.jwt.claims', '', true);
  reset role;
  select count(*) into v_n from public.leads where id = 'c1556000-0000-0000-0000-0000000000e1';
  if v_n <> 1 then raise exception 'FAIL 1/2: refused reset still deleted the lead'; end if;
  select count(*) into v_n from backup.snapshots where id = v_s1;
  if v_n <> 1 then raise exception 'FAIL 1/2: refused delete still removed the snapshot'; end if;
  select count(*) into v_n from backup.snapshots where label = 'R1556 sneak';
  if v_n <> 0 then raise exception 'FAIL 1/2: refused create still took a snapshot'; end if;
  set local role authenticated;

  -- ── 3. manager: role gate ─────────────────────────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1556000-0000-0000-0000-0000000000a4', 'role', 'authenticated', 'aal', 'aal1')::text, true);
  foreach v_call in array array[
      format('select public.get_tenant_backup(%L::uuid)', v_s1),
      format('select public.restore_tenant_backup(%L::uuid)', v_s1),
      'select public.reset_tenant_selected_tables(array[''leads''], ''R1556'', false)'] loop
    begin
      execute v_call;
      raise exception 'FAIL 3: manager ran "%"', v_call;
    exception
      when insufficient_privilege then null;
      when others then
        get stacked diagnostics v_msg = message_text;
        if v_msg like 'FAIL%' then raise; end if;
        raise exception 'FAIL 3: manager on "%" refused by the wrong guard: %', v_call, v_msg;
    end;
  end loop;

  -- ── 4. another company's owner ────────────────────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1556000-0000-0000-0000-0000000000b1', 'role', 'authenticated', 'aal', 'aal1')::text, true);
  if public.get_tenant_backup(v_s1) is not null then
    raise exception 'FAIL 4: owner of company B read company A''s backup';
  end if;
  begin
    perform public.restore_tenant_backup(v_s1);
    raise exception 'FAIL 4: owner of company B restored company A''s backup';
  exception when raise_exception then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'Restore point not found' then raise; end if;
  end;
end $$;

-- ── 5. plain owner: everything works, download has no secrets ───────────────────────
do $$
declare
  v_s1 uuid := current_setting('r1556.s1')::uuid;
  v_s2 uuid := current_setting('r1556.s2')::uuid;
  v_j  jsonb;
  v_n  int;
  v_k  text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1556000-0000-0000-0000-0000000000a1', 'role', 'authenticated', 'aal', 'aal1')::text, true);

  select count(*) into v_n from public.list_tenant_backups();
  if v_n < 2 then raise exception 'FAIL 5: owner lists % backup(s)', v_n; end if;

  -- real snapshot: the employee is there, the PIN hash is not
  v_j := public.get_tenant_backup(v_s1);
  if v_j is null then raise exception 'FAIL 5: owner cannot download own backup'; end if;
  if not (v_j->'employees' @> '[{"name":"R1556 Staff"}]') then
    raise exception 'FAIL 5: download lost the ordinary employee data';
  end if;
  if position('R1556-SECRET-PIN-HASH' in v_j::text) > 0 then
    raise exception 'FAIL 5 (R-1557): downloaded backup carries employees.pin_hash';
  end if;
  if not (v_j->'leads' @> '[{"company":"R1556 Lead"}]') then
    raise exception 'FAIL 5: download lost the lead';
  end if;

  -- hand-made snapshot: every secret column of cloudsql/09 is gone, the rest kept
  v_j := public.get_tenant_backup(v_s2);
  if position('R1556-S' in v_j::text) > 0 then
    raise exception 'FAIL 5 (R-1557): secret value in download: %', v_j;
  end if;
  foreach v_k in array array['attendance_settings.presence_secret','attendance_settings.ingest_key',
      'employees.pin_hash','ad_accounts.access_token','user_google_tokens.access_token',
      'user_google_tokens.refresh_token','user_google_tokens.sync_token','email_verifications.token_hash',
      'vault_passwords.username_ciphertext','vault_passwords.password_ciphertext','vault_passwords.notes_ciphertext'] loop
    if (v_j->split_part(v_k, '.', 1)->0) ? split_part(v_k, '.', 2) then
      raise exception 'FAIL 5 (R-1557): download has key %', v_k;
    end if;
  end loop;
  if v_j->'employees'->0->>'name' <> 'Keep Me' or v_j->'vault_passwords'->0->>'label' <> 'Console'
     or (v_j->'attendance_settings'->0->>'radius_m')::int <> 100 or v_j->'leads'->0->>'company' <> 'Plain Lead' then
    raise exception 'FAIL 5: stripping removed ordinary columns: %', v_j;
  end if;

  -- create
  v_j := public.create_tenant_backup('R1556 manual');
  if v_j->>'id' is null then raise exception 'FAIL 5: owner cannot take a backup'; end if;

  -- reset leads, then restore S1: the lead AND the PIN hash come back (server-side copy)
  v_j := public.reset_tenant_selected_tables(array['leads'], 'R1556', false);
  if (v_j->'deleted'->>'leads')::int < 1 then raise exception 'FAIL 5: reset deleted no lead: %', v_j; end if;
  select count(*) into v_n from public.leads where id = 'c1556000-0000-0000-0000-0000000000e1';
  if v_n <> 0 then raise exception 'FAIL 5: lead still there after reset'; end if;

  update public.employees set pin_hash = null where id = 'c1556000-0000-0000-0000-0000000000c1';
  v_j := public.restore_tenant_backup(v_s1);
  if (v_j->>'restored_tables')::int < 1 then raise exception 'FAIL 5: restore restored nothing'; end if;
  select count(*) into v_n from public.leads where id = 'c1556000-0000-0000-0000-0000000000e1';
  if v_n <> 1 then raise exception 'FAIL 5: restore did not bring the lead back'; end if;

  -- delete
  perform public.delete_tenant_backup(v_s2);
  select count(*) into v_n from public.list_tenant_backups() b where b.id = v_s2;
  if v_n <> 0 then raise exception 'FAIL 5: owner cannot delete a backup'; end if;

  -- ── 6. MFA owner after the second step ──────────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1556000-0000-0000-0000-0000000000a2', 'role', 'authenticated', 'aal', 'aal2')::text, true);
  if public.get_tenant_backup(v_s1) is null then raise exception 'FAIL 6: MFA owner on aal2 cannot download'; end if;
  if not public.current_user_has_role('owner') then raise exception 'FAIL 6: MFA owner on aal2 lost the owner role'; end if;
  perform set_config('request.jwt.claims', '', true);
end $$;

reset role;

do $$
declare v_pin text;
begin
  select pin_hash into v_pin from public.employees where id = 'c1556000-0000-0000-0000-0000000000c1';
  if v_pin is distinct from 'R1556-SECRET-PIN-HASH' then
    raise exception 'FAIL 5: restore did not bring employees.pin_hash back from the server copy (got %)', v_pin;
  end if;
end $$;

do $$ begin raise notice 'R-1556/R-1557 PASS: backup RPCs need an active, fully signed-in owner; download has no secret columns'; end $$;

rollback;
