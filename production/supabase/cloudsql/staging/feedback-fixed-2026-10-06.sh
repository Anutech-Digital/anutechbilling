#!/usr/bin/env bash
# 6 Oct 2026, STAGING only: mark the 7 bug reports the AI fixed today as "fixed" with a note
# (which card/commit, when it reaches staging). They then read "done · waiting for browser
# test" in Admin → Feedback. The reports live on the staging DB; the fixes were made locally.
#
#   & "C:\Program Files\Git\bin\bash.exe" /c/Users/mso50/new-reselleros/production/supabase/cloudsql/staging/feedback-fixed-2026-10-06.sh
#
# Touches only public.feedback rows by id (status, resolved_at, resolution_note, checked_*).
# Undo: Reopen a report in Admin → Feedback.
set -euo pipefail
P=resellsubsos-prod; I=resellersos-staging-db; DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/r161-step2
F="$(cd "$(dirname "$0")" && pwd)/feedback-fixed-2026-10-06.sql"
gcloud storage cp "$F" "$B/feedback-fixed-2026-10-06.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/feedback-fixed-2026-10-06.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null
echo "DONE — 7 reports marked fixed on staging. Open staging → Admin → Feedback → Fixed."
