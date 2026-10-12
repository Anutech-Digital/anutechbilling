# ResellerOS — Unified Product Requirements Document (V3)

> **Version:** 3.0 (Unified)
> **Date:** 2026-05-19
> **Author:** Pardeep / Client A
> **Status:** Decision-pending
> **Replaces:** `LEADOS-FIREBASE-REBUILD-GUIDE.md` (V1), `LEADOS-RESELLER-CRM-V2-PRD.md` (V2)

---

## 0. Executive Summary (Read This First)

Aap teen alag projects me kaam kar rahe ho — `gw-pro` (production), `ResellerOS-Next` (10% built), `LeadOS-guide` (sirf doc). Yeh **V3 PRD** un sab ko **ek single product** me consolidate karta hai jisko **ResellerOS** kahenge.

### The Strategic Decision (Recommended)

```
┌──────────────────────────────────────────────────────────────┐
│  ResellerOS V3 = gw-pro codebase + missing features added    │
│                                                              │
│  • Production code base: KEEP gw-pro (1.3 MB working code)   │
│  • Brand name: ResellerOS (broader, future-proof)            │
│  • Missing features to add: Leads, Activities, Automation,   │
│    Customer Portal, WhatsApp                                 │
│  • Pause: ResellerOS-Next (Next.js prototype) — harvest      │
│    WhatsApp Bot only                                         │
│  • Timeline: 8 weeks to full automation                      │
└──────────────────────────────────────────────────────────────┘
```

### What This Document Delivers

1. **Strategic clarity** — kaunsa system continue, kaunsa archive
2. **Unified feature set** — sab modules ek jagah listed
3. **Wireframes** — customer ko dikhane layak (10 screens)
4. **Phased roadmap** — 8 weeks me complete
5. **Open decisions** — aapse jo confirm chahiye

---

## 1. Product Vision

> **"India ka pehla complete Google Workspace + Microsoft + Zoho reseller operating system jo lead generation se le kar renewal collection tak — sab kuch ek hi platform me automate kare."**

### One-Liner for Customer Pitch
"ResellerOS — Sell, Provision, Bill & Renew Google Workspace customers — without spreadsheets, without confusion, in 60% less time."

### Tagline Options
- **"Your Reseller Business, on Autopilot"**
- **"From Lead to Loyalty — One Platform"**
- **"The Operating System for Cloud Resellers"**

---

## 2. The Problem We Solve

### Current State (Pain Points)

| Persona | Pain Point | Frequency |
|---|---|---|
| **Sales** | Leads excel me, followups Gmail me, quotes alag tool me — context loss | Daily |
| **Provisioning** | DNS/MX/SPF setup manual, customer ko bar-bar call | Per deal |
| **Finance** | Invoice manual, Razorpay alag, Zoho alag reconcile karna padta | Weekly |
| **Support** | Customer history Gmail thread me, kaun kab kya bola pata nahi | Per ticket |
| **Owner (You)** | "Kitna business is month?" — 3 spreadsheets kholo, calculate karo | Monthly |

### Cost of Status Quo

- **Time wasted:** ~30 hours/week across 5-person team on data shuffling
- **Errors:** Wrong GST applied, missed renewals, double invoicing
- **Lost revenue:** 15-20% renewals slip because nobody followed up
- **Team friction:** Sales-Finance handoff broken, blame games

---

## 3. Target Users

### Primary Users (Internal Team)

| Role | Day-to-Day | Power Required |
|---|---|---|
| **Owner / Founder** | Strategy, pricing, team performance | Full access |
| **Sales Executive** | Lead gen, demos, quotes, follow-ups | Own leads + customers |
| **Provisioning Engineer** | DNS setup, account creation, training | Customers + activities |
| **Accountant** | Invoicing, payment reconciliation, GST | All financial data |
| **Support Agent** | Tickets, renewals, customer queries | Customer 360° |

### Secondary Users (External — Customers)

| Persona | Use Case |
|---|---|
| **Customer Admin (IT Head/CTO)** | Login portal, view subscriptions, raise tickets, download invoices |
| **Customer Finance** | Download GST invoices, payment receipts |
| **Prospect** | Visit landing page, request demo, accept trial |

---

## 4. Product Modules — Complete Feature Map

### Module Status Legend
- ✅ **Already built in gw-pro** (reuse)
- 🟡 **Partial in gw-pro** (enhance)
- ➕ **New — to build** (Phase 1-4)
- 🎁 **Harvest from ResellerOS-Next** (port)

