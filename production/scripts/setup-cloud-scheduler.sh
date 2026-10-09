#!/usr/bin/env bash
#
# Cloud Scheduler jobs for EVERY ResellerOS cron endpoint (25 as of 27 Sep 2026).
#
# ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
# The repo carries a vercel.json with a `crons` block, and three of the six cron
# routes document their schedule as "set via vercel.json". The live deployment is
# CLOUD RUN. Vercel crons are a Vercel platform feature — they do not exist on
# Cloud Run, so nothing in that file schedules anything here.
#
# The effect is the failure mode this codebase keeps producing: a job that looks
# configured, is documented as scheduled, and never runs. Nothing errors, no log
# line appears, and the first sign is a renewal that lapsed or a statutory
# deadline that passed.
#
# Two of the six are not even in vercel.json (trial-expiry, attendance-retention),
# and compliance-reminders was added later — so on Vercel they would be missed
# too. This file is the single place all six are declared for the platform that
# is actually running.
#
# ─── BEFORE YOU RUN IT ───────────────────────────────────────────────────────
# See what already exists — birthday-greetings names a Cloud Scheduler job in its
# own comments, so some jobs may already be set up by hand:
#
#   gcloud scheduler jobs list --location=asia-southeast1
#
# This script CREATES missing jobs and SKIPS ones that already exist, so it is
# safe to re-run and cannot disturb a job that is working. Set UPDATE_EXISTING=1
# only when you mean to overwrite every job — rotating CRON_SECRET is the case
# that calls for it.
#
#   chmod +x scripts/setup-cloud-scheduler.sh
#   CRON_SECRET='<the same value the service runs with>' ./scripts/setup-cloud-scheduler.sh
#
# The secret must MATCH what the Cloud Run service has, or every job gets 401 and
# you are back to jobs that appear scheduled and do nothing.

set -euo pipefail

# Singapore since 5 Sep 2026 (cloudbuild.yaml _REGION). The Mumbai URL that used to sit
# here as the default pointed every job at the OLD service after the move — jobs that
# looked scheduled and ran old code (or got 403). The URL is now read from the live
# service, so it cannot go stale again.
REGION="${REGION:-asia-southeast1}"
SERVICE_NAME="${SERVICE_NAME:-resellersos}"
SERVICE_URL="${SERVICE_URL:-$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')}"
if [[ -z "$SERVICE_URL" ]]; then
  echo "Could not resolve the Cloud Run URL for $SERVICE_NAME in $REGION — set SERVICE_URL explicitly." >&2
  exit 1
fi
echo "Scheduling against $SERVICE_URL"
# Schedules are written in IST. Cloud Scheduler does the UTC conversion, and
# daylight saving does not apply in India — so these read exactly as intended,
# which UTC cron expressions do not.
TZ_NAME="${TZ_NAME:-Asia/Kolkata}"

if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "CRON_SECRET is not set. Export the same value the Cloud Run service uses:" >&2
  echo "  CRON_SECRET='…' $0" >&2
  exit 2
fi

