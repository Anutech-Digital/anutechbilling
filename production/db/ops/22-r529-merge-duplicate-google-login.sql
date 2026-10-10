-- R-529 (9 Oct 2026) — remove the DUPLICATE logins Auth.js created on Google sign-in, so each
-- person is back on the auth.users id their public.users profile (tenant + role) hangs off.
--
-- Staging, 9 Oct: pardeep@anutech.in signed in with Google and got a new auth.users id
-- (6172ee49-…) with no profile. The code fix (accounts.ts#linkOAuthUser) already ignores such a
-- stray row when the profile's own login exists; this cleans the stray row up, and — if the
-- profile has NO login row at all — moves the login onto the profile's id.
--
-- Not a Prisma migration: it writes auth.users, which the migration role may not touch
-- (same as the Academy files on 5/6 Oct). Run as `postgres` through the Cloud SQL proxy:
--
--   psql "<admin url>" -f db/ops/22-r529-merge-duplicate-google-login.sql              # DRY RUN (rolls back)
--   psql "<admin url>" -v apply=1 -f db/ops/22-r529-merge-duplicate-google-login.sql   # do it
--
-- Idempotent: a second run finds nothing. Touches ONLY a login that is all of:
--   · created by Auth.js on/after 2026-10-07 (R-161 switch-on), provider google
--   · no public.users profile of its own, no auth.identities row (GoTrue never made it)
--   · its email belongs to exactly ONE active public.users profile with a DIFFERENT id
--   · nothing in the app references it (every FK to auth.users is checked; else skipped)
-- Its pending join requests (made while it had no tenant) are deleted with it.

\set ON_ERROR_STOP on
begin;

create temp table r529_dups on commit drop as
select d.id as dup_id, p.id as profile_id, lower(d.email) as email,
       exists (select 1 from auth.users a where a.id = p.id) as profile_has_login
  from auth.users d
  join lateral (
        select u.id from public.users u
         where lower(u.email) = lower(d.email) and u.is_active
       ) p on true
 where d.created_at >= timestamptz '2026-10-07 00:00:00+00'
   and coalesce(d.raw_app_meta_data->>'provider', '') = 'google'
   and d.id <> p.id
   and not exists (select 1 from public.users pu where pu.id = d.id)
   and not exists (select 1 from auth.identities i where i.user_id = d.id)
   and (select count(*) from public.users u2 where lower(u2.email) = lower(d.email) and u2.is_active) = 1;

-- Skip any duplicate the app already references (FKs from outside the auth schema).
do $$
declare fk record; n bigint; r record;
begin
  for r in select * from r529_dups loop
    for fk in
      select c.conrelid::regclass as tbl, a.attname as col
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
         and c.connamespace <> 'auth'::regnamespace
    loop
      execute format('select count(*) from %s where %I = $1', fk.tbl, fk.col) into n using r.dup_id;
      if n > 0 then
        raise notice 'R-529 SKIP % (%): % row(s) in %.% point at it — check by hand', r.dup_id, r.email, n, fk.tbl, fk.col;
        delete from r529_dups where dup_id = r.dup_id;
        exit;
      end if;
    end loop;
  end loop;
end $$;

select dup_id, profile_id, email, profile_has_login from r529_dups;

delete from public.join_requests j
 using r529_dups r
 where j.auth_user_id = r.dup_id and j.status = 'pending_approval';

-- auth.users belongs to supabase_auth_admin (cloudsql/06 gave postgres that role). The rows to
-- fix are read first, then the role is switched for the auth.users writes only.
do $$
declare r record; todo jsonb; row_json jsonb; cols text;
begin
  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) into todo from r529_dups d;
  -- Every insertable column (GoTrue has generated ones, e.g. confirmed_at).
  select string_agg(quote_ident(attname), ', ' order by attnum) into cols
    from pg_attribute where attrelid = 'auth.users'::regclass and attnum > 0 and not attisdropped and attgenerated = '';
  execute 'set local role supabase_auth_admin';
  for r in select * from jsonb_to_recordset(todo) as x(dup_id uuid, profile_id uuid, email text, profile_has_login boolean) loop
    select to_jsonb(u) into row_json from auth.users u where u.id = r.dup_id;
    delete from auth.users where id = r.dup_id;           -- cascades its sessions / factors
    if r.profile_has_login then
      raise notice 'R-529 removed duplicate login % for % (profile login % kept)', r.dup_id, r.email, r.profile_id;
    else
      -- The profile had no login: re-create this one on the profile's id (same email, same data).
      execute format('insert into auth.users (%s) select %s from jsonb_populate_record(null::auth.users, $1)', cols, cols)
        using row_json || jsonb_build_object('id', r.profile_id);
      raise notice 'R-529 moved login % -> % for %', r.dup_id, r.profile_id, r.email;
    end if;
  end loop;
  if jsonb_array_length(todo) = 0 then raise notice 'R-529 nothing to fix'; end if;
  execute 'reset role';
end $$;

\if :{?apply}
commit;
\echo 'R-529: APPLIED'
\else
rollback;
\echo 'R-529: DRY RUN — rolled back. Re-run with -v apply=1 to apply.'
\endif
