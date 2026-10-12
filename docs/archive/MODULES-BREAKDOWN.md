# ResellerOS — Module-Wise Breakdown

> Total **19 modules** organized into **3 phases**. Each module = standalone deliverable with clear dependencies, time estimate, and live example.

---

## 📊 At-A-Glance Module Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                         PHASE 1 — MVP (6 weeks)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ M1: Auth     │  │ M2: Settings │  │ M3: Items    │               │
│  │ Multi-tenant │→ │ + RBAC       │→ │ Catalog      │               │
│  └──────┬───────┘  └──────────────┘  └──────┬───────┘               │
│         ↓                                    ↓                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ M4: Customers│→ │ M5: Quotes   │→ │ M6: Invoices │               │
│  │              │  │ + GST + PDF  │  │ + Razorpay   │               │
│  └──────────────┘  └──────────────┘  └──────┬───────┘               │
│                                              ↓                       │
│                    ┌──────────────┐  ┌──────────────┐               │
│                    │ M7: Subs     │→ │ M8: Renewals │               │
│                    └──────────────┘  └──────────────┘               │
│                                              ↓                       │
│                    ┌──────────────────────────────┐                  │
│                    │ M9: Customer Portal (basic)  │                  │
│                    └──────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│                      PHASE 2 — Sales Pipeline (4 weeks)              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐    │
│  │M10: Leads  │  │M11: Activ. │  │M12: Tasks  │  │M13: Dash   │    │
│  │Kanban      │  │Timeline    │  │Followups   │  │(role-based)│    │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘    │
│  ┌────────────────────────┐  ┌────────────────────────┐             │
│  │M14: Onboarding Wizard  │  │M15: Support Tickets    │             │
│  └────────────────────────┘  └────────────────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│                      PHASE 3 — Power Features (4 weeks)              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐    │
│  │M16: Reports│  │M17: Automn │  │M18:        │  │M19: Mobile │    │
│  │+ Analytics │  │Engine      │  │Campaigns   │  │PWA         │    │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

# PHASE 1 — MVP MODULES (9 modules, 6 weeks)

## M1: Authentication + Multi-Tenant Foundation

### What It Is
Login/logout system jisme **har reseller (tenant) ka data alag** hota hai. Firebase Auth + custom claims for roles.

### Live Example
**Scenario:** Two resellers using same ResellerOS platform:
- **Tenant A:** Client A (Pardeep, Delhi)
- **Tenant B:** CloudCorp Services (Vikram, Bangalore)

Both login via `app.resellerosaas.com`. Pardeep ne login kiya:
- His JWT has `resellerUid: "tenantA-uid"`, `role: "owner"`
- He sees ONLY his customers (Acme, Cosmo, Delta...)
- Vikram's customers (TechCorp, FastFoods...) invisible to him

### Firestore Structure
```
firestore/
├── tenants/
│   ├── {tenantA-uid}/        ← Client A data
│   │   ├── customers/
│   │   ├── quotations/
│   │   └── ...
│   └── {tenantB-uid}/        ← CloudCorp data
│       ├── customers/
│       └── ...
└── users/
    ├── pardeep@clienta.in  ← uid + role + tenantId
    └── vikram@cloudcorp.in
```

### Tech Stack Specifics
- Firebase Auth (email/password + Google OAuth)
- Custom claims: `{ role, tenantId, plan }`
- Next.js middleware for protected routes
- Firestore Security Rules with tenant isolation

### Deliverables
- ✅ Login page (`/login`)
- ✅ Signup flow (first user = tenant owner)
- ✅ Invite team members (sends magic link)
- ✅ Role assignment (Owner/Admin/Sales/Accountant/Support)
- ✅ Forgot password flow
- ✅ Session management

### Dependencies
**None** — Foundation module, must be first.

### Effort
**4-5 days** (1 dev)

### Acceptance Criteria
1. Pardeep can sign up as new tenant
2. Pardeep can invite Rahul as Sales role
3. Rahul logs in, sees only sales-allowed screens
4. Pardeep and Vikram (different tenants) cannot see each other's data
5. Logout clears all session data

