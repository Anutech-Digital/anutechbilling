-- R-2091: anon/authenticated hold no TRUNCATE / TRIGGER / REFERENCES (MAINTAIN on PG17+) on any
-- public table or view, today or on a table created later — and normal RLS reads still work.
-- Migration: supabase/migrations/20261029030434_r2091_revoke_truncate_trigger_references.sql
-- Self-asserting (RAISE on failure), rolled back.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2091_table_grants.test.sql

begin;

-- A table created AFTER the migration (default privileges), with a normal tenant-style policy.
create table public.__t_r2091_probe (id int primary key, owner_id uuid not null);
alter table public.__t_r2091_probe enable row level security;
create policy __t_r2091_own on public.__t_r2091_probe for select to authenticated
  using (owner_id = auth.uid());
grant select on public.__t_r2091_probe to authenticated;
insert into public.__t_r2091_probe values
  (1, '00000000-0000-4000-8000-0000000a2091'),
  (2, '00000000-0000-4000-8000-0000000b2091');

do $$
declare
  v_privs text[] := array['TRUNCATE', 'TRIGGER', 'REFERENCES'];
  v_bad text;
begin
  if current_setting('server_version_num')::int >= 170000 then
    v_privs := v_privs || 'MAINTAIN'::text;
  end if;

  -- 1. no existing public table/view grants them to anon/authenticated
  select string_agg(distinct r.rolname || ':' || p || ':' || c.relname, ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(v_privs) p
    cross join (values ('anon'), ('authenticated')) r(rolname)
   where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
     and c.relname <> '__t_r2091_probe'
     and has_table_privilege(r.rolname, c.oid, p);
  if v_bad is not null then
    raise exception 'FAIL 1: anon/authenticated still hold table privileges: %', v_bad;
  end if;

  -- 2. a new table does not get them by default either
  select string_agg(r.rolname || ':' || p, ', ') into v_bad
    from unnest(v_privs) p
    cross join (values ('anon'), ('authenticated')) r(rolname)
   where has_table_privilege(r.rolname, 'public.__t_r2091_probe', p);
  if v_bad is not null then
    raise exception 'FAIL 2: a freshly created table hands out: %', v_bad;
  end if;

  -- 3. the four RLS-governed privileges are untouched on real tables
  if not (has_table_privilege('authenticated', 'public.customers', 'SELECT')
      and has_table_privilege('authenticated', 'public.customers', 'INSERT')
      and has_table_privilege('authenticated', 'public.customers', 'UPDATE')
      and has_table_privilege('authenticated', 'public.customers', 'DELETE')
      and has_table_privilege('authenticated', 'public.quotes', 'SELECT')) then
    raise exception 'FAIL 3: authenticated lost SELECT/INSERT/UPDATE/DELETE on customers/quotes';
  end if;
end $$;

-- 4. as authenticated: the RLS select still returns exactly the caller's row …
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000a2091","role":"authenticated"}', true);

do $$
declare v_n int;
begin
  select count(*) into v_n from public.__t_r2091_probe;
  if v_n <> 1 then
    raise exception 'FAIL 4: authenticated RLS select returned % rows, expected 1', v_n;
  end if;

  -- 5. … and TRUNCATE (which RLS would not stop) is refused on a real table.
  begin
    truncate public.support_sync_outbox;
    raise exception 'FAIL 5: authenticated could TRUNCATE support_sync_outbox';
  exception when insufficient_privilege then
    null;
  end;
  begin
    truncate public.__t_r2091_probe;
    raise exception 'FAIL 5: authenticated could TRUNCATE a new table';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'R-2091 table grants: all checks passed';
end $$;

reset role;

rollback;
