-- LOCAL ONLY. Production's app objects belong to resellersos_migration, a NON-superuser
-- (supabase/cloudsql/01b-grants-and-policies.sql:5). That is what lets SECURITY DEFINER
-- functions skip RLS there — as the table owner, not as a superuser. Copy it, or local
-- tests prove nothing about production.
do $o$
declare r record;
begin
  for r in
    select c.oid::regclass as t, c.relkind
      from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'v', 'm', 'S', 'p')
       -- a sequence owned by a column follows its table
       and not exists (select 1 from pg_depend d
                        where d.objid = c.oid and d.classid = 'pg_class'::regclass
                          and d.deptype in ('a', 'i'))
  loop
    execute format('alter %s %s owner to resellersos_migration',
      case r.relkind when 'S' then 'sequence' when 'v' then 'view'
                     when 'm' then 'materialized view' else 'table' end, r.t);
  end loop;

  for r in select p.oid::regprocedure as f, p.prokind
             from pg_proc p where p.pronamespace = 'public'::regnamespace
  loop
    execute format('alter %s %s owner to resellersos_migration',
      case r.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, r.f);
  end loop;

  execute 'alter schema public owner to resellersos_migration';
end $o$;
