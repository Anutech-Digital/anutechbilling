-- deploy-peek: to_regclass('public.automation_jobs') is not null and exists(select 1 from pg_policy where polname = 'automation_jobs_update_owner' and polrelid = to_regclass('public.automation_jobs')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.automation_state(text,uuid)') and prosrc like '%R-897%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.automation_allowed(text,uuid)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.automation_cron_tenants(text)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.automation_record_run(text,uuid[],text)'))
-- deploy-key: r897automation
-- 20261012023000_r897_automation_gate.sql
--
-- R-897 (P1 LAUNCH BLOCKER, 11 Oct 2026 — manager + HQ under Pardeep's delegation):
-- the in-app automation gate.
--
-- ══ WHY ══════════════════════════════════════════════════════════════════════════
--   The app had no off switch for its scheduled jobs. Each of the cron routes ran whatever
--   Cloud Scheduler called, and the only brake was a Google Cloud console. After the
--   17 Oct cutover nothing customer-facing may run until the owner turns it on himself.
--
-- ══ WHAT ═════════════════════════════════════════════════════════════════════════
--   automation_jobs — one row per (company, job). job = a cron name ('invoice-dunning', …)
--     or the global switch 'customer_messages' (every customer email / WhatsApp).
--     enabled  default FALSE, dry_run default FALSE. A MISSING ROW MEANS OFF.
--     NOTHING in this migration inserts a row, and nothing turns anything on.
--   RLS: owner and manager may READ their own company's rows (the /automation page);
--     only the OWNER may insert or change them (enabled / dry_run columns only).
--     Sales, support, manager, everyone else: refused. Service role has its own policy
--     (Cloud SQL has no BYPASSRLS).
--   automation_state(job, tenant)   → 'off' | 'dry_run' | 'on'
--   automation_allowed(job, tenant) → state = 'on'
--     Missing row = off. The workspace AI kill switch (tenants.ai_kill_switch) = off.
--     No company = off. A signed-in caller can only ask about its own company; the tenant
--     parameter is honoured only for the service role / a direct DB session (cron).
--   automation_cron_tenants(job)    → the companies where the job is ON or in dry run
--     (kill switch respected). Service role only.
--   automation_record_run(job, tenants[], result) → stamps last_run_at / last_result.
--     Inserts a missing row with enabled = false (never on). Service role only.
--   Every change of enabled / dry_run is written to activity_log (entity 'automation_job'),
--     with only those two fields in `changes` — nothing secret is ever in this table.
--
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161).
-- Test: supabase/tests/r897_automation_gate.test.sql (rolled back).

begin;

create table if not exists public.automation_jobs (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  job          text        not null check (job ~ '^[a-z0-9_-]{1,64}$'),
  enabled      boolean     not null default false,
  dry_run      boolean     not null default false,
  last_run_at  timestamptz,
  last_result  text        check (last_result is null or length(last_result) <= 500),
  changed_by   uuid        references public.users(id) on delete set null,
  changed_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint automation_jobs_tenant_job_key unique (tenant_id, job)
);

comment on table public.automation_jobs is
  'R-897: per-company ON/OFF + dry run for every scheduled job and the customer_messages switch. Missing row = OFF.';

create index if not exists automation_jobs_job_idx on public.automation_jobs (job) where enabled;

alter table public.automation_jobs enable row level security;

drop policy if exists automation_jobs_select_owner_manager on public.automation_jobs;
drop policy if exists automation_jobs_insert_owner         on public.automation_jobs;
drop policy if exists automation_jobs_update_owner         on public.automation_jobs;
drop policy if exists zzz_service_role_all                 on public.automation_jobs;

create policy automation_jobs_select_owner_manager on public.automation_jobs
  for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager'));

create policy automation_jobs_insert_owner on public.automation_jobs
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner'));

create policy automation_jobs_update_owner on public.automation_jobs
  for update to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner'))
  with check (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner'));

-- No delete policy: turning a job off is an UPDATE, so the history of who did it stays.
create policy zzz_service_role_all on public.automation_jobs
  as permissive for all to service_role using (true) with check (true);

revoke all on public.automation_jobs from anon, authenticated;
grant select on public.automation_jobs to authenticated;
grant insert (tenant_id, job, enabled, dry_run) on public.automation_jobs to authenticated;
grant update (enabled, dry_run) on public.automation_jobs to authenticated;
grant select, insert, update, delete on public.automation_jobs to service_role;


-- ── Who changed it, and when (BEFORE) ───────────────────────────────────────────
create or replace function public.automation_jobs_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  /* R-897: only a change of the switch itself is stamped — a cron writing last_run_at must
     not look like somebody touched the setting. */
  if tg_op = 'INSERT'
     or new.enabled is distinct from old.enabled
     or new.dry_run is distinct from old.dry_run then
    new.changed_at := now();
    new.changed_by := (select u.id from public.users u where u.id = auth.uid() and u.tenant_id = new.tenant_id);
  elsif tg_op = 'UPDATE' then
    new.changed_at := old.changed_at;
    new.changed_by := old.changed_by;
  end if;
  return new;
end
$function$;

revoke all on function public.automation_jobs_stamp() from public, anon, authenticated;

drop trigger if exists trg_automation_jobs_stamp on public.automation_jobs;
create trigger trg_automation_jobs_stamp
  before insert or update on public.automation_jobs
  for each row execute function public.automation_jobs_stamp();


-- ── Every change → activity_log (AFTER) ─────────────────────────────────────────
create or replace function public.automation_jobs_log_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_old_enabled boolean := case when tg_op = 'INSERT' then false else old.enabled end;
  v_old_dry     boolean := case when tg_op = 'INSERT' then false else old.dry_run end;
  v_changes     jsonb   := '{}'::jsonb;
  v_label       text;
begin
  /* R-897: only enabled / dry_run are recorded — never last_result or anything else, so a
     cron's result text can never carry something into the audit log. An INSERT that leaves
     both at false (a cron stamping its first run) is not a change and is not logged. */
  if new.enabled is distinct from v_old_enabled then
    v_changes := v_changes || jsonb_build_object('enabled', jsonb_build_object('old', v_old_enabled, 'new', new.enabled));
  end if;
  if new.dry_run is distinct from v_old_dry then
    v_changes := v_changes || jsonb_build_object('dry_run', jsonb_build_object('old', v_old_dry, 'new', new.dry_run));
  end if;
  if v_changes = '{}'::jsonb then return null; end if;

  v_label := new.job || ': ' || case when not new.enabled then 'off'
                                     when new.dry_run then 'on (dry run — sends nothing)'
                                     else 'on' end;

  insert into public.activity_log (tenant_id, user_id, actor_label, action, entity, entity_id, label, changes)
  values (new.tenant_id, new.changed_by,
          case when new.changed_by is null then 'System' else null end,
          'update', 'automation_job', new.job, left(v_label, 120), v_changes);
  return null;
end
$function$;

revoke all on function public.automation_jobs_log_change() from public, anon, authenticated;

drop trigger if exists trg_automation_jobs_log on public.automation_jobs;
create trigger trg_automation_jobs_log
  after insert or update on public.automation_jobs
  for each row execute function public.automation_jobs_log_change();


-- ── The gate ────────────────────────────────────────────────────────────────────
create or replace function public.automation_state(p_job text, p_tenant uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  /* R-897: trusted = service_role (cron, webhooks) or a direct DB session with no request
     role (psql / scripts) — same rule as R-454 / R-718. */
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_tenant  uuid := public.current_tenant_id();
  v_killed  boolean;
  v_row     public.automation_jobs;
begin
  if p_tenant is not null then
    -- A signed-in user may only ask about their own company; anything else is "off".
    if not v_trusted and p_tenant is distinct from v_tenant then return 'off'; end if;
    v_tenant := p_tenant;
  end if;
  if v_tenant is null or coalesce(trim(p_job), '') = '' then return 'off'; end if;

  select t.ai_kill_switch into v_killed from public.tenants t where t.id = v_tenant;
  if not found or coalesce(v_killed, true) then return 'off'; end if;

  select * into v_row from public.automation_jobs j where j.tenant_id = v_tenant and j.job = p_job;
  if not found or not v_row.enabled then return 'off'; end if;
  if v_row.dry_run then return 'dry_run'; end if;
  return 'on';
end
$function$;

create or replace function public.automation_allowed(p_job text, p_tenant uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  /* R-897: true only when the job is ON and not in dry run. Missing row = false. */
  select public.automation_state(p_job, p_tenant) = 'on';
$function$;

revoke all on function public.automation_state(text, uuid)   from public, anon;
revoke all on function public.automation_allowed(text, uuid) from public, anon;
grant execute on function public.automation_state(text, uuid)   to authenticated, service_role;
grant execute on function public.automation_allowed(text, uuid) to authenticated, service_role;


-- ── For the crons: where is this job ON (or in dry run)? ───────────────────────
create or replace function public.automation_cron_tenants(p_job text)
returns table (tenant_id uuid, dry_run boolean)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
begin
  /* R-897 */
  if not v_trusted then
    raise exception 'Only the scheduler can list where a job is on' using errcode = '42501';
  end if;
  return query
    select j.tenant_id, j.dry_run
      from public.automation_jobs j
      join public.tenants t on t.id = j.tenant_id
     where j.job = p_job
       and j.enabled
       and not coalesce(t.ai_kill_switch, true)
     order by j.tenant_id;
end
$function$;

create or replace function public.automation_record_run(p_job text, p_tenants uuid[], p_result text)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_n integer;
begin
  /* R-897: stamps the run. A missing row is created with enabled = false — never on. */
  if not v_trusted then
    raise exception 'Only the scheduler can record a run' using errcode = '42501';
  end if;
  insert into public.automation_jobs (tenant_id, job, last_run_at, last_result)
  select distinct x, p_job, now(), left(coalesce(p_result, ''), 500)
    from unnest(coalesce(p_tenants, '{}'::uuid[])) x
    join public.tenants t on t.id = x
  on conflict (tenant_id, job) do update
    set last_run_at = excluded.last_run_at,
        last_result = excluded.last_result;
  get diagnostics v_n = row_count;
  return v_n;
end
$function$;

-- ── For the /automation page: the owner flips a switch ──────────────────────────
create or replace function public.set_automation_job(p_job text, p_enabled boolean, p_dry_run boolean)
returns public.automation_jobs
language plpgsql
security invoker            -- RLS decides: owner only. This only gives the refusal a sentence.
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row    public.automation_jobs;
begin
  /* R-897 */
  if v_tenant is null then
    raise exception 'No company context — sign in again.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only the owner can turn automations on or off. Ask your owner to change it.' using errcode = '42501';
  end if;
  if coalesce(p_job, '') !~ '^[a-z0-9_-]{1,64}$' then
    raise exception 'Unknown automation.' using errcode = '22023';
  end if;
  insert into public.automation_jobs (tenant_id, job, enabled, dry_run)
  values (v_tenant, p_job, coalesce(p_enabled, false), coalesce(p_dry_run, false))
  on conflict (tenant_id, job) do update
    set enabled = excluded.enabled,
        dry_run = excluded.dry_run
  returning * into v_row;
  return v_row;
end
$function$;

revoke all on function public.set_automation_job(text, boolean, boolean) from public, anon;
grant execute on function public.set_automation_job(text, boolean, boolean) to authenticated;

revoke all on function public.automation_cron_tenants(text)            from public, anon, authenticated;
revoke all on function public.automation_record_run(text, uuid[], text) from public, anon, authenticated;
grant execute on function public.automation_cron_tenants(text)            to service_role;
grant execute on function public.automation_record_run(text, uuid[], text) to service_role;

commit;