# name | schedule (IST) | path | description
JOBS=(
  "resellersos-renewals|0 9 * * *|/api/cron/renewals|Renewal cadence: T-30/15/12/9/6/3/0, grace, auto-suspend"
  # 09:15 IST — AFTER the renewal cron, deliberately. Renewals can settle a payment
  # and mark an invoice paid; dunning running first would chase money that was about
  # to be recorded, and a customer chased for an invoice they already paid stops
  # reading these emails entirely.
  "resellersos-invoice-dunning|15 9 * * *|/api/cron/invoice-dunning|Overdue-invoice dunning: day 1/3/7/14 from due date"
  # 1st of the month, 00:30 IST — after the midnight backup and before the day's
  # jobs touch anything, so the snapshot describes the month that just ended rather
  # than one already half-modified by a renewal run.
  "resellersos-mrr-snapshot|30 0 1 * *|/api/cron/mrr-snapshot|Monthly MRR per customer — the history NRR is computed from"
  "resellersos-compliance-reminders|30 9 * * *|/api/cron/compliance-reminders|Statutory reminders T-15/T-7/T-3 to owner + CA"
  "resellersos-trial-expiry|0 10 * * *|/api/cron/trial-expiry|Expire trials that have run out"
  "resellersos-birthday-greetings|1 21 * * *|/api/cron/birthday-greetings|Birthday and anniversary greetings"
  "resellersos-google-contacts-sync|0 */6 * * *|/api/cron/google-contacts-sync|Two-way Google Contacts sync"
  "resellersos-gbp-sync|30 2 * * *|/api/cron/gbp-sync|Google Business Profile reviews + performance sync"
  "resellersos-ads-sync|0 3 * * *|/api/cron/ads-sync|Google Ads + Meta Ads daily spend sync"
  # R-524: "Try the demo" sample workspace — fresh sample rows nightly. Does nothing while DEMO_ENABLED is off.
  "resellersos-demo-reset|30 2 * * *|/api/cron/demo-reset|Reset the read-only demo workspace sample data"
  "resellersos-lead-finder|30 3 * * *|/api/cron/lead-finder|AI Lead Finder — nightly prospect discovery"
  # S34. Every 15 min, 08:00–21:45 IST — IndiaMART asks for >= 5 min between calls per key,
  # and an enquiry answered within the hour is the one that converts. Harmless before any
  # company saves a key: the route returns `disabled: true` without calling IndiaMART.
  "resellersos-indiamart-leads|*/15 8-21 * * *|/api/cron/indiamart-leads|IndiaMART Lead Manager pull → leads"
  "resellersos-attendance-retention|0 2 * * *|/api/cron/attendance-retention|Erase attendance face images past retention"
  # Midnight IST, before the other jobs touch anything — a restore point of the
  # day that just ended, not of a day already half-modified by the 09:00 renewal
  # cron. Keeps the newest 30 per tenant (0244).
  "resellersos-backup|0 0 * * *|/api/cron/backup|Nightly restore point for every tenant"
  # HOURLY, and the only job here that is not daily. The AI sales agent schedules its
  # follow-ups in HOURS (SALES_AGENT_SCHEMA bounds in_hours at 1..720), so a daily sweep
  # would round every "chase them this afternoon" up to tomorrow and make the shortest
  # useful follow-up impossible to express.
  #
  # Business hours only (09:00–19:00 IST, Mon–Sat). A nudge landing at 03:00 reads as a
  # machine no matter how well it is written, and Sunday mail to an Indian SME owner is
  # worse than no mail. The rows do not expire — anything that came due overnight is
  # picked up by the 09:00 run.
  #
  # Safe to enable before anybody trusts it: `followup.send` ships as `hold`, so until
  # somebody moves that dial from /automation this job drafts onto lead timelines and
  # sends nothing.
  "resellersos-ai-sales-loop|0 9-19 * * 1-6|/api/cron/ai-sales-loop|AI sales agent follow-ups that have come due"
  # EVERY 15 MINUTES, and ROUND THE CLOCK — the only job here that is both.
  #
  # The frequency is set by the cheaper of its two halves, not the more important one. The
  # 48-hour auto-close would be happy running daily; the "an escalated ticket has been
  # nobody's for 30 minutes" alert cannot be kept by an hourly sweep, because the alert
  # would land anywhere between 30 and 90 minutes late and the number in it would be a
  # fiction. A support promise people learn to distrust is worse than no promise.
  #
  # No business-hours window, unlike the sales follow-up above. Both halves are INTERNAL:
  # closing a ticket for silence is a state change on our own row, and the breach alert goes
  # to our own desk. Nothing here mails a customer, so there is no 03:00 message to be
  # embarrassed by — and a Saturday-night outage escalation nobody was told about until
  # Monday is exactly the failure this job exists to prevent.
  #
  # Safe to enable immediately, and it is NOT gated by the autonomy dial for the reason
  # above: the dial stops what the app sends OUT to other people, and must never be able to
  # silence what the app says TO US.
  "resellersos-ai-support-sla|*/15 * * * *|/api/cron/ai-support-sla|Close silent support tickets; alert on unassigned escalations"
  # 10:30 IST, once a day, weekdays only — and every part of that is deliberate.
  #
  # ONCE: the job selects subscriptions renewing on an EXACT date five days out, so each one
  # is a candidate exactly once. A second run the same day would find the same cohort and,
  # were it not for the 24-hour gap in decideTelecall, ring them twice.
  #
  # 10:30, not 09:00 like the mail crons: this one RINGS A PHONE. Nine in the morning is
  # somebody's commute. It also has to sit inside the quiet-hours window the app already
  # obeys (09:00–19:00 IST) with room to spare, because a run that starts near the edge of
  # that window has its later calls refused by the clock.
  #
  # Mon–Fri, not Mon–Sat: quietHoursDecision treats Saturday as a weekend and would refuse
  # every call, so a Saturday entry would be a job that exists to be turned down.
  #
  # Safe to enable before anybody trusts it: `telecall.place` ships as `hold`, so until
  # somebody moves that dial from /automation this job prepares each call — number, script,
  # the figures it is allowed to quote — files it on the call record, and dials nothing.
  "resellersos-ai-telecall-renewals|30 10 * * 1-5|/api/cron/ai-telecall-renewals|AI voice reminder for subscriptions renewing in 5 days"
  # ── The ten that were never in this file (deep study S9, 27 Sep 2026) ──────────────
  # Six of them existed in Cloud Scheduler by hand (Mumbai, then copied to Singapore on
  # 27 Sep) and four never existed anywhere. A job that lives only in the console is a job
  # the next region move loses again.
  "resellersos-health-digest|30 8 * * *|/api/cron/health-digest|Morning ops digest: cron failures + health signals to the owner"
  # R-112 / R-220 (7 Oct 2026): the same route now carries the OWNER MORNING DIGEST (money in
  # yesterday, overdue, waiting on you, 30-day renewal risk) and should run at 08:00 IST.
  # NOT ENABLED — Pardeep enables it himself. Check the numbers first with
  #   GET /api/cron/health-digest?dryRun=1   (sends nothing; &format=html shows the mail)
  # then uncomment the line below, delete the 08:30 line above, and run this script with
  # ONLY=resellersos-health-digest UPDATE_EXISTING=1 so the existing job is moved, not doubled.
  # "resellersos-health-digest|0 8 * * *|/api/cron/health-digest|Owner morning digest (money in, overdue, waiting on you, renewal risk) + app health"
  "resellersos-billing|0 8 * * *|/api/cron/billing|Subscription billing run (idempotent, at-least-once safe)"
  "resellersos-ai-reflection|0 8 * * *|/api/cron/ai-reflection|AI agents daily reflection over yesterday conversations"
  # Every 5 minutes: a reply the AI could not send (Gemini 503, timeout) is retried here; a
  # lead waiting 5 minutes is fine, a lead waiting until tomorrow is lost.
  "resellersos-ai-reply-retry|*/5 * * * *|/api/cron/ai-reply-retry|Retry AI replies that failed to send"
  # Every minute: the inbound sales mailbox. Bounded by MAX_PER_RUN inside the route.
  "resellersos-gmail-inbox|* * * * *|/api/cron/gmail-inbox|Read the sales Gmail inbox into enquiries"
  "resellersos-attendance-reminders|*/30 9-20 * * *|/api/cron/attendance-reminders|Punch-in / punch-out nudges, working hours only"
  # Hosting & domain workers. All four are gated INSIDE the route by env flags
  # (DOMAIN_REGISTRATION_LIVE etc.) and by a per-row, per-day command id, so scheduling
  # them is safe: with the flag off they list what they would do and touch nothing.
  "resellersos-provision-hosting|*/15 9-21 * * *|/api/cron/provision-hosting|Provision paid hosting orders through the DMS engine"
  "resellersos-register-domains|*/15 9-21 * * *|/api/cron/register-domains|Register paid domains through the DMS engine"
  "resellersos-renew-domains|0 7 * * *|/api/cron/renew-domains|Renew paid domain renewals at the registrar"
  "resellersos-renew-hosting|0 7 * * *|/api/cron/renew-hosting|Renew paid hosting through the DMS engine"
)