---

## M2: Settings & Team Management

### What It Is
Company-wide configuration: GSTIN, branding, currency, integrations, team roster, permissions.

### Live Example
Pardeep logs in for first time:
1. Settings → Company tab
2. Fills:
   - Legal Name: "Client A Pvt Ltd"
   - GSTIN: "07AABCE1234D1Z9"
   - PAN: "AABCE1234D"
   - State: Delhi (07)
   - Currency: INR
   - Logo: uploads PNG
3. Settings → Team tab
4. Invites:
   - rahul@clienta.in → Sales
   - amit@clienta.in → Accountant
   - sneha@clienta.in → Support

Yeh data **har quote/invoice me letterhead pe auto-fill** hota hai.

### Sub-Screens
1. **Company Info** — Legal name, GSTIN, PAN, address, logo
2. **Team** — Invite, manage roles, deactivate
3. **Branding** — Colors, fonts, email signature
4. **Integrations** — Razorpay, Zoho, Gmail, WhatsApp, Reseller APIs status
5. **Notifications** — Email/WhatsApp preferences
6. **Security** — Password policy, 2FA, audit log

### Dependencies
- **M1** (Auth) — must be done first

### Effort
**3 days**

### Acceptance Criteria
1. Pardeep can update company info, persists across sessions
2. Logo uploaded shows on quotes/invoices automatically
3. Pardeep can invite 5 team members with different roles
4. Each role sees only allowed settings tabs

---

## M3: Items Catalog (SKU Master)

### What It Is
Product database with all sellable items: Google Workspace plans, Microsoft 365 plans, Zoho plans, add-ons.

### Live Example
Pardeep adds Google Workspace SKUs:

| SKU | Name | Vendor | HSN | MSRP/mo | Wholesale/mo | Margin |
|---|---|---|---|---|---|---|
| GW-STR | Workspace Starter | Google | 998313 | ₹136 | ₹110 | 19% |
| GW-STD | Workspace Standard | Google | 998313 | ₹736 | ₹620 | 16% |
| GW-PLS | Workspace Plus | Google | 998313 | ₹1,380 | ₹1,150 | 17% |
| GV-STD | Voice Standard | Google | 998313 | ₹800 | ₹680 | 15% |

Quote builder me Rahul jab "Workspace Plus" type karega → auto-suggest aata, fields auto-fill (HSN, rate).

### Sub-Screens
1. **Items List** — Table with all SKUs, vendor filter
2. **Add/Edit Item** — Modal with pricing, HSN, vendor
3. **Wholesale Costs Upload** — CSV import for cost prices
4. **MSRP Changes Review** — When vendor updates prices, approval flow
5. **Vendor SKU Sync** (Google/MS/Zoho) — Auto-import from vendor APIs

### Dependencies
- **M1** (Auth)
- **M2** (Settings — to know which vendors enabled)

### Effort
**4 days**

### Acceptance Criteria
1. Pardeep can add 50+ SKUs across 3 vendors
2. CSV import works for bulk add
3. Margin auto-calculated (MSRP - wholesale)
4. Filters work: by vendor, by category
5. Quote builder pulls from this catalog

---

## M4: Customers (CRM Master)

### What It Is
Central customer database. Sab kuch customer ke around revolve karta hai.

### Live Example
Acme Corp record:
```json
{
  "legalName": "Acme Corp Pvt Ltd",
  "displayName": "Acme Corp",
  "primaryDomain": "acmecorp.com",
  "gstin": "27AABCS1234D1Z5",
  "stateCode": "27",
  "billingAddress": {
    "line1": "501 Tech Park",
    "city": "Mumbai",
    "state": "Maharashtra",
    "pincode": "400001"
  },
  "primaryContact": {
    "name": "Rajesh Kumar",
    "designation": "CTO",
    "email": "rajesh@acmecorp.com",
    "phone": "+91 98765 43210"
  },
  "billingContact": { ... },
  "technicalContact": { ... },
  "accountManagerId": "rahul-uid",
  "healthScore": 85,
  "status": "active"
}
```

