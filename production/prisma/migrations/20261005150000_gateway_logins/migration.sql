-- Logins for the PostgREST-compatible gateway (src/server/postgrest), which replaces the
-- VM's PostgREST. The roles themselves are created by db/ops/10-runtime-roles.sql (needs
-- CREATEROLE + passwords); this teaches the helpers what each login means.
--
--   app_runtime  signed-in user. The tenant may now be left empty: it is then derived from
--                public.users for app.user_id — exactly what PostgREST did with a verified
--                JWT. If a tenant IS given it must still match the user (withTenant always
--                gives one).
--   app_anon     signed-out visitor → behaves as role `anon`, no user, no tenant.
--   app_service  the service-role key's equivalent → current_request_role() = 'service_role',
--                no user, no tenant. Same power as today's createAdminClient, no more.
begin;

create or replace function public.current_user_id() returns uuid
  language sql stable set search_path = ''
as $$
  select case
    when session_user in ('app_runtime', 'app_jobs')
      then nullif(current_setting('app.user_id', true), '')::uuid
    when session_user in ('app_service', 'app_anon') then null
    else auth.uid()
  end;
$$;

create or replace function public.current_request_role() returns text
  language sql stable set search_path = ''
as $$
  select case session_user
    when 'app_runtime' then 'authenticated'
    when 'app_jobs'    then 'app_jobs'
    when 'app_service' then 'service_role'
    when 'app_anon'    then 'anon'
    else auth.role()
  end;
$$;

create or replace function public.current_tenant_id() returns uuid
  language sql stable security definer set search_path = ''
as $$
  select case
    when session_user = 'app_runtime' then (
      select u.tenant_id from public.users u
       where u.id = nullif(current_setting('app.user_id', true), '')::uuid
         and (nullif(current_setting('app.tenant_id', true), '') is null
              or u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
       limit 1)
    when session_user = 'app_jobs' then
      case when nullif(current_setting('app.user_id', true), '') is null
        then nullif(current_setting('app.tenant_id', true), '')::uuid
        else (select u.tenant_id from public.users u
               where u.id = nullif(current_setting('app.user_id', true), '')::uuid
                 and u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
               limit 1)
      end
    when session_user in ('app_service', 'app_anon') then null
    else (select tenant_id from public.users where id = auth.uid() limit 1)
  end;
$$;

commit;
