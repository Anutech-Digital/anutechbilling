-- Background jobs (Cloud Scheduler → /api/cron/*) run ACROSS tenants. Today they use the
-- service-role key, which sees every row of every table. On the Prisma path they log in as
-- app_jobs, which has exactly ONE cross-tenant power: listing tenant ids. All real work is
-- then done one tenant at a time through withJobsTenant(), under the normal RLS policies.
--
-- Anything else a job needs across tenants gets its own named function here, granted to
-- app_jobs only, with a test — never a blanket bypass.
begin;

create or replace function public.jobs_list_tenants()
  returns table (id uuid)
  language sql stable security definer set search_path = ''
as $$
  select t.id from public.tenants t
   where session_user = 'app_jobs'          -- nobody else gets rows, even if granted by mistake
   order by t.id;
$$;

revoke all on function public.jobs_list_tenants() from public, anon, authenticated, service_role;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_jobs') then
    execute 'grant execute on function public.jobs_list_tenants() to app_jobs';
  end if;
end $$;

commit;
