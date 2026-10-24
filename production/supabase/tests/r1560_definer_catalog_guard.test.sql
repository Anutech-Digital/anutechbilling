-- R-1560 — catalog-wide guard for every SECURITY DEFINER function in schema public.
--
-- The older guards (r714/r715/tenant_guard_fail_closed, anon_default_privileges) check fixed
-- lists or one regex. A NEW definer function slips past all of them. This file reads pg_proc
-- and fails when any public definer function:
--   (a) has no `search_path` in proconfig — a definer without it runs with the CALLER's
--       search_path, so a caller can shadow public.users / now() with its own objects;
--   (b) reads public.users by auth.uid() (taking tenant/role from the caller's own row) and
--       never calls current_tenant_id() — that skips R-731's MFA check and is_active, the
--       hole R-1556 closed in the backup functions;
--   (c) is EXECUTE-able by PUBLIC (proacl NULL = PUBLIC by default, or an explicit PUBLIC
--       grant) — on Cloud SQL that is every login, anon included.
--
-- Self-check first: probe functions that break each rule must be caught (so a broken regex
-- cannot pass silently), then the real catalog must be clean apart from the allowlist below.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1560_definer_catalog_guard.test.sql

begin;

create function pg_temp.r1560_violations()
returns table (rule text, fn text)
language sql stable
as $$
  with d as (
    select p.oid, p.proname, p.oid::regprocedure::text as sig, p.proconfig, p.proacl,
           case when p.prokind in ('f', 'p') then pg_get_functiondef(p.oid) else '' end as body
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and not exists (select 1 from pg_depend dep
                        where dep.classid = 'pg_proc'::regclass and dep.objid = p.oid and dep.deptype = 'e')
  )
  select 'a_no_search_path', sig from d
   where not exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c where c like 'search\_path=%')
  union all
  select 'b_users_by_auth_uid', sig from d
   where body ~* '\mfrom\s+(public\.)?users\M[^;]*auth\.uid\(\)'
     and body !~* 'current_tenant_id\(\)'
  union all
  select 'c_public_execute', sig from d
   where proacl is null
      or exists (select 1 from aclexplode(proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE');
$$;

-- ── 1. Self-check: each rule catches a probe ──────────────────────────────────────────
create function public.__t_r1560_no_path() returns int
  language sql security definer as 'select 1';
revoke all on function public.__t_r1560_no_path() from public;

create function public.__t_r1560_users_uid() returns uuid
  language sql security definer set search_path = ''
  as 'select tenant_id from public.users where id = auth.uid()';
revoke all on function public.__t_r1560_users_uid() from public;

create function public.__t_r1560_public_exec() returns int
  language sql security definer set search_path = '' as 'select 1';
grant execute on function public.__t_r1560_public_exec() to public;

do $$
begin
  if not exists (select 1 from pg_temp.r1560_violations() where rule = 'a_no_search_path' and fn = '__t_r1560_no_path()') then
    raise exception 'SELF-CHECK a: a definer without search_path was not caught';
  end if;
  if not exists (select 1 from pg_temp.r1560_violations() where rule = 'b_users_by_auth_uid' and fn = '__t_r1560_users_uid()') then
    raise exception 'SELF-CHECK b: a definer taking tenant from users by auth.uid() was not caught';
  end if;
  if not exists (select 1 from pg_temp.r1560_violations() where rule = 'c_public_execute' and fn = '__t_r1560_public_exec()') then
    raise exception 'SELF-CHECK c: a definer EXECUTE-able by PUBLIC was not caught';
  end if;
  -- the clean probes must not be flagged by the other rules
  if exists (select 1 from pg_temp.r1560_violations() where fn = '__t_r1560_users_uid()' and rule <> 'b_users_by_auth_uid') then
    raise exception 'SELF-CHECK: a clean probe was flagged by the wrong rule';
  end if;
end $$;

drop function public.__t_r1560_no_path();
drop function public.__t_r1560_users_uid();
drop function public.__t_r1560_public_exec();

-- ── 2. The real catalog ──────────────────────────────────────────────────────────────
do $$
declare
  -- Rule (b) — LEGITIMATE: role/identity helpers that read only the caller's own role or id,
  -- never take a tenant from it, and are always combined with a current_tenant_id() check
  -- by their callers / RLS policies.
  v_ok_b text[] := array[
    'current_user_has_role(text[])',   -- role gate; has is_active + session_mfa_ok() (R-1556)
    'current_user_is_owner()',         -- role gate (is_active); policies pair it with current_tenant_id()
    'hierarchy_sees_all()',            -- role gate for sales-hierarchy RLS (is_active)
    'payment_run_role()',              -- returns the caller's role only
    'automation_jobs_stamp()'          -- trigger: stamps changed_by only when the user is in NEW.tenant_id
  ];
  -- Rule (b) — KNOWN GAPS: tenant comes from users by auth.uid(), so R-731 MFA and is_active
  -- are skipped. R-1560 listed 14; R-1615 (migration 20261018225100) moved all 14 to
  -- current_tenant_id(), so this list is EMPTY. Do NOT add names — fix the function instead.
  v_known_b text[] := '{}'::text[];
  v_bad   text;
  v_stale text;
begin
  select string_agg(rule || ': ' || fn, E'\n  ' order by rule, fn) into v_bad
    from pg_temp.r1560_violations()
   where fn not like '\_\_t\_%'
     and not (rule = 'b_users_by_auth_uid' and (fn = any (v_ok_b) or fn = any (v_known_b)));
  if v_bad is not null then
    raise exception E'R-1560: SECURITY DEFINER functions break the catalog rules:\n  %', v_bad
      using hint = 'a: add set search_path = '''' (or public). b: take the tenant from '
                   || 'public.current_tenant_id() and fail closed on NULL (CLAUDE.md 17c). '
                   || 'c: revoke execute ... from public; grant only the roles that call it.';
  end if;

  select string_agg(x, ', ') into v_stale
    from unnest(v_ok_b || v_known_b) x
   where not exists (select 1 from pg_temp.r1560_violations() v
                      where v.rule = 'b_users_by_auth_uid' and v.fn = x);
  if v_stale is not null then
    raise notice 'R-1560: allowlist entries no longer needed (remove them): %', v_stale;
  end if;
  raise notice 'R-1560 definer catalog guard: all checks passed (% known rule-b gaps allowlisted)',
    cardinality(v_known_b);
end $$;

rollback;
