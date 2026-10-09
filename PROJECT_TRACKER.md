# ResellerOS — Project Tracker

> **Single source of truth** for what's shipped, what's in flight, and what's next.
> Mark items `[x]` when done. Add new items as `[ ]`.
> Last refreshed: **2026-05-29**

---

## 📌 Project at a glance

| Field | Value |
|---|---|
| **Product** | ResellerOS — multi-tenant SaaS for Indian cloud resellers (Google Workspace, M365, Zoho) |
| **Owner** | Pardeep A (Excel Technologies Pvt Ltd) |
| **Stack** | Next.js 14 + Supabase Postgres + Cloud Run + Razorpay + Resend |
| **Live URL** | https://reselleros.anutech.in |
| **Repo** | https://github.com/Pardeep-byte1/resellersos |
| **Supabase project ID** | `ontpnqjoysjgrlsukecm` |
| **Cloud Run region** | `asia-south1` (Mumbai) |
| **Current revision** | `resellersos-00060-w5d` (Sentry fully wired: lib/sentry chokepoint + supabase server import + global-error & (app)/error boundaries) |
| **Paying customers** | **0** ← the real KPI to move |
| **Modules built** | 50+ features across 17 modules |

---

## 🔥 ACTIVE — current sprint (this week)

### 🎯 Sprint goal: **World-class polish + first paying customer push**

#### Recently completed (this session)
- [x] **Google OAuth fix** — code shipped (`2ea2a6d`) + verified end-to-end:
  - [x] Google Cloud Console → OAuth Client already configured (4 prior Google sign-ins worked)
  - [x] Client ID + Secret already in Supabase
  - [x] Supabase Auth Providers → Google already toggled ON
  - [x] Live test confirmed: 4 users signed in via Google (pardeep×2, webmaster, hitesh)
  - [x] **Hitesh's stranded account recovered** — Excel Tech + sales role manually provisioned
  - [x] New users from now on: callback auto-provisions tenant + users row (live on revision 00047-rg6)
- [x] **Day 1: Privacy + Terms + About pages** — DPDP Act 2023 compliant, shipped 2026-05-29 (commit `6158742`)
- [x] **Day 4 (server side): Sentry FULLY WORKING** — events landing in dashboard confirmed 2026-05-29 (Issue `JAVASCRIPT-NEXTJS-2`, 3 events, ₹0 spent). Root cause: Next.js 14.2 standalone on Cloud Run silently skips `instrumentation.ts register()` hook even with `experimental.instrumentationHook: true`. Workaround: `src/lib/sentry.ts` side-effect helper called via `import "@/lib/sentry"` from any server file that needs guaranteed init. `ALLOW_SENTRY_TEST` env var disabled — smoke route now 403 in prod.

#### Next 10-day priority (from world-class plan)
- [x] Day 1: Privacy policy + Terms pages publish ← done 2026-05-29
- [ ] Day 2: Buy custom domain `resellersos.in`
- [ ] Day 3: Wire custom domain to Cloud Run (HTTPS auto)
- [x] Day 4a: Sentry monitoring — code + env wired, smoke errors triggered ← done 2026-05-29
- [x] Day 4b: BetterStack uptime — Pardeep signup + monitor for live URL configured ← done 2026-05-29
- [ ] Day 5: Marketing landing page (replace current `/`)
- [ ] Day 6: Pricing page (3 tiers — Starter/Growth/Pro)
- [ ] Day 7: Setup wizard polish — onboarding flow
- [ ] Day 8: Demo data seed for fresh signups
- [ ] Day 9: ICP list — 50 target resellers identify
- [ ] Day 10: First cold outreach — 10 resellers

---

## 🛠 Manual ops pending (Pardeep-only)

