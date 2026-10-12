# ResellerOS — World-Class Gap Analysis

> **Date**: 2026-05-29
> **Status**: 17 modules shipped · 0 paying customers · 230+ tasks closed
> **Author**: Claude (Product Architect) on Pardeep's behalf
> **Purpose**: Honest map of what's missing for ResellerOS to be world-class, prioritised by impact.

---

## TL;DR — where you actually stand

**Build quality**: 8/10. The product is dense, multi-tenant, GST-aware, mobile-ready, and battle-tested against Client A's own ops. Few Indian SaaS startups have this depth at v0.

**Business readiness**: 4/10. You can't actually charge money yet (no live Razorpay, no enforced tiers, no DPA, no GST e-Invoice IRP). The pricing page is a beautiful billboard with no checkout behind it.

**Trust + compliance**: 5/10. DPDP-aware copy is in place, but no public status page, no SOC 2 prep, no audit logs, no data-export tool. Enterprise resellers won't sign without these.

**Growth lever**: 3/10. You have a landing + pricing + about — but no SEO, no blog, no case study, no referral program, no API for integrations. Customers can find you only if they know your name.

**Verdict**: You've built more *product* than 90% of pre-revenue Indian SaaS. You have less *business* than 90% of revenue-bearing Indian SaaS. The next 60 days should be entirely about closing the business-readiness gap — not adding more modules.

---

## Reading guide

Each gap is tagged with:

- **Tier** — Critical · High-impact · Trust+Compliance · Growth+Scale · Polish
- **Effort** — S (≤1 day) · M (1-5 days) · L (1-3 weeks)
- **ROI** — what it unlocks
- **Why we don't have it yet** — honest history note

---

## Tier 1 — Critical (blockers for charging real money)

These prevent you from accepting your first ₹1 of revenue. Fix these before Day 11.

### 1.1 — Live Razorpay + actual paywall enforcement

**What's missing**: `/pricing` page sells 3 tiers but there's no real subscription billing. Razorpay is in test mode only. No webhook handling for "payment received → activate subscription tier". No paywall code that says "Starter tier can't access Renewal automation."

**Effort**: M (3-5 days)

**ROI**: Unlocks revenue. Without this you literally cannot charge.

**Why we don't have it**: Honest dogfooding-first stance — Pardeep ran the product on Client A for free before charging. Now it's time.

**To-do list**:
- Move Razorpay from test to live mode (new keys, KYC complete)
- Webhook handler at `/api/webhooks/razorpay/subscription` (create/cancel/payment_failed)
- `tenants.subscription_tier` column + `tenants.subscription_expires_at`
- Feature-flag middleware: `requireTier("growth")` for Renewals, WhatsApp inbox, AA, etc.
- Settings → Billing page where tenant can upgrade/downgrade/cancel
- Dunning emails when card fails (3 retries over 7 days)

### 1.2 — GST e-Invoice IRP integration

**What's missing**: Tax invoices today are generated locally with HSN 998313 and CGST/SGST split, but they're not pushed to NIC's IRP (Invoice Registration Portal). Above ₹5 cr turnover this is **legally mandatory** in India.

**Effort**: M (3-5 days)

**ROI**: Required by law for B2B customers above ₹5cr. Without this, half your TAM can't buy.

**Why we don't have it**: NIC API requires GSP onboarding + production access — bureaucratic, not technical. ClearTax IRP API is the easier path (~₹5000/month).

**To-do list**:
- Sign up with a GSP (ClearTax recommended)
- Add `irn` (Invoice Reference Number) + `qr_code` columns to `invoices`
- Server-side push to GSP on invoice finalisation
- Embed QR code in PDF (per CBIC notification)
- Cancellation flow (e-Invoice cancel within 24 hrs)

### 1.3 — Audit logs for sensitive actions

**What's missing**: No `audit_log` table. If a sales user deletes a lead at 2am, there's no record. If someone changes a price in the catalog, no trail. This is a hard block for any reseller above 5 employees.

**Effort**: S (1-2 days)

