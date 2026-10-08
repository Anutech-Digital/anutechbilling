#!/usr/bin/env bash
# STAGING: apply R-179's migration (undeposited_funds) — Pardeep runs this; Claude's writes to the
# staging DB are refused by design.
#   & "C:Program FilesGitinash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/staging/r179-undeposited-funds.sh"
set -euo pipefail
P=resellsubsos-prod
I=resellersos-staging-db
DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/r179-staging
F="$(cd "$(dirname "$0")/../.." && pwd)/migrations/20261006140000_undeposited_funds.sql"
gcloud config get-value account
gcloud storage cp "$F" "$B/undeposited.sql" --project="$P" -q
gcloud sql import sql "$I" "$B/undeposited.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet
printf "notify pgrst, 'reload schema';
" > /tmp/r179-reload.sql
gcloud storage cp /tmp/r179-reload.sql "$B/reload.sql" --project="$P" -q
gcloud sql import sql "$I" "$B/reload.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet || true
echo; echo "STAGING R-179 DONE — Balance Sheet par 'Received, not yet in bank' ab dikhega."