| Task | Status | Why |
|---|---|---|
| Google Cloud OAuth Client setup | ✅ done | Done before (4 Google sign-ins prove it works) |
| Supabase Auth provider toggle | ✅ done | Google provider already ON |
| Setu AA signup (email `hello@setu.co`) | ⏳ pending | Production AA bank fetch |
| LinkedIn DM to Sahil Kini (Setu founder) | ⏳ pending | Backup faster AA route |
| HDFC RM call — request API Banking | 🅿️ parked | Direct HDFC API for own account |
| Domain purchase `resellersos.in` | ⏳ pending | Brand + custom URL |
| Update GitHub PAT with `workflow` scope | ⏳ pending | Push `.github/workflows/ci.yml` |
| GitHub PAT secret in Cloud Run env | ⏳ pending | CI workflow |
| Privacy policy + Terms content (legal review) | ✅ done | DPDP Act 2023 compliant pages shipped 2026-05-29 |
| Sentry account + DSN | ✅ done | Org `excel-technologies`, project `javascript-nextjs`, DSN live on Cloud Run |
| Sentry visual verification | ✅ done | Issue `JAVASCRIPT-NEXTJS-2` with 3 events confirmed in dashboard 2026-05-29 |
| BetterStack signup + monitor | ✅ done | Free tier · HTTP monitor for live URL · 3min interval · 10s timeout · email alerts · Mumbai region |
| `ALLOW_SENTRY_TEST` env var disabled | ✅ done | Removed from Cloud Run revision `00058-8wh` — smoke route now 403 in prod |

---

## 📦 Module status

Legend: ✅ shipped · 🟡 partial · 🔴 missing · 🅿️ parked

### Core CRM
| Module | Status | Notes |
|---|---|---|
| Leads (inbox + pipeline + smart actions) | ✅ | List/Kanban toggle, Today strip, Smart Views, follow-ups |
| Deal Pipeline (Kanban) | ✅ | Flex-fill, drag-drop, ₹ value per stage |
| Tasks management | ✅ | Schema, dialog, /tasks page, dashboard widget, bell badge |
| Customers | ✅ | List, drawer form, GSTIN auto-fill, address |
| Contacts | ✅ | Google CSV/OAuth import, promote-to-lead |
| Items catalog | ✅ | 2-tier pricing (monthly/annual), MSRP/wholesale, partner sync |
| Campaigns | ✅ | Bulk email, templates, AI-assisted HTML |

### Revenue
| Module | Status | Notes |
|---|---|---|
| Quote builder | ✅ | 5 commitments × 2 tiers, line discounts, prospect mode |
| Quote send via email + PDF | ✅ | Server-rendered PDF, audit log |
| Quote accept page (public) | ✅ | Accept-with/without-payment |
| Online orders (Razorpay) | ✅ | Test mode, BuyNowDialog, simulation mode |
| Payments + Receipt vouchers | ✅ | record_payment RPC, TDS capture |
| Invoices (GST compliant) | ✅ | Partial invoices, advance adjustment, PDF |
| Subscriptions + lifecycle | ✅ | Annual + monthly, top-up, add-seats pro-rata |
| Renewals automation | ✅ | T-30/T-15/T-7/T-0 cadence, cron, auto-suspend |
| Coupons + Site promos | ✅ | Public buy page, auto-applied online sale |

### Accounting
| Module | Status | Notes |
|---|---|---|
| SaaS metrics (MRR/ARR/Churn/LTV) | ✅ | |
| Vendor Bills | ✅ | PO-bill matching, pre-fill wizard |
| Expenses | ✅ | |
| Bank Accounts | ✅ | Multi-bank, IFSC, opening balance |
| Bank Transactions + CSV import | ✅ | HDFC/ICICI/SBI/Axis/Kotak/Yes Bank auto-detect (fixed period suffix bug) |
| Reconcile + match suggestions | ✅ | exact/high/low confidence pills, manual override |
| Account Aggregator scaffold | ✅ | Setu API client, mock mode, consent + sync UI |
| Account Aggregator LIVE | 🟡 | Mock active; needs Setu API keys to flip to live |
| P&L Report | ✅ | |
| Customer Aging | ✅ | |
| Customer Margin (profitability) | ✅ | |
| GST Reports (output/input/summary) | ✅ | |
| TDS Receivable (4-tab lifecycle + Form 26AS) | ✅ | |

### Procurement
| Module | Status | Notes |
|---|---|---|
| Purchase Orders | ✅ | |
| PO ↔ Bill matching | ✅ | |
| PO → Vendor Bill pre-fill | ✅ | |

