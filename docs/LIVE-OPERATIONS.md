# Live chalane ke niyam (from 17 Oct 2026)

Card **R-911** · owner **Pardeep** · written 11 Oct 2026 · applies from the 17 Oct cutover; real customers from 20 Oct.

Live = Cloud Run service **`resellersos`**, region **`asia-southeast1`**, project **`resellsubsos-prod`**,
URL **https://reselleros.anutech.in**, database Cloud SQL **`resellersos-db`**.
(Values from `cloudbuild.yaml` substitutions and `production/deploy.sh`.)

Related docs — this file does not repeat them:

| Doc | For |
|---|---|
| [`production/docs/R-909-LIVE-CUTOVER.md`](../production/docs/R-909-LIVE-CUTOVER.md) | One-time move of live to Auth.js + gateway (15 Oct rehearsal, 17 Oct cutover) |
| [`ROLLBACK.md`](ROLLBACK.md) | Long version of section 3 (why pinning, env vars per revision) |
| [`BACKUP.md`](BACKUP.md) | Backups, PITR, off-site copies |
| [`MONITORING_SETUP.md`](MONITORING_SETUP.md) | What alerts exist and how they were set up |
| [`production/docs/STAGING-TRAIN.md`](../production/docs/STAGING-TRAIN.md) | How code reaches staging |
| [`ACCESS.md`](ACCESS.md) | Who is admin where (names only) |

Gaps are marked **TODO R-xxx** — that card owns the fix.

---

## 1. Live deploy kab hota hai

- **Two days a week, after 17:00 IST.** Default days: **Tuesday and Friday** (Pardeep can change the days — then change
  this line). Nothing goes live in the daytime; daytime work goes to local → staging only.
- **Only with Pardeep's haan on that day**, in chat, for that exact sha. A haan from yesterday, from a card, or from
  another session does not count.
- **Who runs it:** the manager session runs the steps; Pardeep logs in to gcloud and says haan per step. Workers never
  push the `deploy` branch, never run a live DB script, never change Cloud Run.
- **How code reaches live:** push of the green staging sha to the `deploy` branch → Cloud Build trigger
  `resellersos-deploy-on-push` runs `cloudbuild.yaml` (gate: `npm ci` + tsc + vitest, then image, then `gcloud run deploy`).
  Fast-forward only, never `--force`.
- **`production/deploy.sh` is gated (R-884, 12 Oct).** It no longer runs `gcloud run deploy --source .`; it runs
  `scripts/ops/deploy-gate.mjs` (tree clean + sha pushed to anutech + GitHub **CI** and **SQL tests** green on that
  exact sha) and only then fast-forwards `anutech/deploy` to the sha, so the build always goes through `cloudbuild.yaml`.
  Always `bash production/deploy.sh --dry-run <sha>` first. `--emergency` can skip red CI only after typing the phrase
  it shows (`DEPLOY <sha8> WITHOUT GATE`); logged to `~/.reselleros/deploy-overrides.log`. Never `gcloud run deploy --source .`.
- **First live deploy = the R-909 cutover on 17 Oct.** Use that runbook for 17 Oct, this file after it.

### Emergency hotfix (outside the 2 days)

Allowed only when live is broken for customers **right now** (a P0, section 4) and a rollback (section 3) does not fix it.
1. **Roll back first** (section 3). Most "emergencies" end there; the fix then waits for the next deploy day.
2. If a hotfix is still needed: card with `kind: "bug"`, p0; smallest possible change; same gates as section 2
   (CI green on the sha, staging check) — only the day/time rule is skipped.
3. Pardeep's haan in chat for the hotfix, any time of day.
4. Same day: one liveLog line on the card — what broke, what was deployed, sha, time (`date -u`).

---

## 2. Har live deploy se pehle — checklist

All must be ✓ before asking Pardeep for haan. The manager posts this list with ✓/✗ in chat.

