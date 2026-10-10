-- LOCAL ONLY. Makes a plain Postgres 17 container look like production Cloud SQL did
-- before baseline.sql was loaded: the Supabase roles, the auth/storage schemas and the
-- auth.* helpers (same bodies as supabase/cloudsql/01a-roles-and-auth.sql), plus the
-- minimal auth.users / storage tables GoTrue and Storage would normally create.
-- Never run against a real database — production already has the real versions.

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon')                   then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated')          then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role')           then create role service_role nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator')          then create role authenticator login noinherit password 'localdev'; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin')    then create role supabase_auth_admin login noinherit createrole; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_storage_admin') then create role supabase_storage_admin login noinherit createrole; end if;
  -- Production's table owner (supabase/cloudsql/01b-grants-and-policies.sql:5) and app role.
  if not exists (select 1 from pg_roles where rolname='resellersos_migration')  then create role resellersos_migration login password 'localdev'; end if;
  if not exists (select 1 from pg_roles where rolname='resellersos_app')        then create role resellersos_app login password 'localdev'; end if;
end $$;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role, supabase_auth_admin, supabase_storage_admin to postgres;

create schema if not exists auth    authorization supabase_auth_admin;
create schema if not exists storage authorization supabase_storage_admin;
grant usage on schema auth to anon, authenticated, service_role, authenticator, postgres;

-- Copied verbatim from supabase/cloudsql/01a-roles-and-auth.sql:49-60 (production).
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')) $$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')) $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt()
  to anon, authenticated, service_role, authenticator, postgres;

-- Same columns as GoTrue's auth.users (the SQL tests insert instance_id, aud, role, …).
create table if not exists auth.users (
  instance_id uuid, id uuid primary key default gen_random_uuid(),
  aud varchar(255), role varchar(255), email varchar(255), encrypted_password varchar(255),
  email_confirmed_at timestamptz, invited_at timestamptz, confirmation_token varchar(255),
  confirmation_sent_at timestamptz, recovery_token varchar(255), recovery_sent_at timestamptz,
  email_change_token_new varchar(255), email_change varchar(255), email_change_sent_at timestamptz,
  last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb default '{}'::jsonb,
  is_super_admin boolean, created_at timestamptz default now(), updated_at timestamptz default now(),
  phone text, phone_confirmed_at timestamptz, phone_change text, phone_change_token varchar(255),
  phone_change_sent_at timestamptz, email_change_token_current varchar(255),
  email_change_confirm_status smallint, banned_until timestamptz, reauthentication_token varchar(255),
  reauthentication_sent_at timestamptz, is_sso_user boolean not null default false,
  deleted_at timestamptz, is_anonymous boolean not null default false
);
alter table auth.users owner to supabase_auth_admin;
grant select on auth.users to postgres, service_role;

create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text, owner uuid,
  metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to anon, authenticated, service_role, postgres;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;

-- In production Storage owns its tables; storage migrations `set role` to it.
alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
alter function storage.foldername(text) owner to supabase_storage_admin;

-- GoTrue's MFA table (v2.151 shape), so two-step sign-in can be tested locally and the
-- Auth.js code writes the same rows GoTrue reads (rollback stays possible).
do $$ begin create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
exception when duplicate_object then null; end $$;
do $$ begin create type auth.factor_status as enum ('unverified', 'verified');
exception when duplicate_object then null; end $$;
create table if not exists auth.mfa_factors (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  friendly_name text, factor_type auth.factor_type not null, status auth.factor_status not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  secret text, phone text, last_challenged_at timestamptz
);
alter table auth.mfa_factors owner to supabase_auth_admin;
alter type auth.factor_type owner to supabase_auth_admin;
alter type auth.factor_status owner to supabase_auth_admin;

-- Supabase Storage's own uniqueness rule (bucketid_objname), relied on by upsert.
create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);