### Sub-Screens
1. **Customers List** — Table with search, filter, sort
2. **Customer Detail (360°)** — Tabs: Overview, Subscriptions, Quotes, Invoices, Activities, Files
3. **Add/Edit Customer** — Form with GSTIN validation
4. **Bulk Import** — CSV upload with mapping
5. **Health Score** — Auto-calculated based on activity, support volume, payment history

### Dependencies
- **M1** (Auth), **M2** (Settings)

### Effort
**5 days**

### Acceptance Criteria
1. Add customer with GSTIN validation (15-char format check)
2. State auto-detected from GSTIN first 2 digits
3. CSV import 100 customers in one go
4. Search works on name/domain/email/phone
5. Health score displays on detail page

---

## M5: Quotations + GST + PDF Generation

### What It Is
Heart of sales — quote banake bhejne ka tool. **Sabse complex module.**

### Live Example
Rahul Acme Corp ke liye quote banata:

**Step 1: Customer select** → Auto-fills GSTIN, state
**Step 2: Add line items:**
- Workspace Plus × 25 seats × 12 months = ₹4,14,000
- Voice Standard × 5 seats × 12 months = ₹48,000

**Step 3: Discount apply** → 10% = -₹46,200
**Step 4: GST auto-calc** → Maharashtra (27) ≠ Delhi (07) → **IGST 18%** = ₹74,844
**Step 5: Total** → ₹4,90,644

**Step 6: Send** → PDF auto-generate, WhatsApp/Email send

### Sub-Screens
1. **Quotes List** — All quotes with status filter
2. **Quote Builder** — Main creation UI
3. **Quote Detail/Preview** — Read-only view + actions (send, accept, void)
4. **PDF Template** — Customizable letterhead, T&Cs

### Critical Tech
- **GST calculation engine** (CGST/SGST same-state, IGST inter-state)
- **PDF generation** (react-pdf or jsPDF + autoTable)
- **Auto-generate quote number** (Q-{FY}-{seq})
- **Email + WhatsApp send** integration
- **Quote validity** (default 30 days, auto-expire)

### Dependencies
- **M3** (Items — for line items)
- **M4** (Customers — for buyer)
- **M2** (Settings — for company info on PDF)

### Effort
**6 days** (most complex MVP module)

### Acceptance Criteria
1. Create quote with 5+ line items
2. GST auto-calc correct (test both same-state and inter-state)
3. PDF generates with Client A letterhead, GSTIN, all line items
4. Send via Email — customer receives PDF attachment
5. Send via WhatsApp — message + PDF link
6. Quote validity countdown shown

---

## M6: Invoices + Razorpay Integration

### What It Is
Quote accept hone pe invoice auto-banta, Razorpay payment link send hota, payment auto-track hota.

### Live Example
Acme Corp customer "Accept & Pay" click karta:

```
Quote Q-2026-0042 accepted (Day 16, 4:30 PM)
    ↓
Auto-create invoice INV-2026-0089
    ↓
Razorpay payment page khulta (₹4,90,644)
    ↓
Customer pays via HDFC Net Banking
    ↓
Razorpay webhook fires (3 seconds)
    ↓
Invoice marked PAID, Customer record created, Subscription activated
    ↓
Email/WhatsApp confirmation sent
```

### Sub-Screens
1. **Invoices List** — All invoices, status tabs (Paid/Pending/Overdue/Draft)
2. **Invoice Detail** — Line items, GST, payment history, send/download actions
3. **Razorpay Setup** — API keys (in Settings → Integrations)
4. **Webhook Logs** — Razorpay events for debugging
5. **Manual Payment Entry** — For NEFT/Cheque/Cash (not via Razorpay)

### Critical Tech
- **Razorpay Order API** integration
- **Webhook handler** with signature verification (security!)
- **Auto-generate invoice number** (INV-{FY}-{seq})
- **Invoice PDF** (similar to quote, with "PAID" stamp if paid)
- **Payment reconciliation** with Razorpay dashboard

### Dependencies
- **M5** (Quotations — invoice generates from accepted quote)
- **M2** (Settings — Razorpay API keys)