| # | Module | Status | Phase |
|---|---|---|---|
| 1 | Authentication + RBAC (5 roles) | ✅ Done | — |
| 2 | Multi-tenant architecture | ✅ Done | — |
| 3 | **Lead Capture + Kanban Pipeline** | ➕ New | Phase 1 |
| 4 | Customers (CRM) | ✅ Done | — |
| 5 | **Unified Activity Timeline** | 🟡 Partial | Phase 1 |
| 6 | Items Catalog (SKU + Wholesale) | ✅ Done | — |
| 7 | Quotations (GST, Prorata, PDF) | ✅ Done | — |
| 8 | Invoices + Payment Tracking | ✅ Done | — |
| 9 | Subscriptions (Workspace API sync) | ✅ Done | — |
| 10 | Renewals Dashboard (T-90/60/30) | ✅ Done | — |
| 11 | Followups + Tasks | 🟡 Partial | Phase 1 |
| 12 | Support Tickets + KB | ✅ Done | — |
| 13 | Reports + Analytics | 🟡 Partial | Phase 2 |
| 14 | **Workflow Automation Engine** | ➕ New | Phase 2 |
| 15 | **WhatsApp Integration** | 🎁 Harvest | Phase 3 |
| 16 | Email (Gmail) Integration | ✅ Done | — |
| 17 | **Bulk Messaging Campaigns** | ➕ New | Phase 3 |
| 18 | **Customer Self-Service Portal** | ➕ New | Phase 4 |
| 19 | Zoho Books Sync | ✅ Done | — |
| 20 | Razorpay Payments | ✅ Done | — |
| 21 | Storefront (Marketing Pages) | ✅ Done | — |
| 22 | Chrome Extension (Zoho Bulk) | ✅ Done | — |
| 23 | AI Background Analyst | ✅ Done | — |
| 24 | MCP / Claude.ai Integration | ✅ Done | — |
| 25 | **Onboarding Checklist Auto** | ➕ New | Phase 1 |
| 26 | **Lead Scoring (AI)** | ➕ New | Phase 4 |

**Summary:** 17 modules already built ✅ | 6 to add ➕ | 1 to harvest 🎁

---

## 5. Information Architecture

### Top-Level Navigation