| # | Check | How |
|---|---|---|
| 1 | Every card in the release is ✓ on **staging** by its reporter / owner (board stage "Staging par" with Theek) | Board; cards without ✓ are taken out or Pardeep says go anyway |
| 2 | The sha going live is **exactly** the one checked on staging | `git log --oneline -1 <sha>`; staging `/api/version` showed this sha |
| 3 | GitHub **CI**, **SQL tests**, **Money check** and **E2E (logged-in)** are green on that exact sha | `gh run list --commit <sha>` (workflows in `.github/workflows/`). `bash production/deploy.sh --dry-run <sha>` checks CI + SQL tests (R-884); Money check / E2E still a manual look |
| 4 | New migrations were **rehearsed on the staging DB** with the same script | Every migration has a `-- deploy-peek:` line; `node scripts/ops/gen-deploy-db.mjs --date <day> --check` passes; the staging `deploy-db-<day>.sh` ran and printed "DB READY" |
| 5 | Every migration keeps the **old code working** (expand → deploy → contract) | No drop/rename of anything the live revision still uses — this is what makes a code-only rollback safe (section 3) |
| 6 | **Backup** just before the DB step | The live `deploy-db-<day>.sh` takes an on-demand backup first and stops if it is not SUCCESSFUL — note the backup id it prints |
| 7 | **Point-in-time recovery** is on (7 days) | `gcloud sql instances describe resellersos-db --project=resellsubsos-prod --format="value(settings.backupConfiguration.pointInTimeRecoveryEnabled,settings.backupConfiguration.transactionLogRetentionDays)"` → `True 7` |
| 8 | **Release notes** written | One short list in chat + on each card: card id, one line in plain words, any migration, anything Pardeep/team must do after. No separate tool exists today |
| 9 | Previous revision name written down | `gcloud run services describe resellersos --region=asia-southeast1 --project=resellsubsos-prod --format="value(status.traffic)"` — this is the rollback target |

**Order on deploy day:** live DB step (Pardeep runs `production/supabase/cloudsql/live/deploy-db-<day>.sh` in his terminal)
→ "DB READY" → push `deploy` → build SUCCESS → `npm run verify:deploy` (shows the live sha) → quick browser check
(login, one invoice + PDF, one money page) → board cards get `onLive`.

The live DB script is Pardeep's: Claude may not run SQL on the live DB.

---

## 3. 10 minute mein wapsi (rollback)

**Rule: roll back first, debug after.** If live is broken after a deploy and the cause is not clear in 2 minutes, move
traffic back. It changes no code and no data, and takes about a minute.

Flags checked with `gcloud run services update-traffic --help` on 11 Oct 2026.

```bash
# 1. What is serving now, and the last 5 revisions (newest first; image tag = commit short sha)
gcloud run services describe resellersos --region=asia-southeast1 --project=resellsubsos-prod \
  --format="value(status.traffic)"
gcloud run revisions list --service=resellersos --region=asia-southeast1 --project=resellsubsos-prod --limit=5 \
  --format="table(metadata.name, status.conditions[0].status:label=READY, spec.containers[0].image.basename(), metadata.creationTimestamp)"

# 2. All traffic to the last good revision (newest one OLDER than the bad one, READY = True)
gcloud run services update-traffic resellersos --region=asia-southeast1 --project=resellsubsos-prod \
  --to-revisions=<previous-revision>=100

# 3. Check (after ~30 s) — sha must be the OLD one
curl -s https://reselleros.anutech.in/api/version
```

Then open login + one invoice in the browser. Post one liveLog line on the card(s).

**After the fix — un-pin, or the next deploy gets no traffic:**

```bash
# optional: try the new revision on its own URL first, at 0% traffic
gcloud run services update-traffic resellersos --region=asia-southeast1 --project=resellsubsos-prod \
  --set-tags=candidate=<new-revision>
# when it is good
gcloud run services update-traffic resellersos --region=asia-southeast1 --project=resellsubsos-prod --to-latest
```

Who: Pardeep runs it or says haan and the manager runs it. A rollback is the **one** live action that may happen
without waiting for the evening — but still with Pardeep's haan in chat.