### Partner channel (distributor tier)
| Module | Status | Notes |
|---|---|---|
| Reseller hierarchy (distributor/reseller) | ✅ | |
| Partner catalog (parent → child sync) | ✅ | |
| /partners aggregated metrics page | ✅ | |
| Cross-tenant invoice → vendor bill mirror | ✅ | |
| Renewal sync (parent inventory alerts) | ✅ | |

### Customer portal — ⛔ REMOVED 2026-09-19, see the Phase 8 note below
These were built and then **deleted on purpose** (`61d3b4bd`). The ticks record that the work
happened, not that the feature is there — verified absent 2026-09-23. DMS owns the customer
experience now.

| Module | Status | Notes |
|---|---|---|
| Magic link auth + portal layout | ⛔ removed | deleted 2026-09-19 |
| Dashboard + orders + invoices | ⛔ removed | deleted 2026-09-19 |
| Support tickets + subscription management | ⛔ removed | deleted 2026-09-19 |

### Engagement
| Module | Status | Notes |
|---|---|---|
| WhatsApp inbox (Gupshup BSP) | ✅ | Send + webhook + Inbox UI + quote PDF attach |
| Email (Resend) | ✅ | |
| Setup wizard + Settings | ✅ | Unified company form, role split |

### Auth + multi-tenancy
| Module | Status | Notes |
|---|---|---|
| Email/password signup | ✅ | Server-side via `/api/auth/signup` |
| Google OAuth signin (existing user) | ✅ | Working — 4 users have signed in via Google |
| Google OAuth signup (new user) | ✅ | Callback auto-provisions tenant + users row (`2ea2a6d` in revision 00047-rg6) |
| Restricted sales role (Darshan) | ✅ | |
| Customer portal magic link | ⛔ removed | deleted 2026-09-19 with the rest of the portal |

### Public marketing + legal pages
| Module | Status | Notes |
|---|---|---|
| Marketing landing (`/`) | 🟡 | Basic — needs hero + value props redesign (Day 5) |
| Privacy Policy (`/privacy`) | ✅ | DPDP Act 2023 compliant, 10 sections |
| Terms of Service (`/terms`) | ✅ | Indian law, Mumbai jurisdiction, 13 sections |
| About page (`/about`) | ✅ | Founder story, mission, company facts |
| Pricing page (`/pricing`) | 🔴 | TBD (Day 6) |

### Mobile + PWA
| Module | Status | Notes |
|---|---|---|
| PWA manifest + install page (/mobile) | ✅ | |
| Responsive foundation (FAB, MobileBottomNav, BottomSheet) | ✅ | |
| All 30+ pages mobile-tested | ✅ | |
| Draggable FAB | ✅ | |
| Mobile contacts picker | ✅ | |

### GSTIN + Sandbox API
| Module | Status | Notes |
|---|---|---|
| GSTIN checksum validation | ✅ | |
| Sandbox.co.in verification with mock fallback | ✅ | Two-step token flow |
| Auto-fill form from GST | ✅ | |
| Customer GSTIN verification | ✅ | |

---

## ⏳ Backlog (not started, future)

### Tier 1 — when first paying customer demands them
- [ ] Setu AA live integration (Phase 2) — schema ready, just needs API keys
- [ ] HDFC API Banking direct integration (Phase 3) — own bank, faster sync
- [ ] Email-to-statement automation (parse HDFC daily emails)
- [ ] Razorpay live mode + production webhook
- [ ] GST e-Invoice IRP integration (mandatory above ₹5cr turnover)

### Tier 2 — polish for world-class
- [x] Sentry error monitoring ← code + env shipped 2026-05-29 (revision `00054-xz5`)
- [ ] BetterStack uptime monitoring ← pending signup
- [ ] Lighthouse audit on all pages → fix anything <90
- [ ] Privacy policy + Terms of Service pages
- [ ] Marketing landing page (replace current `/`)
- [ ] Pricing page (3 tiers, comparison)
- [ ] About page (founder story, brand)
- [ ] Status page (uptime dashboard)
- [ ] Custom domain `resellersos.in`
- [ ] Email sending domain (`hello@resellersos.in`)
- [ ] Onboarding magic — guided tour, demo data seed
- [ ] Composite PK migration (quotes/POs/invoices — fix cross-tenant ID collision risk)

