# Customer Portal — scope and design (S10, R-049, R-107)

_Written 7 Oct 2026. Research only: no code, DB or commit changes were made for this doc._

> **Short version (Hinglish)**
> 1. Customer portal pehle se bana tha (OTP login, invoices, pay, seats, tickets) aur 19 Sep ko delete kiya gaya ("DMS owns the customer"). Pura code `git show 61d3b4bd^` me hai, aur DB side (customer_users + RLS) abhi bhi live hai.
> 2. Pawan ki branch (151 commits, 8–18 Sep) zyada-tar hosting/domains portal hai, jo ab DMS ka kaam hai. Use merge mat karo. Sirf design ideas lo, phir branch archive karo.
> 3. Phase 1: email OTP login, invoices + PDF, UPI/Razorpay se pay, subscriptions read-only. Pehle 3 security cards, phir 7 build cards (~10 worker-cards).
> 4. Login kholne se pehle 2 data leaks band karne hain. Customer abhi `tenants` row (attendance key bhi) aur quote ka `total_cost` (aapka margin) padh sakta hai.
> 5. Aapka bada decision: portal ResellerOS me ho ya DMS panel me (meri salah: ResellerOS `/portal`, DMS se SSO link). Baaki decisions §5 me hain.

---

## 1. What customers need (top 8 jobs, ranked)

Customers are small Indian businesses: one owner or office manager, usually on a phone, who wants
to pay and get the GST invoice without calling us.

| # | Job | Why it ranks here |
|---|-----|-------------------|
| 1 | **See and download invoices** (GST PDF) | Their CA asks for them every month. This is the most common "please send again" call. |
| 2 | **Pay dues** by UPI QR, UPI intent or Razorpay (card/netbanking) | This is how we get paid faster. Every invoice should have one "Pay ₹X" button. |
| 3 | **See subscriptions**: plan, seats bought vs used, renewal date, auto-renew on/off | This stops the "kab renew hoga / kitne users hain" calls. |
| 4 | **Request a seat change** (add or remove users) | This is upsell revenue. Today it comes in over WhatsApp and is easy to miss. |
| 5 | **Raise and follow a support ticket** | It gives us one queue instead of personal phones. Tickets and CSAT already exist on the staff side. |
| 6 | **Update GSTIN / billing name / address / billing email** | A wrong GSTIN means a wrong invoice and a lost ITC claim for them. It must go through a check. |
| 7 | **Download receipts and upload TDS certificates (Form 16A)** | Businesses that deduct TDS need to send us the certificate. We need it to claim the credit. |
| 8 | **See quotes and accept them** | This already works by link (`/quote/[id]/accept?t=`). The portal only needs to list quotes and open that same page. |

## 2. What already exists

### 2a. Live in the current code (branch `manager-pardeep`)

**Database (customer side is already built and live):**
- `customer_users` table (tenant_id, customer_id, auth_user_id UNIQUE, email, role, last_login_at) is defined in `production/supabase/baseline.sql` (around line 6881).
- `current_customer_id()` is a SECURITY DEFINER function that returns the customer for `auth.uid()` (baseline.sql:1139).
- These customer read policies are already on the tables: `customers_select_self_customer`, `invoices_select_own_customer`, `payments_select_own_customer`, `quotes_select_own_customer`, `subscriptions_select_own_customer`, `support_tickets_select/insert_own_customer`, `tenants_select_own_customer` (baseline.sql:12040–12977).
- These portal RPCs exist: `portal_customer_exists`, `portal_ensure_customer_link`, `portal_list_products`, `portal_request_quote`, `portal_touch_login`, plus `set_subscription_auto_renew`.
- Activity feed: `supabase/migrations/20260930200001_activity_log_customer_actor.sql` (R-016). When a customer makes a change, the feed shows "Customer <name>" instead of breaking the trigger.
- Other related tables: `seat_requests` (`20260816150000_seat_requests.sql`), `payment_mandates` (`20260817090000_payment_mandates.sql`), `customer_contacts` (one contact can serve many customers, `20260918090000_contact_serves_many_customers.sql`), `tds_receivable`, and `support_ticket_ratings` (CSAT, already uses `current_customer_id()`).
- Test: `supabase/tests/portal_customer_users_no_self_update.test.sql`.

