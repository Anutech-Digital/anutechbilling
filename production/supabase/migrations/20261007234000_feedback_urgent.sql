-- deploy-key: fburgent
-- deploy-peek: (exists (select 1 from information_schema.columns where table_schema='public' and table_name='feedback' and column_name='urgent_at') and exists (select 1 from information_schema.columns where table_schema='public' and table_name='feedback' and column_name='urgent_by'))
-- ============================================================================
-- R-397 (7 Oct 2026): "⚡ Urgent" on a bug report that is already with the AI.
--
-- Pardeep: "AI ko bhej diya, baad me lage urgent karwana hai to kaise manage karoge".
--
-- feedback.urgent_at   when an owner/manager (or the platform owner) marked it urgent.
--                      null = not urgent. /api/agent/feedback-queue hands urgent reports
--                      out FIRST, oldest-urgent first.
-- feedback.urgent_by   who pressed it (users.id / auth uid). No FK on purpose: the platform
--                      owner can mark another workspace's report, and their id is not a
--                      user of that tenant.
--
-- The app works WITHOUT this migration: the select("*") rows carry no urgent_at key, so the
-- button is not drawn; the queue's first read fails on the unknown column and falls back to
-- its R-357 read (order unchanged); POST /api/feedback/urgent answers 409 naming this file.
-- Nullable and additive; RLS unchanged — writes go through the server route with the
-- service role after it has checked role + tenant (or the platform allowlist).
-- ============================================================================

begin;

alter table public.feedback
  add column if not exists urgent_at timestamptz,
  add column if not exists urgent_by uuid;

comment on column public.feedback.urgent_at is
  'R-397: when the report was marked urgent (null = not urgent). The AI queue hands urgent reports out first.';
comment on column public.feedback.urgent_by is
  'R-397: who marked it urgent (auth uid). No FK: the platform owner may mark another workspace''s report.';

create index if not exists feedback_urgent_queue_idx
  on public.feedback (urgent_at)
  where urgent_at is not null and status = 'agent_queued';

commit;

-- ─── VERIFY (run separately) ────────────────────────────────────────────────
-- select column_name, data_type from information_schema.columns
--  where table_schema = 'public' and table_name = 'feedback'
--    and column_name in ('urgent_at', 'urgent_by');
