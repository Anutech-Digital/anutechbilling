#!/usr/bin/env bash
# R-161 step 4b on STAGING only (6 Oct 2026): the build-trigger half of step 4.
# `gcloud builds triggers update github --update-substitutions` returned INVALID_ARGUMENT
# for this trigger, so this exports it, changes three substitutions, and imports it back.
#
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/reselleros-r161/production/supabase/cloudsql/staging/r161-step4b-trigger.sh"
#
# Undo: UNDO=1 (puts _SUPABASE_URL back on the VM and removes the two switches).
set -euo pipefail
P=resellsubsos-prod; T=resellersos-staging-on-push
APP=https://resellersos-staging-njvk4nxhdq-as.a.run.app
VM=https://35-240-252-6.sslip.io
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
gcloud beta builds triggers export "$T" --project="$P" --destination="$TMP/t.yaml" >/dev/null
tr -d '\r' < "$TMP/t.yaml" | grep -vE '^  _(DATA_GATEWAY|AUTH_PROVIDER):' > "$TMP/clean.yaml"
if [ "${UNDO:-}" = 1 ]; then
  sed "s#^  _SUPABASE_URL: .*#  _SUPABASE_URL: $VM#" "$TMP/clean.yaml" > "$TMP/new.yaml"
else
  sed "s#^  _SUPABASE_URL: .*#  _SUPABASE_URL: $APP/api/sb#; s#^substitutions:#substitutions:\n  _AUTH_PROVIDER: authjs\n  _DATA_GATEWAY: '1'#" "$TMP/clean.yaml" > "$TMP/new.yaml"
fi
gcloud beta builds triggers import --project="$P" --source="$TMP/new.yaml" >/dev/null
echo "== Trigger now:"
gcloud beta builds triggers describe "$T" --project="$P" --format="value(substitutions._DATA_GATEWAY,substitutions._AUTH_PROVIDER,substitutions._SUPABASE_URL)"
echo "STEP 4b DONE — tell Claude 'trigger ho gaya'."
