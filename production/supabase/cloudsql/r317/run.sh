#!/usr/bin/env bash
# R-317 - fill MRR on imported active subscriptions at ZERO whose edition is KNOWN (catalogue list
# price x seats). Unknown-edition rows stay at zero and are counted on Reports ("no price").
# Pardeep runs it (Claude's DB writes are refused by design). Staging first, look at the app, then live:
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/r317/run.sh" staging
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/r317/run.sh" live
#   (add "peek" as a 2nd word to only count, change nothing: run.sh live peek)
# Steps: who/where -> (live: backup) -> count -> update -> count again (fixable must be 0).
set -euo pipefail
case "${1:-}" in
  staging) I=resellersos-staging-db ;;
  live)    I=resellersos-db ;;
  *) echo "Use: run.sh staging | run.sh live   (optional 2nd word: peek)"; exit 1 ;;
esac
P=resellsubsos-prod; DB=resellersos; B=gs://resellsubsos-prod-rehearsal/golive/r317-$1
HERE="$(cd "$(dirname "$0")" && pwd)"
peek() {
  gcloud storage cp "$HERE/peek.sql" "$B/peek.sql" --project="$P" -q >/dev/null 2>&1
  gcloud sql import sql "$I" "$B/peek.sql" --database="$DB" --user=postgres --project="$P" --quiet >/dev/null 2>&1 || true
  gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json \
    | grep -oE 'PEEK no_price=[0-9]+ fixable=[0-9]+ fixable_mrr=[0-9]+ unknown_edition=[0-9]+ ambiguous=[0-9]+ no_catalog_price=[0-9]+ no_seats=[0-9]+' | head -1
}
echo "== 0. account: $(gcloud config get-value account 2>/dev/null)   instance: $I"
echo "== 1. before"; BEFORE="$(peek)"; echo "$BEFORE"
[ -n "$BEFORE" ] || { echo "Could not read - nothing changed. Send Claude a screenshot."; exit 1; }
if [ "${2:-}" = peek ]; then echo "Peek only - nothing changed."; exit 0; fi
if echo "$BEFORE" | grep -q " fixable=0 "; then echo "Nothing with a known edition to fill - done (no_price rows need their plan set in the app)."; exit 0; fi
if [ "$1" = live ]; then
  echo "== 2. backup"; gcloud sql backups create --instance="$I" --project="$P" --description="before R-317 list-price MRR"
fi
echo "== 3. update"
gcloud storage cp "$HERE/apply.sql" "$B/apply.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/apply.sql" --database="$DB" --user=postgres --project="$P" --quiet
echo "== 4. after"; AFTER="$(peek)"; echo "$AFTER"
echo "$AFTER" | grep -q " fixable=0 " && echo "R-317 $1 DONE - tell Claude 'r317 $1 ho gaya' with the two PEEK lines." || { echo "Still fixable rows - send Claude this screen."; exit 1; }
