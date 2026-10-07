-- Regression test: the pre-reset shield fires BEFORE any delete (0241).
-- Every block rolls back — safe to run against any database, including prod.
--
-- Proves:
--   1. ORDER — after a reset, a 'pre_reset' snapshot exists AND the rows are gone,
--      from a single call. The snapshot is not an afterthought.
--   2. ATOMICITY — the snapshot holds the rows as they were BEFORE the delete, so
--      restoring it actually brings them back. A snapshot taken after the delete
--      would be the same size and completely worthless.
--   3. STATUTORY REFUSAL — invoices/attendance are refused without explicit
--      confirmation, and nothing is deleted when refused.
--   4. ALLOWLIST — a table not on the list is refused by name.
--   5. OWNER-ONLY — a non-owner cannot reset.
--
-- Point 2 is the one worth having. "A backup ran" and "a backup that can undo
-- this ran" are different claims, and only the second one matters at 2am.
--
-- Run by hand — NOT in CI, NOT in the Stop hook (CLAUDE.md §25.2).
-- (R-380, 7 Oct: CI now runs every file. The shield needs the backup schema, which the
--  baseline does not create — Cloud SQL gets it from cloudsql/06 — so on a database without
--  it the file reports NOT APPLICABLE, like backup_per_tenant.)
do $$
begin
  if to_regnamespace('backup') is null or to_regclass('backup.snapshots') is null then
    raise exception 'NOT APPLICABLE HERE: backup schema is database par nahi hai (baseline defect; Cloud SQL par cloudsql/06 se aata hai)';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 + 2) Snapshot exists, rows gone, and the snapshot still HOLDS those rows
-- ─────────────────────────────────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.tenants (id,name,email,state_code,doc_code) values
  ('5555aaaa-0000-0000-0000-000000000001','Shield Co','shield@s1.in','07','SH01');
insert into auth.users (id,email) values
  ('5555bbbb-0000-0000-0000-000000000001','owner@s1.in');
insert into public.users (id,tenant_id,email,full_name,role) values
  ('5555bbbb-0000-0000-0000-000000000001','5555aaaa-0000-0000-0000-000000000001','owner@s1.in','Owner','owner');
-- due_at is NOT NULL on tasks — checked, not assumed, after the first run failed.
insert into public.tasks (id,tenant_id,title,due_at) values
  (gen_random_uuid(),'5555aaaa-0000-0000-0000-000000000001','Task to be cleared', now()),
  (gen_random_uuid(),'5555aaaa-0000-0000-0000-000000000001','Second task', now());

do $$
declare r jsonb; n int; snap_kind text; snap_rows int; begin
  perform set_config('request.jwt.claims',
    '{"sub":"5555bbbb-0000-0000-0000-000000000001","role":"authenticated"}', true);

  r := public.reset_tenant_selected_tables(array['tasks'], 'shield test', false);

  -- (1) rows gone
  select count(*) into n from public.tasks
   where tenant_id='5555aaaa-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'FAIL 1: tasks not cleared, % left', n; end if;

  -- (1) and a pre_reset snapshot was written by the SAME call
  select kind into snap_kind from backup.snapshots where id = (r->>'backup_id')::uuid;
  if snap_kind is distinct from 'pre_reset' then
    raise exception 'FAIL 1: snapshot kind is %, expected pre_reset', snap_kind; end if;

  -- (2) THE point: the snapshot contains the rows that were just deleted.
  select jsonb_array_length(payload->'tasks') into snap_rows
    from backup.snapshots where id = (r->>'backup_id')::uuid;
  if coalesce(snap_rows,0) <> 2 then
    raise exception 'FAIL 2: snapshot holds % tasks, expected 2 — it was taken AFTER the delete and cannot undo it', coalesce(snap_rows,0);
  end if;

  raise notice 'PASS 1+2: snapshot taken before the delete, and it holds the deleted rows';
