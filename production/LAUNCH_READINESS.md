# ResellerOS — Launch Readiness Audit

**Date**: 2026-05-24
**Auditor**: Claude (Product Architect)
**Goal**: Honest assessment before Pardeep dogfoods at Client A + onboards first paying customers.

---

> ## ⚠️ STALE — point-in-time snapshot from 2026-05-24. Do not trust the tables below.
>
> Stamped 2026-09-01 (CLAUDE.md §25.1: a doc found wrong is fixed or stamped in the same
> session). ~100 days on, most of what §1's **"🔴 Not built"** table lists as absent has
> since **shipped** — verified against the code on 2026-09-01, not remembered:
>
> | Doc said "not built" | Reality on 2026-09-01 |
> |---|---|
> | Customer portal | ✅ built — `src/app/(public)/portal/**` (12 pages) + `portal_customer_users` RLS/tests |
> | Team / invite members | ✅ built — invite route + `20260901090000_team_invites_token.sql` |
> | Contact import (CSV) | ✅ built — `import-csv-dialog.tsx` |
> | Sentry monitoring | ✅ built — `lib/sentry.ts` + chokepoint init (CLAUDE.md §22) |
> | WhatsApp | ✅ page shipped — `/whatsapp` |
> | Razorpay | ✅ webhook + verify shipped (3 route files); **live KYC/keys still Pardeep's** |
> | Gemini AI (scoring, replies, telecalling, sales agent) | ✅ heavily built — 81 libs under `lib/ai/` |
> | Reports | ✅ 4 report pages shipped — **GSTR-1 government-format export still pending** |
> | Hosting (§3 #1) | ✅ live on Cloud Run (`resellersos-njvk4nxhdq`), not "Firebase in progress" |
> | Resend / APP_URL / CRON_SECRET (§3 #2–4) | ✅ all resolved; only Resend **domain verify** remains (Pardeep) |
>
> **Line 178 is actively false:** "Hindi i18n (next-intl already set up)" — Hindi/i18n was
> **cancelled** by Pardeep on 2026-09-01 and `next-intl` uninstalled (CLAUDE.md §2). Do not
> re-propose it.
>
> **Still genuinely open:** GST e-Invoice IRP (IRN+QR), Google CSP / MS Partner / Zoho reseller
> APIs, GSTR-1 export, Razorpay live keys (KYC), Resend domain verify.
>
> **Current sources of truth:** `TASKS.md` (live status) · `production/CLAUDE.md` (conventions)
> · the deep-audit artifact. The narrative below is kept only as a record of where things stood
> at first-launch planning.

---

## TL;DR

Code shape me hai. **Frontend + DB + automated workflows production-grade hain.** Lekin **deploy ke saath ek baar 3 cheezein setup karni hain** for the app to actually deliver business value (emails, payments, GST). Rest is nice-to-have for v1.

| Stage | Status | Hours away |
|---|---|---|
| 1. Hosting (Firebase Blaze) | 🟡 In progress | ~30 min |
| 2. Resend API key (real emails) | 🔴 Blocked on signup | ~15 min |
| 3. Razorpay test keys (real payments) | 🔴 Blocked on KYC | ~1 day |
| **Dogfood-ready** | 🟡 | ~2 hrs + 1 KYC day |
| 4. Real customer onboarded | 🟡 | ~1 week of usage |

---

## 1. Feature inventory — what's built

### ✅ Core (P0) — done

| Feature | Status | Files |
|---|---|---|
| Multi-tenant auth + RLS | ✅ | `0001_init.sql`, `0002_rls.sql`, `lib/supabase/*` |
| Lead → Deal pipeline (Kanban + List) | ✅ | `(app)/leads/page.tsx` |
| Customer 360 with subs/quotes/payments | ✅ | `(app)/customers/[id]/page.tsx` |
| Quote builder (Workspace / M365 / Zoho plans) | ✅ | `components/features/quotes/quote-builder.tsx` |
| Quote PDF (server-rendered, branded) | ✅ | `lib/pdf/QuotePDF.tsx` |
| **Atomic record_payment RPC** (closes CLAUDE §17b tech debt) | ✅ | `0006_record_payment_rpc.sql` |
| Receipt Voucher (CGST §31(3)(d)) auto-issued | ✅ | `lib/pdf/ReceiptVoucherPDF.tsx` |
| Tax Invoice generation (CGST §31 sequential numbering) | ✅ | `lib/pdf/InvoicePDF.tsx`, `0004_document_series.sql` |
| Advance adjustment on invoice (CGST Rule 53) | ✅ | `0005_invoice_advance_adjustment.sql` |
| Subscription lifecycle (create on first payment) | ✅ | `record_payment` RPC body |
| **Full renewal automation** (T-15 → cadence → grace → suspend → roll-forward) | ✅ | `0008` + `0010` + cron + cadence engine |
| **On-demand renewal quote** (early generation) | ✅ | `/api/subscriptions/[id]/generate-renewal-quote` |
| Send quote via email with real PDF attached | ✅ | `/api/quotes/[id]/send` + `send-quote-dialog` |
| Email seam — stub mode (now) + real Resend (when key arrives) | ✅ | `lib/email/send.ts` |
| Tasks system (polymorphic, snooze, dashboard widget, bell) | ✅ | `0007_tasks.sql` + queries + UI |
| Settings → Company (RHF + Zod + grace period) | ✅ | `(app)/settings/page.tsx` |
| Public quote-accept page | ✅ | `(public)/quote/[id]/accept` |
| Dashboard with renewal pipeline widget | ✅ | `(app)/dashboard/page.tsx` |
| PWA support (manifest + icons + install page) | ✅ | `manifest.ts`, `icon-*.tsx`, `(app)/mobile` |
| **Responsive design** — phone / tablet / desktop | ✅ | All 11 listing pages, foundation in `useBreakpoint`, `FAB`, `MobileBottomNav`, responsive `DialogContent` |

### 🟡 Partial / Stubbed — works but needs follow-through

| Feature | Status | What's needed |
|---|---|---|
| Renewal cron daily | Code ✅, vercel.json ✅, BUT Vercel deploy pending | Firebase Cloud Scheduler migration once App Hosting deploys |
| Email send (Resend) | Stub mode logs to DB. **Real send needs RESEND_API_KEY** | Pardeep signs up at resend.com, adds key, real emails fire |
| Lead intelligence "Call top lead" | tel: + mailto: wired ✓ | Could add deeper Gemini-suggested scripts (P2) |
| Bulk reminder on Renewals | Wired to FAB but currently shows toast | Replace with real `/api/cron/renewals` trigger (10 min) |

### 🔴 Not built — explicitly absent

| Feature | Where it's referenced | Critical? |
|---|---|---|
| **Razorpay payment integration** | env vars defined, no code yet | **P0 for first paying customer** |
| **GST e-Invoice IRP** (NIC / ClearTax) | env vars defined, no code | **P0 for B2B customers > ₹5cr turnover** |
| Google CSP Reseller API | env vars defined, no code | P1 — manual provisioning works initially |
| WhatsApp Business API (Gupshup) | env vars defined, no code | P1 — Indian customers prefer WhatsApp |
| Customer portal (`(public)/portal`) | Routing exists, page minimal | P1 — customers want self-service |
| Reports / GSTR-1 export | "Coming soon" toast | P1 (accountants need this) |
| In-app Razorpay payment link generation | Referenced in renewal template | P0 with Razorpay |
| Contact import (CSV) | "Coming soon" toast | P2 |
| Lead Gen channels (email/SMS/WhatsApp ingest) | UI placeholder only | P2 |
| Team / invite members | "Invite coming soon" | P1 once team grows |
| Gemini AI features (lead scoring, reply suggestions) | env defined | P2 — AI features can wait |
| Online Orders → buy-workspace-v2 public funnel | UI shows mock orders | P1 (drives signups) |
| Sentry monitoring | env defined, no init | P1 — needed once live |
| Plausible analytics | env defined, no init | P2 |

---

## 2. Skills / Services needed (API keys, third-party setup)

For each, here's the **why**, **how to get it**, and **how long**.

### P0 — Block dogfood / first customer

| Service | Why | Setup time | Cost |
|---|---|---|---|
| **Resend.com** | Real emails (renewal cadence + quote send) | 15 min | Free (3K/mo) |
| **Razorpay** (test mode) | Payment links on quotes | 1-2 days (KYC) | Free during test |
| **Domain** (e.g., resellersos.in) | Branded URLs in emails + PWA | 5 min | ₹600/yr |

### P1 — Strong launch but not blocker

| Service | Why | Setup time | Cost |
|---|---|---|---|
| **NIC IRP** (GST e-Invoice) | Mandatory for B2B above ₹5cr | 3-5 days | Free (govt) |
| **ClearTax** (alternative) | Easier IRP integration | 1 day | ₹6K/yr |
| **Gupshup BSP** | WhatsApp customer comms | 2 days | ~₹1/msg |
| **Sentry** | Error monitoring once live | 30 min | Free (5K events/mo) |
| **Plausible** | Privacy-respecting analytics | 30 min | ₹450/mo |

### P2 — Future / scale moments

| Service | Why | When |
|---|---|---|
| **Google CSP Partner ID** | Real Workspace provisioning | After Google partner status |
| **Microsoft Partner Center** | Real M365 provisioning | After Microsoft partner status |
| **Zoho Partner** | Real Zoho reseller API | After Zoho partner status |
| **Gemini API** | AI lead scoring + reply drafting | Once usage data accumulates |

---

## 3. Critical P0 blockers — fix before any production usage

### 🔴 #1 — Hosting (in progress)
- Vercel account loop fixed via Firebase migration
- **Status**: Pardeep upgrading `cloudhosting-demo` to Blaze plan
- **Next**: App Hosting setup + env vars + first deploy

### 🔴 #2 — `RESEND_API_KEY` invalid
- Current key in `.env.local` returns 401 from Resend
- All cadence emails currently fail (caught by our retry-prevention fix)
- **Fix**: Pardeep signs up at resend.com (free), creates new API key, replaces in env

### 🔴 #3 — `NEXT_PUBLIC_APP_URL` placeholder
- Currently `http://localhost:3000` in env
- Email signatures + PWA + quote-accept links use this
- **Fix**: Update to real production URL after Firebase deploy succeeds

### 🔴 #4 — `CRON_SECRET` not set in production
- Cron handler accepts unauthenticated requests if secret unset (dev-only)
- **Fix**: Generate random 32-char secret, set in Firebase env + Cloud Scheduler auth header

---

## 4. P1 — Highly recommended before first paying customer

### Razorpay payment flow
- **Why**: Without payment links, "record payment" is just bookkeeping, not collection. Indian SMEs want UPI/cards.
- **Build**: ~6-8 hours
  - Webhook endpoint to validate Razorpay signatures
  - Payment-link generation in quote builder
  - Auto-record payment on webhook + run `record_payment` RPC
- **Outcome**: Customer clicks "Pay now" on quote → Razorpay UPI → ResellerOS auto-records → subscription auto-creates

### GST e-Invoice IRP integration (ClearTax-backed)
- **Why**: Indian B2B mandate. Without IRN+QR, invoices aren't legally valid for high-turnover customers.
- **Build**: ~4-6 hours (ClearTax SDK is straightforward)
- **Outcome**: Invoice generation calls IRP → IRN+QR returned → embedded in PDF

### Customer self-service portal
- **Why**: Customers want to view their subscription, pay open quotes, download past invoices, request changes — without emailing the reseller.
- **Build**: ~8-10 hours (mostly reuse of existing views, simpler auth)
- **Outcome**: customer.resellersos.in or /portal route. Customers log in via emailed magic-link, see their own data.

### Sentry error tracking
- **Why**: First time real customers hit edge cases, we need to know FAST.
- **Build**: 30 min — `@sentry/nextjs` package init
- **Outcome**: Error logs in Sentry dashboard, alerts on Slack/email

### Reports — GSTR-1 export
- **Why**: Accountants live in GSTR-1 cycles. Without this, ResellerOS feels incomplete to the finance team.
- **Build**: ~4-6 hours
- **Outcome**: One-click CSV download in GST government format, per-month per-tenant

---

## 5. P2 — Nice to have, defer to v1.5

- WhatsApp Business integration (templates + opt-in)
- Online buy-workspace-v2 public funnel (drives self-signups)
- Google CSP API for real provisioning
- Team invites + role-based access
- Lead Gen multi-channel ingest (forms, email parsing, SMS forwarding)
- Gemini AI features (reply suggestions, lead scoring, churn prediction)
- Zoho Books sync (Push to Zoho button currently stub)
- Plausible analytics
- Hindi i18n (next-intl already set up)

---

## 6. Tech debt — small, manageable

| Item | Where | Effort |
|---|---|---|
| Bulk reminder button is just toast | `renewals/page.tsx` | 10 min |
| "Coming up" calendar widget is stub data | `dashboard/page.tsx` | Defer to calendar integration |
| Auto-sync card on /invoices is stub | `invoices/page.tsx` | Defer to Zoho integration |
| `/api/public/quote/[id]/accept` TODO: notify reseller via email | accept route | 30 min once Resend live |
| `RESEND_FROM_DEFAULT` not honored in `quote-send` route | `quotes/[id]/send` | 5 min |
| No retry queue for failed Resend sends | cron route | Defer (low priority) |
| Stub Sales Leaderboard data | dashboard | Defer |
| Receipt Voucher numbering uses same series as invoices (per CGST 31(3)(d) — correct) | already done | ✓ |

---

## 7. Recommended launch sequence

```
Day 0 (TODAY)
├─ Firebase App Hosting deploy   (Pardeep + me — 30 min)
├─ Set RESEND_API_KEY in prod    (Pardeep — 15 min)
├─ Set NEXT_PUBLIC_APP_URL       (5 min)
├─ Set CRON_SECRET               (5 min)
├─ Verify renewal cron fires     (1 hr wait + verify log)
└─ Add Client A as first tenant (already exists)

Day 1-3 — Dogfood with Client A
├─ Add 5-10 real customers manually
├─ Send actual renewal quotes (via existing flow)
├─ Receive payments (manual record_payment for now — Razorpay later)
├─ Generate invoices
└─ Capture friction → file as tickets

Day 4-7 — Critical missing pieces
├─ Razorpay test integration + payment link generation
├─ Sentry error tracking
└─ GSTR-1 export

Week 2 — Acquire customer #2
├─ Onboard a friendly reseller (free)
├─ ClearTax IRP integration for e-Invoice
├─ Customer portal skeleton
└─ WhatsApp integration

Month 2 — Customers 3-10
├─ Polish + bugfix
├─ Marketing site
└─ Pricing locked in

Month 3+ — Scale
└─ Google CSP, Microsoft Partner, Zoho Partner APIs
```

---

## 8. Skill gaps — what Pardeep needs to learn / hire

| Skill | Why it matters | Path |
|---|---|---|
| **GST + e-Invoice spec** | Designing invoice flows + IRP integration | Read NIC docs + CGST Act sections 31, 34 |
| **Razorpay webhooks** | Settlement reconciliation | 1-day tutorial sufficient |
| **Cloud Scheduler basics** | For Firebase cron migration | 30 min Google Cloud docs |
| **PostgreSQL RLS** | Already deeply used — review for new tables | Supabase RLS guide |
| **Sentry alerts setup** | Production monitoring | 1 hr Sentry quickstart |
| **Indian tax compliance @ scale** | Once at 5+ customers | Talk to a CA — not technical |

---

## 9. Cost estimate to dogfood-ready

| Item | One-time | Monthly |
|---|---|---|
| Domain (.in) | ₹600 | — |
| Firebase Blaze (free tier covers small scale) | — | ₹0-200 |
| Supabase (free tier 500MB sufficient initially) | — | ₹0 |
| Resend (free tier 3K emails/mo) | — | ₹0 |
| Razorpay test mode | — | ₹0 |
| Sentry (free 5K events/mo) | — | ₹0 |
| **Total to dogfood** | **₹600** | **₹0-200** |

When real customers come:
- Razorpay live mode: 2% per transaction
- ClearTax IRP: ₹6K/yr
- Resend Pro (50K emails/mo): ~₹1,500/mo

---

## 10. What CLAUDE.md should reflect

CLAUDE.md is current as of §20 (Responsive Design). No drift since the latest commit. Just bump **§21 Updates** date to 2026-05-24 and add a one-line entry:

> Last updated: 2026-05-24. Added: full renewal automation (Phase 1-4 + lifecycle), Quote send-via-email, PWA install + Mobile preview, complete responsive design (all 11 listing pages), 7 cron + record_payment bug fixes.

No other doc updates needed — code matches docs.

---

## Conclusion

**Code production-grade hai.** Hosting + 3 critical setup items (Resend / Razorpay / domain) ke baad **Pardeep ready hai apne first dogfood ke liye**.

**Mera honest recommend launch order:**

1. **Aaj** — Firebase deploy + Resend signup + first cron fire ✓
2. **Kal-Parso** — Client A ke 3-5 real customers add karo, real workflows test karo
3. **Is hafte** — Razorpay test integration build karte hain
4. **Agle hafte** — First non-Client-A reseller onboard karte hain free

Sab apne control me hai. **No deal-breakers, sirf next steps.**

---

*Generated by Claude (Product Architect) — 2026-05-24*
