-- deploy-peek: exists(select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'user_role' and e.enumlabel = 'personal')
-- deploy-key: gp01personalroleprisma
-- prisma/migrations/20261030004000_gp01_personal_role
-- R-2110 (GP-01, goal G-PERSONAL): the 'personal' user_role value — same statement as
-- supabase/migrations/20261030004000_gp01_personal_role.sql (R-1934: both sources carry an enum
-- value). Own migration: ADD VALUE cannot share a transaction with its first use. Idempotent.

alter type public.user_role add value if not exists 'personal';
