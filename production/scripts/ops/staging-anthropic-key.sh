#!/usr/bin/env bash
# R-1759 (22 Oct 2026): Claude (Anthropic) as the AI on STAGING, because the Gemini billing
# account hit its monthly spending cap (429). Modelled on staging-gemini-key.sh.
#
#   & "C:\Program Files\Git\bin\bash.exe" /c/Users/mso50/new-reselleros/production/scripts/ops/staging-anthropic-key.sh
#
# Takes ANTHROPIC_API_KEY from production/.env.local on this computer, writes it to Secret
# Manager as staging-anthropic-api-key (never printed), lets the staging service read it, and
# sets on Cloud Run resellersos-staging: ANTHROPIC_API_KEY (from the secret) + AI_PROVIDER=claude.
# GEMINI_API_KEY stays — if Claude fails on key / credit / overload, Gemini is tried once
# (lib/ai/gemini.ts geminiJson). Live is NOT touched.
#
# Back to Gemini later (no code change):
#   gcloud run services update resellersos-staging --region=asia-southeast1 --update-env-vars=AI_PROVIDER=gemini
# Undo fully:
#   gcloud run services update resellersos-staging --region=asia-southeast1 --remove-secrets=ANTHROPIC_API_KEY --remove-env-vars=AI_PROVIDER
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; S=resellersos-staging; SECRET=staging-anthropic-api-key
ENVFILE="$(cd "$(dirname "$0")/../.." && pwd)/.env.local"

KEY="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$ENVFILE" | head -1 | tr -d '\r\n"'"'"' ')"
[ -n "$KEY" ] || { echo "No ANTHROPIC_API_KEY in $ENVFILE — nothing done."; exit 1; }

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

echo "== $S: ANTHROPIC_API_KEY + AI_PROVIDER=claude"
gcloud run services update "$S" --project="$P" --region="$R" \
  --update-secrets=ANTHROPIC_API_KEY=$SECRET:latest \
  --update-env-vars=AI_PROVIDER=claude

echo "DONE. Tell Claude 'anthropic key ho gayi'."