### Tier 3 — future
- [ ] Hindi i18n (next-intl) — when 100+ customers
- [ ] Native iOS/Android apps (PWA covers for now)
- [ ] Google CSP API integration (auto-provision Workspace seats)
- [ ] Microsoft Partner Center API
- [ ] Zoho Partner API
- [ ] Gemini AI lead scoring + reply suggestions
- [ ] Bulk reconcile (10 transactions at once)
- [ ] Multi-account transfer detection (HDFC → ICICI auto-link)
- [ ] Bank charges automatic categorization

---

## 🎯 90-day plan (high-level)

### Month 1: Foundation polish (NO new features)
- Trust + brand: privacy/terms/about pages, custom domain, monitoring
- Onboarding magic: setup wizard polish, demo data, guided tour
- UX polish: Lighthouse audits, loading/empty/error states audit
- Pricing + landing page

### Month 2: Customer hunt
- ICP list of 50 Indian cloud resellers
- Outreach (email + WhatsApp + LinkedIn)
- 10 free trial signups
- 3 paying customers (₹999/mo Starter tier)
- Personal demos + customer success stories

### Month 3: Iterate on feedback
- Top 5 feature requests from paying customers
- Top 10 bug fixes
- AA integration (Setu) — paying customer demand
- Case studies
- **Goal: 10 paying customers, ₹15K MRR**

---

## 🔑 World-class success metrics

| Metric | Today | 90-day target | World-class target |
|---|---|---|---|
| Paying customers | 0 | 10 | 100 |
| MRR | ₹0 | ₹15K | ₹2L |
| Lighthouse score | unknown | >90 | >95 |
| Time to first value | unknown | <5 min | <2 min |
| Uptime SLA | unknown | 99.5% | 99.9% |
| NPS | n/a | >40 | >60 |
| Monthly churn | n/a | <5% | <2% |

---

## 🚫 What NOT to do (avoid these temptations)

- ❌ Adding new features without paying-customer demand
- ❌ Database migration (Firebase, Cloud SQL) — Supabase is the right call
- ❌ Tech stack changes (Next.js + Supabase = solid)
- ❌ More TSP integration (Setu signup is enough work)
- ❌ Hindi i18n until 100+ customers
- ❌ Native mobile app (PWA covers it)
- ❌ Chasing self-serve AA TSP URLs (sales-led signup is the only path)

---

## 🌐 Live links + admin URLs

| Purpose | URL |
|---|---|
| Live app | https://reselleros.anutech.in |
| Login page | https://reselleros.anutech.in/login |
| Banking module | https://reselleros.anutech.in/accounting/banking |
| GitHub repo | https://github.com/Pardeep-byte1/resellersos |
| Supabase project | https://supabase.com/dashboard/project/ontpnqjoysjgrlsukecm |
| Cloud Run console | https://console.cloud.google.com/run/detail/asia-south1/resellersos/metrics?project=resellsubsos-prod |
| Google Cloud Console (OAuth) | https://console.cloud.google.com/apis/credentials |
| Razorpay dashboard | https://dashboard.razorpay.com (test mode) |

---

## 👥 Test users (dev mode)

| Email | Password | Tenant | Role |
|---|---|---|---|
| `pardeep@exceltechnologies.in` | (apne paas — code/docs mein nahi) | Excel Technologies (distributor) | owner |
| `darshan@exceltechnologies.in` | (apne paas — code/docs mein nahi) | Excel Technologies | sales |
| `pardeep.webmaster@gmail.com` | (in DB) | Excel Technologies | sales |
| `pardeep@anutech.in` | (apne paas — code/docs mein nahi) | Anutech Digital (reseller) | owner |

---

## ⚠️ Known issues + pitfalls

| Issue | Workaround |
|---|---|
| Google OAuth not yet enabled in Supabase | Use email/password login until OAuth Client configured |
| Setu AA real-time fetch | Use CSV upload monthly (or mock mode for demos) |
| Cross-tenant ID collision on quotes/POs | Currently mitigated with renamed prefixes (e.g. PO-ET-...) — composite PK migration pending |
| Screenshot tool timeout on first-compile pages | Wait 5-8 sec after navigate, retry once |
| Browser Chrome MCP can't navigate to Cloud Run URL | Localhost works fine; Chrome extension domain permission limitation |

