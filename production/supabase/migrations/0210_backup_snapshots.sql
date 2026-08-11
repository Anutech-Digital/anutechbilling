-- 0210 — a hidden `backup` schema for point-in-time full-data snapshots.
--
-- Lives OUTSIDE the API-exposed `public` schema, so PostgREST/RLS never surface
-- it to the app. Used to take a manual restore point before risky experiments
-- (the free Supabase plan has no automatic backups / PITR).
--
-- Taking a snapshot is a one-off manual operation (run in the SQL editor), not
-- part of this migration:
--   do $$
--   declare r record; result jsonb := '{}'::jsonb; tbl_json jsonb; n int := 0;
--   begin
--     for r in select tablename from pg_tables
--       where schemaname='public' and tablename not in ('tenant_secrets','schema_migrations')
--       order by tablename
--     loop
--       execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t', r.tablename) into tbl_json;
--       result := result || jsonb_build_object(r.tablename, tbl_json); n := n + 1;
--     end loop;
--     insert into backup.snapshots(label, table_count, payload) values ('manual snapshot', n, result);
--   end $$;

create schema if not exists backup;

create table if not exists backup.snapshots (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  label       text,
  table_count int,
  payload     jsonb not null
);