**Public customer pages and money routes that work today:**
- Quote accept page: `src/app/(public)/quote/[id]/accept/` (page, `quote-accept-view.tsx`, `accepted-pay.ts`). It uses a token, strips cost before showing the quote, and has a Razorpay gate.
- Short quote link: `src/app/(public)/quote/view/[token]/page.tsx` just redirects to the accept page, so there is still only one page.
- Pay a quote: `src/app/api/public/quote/[id]/pay/route.ts` creates a Razorpay order. The `/api/webhooks/razorpay` webhook then settles it with `record_payment`. The shared guards are in `src/lib/checkout/quote-order.ts`.
- UPI "I've paid": `src/app/api/public/quote/[id]/upi-notify/route.ts` only emails staff and never records a payment. Keep this rule.
- UPI QR on the PDF comes from `src/lib/pdf/upi-qr.ts`, using the tenant's `upi_vpa` and `upi_payee_name`.
- PDFs: `src/lib/pdf/InvoicePDF.tsx`, `QuotePDF.tsx` and `ReceiptVoucherPDF.tsx`. Signed links that expire after 30 days come from `src/lib/pdf/pdf-token.ts` (S20) and are served at `/api/v1/documents/{invoice|quote}/[id]/pdf`.
- Amount due: `src/lib/payments/amount-due.ts`. Seat-change pricing: `src/lib/subscriptions/seat-request.ts`.

**The DMS panel (separate repo, the hosting/domains customer panel):**
- `src/app/api/dms/*` (panel-order, renewal-order, sso, upgrade-request…) and `/api/v1/customers/[id]/{invoices,payments,quotes,subscriptions}` are the endpoints DMS calls with a panel/API key and an email match (`lib/api/v1-email-match.ts`). The DMS panel already reads ResellerOS invoices and pays hosting/domain renewals this way.
- The marketing site's "Log in to the Customer Portal" button opens **DMS's** login (`CLIENT_AREA_URL` in `src/site/lib/config.ts`, built from `NEXT_PUBLIC_DMS_PORTAL_URL`).

**What is missing:** there is no `/portal` route group. `production/CLAUDE.md` §7 says it was deleted on 19 Sep. A Workspace/M365/Zoho customer has **no self-service at all** today. Note: `docs/LIFECYCLE-AUDIT.md` "Stage 9 — Customer portal ✅ built" is out of date.

### 2b. The deleted ResellerOS portal (best place to restore from)

Commit `61d3b4bd` (19 Sep, "feat: remove the ResellerOS customer portal") deleted 24 files and about 3,900 lines. It was self-contained, and the DB side was deliberately left in place. You can get every file back with `git show 61d3b4bd^:<path>`:

- `src/lib/portal/session.ts` — `getPortalSession` / `requirePortalSession` (from customer_users + tenant)
- `src/app/(public)/portal/{login,auth/callback,dashboard,invoices,billing,subscription,orders,support,support/new,profile,shop}`
- `src/app/api/portal/invoice/[id]/pay/route.ts` (Razorpay per invoice), `invoice/[id]/pdf/route.ts`. The PDF route used the admin client but matched on **both** customer_id and tenant_id inside the query, which is the right pattern.
- `src/app/api/portal/seat-request/route.ts` (the server reads tenant/customer/seats from the subscription row and the body only carries a seat count, which is good). There was also `mandate/route.ts` (autopay).

**Verdict: reuse.** This code fits today's schema, it was already reviewed on the main line, and it covers jobs 1–5. Bring it back in small cards, one route at a time, and run the security fixes in §4 first. Do not restore `shop/`, because buying goes through `/buy` and the marketing cart.

### 2c. Pawan's branch (R-107)