### Effort
**5 days**

### Acceptance Criteria
1. Accepted quote auto-creates invoice
2. Razorpay payment link generated, customer can pay
3. Webhook updates invoice to PAID
4. Manual NEFT entry works
5. Overdue auto-detected (due date passed + unpaid)
6. PDF download with "PAID" stamp

---

## M7: Subscriptions

### What It Is
Active customer subscriptions tracking — kya plans active hain, kab end hote hain, MRR/ARR.

### Live Example
Acme Corp ka subscription record:
```json
{
  "customerId": "acme-id",
  "sku": "workspace_plus",
  "seats": 25,
  "billingCycle": "annual",
  "mrr": 34500,
  "arr": 414000,
  "startDate": "2026-05-16",
  "endDate": "2027-05-15",
  "autoRenew": true,
  "status": "active"
}
```

Plus Delta Pvt Ltd ka **multi-cycle** example:
- Annual ₹8.28L commitment
- Billed quarterly (4 cycles of ₹2.07L each)
- Parent subscription ID linked

### Sub-Screens
1. **Subscriptions List** — All subs with vendor filter, status tabs
2. **Subscription Detail** — Plan, seats, history, payments
3. **Multi-Cycle View** — Parent + child cycles
4. **Vendor Reconciliation** — Compare our DB vs Google Reseller API
5. **Upgrade/Downgrade** — Change seats or plan

### Critical Tech
- **MRR/ARR calculation** logic
- **Multi-cycle subscription** support
- **Vendor sync** with Google/Microsoft/Zoho APIs
- **Status management** (active → suspended → cancelled)

### Dependencies
- **M6** (Invoices — sub activates after payment)
- **M4** (Customers)

### Effort
**4 days**

### Acceptance Criteria
1. Subscription auto-creates after first invoice paid
2. MRR calculation correct (handles annual/monthly/quarterly)
3. Multi-cycle subs collapse in UI (show latest cycle)
4. Vendor reconciliation flags mismatches
5. Total ARR shown on dashboard

---

## M8: Renewals Engine

### What It Is
**Revenue protection module.** T-90/60/30/7 day alerts + auto-renewal quotes.

### Live Example
Cosmo Tech subscription ends 21 May 2026:
- **T-90 (20 Feb)**: Soft email to customer, task to Amit
- **T-60 (22 Mar)**: Auto-quote generated + email + WhatsApp
- **T-30 (21 Apr)**: WhatsApp + phone call task URGENT
- **T-7 (14 May)**: Daily WhatsApp until paid
- **17 May**: Customer pays → renewal cycle starts

### Sub-Screens
1. **Renewals Dashboard** — 3 buckets: Urgent (≤7d), Upcoming (30d), Future (31-90d)
2. **Auto-Renewal Settings** — Per customer toggle
3. **Bulk Reminder** — Select multiple, send batch reminders
4. **Renewal Quote Builder** — Auto-populated from existing sub

### Critical Tech
- **Daily Cloud Function** (9 AM IST)
- **Multi-stage alert logic** (T-90/60/30/7)
- **Auto-quote generation**
- **Customer state tracking** (sent/responded/paid)

### Dependencies
- **M7** (Subscriptions), **M5** (Quotations)

### Effort
**4 days**

### Acceptance Criteria
1. Cron runs daily 9 AM IST, no manual trigger needed
2. T-90 sends email + creates task
3. T-60 generates renewal quote automatically
4. T-30 fires WhatsApp + phone task
5. T-7 daily WhatsApp until paid
6. Dashboard shows 3 buckets correctly

---

## M9: Customer Portal (Basic)

### What It Is
Customer ka self-service portal — login karke khud subscriptions manage karein.

### Live Example
Rajesh (Acme Corp CTO) logs into `portal.resellerosaas.com`:
- Sees: 2 active subscriptions (Workspace Plus, Voice)
- Can: Download past invoices, raise ticket, request renewal quote
- Cannot: See pricing margins, contact internal team directly

