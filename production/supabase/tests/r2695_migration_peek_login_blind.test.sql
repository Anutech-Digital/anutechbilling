-- R-2695 (12 Nov 2026): GET /api/health/migrations on staging 3afa13f said migration
-- 'paidcampaignplatformlinks' was missing while the DB step (run as the table owner) said true and
-- marketing_campaigns.ads_manager_url was there.
-- Cause: information_schema.columns lists only columns the CURRENT login has a privilege on. The
-- app asks as app_service (member of service_role); on Cloud SQL a table created without an
-- explicit GRANT gives service_role nothing, so the column is invisible to the app's check.
-- Fix (src/server/migrations-health/peek-sql.ts): the app swaps information_schema.columns for the
-- pg_catalog query below (CATALOG_COLUMNS_SQL — peek-sql.test.ts keeps this file's copy identical).
--
-- Self-asserting, ONE transaction, rolled back. Local/test DB only.
-- Proves:
--   A. The catalog query returns exactly what information_schema.columns returns, field for field
--      (table_schema, table_name, column_name, data_type, column_default), for every public column
--      — seen by a login that owns / can see everything.
--   B. Reproduces staging: a login with no privilege on marketing_campaigns (like app_service on
--      staging) gets FALSE from the real peek text, and TRUE from the catalog query.

begin;

create role r2695_probe nologin;
grant r2695_probe to current_user;
grant usage on schema public to r2695_probe;

-- A. Same answer as information_schema.columns for a login that sees everything.
do $r2695a$
declare n_cat int; n_isc int; n_total int;
begin
  with cat as (
    select table_schema, table_name, column_name, data_type::text, column_default::text
      from (select nc.nspname::text as table_schema, c.relname::text as table_name, a.attname::text as column_name, case when t.typtype = 'd' then case when bt.typelem <> 0 and bt.typlen = -1 then 'ARRAY' when nbt.nspname = 'pg_catalog' then format_type(t.typbasetype, null) else 'USER-DEFINED' end else case when t.typelem <> 0 and t.typlen = -1 then 'ARRAY' when nt.nspname = 'pg_catalog' then format_type(a.atttypid, null) else 'USER-DEFINED' end end as data_type, case when a.attgenerated = '' then pg_get_expr(ad.adbin, ad.adrelid) end as column_default from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace nc on nc.oid = c.relnamespace join pg_catalog.pg_type t on t.oid = a.atttypid join pg_catalog.pg_namespace nt on nt.oid = t.typnamespace left join pg_catalog.pg_type bt on t.typtype = 'd' and bt.oid = t.typbasetype left join pg_catalog.pg_namespace nbt on nbt.oid = bt.typnamespace left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'v', 'f', 'p')) as isc_columns where table_schema = 'public'
  ), isc as (
    select table_schema::text, table_name::text, column_name::text, data_type::text, column_default::text
      from information_schema.columns where table_schema = 'public'
  )
  select (select count(*) from (select * from cat except select * from isc) x),
         (select count(*) from (select * from isc except select * from cat) y),
         (select count(*) from isc)
    into n_cat, n_isc, n_total;
  if n_total < 1000 then raise exception 'A0 FAIL: only % public columns visible — not a real schema', n_total; end if;
  if n_cat <> 0 or n_isc <> 0 then
    raise exception 'A FAIL: catalog vs information_schema differ (only catalog %, only information_schema %)', n_cat, n_isc;
  end if;
  raise notice 'A ok: % public columns, identical', n_total;
end $r2695a$;

-- B. A login with no privilege on marketing_campaigns — app_service on staging.
set local role r2695_probe;
do $r2695b$
begin
  if has_table_privilege('public.marketing_campaigns', 'select') then
    raise exception 'B0 FAIL: probe login can read marketing_campaigns — premise broken';
  end if;
  if exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'marketing_campaigns' and column_name = 'ads_manager_url') then
    raise exception 'B1 FAIL: information_schema showed the column to a login without privilege — staging cause not reproduced';
  end if;
  if not exists(select 1 from (select nc.nspname::text as table_schema, c.relname::text as table_name, a.attname::text as column_name, case when t.typtype = 'd' then case when bt.typelem <> 0 and bt.typlen = -1 then 'ARRAY' when nbt.nspname = 'pg_catalog' then format_type(t.typbasetype, null) else 'USER-DEFINED' end else case when t.typelem <> 0 and t.typlen = -1 then 'ARRAY' when nt.nspname = 'pg_catalog' then format_type(a.atttypid, null) else 'USER-DEFINED' end end as data_type, case when a.attgenerated = '' then pg_get_expr(ad.adbin, ad.adrelid) end as column_default from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace nc on nc.oid = c.relnamespace join pg_catalog.pg_type t on t.oid = a.atttypid join pg_catalog.pg_namespace nt on nt.oid = t.typnamespace left join pg_catalog.pg_type bt on t.typtype = 'd' and bt.oid = t.typbasetype left join pg_catalog.pg_namespace nbt on nbt.oid = bt.typnamespace left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'v', 'f', 'p')) as isc_columns where table_schema = 'public' and table_name = 'marketing_campaigns' and column_name = 'ads_manager_url') then
    raise exception 'B2 FAIL: the app''s catalog peek says ads_manager_url is missing for a login without privilege';
  end if;
  raise notice 'B ok: information_schema hides the column, the catalog peek finds it';
end $r2695b$;
reset role;

rollback;
