#!/usr/bin/env bash
# R-1721 (21 Oct 2026): the token for GET /api/health/migrations — "is every migration this build
# knows about on its DB?". staging-train.mjs --push reads it after the push.
#
#   bash production/scripts/ops/migrations-health-token.sh staging
#   bash production/scripts/ops/migrations-health-token.sh live      # with the deploy
#
# First run makes one random token and puts it in two places only: Secret Manager
# (migrations-health-token) and ~/.claude/secrets/migrations-health-token on this computer (the
# train reads it). The value is never printed. Later runs reuse it.
# Then it gives that Cloud Run service the secret as MIGRATIONS_HEALTH_TOKEN (a new revision with
# the same image — nothing else changes). The token can only read true/false per migration.
# To cut it off: gcloud run services update <service> --region=asia-southeast1 --remove-secrets=MIGRATIONS_HEALTH_TOKEN
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; SECRET=migrations-health-token
case "${1:-}" in
  staging) S=resellersos-staging ;;
  live)    S=resellersos ;;
  *) echo "usage: $0 staging|live"; exit 1 ;;
esac
FILE="$HOME/.claude/secrets/migrations-health-token"

if ! gcloud secrets describe "$SECRET" --project="$P" >/dev/null 2>&1; then
  echo "== New token (never shown)"
  mkdir -p "$(dirname "$FILE")"
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > "$FILE"
  chmod 600 "$FILE" 2>/dev/null || true
  gcloud secrets create "$SECRET" --project="$P" --replication-policy=automatic --data-file="$FILE" >/dev/null
elif [ ! -s "$FILE" ]; then
  echo "== Token exists in Secret Manager; copying it to this computer (never shown)"
  mkdir -p "$(dirname "$FILE")"
  gcloud secrets versions access latest --secret="$SECRET" --project="$P" > "$FILE"
  chmod 600 "$FILE" 2>/dev/null || true
fi

SA="$(gcloud run services describe "$S" --project="$P" --region="$R" --format='value(spec.template.spec.serviceAccountName)')"
gcloud secrets add-iam-policy-binding "$SECRET" --project="$P" --member="serviceAccount:$SA" \
  --role=roles/secretmanager.secretAccessor --condition=None >/dev/null

echo "== $S: MIGRATIONS_HEALTH_TOKEN"
gcloud run services update "$S" --project="$P" --region="$R" --update-secrets=MIGRATIONS_HEALTH_TOKEN=$SECRET:latest

echo "DONE ($1). Check: node production/scripts/ops/migrations-health-check.mjs --url <service url>"