- **Branches:** `origin/pawan` (tip `857055a6`, 18 Sep) has **151 commits not in `manager-pardeep`**. It forked at `c81a9067` (8 Sep), and `manager-pardeep` has gained 965 commits since then. The diff is 366 files, about +38,000 lines, and includes 16 migrations. (`anutech/Pawan` is a different, current branch: Pawan's website work, up to 7 Oct.)
- **Contents:** most of it is the **hosting and domains** system: domain/hosting assets, a DNS editor, registrar write path, renewal crons, domain watches, hosting shop/upgrade/SSO-to-panel, "paid but undelivered" handling, and reseller economics. On top of that is a polished portal shell (`portal-sidebar`, `portal-page`, `portal-nav`, `portal-breadcrumb`, theme toggle, `scripts/check-portal-matches-panel.mjs`, heading/icon tests) and a seed (`scripts/seed-portal-test-customer.sql`).
- **Why it never reached main:** on 19 Sep the team decided that hosting/domains belong to **DMS**. That makes about 80% of the branch duplicate work that conflicts with DMS, and its 16 migrations would collide with the schema as it is today.
- **Verdict: do not merge.** Possibly worth borrowing (copy the ideas by hand, not with cherry-pick):
  - the sidebar/page shell that matches the staff panel, and the "portal matches panel" check script
  - the suspended-account and "customer landed in the staff app" messages (fixes for the "orphaned portal session" note in `e15d196f`)
  - the dev demo-customer sign-in (`api/dev/portal-signin`), but only behind `ALLOW_DEV_PAGES`
  - the portal-actor audit idea (already re-done as R-016)

  Then tag the branch `archive/pawan-portal-2026-09-18` and close R-107.

## 3. Phases

### Phase 0 — security before any login (must ship first)
See §4, items S1–S4. Phase 0 has no UI.

### Phase 1 — smallest useful portal (jobs 1–3)
- **Login:** the customer types their email and gets a 6-digit code (and an equivalent link). There are no passwords. Only contacts that staff invited can log in, through a `customer_users` row per contact per customer. A contact linked to two customers sees a customer switcher.
- **Home:** total due, a "Pay now" button, the next renewal date, and the latest 3 invoices. Designed for a phone first.
- **Invoices:** list with status (paid / partly paid / due / overdue), GST PDF download, payment receipt PDF (`ReceiptVoucherPDF`).
- **Pay:** a Razorpay order per invoice (restored `api/portal/invoice/[id]/pay`, using the guards from `quote-order.ts`), settled **only** by the webhook through `record_payment`. A UPI QR and VPA with an "I've paid by UPI" button that emails staff (same rule as `upi-notify`; never marks the invoice paid).
- **Subscriptions (read-only):** product, plan, seats bought/used, renewal date, auto-renew status, status.
- **Staff side:** an "Invite to portal" button on the customer page, a list of who has access with last login, a revoke button, and a "send invoice email with portal link" option.

### Phase 2 — requests (jobs 4, 5, 6, 8)
- Seat change request (restore `seat-request` route; staff approve in the existing seat-requests flow; priced pro-rata when approved).
- Support tickets: list, new ticket, replies, CSAT (the RLS insert policy already exists).
- Billing details change **request** (GSTIN checked against `/api/gstin`; staff approve; old invoices are never edited).
- Quotes list that opens the existing `/quote/[id]/accept` page, and an auto-renew toggle (`set_subscription_auto_renew`, already audited).

### Phase 3 — nice to have (job 7 and more)
- TDS certificate upload into `tds_receivable` (staff verify).
- Statement of account / ledger PDF (opening balance, invoices, payments, closing balance).
- Autopay with Razorpay mandates (`payment_mandates`).
- Contact roles (billing-only vs admin) and more than one contact per customer.
- Portal link in WhatsApp reminders, and one sign-in shared with the DMS panel through `api/dms/sso`.

## 4. Security model

**Rule:** a customer's session may only ever read rows where `tenant_id = their tenant AND customer_id = their customer`. Staff-only data must never reach the browser.

1. **Two kinds of identity, never mixed.** Staff come from `public.users`, which `current_tenant_id()` reads. Customers come from `customer_users`, which `current_customer_id()` reads. A customer auth user has no `users` row, so `current_tenant_id()` returns null for them and staff policies give them nothing. `middleware.ts` must send a customer session to `/portal` and block it from every `(app)` route (this was the gap noted in commit `e15d196f`).
2. **RLS is the main guard, and server checks sit on top.** Portal pages read with the user's own client, so RLS applies. Any route that has to use the admin client (PDF render, Razorpay order, seat request) must filter on **both** `customer_id` and `tenant_id` inside the query, and must take the ids from the session, never from the request body.
3. **Gaps to close before login opens (Phase 0):**
   - **S1. `tenants_select_own_customer` exposes the whole tenant row.** That includes `attendance_ingest_key` (the secret the attendance device posts with) and every internal setting. Replace it with a narrow view or RPC that returns only name, GSTIN, address, phone, `upi_vpa`, `upi_payee_name` and logo, and drop the policy.
   - **S2. `quotes_select_own_customer` exposes `total_cost` (our margin), `notes` and `payment_notes`.** `subscriptions` likewise exposes `write_off_reason`, `is_urgent` and `reminder_count`. The portal must read these through customer-safe views or RPCs (the same cost-stripping idea as the quote-accept page). Either revoke direct customer SELECT on these tables or change the policies to go through the views. Add a SQL test that fails if a cost column can be reached.
   - **S3. A contact with many customers.** `current_customer_id()` uses `limit 1`, so a contact linked to 2 customers gets an arbitrary one. Add an "active customer" choice (in a session claim or a `customer_users` row per customer plus a picker) that the function respects. Re-check that the `customer_users` select policy cannot list another customer's users.
   - **S4. Isolation tests.** pgTAP/SQL tests that check: customer A cannot read B's invoices, payments, quotes, subscriptions or tickets; cannot read the tenant secrets; cannot UPDATE or DELETE anything except through the RPCs; and an anonymous user reads nothing.
4. **Writes only through RPCs or server routes.** Customers never write to money tables. Payments are recorded only by the webhook through `record_payment` (service role, idempotent). UPI "I've paid" only sends a notification. Seat, GSTIN and ticket changes are *requests* that staff approve.
5. **Audit.** Record every portal login (`portal_touch_login` → `last_login_at`, and an activity row with IP/user agent). Write every customer action to `activity_log` with `actor_label = 'Customer <name>'` (R-016). Show staff "who has portal access and last seen".
6. **Login hardening.** OTP codes are single-use, last 10 minutes, and are rate-limited per email and per IP (the shared rate limiter). The response must not reveal whether an email exists (`portal_customer_exists` must stay server-only). Sessions end after 30 days. Revoking access ends sessions immediately.
7. **Auth backend.** R-161 is moving login to Auth.js / a Prisma gateway. Put the portal session behind one small adapter (`lib/portal/session.ts`) so it works with either backend, and decide before card P1-1.

## 5. Open decisions for the owner (with my recommendation)

1. **Where does the portal live?** Rec: **ResellerOS `/portal`** for billing and Workspace/M365/Zoho, because that is where the money, the RLS and the old code are. DMS keeps hosting/domains. Each panel links to the other through the existing `api/dms/sso` hand-off. The site's single "Customer Portal" button opens ResellerOS's login, and hosting customers get one click into DMS.
2. **Login method?** Rec: **6-digit email code** (link as a backup). Company mail scanners (Outlook Safe Links) often "click" magic links before the customer does. No passwords. Add WhatsApp OTP in Phase 3.
3. **Who gets access?** Rec: **invite-only in Phase 1** (staff click "Invite"). From Phase 2, automatically invite the billing contact when their first invoice is emailed.
4. **Can a customer edit their GSTIN/billing details directly?** Rec: **no. They send a request, staff check it and approve.** The change applies to future invoices only, because a wrong GSTIN costs the customer ITC.
5. **Seat changes: request or instant self-serve?** Rec: **request + staff approval** (Phase 2). Add instant pay-and-add later, once pro-rata pricing has been proven on real requests.
6. **When the customer says "I paid by UPI", should we mark it paid?** Rec: **never automatically.** Staff confirm against the bank, as the quote flow does today.
7. **Card/Razorpay fee?** Rec: **no convenience fee.** Push UPI first (lowest cost) and show Razorpay as "Card / Netbanking".
8. **For which tenants?** Rec: build it tenant-aware (branding, UPI and GSTIN come from the tenant) but **switch it on for Anutech only** with a setting. Offer it to other resellers later.
9. **Old Pawan branch (R-107)?** Rec: **archive it with a tag, don't merge**, borrow the shell design by hand, and close R-107 with a link to this doc.
10. **Leftover portal auth users** (Todos decision from 19 Sep)? Rec: list them, and once Phase 1 is live re-link the ones that are real customer contacts and remove the rest. You decide; this touches the production DB.

## 6. Rough effort (worker-cards; 1 card ≈ one local worker session, with tests)

| Phase | Cards | What |
|-------|-------|------|
| 0 — security | **3** | S1 tenant profile view + drop the wide policy · S2 customer-safe views for quotes/subscriptions/invoices + cost-leak test · S3+S4 active-customer + isolation SQL tests |
| 1 — core | **7** | P1-1 OTP login + session adapter + middleware split · P1-2 shell + home (phone-first) · P1-3 invoices + PDF + receipts · P1-4 pay: Razorpay per invoice · P1-5 pay: UPI QR + "I've paid" · P1-6 subscriptions read-only · P1-7 staff invite/revoke/last-seen + e2e check in browser |
| 2 — requests | **5** | seat request · tickets (list/new/reply/CSAT) · billing-details request + staff approval · quotes list + auto-renew toggle · auto-invite on first invoice |
| 3 — extras | **5** | TDS upload · statement of account · autopay mandates · contact roles · DMS one-sign-in + WhatsApp links |
| **Total** | **~20** | Phase 0+1 (10 cards) is about 2 days for 4 parallel workers, then staging at 17:00 and a live deploy with your "haan" |

**Phase 1 is done when** a test customer can do all of this on a phone on staging: log in with a code, see only their own invoices, download a GST PDF, pay ₹1 through Razorpay test mode and see it marked paid by the webhook, and see their seats and renewal date. In the same check, the isolation tests prove they cannot see another customer, the tenant secrets or any cost.
