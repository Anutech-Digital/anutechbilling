# Monitoring setup — what exists, and how it was set up

## What exists today (updated 30 Sep 2026)

| What | Where | State |
|---|---|---|
| **Uptime check "ResellerOS live"** | Cloud Monitoring, project `resellsubsos-prod` | Created 29 Sep 2026 by `production/scripts/setup-uptime-checks.sh`. Watches **`/login`** (run with `HEALTH_PATH=/login` because `/api/public/health/live` was not deployed yet), HTTPS, every 5 min, from 3 regions (asia-pacific, europe, usa-oregon), expects 200 |
| **Alert "ResellerOS live — uptime failing"** | Cloud Monitoring | Created 29 Sep. Fires when the check fails from 2+ regions for 10 min |
| **Alert "ResellerOS cron failure"** | Cloud Monitoring (log-based) | Created 29 Sep. Fires on a `[cron/<job>]` line on the service's stderr (written by `lib/ops/cron-report.ts`); max one mail/hour |
| **Alert "ResellerOS 5xx spike"** | Cloud Monitoring | Created 29 Sep. More than 20 5xx responses in 5 minutes on the `resellersos` service |
| Notification channel "ResellerOS ops email" | Cloud Monitoring | Email; all three alerts notify it |
| **Sentry** (server + browser) | sentry.io | `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` set on Cloud Run (verified 1 Sep). Server/edge init runs from `production/instrumentation.ts` `register()` (Next 15 calls it at boot), with the `@/lib/sentry` import as backup |
| BetterStack | — | **Not set up.** Optional now: Cloud Monitoring covers uptime. Its one advantage is living outside the GCP project/billing account (see the external heartbeat, `HEARTBEAT_PING_URL`) |

**Next step (after `/api/public/health/live` is deployed):** re-run the script without
`HEALTH_PATH` so the same check (same name, same alert) watches app **and** database
instead of just the login page:

```bash
PROJECT=resellsubsos-prod NOTIFY_EMAIL=pardeep@anutech.in ./production/scripts/setup-uptime-checks.sh
```

The script is idempotent — existing channel/policies are skipped, the check's path is
updated in place. Service: `resellersos`, region **`asia-southeast1`** (the move from
`asia-south1` happened 5 Sep; commands further down that still say `asia-south1` are the
historical setup record). Public host: `https://reselleros.anutech.in`.

Not verified from the repo: whether the older 1 Sep uptime check on `/api/version` and its
"ResellerOS down" alert (TASKS.md A7, `docs/DEPLOY-ROLLBACK.md`) still exist next to these.
Check in Cloud Monitoring → Uptime checks, and delete the duplicate if so.

---

## Historical setup record

> Sentry was set up before 1 Sep 2026; the "🔴 Sentry" section below is a **record of how
> it was set up, not an open task** — skip straight to verification (`/api/sentry-test`,
> needs `ALLOW_SENTRY_TEST=1` in production) if you're checking it still works. Org/email
> references say "Client A" — historical; the company is **ANUTECH DIGITAL PVT LTD** now
> (CLAUDE.md §1).

Two services give us full production visibility:

- **Sentry** → catches every JavaScript / server error with stack trace + breadcrumbs
- **BetterStack** → pings the live URL every minute; alerts if down

Both have generous free tiers. Total monthly cost while small: **₹0**.

Code-side is fully wired — both products activate the moment you set env vars on Cloud Run.

---

## 🔴 Sentry — error tracking

### 1. Sign up (3 min)

URL: **https://sentry.io/signup/**

- Use your Client A email
- Organization name: `client-a` (or anything)
- Choose plan: **Developer (Free)** — 5,000 errors/month
- Platform: **Next.js**

After signup → "Create Project" wizard:
- Platform: **Next.js**
- Alert frequency: **On every new issue**
- Project name: `resellersos`
- Team: `#default`

### 2. Copy the DSN (1 min)

After project creation, Sentry shows you a snippet like:
```
Sentry.init({
  dsn: "https://abc123...@o4506789.ingest.sentry.io/4506789",
  ...
});
```

Copy the **DSN string** (the `https://...@...sentry.io/...` URL).

### 3. (Optional) Source-map auth token (3 min)

If you want **stack traces with original file names** instead of minified blobs:

1. Sentry → Settings → Account → Auth Tokens → **Create New Token**
2. Scope: `project:releases` + `project:write`
3. Copy the token string
4. Also note your **Org slug** + **Project slug** (visible in URL)

Without auth token: errors still get captured, but stack traces show minified code. Add the token later when you want to read traces easily.

### 4. Set env vars on Cloud Run (5 min)

