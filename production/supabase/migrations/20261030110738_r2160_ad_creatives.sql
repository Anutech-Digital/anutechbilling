-- deploy-peek: (to_regprocedure('public.ad_creative_object_allowed(text,text)') is not null and exists(select 1 from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'storage' and c.relname = 'objects' and p.polname = 'r2160 ad-creatives select'))
-- deploy-key: r2160adcreatives
-- deploy-user: postgres
--   (storage.buckets / storage.objects belong to the storage admin, as in 20261011133000_r724_storage_roles)
-- 20261030110738_r2160_ad_creatives.sql
--
-- R-2160 (30 Oct 2026, G-ADS-AI AI-04, with R-1883): the private `ad-creatives` bucket for the
-- marketing agent's generated ad images (1:1 1080x1080 and 9:16 1080x1920, plan
-- snappy-painting-dragonfly §6).
--
--   Path      {tenantId}/{adPlanId}/{file}.png   — folder 1 is always the company.
--   Read      owner and marketing of THAT company only (the same two roles as the agent routes
--             and agent_checkpoints, R-2157). Manager, sales, personal, another company: nothing.
--   Write     the server only (service_role, zzz_service_role_all) — images are made by the image
--             provider after the route's own role + plan + AI-cap checks; no browser upload yet.
--             (R-1883's own upload from the wizard adds an insert rule here when it is built.)
--   Bucket    private; png / jpeg / webp only; 10 MB per file (a 1080x1920 PNG is ~2-5 MB).
--
-- A separate rule function (not public.storage_object_allowed) so R-724's function is not
-- redefined. Runs as postgres on Cloud SQL (member of supabase_storage_admin). Idempotent.
-- Test: supabase/tests/r2160_ad_creatives.test.sql (rolled back).

begin;

create or replace function public.ad_creative_object_allowed(p_name text, p_op text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.current_tenant_id();
  v_parts  text[];
  v_n      int;
  v_role   text;
begin
  /* R-2160: who may READ a file in ad-creatives. Writes stay with the server (service_role). */
  if v_uid is null or v_tenant is null or p_name is null or p_op is distinct from 'select' then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  v_n     := coalesce(cardinality(v_parts), 0);
  if v_n < 2 or v_parts[1] <> v_tenant::text or '' = any (v_parts) or '.' = any (v_parts) or '..' = any (v_parts) then
    return false;
  end if;

  select u.role::text into v_role
    from public.users u where u.id = v_uid and u.tenant_id = v_tenant and u.is_active;
  return coalesce(v_role in ('owner', 'marketing'), false);
end;
$function$;

comment on function public.ad_creative_object_allowed(text, text) is
  'R-2160: read rule for the private ad-creatives bucket — {tenant}/… of the caller''s own company, owner or marketing, active login. Writes are server-only (service_role).';

revoke all on function public.ad_creative_object_allowed(text, text) from public, anon;
grant execute on function public.ad_creative_object_allowed(text, text) to authenticated, service_role, supabase_storage_admin;
grant usage on schema public to supabase_storage_admin;

set local role supabase_storage_admin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('ad-creatives', 'ad-creatives', false, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "r2160 ad-creatives select" on storage.objects;
create policy "r2160 ad-creatives select" on storage.objects for select to authenticated
  using (bucket_id = 'ad-creatives' and public.ad_creative_object_allowed(name, 'select'));

reset role;
commit;