### Sub-Screens
1. **Customer Login** — Magic link or password
2. **Portal Dashboard** — Subscriptions overview, KPIs
3. **My Subscriptions** — Detail of each active sub
4. **Invoices** — Download history with PDFs
5. **Raise Ticket** — Form submit to support
6. **Quote Accept Page** — When quote sent, customer accepts/pays here

### Critical Tech
- **Separate auth flow** (not same as internal team)
- **Read-only access** to their own data
- **Razorpay payment page** integration

### Dependencies
- **M4** (Customers), **M6** (Invoices), **M7** (Subscriptions)

### Effort
**5 days**

### Acceptance Criteria
1. Customer can request login link via email
2. Login takes to dashboard showing only their data
3. Invoice PDFs download correctly
4. Raise ticket creates entry in support queue
5. Quote accept flow works end-to-end (pay → confirm)

---

# PHASE 2 — SALES PIPELINE MODULES (6 modules, 4 weeks)

## M10: Lead Pipeline (Kanban Board)

### What It Is
Drag-drop Kanban board for sales pipeline management.

### Live Example
Rahul morning me Kanban kholta:
- **New (5)**: TechBrand, Hotel Royal, Kilo Foods, +2
- **Contacted (4)**: Beta, Gamma, +2
- **Demo Done (3)**: Cosmo, Hi-Tech, Acme
- **Trial Active (4)**: Delta, Iota, +2
- **Quote Sent (2)**: Echo, Acme
- **Won (12)**: Foxtrot, Golf, +10

Rahul Acme card drag karta "Demo Done" → "Quote Sent" → status auto-updates in DB.

### Sub-Screens
1. **Kanban View** — Default
2. **List View** — Table fallback
3. **Lead Detail** — Modal with full info
4. **Add Lead** — Form
5. **Bulk Import** — CSV upload

### Dependencies
- **M4** (Customers — leads become customers when won)

### Effort
**5 days** (drag-drop complexity)

### Acceptance Criteria
1. Drag card between columns updates DB
2. Filters work: by owner, source, value
3. Search across name/company
4. Add lead form validates required fields
5. Won leads auto-prompt: "Convert to customer?"

---

## M11: Activity Timeline

### What It Is
Every customer interaction logged: calls, emails, meetings, notes, status changes.

### Live Example
Acme Corp 360° → Activities tab:
```
TODAY
📞 11:30 AM — Call with Rajesh, discussed Plus upgrade (Rahul)
📧 09:45 AM — Email received: "Re: Workspace upgrade query"

YESTERDAY
🔄 04:15 PM — Status: Trial → Quote Sent
💰 04:30 PM — Quote sent ₹4,90,644

LAST WEEK
🤝 Demo @ Mumbai office (2 hours)
📝 Note: Decision maker = CTO Rajesh
```

### Sub-Screens
1. **Customer 360° Timeline** — Embedded in customer detail
2. **Global Activities Feed** — All team activities
3. **Add Activity Modal** — Manual log
4. **Activity Filters** — By type, user, date

### Critical Tech
- **Gmail integration** for auto-email logging
- **Activity types**: call/email/meeting/note/status_change/system
- **Polymorphic linking** (lead OR customer)

### Dependencies
- **M4** (Customers), **M10** (Leads)

### Effort
**4 days**

### Acceptance Criteria
1. Manual activity add works
2. Email auto-sync from Gmail (if integrated)
3. Status changes auto-log
4. Timeline groups by day
5. Filters work

---

## M12: Tasks & Followups

### What It Is
Action items, reminders, follow-up management.

### Live Example
Rahul ki "My Day":
- 🔴 **HIGH**: Call Cosmo Tech (T-7 renewal) — Today 11:30 AM
- 🟡 **MEDIUM**: Send revised quote to Delta — Today 2:00 PM
- 🟢 **LOW**: Email demo recording to TechBrand — Today EOD

Auto-created from:
- Renewal alerts (T-30/7)
- Demo bookings
- Stuck lead alerts

### Sub-Screens
1. **My Tasks** — Personal queue
2. **Team Tasks** — Owner view
3. **Calendar View** — Tasks on calendar
4. **Add/Edit Task** — Form

