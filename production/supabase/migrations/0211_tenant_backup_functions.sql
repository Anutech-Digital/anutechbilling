-- 0211 — in-app "Backup" feature (owner-only, tenant-scoped).
--
-- Each reseller can take a snapshot of THEIR OWN data and download it. Snapshots
-- live in the hidden `backup` schema (not API-exposed); all access is via these
-- SECURITY DEFINER functions, which scope strictly to the caller's tenant. This
-- must never dump another tenant's rows.

alter table backup.snapshots add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
create index if not exists idx_backup_snapshots_tenant on backup.snapshots(tenant_id, created_at desc);

-- Take a full snapshot of the caller's tenant data → store + return metadata.
create or replace function public.create_tenant_backup(p_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_role text; r record; result jsonb := '{}'::jsonb; tbl_json jsonb; n int := 0; v_id uuid;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can take a backup'; end if;

  -- The tenant's own row.
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into tbl_json from public.tenants t where t.id = v_tenant;
  result := jsonb_build_object('tenants', tbl_json); n := 1;

  -- Every public table that has a tenant_id column, filtered to this tenant.
  -- Secrets are never backed up.
  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname = 'public' and pt.tablename = c.table_name
    where c.table_schema = 'public' and c.column_name = 'tenant_id'
      and c.table_name not in ('tenant_secrets')
    order by c.table_name
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t where t.tenant_id = $1', r.table_name)
      into tbl_json using v_tenant;
    result := result || jsonb_build_object(r.table_name, tbl_json);
    n := n + 1;
  end loop;

  insert into backup.snapshots(tenant_id, label, table_count, payload)
  values (v_tenant, coalesce(nullif(btrim(p_label), ''), 'Manual backup'), n, result)
  returning id into v_id;

  -- Keep the latest 20 per tenant so the table doesn't grow forever.
  delete from backup.snapshots s
  where s.tenant_id = v_tenant
    and s.id not in (
      select id from backup.snapshots where tenant_id = v_tenant order by created_at desc limit 20
    );

  return jsonb_build_object('id', v_id, 'table_count', n, 'bytes', length(result::text), 'created_at', now());
end $$;

-- List the caller's snapshots (metadata only).
create or replace function public.list_tenant_backups()
returns table(id uuid, created_at timestamptz, label text, table_count int, bytes int)
language sql security definer set search_path = public as $$
  select s.id, s.created_at, s.label, s.table_count, length(s.payload::text)
  from backup.snapshots s
  where s.tenant_id = (select tenant_id from public.users where id = auth.uid())
  order by s.created_at desc;
$$;

-- Fetch one snapshot's full payload (for download) — only if it's the caller's.
create or replace function public.get_tenant_backup(p_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select payload from backup.snapshots
  where id = p_id and tenant_id = (select tenant_id from public.users where id = auth.uid());
$$;

-- Delete one of the caller's snapshots.
create or replace function public.delete_tenant_backup(p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from backup.snapshots
  where id = p_id and tenant_id = (select tenant_id from public.users where id = auth.uid());
$$;

grant execute on function public.create_tenant_backup(text) to authenticated;
grant execute on function public.list_tenant_backups() to authenticated;
grant execute on function public.get_tenant_backup(uuid) to authenticated;
grant execute on function public.delete_tenant_backup(uuid) to authenticated;
