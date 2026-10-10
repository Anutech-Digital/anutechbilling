#!/usr/bin/env bash
# R-161 step 3 on STAGING only (6 Oct 2026): the secrets the no-VM path needs, written straight
# into Secret Manager — no value is ever printed, logged or put in chat.
#
#   bash production/supabase/cloudsql/staging/r161-step3-secrets.sh
#
#   staging-r161-database-url          app_runtime   (DATABASE_URL)
#   staging-r161-anon-database-url     app_anon      (ANON_DATABASE_URL)
#   staging-r161-service-database-url  app_service   (SERVICE_DATABASE_URL)
#   staging-r161-auth-database-url     app_auth      (AUTH_DATABASE_URL)
#   staging-r161-jobs-database-url     app_jobs      (JOBS_DATABASE_URL)
#   staging-r161-supabase-jwt-secret   the staging VM's JWT_SECRET (SUPABASE_JWT_SECRET) — so
#                                      tokens already issued keep verifying during the switch
#   staging-r161-auth-secret           new random AUTH_SECRET (Auth.js session cookies)
#   staging-r161-google-client-id / -secret   the staging VM's Google OAuth client (Auth.js)
#
# DB passwords come from step 1's secrets (staging-db-app-<role>-password). Cloud Run reaches
# Cloud SQL over its unix socket (/cloudsql/<connection>), so no IP allow-list is opened.
# Re-running adds new versions. The Cloud Run service account gets secretAccessor on each.
set -euo pipefail
P=resellsubsos-prod; Z=asia-southeast1-a; DB=resellersos
CONN="resellsubsos-prod:asia-southeast1:resellersos-staging-db"
SA="$(gcloud run services describe resellersos-staging --project="$P" --region=asia-southeast1 --format='value(spec.template.spec.serviceAccountName)')"
say() { printf '\n== %s\n' "$1"; }
put() { # $1 secret name; value on stdin
  if gcloud secrets describe "$1" --project="$P" >/dev/null 2>&1; then
    gcloud secrets versions add "$1" --project="$P" --data-file=- >/dev/null
  else
    gcloud secrets create "$1" --project="$P" --replication-policy=automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$1" --project="$P" --member="serviceAccount:$SA" \
    --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
  echo "set: $1"
}
url() { # $1 role suffix (runtime|anon|service|auth|jobs)
  local pw; pw="$(gcloud secrets versions access latest --secret="staging-db-app-$1-password" --project="$P")"
  printf 'postgresql://app_%s:%s@localhost/%s?host=/cloudsql/%s' "$1" "$pw" "$DB" "$CONN"
}

say "1. Database URLs (passwords from step 1, never shown)"
url runtime | put staging-r161-database-url
url anon    | put staging-r161-anon-database-url
url service | put staging-r161-service-database-url
url auth    | put staging-r161-auth-database-url
url jobs    | put staging-r161-jobs-database-url

say "2. From the staging VM: JWT secret + Google OAuth client (read, never printed)"
B64="$(gcloud compute ssh staging-gateway --zone="$Z" --project="$P" --strict-host-key-checking=no --quiet \
  --command="grep -E '^(JWT_SECRET|GOOGLE_CLIENT_ID|GOOGLE_SECRET)=' ~/.env | base64 -w0" | tr -d '\r\n')"
[ -n "$B64" ] || { echo "Could not read the VM's settings — nothing more done."; exit 1; }
VMENV="$(printf '%s' "$B64" | base64 -d)"
get() { printf '%s\n' "$VMENV" | sed -n "s/^$1=//p" | head -1 | tr -d '\r\n'; }
[ -n "$(get JWT_SECRET)" ] && [ -n "$(get GOOGLE_CLIENT_ID)" ] && [ -n "$(get GOOGLE_SECRET)" ] \
  || { echo "A VM setting was empty — nothing more done."; exit 1; }
get JWT_SECRET       | tr -d '\n' | put staging-r161-supabase-jwt-secret
get GOOGLE_CLIENT_ID | tr -d '\n' | put staging-r161-google-client-id
get GOOGLE_SECRET    | tr -d '\n' | put staging-r161-google-client-secret

say "3. New AUTH_SECRET"
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' | put staging-r161-auth-secret

say "Done — 9 secrets set, service account $SA can read them."