**ROI**: Trust + compliance + debugging. Indian reseller owners with ex-employees want this on day one.

**Why we don't have it**: Got skipped in the "ship more modules" phase.

**To-do list**:
- `audit_log` table: `tenant_id, actor_id, action, entity_type, entity_id, before_jsonb, after_jsonb, ip, created_at`
- Wrap all mutations (`useUpdate*`, `useDelete*` queries) to write to log
- Admin-only `/audit-log` page with filters (actor, entity, date)
- 12-month retention by default (DPDP-aware)

### 1.4 — Data Processing Agreement (DPA) template

**What's missing**: Public privacy + terms exist, but no signable DPA for B2B customers. DPDP Act 2023 requires controllers (your reseller customers) to have a DPA with processors (you).

**Effort**: S (1 day with legal review)

**ROI**: Closes enterprise deals. Without DPA, no Wipro/TCS/etc. reseller arm can buy.

**Why we don't have it**: Legal cost (₹15-50K with a competent SaaS lawyer) hadn't been planned.

**To-do list**:
- Buy a DPDP-compliant DPA template from someone like SignDesk / SpiceJet legal
- Host at `/dpa` (public)
- Settings → Legal → "Generate signed DPA" button (auto-fills tenant name + GSTIN)
- Esign integration (DocuSign or LeegalityHub for Indian businesses)

---

## Tier 2 — High-impact (unlock first 10 customers)

These don't block charging, but every prospect will ask about them in week 1. Fix before Day 20.

### 2.1 — Custom domain `resellersos.in`

**What's missing**: Live URL is `https://resellersos-njvk4nxhdq-el.a.run.app` — unmemorable, looks like an internal staging site.

**Effort**: S (5 min Pardeep + 30 min me)

**ROI**: Brand identity. Custom email (`hello@resellersos.in`). Customer-facing buy pages look professional.

**Why we don't have it**: ₹800 + 5 minutes of Pardeep's time hadn't been spent yet.

### 2.2 — Email deliverability hardening

**What's missing**: Resend is wired but `hello@resellersos.in` doesn't exist. SPF, DKIM, DMARC records missing. Renewal reminder emails will land in spam at 30%+ rate.

**Effort**: S (1 day after domain bought)

**ROI**: Renewal automation literally only works if reminders reach inboxes. Spam = lost revenue.

**To-do list**:
- Set up Resend with `resellersos.in` as sending domain
- Add SPF record (`v=spf1 include:resend.com -all`)
- Add DKIM (Resend provides 2 CNAMEs)
- Add DMARC (`v=DMARC1; p=quarantine; rua=mailto:dmarc@resellersos.in`)
- Test via mail-tester.com — aim for 10/10
- Warm up the sending domain (start at 50 emails/day, ramp up)

### 2.3 — Onboarding tour + in-app help

**What's missing**: Setup wizard exists but no progressive disclosure. New tenants land on dashboard with no idea what to do first. No tooltips, no "what is this?" hover hints, no walkthrough.

**Effort**: M (3-4 days)

**ROI**: Reduces time-to-first-value. World-class SaaS gets users to "first invoice sent" in <10 minutes.

**To-do list**:
- Library: `react-joyride` or build minimal Tour component
- 5-step initial tour: company setup → add first customer → create first quote → send quote → mark paid
- Inline help icons (`?` next to GSTIN, HSN, commitment types) that open a side-drawer with explanation
- "Did you know?" toasts on day 2, day 7, day 14 (one tip per visit)
- Empty-state CTAs: every empty list page suggests next action

### 2.4 — Demo data seed for new tenants

**What's missing**: New tenant sign-up = empty database = scary blank slate. Need realistic demo data so the operator can explore the product before importing real data.

**Effort**: S (1-2 days)

**ROI**: Time-to-value. Operator can play with the product without risk.

