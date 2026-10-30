-- deploy-peek: exists(select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'user_role' and e.enumlabel = 'personal')
-- deploy-key: gp01personalrole
-- R-2110 (GP-01, goal G-PERSONAL, 30 Oct 2026): the 'personal' value of public.user_role.
-- The one person in a personal workspace (tenants.workspace_kind = 'personal', next migration).
-- Set only by the server at personal signup (GP-05); lib/auth/roles.ts keeps it out of
-- INVITABLE_ROLES, so no Team picker, claim or join request can hand it out.
-- Own file: ALTER TYPE ... ADD VALUE cannot be used in the same transaction as the new value.
-- The same statement is in prisma/migrations/20261030004000_gp01_personal_role (R-1934 rule:
-- both sources carry an enum value). Idempotent. Needs the type owner (postgres locally;
-- resellersos_migration on Cloud SQL).

alter type public.user_role add value if not exists 'personal';