```
┌─────────────────────────────────────────────────────────────┐
│  ResellerOS                                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  📊 Dashboard           ← Role-customized landing           │
│  🎯 Leads              ← NEW (Kanban + List)               │
│  👥 Customers          ← 360° view per customer            │
│  📋 Quotations         ← Builder + PDF                     │
│  📄 Invoices           ← Generate, track, reconcile        │
│  🔄 Subscriptions      ← Active + reconciliation           │
│  ⏰ Renewals           ← T-90/60/30 buckets                │
│  💰 Payments           ← Razorpay + Bank + Cheque          │
│  🛒 Orders             ← Storefront purchases              │
│  ✅ Tasks/Followups    ← My day, my week                   │
│  🎫 Support            ← Tickets + KB                      │
│  📦 Items Catalog      ← SKUs, pricing, vendors            │
│  📈 Reports            ← MRR, ARR, churn, leaderboard      │
│  ⚙️  Automation        ← NEW (Rules + workflows)           │
│  💬 Campaigns          ← NEW (Email + WhatsApp bulk)       │
│  🔧 Settings           ← Team, integrations, branding      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Role-Based Navigation Visibility

| Module | Owner | Admin | Sales | Accountant | Support |
|---|---|---|---|---|---|
| Dashboard | ✅ | ✅ | ✅ | ✅ | ✅ |
| Leads | ✅ | ✅ | ✅ (own) | ❌ | ❌ |
| Customers | ✅ | ✅ | ✅ (own) | ✅ | ✅ |
| Quotations | ✅ | ✅ | ✅ (own) | ✅ | ❌ |
| Invoices | ✅ | ✅ | View own | ✅ | ❌ |
| Subscriptions | ✅ | ✅ | View | ✅ | ✅ |
| Renewals | ✅ | ✅ | ✅ (own) | ✅ | ✅ |
| Payments | ✅ | ✅ | ❌ | ✅ | ❌ |
| Support | ✅ | ✅ | ❌ | ❌ | ✅ |
| Items | ✅ | ✅ | View | View | View |
| Reports | ✅ | ✅ | Own KPIs | Financial | ❌ |
| Automation | ✅ | ✅ | ❌ | ❌ | ❌ |
| Settings | ✅ | Limited | ❌ | ❌ | ❌ |

---

## 6. WIREFRAMES — Customer Demo Ready

> Yeh wireframes aap customer ko dikha sako — actual UI ka rough representation.

### 6.1 Public Marketing / Landing Page

```
┌────────────────────────────────────────────────────────────────┐
│  [Logo] ResellerOS                            [Login]  [Demo]  │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│        Your Reseller Business, on Autopilot.                   │
│        ─────────────────────────────────────                   │
│        Sell, Provision, Bill & Renew Google Workspace,         │
│        Microsoft 365, and Zoho — all in one platform.          │
│                                                                │
│            [Start Free Trial]    [Watch 2-min Demo]            │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   Choose Your Vendor to Get Started:                           │
│                                                                │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐              │
│   │  Google    │  │ Microsoft  │  │   Zoho     │              │
│   │ Workspace  │  │    365     │  │ Workplace  │              │
│   │            │  │            │  │            │              │
│   │ from ₹136  │  │ from ₹200  │  │ from ₹120  │              │
│   │ /user/mo   │  │ /user/mo   │  │ /user/mo   │              │
│   │            │  │            │  │            │              │
│   │  [Explore] │  │  [Explore] │  │  [Explore] │              │
│   └────────────┘  └────────────┘  └────────────┘              │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   Why Client A?                                      │
│                                                                │
│   ✓ Google Authorized Reseller (10+ years)                     │
│   ✓ 500+ businesses migrated                                   │
│   ✓ 24x7 India-based support                                   │
│   ✓ Free DNS, MX, SPF, DKIM setup                              │
│   ✓ Easy GST invoicing                                         │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  About | Pricing | Support | Privacy | Terms | Contact         │
└────────────────────────────────────────────────────────────────┘
```

### 6.2 Internal Dashboard (Owner View)

```
┌────────────────────────────────────────────────────────────────┐
│ [≡] ResellerOS              [Search...]      🔔 3   PA  [▼]    │
├──────┬─────────────────────────────────────────────────────────┤
│      │                                                         │
│ 📊   │  Welcome back, Pardeep! 👋                              │
│ 🎯   │  ─────────────────────────────                          │
│ 👥   │                                                         │
│ 📋   │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│ 📄   │  │ MRR     │ │ Pipeline│ │ Renewals│ │ Overdue │       │
│ 🔄   │  │ ₹4.2L   │ │ ₹18L    │ │ Due: 12 │ │ ₹3.5L   │       │
│ ⏰   │  │ ▲ +12% │ │ 23 deals│ │ T-30: 5 │ │ 7 invs  │       │
│ 💰   │  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│ 🛒   │                                                         │
│ ✅   │  Today's Focus                                          │
│ 🎫   │  ──────────────                                         │
│ 📦   │  ⚠️  3 renewals due this week — Acme, Beta, Cosmo       │
│ 📈   │  ⚠️  5 overdue invoices — total ₹3.5L                   │
│ ⚙️   │  ✓ 8 tasks pending — 2 yours                            │
│ 💬   │                                                         │
│ 🔧   │  Recent Activity                                        │
│      │  ─────────────────                                      │
│      │  10:32 AM — Rahul closed "Acme Corp" deal — ₹2.4L      │
│      │  09:15 AM — New lead: TechBrand Pvt Ltd (Referral)     │
│      │  Yesterday — 3 invoices auto-generated for renewals    │
│      │                                                         │
│      │  Sales Leaderboard (This Month)                         │
│      │  ─────────────────────────────                          │
│      │  🥇 Rahul     ₹8.2L  (12 deals)                         │
│      │  🥈 Priya     ₹5.6L  (8 deals)                          │
│      │  🥉 Amit      ₹3.1L  (6 deals)                          │
│      │                                                         │
└──────┴─────────────────────────────────────────────────────────┘
```

### 6.3 Lead Kanban Pipeline (NEW Module)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Leads                              [+ Add Lead] [Import] [Filter: All ▼]   │
├────────────────────────────────────────────────────────────────────────────┤
│  🔍 Search...                                            View: Kanban|List │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  New         Contacted   Demo Done  Trial      Quote Sent  Won            │
│  (8)         (5)         (3)        (4)        (2)         (12)           │
│  ─────       ─────       ─────      ─────      ─────       ─────          │
│  ┌─────┐    ┌─────┐    ┌─────┐    ┌─────┐    ┌─────┐    ┌─────┐         │
│  │Acme │    │Beta │    │Cosmo│    │Delta│    │Echo │    │Foxtr│         │
│  │₹2L  │    │₹5L  │    │₹8L  │    │₹3L  │    │₹12L │    │₹4L  │         │
│  │RB   │    │PR   │    │AM   │    │RB   │    │PR   │    │AM   │         │
│  │📅 2d│    │📅 1d│    │📅 5h│    │📅 3d│    │📅 4d│    │✅ ₹3L│         │
│  └─────┘    └─────┘    └─────┘    └─────┘    └─────┘    └─────┘         │
│  ┌─────┐    ┌─────┐    ┌─────┐    ┌─────┐                 ┌─────┐       │
│  │Hotel│    │Gamma│    │Hi-T │    │Iota │                 │Golf │       │
│  │₹4L  │    │₹1L  │    │₹6L  │    │₹2L  │                 │₹5L  │       │
│  │RB   │    │AM   │    │PR   │    │RB   │                 │PR   │       │
│  └─────┘    └─────┘    └─────┘    └─────┘                 └─────┘       │
│  ┌─────┐                                                                  │
│  │Kilo │    Drag any card across columns to update stage                  │
│  │₹3L  │                                                                  │
│  └─────┘                                                                  │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

Legend: RB = Rahul, PR = Priya, AM = Amit (sales rep initials)
        📅 = Last activity   ₹ = Deal value
```