echo "Region:  $REGION"
echo "Service: $SERVICE_URL"
echo "Zone:    $TZ_NAME"
echo

for row in "${JOBS[@]}"; do
  IFS='|' read -r NAME SCHEDULE PATH_ DESC <<< "$row"

  # ONLY="job-a,job-b" — touch just these (2 Oct 2026 go-live: 4 of the 11 missing jobs were
  # wanted; the rest wait for DMS / ad keys). Unset = every job, as before.
  if [[ -n "${ONLY:-}" && ",${ONLY}," != *",${NAME},"* ]]; then
    continue
  fi

  # `describe` is the cheapest existence check that does not depend on parsing
  # `list` output, which changes between gcloud versions.
  if gcloud scheduler jobs describe "$NAME" --location="$REGION" >/dev/null 2>&1; then
    # SKIP BY DEFAULT — do not touch a job that already works.
    #
    # This script used to `update` here, and that was dangerous. An update rewrites
    # the Authorization header, so running it with the wrong CRON_SECRET would
    # break jobs that are currently fine. Three of these (renewals, trial-expiry,
    # birthday-greetings) have been running in production since July; renewals last
    # fired at 09:00 IST today. Silently re-pointing their credentials to "whatever
    # was in my shell" is not a setup step, it is an outage.
    #
    # Pass UPDATE_EXISTING=1 to overwrite deliberately — e.g. when rotating the
    # secret, which is the one time you actually want every job rewritten.
    if [[ "${UPDATE_EXISTING:-0}" != "1" ]]; then
      echo "==> skip:   $NAME  (already exists — set UPDATE_EXISTING=1 to overwrite)"
      continue
    fi
    ACTION="update"
  else
    ACTION="create"
  fi

  # `create` takes --headers; `update` takes --update-headers. They are not
  # interchangeable, and this script used --update-headers for BOTH — so it could
  # never create a job. Every "create" line it printed was followed by
  # "unrecognized arguments", which is why the six jobs in production were made by
  # hand. The same failure this file was written to fix, one level up: a setup
  # script that looks like it works and has never once created anything.
  if [[ "$ACTION" == "create" ]]; then
    HEADER_FLAG="--headers"
  else
    HEADER_FLAG="--update-headers"
  fi

  echo "==> ${ACTION}: $NAME  ($SCHEDULE $TZ_NAME)  $PATH_"
  # 2>&1 through a filter: gcloud echoes the FULL argument list on an argument
  # error, which put the live CRON_SECRET into a terminal once already. Any line
  # carrying the secret is replaced rather than printed.
  if ! gcloud scheduler jobs "$ACTION" http "$NAME" \
    --location="$REGION" \
    --schedule="$SCHEDULE" \
    --time-zone="$TZ_NAME" \
    --uri="${SERVICE_URL}${PATH_}" \
    --http-method=GET \
    "$HEADER_FLAG"="Authorization=Bearer ${CRON_SECRET}" \
    --attempt-deadline=540s \
    --description="$DESC" \
    --quiet 2>&1 | sed "s|${CRON_SECRET}|<redacted>|g"
  then
    echo "    ^ failed — see the message above (secret redacted)." >&2
  fi
done

cat <<'DONE'

Done. Verify what is now scheduled:

  gcloud scheduler jobs list --location=asia-southeast1

Prove one end to end WITHOUT waiting for its schedule — the renewals and
compliance jobs both support a dry run that sends nothing and writes nothing:

  gcloud scheduler jobs run resellersos-renewals --location=asia-southeast1
  gcloud logging read \
    'resource.type=cloud_run_revision AND textPayload:"cron"' \
    --limit=20 --freshness=10m

A 401 in those logs means the CRON_SECRET here does not match the one the
service runs with — fix that before trusting any of these jobs.
DONE
