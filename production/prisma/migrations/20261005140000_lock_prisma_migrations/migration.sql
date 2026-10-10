-- Prisma Migrate keeps its bookkeeping in public._prisma_migrations, created by the first
-- `migrate resolve/deploy` with no RLS. PostgREST exposes the public schema, and production's
-- default privileges for the migrating role are not known from git — so close it outright.
-- The owner (resellersos_migration, which runs migrations) is unaffected: RLS is not forced.
begin;
alter table public._prisma_migrations enable row level security;
revoke all on table public._prisma_migrations from public, anon, authenticated, service_role;
commit;