### Dependencies
- **M11** (Activities — completed tasks log activity)

### Effort
**3 days**

### Acceptance Criteria
1. Tasks auto-created from system events
2. Priority levels with visual cues
3. Done/Snooze/Reassign actions
4. Notification when due

---

## M13: Dashboard (Role-Based)

### What It Is
Personalized landing page jo role ke hisab se different KPIs dikhata.

### Live Example
- **Pardeep (Owner)**: MRR, Pipeline, Renewals, Overdue, CSAT, Churn
- **Rahul (Sales)**: My pipeline, My deals closed, My commission, Followups
- **Amit (Accountant)**: Overdue invoices, Collections today, GST due
- **Sneha (Support)**: Open tickets, SLA at risk, CSAT scores

### Sub-Screens
1. **Owner Dashboard** — Full business view
2. **Sales Dashboard** — Personal pipeline
3. **Finance Dashboard** — Money view
4. **Support Dashboard** — Tickets focus

### Dependencies
- All previous modules (pulls data from everywhere)

### Effort
**3 days**

### Acceptance Criteria
1. Role-based view loads correctly
2. KPI cards refresh every 5 min
3. Drill-down works (click MRR → see breakdown)
4. Today's focus widget shows action items

---

## M14: Onboarding Wizard

### What It Is
Step-by-step guided setup for new customer (post-payment).

### Live Example
TechBrand pays, wizard auto-launches:
1. **Welcome** — Account manager assigned
2. **DNS Setup** — MX/SPF/DKIM/DMARC with auto-verify
3. **Provisioning** — Google API license assignment
4. **Training** — Admin video + Q&A scheduled
5. **Go-Live** — Final check, marked Active

### Sub-Screens
1. **Wizard Steps** (4-5 steps)
2. **DNS Verification UI** — Show records to add, auto-check
3. **Provisioning Status** — Live updates
4. **Internal Onboarding Tracker** — For provisioning team

### Critical Tech
- **DNS lookup** library (dig TXT records)
- **Google Reseller API** for license assignment
- **Status polling** (auto-check DNS every 5 min)

### Dependencies
- **M4** (Customers), **M6** (Invoices — onboarding triggers post-payment)

### Effort
**5 days**

### Acceptance Criteria
1. Wizard launches after payment
2. DNS records correctly shown
3. Auto-verify works (5-min polling)
4. License auto-assigned via API
5. Status persisted across sessions

---

## M15: Support Tickets

### What It Is
Multi-channel ticket system: Portal + Email + WhatsApp.

### Live Example
Echo Pharma CTO Vikram raises ticket via portal:
- Subject: "Email not sending to external domains"
- Auto-routed to Priya (premium customer, urgent)
- Priya responds in 10 min (SLA 4 hr)
- Resolved in 1h 15m (SLA 24 hr)
- CSAT survey: 5/5

### Sub-Screens
1. **Tickets List** — Internal queue with SLA indicators
2. **Ticket Detail** — Thread, history, attachments
3. **Knowledge Base** — Articles for self-service
4. **Customer Support View** — In portal
5. **SLA Dashboard** — Owner view

### Critical Tech
- **Multi-channel ingestion** (form + email parser + WhatsApp bot)
- **SLA tracking** with auto-escalation
- **Email reply parsing** (link replies to ticket)

### Dependencies
- **M4** (Customers), **M11** (Activities)

### Effort
**5 days**

### Acceptance Criteria
1. Ticket created via 3 channels
2. Auto-routing rules work
3. SLA timer counts down
4. CSAT survey sent post-resolution
5. KB articles published

---

# PHASE 3 — POWER FEATURES (4 modules, 4 weeks)

## M16: Reports & Analytics

### What It Is
Business intelligence — MRR/ARR trends, churn, funnel, leaderboard.

### Live Example
Pardeep monthly review:
- **MRR Chart**: Last 12 months trend (₹2.5L → ₹4.2L = +68%)
- **Sales Funnel**: 120 leads → 22 wins (18% conversion)
- **Top Customers**: Delta ₹8.3L ARR, Echo ₹6.1L
- **Rep Leaderboard**: Rahul ₹8.2L this month
- **Churn**: 2 customers lost, ₹15K MRR

