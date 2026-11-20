-- deploy-peek: to_regclass('public.mcp_audit_log') is not null and to_regclass('public.mcp_oauth_grants') is not null and to_regclass('public.mcp_write_previews') is not null and exists(select 1 from pg_trigger where tgname = 'trg_mcp_oauth_grants_transition')
--
-- MCP connector (docs/MCP.md) — Claude as a custom connector for ResellerOS.
--
-- Why: the owner manages the business from Claude chat. Every MCP database call runs as the
-- calling user (a JWT minted for them), so these tables are written by signed-in users under RLS —
-- never by the service role from MCP code.
--
-- What:
--   1. public.mcp_oauth_grants   — one row per connection (OAuth grant). Code / refresh secrets are
--      stored only as sha256 hashes. A user reads and writes ONLY their own rows in their current
--      company. A trigger allows only pending → active → revoked (revoked is final).
--   2. public.mcp_write_previews — the preview half of every write tool (two-step confirm), with the
--      caller's idempotency key (unique per user). Own rows only.
--   3. public.mcp_audit_log      — one row per tool call: tool, input, status, before/after for
--      writes. Append-only for signed-in users (insert own; no update / delete grant). Read: own
--      rows, or every row of the company for owner / manager.
--
-- If wrong: the connector refuses to connect (grants), or writes fail closed (previews), or tool
-- calls still answer but leave no audit row (logged as "[mcp] audit insert failed").
-- Check: supabase/tests/mcp_connector_rls.test.sql (rollback-only).
-- Additive and idempotent. No existing object is changed. No data is changed.

begin;

-- ── 1. grants ───────────────────────────────────────────────────────────────────────────
create table if not exists public.mcp_oauth_grants (
  id                  uuid        primary key,
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  user_id             uuid        not null references public.users(id) on delete cascade,
  client_id           text        not null,
  client_name         text        not null default 'MCP client',
  redirect_uri        text        not null,
  scope               text        not null default 'mcp:read',
  aal                 text        not null default 'aal1',
  status              text        not null default 'pending',
  code_hash           text,
  code_challenge      text,
  code_expires_at     timestamptz,
  refresh_hash        text,
  refresh_expires_at  timestamptz,
  created_at          timestamptz not null default now(),
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  constraint mcp_oauth_grants_status_check check (status in ('pending', 'active', 'revoked')),
  constraint mcp_oauth_grants_aal_check    check (aal in ('aal1', 'aal2')),
  constraint mcp_oauth_grants_scope_check  check (scope in ('mcp:read', 'mcp:read mcp:write')),
  constraint mcp_oauth_grants_client_check check (char_length(client_id) <= 2000 and char_length(client_name) <= 100 and char_length(redirect_uri) <= 500),
  constraint mcp_oauth_grants_hash_check   check ((code_hash is null or code_hash ~ '^[0-9a-f]{64}$') and (refresh_hash is null or refresh_hash ~ '^[0-9a-f]{64}$'))
);
comment on table public.mcp_oauth_grants is
  'MCP connector: one row per Claude connection (OAuth grant). Secrets only as sha256. Own rows only (RLS). Status pending → active → revoked; revoked is final (trg_mcp_oauth_grants_transition).';
create index if not exists mcp_oauth_grants_user_idx on public.mcp_oauth_grants (tenant_id, user_id, created_at desc);

create or replace function public.tg_mcp_oauth_grants_transition()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  /* MCP connector: a revoked connection never comes back, and the owner of a row never changes. */
  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.user_id <> old.user_id or new.client_id <> old.client_id then
    raise exception 'A Claude connection cannot be moved to another person or client. Disconnect it and connect again.'
      using errcode = 'check_violation';
  end if;
  if old.status = 'revoked' and new.status <> 'revoked' then
    raise exception 'This Claude connection was disconnected and cannot be switched back on. Add the connector again in Claude.'
      using errcode = 'check_violation';
  end if;
  if old.status = 'active' and new.status = 'pending' then
    raise exception 'An active Claude connection cannot go back to pending.' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_mcp_oauth_grants_transition on public.mcp_oauth_grants;
create trigger trg_mcp_oauth_grants_transition
  before update on public.mcp_oauth_grants
  for each row execute function public.tg_mcp_oauth_grants_transition();

alter table public.mcp_oauth_grants enable row level security;
drop policy if exists mcp_grants_own on public.mcp_oauth_grants;
create policy mcp_grants_own on public.mcp_oauth_grants for all to authenticated
  using (tenant_id = (select public.current_tenant_id()) and user_id = (select public.current_user_id()))
  with check (tenant_id = (select public.current_tenant_id()) and user_id = (select public.current_user_id()));
drop policy if exists gp09_personal_wall on public.mcp_oauth_grants;
create policy gp09_personal_wall on public.mcp_oauth_grants as restrictive for all to authenticated
  using (not (select public.is_personal_session())) with check (not (select public.is_personal_session()));