```bash
gcloud run services update resellersos \
  --region asia-south1 \
  --update-env-vars \
NEXT_PUBLIC_SENTRY_DSN=https://abc123@o4506789.ingest.sentry.io/4506789,\
SENTRY_DSN=https://abc123@o4506789.ingest.sentry.io/4506789,\
SENTRY_ORG=client-a,\
SENTRY_PROJECT=resellersos,\
SENTRY_AUTH_TOKEN=YOUR_TOKEN_HERE
```

`NEXT_PUBLIC_SENTRY_DSN` = same DSN, exposed to client (this is intentional — Sentry DSNs are public-facing by design).

Cloud Run will auto-redeploy with new env. ~2 minutes downtime-free rollout.

### 5. Verify it works (1 min)

```bash
# Test from any terminal:
curl -i https://reselleros.anutech.in/api/sentry-test
# Should return HTTP 500 with our intentional error

# Within ~10 seconds, the error appears in:
# https://sentry.io/organizations/<your-org>/issues/
```

You'll see: **"ResellerOS Sentry smoke test — this is intentional, no action needed"**

Once verified, set `ALLOW_SENTRY_TEST=` (empty) to disable the test route again.

---

## 🟢 BetterStack — uptime monitoring

### 1. Sign up (2 min)

URL: **https://betterstack.com/users/sign-up**

- Sign up with Client A email
- Choose **Uptime** product (NOT Logs)
- Plan: **Free** — 10 monitors, 3-min check intervals, unlimited team

### 2. Add a monitor (3 min)

After login, **+ Create Monitor**:

| Field | Value |
|---|---|
| Monitor type | **HTTP/S** |
| URL to check | `https://reselleros.anutech.in/login` |
| Check frequency | **3 minutes** (free tier minimum) |
| Recovery period | 1 minute |
| HTTP status code | 200-299 expected |
| Name | `ResellerOS production` |
| Region | Mumbai or Singapore (closest) |
| Maintenance window | Optional |

### 3. Configure alerts (2 min)

After monitor created → **Notifications** tab:

- **Email:** your real email → "On every alert"
- **Webhook / SMS / Slack** → optional, free tier supports unlimited email recipients

Now if the site goes down for >3 minutes, you get an email within 6 minutes.

### 4. (Optional) Add status page (5 min)

BetterStack gives a free public status page at `<slug>.betteruptime.com`:

- Dashboard → **Status pages → Create**
- Add your monitor
- Customize colors / branding to amber
- Link from your main site: `<a href="https://resellersos.betteruptime.com">Status</a>`

This builds trust — paying customers like seeing 99.9% uptime publicly.

---

## 📊 What you'll see after setup

### Sentry inbox
Every JavaScript error from any browser + every server-side exception lands here. Grouped by stack trace. You can filter by:
- Production vs dev
- User (auth.uid)
- Tenant
- Page / route
- First seen / last seen

Set up email alerts so you get pinged on **new error types** (not every occurrence).

### BetterStack dashboard
- Uptime % over 24h / 7d / 30d / 90d
- Response time graph (latency tracking)
- Last 50 incidents with duration + status
- Trend: am I getting faster or slower over time?

---

## 💰 Cost reality

| Service | Free tier | Likely cost first year |
|---|---|---|
| Sentry | 5,000 errors/month | ₹0 |
| BetterStack | 10 monitors, 3-min intervals | ₹0 |
| **Total** | | **₹0 / year** |

Upgrade only when you have 5+ paying customers and need 30-sec interval monitoring or 50K errors/month.

---

## 🛠️ Troubleshooting

### "I set env vars but Sentry isn't capturing"

1. Check Cloud Run env vars are actually set: `gcloud run services describe resellersos --region asia-southeast1 --format='value(spec.template.spec.containers[0].env)'`
2. Confirm app re-rolled: `gcloud run revisions list --service resellersos --region asia-southeast1 --limit 3` — latest revision should be newer than when you set env vars
3. Hit `/api/sentry-test` curl above
4. Wait 10-20 seconds — Sentry batches events
5. Check spam folder of Sentry inbox

### "BetterStack pings but always shows down"

Cloud Run cold starts can take 5-15 seconds on first hit. If BetterStack times out at 3 seconds, increase to 10-second timeout in monitor settings.

### "Source maps not showing original file names"

Need `SENTRY_AUTH_TOKEN` set. Without it, traces are still captured but minified.

---

## 🎯 After setup — what should you do?

1. **Add 'Status' link to PublicFooter** pointing to BetterStack status page
2. **Add Sentry breadcrumbs** for important user actions (already-built error boundaries auto-capture)
3. **Set up weekly digest emails** in both products (overview without daily noise)
4. **Monitor for 1 week** — adjust noise thresholds if needed