### 6.4 Customer 360° View (with Activity Timeline)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ← Back to Customers          ACME CORP                  [Edit] [⋯ More]    │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌─────────────────────────────────┐  ┌──────────────────────────────┐    │
│  │ Acme Corp                       │  │ Health Score: 85/100 🟢       │    │
│  │ acmecorp.com                    │  │ ───────────────────────       │    │
│  │ GSTIN: 27AABCS1234D1Z5          │  │ Active Subs:  Workspace Std   │    │
│  │ State: Maharashtra (27)         │  │ Seats:        25              │    │
│  │                                 │  │ MRR:          ₹18,400         │    │
│  │ Primary: Rajesh K (CTO)         │  │ ARR:          ₹2,20,800       │    │
│  │ rajesh@acmecorp.com             │  │ Renewal:      15 Sep 2026     │    │
│  │ +91 98765 43210                 │  │ Owner:        Rahul B         │    │
│  └─────────────────────────────────┘  └──────────────────────────────┘    │
│                                                                            │
│  [Overview] [Subscriptions] [Quotes] [Invoices] [Activities] [Files]      │
│  ════════════════════════════════════                                     │
│                                                                            │
│  Activity Timeline                                       [+ Add Activity]  │
│  ──────────────────                                                       │
│                                                                            │
│  📅 TODAY                                                                 │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ 11:30 AM  📞  Call with Rajesh — Discussed Plus upgrade           │    │
│  │           Outcome: Positive | Next: Send revised quote by 2 PM    │    │
│  │           By: Rahul B                                             │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ 09:45 AM  📧  Email received: "Re: Workspace upgrade query"        │    │
│  │           From: rajesh@acmecorp.com                                │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  📅 YESTERDAY                                                             │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ 04:15 PM  🔄  Status changed: Trial Active → Quote Sent           │    │
│  │           Quote #Q-2026-0042 sent for ₹2.45L                       │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  📅 LAST WEEK                                                             │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ 🤝  Demo scheduled — 2 hours — Mumbai office (4 attendees)        │    │
│  │ 📝  Note: Decision maker = CTO Rajesh, not founder. Budget ₹3L.   │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.5 Quotation Builder