Watch out:
- **Env vars belong to a revision.** Rolling back also rolls back any env var changed since. Re-apply with
  `gcloud run services update ... --update-env-vars` — **never `--set-env-vars`** (it deletes all live-only keys).
- **Do not roll back across the 17 Oct cutover.** Revisions from before it (e.g. `resellersos-00035-prc`) need the
  stopped Supabase VM. After 17 Oct the oldest safe target is the cutover revision; before that, fix forward.
  (Cutover-day rollback: `node scripts/ops/r909-live-cutover.mjs rollback-traffic --run`, R-909 runbook 8.9.)
- The rollback in Asia-southeast1 has **not been rehearsed** yet (`ROLLBACK.md` rehearsal log). Do it once on the first
  quiet deploy day after 17 Oct and add a row there.

### Database: forward-fix only

- A rollback moves **code** only. The DB stays as the new deploy left it.
- **Never run a "down" migration on live.** Undo = a **new** migration (`npm run migration:new`), with its own
  `-- deploy-peek:`, rehearsed on staging, run by Pardeep.
- Data damaged (not just code)? That is a **restore**, not a rollback: Cloud SQL point-in-time recovery or the backup id
  from deploy day, restored to a **new** instance first (`BACKUP.md`). It touches every tenant → Pardeep decides, never AI.
  The R-909 runbook (8.2) has the in-place restore command for cutover day only.

### Switching a feature off fast

There is **no general feature-flag system** in the code. What exists:

| Switch | What it stops | How |
|---|---|---|
| `HOSTING_TRIAL_LIVE`, `HOSTING_PROVISIONING_LIVE`, `HOSTING_RENEWAL_LIVE`, `DOMAIN_REGISTRATION_LIVE`, `DOMAIN_RENEWAL_LIVE` | Real hosting accounts / domain registrations and renewals (they cost money). Off unless the value is `1` | `gcloud run services update resellersos --region=asia-southeast1 --project=resellsubsos-prod --remove-env-vars=<NAME>` (creates a new revision, ~1 min) |
| `DEMO_ENABLED` | Public demo login | same, remove the var |
| Cloud Scheduler jobs | All crons (emails, reminders, renewals, inbox) | `node scripts/ops/r909-live-cutover.mjs scheduler-pause --run` / `scheduler-resume --run` (R-909 helper; dry run without `--run`) or `gcloud scheduler jobs pause <job> --location=asia-southeast1 --project=resellsubsos-prod` for one job |
| Razorpay | Online payments | No app switch; pause from the Razorpay dashboard (Pardeep) |

Anything else = rollback, or a hotfix. **TODO**: a small kill-switch list (payments, outbound email/WhatsApp) — not carded yet.

---

## 4. Live par nazar (watching)

What exists today (`MONITORING_SETUP.md`, set up 29 Sep):

| Signal | Where | Goes to |
|---|---|---|
| Uptime check "ResellerOS live" (every 5 min, 3 regions) + alert after 10 min | Cloud Monitoring | "ResellerOS ops email" channel |
| 5xx spike (> 20 in 5 min on `resellersos`) | Cloud Monitoring | same |
| Cron failure (`[cron/<job>]` line in logs) | Cloud Monitoring, log-based, max 1 mail/hour | same |
| App errors (server + browser) | Sentry (`SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`) | Sentry inbox |
| Daily health digest (errors from logs + money/overdue numbers) | cron `resellersos-health-digest`, every morning IST | email to the owner |
| In-app bug reports (Report Bug button) | `/admin/feedback` + agent feedback queue | auto card pipeline (AI triage → card → worker) |

**Known gap — TODO R-886:** the uptime check still watches the old run.app `/login`, and nobody has verified the alert
email actually arrives. Must be fixed right after the 17 Oct cutover: point it at
`https://reselleros.anutech.in/api/public/health/live` (`production/scripts/setup-uptime-checks.sh`, idempotent) and send a
test alert to Pardeep.

### What is a P0

