-- ============================================================================
-- R-188 (6 Oct 2026): "Did I already check this fixed report in a browser?"
--
-- Pardeep, Fixed tab: "mene is browser me check kar liya aur ok dikha lekin me dobara aayunga
-- to confuse rahunga ki mene browser me check kiya hai ya nahi". A fixed report now carries
-- who checked it and when; the card shows "✓ Checked <date> · <name>" or "Not checked yet".
--
-- checked_at       when someone confirmed it in a browser (Mark checked).
-- checked_by_name  their name as shown — same pattern as reporter_name, no FK, so a later
--                  change to the user row does not rewrite history.
-- Reopen clears both (lib/queries/feedback.ts). Nullable and additive; RLS unchanged — the
-- update is the same tenant-scoped update the status buttons already make.
-- ============================================================================

begin;

alter table public.feedback
  add column if not exists checked_at timestamptz,
  add column if not exists checked_by_name text;

alter table public.feedback
  drop constraint if exists feedback_checked_by_name_len;
alter table public.feedback
  add constraint feedback_checked_by_name_len check (checked_by_name is null or char_length(checked_by_name) <= 200);

comment on column public.feedback.checked_at is
  'R-188: when someone confirmed this fixed report in a browser. Cleared on Reopen.';
comment on column public.feedback.checked_by_name is
  'R-188: display name of who confirmed it.';

commit;
