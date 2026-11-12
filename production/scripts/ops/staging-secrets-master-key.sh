#!/usr/bin/env bash
# 26 Oct 2026: STAGING has no SECRETS_MASTER_KEY, so Settings → Integrations → Razorpay (and every
# other tenant secret) refuses to save: "Encryption key (SECRETS_MASTER_KEY) is not set on this
# server, so the secret was NOT saved." Modelled on staging-anthropic-key.sh.
#
#   & "C:\Program Files\Git\bin\bash.exe" /c/Users/mso50/new-reselleros/production/scripts/ops/staging-secrets-master-key.sh
#
# Generates a NEW random 32-byte key (base64) for STAGING only — never printed, never written to a
# file — stores it in Secret Manager as staging-secrets-master-key, lets the staging service read
# it, and sets SECRETS_MASTER_KEY on Cloud Run resellersos-staging from that secret.
# Existing plaintext values in tenant_secrets keep working (lib/crypto/vault.ts decryptSecret
# passes non-envelope values through). Live is NOT touched.
#
# Refuses to run if the secret already exists: a second key would make values sealed with the
# first one unreadable. Never rotate this by re-running.
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; S=resellersos-staging; SECRET=staging-secrets-master-key

CUR="$(gcloud run services describe "$S" --project="$P" --region="$R" --format=json | grep -c '"SECRETS_MASTER_KEY"' || true)"
if [ "$CUR" != "0" ]; then
  echo "$S already has SECRETS_MASTER_KEY set — nothing done."; exit 1
fi

if gcloud secrets describe "$SECRET" --project="$P" >/dev/null 2>&1; then
  # 26 Oct: the secret already existed but was never attached to the service. Reuse it — any
  # value staging sealed earlier was sealed with THIS key; a new one would make those unreadable.
  echo "== Secret $SECRET already exists — reusing it (no new key made)"
else
  echo "== Secret $SECRET (new random key, value never shown)"
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" \
    | gcloud secrets create "$SECRET" --project="$P" --replication-policy=automatic --data-file=- >/dev/null
fi

SA="$(gcloud run services describe "$S" --project="$P" --region="$R" --format='value(spec.template.spec.serviceAccountName)')"
gcloud secrets add-iam-policy-binding "$SECRET" --project="$P" --member="serviceAccount:$SA" \
  --role=roles/secretmanager.secretAccessor --condition=None >/dev/null

echo "== $S: SECRETS_MASTER_KEY (from the secret)"
gcloud run services update "$S" --project="$P" --region="$R" \
  --update-secrets=SECRETS_MASTER_KEY=$SECRET:latest

echo "DONE. Staging restarted with the key. Save the Razorpay keys again, then tell Claude 'master key lag gayi'."
