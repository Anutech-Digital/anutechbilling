#!/usr/bin/env bash
# 26 Oct 2026: staging has SECRETS_MASTER_KEY set, yet Settings says "not set". lib/crypto/vault.ts
# masterKey() accepts it only as base64 that decodes to EXACTLY 32 bytes. This prints the SHAPE of
# the value — never the value: how it is attached (secret ref or plain env), its length, whether
# it looks like hex/base64, and how many bytes it decodes to.
#
#   & "C:\Program Files\Git\bin\bash.exe" /c/Users/mso50/new-reselleros/production/scripts/ops/staging-master-key-check.sh
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; S=resellersos-staging

echo "== How $S gets SECRETS_MASTER_KEY"
gcloud run services describe "$S" --project="$P" --region="$R" --format=json \
  | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const c=JSON.parse(s).spec.template.spec.containers[0];
  const e=(c.env||[]).find(x=>x.name==="SECRETS_MASTER_KEY");
  if(!e){console.log("not in env");return;}
  if(e.valueFrom&&e.valueFrom.secretKeyRef){const r=e.valueFrom.secretKeyRef;console.log("from secret:",r.name,"version:",r.key);}
  else console.log("PLAIN env value, length",(e.value||"").length,"(not from Secret Manager)");
});'

shape() {
  node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const raw=s.trim();
  const hex=/^[0-9a-fA-F]+$/.test(raw), b64=/^[A-Za-z0-9+/=_-]+$/.test(raw);
  console.log("  length:",raw.length,"| looks hex:",hex,"| looks base64:",b64,
    "| base64-decoded bytes:",Buffer.from(raw,"base64").length,"(need 32)",
    hex?"| hex-decoded bytes: "+Buffer.from(raw,"hex").length:"");
});'
}

echo "== Secret staging-secrets-master-key, latest version (value never shown)"
gcloud secrets versions access latest --secret=staging-secrets-master-key --project="$P" | shape || echo "  (could not read)"
