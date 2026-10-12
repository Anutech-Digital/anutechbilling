#!/usr/bin/env bash
# ============================================================================
# ResellerOS live deploy — gated (R-884, 12 Oct 2026).
#
# Ships ONE exact sha through Cloud Build (cloudbuild.yaml: tsc + vitest gate, Auth.js /
# gateway build args, image tagged with the sha) by fast-forwarding the `deploy` branch on
# the anutech remote. It NEVER runs `gcloud run deploy --source .` any more: that path
# skipped CI and built the image with Dockerfile defaults (Supabase-era live image).
#
# Refuses unless scripts/ops/deploy-gate.mjs passes:
#   working tree clean · sha pushed to anutech · GitHub "CI" + "SQL tests" green on that sha.
#
# Usage (from anywhere; it cd's itself):
#   bash deploy.sh --dry-run [<sha>]     check only, push nothing  ← use this first
#   bash deploy.sh [<sha>]               gate, then push <sha> to `deploy` (default: HEAD)
#   bash deploy.sh --emergency [<sha>]   red CI may be overridden by typing the phrase it
#                                        shows; logged to ~/.reselleros/deploy-overrides.log
# Rules (docs/LIVE-OPERATIONS.md): live only on deploy days after 17:00 IST, with Pardeep's
# haan for this exact sha. Workers never run this.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"               # production/
REMOTE="anutech"
DEPLOY_BRANCH="deploy"

DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done

# Gate: its last stdout line is SHA=<full sha> when allowed. pipefail (above) keeps the
# gate's exit code through tee; stdin stays the terminal for the emergency prompt.
OUT_FILE="$(mktemp)"
trap 'rm -f "$OUT_FILE"' EXIT
if ! node scripts/ops/deploy-gate.mjs "$@" | tee "$OUT_FILE"; then
  echo "✗ Deploy refused by the gate. Nothing was pushed."
  exit 1
fi

SHA="$(grep '^SHA=' "$OUT_FILE" | tail -1 | cut -d= -f2)"
if [ "$DRY" = "1" ] || [ -z "$SHA" ]; then
  echo "(dry-run) Nothing pushed."
  exit 0
fi

echo "── Shipping $SHA via Cloud Build (push to $REMOTE/$DEPLOY_BRANCH, fast-forward only) ──"
# No --force: a non-fast-forward is refused by git, which is what we want.
git push "$REMOTE" "$SHA:refs/heads/$DEPLOY_BRANCH"
echo "✓ Pushed. Cloud Build trigger resellersos-deploy-on-push builds + deploys it (3–5 min)."
echo "  Then: npm run verify:deploy (must show ${SHA:0:8})."
