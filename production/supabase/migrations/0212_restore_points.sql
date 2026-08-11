-- 0212 — restore points: auto snapshots + one-click restore (owner, tenant-scoped).
--
-- Builds on 0210/0211. Adds:
--   * backup.snapshots.kind ('manual' | 'auto')
--   * backup._take(tenant, label, kind)  — shared snapshot builder, keeps last 15
--   * public.auto_backup_if_stale()      — makes a daily 'auto' restore point
--   * public.restore_tenant_backup(id)   — ATOMIC restore of the caller's data to
--     a chosen point; first saves a 'Before restore' safety point, then replaces
--     all tenant-scoped tables from the snapshot. FK order + triggers are bypassed
--     with session_replication_role=replica; the whole thing is one transaction, so
--     a failure rolls everything back and nothing is lost. Never touches users,
--     tenant_secrets, or the tenants row.

alter table backup.snapshots add column if not exists kind text not null default 'manual';

-- ── Shared snapshot builder (internal; not exposed to the API) ────────────────
create or replace function backup._take(p_tenant uuid, p_label text, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; result jsonb := '{}'::jsonb; tbl_json jsonb; n int := 0; v_id uuid;
begin
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into tbl_json from public.tenants t where t.id = p_tenant;
  result := jsonb_build_object('tenants', tbl_json); n := 1;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id'
      and c.table_name not in ('tenant_secrets')
    group by c.table_name order by c.table_name
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t where t.tenant_id = $1', r.table_name)
      into tbl_json using p_tenant;
    result := result || jsonb_build_object(r.table_name, tbl_json);
    n := n + 1;
  end loop;

  insert into backup.snapshots(tenant_id, label, kind, table_count, payload)
  values (p_tenant, coalesce(nullif(btrim(p_label), ''), 'Backup'), p_kind, n, result)
  returning id into v_id;

  -- Keep the newest 15 restore points per tenant (always ≥10 available).
  delete from backup.snapshots s
  where s.tenant_id = p_tenant
    and s.id not in (select id from backup.snapshots where tenant_id = p_tenant order by created_at desc limit 15);

  return jsonb_build_object('id', v_id, 'table_count', n, 'bytes', length(result::text), 'created_at', now());
end $$;

-- ── Manual backup (owner) ─────────────────────────────────────────────────────
create or replace function public.create_tenant_backup(p_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_role text;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can take a backup'; end if;
  return backup._take(v_tenant, coalesce(p_label, 'Manual backup'), 'manual');
end $$;

-- ── Auto daily restore point (owner) — no-op if a snapshot < 20h old exists ───
create or replace function public.auto_backup_if_stale()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_role text; v_last timestamptz;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null or coalesce(v_role,'') <> 'owner' then return jsonb_build_object('created', false); end if;
  select max(created_at) into v_last from backup.snapshots where tenant_id = v_tenant;
  if v_last is not null and v_last > now() - interval '20 hours' then
    return jsonb_build_object('created', false);
  end if;
  perform backup._take(v_tenant, 'Auto (daily)', 'auto');
  return jsonb_build_object('created', true);
end $$;

-- ── Restore to a chosen point (owner) — ATOMIC + reversible ───────────────────
create or replace function public.restore_tenant_backup(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_role text; v_payload jsonb; r record; col_list text; has_identity bool; n int := 0;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can restore'; end if;

  select payload into v_payload from backup.snapshots where id = p_id and tenant_id = v_tenant;
  if v_payload is null then raise exception 'Restore point not found'; end if;

  -- Safety point of the CURRENT state first, so the restore itself is undoable.
  perform backup._take(v_tenant, 'Before restore ' || to_char(now(), 'DD Mon HH24:MI'), 'auto');

  -- Bypass FK ordering + data triggers for the bulk replace. Whole function is one
  -- transaction: any error rolls the entire restore back (no partial data loss).
  set local session_replication_role = replica;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id'
      and c.table_name not in ('tenant_secrets','users')
    group by c.table_name order by c.table_name
  loop
    if not (v_payload ? r.table_name) then continue; end if;

    -- Insertable columns = everything except GENERATED ALWAYS (computed) columns.
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position), bool_or(is_identity = 'YES')
      into col_list, has_identity
    from information_schema.columns
    where table_schema='public' and table_name = r.table_name and is_generated <> 'ALWAYS';

    execute format('delete from public.%I where tenant_id = $1', r.table_name) using v_tenant;
    execute format(
      'insert into public.%I (%s) %s select %s from jsonb_populate_recordset(null::public.%I, $1)',
      r.table_name, col_list,
      case when has_identity then 'overriding system value' else '' end,
      col_list, r.table_name
    ) using (v_payload -> r.table_name);
    n := n + 1;
  end loop;

  set local session_replication_role = origin;
  return jsonb_build_object('restored_tables', n, 'restored_at', now());
end $$;

-- List now includes kind.
create or replace function public.list_tenant_backups()
returns table(id uuid, created_at timestamptz, label text, kind text, table_count int, bytes int)
language sql security definer set search_path = public as $$
  select s.id, s.created_at, s.label, s.kind, s.table_count, length(s.payload::text)
  from backup.snapshots s
  where s.tenant_id = (select tenant_id from public.users where id = auth.uid())
  order by s.created_at desc;
$$;

grant execute on function public.create_tenant_backup(text) to authenticated;
grant execute on function public.auto_backup_if_stale() to authenticated;
grant execute on function public.restore_tenant_backup(uuid) to authenticated;
grant execute on function public.list_tenant_backups() to authenticated;