```
┌────────────────────────────────────────────────────────────────────────────┐
│ New Quotation                                  [Save Draft] [Preview PDF]  │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Customer:  [Acme Corp                              ▼ ]  [+ New]          │
│  Domain:    acmecorp.com                                                   │
│  Quote #:   Q-2026-0042 (auto)        Valid for: [30] days                │
│                                                                            │
│  ───────────────────────────────────────────────────────────              │
│  Line Items                                            [+ Add Item]        │
│  ───────────────────────────────────────────────────────────              │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ # | Description              | HSN    | Qty | Rate    | Amount  │    │
│  │ 1 | Google Workspace Plus    | 998313 | 25  | ₹1,380  | ₹34,500│    │
│  │   | Annual commitment        |        |     | /mo     | /mo    │    │
│  │ 2 | Google Voice Standard    | 998313 | 5   | ₹800    | ₹4,000 │    │
│  │   |                          |        |     | /mo     | /mo    │    │
│  │                                                          [Add+] │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  Billing Cycle:  [● Annual]  [○ Monthly]  [○ Quarterly]                   │
│  Commitment:     12 months                                                 │
│                                                                            │
│  ───────────────────────────────────────────────────────────              │
│  Calculation                                                               │
│  ───────────────────────────────────────────────────────────              │
│  Subtotal (12 months)                       ₹4,62,000                     │
│  Discount  [10] %  [Apply]                  -₹46,200                      │
│  ─────────────────────                                                    │
│  Taxable Amount                             ₹4,15,800                     │
│                                                                            │
│  Customer State: Maharashtra (27)  ≠  Our State: Delhi (07)               │
│  → IGST applicable @ 18%                                                  │
│  IGST                                       ₹74,844                       │
│  ═══════════════════════                                                  │
│  GRAND TOTAL                                ₹4,90,644                     │
│                                                                            │
│  [Save Draft]    [Send via Email]    [Send via WhatsApp]    [Preview]     │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.6 Renewals Dashboard

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Renewals                                              [Export] [Bulk Email]│
├────────────────────────────────────────────────────────────────────────────┤
│  Total Renewable: 47 subs | ARR at Risk: ₹38,40,000                       │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  🔴 URGENT — Next 7 Days                                                  │
│  ───────────────────────                                                   │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Customer       | Plan       | Seats | Renewal     | MRR    | Act │    │
│  ├──────────────────────────────────────────────────────────────────┤    │
│  │ Cosmo Tech     | Plus       | 12    | 21 May (2d) | ₹16.5K | [📞]│    │
│  │ Hotel Royal    | Standard   | 8     | 24 May (5d) | ₹5.9K  | [📞]│    │
│  │ Kilo Foods     | Starter    | 30    | 25 May (6d) | ₹4.1K  | [📞]│    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  🟠 UPCOMING — Next 30 Days                                               │
│  ──────────────────────                                                    │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Acme Corp      | Plus       | 25    | 15 Jun      | ₹34.5K | [📧]│    │
│  │ Beta Industries| Standard   | 15    | 18 Jun      | ₹11.0K | [📧]│    │
│  │ Delta Pvt Ltd  | Plus       | 50    | 22 Jun      | ₹69.0K | [📧]│    │
│  │ ... +9 more                                                       │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  🟢 FUTURE — 31-90 Days                                                   │
│  ──────────────────                                                        │
│  35 subscriptions worth ₹28,80,000                          [View All]    │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.7 Customer Portal — Subscription View

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Welcome, Rajesh!  Acme Corp                          [Logout]   PA [▼]    │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Your Subscriptions                                                       │
│  ──────────────────                                                       │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ Google Workspace Plus                            🟢 ACTIVE      │      │
│  │ ────────────────────────                                        │      │
│  │ Seats:           25  (3 unused — invite team)                   │      │
│  │ Monthly cost:    ₹34,500                                        │      │
│  │ Billing cycle:   Annual                                         │      │
│  │ Started:         15 Sep 2025                                    │      │
│  │ Renewal due:     15 Sep 2026   (118 days)                       │      │
│  │ Auto-renew:      ON                                             │      │
│  │                                                                 │      │
│  │ [Manage Users] [Upgrade Plan] [Renewal Quote] [Contact Support] │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                                                            │
│  Quick Actions                                                            │
│  ─────────────                                                             │
│  📄 Download Invoices    🎫 Raise Support Ticket    📞 Schedule Call      │
│  💳 Update Payment       📊 Usage Report             ⚙️ Account Settings  │
│                                                                            │
│  Recent Invoices                                            [View All →]  │
│  ──────────────────                                                        │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ INV-2026-0042  | 15 Sep 2025  | ₹4,90,644  | ✅ Paid | [📥]     │      │
│  │ INV-2025-0098  | 15 Sep 2024  | ₹4,15,200  | ✅ Paid | [📥]     │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.8 Customer Portal — Quote Acceptance + Pay Online

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Client A                                                         │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Hi Rajesh,                                                                │
│  Here is your quotation for Google Workspace Plus upgrade.                 │
│                                                                            │
│  Quotation #Q-2026-0042                          Valid until: 18 Jun 2026 │
│  ────────────────────────                                                  │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ Product                          | Qty | Rate     | Amount     │      │
│  │ Google Workspace Plus (Annual)   | 25  | ₹1,380   | ₹34,500/mo│      │
│  │ Google Voice Standard            | 5   | ₹800     | ₹4,000/mo │      │
│  ├────────────────────────────────────────────────────────────────┤      │
│  │                              Subtotal (Annual): ₹4,62,000      │      │
│  │                              Discount (10%):     -₹46,200      │      │
│  │                              IGST (18%):         ₹74,844       │      │
│  │                              ──────────────────                │      │
│  │                              TOTAL:              ₹4,90,644      │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                                                            │
│  ┌───────────────────────┐   ┌───────────────────────┐                   │
│  │   ✅ ACCEPT & PAY     │   │   💬 Discuss / Modify │                   │
│  │   Via Razorpay        │   │   Schedule a call     │                   │
│  └───────────────────────┘   └───────────────────────┘                   │
│                                                                            │
│  Once payment is received, your Workspace will be provisioned within      │
│  24 hours. We'll guide you through DNS and admin setup.                   │
│                                                                            │
│  [📥 Download PDF]    [📧 Email me a copy]    [❓ Got a question?]        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.9 Automation Rule Builder (NEW)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Automation Rules                                          [+ New Rule]     │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Active Rules (8)                                                          │
│  ─────────────                                                             │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ ✅ Renewal Reminder T-30                                  [⚙️]  │      │
│  │    WHEN: Subscription renewal in 30 days                        │      │
│  │    THEN: Email customer + Create task for owner                 │      │
│  │    Last run: 9:00 AM today | 3 emails sent                      │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ ✅ Invoice Paid Auto-Receipt                              [⚙️]  │      │
│  │    WHEN: Invoice status → paid                                  │      │
│  │    THEN: Send receipt PDF via email + WhatsApp                  │      │
│  │    Last run: 11:32 AM today | 5 receipts sent                   │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ ✅ Stuck Lead Alert                                       [⚙️]  │      │
│  │    WHEN: Lead in same stage > 7 days, no activity              │      │
│  │    THEN: Flag red + notify assigned sales rep                  │      │
│  │    Last run: 9:00 AM today | 4 leads flagged                    │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                                                            │
│  ─────── Create New Rule ───────                                          │
│                                                                            │
│  WHEN  [Event ▼]    [Condition ▼]                                         │
│  ┌──────────────────────────────────────────────┐                         │
│  │ Subscription renewal in [30] days            │                         │
│  └──────────────────────────────────────────────┘                         │
│                                                                            │
│  THEN  Do these actions (in order):                                        │
│  1. [Send Email ▼]  Template: [Renewal-T30 ▼]                             │
│  2. [Create Task ▼] Assign to: [Owner of customer ▼]                      │
│  3. [Send WhatsApp ▼]  Template: [Renewal-T30-WA ▼]                       │
│                                                                            │
│  [Test Rule]                            [Save & Activate]                  │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.10 Mobile View — Sales Rep on Field

```
┌──────────────────────┐
│ ☰ ResellerOS    🔔   │
├──────────────────────┤
│                      │
│ 📊 My Day            │
│ ──────────           │
│                      │
│ ┌──────────────────┐ │
│ │ 3 Tasks Due      │ │
│ │ 2 Calls Pending  │ │
│ │ ₹4.2L Pipeline   │ │
│ └──────────────────┘ │
│                      │
│ Today's Followups    │
│ ──────────────       │
│                      │
│ ┌──────────────────┐ │
│ │ ⚡ Acme Corp     │ │
│ │ Call Rajesh      │ │
│ │ 11:30 AM         │ │
│ │ [Call] [Note]    │ │
│ └──────────────────┘ │
│                      │
│ ┌──────────────────┐ │
│ │ 📧 Beta Ltd      │ │
│ │ Send quote f/u   │ │
│ │ 02:00 PM         │ │
│ │ [Email] [WApp]   │ │
│ └──────────────────┘ │
│                      │
│ ─────────────────    │
│  [+ Quick Add]       │
│ ─────────────────    │
│                      │
│ [📊][🎯][👥][💬][⚙️] │
└──────────────────────┘
```

---

## 7. Phased Roadmap — 8 Weeks to Full Automation

```
WEEK 1-2: FOUNDATION         WEEK 3-4: SALES PIPELINE
┌──────────────────────┐     ┌──────────────────────┐
│ • Data cleanup       │     │ • Leads module       │
│ • Team RBAC audit    │     │ • Kanban UI          │
│ • Role-based dashb.  │     │ • Activity timeline  │
│ • Email templates    │ ──▶ │ • Onboarding check   │
│ • Notification rules │     │ • Lead→Customer      │
│ • SOP docs           │     │   conversion         │
└──────────────────────┘     └──────────────────────┘
            │                            │
            ▼                            ▼
