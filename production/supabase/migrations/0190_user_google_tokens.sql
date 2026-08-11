-- 0190 — Per-user Google OAuth token store for Contacts two-way sync.
--
-- Each team member connects THEIR OWN Google account (contacts are personal), so
-- this is keyed on user_id, not tenant_id. We need a durable refresh token for
-- offline / cron-driven sync — Supabase's login provider_token is short-lived and
-- not persisted, so it can't drive a background sync. Hence a dedicated OAuth
-- client (offline access) whose refresh token we store here.
--
-- SECURITY: the refresh_token is sensitive. RLS is ENABLED with NO policies for
-- authenticated/anon, so the browser can never read this table — every access
-- goes through server routes using the service-role admin client (which bypasses
-- RLS), exactly like tenant_secrets. Plaintext at rest, protected by RLS + never
-- returned raw to the client (status routes return only connected/email/last-sync).

create table if not exists public.user_google_tokens (
  user_id         uuid primary key references public.users(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  google_email    text,
  access_token    text,
  refresh_token   text,
  token_expiry    timestamptz,
  scopes          text,
  -- People API nextSyncToken — enables incremental pulls (only changes since last sync).
  sync_token      text,
  last_synced_at  timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.user_google_tokens enable row level security;
-- Intentionally NO policies → only the service-role admin client can touch this.

drop trigger if exists trg_user_google_tokens_updated_at on public.user_google_tokens;
create trigger trg_user_google_tokens_updated_at
  before update on public.user_google_tokens
  for each row execute function public.handle_updated_at();

comment on table public.user_google_tokens is 'Per-user Google OAuth tokens for Contacts sync. Service-role only (RLS deny-all); refresh_token never exposed to the browser.';