---

## 🏆 Completed phases (historical rollup)

These represent **223+ completed tasks** rolled up into modules. Not exhaustive, see git history for details.

### Phase 1 — Foundation (Weeks 1-3)
- Auth, multi-tenant (tenants/users/RLS)
- Design system + 30+ shadcn components
- Layout shell (Sidebar + TopBar + CommandPalette)
- Basic CRUD for all 12 core entities

### Phase 2 — Money (Weeks 4-6)
- Razorpay test mode + checkout
- GST 18% (CGST/SGST split, IGST inter-state)
- WhatsApp via Gupshup BSP
- Resend email integration

### Phase 3 — Document numbering + atomic writes (Week 5)
- `next_document_number` RPC (GST-compliant per-FY series)
- `record_payment` RPC (lead → customer cascade + receipt voucher)
- `compute_advance_adjustment` for invoices
- `accept_quote` for accept-without-payment

### Phase 4 — Renewal automation (Weeks 6-7)
- Cadence engine (T-30/T-15/T-7/T-0)
- Daily cron handler
- Auto-suspend with grace period
- On-demand quote generation

### Phase 5 — Quote send + PDF (Week 7)
- Server-rendered PDF via @react-pdf/renderer
- Quote send dialog with audit log
- Multi-tenant branding fix

### Phase 6 — Responsive foundation (Week 8)
- `useBreakpoint`, `FAB`, `MobileBottomNav`, `BottomSheet`
- 11 listing pages ported to card-list-on-mobile
- KPI grid squish fix, max-width fix

### Phase 7 — Accounting layer (Weeks 9-10)
- Vendor Bills + Expenses
- P&L Report
- Customer Aging
- GST Reports (3 sub-pages)
- Customer Margin
- SaaS Metrics (MRR/ARR/Churn/LTV)
- TDS Receivable (4-tab lifecycle + Form 26AS reconciliation)

> **Phase numbers here are this roadmap's own.** They are NOT the engine write-command
> phases in `Todos.md` §C, which run 0-9 and are on a different clock — engine Phase 8 is
> `domain.renew` and shipped 2026-09-23. Two different "Phase 8" exist; check which document
> you are in.

### Phase 8 — Customer portal (Week 11) — ⛔ BUILT, THEN DELETED 2026-09-19
**Do not read this as a delivered feature, and do not rebuild it without being asked.**
`(public)/portal`, `api/portal` and `lib/portal` were removed in `61d3b4bd` — 24 files, the
nav entry, 11 route-map entries and a robots disallow. Verified absent 2026-09-23.
DMS owns the customer experience now; staff reach it from the demo panel on `/login`.
See AGENTS.md §0 and Todos.md §F for what that decision cost — chiefly that ResellerOS's OWN
customers (Workspace / M365 / Zoho) have no self-service at all, and everything is
staff-mediated until something replaces it.
The `portal_*` database functions were deliberately left in place, so their presence is not
evidence the feature exists.

### Phase 9 — Subscription lifecycle (Week 11)
- Domain field end-to-end
- Subscription extension/top-up (N years)
- Add Seats pro-rata
- Trial automation (Option B)

### Phase 10 — Procurement (Week 12)
- Purchase Orders
- PO ↔ Vendor Bill matching
- PO → Vendor bill pre-fill wizard

### Phase 11 — Partner channel (Week 13)
- Reseller hierarchy schema (distributor/reseller tiers)
- Partner catalog (parent → child sync)
- Cross-tenant invoice → vendor bill auto-mirror
- /partners aggregated metrics page
- Renewal sync (parent inventory alerts)

### Phase 12 — Engagement (Week 14)
- Campaigns (bulk email, templates, AI-assisted HTML)
- WhatsApp inbox + send + webhook + Send buttons
- Coupons + Site Promos
- Google Contacts (CSV + direct OAuth import)

### Phase 13 — GSTIN verification (Week 15)
- Real checksum validation
- Sandbox.co.in API with mock fallback
- Two-step token flow
- "Fill form from GST" auto-populate
- Customer GSTIN verification + auto-fill

