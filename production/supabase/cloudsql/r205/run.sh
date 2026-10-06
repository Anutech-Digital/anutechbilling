#!/usr/bin/env bash
# R-205 — fix Google Workspace list prices in the items catalogue. Pardeep runs it (Claude's DB
# writes are refused by design). Staging first, look at the app, then live:
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/r205/run.sh" staging
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/r205/run.sh" live
# Steps: who/where → (live: backup) → count rows below list → update → count again (must be 0).
set -euo pipefail
case "${1:-}" in
  staging) I=resellersos-staging-db ;;
  live)    I=resellersos-db ;;
  *) echo "Use: run.sh staging | run.sh live"; exit 1 ;;
esac
P=resellsubsos-prod; DB=resellersos; B=gs://resellsubsos-prod-rehearsal/golive/r205-$1
HERE="$(cd "$(dirname "$0")" && pwd)"
peek() {
  gcloud storage cp "$HERE/peek.sql" "$B/peek.sql" --project="$P" -q >/dev/null 2>&1
  gcloud sql import sql "$I" "$B/peek.sql" --database="$DB" --user=postgres --project="$P" --quiet >/dev/null 2>&1 || true
  gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'PEEK below_list=[0-9]+' | head -1
}
echo "== 0. account: $(gcloud config get-value account 2>/dev/null)   instance: $I"
if [ "$1" = live ]; then
  echo "== 1. backup"; gcloud sql backups create --instance="$I" --project="$P" --description="before R-205 GW list prices"
fi
echo "== 2. before"; BEFORE="$(peek)"; echo "$BEFORE"
[ -n "$BEFORE" ] || { echo "Could not read — nothing changed. Send Claude a screenshot."; exit 1; }
if echo "$BEFORE" | grep -q "=0$"; then echo "Nothing below list — done."; exit 0; fi
echo "== 3. update"
gcloud storage cp "$HERE/apply.sql" "$B/apply.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/apply.sql" --database="$DB" --user=postgres --project="$P" --quiet
echo "== 4. after"; AFTER="$(peek)"; echo "$AFTER"
echo "$AFTER" | grep -q "=0$" && echo "R-205 $1 DONE — tell Claude 'r205 $1 ho gaya'." || { echo "Still rows below list — send Claude this screen."; exit 1; }