WEEK 5-6: AUTOMATION         WEEK 7-8: ENGAGEMENT
┌──────────────────────┐     ┌──────────────────────┐
│ • Rule builder UI    │     │ • WhatsApp integ.    │
│ • Workflow engine    │     │ • Bulk campaigns     │
│ • Cloud Functions    │     │ • Customer portal    │
│ • Auto-renewal mails │ ──▶ │ • Quote-accept flow  │
│ • Auto-receipts      │     │ • Self-service       │
│ • Custom reports     │     │ • AI lead scoring    │
└──────────────────────┘     └──────────────────────┘
```

### Phase-Wise Deliverables

#### **Phase 1 (Week 1-2): Foundation & Cleanup**
- ✅ Data audit (duplicate customers, stale leads)
- ✅ Team roles verified in gw-pro
- ✅ Dashboard customized per role
- ✅ 10 email templates configured
- ✅ SOPs published (1-page per role)
- ✅ Weekly cadence calendar set

**Outcome:** Team confusion 50% reduced

#### **Phase 2 (Week 3-4): Sales Pipeline & Activity**
- ➕ `leads.js` — Kanban + List view
- ➕ `activities.js` — Unified timeline
- ➕ `tasks.js` — Priority + assignment
- ➕ Onboarding checklist automation
- ➕ Lead → Customer convert flow

**Outcome:** Sales team visibility 10x, no more "lead kahan gaya" confusion

#### **Phase 3 (Week 5-6): Automation Engine**
- ➕ Rule builder UI in Settings
- ➕ 12 starter rules pre-configured
- ➕ Cloud Function workflow runner
- ➕ Custom report builder
- ➕ AI-suggested next actions

**Outcome:** 15+ hours/week manual work eliminated

#### **Phase 4 (Week 7-8): Customer Engagement**
- 🎁 WhatsApp Business API integration
- ➕ Bulk campaign module
- ➕ Customer self-service portal
- ➕ Quote acceptance + online pay flow
- ➕ AI lead scoring

**Outcome:** Customer satisfaction up, sales cycle compressed

---

## 8. Tech Stack Decision

### Decision Matrix

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Continue with gw-pro (Vite + vanilla JS)** | Mature, working, fast, modular | Vanilla JS perceived as "old" | ✅ **RECOMMENDED** |
| B. Rewrite in Next.js (ResellerOS-Next) | Modern stack, TS, SSR | 6+ months rewrite, business risk | ❌ Avoid |
| C. Hybrid (gw-pro + Next.js admin) | Best of both | Maintenance nightmare | ❌ Avoid |

### Final Tech Stack (V3 Recommendation)

| Layer | Tech | Reason |
|---|---|---|
| **Frontend** | Vite + ES Modules | Existing, fast, modular |
| **State** | SQL.js (in-browser cache) + Firestore sync | Already wired |
| **Backend** | Firebase Cloud Functions (Node 20) | Auto-scale |
| **DB** | Cloud Firestore (asia-south1) | Existing tenant model |
| **Auth** | Firebase Auth + Custom Claims | RBAC built-in |
| **Storage** | Firebase Storage | PDFs, attachments |
| **Search** | SQL.js queries (in-memory) | No external dep |
| **PDF** | jsPDF + jspdf-autotable | Existing |
| **Email** | Gmail API (per tenant) | Already integrated |
| **WhatsApp** | WhatsApp Business Cloud API | New addition |
| **Payments** | Razorpay | Already integrated |
| **Monitoring** | Sentry | Already wired |
| **Hosting** | Firebase Hosting | Already deployed |
| **CDN** | Firebase auto | Built-in |

**No new technologies introduced.** Build on what works.

---

## 9. Data Migration Strategy

### Source of Truth: gw-pro Firestore (`gw-pro-quotation` project)

```
Existing collections (KEEP AS-IS):
├── resellers/{uid}/
│   ├── customers
│   ├── items
│   ├── quotations
│   ├── invoices
│   ├── workspace_subscriptions
│   ├── support_tickets
│   └── ... (all existing)
│
Add new collections (Phase 2):
├── resellers/{uid}/
│   ├── leads               ← NEW
│   ├── activities          ← NEW
│   ├── tasks               ← NEW
│   └── automation_rules    ← Phase 3
```

### From ResellerOS-Next: Harvest, Don't Migrate

- **Port:** WhatsApp bot integration code
- **Port:** Email digest cron pattern (Vercel cron → Firebase scheduled function)
- **Discard:** PostgreSQL schema (Firestore stays)
- **Discard:** Next.js code (Vite stays)

### From LeadOS Guide: Reference Only

- Use Kanban UI pattern as design inspiration for `leads.js`
- Otherwise, archive the markdown — code never built

---

## 10. Team Workflow & SOPs

### Daily Cadence

```
┌──────────────┬─────────────────────────────────────────────┐
│ Time         │ Activity                                     │
├──────────────┼─────────────────────────────────────────────┤
│ 09:00 AM     │ All hands: Check dashboard, today's tasks   │
│ 09:15 AM     │ Sales: Lead pipeline review (5 min)         │
│ 09:30 AM     │ Provisioning: Open onboarding checklist     │
│ 10:00 AM     │ Sales calls / follow-ups                    │
│ 11:00 AM     │ Support: Open ticket triage                 │
│ 12:00 PM     │ Lunch                                       │
│ 02:00 PM     │ Demos, quote sending                        │
│ 04:00 PM     │ Finance: Invoice + payment reconciliation   │
│ 05:30 PM     │ End-of-day: Update activities, log notes    │
│ 06:00 PM     │ Auto-digest email to owner (daily summary)  │
└──────────────┴─────────────────────────────────────────────┘
```

### Weekly Cadence

| Day | Time | Meeting | Owner |
|---|---|---|---|
| Mon | 10:00 AM | Sales pipeline review (30 min) | Sales lead |
| Wed | 11:00 AM | Renewals & customer health (30 min) | CS lead |
| Thu | 03:00 PM | Support ticket review (20 min) | Support lead |
| Fri | 04:00 PM | Finance & collections (45 min) | Accountant |
| Fri | 05:00 PM | Owner business review (1 hr) | You |

### Role-Wise SOP Templates

Each role gets a **1-page playbook**:

1. **Sales SOP** — Lead intake → qualify → demo → quote → close
2. **Provisioning SOP** — Closed deal → DNS → Account → Training → Handoff
3. **Support SOP** — Ticket triage → SLA → Resolution → KB update
4. **Finance SOP** — Invoice → Send → Track → Reconcile → Report
5. **Owner SOP** — Daily metrics → Weekly review → Monthly strategy

(SOPs to be written as separate docs in Phase 1)

---

## 11. Success Metrics (KPIs)

### Business KPIs (Track Weekly)

| Metric | Current (estimated) | Target (12 weeks) |
|---|---|---|
| **MRR** | ₹4.2L | ₹6.5L (+55%) |
| **Customer count** | ~120 | 180 |
| **Sales cycle (lead→close)** | 35 days | 21 days |
| **Renewal rate** | 70% | 90% |
| **Avg deal size** | ₹2L | ₹2.5L |
| **Pipeline value** | ₹18L | ₹35L |

### Operational KPIs (Track Daily)

| Metric | Target |
|---|---|
| Manual data entry time | < 1 hr/day per person |
| Invoice generation time | < 2 min |
| Quote turnaround | Same day |
| Support ticket first response | < 4 hrs |
| Renewal alert success rate | 100% (none missed) |
| Onboarding time (closed → live) | < 48 hrs |

### Product KPIs (Internal)

| Metric | Target |
|---|---|
| Active users daily | 5/5 team |
| Feature adoption (Leads module) | 100% within 2 weeks |
| Mobile usage | 30% of sessions |
| Customer portal logins | 40% of customers/month |
| Automation rules running | 12+ |

---

## 12. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| Team resists new modules (Leads/Kanban) | High | Medium | Phase 1 includes training + SOPs |
| WhatsApp API approval delay | Medium | Medium | Apply early; use Twilio fallback |
| gw-pro production data corruption during migration | Critical | Low | Daily Firestore export backups |
| Cloud Functions costs spike | Low | Low | Budget alerts at ₹5K/mo |
| Sales team uses Excel anyway | High | Medium | Make Kanban faster than Excel; gamification |
| Customer portal adoption low | Medium | Medium | Promote in invoice emails; SMS link |
| Algolia/search not needed (over-engineering) | Low | High | Use SQL.js for now, add later |
| Owner (you) too busy to review weekly | High | Medium | Auto-digest email Fri evening |

---

## 13. Naming & Branding Decision

### Product Name Options

| Option | Pros | Cons |
|---|---|---|
| **ResellerOS** (recommend) | Broad, scalable, modern | Already exists as half-built project |
| **GW Pro v3** | Continuity from current | Limits to Google Workspace branding |
| **PartnerOS** | Generic enough | Doesn't say "reseller" |
| **Channel Pro** | B2B-sounding | Generic |
| **CloudResellerOS** | Descriptive | Long |

**Recommended:** **ResellerOS** — and treat the existing "ResellerOS-Next" Next.js project as a discontinued prototype.

### Visual Identity

- **Logo:** Keep existing gw-pro logo OR refresh to "ResellerOS" wordmark
- **Primary color:** Purple `#8b5cf6` (already in use)
- **Secondary:** Existing dark theme glassmorphism (already in use)
- **Tagline:** "Your Reseller Business, on Autopilot"