### Sub-Screens
1. **Owner Reports** — Full business analytics
2. **Custom Report Builder** — Drag-drop fields
3. **Scheduled Reports** — Auto-email weekly/monthly
4. **Export** — CSV/PDF/Excel

### Critical Tech
- **Chart library** (Recharts or Chart.js)
- **Real-time aggregations** from Firestore
- **PDF export** for sharing

### Effort
**6 days**

---

## M17: Automation Rules Engine

### What It Is
"IF X THEN Y" no-code rule builder + Cloud Function executor.

### Live Example
Rule: "Invoice paid → Send receipt PDF + WhatsApp + Update Zoho"
- Trigger: `invoice.status === 'paid'`
- Actions (3): Send email template, Send WhatsApp, Push to Zoho
- Last run: 11:32 AM today, 5 receipts sent

### Sub-Screens
1. **Rules List** — Active/Inactive toggle
2. **Rule Builder UI** — Visual workflow
3. **Execution Log** — When fired, success/failure
4. **Pre-Built Templates** — 12 starter rules

### Critical Tech
- **Cloud Function triggers** (Firestore onWrite)
- **Rule serialization** to JSON
- **Action executors** library

### Effort
**7 days** (most complex Phase 3)

---

## M18: Campaigns (Email + WhatsApp Bulk)

### What It Is
Targeted bulk messaging to customer segments.

### Live Example
"May Renewal Reminder" campaign:
- Segment: 12 customers with renewals in 30-60 days
- Channel: Email + WhatsApp combo
- Template: "Renewal-T30"
- Results: 12 sent, 8 opened, 5 clicked, 3 replied, 2 paid (16% conversion)

### Sub-Screens
1. **Campaigns List** — Active/Scheduled/Sent
2. **Campaign Builder** — Segment + Template + Schedule
3. **Templates Library** — Email + WhatsApp templates
4. **Performance Dashboard** — Open rates, replies

### Critical Tech
- **Segmentation engine** (query builder)
- **WhatsApp Business API** with template approval
- **Email tracking** (open pixel, click redirect)

### Effort
**6 days**

---

## M19: Mobile PWA

### What It Is
Progressive Web App for mobile access — install from browser.

### Live Example
Rahul on field at customer office:
- Opens phone browser → portal.resellerosaas.com
- "Add to Home Screen" → app installed
- Logs activity, calls customer, takes photo of signed PO
- Offline mode works during metro travel

### Sub-Screens
- All existing screens responsive
- Bottom nav (📊 🎯 👥 💬 ⚙️)
- Voice note recording
- Photo capture
- GPS check-in

### Critical Tech
- **Service Worker** for offline
- **Web Push Notifications**
- **PWA manifest**
- **Touch-optimized UI**

### Effort
**4 days**

---

# 🔌 CROSS-CUTTING INTEGRATIONS

Yeh modules ke ANDAR build hote hain, separate nahi:

| Integration | In Module(s) | Purpose |
|---|---|---|
| **Google Reseller API** | M3, M5, M7, M14 | Sync SKUs, provision trials, subscriptions, license assign |
| **Microsoft Partner Center** | M3, M7 | Same as Google for MS products |
| **Zoho Workplace** | M3, M7 | Same for Zoho products |
| **Razorpay** | M6, M9 | Payment processing |
| **Zoho Books** | M6 | Invoice sync, GSTR-1 |
| **Gmail API** | M11 | Email sync to activity timeline |
| **WhatsApp Business API** | M5, M8, M11, M18 | Messaging |
| **Google Calendar** | M12, M14 | Demo scheduling, training calls |

---

# 📊 EFFORT & TIMELINE SUMMARY

## Phase 1 — MVP (6 weeks, 9 modules)

