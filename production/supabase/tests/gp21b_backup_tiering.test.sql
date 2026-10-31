-- Regression test: backup_tenant_tiered() — R-2140 (GP-21b, goal G-PERSONAL).
--
-- WHY THIS FILE EXISTS
--   Free personal workspaces must not make the nightly backup (600 s Cloud Run budget) and
--   backup.snapshots grow with every free sign-up. A personal tenant is snapshotted only when
--   its data changed since its newest snapshot, and keeps fewer copies. What can silently break:
--     1. Access — the function reads ANY tenant's whole data: never from a browser session.
--     2. Skip — an unchanged personal tenant must write nothing; a changed one must be saved.
--     3. Retention — personal keeps only p_keep; never another tenant's rows.
--     4. Business — never tiered: every call is a full backup_tenant() snapshot (no skip).
--     5. Drift — the payload must carry the same tables as backup._take (restore reads it).
--   Needs migration 20261030114917_gp21b_backup_tiering.sql. The `backup` schema is not in
--   baseline.sql (Cloud SQL gets it from cloudsql/06), so when it is missing this file builds
--   the same table + _take (20260928141000 body) INSIDE the transaction — all rolled back.
--
-- SAFETY: own fixture tenants (L11), everything rolled back.

begin;

do $$
begin
  if to_regprocedure('public.backup_tenant(uuid,text)') is null then
    raise exception 'NOT APPLICABLE HERE: backup_tenant() missing (migration 20260928141000 not applied)';
  end if;
end $$;

create temp table gp21b_env(real_take boolean) on commit drop;
insert into gp21b_env values (to_regprocedure('backup._take(uuid,text,text)') is not null);

do $$
begin
  if to_regnamespace('backup') is null then
    create schema backup;
  end if;
  if to_regclass('backup.snapshots') is null then
    create table backup.snapshots (
      id          uuid primary key default gen_random_uuid(),
      created_at  timestamptz not null default now(),
      label       text,
      table_count int,
      payload     jsonb not null,
      tenant_id   uuid references public.tenants(id) on delete cascade,
      kind        text not null default 'manual'
    );
  end if;
end $$;

do $outer$
begin
  if to_regprocedure('backup._take(uuid,text,text)') is null then
    execute $fn$
create or replace function backup._take(p_tenant uuid, p_label text, p_kind text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  -- S15 (28 Sep 2026): newest 7 restore points per tenant (was 30). Mirrored in TypeScript
  -- as SNAPSHOT_RETENTION (lib/queries/backups.ts) — change both together.
  delete from backup.snapshots s
  where s.tenant_id = p_tenant
    and s.id not in (select id from backup.snapshots where tenant_id = p_tenant order by created_at desc limit 7);

  return jsonb_build_object('id', v_id, 'table_count', n, 'bytes', length(result::text), 'created_at', now());
end $function$
$fn$;
  end if;
end $outer$;

-- ── 1. GRANT ────────────────────────────────────────────────────────────────
do $$
declare f text := 'public.backup_tenant_tiered(uuid, integer, boolean, text)';
begin
  if to_regprocedure('public.backup_tenant_tiered(uuid,integer,boolean,text)') is null then
    raise exception 'FAIL 1: backup_tenant_tiered(uuid, integer, boolean, text) does not exist';
  end if;
  if has_function_privilege('anon', f, 'execute') then
    raise exception 'FAIL 1: anon can run %', f;
  end if;
  if has_function_privilege('authenticated', f, 'execute') then
    raise exception 'FAIL 1: authenticated can run % (any tenant whole data)', f;
  end if;
  if not has_function_privilege('service_role', f, 'execute') then
    raise exception 'FAIL 1: service_role cannot run % (the nightly backup would fail)', f;
  end if;
end $$;

-- Fixtures: one personal, one business tenant.
insert into public.tenants (id, name, email, workspace_kind)
values ('21b00000-0000-4000-8000-00000000000a', 'GP21b personal', 'gp21b-p@example.invalid', 'personal'),
       ('21b00000-0000-4000-8000-00000000000b', 'GP21b business', 'gp21b-b@example.invalid', 'business');

-- ── 2. BODY: browser session refused ────────────────────────────────────────
do $$
declare v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '3caa0f07-44d1-42ee-91b3-2123e04853b1', 'role', 'authenticated')::text, true);
  begin perform public.backup_tenant_tiered('21b00000-0000-4000-8000-00000000000a', 2, true, null);
  exception when others then v_msg := sqlerrm; end;
  if coalesce(v_msg, '') not like '%service_role only%' then
    raise exception 'FAIL 2: backup_tenant_tiered in an authenticated session: %', coalesce(v_msg, 'IT RAN');
  end if;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- The nightly cron calls it as service_role: it must run there (one call, no table reads).
set local role service_role;
do $$ begin perform public.backup_tenant_tiered('21b00000-0000-4000-8000-00000000000b', 2, true, null); end $$;
reset role;
delete from backup.snapshots where tenant_id = '21b00000-0000-4000-8000-00000000000b';

-- ── 3. SKIP: unchanged personal tenant writes nothing; changed one is saved ──
do $$
declare
  p uuid := '21b00000-0000-4000-8000-00000000000a';
  r jsonb; n int; v_first uuid;
