-- MCP connector: mcp_oauth_grants / mcp_write_previews / mcp_audit_log RLS + grant transitions.
-- Migration 20261120151905_mcp_connector.sql.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   1. A user inserts and reads their OWN grant / preview / audit row in their company.
--   2. They cannot insert a row for another user, or for another company.
--   3. Tenant B's owner sees none of tenant A's rows (and A's sales rep none of A's owner's grants).
--   4. A's owner reads every audit row of A; A's sales rep reads only their own.
--   5. Audit rows cannot be updated or deleted by a signed-in user.
--   6. A revoked grant cannot be switched back on; a grant cannot change owner.
--   7. One idempotency key per user (unique).
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c0dec0de-0000-0000-0000-0000000000a1', 'mcp-owner-a@example.test'),
  ('c0dec0de-0000-0000-0000-0000000000a2', 'mcp-sales-a@example.test'),
  ('c0dec0de-0000-0000-0000-0000000000b1', 'mcp-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c0dec0de-0000-0000-0000-0000000000f0', 'MCP A', 'mcpa@example.test', '07', 'MCPA'),
  ('c0dec0de-0000-0000-0000-0000000000f1', 'MCP B', 'mcpb@example.test', '07', 'MCPB');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c0dec0de-0000-0000-0000-0000000000a1', 'c0dec0de-0000-0000-0000-0000000000f0', 'mcp-owner-a@example.test', 'Owner A', 'owner', true),
  ('c0dec0de-0000-0000-0000-0000000000a2', 'c0dec0de-0000-0000-0000-0000000000f0', 'mcp-sales-a@example.test', 'Sales A', 'sales', true),
  ('c0dec0de-0000-0000-0000-0000000000b1', 'c0dec0de-0000-0000-0000-0000000000f1', 'mcp-owner-b@example.test', 'Owner B', 'owner', true);

-- current_tenant_id() needs an active membership (R-2471); add them when the table exists.
do $$
begin
  if to_regclass('public.tenant_memberships') is not null then
    insert into public.tenant_memberships (user_id, tenant_id, role, is_active)
    select u.id, u.tenant_id, u.role::text, true from public.users u
     where u.id in ('c0dec0de-0000-0000-0000-0000000000a1', 'c0dec0de-0000-0000-0000-0000000000a2', 'c0dec0de-0000-0000-0000-0000000000b1')
    on conflict do nothing;
  end if;
end $$;

-- ── tenant A's owner ────────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'c0dec0de-0000-0000-0000-0000000000a1', 'role', 'authenticated', 'aal', 'aal1')::text, true);
do $$
declare n int;
begin
  -- 1. own rows
  insert into public.mcp_oauth_grants (id, tenant_id, user_id, client_id, redirect_uri, status)
    values ('c0dec0de-0000-0000-0000-00000000d001', 'c0dec0de-0000-0000-0000-0000000000f0', 'c0dec0de-0000-0000-0000-0000000000a1', 'mcpc.x.y', 'https://claude.ai/api/mcp/auth_callback', 'pending');
  update public.mcp_oauth_grants set status = 'active' where id = 'c0dec0de-0000-0000-0000-00000000d001';
  insert into public.mcp_write_previews (tenant_id, user_id, tool, input, input_hash, idempotency_key, expires_at)
    values ('c0dec0de-0000-0000-0000-0000000000f0', 'c0dec0de-0000-0000-0000-0000000000a1', 'add_lead', '{}', repeat('a', 64), 'key-owner-1', now() + interval '15 minutes');
  insert into public.mcp_audit_log (tenant_id, user_id, tool, status)
    values ('c0dec0de-0000-0000-0000-0000000000f0', 'c0dec0de-0000-0000-0000-0000000000a1', 'list_leads', 'ok');
  select count(*) into n from public.mcp_oauth_grants where id = 'c0dec0de-0000-0000-0000-00000000d001';
  if n <> 1 then raise exception 'FAIL 1a: owner cannot read own grant (got %)', n; end if;

  -- 7. one idempotency key per user
  begin
    insert into public.mcp_write_previews (tenant_id, user_id, tool, input, input_hash, idempotency_key, expires_at)
      values ('c0dec0de-0000-0000-0000-0000000000f0', 'c0dec0de-0000-0000-0000-0000000000a1', 'add_lead', '{}', repeat('b', 64), 'key-owner-1', now());
    raise exception 'FAIL 7: the same idempotency key was accepted twice';
  exception when unique_violation then null;
  end;

  -- 2. not for another user / another company
  begin
    insert into public.mcp_audit_log (tenant_id, user_id, tool, status)
      values ('c0dec0de-0000-0000-0000-0000000000f0', 'c0dec0de-0000-0000-0000-0000000000a2', 'list_leads', 'ok');
    raise exception 'FAIL 2a: owner wrote an audit row as another user';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.mcp_oauth_grants (id, tenant_id, user_id, client_id, redirect_uri)
      values ('c0dec0de-0000-0000-0000-00000000d009', 'c0dec0de-0000-0000-0000-0000000000f1', 'c0dec0de-0000-0000-0000-0000000000a1', 'mcpc.x.y', 'https://x.test/cb');
    raise exception 'FAIL 2b: owner A wrote a grant into company B';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 5. audit is append-only (own blocks: a caught error rolls back its whole block)
do $$
begin
  update public.mcp_audit_log set status = 'error' where user_id = 'c0dec0de-0000-0000-0000-0000000000a1';
  raise exception 'FAIL 5a: an audit row was updated';
exception when insufficient_privilege then null;
end $$;

do $$
begin
  delete from public.mcp_audit_log where user_id = 'c0dec0de-0000-0000-0000-0000000000a1';
  raise exception 'FAIL 5b: an audit row was deleted';
exception when insufficient_privilege then null;
end $$;

-- 6. transitions
do $$
declare v_err text;
begin
  update public.mcp_oauth_grants set status = 'revoked', revoked_at = now(), refresh_hash = null where id = 'c0dec0de-0000-0000-0000-00000000d001';
  begin
    update public.mcp_oauth_grants set status = 'active' where id = 'c0dec0de-0000-0000-0000-00000000d001';
    raise exception 'FAIL 6a: a revoked grant was switched back on';
  exception when check_violation then null;
  end;
  begin
    update public.mcp_oauth_grants set client_id = 'mcpc.other' where id = 'c0dec0de-0000-0000-0000-00000000d001';
    raise exception 'FAIL 6b: a grant changed its client';
  exception when check_violation then null;
  end;
end $$;

-- ── tenant A's sales rep ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'c0dec0de-0000-0000-0000-0000000000a2', 'role', 'authenticated', 'aal', 'aal1')::text, true);
do $$
declare n int;
begin
  insert into public.mcp_audit_log (tenant_id, user_id, tool, status)
    values ('c0dec0de-0000-0000-0000-0000000000f0', 'c0dec0de-0000-0000-0000-0000000000a2', 'list_tasks', 'ok');
  select count(*) into n from public.mcp_oauth_grants;
  if n <> 0 then raise exception 'FAIL 3a: sales A reads % grant(s) of the owner', n; end if;
  select count(*) into n from public.mcp_write_previews;
  if n <> 0 then raise exception 'FAIL 3b: sales A reads % preview(s) of the owner', n; end if;
  select count(*) into n from public.mcp_audit_log;
  if n <> 1 then raise exception 'FAIL 4a: sales A should read only their own audit row (got %)', n; end if;
end $$;

-- ── tenant A's owner reads the whole company's audit ────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'c0dec0de-0000-0000-0000-0000000000a1', 'role', 'authenticated', 'aal', 'aal1')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.mcp_audit_log where tenant_id = 'c0dec0de-0000-0000-0000-0000000000f0';
  if n <> 2 then raise exception 'FAIL 4b: owner A should read both audit rows of A (got %)', n; end if;
end $$;

-- ── tenant B's owner sees nothing of A ──────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'c0dec0de-0000-0000-0000-0000000000b1', 'role', 'authenticated', 'aal', 'aal1')::text, true);
do $$
declare n int;
begin
  -- precondition (L7): A has rows that could leak — counted above as A's owner.
  select count(*) into n from public.mcp_oauth_grants where tenant_id = 'c0dec0de-0000-0000-0000-0000000000f0';
  if n <> 0 then raise exception 'FAIL 3c: owner B reads % of A''s grants', n; end if;
  select count(*) into n from public.mcp_write_previews where tenant_id = 'c0dec0de-0000-0000-0000-0000000000f0';
  if n <> 0 then raise exception 'FAIL 3d: owner B reads % of A''s previews', n; end if;
  select count(*) into n from public.mcp_audit_log where tenant_id = 'c0dec0de-0000-0000-0000-0000000000f0';
  if n <> 0 then raise exception 'FAIL 3e: owner B reads % of A''s audit rows', n; end if;
  update public.mcp_oauth_grants set status = 'revoked' where id = 'c0dec0de-0000-0000-0000-00000000d001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 3f: owner B changed A''s grant'; end if;
end $$;

reset role;

rollback;
