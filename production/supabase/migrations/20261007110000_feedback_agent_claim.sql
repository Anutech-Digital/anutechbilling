-- ============================================================================
-- R-357 (7 Oct 2026): bug report -> AI fix, fully automatic.
--
-- Pardeep: "ye sab full automation par hona chahiye automatic". Two additive pieces:
--
-- tenants.feedback_auto_send   workspace switch "Auto-send new reports to AI" (default ON).
--                              ON: a new report goes to the AI queue as soon as it is triaged,
--                              no Run AI Auto-Fix press. Owner flips it on /admin/feedback.
-- feedback.agent_card          the board card (R-123) the AI worker made for this report.
-- feedback.agent_claimed_at    when it did. Set by POST /api/agent/feedback-claimed; the
--                              queue stops handing out a claimed report.
--
-- The app works WITHOUT this migration: a missing switch column reads as ON, a missing claim
-- column means nothing is claimed (the queue falls back to its plain read and the claim route
-- answers 503 naming this file). Nullable / defaulted and additive; RLS unchanged — the same
-- tenant-scoped feedback update policy covers the new columns, and the agent route writes
-- with the service role exactly as /api/agent/feedback-checked already does.
-- ============================================================================

begin;

alter table public.tenants
  add column if not exists feedback_auto_send boolean not null default true;

comment on column public.tenants.feedback_auto_send is
  'R-357: new bug reports go to the AI queue on their own after triage. Owner switch, default ON.';

alter table public.feedback
  add column if not exists agent_card text,
  add column if not exists agent_claimed_at timestamptz;

alter table public.feedback
  drop constraint if exists feedback_agent_card_shape;
alter table public.feedback
  add constraint feedback_agent_card_shape check (agent_card is null or agent_card ~ '^R-[0-9]{1,5}$');

comment on column public.feedback.agent_card is
  'R-357: board card id (R-123) the AI worker made for this report.';
comment on column public.feedback.agent_claimed_at is
  'R-357: when the AI worker claimed this report. A claimed report is not handed out again.';

commit;

-- ─── VERIFY (run separately) ────────────────────────────────────────────────
-- select column_name, data_type, column_default from information_schema.columns
--  where table_schema = 'public'
--    and ((table_name = 'tenants' and column_name = 'feedback_auto_send')
--      or (table_name = 'feedback' and column_name in ('agent_card', 'agent_claimed_at')));