begin
  r := public.backup_tenant_tiered(p, 2, true, null);
  if r ? 'skipped' or r->>'id' is null then
    raise exception 'FAIL 3: first personal backup was not taken: %', r;
  end if;
  v_first := (r->>'id')::uuid;

  r := public.backup_tenant_tiered(p, 2, true, null);
  if r->>'skipped' is distinct from 'unchanged' or (r->>'snapshot_id')::uuid <> v_first then
    raise exception 'FAIL 3: unchanged personal tenant was NOT skipped: %', r;
  end if;
  select count(*) into n from backup.snapshots where tenant_id = p;
  if n <> 1 then
    raise exception 'FAIL 3: a skipped run still wrote a snapshot (% rows, want 1)', n;
  end if;
end $$;

update public.tenants set name = 'GP21b personal (renamed)' where id = '21b00000-0000-4000-8000-00000000000a';

do $$
declare p uuid := '21b00000-0000-4000-8000-00000000000a'; r jsonb; n int;
begin
  r := public.backup_tenant_tiered(p, 2, true, null);
  if r ? 'skipped' then
    raise exception 'FAIL 3: a CHANGED personal tenant was skipped: %', r;
  end if;
  select count(*) into n from backup.snapshots where tenant_id = p;
  if n <> 2 then
    raise exception 'FAIL 3: changed personal tenant: % snapshots, want 2', n;
  end if;
  if (select payload->'tenants'->0->>'name' from backup.snapshots where id = (r->>'id')::uuid)
     <> 'GP21b personal (renamed)' then
    raise exception 'FAIL 3: the new snapshot does not carry the change';
  end if;
end $$;

-- ── 4. RETENTION: keep only p_keep for the personal tenant, never others ────
do $$
declare p uuid := '21b00000-0000-4000-8000-00000000000a'; b uuid := '21b00000-0000-4000-8000-00000000000b';
        r jsonb; n int; nb int;
begin
  r := public.backup_tenant(b, 'business only');           -- another tenant's row must survive
  for i in 1..4 loop
    r := public.backup_tenant_tiered(p, 2, false, null);    -- forced (policy keep-one passes false)
  end loop;
  select count(*) into n from backup.snapshots where tenant_id = p;
  if n <> 2 then
    raise exception 'FAIL 4: personal tenant keeps % snapshots, want 2 (p_keep)', n;
  end if;
  if not exists (select 1 from backup.snapshots where id = (r->>'id')::uuid) then
    raise exception 'FAIL 4: retention deleted the snapshot it just took';
  end if;
  select count(*) into nb from backup.snapshots where tenant_id = b;
  if nb <> 1 then
    raise exception 'FAIL 4: personal retention touched the business tenant (% rows, want 1)', nb;
  end if;
  r := public.backup_tenant_tiered(p, 99, false, null);
  if (r->>'kept')::int <> 7 then
    raise exception 'FAIL 4: p_keep is not clamped to 7: %', r->>'kept';
  end if;
end $$;

-- ── 5. BUSINESS: never tiered — two unchanged calls = two full snapshots ─────
do $$
declare b uuid := '21b00000-0000-4000-8000-00000000000b'; r jsonb; n int;
begin
  r := public.backup_tenant_tiered(b, 1, true, null);
  if r ? 'skipped' then raise exception 'FAIL 5: business tenant skipped: %', r; end if;
  r := public.backup_tenant_tiered(b, 1, true, null);
  if r ? 'skipped' then raise exception 'FAIL 5: unchanged business tenant skipped: %', r; end if;
  if r->>'label' not like 'Automated Daily Backup - %' or (r->>'tenant_id')::uuid <> b then
    raise exception 'FAIL 5: business answer is not the backup_tenant() one: %', r;
  end if;
  select count(*) into n from backup.snapshots where tenant_id = b;
  if n <> 3 then
    raise exception 'FAIL 5: business tenant has % snapshots, want 3 (p_keep must be ignored)', n;
  end if;
end $$;

-- ── 6. DRIFT: same tables as backup._take (only meaningful against the real _take) ──
do $$
declare p uuid := '21b00000-0000-4000-8000-00000000000a'; v_take uuid; k_take text; k_tier text;
begin
  if not (select real_take from gp21b_env) then
    raise notice 'gp21b: drift check skipped (backup._take was built by this test, no backup schema here)';
    return;
  end if;
  v_take := (backup._take(p, 'drift probe', 'manual')->>'id')::uuid;
  select string_agg(k, ',' order by k) into k_take
    from backup.snapshots s, jsonb_object_keys(s.payload) k where s.id = v_take;
  select string_agg(k, ',' order by k) into k_tier
    from (select payload from backup.snapshots where tenant_id = p and kind = 'auto'
           order by created_at desc limit 1) s, jsonb_object_keys(s.payload) k;
  if k_take is distinct from k_tier then
    raise exception 'FAIL 6: tiered payload tables differ from backup._take (change both together)';
  end if;
end $$;

do $$ begin raise notice 'gp21b_backup_tiering: all checks passed'; end $$;

rollback;
