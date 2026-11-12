#!/usr/bin/env bash
# 26 Oct 2026: staging-secrets-master-key holds the 32-byte key as 64 HEX characters, but
# lib/crypto/vault.ts masterKey() reads base64 — hex read as base64 gives 48 bytes, so the vault
# refused it and Settings said "SECRETS_MASTER_KEY is not set". Checked with
# staging-master-key-check.sh: length 64, hex-decoded 32 bytes.
#
#   & "C:\Program Files\Git\bin\bash.exe" /c/Users/mso50/new-reselleros/production/scripts/ops/staging-master-key-to-base64.sh
#
# Adds a NEW secret version holding the SAME 32 key bytes written as base64 (the key does not
# change — only its spelling), then rolls resellersos-staging to a new revision so it reads it.
# The value is never printed. Refuses if any OTHER Cloud Run service uses this secret, or if the
# latest version is not 64 hex characters. Live is NOT touched.
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; S=resellersos-staging; SECRET=staging-secrets-master-key

echo "== Who else uses $SECRET"
# One list call (name + region), \r stripped — on Windows gcloud ends lines with CRLF and the
# stray \r made every name invalid in the first version of this loop.
OTHERS=""
while IFS=$'\t ' read -r svc reg; do
  svc="${svc//$'\r'/}"; reg="${reg//$'\r'/}"
  [ -z "$svc" ] && continue
  [ "$svc" = "$S" ] && continue
  if gcloud run services describe "$svc" --project="$P" --region="$reg" --format=json | grep -q "\"$SECRET\""; then
    OTHERS="$OTHERS $svc"
  fi
done < <(gcloud run services list --project="$P" --format='value(metadata.name,metadata.labels."cloud.googleapis.com/location")')
if [ -n "$OTHERS" ]; then echo "Also used by: $OTHERS — NOT changing it. Nothing done."; exit 1; fi
echo "  only $S"

echo "== New version: same key, base64 (value never shown)"
gcloud secrets versions access latest --secret="$SECRET" --project="$P" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const raw=s.trim();
  if(!/^[0-9a-fA-F]{64}$/.test(raw)){console.error("Latest version is not 64 hex chars — refusing.");process.exit(2);}
  process.stdout.write(Buffer.from(raw,"hex").toString("base64"));
});' | gcloud secrets versions add "$SECRET" --project="$P" --data-file=- >/dev/null

echo "== Roll $S to a new revision so it reads the new version"
gcloud run services update "$S" --project="$P" --region="$R" \
  --update-secrets=SECRETS_MASTER_KEY=$SECRET:latest \
  --update-env-vars=SECRETS_MASTER_KEY_FORMAT_FIX=20261026

echo "DONE. Save the Razorpay keys again on staging, then tell Claude 'master key lag gayi'."
