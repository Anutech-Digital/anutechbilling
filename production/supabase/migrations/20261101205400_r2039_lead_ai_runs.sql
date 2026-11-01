-- deploy-peek: to_regclass('public.lead_ai_runs') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leads' and column_name = 'ai_status_at')
-- deploy-key: r2039leadairuns
-- 20261101205400_r2039_lead_ai_runs.sql
--
-- R-2039 (AI Lead Workflow A, plan approved by Pardeep 27 Oct 2026): one visible AI run per lead.
-- POST /api/leads/[id]/ai-workflow (src/lib/leads/ai-workflow.server.ts) enriches the lead from
-- its own website (Lead Finder helpers), qualifies it with the AI, and saves a 2-line pitch as an
-- email DRAFT — nothing is sent (a person approves the send, R-2040). Each step is written here
-- and on the lead's timeline (lead_activities).
--
-- WHAT IS HERE
--   lead_ai_runs      one row per run. step = where it is now:
--                       fetching → qualified | unqualified → draft_ready  (this card)
--                       sent, call_scheduled, call_done                   (R-2040 / R-2041)
--                       failed (error + next_step say what went wrong and what to do)
--                     finished_at IS NULL = running. The partial unique index allows ONE running
--                     run per lead, so a double click cannot start two (the second POST gets the
--                     running one back).
--   leads.ai_status / ai_status_at — the latest run's step, for list badges (R-2042).
--
-- RLS: SELECT only for signed-in users — same tenant (current_tenant_id(), InitPlan-wrapped) AND
-- the lead itself is visible to the caller (the leads hierarchy / R-1401 policies apply inside
-- the EXISTS), so a pitch never shows to a login that cannot open the lead. Plus the G-PERSONAL
-- wall (gp09_personal_wall, RESTRICTIVE, SELECT). No insert/update/delete for authenticated:
-- the server writes with the service role (zzz_service_role_all, R-450 — Cloud SQL has no
-- BYPASSRLS). No money in this table, so no books-lock trigger.
-- Test: supabase/tests/r2039_lead_ai_runs_rls.sql. Re-runnable.

begin;

create table if not exists public.lead_ai_runs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  lead_id        text not null references public.leads(id) on delete cascade,
  step           text not null default 'fetching'
                 check (step in ('fetching', 'qualified', 'unqualified', 'draft_ready', 'sent',
                                 'call_scheduled', 'call_done', 'failed')),
  -- {verdict: 'qualified'|'unqualified', reasons: [text]}
  qualify_result jsonb check (qualify_result is null or (
                   jsonb_typeof(qualify_result) = 'object'
                   and qualify_result ->> 'verdict' in ('qualified', 'unqualified')
                   and jsonb_typeof(qualify_result -> 'reasons') = 'array')),
  -- what enrichment filled on the lead, e.g. {"filled": {"contact_phone": "…"}, "source": "https://…"}
  enrich_result  jsonb,
  pitch          text check (pitch is null or char_length(pitch) <= 2000),
  draft_subject  text check (draft_subject is null or char_length(draft_subject) <= 200),
  error          text check (error is null or char_length(error) <= 1000),
  next_step      text check (next_step is null or char_length(next_step) <= 500),
  started_by     uuid references public.users(id) on delete set null,
  started_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz,
  constraint lead_ai_runs_failed_says_why check (step <> 'failed' or (error is not null and finished_at is not null))
);

comment on table public.lead_ai_runs is
  'R-2039: one AI Lead Workflow run per lead (enrich → qualify → pitch as an email draft). finished_at null = running; one running run per lead. Written by the server (service role) only.';

create unique index if not exists lead_ai_runs_one_running_uq
  on public.lead_ai_runs (tenant_id, lead_id) where finished_at is null;
create index if not exists lead_ai_runs_lead_time_idx
  on public.lead_ai_runs (tenant_id, lead_id, started_at desc);

alter table public.leads add column if not exists ai_status text;
alter table public.leads add column if not exists ai_status_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_ai_status_check' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_ai_status_check check (ai_status is null or ai_status in
      ('fetching', 'qualified', 'unqualified', 'draft_ready', 'sent', 'call_scheduled', 'call_done', 'failed'));
  end if;
end $$;

alter table public.lead_ai_runs enable row level security;

drop policy if exists "tenant isolation read" on public.lead_ai_runs;
create policy "tenant isolation read" on public.lead_ai_runs for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and exists (select 1 from public.leads l where l.id = lead_ai_runs.lead_id and l.tenant_id = lead_ai_runs.tenant_id)
  );

drop policy if exists gp09_personal_wall on public.lead_ai_runs;
create policy gp09_personal_wall on public.lead_ai_runs as restrictive for select to authenticated
  using (not (select public.is_personal_session()));

drop policy if exists zzz_service_role_all on public.lead_ai_runs;
create policy zzz_service_role_all on public.lead_ai_runs as permissive for all to service_role
  using (true) with check (true);

revoke all on public.lead_ai_runs from anon, authenticated;
grant select on public.lead_ai_runs to authenticated;
grant all on public.lead_ai_runs to service_role;

commit;
