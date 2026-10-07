#!/usr/bin/env bash
# R-161 step 4 on STAGING only (6 Oct 2026): turn the three no-VM switches on.
# Pardeep runs this (the Cloud Run / trigger changes are his to make):
#
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/reselleros-r161/production/supabase/cloudsql/staging/r161-step4-switch-on.sh"
#
# Steps 1–3 are done (Prisma migrations on the staging DB, 9 secrets, the files bucket).
# This one:
#   1. Cloud Run `resellersos-staging`: Cloud SQL socket + the 9 secrets + DATA_GATEWAY=1,
#      AUTH_PROVIDER=authjs, STORAGE_BACKEND=gcs, GCS_BUCKET, DB_POOL_MAX=3 — on a NO-TRAFFIC
#      revision, so today's staging keeps working until the new build lands.
#   2. The staging build trigger: NEXT_PUBLIC_DATA_GATEWAY=1, NEXT_PUBLIC_AUTH_PROVIDER=authjs,
#      and the app's own /api/sb as the Supabase URL — nothing in the bundle points at the VM.
# Then tell Claude "step 4 ho gaya": it pushes the staging build (~20 min) and checks login,
# invoices, PDFs, Report Bug, uploads — with the staging VM still running as the safety net.
#
# Undo (any time): run with UNDO=1 — removes the switches and puts the trigger back.
# Production is not touched.
# Learned on staging 6 Oct: 512Mi runs out of heap with the gateway (1Gi), and Auth.js needs
# AUTH_URL or it sends Google https://0.0.0.0:8080 as the redirect. Both are in step 1 now.
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; S=resellersos-staging
APP=https://resellersos-staging-njvk4nxhdq-as.a.run.app
say() { printf '\n== %s\n' "$1"; }

say "0. Who is logged in"
gcloud config get-value account

if [ "${UNDO:-}" = 1 ]; then
  say "UNDO: switches off, trigger back to the VM"
  gcloud run services update "$S" --project="$P" --region="$R" \
    --remove-env-vars=DATA_GATEWAY,AUTH_PROVIDER,AUTH_URL,STORAGE_BACKEND,GCS_BUCKET,DB_POOL_MAX \
    --remove-secrets=DATABASE_URL,ANON_DATABASE_URL,SERVICE_DATABASE_URL,AUTH_DATABASE_URL,JOBS_DATABASE_URL,SUPABASE_JWT_SECRET,AUTH_SECRET,AUTH_GOOGLE_ID,AUTH_GOOGLE_SECRET
  UNDO=1 bash "$(dirname "$0")/r161-step4b-trigger.sh"
  say "Undone. Tell Claude 'undo ho gaya' — it rebuilds staging on the VM path."
  exit 0
fi

say "1. Cloud Run staging: socket + secrets + switches (no traffic yet)"
gcloud run services update "$S" --project="$P" --region="$R" --no-traffic --tag=r161 \
  --add-cloudsql-instances=resellsubsos-prod:asia-southeast1:resellersos-staging-db \
  --update-secrets=DATABASE_URL=staging-r161-database-url:latest,ANON_DATABASE_URL=staging-r161-anon-database-url:latest,SERVICE_DATABASE_URL=staging-r161-service-database-url:latest,AUTH_DATABASE_URL=staging-r161-auth-database-url:latest,JOBS_DATABASE_URL=staging-r161-jobs-database-url:latest,SUPABASE_JWT_SECRET=staging-r161-supabase-jwt-secret:latest,AUTH_SECRET=staging-r161-auth-secret:latest,AUTH_GOOGLE_ID=staging-r161-google-client-id:latest,AUTH_GOOGLE_SECRET=staging-r161-google-client-secret:latest \
  --memory=1Gi \
  --update-env-vars=DATA_GATEWAY=1,AUTH_PROVIDER=authjs,AUTH_URL=$APP,STORAGE_BACKEND=gcs,GCS_BUCKET=resellsubsos-staging-files,DB_POOL_MAX=3

say "2. Staging build trigger: browser switches on, Supabase URL = the app itself"
# update github --update-substitutions returns INVALID_ARGUMENT here; export/import instead.
bash "$(dirname "$0")/r161-step4b-trigger.sh"

say "STEP 4 DONE — tell Claude 'step 4 ho gaya'."