**To-do list**:
- `/api/tenants/seed-demo` route: creates 5 sample customers, 10 leads (mixed stages), 3 quotes (draft/sent/accepted), 2 subscriptions
- "Reset demo data" button in Settings → uses seed RPC
- New signup flow: "Start with demo data?" toggle on signup form
- Demo data clearly marked with `is_demo` flag so operator can delete in bulk later

### 2.5 — Status page (public)

**What's missing**: BetterStack monitors privately. No `status.resellersos.in` for customers to check during outages.

**Effort**: S (configured in BetterStack — they provide free hosted status pages)

**ROI**: Trust. Customers panic when site is slow; status page deflects that.

**To-do list**:
- BetterStack → Status pages → Create
- Add the ResellerOS monitor
- Customise: amber colors, "ResellerOS Status" branding
- Add subdomain CNAME: `status.resellersos.in` → BetterStack's hostname
- Link from PublicFooter + about page

### 2.6 — Knowledge base / docs site

**What's missing**: No `/docs`, no `/help`, no in-product help center. When a customer asks "how do I…?", you answer 1-on-1 every time.

**Effort**: M (2-3 weeks initial seed, then ongoing)

**ROI**: Customer success scales. Reduces your support load by 70%+.

**To-do list**:
- Choose tooling: Mintlify (free for OSS), GitBook, or Notion → Super.so
- Initial 20 articles:
  - Quickstart: 10-min setup
  - Importing customers from Tally
  - Creating your first GST invoice
  - Setting up renewal cadence
  - Bank reconciliation walkthrough
  - WhatsApp Business setup
  - Customer portal magic link explained
  - Multi-user roles
  - 10 more on common questions
- Search via Algolia DocSearch (free for OSS docs)
- Embed help-search in app via cmdk

---

## Tier 3 — Trust + Compliance (needed for serious customers)

These build credibility for the second 90 days (10 → 30 customers). Tackle around Day 30–60.

### 3.1 — Data export tool (DPDP requirement)

**What's missing**: DPDP Act 2023 requires data portability. Tenants should be able to export their full data as JSON/CSV with one click.

**Effort**: S (1-2 days)

**ROI**: Legal compliance + customer trust (they know they can leave).

**To-do list**:
- Settings → Data → "Export all data" button
- Server-side job that bundles all tables for the tenant into a single ZIP (JSON files)
- Email link to download (signed S3 URL, expires in 24 hrs)
- Audit-logged

### 3.2 — Account deletion + data retention controls

**What's missing**: No "delete my account" flow. DPDP requires this. No retention policy settings (some industries need 7-year retention, some 30 days).

**Effort**: S (1 day)

**To-do list**:
- Settings → Danger zone → "Delete tenant"
- 14-day grace (read-only) before permanent deletion
- Per-tenant retention settings (default 7 years for accounting compliance)
- Auto-purge of soft-deleted leads/quotes after retention window

### 3.3 — SOC 2 Type I prep

**What's missing**: No security baseline documented. No vulnerability scans. No employee access policies.

**Effort**: L (3-6 months with Vanta/Drata)

**ROI**: Unlocks enterprise sales. Required by Wipro/TCS/Infosys reseller arms.

**Why we don't have it**: Premature for 0 customers. Start prep at 20 customers.

**To-do list** (when ready):
- Sign up with Vanta or Drata (~$15K/year)
- Document policies (incident response, access control, etc.)
- Penetration test (~$5K with a reputable firm)
- 3-6 months observation period
- Audit by AICPA-registered auditor

### 3.4 — Two-factor auth + SSO

**What's missing**: Email + Google OAuth only. No TOTP 2FA. No SAML SSO for enterprise.

**Effort**: M (2-3 days for TOTP, L for SAML)

**ROI**: Enterprise checkbox.

**To-do list**:
- TOTP via Supabase Auth (already supported, just need to enable + UI)
- SAML 2.0 for Pro tier (Supabase Auth supports it, needs custom UI in Settings)

### 3.5 — Public roadmap

**What's missing**: Customers can't see what's coming. Trust + collaboration suffers.

**Effort**: S (1 day with Productboard or Canny.io free tier)

