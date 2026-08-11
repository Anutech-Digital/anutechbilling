-- 0208: Lightweight proctoring signals on reasoning-test attempts.
--
-- Pardeep wants to know whether a candidate used AI during the test. The most
-- direct signal for a browser-based MCQ test is NOT video — it's behaviour:
--   * how long they took (duration),
--   * whether they left the test tab/window (opened ChatGPT in another tab),
--   * whether they pasted an answer in.
-- These are captured client-side and recorded per attempt. All optional /
-- defaulted so old attempts stay valid.

alter table public.assessment_attempts
  add column if not exists duration_seconds   integer,
  add column if not exists focus_lost_count   integer not null default 0,
  add column if not exists focus_lost_seconds integer not null default 0,
  add column if not exists paste_count        integer not null default 0;

comment on column public.assessment_attempts.duration_seconds   is 'Total seconds from test open to submit.';
comment on column public.assessment_attempts.focus_lost_count   is 'How many times the candidate switched away from the test tab/window.';
comment on column public.assessment_attempts.focus_lost_seconds is 'Total seconds spent away from the test (possible AI/lookup use).';
comment on column public.assessment_attempts.paste_count        is 'How many paste events happened inside the test.';
