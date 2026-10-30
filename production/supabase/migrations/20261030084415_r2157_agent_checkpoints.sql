-- deploy-peek: to_regclass('agent_checkpoints.checkpoints') is not null and to_regclass('agent_checkpoints.writes') is not null and exists(select 1 from pg_policies where schemaname = 'agent_checkpoints' and tablename = 'writes' and policyname = 'zzz_service_role_all')
-- deploy-key: r2157agentcheckpoints
-- 20261030084415_r2157_agent_checkpoints.sql
--
-- R-2157 (30 Oct 2026, goal G-ADS-AI, card AI-01 — LangGraph.js foundation): where the
-- marketing agent graph (Xeno → Pixeo → review → publish → monitor) saves its checkpoints,
-- so a run can stop at a human approval (interrupt) and carry on hours later, on another
-- server instance, from exactly where it stopped.
--
-- ─── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--   schema agent_checkpoints  — its own schema (plan: "Postgres checkpointer, own schema"),
--                               so graph internals never mix with business tables.
--   agent_checkpoints.checkpoints — one row per graph step: the serialized checkpoint and
--                               its metadata (LangGraph serde: type + bytes), the parent step.
--   agent_checkpoints.writes  — the pending writes of a step (node outputs, interrupts,
--                               resume values), keyed (task_id, idx) as LangGraph expects.
--
-- ─── ONE THREAD = ONE ad_plans ROW ──────────────────────────────────────────
-- thread_id is the ad_plans.id the graph works on (plan: "reuse ad_plans as the campaign
-- row"). The FK is composite (tenant_id, thread_id) → ad_plans (tenant_id, id), so a
-- checkpoint can never sit under another company's plan, even if a request types that id.
-- Deleting a plan deletes its checkpoints.
--
-- ─── WHO ────────────────────────────────────────────────────────────────────
-- Same company AND role owner or marketing (card R-2157: "role owner/marketing") — narrower
-- than ad_plans (which also lets managers in): the agent will later propose spend, so only
-- the people who approve spend run it. current_user_has_role() also drops deactivated users
-- and MFA users without the second step (R-722, R-731). The app does NOT use a separate
-- pg pool for this: the checkpointer writes through withTenant (app_runtime → authenticated),
-- so RLS here is the real lock, not just a second one.
-- The server (service_role) has its own policy (R-450, Cloud SQL has no BYPASSRLS) — the
-- monitor cron (a later card) wakes threads of every company.
--
-- No functions, no data changed.
-- Test: supabase/tests/r2157_agent_checkpoints.test.sql

begin;

create schema if not exists agent_checkpoints;
revoke all on schema agent_checkpoints from public;
grant usage on schema agent_checkpoints to authenticated, service_role;

-- ── checkpoints ──────────────────────────────────────────────────────────────
create table if not exists agent_checkpoints.checkpoints (
  tenant_id             uuid not null,
  thread_id             uuid not null,
  checkpoint_ns         text not null default '' check (char_length(checkpoint_ns) <= 500),
  checkpoint_id         text not null check (char_length(checkpoint_id) between 1 and 100),
  parent_checkpoint_id  text check (parent_checkpoint_id is null or char_length(parent_checkpoint_id) between 1 and 100),
  checkpoint_type       text not null check (char_length(checkpoint_type) between 1 and 40),
  checkpoint            bytea not null,
  metadata_type         text not null check (char_length(metadata_type) between 1 and 40),
  metadata              bytea not null,
  created_by            uuid default auth.uid(),
  created_at            timestamptz not null default now(),
  primary key (tenant_id, thread_id, checkpoint_ns, checkpoint_id),
  constraint agent_checkpoints_plan_fk foreign key (tenant_id, thread_id)
    references public.ad_plans (tenant_id, id) on delete cascade
);

comment on table agent_checkpoints.checkpoints is
  'R-2157: LangGraph checkpoints of the marketing agent. thread_id = ad_plans.id. Owner / marketing of the same company only.';

create index if not exists agent_checkpoints_latest_idx
  on agent_checkpoints.checkpoints (tenant_id, thread_id, checkpoint_ns, checkpoint_id desc);

-- ── writes ───────────────────────────────────────────────────────────────────
create table if not exists agent_checkpoints.writes (
  tenant_id      uuid not null,
  thread_id      uuid not null,
  checkpoint_ns  text not null default '' check (char_length(checkpoint_ns) <= 500),
  checkpoint_id  text not null check (char_length(checkpoint_id) between 1 and 100),
  task_id        text not null check (char_length(task_id) between 1 and 200),
  idx            integer not null,
  channel        text not null check (char_length(channel) between 1 and 200),
  value_type     text not null check (char_length(value_type) between 1 and 40),
  value          bytea not null,
  created_at     timestamptz not null default now(),
  primary key (tenant_id, thread_id, checkpoint_ns, checkpoint_id, task_id, idx),
  constraint agent_checkpoint_writes_plan_fk foreign key (tenant_id, thread_id)
    references public.ad_plans (tenant_id, id) on delete cascade
);

comment on table agent_checkpoints.writes is
  'R-2157: LangGraph pending writes (node outputs, interrupts, resume values) per checkpoint. Owner / marketing of the same company only.';

-- ── RLS: same company AND owner / marketing ─────────────────────────────────
alter table agent_checkpoints.checkpoints enable row level security;
alter table agent_checkpoints.writes enable row level security;

drop policy if exists r2157_agent_team on agent_checkpoints.checkpoints;
create policy r2157_agent_team on agent_checkpoints.checkpoints as permissive for all to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'marketing')))
  with check (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'marketing')));

drop policy if exists r2157_agent_team on agent_checkpoints.writes;
create policy r2157_agent_team on agent_checkpoints.writes as permissive for all to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'marketing')))
  with check (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'marketing')));

-- Cloud SQL has no BYPASSRLS: the server (service_role) needs its own policy (R-450).
drop policy if exists zzz_service_role_all on agent_checkpoints.checkpoints;
create policy zzz_service_role_all on agent_checkpoints.checkpoints as permissive for all to service_role
  using (true) with check (true);
drop policy if exists zzz_service_role_all on agent_checkpoints.writes;
create policy zzz_service_role_all on agent_checkpoints.writes as permissive for all to service_role
  using (true) with check (true);

-- Grants (cloudsql/09 only walks the public schema, so they are written here).
revoke all on agent_checkpoints.checkpoints, agent_checkpoints.writes from public, anon;
grant select, insert, update, delete on agent_checkpoints.checkpoints, agent_checkpoints.writes to authenticated, service_role;

commit;