### Phase 14 — Roles + Sales workspace v2 (Week 16)
- Restricted sales role (Darshan @ Excel Tech)
- Split Leads/Deals UX
- Today Strip + Smart Views + Pipeline Pulse
- Dense lead rows + slim KPI strip
- Detail sheet with timeline + actions

### Phase 15 — Lead acquisition polish (Week 17)
- Mobile Leads card list + FAB + swipe gestures
- Draggable FAB with persisted position
- Quick-add lead form (4 fields)
- CSV bulk upload for leads
- Topbar action button page-aware panel

### Phase 16 — Banking module Phase 1 (Week 18, **today**)
- Schema: `bank_accounts`, `bank_transactions`
- UI: list, detail, add-account drawer, import-statement drawer
- CSV parser for HDFC/ICICI/SBI/Axis/Kotak/IndusInd/Yes Bank
- Reconcile drawer with exact/high/low match suggestions
- Manual reconcile escape hatch
- Fixed: HDFC "Withdrawal Amt." header parser bug

### Phase 18 — Monitoring (Week 18, **today**)
- Sentry NextJS SDK 10.55 wired: `instrumentation.ts` + `sentry.{server,client,edge}.config.ts`
- `next.config.mjs` wrapped with `withSentryConfig` (silent + hidden source maps)
- Sentry env vars live on Cloud Run: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG=excel-technologies`, `SENTRY_PROJECT=javascript-nextjs`
- **🐛 Bug found + worked around**: Next.js 14.2.15 + `output: "standalone"` + Cloud Run silently skips `instrumentation.ts register()` even with `experimental.instrumentationHook: true`. Diagnosed via boot-log instrumentation showing register never fires. Workaround: `src/lib/sentry.ts` side-effect helper with idempotent guard (`!Sentry.getClient()`) — imported via `import "@/lib/sentry"` from any server file that needs guaranteed init. When Next.js fixes this upstream, helper can be deleted.
- Comprehensive setup doc at `docs/MONITORING_SETUP.md` (Sentry signup + BetterStack signup + troubleshooting)
- ✅ Visual verification: 3 events landed in Sentry dashboard (Issue `JAVASCRIPT-NEXTJS-2`)
- ✅ `ALLOW_SENTRY_TEST` disabled in prod (smoke route 403)
- ✅ Universal coverage: `import "@/lib/sentry"` added to `src/lib/supabase/server.ts` chokepoint → all authenticated routes/server-components/server-actions covered
- ✅ React error boundaries: `app/global-error.tsx` (root catch-all) + `app/(app)/error.tsx` (sidebar-preserved in-app errors) — both report to Sentry + show friendly UI with digest ref
- ⏳ Pending: BetterStack signup (manual, ~5 min)

### Phase 17 — Banking AA scaffold (Week 18, **today**)
- `bank_aa_connections` table
- Setu API client (mock-first, switches to live with env keys)
- 3 API routes: consent init, callback, fetch
- ConnectAaDialog drawer
- Simulate-approval page (mock consent UI)
- Daily-sync ready (cron handler)
- Verified end-to-end on Chrome: connect → approve → 4 mock txns synced

---

## 📝 How to use this file

1. **Active sprint section** — daily check, mark `[x]` when done
2. **Manual ops** — these need Pardeep's action, not Claude's
3. **Module status** — see what's shipped vs partial vs missing
4. **Backlog** — defer non-critical items here
5. **Add new items** — `[ ] description` under appropriate section
6. **Completed phases** — historical context, don't edit

When adding a new task today:
- If in current sprint → add to "Active" section
- If for next sprint → add to "Next 10-day priority"
- If non-urgent → add to "Backlog → Tier X"

When completing a task:
- Change `[ ]` to `[x]`
- If it's a significant module, add a 1-line entry to "Completed phases"

---

## 🤖 Claude conventions (for future sessions)

- **Always read this file at session start** to know current priorities
- **Never add new features without paying-customer demand** (architect rule)
- **Always run `npm run typecheck && npm run lint` before commit**
- **Always use `gcloud run deploy resellersos --source . --region asia-south1`** for deploys
- **Always commit with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`**
- **Skip `.github/` from staging** until GitHub PAT has `workflow` scope
- **Use Hinglish in operator-facing messages** (Pardeep's preference)
- **Push back as Product Architect** when scope/timing is wrong
