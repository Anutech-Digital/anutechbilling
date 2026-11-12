#!/usr/bin/env bash
# 26 Oct 2026: staging /buy/workspace showed no "Buy now" although Razorpay TEST keys were saved
# in Anutech's Settings. BUY_PAGE_TENANT_ID was unset, so lib/website-tenant.ts fell back to the
# LIVE Anutech id fbb976f1-9090-4f10-9726-0901bd144e42 — but on STAGING Anutech is
# 5f40cbee-7982-454e-8b3f-9b2e6f6b011f (read from the logged-in staging session's own requests).
# The buy page therefore looked for keys (and would file orders) under a tenant staging does not use.
#
#   & "C:\Program Files\Git\bin\bash.exe" /c/Users/mso50/new-reselleros/production/scripts/ops/staging-buy-page-tenant.sh
#
# Sets BUY_PAGE_TENANT_ID on resellersos-staging only. Live is NOT touched.
# Undo: gcloud run services update resellersos-staging --region=asia-southeast1 --remove-env-vars=BUY_PAGE_TENANT_ID
set -euo pipefail
P=resellsubsos-prod; R=asia-southeast1; S=resellersos-staging
T=5f40cbee-7982-454e-8b3f-9b2e6f6b011f

gcloud run services update "$S" --project="$P" --region="$R" --update-env-vars=BUY_PAGE_TENANT_ID=$T
echo "DONE. Staging restarted with BUY_PAGE_TENANT_ID=$T. Tell Claude 'tenant set ho gaya'."
