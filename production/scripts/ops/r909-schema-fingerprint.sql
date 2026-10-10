-- R-909: one row per schema object — kind, name, md5 of its definition — for public, auth, storage
-- plus instance roles, extensions and storage buckets. READ-ONLY. Run through
-- `gcloud sql export csv --query` (scripts/ops/r909-live-db.sh MODE=fingerprint) on the staging DB
-- and on the rehearsal clone / live DB, then diff the two CSVs: an empty diff = same schema,
-- policies, grants, functions, triggers and roles. Row data and passwords are never read.
-- Uses pg_catalog (not information_schema), which does not hide objects the exporting user
-- has no privilege on. The staging-only marker table is left out on purpose.
select kind, name, md5(coalesce(def, '')) as h from (
  select 'column' as kind, n.nspname || '.' || c.relname || '.' || a.attname as name,
         concat_ws('|', format_type(a.atttypid, a.atttypmod), a.attnotnull::text, pg_get_expr(d.adbin, d.adrelid)) as def
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped and n.nspname in ('public', 'auth', 'storage')
  union all
  select 'rls', n.nspname || '.' || c.relname, concat_ws('|', c.relrowsecurity::text, c.relforcerowsecurity::text)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname in ('public', 'auth', 'storage')
  union all
  select 'table_acl', n.nspname || '.' || c.relname, concat_ws('|', array_to_string(c.relacl::text[], ','), pg_get_userbyid(c.relowner))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p', 'v', 'm', 'S') and n.nspname in ('public', 'auth', 'storage')
  union all
  select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         concat_ws('|', pg_get_functiondef(p.oid), array_to_string(p.proacl::text[], ','), pg_get_userbyid(p.proowner))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prokind in ('f', 'p') and n.nspname in ('public', 'auth', 'storage')
  union all
  select 'policy', schemaname || '.' || tablename || '.' || policyname,
         concat_ws('|', permissive, array_to_string(roles, ','), cmd, qual, with_check)
    from pg_policies where schemaname in ('public', 'auth', 'storage')
  union all
  select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal and n.nspname in ('public', 'auth', 'storage')
  union all
  select 'constraint', n.nspname || '.' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'auth', 'storage')
  union all
  select 'index', schemaname || '.' || indexname, indexdef from pg_indexes where schemaname in ('public', 'auth', 'storage')
  union all
  select 'schema_acl', nspname, array_to_string(nspacl::text[], ',') from pg_namespace where nspname in ('public', 'auth', 'storage')
  union all
  select 'default_acl', pg_get_userbyid(defaclrole) || '.' || coalesce(defaclnamespace::regnamespace::text, '*') || '.' || defaclobjtype::text,
         array_to_string(defaclacl::text[], ',') from pg_default_acl
  union all
  select 'role', r.rolname,
         concat_ws('|', r.rolcanlogin::text, r.rolinherit::text, r.rolbypassrls::text, r.rolcreaterole::text,
           (select string_agg(g.rolname, ',' order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid),
           (select string_agg(array_to_string(s.setconfig, ','), ';' order by array_to_string(s.setconfig, ',')) from pg_db_role_setting s where s.setrole = r.oid))
    from pg_roles r where r.rolname !~ '^(pg_|cloudsql)'
  union all
  select 'extension', extname, extversion from pg_extension
  union all
  select 'storage_bucket', id, concat_ws('|', public::text, file_size_limit::text, array_to_string(allowed_mime_types, ',')) from storage.buckets
) x
where name not like 'public.zz_staging_marker%'
order by kind, name
