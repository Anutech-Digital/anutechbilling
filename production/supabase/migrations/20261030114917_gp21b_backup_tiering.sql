-- deploy-peek: to_regprocedure('public.backup_tenant_tiered(uuid,integer,boolean,text)') is not null
-- R-2140 (GP-21b, goal G-PERSONAL) — nightly backup tiering for PERSONAL workspaces.
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
-- The nightly cron (lib/backup/per-tenant.ts) takes a full snapshot of EVERY tenant: ~134
-- tenant tables → one jsonb row in backup.snapshots, then an export + an off-site upload, and
-- 7 copies kept per tenant (20260928141000). Free personal workspaces (G-PERSONAL) will be
-- many, small and mostly idle. Taking them like a business tenant makes the 600 s Cloud Run
-- budget and the database size grow with FREE sign-ups.
--
-- `backup_tenant_tiered(tenant, keep, only_if_changed)`:
--   · business tenant (workspace_kind <> 'personal') → exactly `backup_tenant()` — the arguments
--     are ignored. The database, not only the caller, keeps business backups unchanged.
--   · personal tenant → builds the same payload as backup._take (same table list: every public
--     table with a tenant_id column except tenant_secrets, plus the tenants row), with each
--     table's rows in a fixed order so the same data always gives the same text. If
--     `only_if_changed` and the newest snapshot of this tenant has the same payload → nothing is
--     written; it returns {skipped: 'unchanged', snapshot_id}. Otherwise it stores a 'auto'
--     snapshot and keeps only the newest `keep` (clamped 1..7) for this tenant.
--
-- The policy (only-if-changed / keep one / skip) and the kept count are TypeScript constants
-- in lib/backup/tiering.ts (PERSONAL_BACKUP_POLICY, PERSONAL_SNAPSHOT_RETENTION) — the owner's
-- decision on R-2140; the code default is only-if-changed, keep 2.
--
-- The table loop mirrors backup._take (20260928141000_backup_per_tenant.sql:50-60). Change
-- both together; supabase/tests/gp21b_backup_tiering.test.sql compares the two key sets
-- wherever the real _take exists.
--
-- The `backup` schema is not in baseline.sql (Cloud SQL gets it from cloudsql/06). A plpgsql
-- body does not look tables up at create time, so this function is created everywhere.

create or replace function public.backup_tenant_tiered(
  p_tenant          uuid,
  p_keep            integer,
  p_only_if_changed boolean default true,
  p_label           text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_name    text;
  v_kind    text;
  v_keep    integer := least(greatest(coalesce(p_keep, 1), 1), 7);
  v_label   text := coalesce(nullif(btrim(p_label), ''),
                             'Automated Daily Backup - ' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'));
  r         record;
  v_payload jsonb;
  tbl_json  jsonb;
  n         integer := 0;
  v_prev_id uuid;
  v_prev_md5 text;
  v_id      uuid;
begin
  /* Same wall as backup_tenant: this reads ANY tenant's whole data. */
  if auth.uid() is not null or v_role in ('authenticated', 'anon') then
    raise exception 'backup_tenant_tiered is service_role only';
  end if;

  select name, workspace_kind into v_name, v_kind from public.tenants where id = p_tenant;
  if not found then
    raise exception 'backup_tenant_tiered: tenant % not found — read the tenants list again (it may have just been deleted)', p_tenant;
  end if;

  /* Business: never tiered. */
  if v_kind is distinct from 'personal' then
    return public.backup_tenant(p_tenant, p_label);
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)
    into tbl_json from public.tenants t where t.id = p_tenant;
  v_payload := jsonb_build_object('tenants', tbl_json); n := 1;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname = 'public' and pt.tablename = c.table_name
    where c.table_schema = 'public' and c.column_name = 'tenant_id'
      and c.table_name not in ('tenant_secrets')
    group by c.table_name order by c.table_name
  loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), ''[]''::jsonb) from public.%I t where t.tenant_id = $1',
      r.table_name)
      into tbl_json using p_tenant;
    v_payload := v_payload || jsonb_build_object(r.table_name, tbl_json);
    n := n + 1;
  end loop;

  if p_only_if_changed then
    select s.id, md5(s.payload::text) into v_prev_id, v_prev_md5
      from backup.snapshots s
     where s.tenant_id = p_tenant
     order by s.created_at desc, s.id desc
     limit 1;
    if v_prev_id is not null and v_prev_md5 = md5(v_payload::text) then
      return jsonb_build_object('skipped', 'unchanged', 'snapshot_id', v_prev_id,
                                'tenant_id', p_tenant, 'tenant_name', v_name,
                                'table_count', n, 'bytes', 0);
    end if;
  end if;

  /* clock_timestamp, not now(): two runs in one transaction (tests) must still order. */
  insert into backup.snapshots(tenant_id, label, kind, table_count, payload, created_at)
  values (p_tenant, v_label, 'auto', n, v_payload, clock_timestamp())
  returning id into v_id;

  delete from backup.snapshots s
   where s.tenant_id = p_tenant
     and s.id <> v_id
     and s.id not in (select id from backup.snapshots
                       where tenant_id = p_tenant order by created_at desc, id limit v_keep);

  return jsonb_build_object('id', v_id, 'table_count', n, 'bytes', length(v_payload::text),
                            'created_at', now(), 'tenant_id', p_tenant, 'tenant_name', v_name,
                            'label', v_label, 'kept', v_keep);
end;
$$;

comment on function public.backup_tenant_tiered(uuid, integer, boolean, text) is
  'R-2140 (GP-21b): nightly snapshot with tiering for personal workspaces — skip when unchanged since the newest snapshot, keep only p_keep (1..7). Business tenants = backup_tenant(). service_role only. Test: supabase/tests/gp21b_backup_tiering.test.sql';

revoke all on function public.backup_tenant_tiered(uuid, integer, boolean, text) from public;
revoke all on function public.backup_tenant_tiered(uuid, integer, boolean, text) from anon;
revoke all on function public.backup_tenant_tiered(uuid, integer, boolean, text) from authenticated;
grant execute on function public.backup_tenant_tiered(uuid, integer, boolean, text) to service_role;