| Module | Effort | Cumulative |
|---|---|---|
| M1: Auth + Multi-Tenant | 4d | 4d |
| M2: Settings & Team | 3d | 7d |
| M3: Items Catalog | 4d | 11d |
| M4: Customers | 5d | 16d |
| M5: Quotations + GST + PDF | 6d | 22d |
| M6: Invoices + Razorpay | 5d | 27d |
| M7: Subscriptions | 4d | 31d |
| M8: Renewals | 4d | 35d |
| M9: Customer Portal | 5d | **40d** |

**40 days ÷ 5 working days/week = 8 weeks (1 dev)**
**OR 4-5 weeks with 2 devs working parallel**

## Phase 2 — Sales Pipeline (4 weeks, 6 modules)

| Module | Effort |
|---|---|
| M10: Lead Kanban | 5d |
| M11: Activity Timeline | 4d |
| M12: Tasks & Followups | 3d |
| M13: Dashboard (role-based) | 3d |
| M14: Onboarding Wizard | 5d |
| M15: Support Tickets | 5d |
| **Total** | **25d (5 weeks)** |

## Phase 3 — Power Features (4 weeks, 4 modules)

| Module | Effort |
|---|---|
| M16: Reports & Analytics | 6d |
| M17: Automation Engine | 7d |
| M18: Campaigns | 6d |
| M19: Mobile PWA | 4d |
| **Total** | **23d (4-5 weeks)** |

## Grand Total
- **19 modules**
- **88 dev-days** (~17-18 weeks for 1 dev OR 9-10 weeks for 2 devs parallel)
- **MVP can launch in 4-6 weeks** with 2 devs

---

# 🎯 MODULE DEPENDENCY GRAPH (Build Order)

```
                    ┌─────────┐
                    │ M1 Auth │ ← Build first!
                    └────┬────┘
                         ↓
              ┌──────────┴──────────┐
              ↓                     ↓
        ┌──────────┐         ┌────────────┐
        │M2 Settings│         │M3 Items   │
        └─────┬────┘         └─────┬──────┘
              │                     │
              └──────────┬──────────┘
                         ↓
                   ┌──────────┐
                   │M4 Customers│
                   └─────┬────┘
                         ↓
                   ┌──────────┐
                   │M5 Quotes │
                   └─────┬────┘
                         ↓
                   ┌──────────┐
                   │M6 Invoices│
                   └─────┬────┘
                         ↓
                   ┌──────────┐
                   │M7 Subs   │
                   └─────┬────┘
                         ↓
              ┌──────────┴──────────┐
              ↓                     ↓
        ┌──────────┐         ┌────────────┐
        │M8 Renewals│         │M9 Portal  │
        └──────────┘         └────────────┘

       ─────── MVP COMPLETE ────────
                    ↓
              [Phase 2 starts]
            M10 → M11 → M12 → M13 → M14 → M15
                    ↓
              [Phase 3 starts]
            M16 → M17 → M18 → M19
```

**Critical insight:** M1 → M4 → M5 → M6 is the **critical path**. Without these, nothing else works.

---

# 💰 MODULE-WISE PRICING (if charging by module)

| Phase | Modules | Effort | Cost @ ₹8K/day | Total |
|---|---|---|---|---|
| Phase 1 (MVP) | M1-M9 | 40 days | ₹3.2L | **₹3.2L** |
| Phase 2 | M10-M15 | 25 days | ₹2.0L | **₹2.0L** |
| Phase 3 | M16-M19 | 23 days | ₹1.8L | **₹1.8L** |
| **TOTAL** | 19 modules | 88 days | | **₹7.0L** |

Plus 15-20% buffer for testing, integration issues, polish = **~₹8-8.5L** realistic total.

---

# ✅ ACCEPTANCE / DELIVERY CHECKLIST PER MODULE

Each module is "done" when:
1. ✅ All sub-screens functional
2. ✅ Unit tests written (60%+ coverage)
3. ✅ Integration tested with dependent modules
4. ✅ Demo to client + sign-off
5. ✅ Documentation written (user guide + tech README)
6. ✅ Deployed to staging
7. ✅ No P0/P1 bugs

---

**End of Modules Breakdown**

*Next step: Sprint plan (kab kya banega day-by-day). Bolo to woh banata hu.*