end $$;
rollback;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Statutory sections refused without explicit confirmation — and untouched
-- ─────────────────────────────────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.tenants (id,name,email,state_code,doc_code) values
  ('5555aaaa-0000-0000-0000-000000000002','Shield Co 2','shield@s2.in','07','SH02');
insert into auth.users (id,email) values
  ('5555bbbb-0000-0000-0000-000000000002','owner@s2.in');
insert into public.users (id,tenant_id,email,full_name,role) values
  ('5555bbbb-0000-0000-0000-000000000002','5555aaaa-0000-0000-0000-000000000002','owner@s2.in','Owner','owner');

/* No attendance fixture on purpose. The statutory guard runs BEFORE anything is
   read or written, so rows are not needed to prove it fires — and the stronger
   assertion is available without them: a refusal must leave NO snapshot behind
   either. A refused call that still wrote a "Pre-Reset Safeguard Snapshot" would
   mean the shield ran ahead of the guard, i.e. the order is wrong even though
   nothing was deleted this time. */
do $$ declare msg text; n int; begin
  perform set_config('request.jwt.claims',
    '{"sub":"5555bbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
  begin
    perform public.reset_tenant_selected_tables(array['attendance'], 'no confirm', false);
    raise exception 'FAIL 3: statutory reset went through WITHOUT confirmation';
  exception when others then
    msg := sqlerrm;
    if msg like 'FAIL 3:%' then raise; end if;
  end;
  if msg not like '%statutory%' then
    raise exception 'FAIL 3: wrong refusal reason: %', msg; end if;

  select count(*) into n from backup.snapshots
   where tenant_id='5555aaaa-0000-0000-0000-000000000002';
  if n <> 0 then
    raise exception 'FAIL 3: a snapshot was written for a call that was refused (% found)', n; end if;

  raise notice 'PASS 3: statutory refused, and no snapshot was taken';
end $$;
rollback;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4 + 5) Allowlist refuses unknown sections; non-owners refused
-- ─────────────────────────────────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.tenants (id,name,email,state_code,doc_code) values
  ('5555aaaa-0000-0000-0000-000000000003','Shield Co 3','shield@s3.in','07','SH03');
insert into auth.users (id,email) values
  ('5555bbbb-0000-0000-0000-000000000003','owner@s3.in'),
  ('5555bbbb-0000-0000-0000-000000000004','sales@s3.in');
insert into public.users (id,tenant_id,email,full_name,role) values
  ('5555bbbb-0000-0000-0000-000000000003','5555aaaa-0000-0000-0000-000000000003','owner@s3.in','Owner','owner'),
  ('5555bbbb-0000-0000-0000-000000000004','5555aaaa-0000-0000-0000-000000000003','sales@s3.in','Sales','sales');

do $$ declare msg text; begin
  -- 4) 'users' and 'payments' are the ones that must never be reachable
  perform set_config('request.jwt.claims',
    '{"sub":"5555bbbb-0000-0000-0000-000000000003","role":"authenticated"}', true);
  begin
    perform public.reset_tenant_selected_tables(array['users','payments'], 'off list', true);
    raise exception 'FAIL 4: an off-allowlist table was accepted';
  exception when others then
    msg := sqlerrm;
    if msg like 'FAIL 4:%' then raise; end if;
  end;
  if msg not like '%Not resettable%' then
    raise exception 'FAIL 4: wrong refusal reason: %', msg; end if;
  raise notice 'PASS 4: off-allowlist refused by name';

  -- 5) a sales user is not an owner
  perform set_config('request.jwt.claims',
    '{"sub":"5555bbbb-0000-0000-0000-000000000004","role":"authenticated"}', true);
  begin
    perform public.reset_tenant_selected_tables(array['tasks'], 'not owner', false);
    raise exception 'FAIL 5: a non-owner was allowed to reset';
  exception when others then
    msg := sqlerrm;
    if msg like 'FAIL 5:%' then raise; end if;
  end;
  if msg not like '%Only the owner%' then
    raise exception 'FAIL 5: wrong refusal reason: %', msg; end if;
  raise notice 'PASS 5: non-owner refused';
end $$;
rollback;
