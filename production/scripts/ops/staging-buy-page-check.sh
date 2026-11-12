#!/usr/bin/env bash
# 26 Oct 2026: Razorpay keys saved on staging Settings, but /buy/workspace still shows no "Buy now".
# The buy page reads Razorpay keys from tenant_secrets of the WEBSITE tenant
# (lib/website-tenant.ts: BUY_PAGE_TENANT_ID, else Anutech fbb976f1… in production), then from
# RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env. This prints which tenant that is and whether the env
# pair exists — names and ids only, never a key value.
#
#   & "C:\Program Files\Git\bin\bash.exe" /c/Users/mso50/new-reselleros/production/scripts/ops/staging-buy-page-check.sh
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; S=resellersos-staging

gcloud run services describe "$S" --project="$P" --region="$R" --format=json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s), env=j.spec.template.spec.containers[0].env||[];
  const get=n=>env.find(x=>x.name===n);
  const show=n=>{const e=get(n); if(!e) return "not set";
    if(e.valueFrom&&e.valueFrom.secretKeyRef) return "from secret "+e.valueFrom.secretKeyRef.name;
    return n==="BUY_PAGE_TENANT_ID"||n==="NODE_ENV" ? (e.value||"(empty)") : "set (plain, length "+(e.value||"").length+")";};
  console.log("revision:          ", j.status.latestReadyRevisionName);
  for (const n of ["BUY_PAGE_TENANT_ID","NODE_ENV","RAZORPAY_KEY_ID","NEXT_PUBLIC_RAZORPAY_KEY_ID","RAZORPAY_KEY_SECRET","SECRETS_MASTER_KEY"])
    console.log((n+":").padEnd(32), show(n));
  console.log("If BUY_PAGE_TENANT_ID is not set, the buy page uses Anutech fbb976f1-9090-4f10-9726-0901bd144e42.");
});'
