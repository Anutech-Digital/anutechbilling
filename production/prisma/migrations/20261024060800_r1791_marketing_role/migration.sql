-- deploy-peek: exists(select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'user_role' and e.enumlabel = 'marketing')
-- deploy-key: r1791marketingrole
-- prisma/migrations/20261023114000_r1791_marketing_role
-- R-1791 (Abhishek, 23 Oct 2026): a "Marketing" role — the person who asks the owner for a
-- marketing budget and asks billing to pay against it (R-1792). Additive: every existing row
-- and check keeps working; what the role may open is decided in lib/auth/roles.ts + nav.ts.
-- ADD VALUE is not run inside an explicit transaction, so the new value is usable as soon as
-- this file has run. It needs the type's OWNER: on Cloud SQL that is resellersos_migration
-- (it created the enum); locally the type was postgres-owned and was re-owned once by hand.

alter type public.user_role add value if not exists 'marketing';
