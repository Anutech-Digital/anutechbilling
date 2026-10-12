# Email Deliverability Setup — Resend + Cloudflare DNS

> **Status**: ⏳ in progress · paused 2026-05-29 · resume next session
> **Owner**: Pardeep (manual signup + DNS) → Claude (Cloud Run env vars + test)
> **Approach**: Use `example.test` as sending domain temporarily, until `resellersos.in` is bought
> **From-address**: `ResellerOS by Client A <noreply@example.test>`

---

## Why this matters

Current state: app falls back to `onboarding@resend.dev` (shared sender) → 30-40% of renewal reminders + quote emails land in spam.

After setup: emails ship from `noreply@example.test` with proper SPF + DKIM + DMARC → 95%+ inbox delivery.

---

## Pre-confirmed facts (saved 2026-05-29)

- **Domain**: `example.test` (already owned by Client A)
- **DNS provider**: Cloudflare (nameservers: `addilyn.ns.cloudflare.com`, `damian.ns.cloudflare.com`)
- **Resend account**: Pardeep has one (login available)
- **Cloud Run env vars to update** (Claude's job):
  - `RESEND_API_KEY=re_...`
  - `RESEND_FROM_DEFAULT=ResellerOS by Client A <noreply@example.test>`

---

## Pardeep's checklist (~20 min)

### ☐ Step 1 — Add domain in Resend

1. Open https://resend.com → login
2. Left sidebar → **Domains**
3. Top-right → **Add Domain**
4. Enter: `example.test`
5. Region: **EU** (closer latency to India than US)
6. Click **Add Domain**

### ☐ Step 2 — Copy DNS records from Resend

Resend will show a table with **4 records**:

| Type | Name | Value | Priority |
|---|---|---|---|
| MX | `send.example.test` | `feedback-smtp.eu-west-1.amazonses.com` | 10 |
| TXT | `send.example.test` | `v=spf1 include:amazonses.com -all` | — |
| TXT | `resend._domainkey.example.test` | (long DKIM key, ~400 chars) | — |
| TXT | `_dmarc.example.test` | `v=DMARC1; p=none;` | — |

**Screenshot this table and send to Claude** so values can be verified.

### ☐ Step 3 — Add records in Cloudflare

1. Open https://dash.cloudflare.com → login
2. Left sidebar → click `example.test`
3. Top menu → **DNS → Records**
4. For each of the 4 records above, click **Add record**:
   - **Type**: as in table (MX or TXT)
   - **Name**: `send` / `resend._domainkey` / `_dmarc` (Cloudflare auto-appends domain)
   - **Content/Value**: paste from Resend
   - **Proxy status**: **DNS only** (gray cloud, NOT orange) ⚠️
   - **TTL**: Auto
5. Save each one

⚠️ **Critical**: Proxy MUST be gray, not orange. Email DNS records cannot be proxied through Cloudflare.

### ☐ Step 4 — Verify on Resend

1. Wait 5-15 minutes after saving Cloudflare records
2. Back to Resend → Domains page
3. Click **Verify** next to `example.test`
4. All 4 records should turn green ✅

If any record fails:
- Most common: typo in pasted value (especially DKIM — it's long)
- Re-check Cloudflare record matches Resend exactly
- TTL effect: wait another 10 min

### ☐ Step 5 — Get API key

1. Resend → left sidebar → **API Keys**
2. **Create API Key**
3. Name: `ResellerOS production`
4. Permission: **Sending access only** (NOT Full Access — least privilege)
5. Click **Add** → copy the key (starts with `re_...`)
6. Share securely with Claude:
   - Best: paste in next conversation as "Resend API key: re_..."
   - It will be set on Cloud Run, not stored in code/git

---

## Claude's checklist (after Pardeep done)

### ☐ Step 6 — Set Cloud Run env vars

```bash
gcloud run services update resellersos \
  --region asia-south1 \
  --update-env-vars \
RESEND_API_KEY=re_<paste-from-pardeep>,\
RESEND_FROM_DEFAULT="ResellerOS by Client A <noreply@example.test>"
```

### ☐ Step 7 — Test send

Send a test renewal reminder email manually:

```bash
# Hit existing test endpoint or trigger via app:
# Option A: Resend dashboard "Send test email"
# Option B: Sign in as pardeep@anutech.in, trigger a quote send to pardeep@example.test
```

Or simpler: send via Resend dashboard direct test feature → recipient is Pardeep's email.

### ☐ Step 8 — Score via mail-tester.com

1. Open https://www.mail-tester.com/
2. Copy the test email address it shows
3. From within ResellerOS app, send a quote to that address (via the existing Send-quote flow)
4. Back to mail-tester → check score
5. **Target**: 9-10 / 10
6. Anything <8 → investigate (most common: missing DMARC alignment, BIMI not set, etc.)

### ☐ Step 9 — Update PROJECT_TRACKER + close task

- Mark Day 4c (email deliverability) ✅ done in tracker
- Update Phase 18 (Monitoring) historical rollup
- Close task #231

---

## Resume tomorrow

Tomorrow, just paste this in chat to resume:

> "Email setup resume karte hain — `docs/EMAIL_SETUP_RESEND.md` follow kar liya, screenshot bhej raha hu / API key ye hai: re_..."

Claude will pick up from wherever the checklist left off.

---

## Future migration to resellersos.in

When `resellersos.in` is purchased:

1. Add `resellersos.in` as a 2nd domain in Resend
2. Verify DNS (same SPF/DKIM/DMARC pattern, on resellersos.in DNS panel)
3. Update Cloud Run env: `RESEND_FROM_DEFAULT="ResellerOS <hello@resellersos.in>"`
4. Keep `example.test` verified as backup sender
5. Done — no code changes needed