**ROI**: Engaged customers contribute ideas + feel heard.

---

## Tier 4 — Growth + Scale (10 → 100 customers)

These compound over time. Start during Day 60-90.

### 4.1 — Public API + webhooks

**What's missing**: No `/api/v1/*` for tenants to integrate with their existing tools.

**Effort**: M-L (2-3 weeks)

**ROI**: Lock-in (the more they integrate, the harder to leave) + unblocks larger customers who run Salesforce/HubSpot.

**To-do list**:
- API auth: per-tenant API keys with scopes
- REST endpoints for core entities (leads, customers, quotes, invoices)
- Outbound webhooks (subscribe to `quote.sent`, `payment.received`, etc.)
- Rate limiting (100 req/min on Starter, 1000 on Growth, unlimited on Pro)
- API docs at `/docs/api`

### 4.2 — Referral / affiliate program

**What's missing**: Best B2B SaaS growth lever — existing customers refer new ones. No system to track + reward.

**Effort**: M (3-5 days)

**ROI**: 2-3x growth multiplier when done right.

**To-do list**:
- Settings → Referrals → Get your link (`resellersos.in/?ref=client-a`)
- Track referral source on signup
- Auto-credit referrer ₹999 (or 1 month free) when referee pays first invoice
- Public leaderboard

### 4.3 — AI features (the differentiator)

**What's missing**: CLAUDE.md mentioned Gemini for lead scoring + reply suggestions — not built yet.

**Effort**: M-L (1-3 weeks per feature)

**ROI**: Differentiation. Competitors have generic CRM; you have "AI suggests 30% margin for this deal based on similar quotes."

**Specific AI bets**:
- **Lead scoring**: Auto-score leads 0-100 based on deal value, seats, plan, contact data
- **Quote suggestion**: When operator opens "Create quote" with a lead, AI proposes line items based on similar accepted quotes
- **Reply suggestions**: WhatsApp inbox shows 3 suggested replies based on conversation context
- **Anomaly detection**: "This invoice's margin is 12%, your usual is 18% — review?"
- **Renewal probability**: "TechVista renewal at risk (60% probability of churn) — last touch was 22 days ago"

Use Gemini Flash for cost (~₹0.05 per call). Cache responses.

### 4.4 — Native iOS + Android apps

**What's missing**: PWA covers basic mobile, but missing push notifications, biometric auth, app store discovery.

**Effort**: L (2-3 months with Capacitor wrapping the existing PWA)

**ROI**: Sales reps' #1 ask. They want to be pinged on phone when a lead comes in.

**Why we don't have it**: Premature. Build at 25 customers when sales reps complain about PWA.

### 4.5 — Slack + Microsoft Teams integration

**What's missing**: No `#sales` channel notifications when a deal closes.

**Effort**: M (2-3 days each)

**ROI**: Team productivity. Teams like to celebrate wins publicly.

### 4.6 — Multi-currency

**What's missing**: INR only. If your reseller has a US customer paying USD for GW seats, can't invoice.

**Effort**: M (1 week with proper exchange rate handling)

**ROI**: Unlocks the 10-15% of resellers with international clients.

### 4.7 — Marketplace integrations (Zapier, Make, n8n)

**What's missing**: Customers can't connect ResellerOS to 5000+ other tools.

**Effort**: M (build Zapier app: 1 week)

**ROI**: Lower-tier customers integrate via Zapier rather than asking for custom dev.

---

## Tier 5 — World-class polish (the 10% that separates from "good")

These are what makes Stripe / Linear / Vercel feel different from a competent SaaS. Tackle over Day 90+.

### 5.1 — Lighthouse 95+ on every page

**What's missing**: CLAUDE.md sets >90 budget but no automated enforcement. Real-world bundle is probably 300+ KB.

**Effort**: M (1 week iteration)

