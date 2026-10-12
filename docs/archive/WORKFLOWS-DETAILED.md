# ResellerOS — Detailed Workflows with Live Examples

> Yeh document 4 critical workflows ko **step-by-step live examples** ke saath cover karta hai. Har step me dikhata hai: kaun karta hai, kya hota hai, UI me kya dikhe, kya automation fire ho, time kitna lage.

---

## 📑 Table of Contents

1. [Lead-to-Cash Workflow](#1-lead-to-cash-workflow) — Acme Corp case study
2. [Renewal Automation Workflow](#2-renewal-automation-workflow) — Cosmo Tech case study
3. [Payment + GST + Zoho Sync Workflow](#3-payment--gst--zoho-sync-workflow) — Delta Pvt Ltd case study
4. [Support Ticket Lifecycle Workflow](#4-support-ticket-lifecycle-workflow) — Echo Pharma case study
5. [Bonus: Customer Onboarding Workflow](#5-customer-onboarding-workflow) — TechBrand case study

---

# 1. Lead-to-Cash Workflow

> **Live Example:** Acme Corp Pvt Ltd ka complete journey — Lead se Closed Won tak (28 days total)

## 👤 Background

- **Company:** Acme Corp Pvt Ltd
- **Domain:** acmecorp.com
- **Contact:** Rajesh Kumar (CTO)
- **Phone:** +91 98765 43210
- **Email:** rajesh@acmecorp.com
- **State:** Maharashtra (27)
- **Seats Required:** 25 users (Workspace Plus)
- **Source:** Inbound — Google Search → Website

---

## Step 1: Lead Capture (Day 1, 10:30 AM)

**WHO:** Customer (Rajesh) himself fills website form
**WHAT HAPPENS:**
```
Website form data → Webhook → ResellerOS API
  ↓
POST /api/leads
{
  "name": "Rajesh Kumar",
  "company": "Acme Corp Pvt Ltd",
  "email": "rajesh@acmecorp.com",
  "phone": "+91 98765 43210",
  "source": "website",
  "utmSource": "google_organic",
  "estimatedSeats": 25,
  "currentEmailProvider": "rediff",
  "message": "Want to migrate from Rediff Mail"
}
```

**UI ME:**
- Kanban "New" column me lead card auto-appear
- Color: Blue (new)
- Avatar initials: "RK"
- Footer: "Just now"

**AUTO-FIRE:**
- Round-robin assign to Sales rep (Rahul B)
- WhatsApp ping to Rahul: "🎯 New lead: Acme Corp — 25 seats expected"
- Activity log entry: `{type: 'system', title: 'Lead captured via website'}`
- Email auto-acknowledgment to Rajesh

**TIME:** 0 seconds (real-time)

---

## Step 2: First Contact (Day 1, 11:15 AM)

**WHO:** Rahul B (Sales)
**ACTION:** Rahul ne 11:15 AM pe call kiya

**UI ME:**
1. Rahul lead card click karega
2. Customer 360° view khulega
3. "📞 Call" button click → phone dialer + activity recorder start

**RAHUL LOG KARTA HAI:**
```
Activity Type: Call
Duration: 12 min
Outcome: Positive
Notes: "Rediff se migrate karna hai. 25 users hain. Decision maker = Rajesh.
        Budget approved ~₹3L. Comparing with Zoho. Demo schedule chahiye."
Next Action: Schedule demo for Day 3
Next Action Date: Day 3, 3:00 PM
```

**AUTO-FIRE:**
- Lead stage drag karke "Contacted" — auto-update DB
- Task auto-create: "Demo Day 3, 3:00 PM @ Acme Corp"
- Google Calendar invite sent to Rajesh
- Reminder set: Day 3, 2:30 PM

**TIME:** 12 min call + 2 min log

---

## Step 3: Demo Preparation (Day 2)

**WHO:** Rahul + Pre-sales team

**WHAT HAPPENS:**
- Rahul ResellerOS me Acme Corp ka profile dekhe — Rediff user hai (yeh notes me hai)
- Demo deck personalize karta — "Rediff to Google Workspace migration" focus
- Test trial account prepare karta (acmecorp.demo.gw-pro.com)

**TOOLS USED:**
- Customer 360° → Read notes
- Items Catalog → Workspace Plus features pull
- Quote Builder → Mock quote prepare for demo

**TIME:** 30 min prep

---

## Step 4: Demo Done (Day 3, 3:00-5:00 PM)

**WHO:** Rahul + Rajesh + Acme team (3 attendees)
**LOCATION:** Acme Corp office, Mumbai

**ACTION:** Live demo

**POST-DEMO LOG:**
```
Activity Type: Meeting
Duration: 2 hours
Outcome: Strong interest
Attendees: Rajesh (CTO), Suresh (CFO), Priya (HR Head)
Notes: "Demo went well. CFO concerned about pricing — wants
        annual vs monthly comparison. HR likes Drive integration.
        CTO wants trial for 14 days. Migration support needed
        — 800 GB data."
Next Action: Provision trial + send pricing comparison
Next Action Date: Day 3 (today, by 6 PM)
```

**UI ME:**
- Lead card moves to "Demo Done" column
- Card color: Purple
- Health indicator: 🟢 Hot lead

**TIME:** 2 hr demo + 5 min log

---

## Step 5: Trial Provisioning (Day 3, 5:45 PM)

**WHO:** Rahul → triggers automation

**ACTION:** Rahul "Provision Trial" button click karta in Customer 360°

**WHAT HAPPENS (BEHIND THE SCENES):**
```
1. ResellerOS → Google Reseller API call
   POST /workspace/v1/customers
   {
     "customerDomain": "acmecorp.com",
     "alternateEmail": "rajesh@acmecorp.com",
     "customerType": "domain"
   }

2. API response: customerId = "C03az79cb"

3. ResellerOS → Create subscription
   POST /workspace/v1/customers/C03az79cb/subscriptions
   {
     "skuId": "Google-Apps-Unlimited",
     "plan": "FLEXIBLE",
     "seats": 25,
     "trialEnd": Day 17 (14 days later)
   }

4. Activity log:
   - "Trial provisioned: Google Workspace Plus, 25 seats, expires Day 17"

5. Customer email triggered:
   "Welcome to your Google Workspace trial..."

6. Task auto-create: "Follow up with Acme — Day 10 (mid-trial check)"

7. Task auto-create: "Trial expiry — Day 15 (T-2 days)"
```

**UI ME:**
- Lead stage → "Trial Active"
- Card shows: "Trial expires in 14 days"
- Customer 360° → New "Subscription (Trial)" tile dikhe

**TIME:** 5 min Rahul effort + 3 min API processing

---

## Step 6: Mid-Trial Check (Day 10)

**WHO:** Rahul (auto-triggered task)

**TASK FIRES:** Dashboard pe Rahul ko "Acme Corp — mid-trial follow-up" task dikhe

**RAHUL DOES:**
- Phone call to Rajesh
- Check usage: Workspace admin panel — 18/25 seats activated
- Migration status: 600 GB of 800 GB migrated

**LOG:**
```
Activity Type: Call
Outcome: Positive
Notes: "18/25 users onboarded. Migration 75% done. CFO ne pricing
        comparison dekh liya — annual ₹1,380/user/mo me convinced.
        Quote chahiye next week."
Next Action: Send quote Day 14
```

**TIME:** 10 min call

---

## Step 7: Quote Creation (Day 14, 11:00 AM)

**WHO:** Rahul

**ACTION:** Quote Builder open

**STEPS:**

### 7.1 Customer Select
```
Customer field → Type "Acme" → Auto-suggest → Select
Auto-populate:
  - Domain: acmecorp.com
  - GSTIN: (empty — Rahul fills) 27AABCS1234D1Z5
  - State: Maharashtra (27)
```

### 7.2 Line Items Add

**Item 1: Workspace Plus**
- Item search → "Plus" → Google Workspace Plus
- Auto-fill:
  - HSN: 998313
  - Rate: ₹1,380/user/mo (annual)
- Qty: 25
- Commitment: 12 months
- Line total: 25 × ₹1,380 × 12 = ₹4,14,000

**Item 2: Voice Standard (Add-on)**
- 5 seats for CTO + CFO + 3 sales
- Rate: ₹800/user/mo
- Line total: 5 × ₹800 × 12 = ₹48,000

### 7.3 Discount Apply
- Rahul "Apply Discount" → 10% (sales team allowed)
- Subtotal: ₹4,62,000
- Discount: -₹46,200
- Taxable: ₹4,15,800

### 7.4 GST Auto-Calculate
```
Our state: Delhi (07)
Customer state: Maharashtra (27)
07 ≠ 27 → INTER-STATE → IGST applicable

IGST @ 18% of ₹4,15,800 = ₹74,844
```

### 7.5 Final Total
```
Subtotal:    ₹4,62,000
Discount:    -₹46,200
Taxable:     ₹4,15,800
IGST 18%:    ₹74,844
─────────────────────
TOTAL:       ₹4,90,644
```

### 7.6 Send
- "Send via Email + WhatsApp" click
- PDF auto-generate with Client A letterhead, GSTIN, T&Cs
- Email + WhatsApp message:
  ```
  Hi Rajesh,
  Aapka quotation #Q-2026-0042 attached hai.
  Total: ₹4,90,644 (incl. GST)
  Valid until: Day 44

  Pay online here: [Razorpay link]
  ```

**AUTO-FIRE:**
- Lead → "Quote Sent" stage
- Quote status: "Sent"
- Task: "Follow up if no response by Day 17"
- Activity timeline updated

**TIME:** 12 min total (vs 45 min manual)

---

## Step 8: Customer Reviews (Day 14-15)

**CUSTOMER SIDE:**
1. Rajesh email kholta — PDF download
2. CFO Suresh ke saath review
3. Quote link kholta in browser:
   ```
   https://portal.gw-pro.com/quote/Q-2026-0042
   ```
4. Sees beautifully designed quote page
5. Has 3 options:
   - ✅ Accept & Pay (via Razorpay)
   - 💬 Discuss/Modify (opens WhatsApp chat)
   - 📥 Download PDF

**NO SALES PRESSURE — customer decides own time.**

---

## Step 9: Customer Pays (Day 16, 4:30 PM)

**CUSTOMER ACTION:**
- "Accept & Pay" click
- Razorpay checkout opens (₹4,90,644)
- Card payment / UPI / NEFT
- Payment success

**BACKEND FLOW:**
```
1. Razorpay webhook fires:
   POST /api/razorpay/webhook
   {
     "event": "payment.captured",
     "payload": {
       "payment": {
         "id": "pay_NXyz123",
         "amount": 49064400,  // paisa
         "currency": "INR",
         "order_id": "order_Q-2026-0042"
       }
     }
   }

2. Webhook handler:
   a. Verify signature (security)
   b. Quote lookup: Q-2026-0042
   c. Quote.status = "accepted"
   d. Auto-create Invoice INV-2026-0089
   e. Auto-create Customer record (if not exists)
   f. Auto-create Subscription (active)
   g. Auto-trigger Zoho Books sync

3. Customer record auto-create:
   {
     "legalName": "Acme Corp Pvt Ltd",
     "primaryDomain": "acmecorp.com",
     "gstin": "27AABCS1234D1Z5",
     "billingAddress": {...},
     "primaryContact": {Rajesh details},
     "convertedFromLeadId": <lead-id>,
     "accountManagerId": <Rahul's UID>
   }

4. Subscription record:
   {
     "customerId": <new customer id>,
     "sku": "workspace_plus",
     "seats": 25,
     "billingCycle": "annual",
     "mrr": ₹34,500,
     "arr": ₹4,14,000,
     "startDate": Day 16,
     "endDate": Day 380 (1 year later),
     "autoRenew": true,
     "status": "active"
   }

5. Invoice record:
   {
     "invoiceNumber": "INV-2026-0089",
     "customerId": <id>,
     "amount": ₹4,90,644,
     "status": "paid",
     "paidDate": Day 16,
     "razorpayPaymentId": "pay_NXyz123"
   }

6. Zoho Books push:
   - Customer create/update in Zoho
   - Invoice push with full GST details
   - Payment record link
   - GSTR-1 ready data

7. Notifications fire:
   - Email to Rajesh: "Payment received ✓ + Invoice PDF attached"
   - WhatsApp to Rajesh: "Payment confirmed. Provisioning shuru."
   - WhatsApp to Rahul: "🎉 Acme Corp PAID ₹4,90,644!"
   - Push notification to owner (Pardeep): "₹4.9L deal closed"

8. Lead transition:
   - Lead.status → "closed_won"
   - Lead.convertedCustomerId = <customer id>
   - Lead card moves to "Won 🎉" column in Kanban
   - Activity timeline:
     "🎉 Deal closed! ₹4,90,644 paid via Razorpay"
```

**TIME:** 2 min customer effort, 8 seconds backend

---

## Step 10: Auto-Provisioning (Day 16, 4:32 PM — same minute!)

**TRIGGERED BY:** Invoice paid event

**WHAT HAPPENS:**
```
1. Trial → Paid conversion in Google API:
   PUT /workspace/v1/customers/C03az79cb/subscriptions/{id}/changePlan
   {
     "planName": "ANNUAL_YEARLY_PAY",
     "seats": 25
   }

2. Trial expiry removed → permanent subscription

3. License confirmation email sent to admin@acmecorp.com

4. Onboarding Wizard auto-launches for Rajesh:
   Step 1: DNS verification (MX, SPF, DKIM, DMARC)
   Step 2: Admin training resources
   Step 3: Migration completion check
   Step 4: Go-live confirmation

5. Customer Portal credentials emailed:
   "Aap login karein: portal.gw-pro.com/login
    Username: rajesh@acmecorp.com"
```

**TIME:** 30 seconds automated

---

## Step 11: Onboarding Complete (Day 17-20)

**CUSTOMER:** Rajesh portal kholta, onboarding wizard complete karta
**PROVISIONING TEAM:** Sneha K monitors checklist completion
**STATUS:** Customer marked "Active — Onboarded"

---

## 📊 Lead-to-Cash Summary

| Metric | Value |
|---|---|
| Days from lead → paid | **16 days** (vs industry avg 35-45) |
| Sales rep effort total | **3.5 hours** |
| Customer touch-points | 5 (call, demo, mid-check, quote, payment) |
| System automated tasks | 12 |
| Error rate | 0 (vs ~5% manual) |
| Deal value | **₹4,90,644** |
| MRR added | ₹34,500 |
| Owner notifications | 3 (lead → demo → won) |

---

# 2. Renewal Automation Workflow

> **Live Example:** Cosmo Tech ka renewal cycle (Plus, 12 seats, ₹16,560 MRR)

## 👤 Background

- **Customer:** Cosmo Tech
- **Subscription:** Google Workspace Plus, 12 seats
- **MRR:** ₹16,560
- **Start Date:** 21 May 2025
- **End Date:** 21 May 2026 (annual)
- **Auto-Renew:** ON
- **Account Manager:** Amit M

---

## Step 1: T-90 Days Alert (20 Feb 2026, 9:00 AM)

**TRIGGER:** Daily cron job runs at 9 AM IST
**CODE:**
```js
// functions/src/renewals.ts
export const checkRenewals = onSchedule(
  { schedule: 'every day 09:00', timeZone: 'Asia/Kolkata' },
  async () => {
    const target = addDays(new Date(), 90); // = 21 May 2026
    const subs = await firestore
      .collection('subscriptions')
      .where('status', '==', 'active')
      .where('endDate', '>=', startOfDay(target))
      .where('endDate', '<=', endOfDay(target))
      .get();

    // Cosmo Tech matches!
    for (const sub of subs.docs) {
      await sendT90Email(sub);
      await createTask(sub, 90);
    }
  }
);
```

**WHAT HAPPENS:**

### 1.1 Email to Customer (Auto)
**To:** rajeev@cosmotech.in
**Subject:** "Your Google Workspace renewal — 90 days away"
**Body:**
```
Hi Rajeev,

Your Google Workspace Plus subscription (12 seats) is up for
renewal on 21 May 2026.

Current rate: ₹1,380/user/mo (annual commitment)
Annual cost: ₹1,98,720 + GST

Want to upgrade, downgrade, or add seats?
👉 [Get Renewal Quote] [Talk to Amit]

— Client A
```

### 1.2 Task for Account Manager (Auto)
```
Task: "Cosmo Tech renewal — 90 days out"
Assigned to: Amit M
Due: 1 March 2026
Priority: Medium
Description: "Soft outreach. Check if any changes needed.
              Auto-renew is ON but confirm with customer."
```

### 1.3 Dashboard Update
- Renewals "Future" bucket me Cosmo Tech show ho
- ARR risk widget: +₹1,98,720

### 1.4 Activity Log
```
Type: system
Title: "T-90 renewal reminder sent"
Description: "Email sent to rajeev@cosmotech.in"
```

**TIME:** Auto, 0 human effort

---

## Step 2: T-60 Days (22 March 2026)

**SAME CRON,** but T-60 logic:

### 2.1 Auto-Generate Renewal Quote
```js
// Generate quote with same items, current year pricing
const renewalQuote = await createRenewalQuote(subscription);
```

**Quote #Q-2026-0089** auto-created with:
- Same items (Plus, 12 seats)
- New pricing if Google rates changed
- New period: 21 May 2026 → 20 May 2027
- Total: ₹1,98,720 + 18% IGST = ₹2,34,490

### 2.2 Email + WhatsApp
```
"Hi Rajeev,
Aapki renewal quote ready hai — 60 days remaining.
Q-2026-0089 attached.
Total: ₹2,34,490 (incl. GST)

Renewal pay karne ke liye yahan click:
[Pay Now] [Discuss with Amit]"
```

### 2.3 Task Update
```
Task: "Cosmo Tech renewal — 60 days"
Priority: High (escalated)
Status: Pending follow-up
```

**TIME:** Auto + Amit reviews quote (5 min)

---

## Step 3: T-30 Days (21 April 2026)

**ESCALATION — Multi-Channel Push**

### 3.1 WhatsApp Message (Auto)
```
"नमस्ते राजीव जी,
आपकी Google Workspace renewal में सिर्फ 30 दिन बचे हैं।

Quote: ₹2,34,490 (incl. GST)

Pay now to avoid service disruption:
👉 https://portal.gw-pro.com/q/Q-2026-0089

— Client A"
```

### 3.2 Phone Call Task — URGENT
```
Task: "📞 Call Cosmo Tech — renewal in 30 days"
Assigned to: Amit M
Priority: HIGH (red)
Due: TODAY (21 April)
```

### 3.3 Owner Alert
Pardeep ka dashboard pe red banner:
```
⚠️ ₹16,560 MRR at risk — Cosmo Tech renewal in 30 days
[View Customer] [Call Amit]
```

### 3.4 Amit Action
Amit calls Rajeev:
```
Rajeev: "Haan haan dekh raha hu, payment kar denge."
Outcome: Soft commitment
Log activity: "Call done. Customer committed payment by Day 24."
Update task: "Recheck Day 24 if no payment"
```

**TIME:** 15 min call

---

## Step 4: T-7 Days (14 May 2026)

**URGENT — Last Chance Push**

### 4.1 Dashboard URGENT
```
🔴 CRITICAL: Cosmo Tech renewal in 7 DAYS — Service WILL stop
Action: Amit, call immediately
```

### 4.2 Daily WhatsApp Reminders
T-7, T-5, T-3, T-2, T-1 — daily WhatsApp until paid:
```
"Sir, sirf 7 din baad service band ho jayegi.
Quick payment yahan karein: [Pay Link]"
```

### 4.3 Amit Calls Again — Day 17 May (T-4)
Customer pays via Razorpay link!

---

## Step 5: Payment Received (17 May 2026)

**SAME FLOW AS LEAD-TO-CASH STEP 9** — auto-everything:

```
1. Razorpay webhook → Invoice marked paid
2. Subscription extended:
   - Old endDate: 21 May 2026 → DELETED
   - New endDate: 20 May 2027
   - New invoice: INV-2026-0156
   - Renewal record: "Year 2 of subscription"

3. Cycle increment:
   {
     "parentSubscriptionId": <original sub id>,
     "cycleNumber": 2,
     "totalCycles": "ongoing",
     "isRenewal": true
   }

4. Activity log:
   "🎉 Renewed! Cosmo Tech extended for 1 year. ₹2,34,490 collected."

5. Customer email + WhatsApp:
   "Thanks for renewing! Your service continues uninterrupted."

6. Internal celebration:
   - Pardeep dashboard: ARR retained
   - Amit gets renewal commission credit
   - Renewal rate metric updated
```

---

## 📊 Renewal Workflow Summary

| Stage | Time before expiry | Action | Channel |
|---|---|---|---|
| T-90 | 90 days | Soft email + Task | Email |
| T-60 | 60 days | Auto-quote + Email + WhatsApp | Email + WhatsApp |
| T-30 | 30 days | WhatsApp + Phone task | Multi-channel |
| T-7 | 7 days | URGENT alerts + Daily WhatsApp | Critical |
| T-1 to T-0 | Final | Service suspension warning | Critical |
| Post-pay | N/A | Confirmation + Service continue | Email + WhatsApp |

**Without ResellerOS:** 30% renewals slip (industry avg)
**With ResellerOS:** 90%+ renewal rate

---

# 3. Payment + GST + Zoho Sync Workflow

> **Live Example:** Delta Pvt Ltd ka invoice — 50 seats Plus annual

## 👤 Background

- **Customer:** Delta Pvt Ltd
- **Subscription:** Workspace Plus, 50 seats
- **State:** Delhi (07) — same state as Client A
- **GSTIN:** 07AABCD1234D1Z5
- **Annual amount:** ₹8,28,000 + GST

---

## Step 1: Invoice Generation Trigger (12 May 2026, midnight)

**TRIGGER:** Subscription billing cycle reached annual mark
**OR:** Quote accepted by customer

**CODE:**
```js
// On quote acceptance OR scheduled billing cycle
async function generateInvoice(subscriptionId) {
  const sub = await firestore.collection('subscriptions').doc(subscriptionId).get();
  const customer = await firestore.collection('customers').doc(sub.customerId).get();

  // Build line items
  const items = [{
    description: "Google Workspace Plus — Annual",
    hsn: "998313",
    quantity: 50,
    rate: 1380,
    durationMonths: 12,
    amount: 50 * 1380 * 12  // = ₹8,28,000
  }];

  // ... GST calculation (Step 2)
  // ... Save invoice (Step 3)
  // ... Zoho sync (Step 4)
}
```

---

## Step 2: GST Calculation (Auto)

**LOGIC:**
```js
function calculateGST(amount, buyerState, sellerState, rate = 18) {
  const totalTax = (amount * rate) / 100;

  if (buyerState === sellerState) {
    // SAME STATE → CGST + SGST
    return {
      cgst: totalTax / 2,  // 9%
      sgst: totalTax / 2,  // 9%
      igst: 0,
      taxableAmount: amount,
      total: amount + totalTax
    };
  } else {
    // DIFFERENT STATE → IGST
    return {
      cgst: 0,
      sgst: 0,
      igst: totalTax,      // 18%
      taxableAmount: amount,
      total: amount + totalTax
    };
  }
}
```

**DELTA CASE:**
```
Delta state: Delhi (07)
Our state:   Delhi (07)
SAME → CGST + SGST applicable

Subtotal:      ₹8,28,000
CGST (9%):     ₹74,520
SGST (9%):     ₹74,520
─────────────────────
TOTAL:         ₹9,77,040
```

**COMPARE WITH ACME CORP** (Maharashtra):
```
Acme state: Maharashtra (27)
Our state:  Delhi (07)
DIFFERENT → IGST applicable

Subtotal:      ₹4,15,800
IGST (18%):    ₹74,844
─────────────────────
TOTAL:         ₹4,90,644
```

**KEY POINT:** Customer state se decide hota hai, automatic.

---

## Step 3: Invoice Record Created

```js
const invoice = {
  invoiceNumber: "INV-2026-0086",
  customerId: <Delta's id>,
  subscriptionId: <sub id>,

  lineItems: [{
    description: "Google Workspace Plus — Annual",
    hsn: "998313",
    quantity: 50,
    rate: 1380,
    durationMonths: 12,
    amount: 828000
  }],

  subtotal: 828000,
  discount: 0,
  taxableAmount: 828000,
  cgst: 74520,
  sgst: 74520,
  igst: 0,
  total: 977040,

  issueDate: "2026-05-12",
  dueDate: "2026-05-30",  // Net 18 days
  status: "sent",

  paymentLink: "https://razorpay.me/pay/inv-2026-0086"
};

await firestore.collection('invoices').doc(invoice.invoiceNumber).set(invoice);
```

**PDF AUTO-GENERATED:**
- Client A letterhead
- GSTIN: 07AABCE1234D1Z9
- Bill To: Delta Pvt Ltd + GSTIN: 07AABCD1234D1Z5
- Line items with HSN codes
- CGST + SGST breakdown
- Bank details for offline payment
- Razorpay QR + pay link

---

## Step 4: Send to Customer (Auto)

**EMAIL:**
```
To: accounts@deltapvt.com
Subject: Invoice INV-2026-0086 — ₹9,77,040
Attachments: INV-2026-0086.pdf

Hi Team,
Your invoice for Google Workspace Plus renewal is attached.

Amount: ₹9,77,040 (incl. CGST + SGST @ 9% each)
Due: 30 May 2026 (Net 18 days)

Pay online: [Razorpay link]
Pay via NEFT: HDFC Bank A/c 50100xxxxxxxxx

— Client A
```

**WHATSAPP:**
```
"Sir, Delta Pvt Ltd ka invoice ₹9,77,040 send kiya hai.
Razorpay pe pay karne ke liye: [link]
Due: 30 May"
```

---

## Step 5: Razorpay Payment (15 May 2026, 11:30 AM)

**CUSTOMER FLOW:**
1. Email me Razorpay link click
2. Razorpay page: amount, INR
3. Pay with:
   - Card / UPI / Netbanking / NEFT
4. Customer chose: HDFC Net Banking
5. ₹9,77,040 paid

**RAZORPAY WEBHOOK:**
```http
POST https://api.gw-pro.com/api/razorpay/webhook
X-Razorpay-Signature: abc123...

{
  "event": "payment.captured",
  "payload": {
    "payment": {
      "entity": "payment",
      "id": "pay_Pq8vKb12345",
      "amount": 97704000,  // paisa
      "currency": "INR",
      "status": "captured",
      "order_id": "order_INV-2026-0086",
      "method": "netbanking",
      "bank": "HDFC",
      "fee": 21494,  // ₹214.94 Razorpay fee (2%+18% GST)
      "tax": 3279,
      "captured": true,
      "created_at": 1747318200
    }
  }
}
```

**WEBHOOK HANDLER:**
```js
// /api/razorpay/webhook
export async function POST(req: Request) {
  const signature = req.headers.get('x-razorpay-signature');
  const body = await req.text();

  // 1. VERIFY SIGNATURE (security)
  const expectedSig = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  if (signature !== expectedSig) {
    return new Response('Invalid signature', { status: 400 });
  }

  const event = JSON.parse(body);

  // 2. EXTRACT INVOICE
  const invoiceNumber = event.payload.payment.order_id.replace('order_', '');
  const invoiceRef = firestore.collection('invoices').doc(invoiceNumber);

  // 3. UPDATE INVOICE
  await invoiceRef.update({
    status: 'paid',
    paidDate: new Date(),
    amountPaid: event.payload.payment.amount / 100,
    paymentMode: 'razorpay',
    razorpayPaymentId: event.payload.payment.id,
    paymentMethod: event.payload.payment.method
  });

  // 4. RECORD PAYMENT
  await firestore.collection('payments').add({
    invoiceId: invoiceNumber,
    amount: event.payload.payment.amount / 100,
    razorpayFee: event.payload.payment.fee / 100,
    netAmount: (event.payload.payment.amount - event.payload.payment.fee) / 100,
    method: 'razorpay',
    razorpayId: event.payload.payment.id,
    paidAt: new Date()
  });

  // 5. ZOHO BOOKS SYNC (Step 6 below)
  await syncInvoiceToZoho(invoiceNumber);

  // 6. NOTIFICATIONS
  await notifyPaymentReceived(invoiceNumber);

  return new Response('OK');
}
```

---

## Step 6: Zoho Books Sync (Auto)

**FLOW:**
```js
async function syncInvoiceToZoho(invoiceNumber) {
  const invoice = await getInvoice(invoiceNumber);
  const customer = await getCustomer(invoice.customerId);

  // Step 6.1: Ensure customer exists in Zoho
  let zohoCustomerId = customer.zohoCustomerId;
  if (!zohoCustomerId) {
    const zohoCust = await zoho.contacts.create({
      contact_name: customer.legalName,
      company_name: customer.legalName,
      gst_no: customer.gstin,
      gst_treatment: "business_gst",
      place_of_contact: customer.stateCode,
      billing_address: customer.billingAddress,
      contact_persons: [{
        first_name: customer.primaryContact.name,
        email: customer.primaryContact.email,
        phone: customer.primaryContact.phone
      }]
    });
    zohoCustomerId = zohoCust.contact_id;
    await updateCustomer(customer.id, { zohoCustomerId });
  }

  // Step 6.2: Push invoice to Zoho
  const zohoInvoice = await zoho.invoices.create({
    customer_id: zohoCustomerId,
    invoice_number: invoice.invoiceNumber,
    date: invoice.issueDate,
    due_date: invoice.dueDate,
    line_items: invoice.lineItems.map(item => ({
      name: item.description,
      hsn_or_sac: item.hsn,
      quantity: item.quantity,
      rate: item.rate * item.durationMonths,
      tax_id: "default_18_intra"  // 18% intra-state
    })),
    notes: `Auto-synced from ResellerOS. Original ID: ${invoiceNumber}`
  });

  // Step 6.3: Mark as paid in Zoho
  await zoho.invoices.recordPayment(zohoInvoice.invoice_id, {
    amount: invoice.total,
    date: invoice.paidDate,
    payment_mode: "Razorpay",
    reference_number: invoice.razorpayPaymentId,
    bank_charges: invoice.razorpayFee
  });

  // Step 6.4: Update our DB with Zoho IDs
  await firestore.collection('invoices').doc(invoiceNumber).update({
    zohoInvoiceId: zohoInvoice.invoice_id,
    zohoInvoiceNumber: zohoInvoice.invoice_number,
    zohoSyncedAt: new Date()
  });
}
```

**ZOHO ME KYA HOTA HAI:**
- Invoice automatically appear ho with GST breakup
- Customer ledger update
- GSTR-1 ready data (CGST + SGST split)
- Bank reconciliation matched with Razorpay

**TIME:** 3 seconds entire flow

---

## Step 7: Notifications Fire

```
1. Customer email:
   "Payment received ✓ — Invoice INV-2026-0086 paid
    Receipt PDF attached. Thank you!"

2. Customer WhatsApp:
   "✅ Payment confirmed. Your subscription continues."

3. Finance team Slack:
   "💰 ₹9,77,040 received from Delta Pvt Ltd"

4. Pardeep dashboard:
   - MRR widget: no change (renewal)
   - "Today's collections" widget: +₹9,77,040
```

---

## Step 8: GSTR-1 Filing Ready

**END OF MONTH:** Pardeep exports GSTR-1 from Zoho:
```
B2B Invoices:
- Delta Pvt Ltd (GSTIN 07AABCD1234D1Z5):
  Invoice INV-2026-0086, Date 12/05/2026
  Taxable: ₹8,28,000 | CGST: ₹74,520 | SGST: ₹74,520 | Total: ₹9,77,040
- Acme Corp (GSTIN 27AABCS1234D1Z5):
  Invoice INV-2026-0089, Date 16/05/2026
  Taxable: ₹4,15,800 | IGST: ₹74,844 | Total: ₹4,90,644
- ... (more)
```

CSV/JSON upload directly to GSTN portal.

---

## 📊 Payment + GST + Zoho Summary

| Step | Manual Time | Automated Time |
|---|---|---|
| Invoice generation | 15 min | Auto (0 sec) |
| GST calculation | 5 min + error risk | Auto (0 sec) |
| PDF creation | 10 min | Auto (2 sec) |
| Email send | 5 min | Auto (1 sec) |
| Razorpay setup | N/A | Auto link |
| Webhook handling | 10 min check | Auto (3 sec) |
| Zoho sync | 15 min manual entry | Auto (3 sec) |
| Bank reconciliation | 15 min | Auto |
| GSTR-1 prep | 1 day/month | Auto export |
| **TOTAL per invoice** | **~75 min** | **~10 sec** |

**Monthly savings (100 invoices):** 125 hours → 17 minutes

---

# 4. Support Ticket Lifecycle Workflow

> **Live Example:** Echo Pharma ka email delivery issue ticket

## 👤 Background

- **Customer:** Echo Pharma
- **Subscription:** Enterprise (80 seats)
- **Tier:** Premium support (24×7, 4 hr SLA)
- **Account Manager:** Priya R

---

## Step 1: Ticket Created (Day 1, 10:15 AM)

**HOW IT CAME IN:** 3 channels possible

### Channel A: Customer Portal
1. CTO (Vikram) logs into portal.gw-pro.com
2. "Raise Ticket" click
3. Form:
   ```
   Subject: "Email not sending to external domains"
   Description: "Since this morning, our team can send emails
                 only to other @echopharma.in users. External
                 emails (gmail.com, yahoo.com) bounce back."
   Priority: Urgent
   Affected users: All 80
   ```
4. Submit

### Channel B: Email
- Vikram sends email to support@excelt.in
- Email parser extracts → creates ticket
- Customer matched by sender domain

### Channel C: WhatsApp
- Vikram WhatsApps support number
- Bot detects keywords (email, bounce, not sending)
- Auto-create ticket OR escalate to human

**RESULT (regardless of channel):**
```js
const ticket = {
  ticketNumber: "TKT-2026-0143",
  customerId: <Echo Pharma id>,
  subject: "Email not sending to external domains",
  description: "...",
  priority: "urgent",
  category: "email_delivery",
  channel: "portal",
  status: "open",
  affectedSeats: 80,
  createdBy: "vikram@echopharma.in",
  createdAt: <timestamp>,

  // SLA auto-calculated:
  slaResponseDue: createdAt + 4 hours,    // Premium tier
  slaResolutionDue: createdAt + 24 hours,
  isPremium: true
};
```

---

## Step 2: Auto-Routing (Day 1, 10:15:30 AM)

**RULES ENGINE:**
```js
// Priority + category routes to specific person
if (ticket.priority === 'urgent' && ticket.category === 'email_delivery') {
  ticket.assignedTo = "priya@excelt.in";  // Specialist
  ticket.escalatedTo = "pardeep@excelt.in";  // Owner CC
}

// Premium tier → immediate alerts
if (customer.supportTier === 'premium') {
  await sendWhatsApp(priya, `🚨 URGENT: ${ticket.ticketNumber} — Echo Pharma`);
  await sendPush(priya, ticket);
}
```

**WHAT FIRES:**
1. WhatsApp to Priya: "Urgent ticket from Echo Pharma — 80 users affected"
2. Email to Priya with full context
3. Push notification on Priya's phone
4. Pardeep CC'd (premium customer)
5. Auto-reply to Vikram:
   ```
   "Hi Vikram,
   Ticket #TKT-2026-0143 received.
   Priya R will respond within 4 hours.

   For urgent issues, call +91 99999 99999."
   ```

---

## Step 3: First Response (Day 1, 10:25 AM — 10 min later!)

**PRIYA ACTION:**
1. Phone notification dekhi, immediate
2. Customer 360° for Echo Pharma open
3. Sees: Enterprise customer, premium tier, 80 seats, no recent issues

**INITIAL DIAGNOSIS:**
- Check Google Admin SDK: Echo Pharma's SPF/DKIM
- Run: `dig TXT echopharma.in`
- Find: SPF record was modified yesterday by their IT

**PRIYA REPLIES (within 10 min):**
```
"Hi Vikram,

I see this is an SPF/DKIM authentication issue. Looks like
your SPF record was modified yesterday and is now too strict.

Specifically: include:mail.echopharma.in is conflicting with
include:_spf.google.com

Can I jump on a 10-min Google Meet to fix this?
[Meet Link]

— Priya R, Client A"
```

**ACTIVITY LOG:**
```
Type: ticket_reply
Time to first response: 10 minutes ✓ (SLA was 4 hours)
Status: in_progress
```

---

## Step 4: Resolution Call (Day 1, 11:00 AM)

**ACTION:**
- 15-min Google Meet
- Priya screen-shares with Vikram's IT
- Together fix SPF record:
  ```
  Old: v=spf1 include:mail.echopharma.in -all
  New: v=spf1 include:_spf.google.com include:mail.echopharma.in -all
  ```
- DNS propagation: 5-10 min wait
- Test email: external send works ✓

**ACTIVITY LOG:**
```
Type: ticket_call
Duration: 15 min
Outcome: Resolved
Notes: "Fixed SPF record. Both Google + their MTA included.
        Tested external send — working. Recommended DKIM review next."
```

---

## Step 5: Verification (Day 1, 11:30 AM)

**PRIYA:**
- Asks Vikram to test 5 emails
- All succeed
- Update ticket:
  ```
  Status: resolved
  Resolution: "SPF record corrected. Issue fully resolved.
               Customer confirmed external email delivery working."
  Resolution time: 1 hour 15 min ✓ (SLA was 24 hours)
  ```

**AUTO-FIRE:**
- Customer email with resolution summary
- WhatsApp to Vikram: "✅ TKT-2026-0143 resolved. Email delivery working."
- CSAT survey sent (auto after resolution)
- KB article auto-suggested: "Want to publish this as KB article?"

---

## Step 6: Customer CSAT (Day 1, 4:00 PM)

**CUSTOMER GETS:**
```
"Hi Vikram,

Your ticket TKT-2026-0143 was resolved by Priya R.

How was your support experience?
[1 - Poor] [2] [3] [4] [5 - Excellent]

Any feedback?
[textbox]"
```

**VIKRAM RATES:**
- Score: 5 (Excellent)
- Comment: "Priya was very fast. Within 10 min she identified the issue. Top class support."

**SYSTEM:**
- CSAT recorded
- Priya's CSAT average: 4.8 (excellent)
- Pardeep dashboard: CSAT widget +1
- Activity log updated

---

## Step 7: KB Article Auto-Created (Day 2)

**SUGGESTION:**
```
"This resolution could help other customers.
Convert to KB article?
[Yes, draft article] [No, skip]"
```

**PRIYA CLICKS YES:**
- AI auto-drafts article: "Fixing SPF Record Conflicts with Google Workspace"
- Priya reviews, edits 10 min
- Publish to KB

**RESULT:**
- Future tickets with same issue → KB suggestion shown to customer first
- Self-service ratio increases over time

---

## Step 8: Internal Review (End of Week)

**TICKETS DASHBOARD:**
```
Week's tickets:
- Total: 23
- Avg first response: 1h 45m (SLA 4h ✓)
- Avg resolution: 6h 30m (SLA 24h ✓)
- SLA breached: 0
- CSAT average: 4.7/5
- Most issues: Email delivery (8), DNS (5), User access (4)
```

**PARDEEP REVIEWS:**
- Trending issues this month
- Reps performance
- KB article impact

---

## 📊 Support Workflow Summary

| Stage | Time | Auto/Manual |
|---|---|---|
| Ticket creation | 30 sec | Auto-routed |
| First response | 10 min | Manual (urgent) |
| Diagnosis | 15 min | Manual |
| Resolution | 1 hr 15 min | Manual + tools |
| Customer notification | Instant | Auto |
| CSAT survey | After resolution | Auto |
| KB article creation | 10 min | AI-assisted |
| Internal review | Weekly | Dashboard |

**Without ResellerOS:**
- Email-based tickets, no SLA tracking
- 24-48 hr avg response
- Lost emails, repeat questions
- No CSAT tracking

**With ResellerOS:**
- Multi-channel (Portal + Email + WhatsApp)
- Auto-SLA + alerts
- 2-4 hr response
- CSAT 4.7/5 average

---

# 5. Customer Onboarding Workflow

> **Live Example:** TechBrand Pvt Ltd ka 48-hour onboarding

## 👤 Background

- **Customer:** TechBrand Pvt Ltd (just closed-won)
- **Subscription:** Workspace Standard, 25 seats
- **Current:** Migrating from Microsoft 365
- **Domain:** techbrand.in
- **Admin contact:** Sunil (IT Head)

---

## Step 1: Trigger (Hour 0 — Payment Received)

**Razorpay webhook → triggers onboarding workflow**

```js
async function startOnboarding(customerId) {
  const onboarding = {
    customerId,
    status: "in_progress",
    checklist: {
      paymentVerified: { done: true, completedAt: new Date() },
      provisioningDone: { done: false },
      mxRecordsSet: { done: false },
      mxRecordsVerified: { done: false },
      spfRecordSet: { done: false },
      spfRecordVerified: { done: false },
      dkimEnabled: { done: false },
      dmarcRecordSet: { done: false },
      domainVerified: { done: false },
      adminAccountCreated: { done: false },
      adminTrainingScheduled: { done: false },
      migrationStarted: { done: false },
      migrationCompleted: { done: false },
      goLiveConfirmed: { done: false }
    },
    sla: addHours(new Date(), 48),  // 48-hour onboarding target
    assignedTo: "sneha@excelt.in",  // Provisioning engineer
    accountManagerId: "amit@excelt.in"
  };

  await firestore.collection('onboarding').add(onboarding);

  // Notify provisioning team
  await sendWhatsApp(sneha, "🎉 New customer onboarding: TechBrand (25 seats)");
}
```

---

## Step 2: Auto-Provisioning (Hour 0:30)

**Google Reseller API:**
```js
// Already done as part of payment flow
// License = active, seats = 25, account = techbrand.in
```

**RESULT:**
- ✓ Google Workspace account active
- ✓ Admin credentials generated (admin@techbrand.in)
- Email to Sunil with login details

---

## Step 3: Welcome Call (Hour 2)

**SNEHA:**
- Calls Sunil within 2 hours
- "Hi Sunil, congratulations! Let me walk you through onboarding."
- Sends WhatsApp link to Customer Portal
- Sunil logs in → Onboarding Wizard shows

---

## Step 4: Onboarding Wizard (Hour 2-4)

**Sunil sees Wizard with 4 steps:**

### Step 4.1 — Domain Verification
**UI shows:**
```
Add this TXT record to your domain:

google-site-verification=abc123xyz...

Once added, click "Verify"
```

**Sunil:**
- GoDaddy panel khola
- TXT record added
- "Verify" click

**System:**
```js
await dns.resolveTxt('techbrand.in');
// Check if google-site-verification record exists
// If yes: onboarding.checklist.domainVerified.done = true
```

✓ Verified

### Step 4.2 — MX Records
**UI shows:**
```
Replace existing MX records with these:

Priority 1: aspmx.l.google.com
Priority 5: alt1.aspmx.l.google.com
Priority 5: alt2.aspmx.l.google.com
Priority 10: alt3.aspmx.l.google.com
Priority 10: alt4.aspmx.l.google.com
```

**Sunil:**
- GoDaddy MX records replaced
- Click "Verify MX"

**System:**
- DNS check every 5 min
- Once propagated: ✓ Verified

### Step 4.3 — SPF Record
```
Add this TXT record:
v=spf1 include:_spf.google.com ~all
```
✓ Verified

### Step 4.4 — DKIM
```
Generate DKIM key in Google Admin
Add this TXT record:
google._domainkey.techbrand.in → [generated key]
```
✓ Verified

### Step 4.5 — DMARC (Optional but Recommended)
```
Add this TXT record:
_dmarc.techbrand.in → v=DMARC1; p=quarantine; rua=mailto:dmarc@techbrand.in
```
✓ Verified

---

## Step 5: Migration Started (Hour 6)

**Sneha starts data migration:**
- Microsoft 365 → Google Workspace
- Tools: Google Workspace Migrate
- 800 GB of mail + drive data
- Estimated: 24 hours

**Customer Portal shows:**
```
Migration Status: In Progress
Progress: 22% (175 GB / 800 GB)
ETA: 18 hours remaining
[View Details]
```

---

## Step 6: User Training (Hour 12)

**Sneha conducts:**
- 1-hour Google Meet
- 5 attendees (Sunil + IT team)
- Topics:
  - Admin Console basics
  - User management
  - Security best practices
  - Common policies

**Recording shared** in Customer Portal for future reference.

---

## Step 7: Migration Complete (Hour 30)

**System:**
```js
// Auto-detect migration done
if (migrationProgress === 100) {
  await updateOnboarding({
    'checklist.migrationCompleted.done': true
  });

  // Notify
  await sendEmail(customer, "Migration complete!");
  await sendWhatsApp(customer, "✅ All 800 GB migrated to Google Workspace");

  // Trigger go-live check
  await sendEmail(sneha, "TechBrand migration done. Confirm go-live readiness.");
}
```

---

## Step 8: Go-Live (Hour 36)

**SNEHA + SUNIL:**
- Final verification call (30 min)
- Email send test (all 25 users)
- Drive sharing test
- Calendar sync test
- Mobile app test

**ALL PASS:**
```
Onboarding Status: COMPLETE ✓
Total Time: 36 hours (under 48-hour SLA)
```

**HANDOFF:**
- Sneha → Amit (Account Manager) takes over
- Customer status: "Active — Onboarded"
- Welcome bonus: 1-month free support extension

---

## Step 9: Post-Onboarding Check (Day 7)

**AUTO-TASK fires for Amit:**
"Check in with TechBrand — 1 week post-go-live"

**Amit calls Sunil:**
- Any issues?
- Training needed for new users?
- Feedback?

**CSAT survey sent:**
- Score: 5/5
- "Excellent migration experience. Sneha was very helpful."

---

## 📊 Onboarding Summary

| Phase | Time | Status |
|---|---|---|
| Payment → Provisioning | 0:30 hr | Auto |
| Welcome call | 2 hr | Manual |
| DNS setup wizard | 2 hr | Customer + auto-verify |
| Migration started | 6 hr | Manual + auto |
| Training | 12 hr | Manual |
| Migration complete | 30 hr | Auto |
| Go-live | 36 hr | Manual verify |
| 1-week check | 7 days | Auto-task |

**Without ResellerOS:** 5-7 days, multiple emails, errors common
**With ResellerOS:** 36-48 hours, guided wizard, zero errors

---

# 📋 Cross-Cutting Patterns

## Pattern 1: Multi-Channel Communication

Every customer touchpoint uses **multiple channels**:
- Email (primary)
- WhatsApp (urgent + Indian preference)
- Portal notification (in-app)
- Phone (high priority)
- SMS (fallback)

System picks **right channel** based on:
- Customer preference setting
- Issue priority
- Customer tier (premium gets more channels)

## Pattern 2: Audit Trail Everywhere

Every action logged with:
- Who did it (user ID)
- When (timestamp)
- What (action type)
- Why (notes)
- Result (outcome)

→ Complete activity timeline visible on Customer 360°

## Pattern 3: Automation + Human Hybrid

System NEVER fully automates customer interactions. Pattern:
- Auto-prepare (system gathers data, creates draft)
- Human review (sales/support adds personalization)
- Auto-send (after human approves)
- Auto-track (response, outcome)

→ Best of both: efficiency + personalization

## Pattern 4: SLA Everywhere

Every critical workflow has SLA:
- Lead response: 1 hour
- Quote turnaround: same day
- Support first response: 4 hr (premium) / 24 hr (basic)
- Onboarding: 48 hours
- Renewal: T-90/60/30/7 alerts

SLA breach → escalation chain triggers automatically.

---

# 🎯 Bottom Line

**Without ResellerOS:**
- 30+ hours/week wasted on data shuffling
- 15-20% revenue loss from missed renewals
- 5-8 errors/month in GST/invoicing
- 24-48 hr support response
- 5-7 day customer onboarding

**With ResellerOS:**
- 5 hours/week on data (83% reduction)
- 90%+ renewal rate (vs 70-80%)
- 0-1 error/month (90% reduction)
- 2-4 hr support response (85% faster)
- 36-48 hr onboarding (70% faster)

**ROI:** Pehla customer 3-4 months me payback. Year 1 me 2x revenue.

---

**End of Workflows Document**

*Yeh document har 4-6 mahine update karein as workflows evolve. Customer feedback ke basis pe new patterns add karein.*