Any of these on live = **P0** (drop other work):
- Live down / login broken for everyone (uptime alert, 5xx spike).
- **Money wrong**: wrong amount, GST, invoice number, a payment not recorded or recorded twice.
- One customer can see another customer's data (tenant leak) or any security hole.
- Data lost or changed without a user doing it.
- A cron sending wrong emails/WhatsApp to customers, or charging / registering wrongly.

P1 = one important flow broken for some users, no money/data harm. Everything else = normal card.

### Who does what, how fast

| | AI (manager session / dispatcher) | Pardeep |
|---|---|---|
| Sentry + bug-report queue | Checks on every dispatcher tick while a session runs; makes the card (`kind: "bug"`, priority), starts a worker | Reads the P0 summary |
| P0 | Tells Pardeep in chat **at once** (security/money/blocker = urgent, not batched); proposes rollback with the exact command | Says haan to rollback/hotfix; talks to the customer |
| Alert emails (uptime, 5xx, cron) | **Cannot receive them** — they go to the ops email | First to see them when no session is running; pastes into chat |
| Target | P0: rollback decision in **15 min** from the alert; P1: fix on the next deploy day | |

Honest limit: there is **no 24×7 human on-call**. Out of office hours an alert waits until Pardeep sees the email. Adding a
phone/SMS channel is part of **R-886**.

---

## 5. Customer data badalna

- **Changing a real customer's data directly in the DB** (SQL, scripts, bulk fixes, deletes, imports) happens **only with
  the owner's haan** — Pardeep, and for a tenant's own data that tenant's owner too — for that exact change.
- **AI never runs anything on the live DB.** Claude's production read/write is blocked by design (see the live deploy-db
  script header). AI writes the SQL file, tests it on staging / a clone, and Pardeep runs it in his terminal.
- Every such change is a **committed SQL file** with a card id (no hand-typed SQL on live), run once, and the card gets
  a liveLog line: what, how many rows, who ran it, time (`date -u`), backup id taken before.
- Normal changes by users inside the app are logged by the app's own audit trail; DB-level fixes are not — that is why
  the card + committed file are the audit for them.
- Test data never goes on live after 20 Oct. Checks on live use only records named "Test …", deleted the same day.

---

## 6. Restore drill

A backup is only trusted once it has been restored.
- **TODO R-887:** script that restores the latest Cloud SQL backup into a temporary clone, runs read-only row counts,
  then deletes the clone (dry run by default; a real run costs money → Pardeep's haan).
- Until then: the 29 Sep off-site JSON rehearsal (`BACKUP.md`) and the 15 Oct live-DB clone rehearsal (R-909 runbook 4.4)
  are the only proofs.
- After R-887: run it **once a month** and before any big migration; result as a row in `BACKUP.md`.

---

## 7. Contacts and where secrets live (names only — never values here)

| What | Who |
|---|---|
| Haan for deploy, rollback, live DB, customer data | **Pardeep** (pardeep@anutech.in) |
| GCP project owner (second admin) | Abhishek (`ACCESS.md`) |
| Billing account admin | Abhishek (`ACCESS.md`, R-017) |
| Testing on staging, customer feedback | Abhishek, Pawan |

Secrets:
- **Google Secret Manager**, project `resellsubsos-prod` — after cutover the `live-*` secrets
  (`live-database-url`, `live-auth-secret`, `live-supabase-jwt-secret`, `live-service-role-key`, `live-db-app-*-password`, …;
  full list in the R-909 runbook section 2) plus `agent-queue-token`.
- **Cloud Run env vars** on `resellersos` — some keys are still plain env vars there (`CRON_SECRET`, `RESEND_API_KEY`,
  `SECRETS_MASTER_KEY`, DirectAdmin/ResellerClub keys …). Moving them into Secret Manager: `SECURITY-RUNBOOK.md` §4
  (not done). **`SECRETS_MASTER_KEY` must never change** — it decrypts the vault rows in the DB.
- **GitHub Actions secrets** — E2E logins and CI (R-839 / R-883).
- Local test logins: `.env.test` on Pardeep's laptop (never committed).
- Never paste a secret value in chat, a card, a commit or this repo.
