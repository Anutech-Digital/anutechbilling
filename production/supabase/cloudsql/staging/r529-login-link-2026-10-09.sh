#!/usr/bin/env bash
# R-529 (9 Oct 2026) — STAGING ONLY. Lets a Google sign-in find the existing account.
# Two additive steps, nothing is deleted:
#   1. function public.login_profile_id_for_email(text)  (as resellersos_migration, the table owner)
#   2. grants for the Auth.js login role app_auth          (as postgres)
set -euo pipefail
P=resellsubsos-prod
I=resellersos-staging-db
DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/staging-20261009
SRC=/c/Users/mso50/wt-r161-fix/production

echo "== who: $(gcloud config get-value account 2>/dev/null)   instance: $I"
gcloud storage cp "$SRC/prisma/migrations/20261009200000_login_profile_lookup/migration.sql" "$B/r529-fn.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/r529-fn.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet
echo "== 1 done: function"
gcloud storage cp "$SRC/db/ops/21-auth-login-link.sql" "$B/r529-grants.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/r529-grants.sql" --database="$DB" --user=postgres --project="$P" --quiet
echo "== 2 done: grants"
echo "== R-529 DB READY — tell Claude 'r529 ho gaya'"