**To-do**:
- GitHub Action: Lighthouse CI on every PR
- Code split aggressively (most pages don't need TanStack Query Devtools)
- Replace heavy libs (@react-pdf/renderer is 1MB+ — generate PDFs server-side instead)
- Image optimization (we already use Next/Image; add `loading="lazy"` everywhere)
- Aim: LCP <1.5s, CLS <0.05, TTI <2.5s

### 5.2 — Comprehensive test coverage

**What's missing**: 4 E2E specs + some Vitest unit tests. World-class apps have 80%+ test coverage and tests gate merging.

**Effort**: L (continuous)

**To-do**:
- Vitest unit tests for every util function (rupee, formatDate, GSTIN validation, etc.)
- E2E specs for every major flow (create lead → quote → invoice → payment)
- Visual regression via Playwright snapshots
- Coverage gate in CI: PR can't merge if coverage drops below 70%

### 5.3 — Performance budgets per route

**What's missing**: No size limits per route. As features pile up, every page gets heavier.

**Effort**: S (1 day setup)

**To-do**:
- `next.config.mjs` performance budgets
- bundle-analyzer in CI
- Slack alert if any route exceeds 200KB gzipped JS

### 5.4 — Storybook for design system

**What's missing**: 30+ shadcn components but no canonical reference. New devs (or future Claude sessions) have to grep through code.

**Effort**: M (1 week initial seed)

**ROI**: Faster feature dev once seeded. Quality control on UI consistency.

### 5.5 — Customer success stories + case studies

**What's missing**: Client A is the first customer but no published story. World-class SaaS has 10+ case studies on landing.

**Effort**: S (1 day per story once you have a customer)

**To-do** (after customer #1):
- Interview customer
- Write 800-word case study (problem → ResellerOS solution → metrics)
- Publish at `/customers/[slug]`
- Linked from landing's social proof section

### 5.6 — A/B testing infrastructure

**What's missing**: No way to test "amber CTA vs indigo CTA" or "free during beta vs 14-day trial" hero copy.

**Effort**: S (1 day with PostHog or GrowthBook)

**ROI**: Optimisation flywheel.

### 5.7 — Brand assets system

**What's missing**: No press kit, no brand book, no media folder, no Open Graph images on each page.

**Effort**: S (1 day)

**To-do**:
- `/brand` public page with logo (svg, png, monochrome variants)
- Per-page OG images (generated dynamically with @vercel/og)
- Twitter card meta tags
- Favicon SVG (current is fine, just ensure all variations)

### 5.8 — Internationalisation (Hindi UI)

**What's missing**: next-intl is set up per CLAUDE.md but no Hindi translation yet.

**Effort**: L (3-4 weeks)

**ROI**: Unlocks tier-2/3 Indian city resellers who prefer Hindi UI.

**Why we don't have it**: Tracker explicitly says "Hindi i18n when 100+ customers" — wait.

---

## Operational gaps

### O.1 — Backup + DR strategy

**What's missing**: Supabase does daily backups (point-in-time). But never tested. Disaster recovery RTO unknown.

**Effort**: S (1 day to document + test)

**To-do**:
- Document RPO (1 hour) + RTO (4 hours) targets
- Test restore: spin up branch from yesterday's backup, verify data integrity
- Quarterly DR drill
- Cross-region backup (Supabase only stores in same region — pay for cross-region or replicate to S3)

### O.2 — Cost monitoring + budgets

**What's missing**: No budget alerts on Cloud Run, Supabase, Razorpay, Sentry. One runaway query could 10x your bill.

**Effort**: S (1 day)

**To-do**:
- Cloud Billing budget alerts (₹2000 month, ₹5000 quarter)
- Supabase usage dashboard check weekly
- Sentry events/quota alert
- Razorpay rate-limit alerts

### O.3 — On-call rotation (you're solo, but plan for growth)

**What's missing**: You're the only escalation. Once you hire, no clear on-call.

**Effort**: S (1 day with PagerDuty free tier, when you have 2 engineers)

### O.4 — Database performance monitoring

**What's missing**: No slow query log monitoring. No index hit-rate dashboard.

**Effort**: M (2 days)

**To-do**:
- Supabase observability dashboard reviewed weekly
- pg_stat_statements analysis monthly
- Index suggestions for queries running >100ms
- N+1 query detection (TanStack Query devtools helps)

### O.5 — Security audit

**What's missing**: No penetration test. No security headers audit. No CSP policy.

**Effort**: M (1 week prep + ~$5K with firm)

**Why we don't have it**: Premature for 0 customers. Do before first enterprise customer.

---

## Recommended 90-day roadmap

### Days 1-15 (June 2026) — Charge first ₹1

Goal: ResellerOS can accept money.

1. Day 7-8: Custom domain bought + wired (Tier 2.1) — Pardeep action
2. Day 9: Email deliverability setup (Tier 2.2)
3. Day 10-12: Razorpay live mode + paywall (Tier 1.1)
4. Day 13: Audit logs (Tier 1.3)
5. Day 14: Data export tool (Tier 3.1)
6. Day 15: Status page (Tier 2.5)

### Days 16-45 (July 2026) — Onboard 5 customers

Goal: 5 paying tenants from your network.

1. Onboarding tour (Tier 2.3)
2. Demo data seed (Tier 2.4)
3. Knowledge base (Tier 2.6)
4. e-Invoice IRP (Tier 1.2)
5. DPA template (Tier 1.4)
6. First case study (Tier 5.5)

### Days 46-90 (Aug 2026) — Scale to 20 customers

Goal: Word-of-mouth growth + product depth.

1. Public API (Tier 4.1)
2. Referral program (Tier 4.2)
3. AI: Lead scoring + Quote suggestions (Tier 4.3)
4. Storybook (Tier 5.4)
5. Lighthouse 95+ (Tier 5.1)
6. Account deletion + retention (Tier 3.2)

### Days 91-180 (Sep-Nov 2026) — Become enterprise-ready

Goal: First Wipro/TCS-style reseller.

1. SOC 2 Type I prep (Tier 3.3)
2. SAML SSO (Tier 3.4)
3. Native iOS/Android (Tier 4.4) — if reps demand
4. Security audit (O.5)

---

## What's NOT on this list (and why)

These ideas keep coming up but I'm intentionally leaving them out:

- **Microservices** — overkill at this scale. Monolith is right.
- **Multi-region deployment** — Mumbai-only is fine until you have international customers
- **GraphQL** — REST is simpler, less moving parts
- **Kubernetes** — Cloud Run is right. K8s is a 5-engineer problem
- **Real-time collaboration (multi-cursor)** — not a CRM use case
- **Mobile app written natively in Swift/Kotlin** — Capacitor wrapper is enough
- **Custom email server** — Resend is right
- **Building a marketplace for third-party apps** — premature for 20-customer tier

---

## The brutal honest summary

You have built a **product**. You don't yet have a **business**.

The product is impressive — 17 modules, real Indian compliance, real dogfooding pedigree. Most Indian SaaS founders haven't shipped half this much in 5 years.

But:
- Nobody can buy it (Razorpay test mode, no paywall)
- Nobody knows it exists (no domain, no SEO, no case studies)
- Nobody can trust it for high-stakes use (no audit logs, no DPA, no status page)
- Nobody's using it but you (still 0 paying customers)

Your next 60 days should be **business-readiness**, not product-readiness. Charge money, get 10 customers, then iterate based on what they actually pay for. Building more modules without paying customers is procrastination dressed up as productivity.

**The 5 things to do in the next 30 days:**

1. **Buy `resellersos.in`** (5 min, ₹1000)
2. **Wire Razorpay live mode + enforce tiers** (3 days)
3. **Get e-Invoice IRP working** (3 days, via ClearTax GSP)
4. **Add audit logs + data export** (2 days)
5. **Write your first case study** (1 day — interview yourself about Client A's results)

Everything else can wait.

---

*This document was generated by Claude (Product Architect role) based on PROJECT_TRACKER.md, CLAUDE.md, codebase audit, and 230+ session-history tasks. It is opinionated, not authoritative. Treat it as a peer review, not a directive.*
