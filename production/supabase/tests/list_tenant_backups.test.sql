-- R-823: list_tenant_backups() must run (it raised 42702 "column reference id is
-- ambiguous" on every call → HTTP 400 on /settings/backup) and must still show an owner
-- only their own tenant's snapshots, refuse a non-owner, and return nothing for a caller
-- with no users row. Asserts the LIVE function (apply
-- 20261010223000_list_tenant_backups_ambiguous_id.sql first). Self-asserting; rolled back.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/list_tenant_backups.test.sql
--
-- Expect "PASS list_tenant_backups". Before the migration it fails with
-- "column reference "id" is ambiguous".
--
-- Local Supabase has no `backup` schema (it lives on Cloud SQL — cloudsql/06-…), so the
-- test creates a minimal one when it is missing. All of it is rolled back.

begin;

create schema if not exists backup;
create table if not exists backup.snapshots (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  label       text,
  kind        text,
  table_count int,
  payload     jsonb not null,
  tenant_id   uuid
);

insert into auth.users (id, email) values
  ('e8230000-0000-4000-8000-00000000000a', 'r823-owner-a@example.test'),
  ('e8230000-0000-4000-8000-00000000000b', 'r823-sales-a@example.test'),
  ('e8230000-0000-4000-8000-00000000000c', 'r823-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e8230000-0000-0000-0000-0000000000a1', 'R823 A', 'r823a@example.in', '07', 'R823A'),
  ('e8230000-0000-0000-0000-0000000000b1', 'R823 B', 'r823b@example.in', '07', 'R823B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e8230000-0000-4000-8000-00000000000a', 'e8230000-0000-0000-0000-0000000000a1', 'r823-owner-a@example.in', 'R823 Owner A', 'owner', true),
  ('e8230000-0000-4000-8000-00000000000b', 'e8230000-0000-0000-0000-0000000000a1', 'r823-sales-a@example.in', 'R823 Sales A', 'sales', true),
  ('e8230000-0000-4000-8000-00000000000c', 'e8230000-0000-0000-0000-0000000000b1', 'r823-owner-b@example.in', 'R823 Owner B', 'owner', true);

insert into backup.snapshots (id, tenant_id, label, kind, table_count, payload, created_at) values
  ('e8230000-0000-4000-8000-0000000000f1', 'e8230000-0000-0000-0000-0000000000a1', 'A old', 'manual', 3, '{"x":1}', now() - interval '2 days'),
  ('e8230000-0000-4000-8000-0000000000f2', 'e8230000-0000-0000-0000-0000000000a1', 'A new', 'auto',   3, '{"x":2}', now() - interval '1 day'),
  ('e8230000-0000-4000-8000-0000000000f3', 'e8230000-0000-0000-0000-0000000000b1', 'B',     'manual', 3, '{"x":3}', now());

create temp table r823_result (who text, n int, first_label text, other_tenant int, refused text);
grant all on r823_result to authenticated;

-- ── 1. Owner A: own two snapshots, newest first, none of B's ─────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e8230000-0000-4000-8000-00000000000a"}', true);
select set_config('request.jwt.claim.sub', 'e8230000-0000-4000-8000-00000000000a', true);
insert into r823_result (who, n, first_label, other_tenant)
  select 'ownerA', count(*), (array_agg(label order by created_at desc))[1],
         count(*) filter (where id = 'e8230000-0000-4000-8000-0000000000f3')
    from public.list_tenant_backups();
reset role;

-- ── 2. Sales A (same tenant, not owner): refused ─────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e8230000-0000-4000-8000-00000000000b"}', true);
select set_config('request.jwt.claim.sub', 'e8230000-0000-4000-8000-00000000000b', true);
do $$
begin
  perform count(*) from public.list_tenant_backups();
  insert into r823_result (who, refused) values ('salesA', 'no');
exception when insufficient_privilege then
  insert into r823_result (who, refused) values ('salesA', 'yes');
end $$;
reset role;

-- ── 3. A signed-in id with no users row: refused or empty, never rows ────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e8230000-0000-4000-8000-0000000000ee"}', true);
select set_config('request.jwt.claim.sub', 'e8230000-0000-4000-8000-0000000000ee', true);
do $$
declare v int;
begin
  select count(*) into v from public.list_tenant_backups();
  insert into r823_result (who, n, refused) values ('nobody', v, 'no');
exception when insufficient_privilege then
  insert into r823_result (who, n, refused) values ('nobody', 0, 'yes');
end $$;
reset role;

do $$
declare r record;
begin
  select * into r from r823_result where who = 'ownerA';
  if r.n is distinct from 2 then raise exception 'FAIL ownerA: % rows, expected 2', r.n; end if;
  if r.first_label is distinct from 'A new' then raise exception 'FAIL ownerA: newest first, got %', r.first_label; end if;
  if r.other_tenant <> 0 then raise exception 'FAIL ownerA: saw tenant B''s snapshot'; end if;

  select * into r from r823_result where who = 'salesA';
  if r.refused is distinct from 'yes' then raise exception 'FAIL salesA: non-owner was not refused'; end if;

  select * into r from r823_result where who = 'nobody';
  if r.n <> 0 then raise exception 'FAIL nobody: % rows for a caller with no users row', r.n; end if;

  raise notice 'PASS list_tenant_backups';
end $$;

rollback;
