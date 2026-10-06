#!/usr/bin/env bash
# R-190 (6 Oct 2026): a shared Gemini key on STAGING only, so AI Help (and the other AI
# features) work for every test company, not just the one whose own key is in Settings.
#
#   & "C:\Program Files\Git\bin\bash.exe" /c/Users/mso50/new-reselleros/production/scripts/ops/staging-gemini-key.sh
#
# Takes GEMINI_API_KEY from production/.env.local on this computer, writes it to Secret
# Manager as staging-gemini-api-key (never printed), lets the staging service read it, and
# sets it on Cloud Run resellersos-staging. A company's own key in Settings still wins
# (lib/ai/gemini.ts resolveGeminiConfig). Live is NOT touched.
#
# Undo: gcloud run services update resellersos-staging --region=asia-southeast1 --remove-secrets=GEMINI_API_KEY
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; S=resellersos-staging; SECRET=staging-gemini-api-key
ENVFILE="$(cd "$(dirname "$0")/../.." && pwd)/.env.local"

KEY="$(sed -n 's/^GEMINI_API_KEY=//p' "$ENVFILE" | head -1 | tr -d '\r\n"'"'"' ')"
[ -n "$KEY" ] || { echo "No GEMINI_API_KEY in $ENVFILE — nothing done."; exit 1; }

echo "== Secret $SECRET (value never shown)"
if gcloud secrets describe "$SECRET" --project="$P" >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET" --project="$P" --data-file=- >/dev/null
else
  printf '%s' "$KEY" | gcloud secrets create "$SECRET" --project="$P" --replication-policy=automatic --data-file=- >/dev/null
fi
unset KEY

SA="$(gcloud run services describe "$S" --project="$P" --region="$R" --format='value(spec.template.spec.serviceAccountName)')"
gcloud secrets add-iam-policy-binding "$SECRET" --project="$P" --member="serviceAccount:$SA" \
  --role=roles/secretmanager.secretAccessor --condition=None >/dev/null

echo "== $S: GEMINI_API_KEY"
gcloud run services update "$S" --project="$P" --region="$R" --update-secrets=GEMINI_API_KEY=$SECRET:latest

echo "DONE. Tell Claude 'gemini key ho gayi'."