drop policy if exists zzz_service_role_all on public.mcp_oauth_grants;
create policy zzz_service_role_all on public.mcp_oauth_grants as permissive for all to service_role using (true) with check (true);
revoke all on public.mcp_oauth_grants from public, anon, authenticated;
grant select, insert, update on public.mcp_oauth_grants to authenticated;
grant all on public.mcp_oauth_grants to service_role;

-- ── 2. write previews ───────────────────────────────────────────────────────────────────
create table if not exists public.mcp_write_previews (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  user_id          uuid        not null references public.users(id) on delete cascade,
  tool             text        not null,
  input            jsonb       not null,
  input_hash       text        not null,
  before_values    jsonb,
  idempotency_key  text        not null,
  status           text        not null default 'pending',
  result           jsonb,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  confirmed_at     timestamptz,
  constraint mcp_write_previews_status_check check (status in ('pending', 'applying', 'done', 'failed')),
  constraint mcp_write_previews_key_check    check (char_length(idempotency_key) between 8 and 100),
  constraint mcp_write_previews_tool_check   check (tool ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint mcp_write_previews_hash_check   check (input_hash ~ '^[0-9a-f]{64}$')
);
comment on table public.mcp_write_previews is
  'MCP connector: the preview half of each write tool (preview → confirm=true). One idempotency key per user. Own rows only (RLS).';
create unique index if not exists mcp_write_previews_key_uniq on public.mcp_write_previews (tenant_id, user_id, idempotency_key);

alter table public.mcp_write_previews enable row level security;
drop policy if exists mcp_previews_own on public.mcp_write_previews;
create policy mcp_previews_own on public.mcp_write_previews for all to authenticated
  using (tenant_id = (select public.current_tenant_id()) and user_id = (select public.current_user_id()))
  with check (tenant_id = (select public.current_tenant_id()) and user_id = (select public.current_user_id()));
drop policy if exists gp09_personal_wall on public.mcp_write_previews;
create policy gp09_personal_wall on public.mcp_write_previews as restrictive for all to authenticated
  using (not (select public.is_personal_session())) with check (not (select public.is_personal_session()));
drop policy if exists zzz_service_role_all on public.mcp_write_previews;
create policy zzz_service_role_all on public.mcp_write_previews as permissive for all to service_role using (true) with check (true);
revoke all on public.mcp_write_previews from public, anon, authenticated;
grant select, insert, update on public.mcp_write_previews to authenticated;
grant all on public.mcp_write_previews to service_role;

-- ── 3. audit log ────────────────────────────────────────────────────────────────────────
create table if not exists public.mcp_audit_log (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references public.tenants(id) on delete cascade,
  user_id        uuid        not null references public.users(id) on delete cascade,
  grant_id       uuid,
  client_name    text,
  tool           text        not null,
  input          jsonb,
  status         text        not null,
  error          text,
  before_values  jsonb,
  after_values   jsonb,
  duration_ms    integer,
  created_at     timestamptz not null default now(),
  constraint mcp_audit_log_status_check check (status in ('ok', 'preview', 'replay', 'denied', 'invalid', 'not_found', 'error', 'rate_limited')),
  constraint mcp_audit_log_tool_check   check (char_length(tool) between 1 and 64),
  constraint mcp_audit_log_error_check  check (error is null or char_length(error) <= 500)
);
comment on table public.mcp_audit_log is
  'MCP connector: one row per tool call (who, tool, input, status, before/after for writes). Insert own only; read own or (owner / manager) the whole company. No update / delete for signed-in users.';
create index if not exists mcp_audit_log_tenant_idx on public.mcp_audit_log (tenant_id, created_at desc);
create index if not exists mcp_audit_log_user_idx on public.mcp_audit_log (tenant_id, user_id, created_at desc);

alter table public.mcp_audit_log enable row level security;
drop policy if exists mcp_audit_insert_own on public.mcp_audit_log;
create policy mcp_audit_insert_own on public.mcp_audit_log for insert to authenticated
  with check (tenant_id = (select public.current_tenant_id()) and user_id = (select public.current_user_id()));
drop policy if exists mcp_audit_read on public.mcp_audit_log;
create policy mcp_audit_read on public.mcp_audit_log for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and (user_id = (select public.current_user_id()) or (select public.current_user_has_role('owner', 'manager')))
  );
drop policy if exists gp09_personal_wall on public.mcp_audit_log;
create policy gp09_personal_wall on public.mcp_audit_log as restrictive for all to authenticated
  using (not (select public.is_personal_session())) with check (not (select public.is_personal_session()));
drop policy if exists zzz_service_role_all on public.mcp_audit_log;
create policy zzz_service_role_all on public.mcp_audit_log as permissive for all to service_role using (true) with check (true);
revoke all on public.mcp_audit_log from public, anon, authenticated;
grant select, insert on public.mcp_audit_log to authenticated;
grant all on public.mcp_audit_log to service_role;

commit;
