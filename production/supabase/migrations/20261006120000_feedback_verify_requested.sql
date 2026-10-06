-- ============================================================================
-- R-184 (6 Oct 2026): "Check in browser" on a fixed bug report.
--
-- Pardeep, Fixed tab: "fixed tab me yadi bug ko browser me test karna ho to kya karna
-- padega" — there was no way to ask for it. Pressing the button stamps
-- verify_requested_at; the AI worker routine reads it through /api/agent/feedback-queue and
-- puts the report on the work board with "AI se jaanch karwao" on, and the AI check routine
-- runs the reporter's steps in a browser and writes the result on that card.
--
-- One nullable timestamp, nothing else: pressing it again is a new request (a later time),
-- and Reopen / Mark fixed do not need to know about it. RLS unchanged — the owner's update
-- is the same tenant-scoped update the status buttons already make.
-- ============================================================================

begin;

alter table public.feedback
  add column if not exists verify_requested_at timestamptz;

comment on column public.feedback.verify_requested_at is
  'R-184: when someone asked the AI to re-check this (fixed) report in a browser. Read by /api/agent/feedback-queue.';

commit;