---

## 14. Open Decisions (Aapse Confirmation Chahiye)

Yeh 7 decisions confirm karo, fir Phase 1 ka exact kick-off plan banta hai:

| # | Decision | Options | Default |
|---|---|---|---|
| 1 | **Final product name?** | ResellerOS / GW Pro v3 / Custom | ResellerOS |
| 2 | **Codebase consolidation approach?** | Continue gw-pro / Rewrite Next.js / Hybrid | Continue gw-pro |
| 3 | **ResellerOS-Next ka kya kare?** | Sunset / Harvest WhatsApp only / Keep parallel | Harvest only |
| 4 | **Domain name for product?** | resellersos.in / gwpro.in / new domain | resellersos.in |
| 5 | **Team size right now?** | 1 / 2-3 / 4-5 / 6+ | Confirm me |
| 6 | **Phase 1 start date?** | This week / Next week / Specific date | Confirm me |
| 7 | **Budget for WhatsApp Business API?** | Have it / Need to apply / Skip | Confirm me |

---

## 15. What Customer Sees vs What Team Sees

### Customer Sees (Marketing + Portal):
- Landing page (Section 6.1)
- Quote acceptance + pay (Section 6.8)
- Customer portal (Section 6.7)
- Support ticket form
- Email/WhatsApp communications

