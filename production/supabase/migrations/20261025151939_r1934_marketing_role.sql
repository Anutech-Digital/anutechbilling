-- deploy-peek: exists(select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'user_role' and e.enumlabel = 'marketing')
-- deploy-key: r1934marketingrole
-- R-1934 (25 Oct 2026): the 'marketing' value of public.user_role as a supabase migration.
-- R-1791 (Abhishek, 24 Oct) added it ONLY in prisma/migrations/20261024060800_r1791_marketing_role
-- (staging/live run those). The CI database is built from supabase/baseline.sql + supabase/migrations
-- only, so it never had the value and the R-1878 / R-1897 SQL tests (a marketing user) failed with
-- "invalid input value for enum user_role". The role is real (lib/auth/roles.ts, R-1792 budgets),
-- so the tests are right and the schema source was incomplete.
-- Idempotent: where R-1791 already ran (staging, live, local) this is a no-op.
-- ADD VALUE needs the type owner (postgres in the baseline; resellersos_migration on Cloud SQL).

alter type public.user_role add value if not exists 'marketing';
