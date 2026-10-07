#!/usr/bin/env bash
# R-183 (6 Oct 2026): the token for /api/agent/feedback-queue — the read-only list of
# "Run AI Auto-Fix" reports that the AI worker routine turns into board cards.
#
#   bash production/scripts/ops/agent-queue-token.sh staging   # now
#   bash production/scripts/ops/agent-queue-token.sh live      # with the evening deploy
#
# First run makes one random token and puts it in two places only: Secret Manager
# (agent-queue-token) and a file on this computer (~/.claude/secrets/agent-queue-token) that
# the routine reads. The value is never printed. Later runs reuse it.
# Then it gives that Cloud Run service the secret as AGENT_QUEUE_TOKEN (a new revision with
# the same image — nothing else changes).
# The token can only read that work list. To cut it off: delete the file, or
#   gcloud run services update <service> --region=asia-southeast1 --remove-secrets=AGENT_QUEUE_TOKEN
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; SECRET=agent-queue-token
case "${1:-}" in
  staging) S=resellersos-staging ;;
  live)    S=resellersos ;;
  *) echo "usage: $0 staging|live"; exit 1 ;;
esac
FILE="$HOME/.claude/secrets/agent-queue-token"

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

echo "== $S: AGENT_QUEUE_TOKEN"
gcloud run services update "$S" --project="$P" --region="$R" --update-secrets=AGENT_QUEUE_TOKEN=$SECRET:latest

echo "DONE ($1). Tell Claude 'token ho gaya'."