### Team Sees (Internal CRM):
- Dashboard (Section 6.2)
- Lead Kanban (Section 6.3)
- Customer 360° (Section 6.4)
- Quote builder (Section 6.5)
- Renewals dashboard (Section 6.6)
- Automation rules (Section 6.9)
- Mobile view (Section 6.10)

**Customer never sees internal modules.** Clean separation via auth.

---

## 16. Out of Scope (V3)

To avoid scope creep, **yeh V3 me NAHI hai**:

- ❌ Multi-language UI (English only)
- ❌ Mobile native app (PWA covers it)
- ❌ Cryptocurrency payments
- ❌ International compliance (GDPR/CCPA — Indian DPDP covered)
- ❌ AI chatbot for customer support (Phase 5+)
- ❌ Marketplace for third-party apps
- ❌ Public API for external integrations (already exists, no enhancement)
- ❌ White-label for sub-resellers (Phase 5+)

---

## 17. Appendix — Document Hierarchy Going Forward

```
┌─────────────────────────────────────────────────────────────┐
│  UNIFIED-PRD-V3.md (this file)        ← STRATEGY, FEATURES   │
│  ─────────────────────────                                   │
│       │                                                       │
│       ├─▶ SOP-Sales.md             ← How sales team works    │
│       ├─▶ SOP-Provisioning.md      ← Onboarding checklist    │
│       ├─▶ SOP-Support.md           ← Ticket workflow         │
│       ├─▶ SOP-Finance.md           ← Billing & collections   │
│       │                                                       │
│       ├─▶ TRD-Leads-Module.md      ← Tech design: leads.js   │
│       ├─▶ TRD-Activities.md        ← Tech design: timeline   │
│       ├─▶ TRD-Automation.md        ← Tech design: rule eng.  │
│       │                                                       │
│       └─▶ CUSTOMER-BROCHURE.pdf    ← Sales collateral         │
│                                                               │
│  Archive (do not edit):                                       │
│       ├─ LEADOS-FIREBASE-REBUILD-GUIDE.md (V1)               │
│       └─ LEADOS-RESELLER-CRM-V2-PRD.md (V2)                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 18. Next Steps (Aaj Hi)

1. **Yeh PRD V3 padho** (1 hour read)
2. **Section 14 ke 7 decisions** confirm karo
3. **Decisions confirm hone ke baad** main yeh banaunga:
   - 5 SOP docs (1 page each per role)
   - Phase 1 detailed task breakdown (day-by-day)
   - Wireframes ka high-fidelity version (agar PDF/PNG chahiye)
   - Customer demo PDF (Section 6 wireframes ko stand-alone PDF)

---

**End of PRD V3**

*Yeh document final hai. V1 aur V2 ko archive me move karein. Aage sirf is document aur uske child docs (SOPs, TRDs) ko follow karein.*

---

### Document Control

| Version | Date | Author | Changes |
|---|---|---|---|
| V1 | Earlier | — | Initial LeadOS rebuild guide (Postgres → Firestore) |
| V2 | 2026-05-19 | Claude + Pardeep | Added reseller-specific features layer |
| **V3** | **2026-05-19** | **Claude + Pardeep** | **Unified all projects, added wireframes, defined SOPs structure** |
