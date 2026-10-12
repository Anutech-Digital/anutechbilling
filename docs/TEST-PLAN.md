# ResellerOS — Comprehensive Test Plan

> **What this is:** Every angle worth testing in ResellerOS, organized by
> functional area. Each case has an ID, the exact steps to reproduce, the
> expected behaviour, the current status (built vs not), and whether it
> belongs in manual smoke vs automated CI.
>
> **How to use:**
> 1. Dogfooding at Client A → run the **🔴 Critical** rows manually before
>    handing the system to a real customer.
> 2. Future Playwright suite → start with the cases marked **🤖 Automate**.
> 3. Risk register → cases marked **❌ Not built** define the gap to MVP.
>
> Last refreshed: 2026-05-23 (post commit `a447ad6`).

---

## Coverage at a glance

| Area | Total | ✅ Working | ⚠️ Partial | ❌ Not built |
|---|---:|---:|---:|---:|
| 1. Auth & multi-tenancy | 8 | 6 | 1 | 1 |
| 2. Lead lifecycle | 9 | 7 | 2 | 0 |
| 3. Quote builder | 12 | 10 | 2 | 0 |
| 4. Payment flow (atomic) | 11 | 11 | 0 | 0 |
| 5. Invoice & advance adjustment | 9 | 8 | 1 | 0 |
| 6. Receipt voucher | 5 | 5 | 0 | 0 |
| 7. Subscriptions & renewals | 8 | 3 | 2 | 3 |
| 8. PDF documents | 11 | 11 | 0 | 0 |
| 9. Search, filter, sort | 6 | 5 | 1 | 0 |
| 10. Multi-tenant isolation (security) | 9 | 7 | 0 | 2 |
| 11. State transition guards | 7 | 6 | 1 | 0 |
| 12. Edge cases | 10 | 8 | 2 | 0 |
| 13. Errors & resilience | 8 | 5 | 2 | 1 |
| 14. Integrations (external APIs) | 8 | 0 | 0 | 8 |
| **Total** | **121** | **92** | **14** | **15** |

---

## Status legend

| Symbol | Meaning |
|---|---|
| 🔴 | **Critical** — must pass before any customer touches the system |
| 🟡 | **High** — should pass before dogfood at Client A |
| 🟢 | **Nice** — polish; can ship with these failing |
| ✅ | Currently working & verified |
| ⚠️ | Partial — works for happy path, edge cases unknown |
| ❌ | Not built yet |
| 🤖 | Good Playwright/Vitest candidate |
| 👀 | Manual visual check only |

---

# 1. Auth & multi-tenancy

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-101** | 🔴 | ✅ | 🤖 | **Email signup creates tenant + linked public.users row.** Submit /signup with new email → check auth.users has user, public.tenants has tenant, public.users links them. |
| **TC-102** | 🔴 | ✅ | 🤖 | **Email/password login works.** Existing user signs in via /login → redirected to /dashboard, useCurrentUser returns correct tenantName. |
| **TC-103** | 🟡 | ⚠️ | 👀 | **Google OAuth login.** Click "Sign in with Google" → consent → redirect /callback → land on /dashboard. **Status:** wired but needs real test against project's OAuth config. |
| **TC-104** | 🔴 | ✅ | 🤖 | **Auth required for /(app) routes.** Logged-out access to /dashboard, /leads, /quotes, etc. → middleware redirects to /login?next=... |
| **TC-105** | 🟡 | ✅ | 🤖 | **Public quote-accept page works without auth.** Open /quote/[id]/accept while logged-out → renders quote details from the resolved tenant. |
| **TC-106** | 🟡 | ✅ | 🤖 | **Draft quotes are NOT exposed publicly.** /quote/[draftId]/accept → 404 (per server-side check). |
| **TC-107** | 🟢 | ✅ | 👀 | **Logout clears session.** /auth/sign-out → cookies cleared, back to /login. |
| **TC-108** | 🟡 | ❌ | 🤖 | **Password reset / forgot password.** Not built. Should send reset link via Supabase Auth + reset form. |

---

# 2. Lead lifecycle

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-201** | 🔴 | ✅ | 🤖 | **Create lead.** /leads → "Add Lead" → fill RHF form → submit → row appears in "New" column. |
| **TC-202** | 🟡 | ✅ | 🤖 | **Lead value auto-calc from plan + seats.** Picking "Google Workspace Starter" + 50 seats sets `value` in the form to ₹81,600. |
| **TC-203** | 🔴 | ✅ | 🤖 | **Kanban drag-drop updates stage.** Drag lead card from "New" to "Demo" → useUpdateLeadStage fires → optimistic UI + DB row updated. |
| **TC-204** | 🔴 | ✅ | 🤖 | **Optimistic UI rolls back on error.** Force RLS error (fake stage value) → UI reverts to original position + toast error. |
| **TC-205** | 🟡 | ✅ | 🤖 | **Edit lead.** Click lead → drawer → Edit → change company/contact/notes → save → row reflects new values. |
| **TC-206** | 🟡 | ✅ | 🤖 | **Delete lead.** Drawer → Delete → confirm → row gone from kanban, DB row deleted. |
| **TC-207** | 🟡 | ✅ | 🤖 | **"Send via email" mailto signature is tenant-specific.** Click email → mailto opens with body ending in "— Anutech Digital" (not Client A). |
| **TC-208** | 🟢 | ⚠️ | 🤖 | **Deep-link `/leads?lead=L-XXX`.** Pasting URL with the param scrolls + opens that lead's drawer. **Status:** wired in skill notes, needs manual verify. |
| **TC-209** | 🟡 | ⚠️ | 👀 | **Search filters across company/contact/email.** Type in search box → only matching lead cards remain. **Status:** UI present, behaviour not regression-tested. |

---

# 3. Quote builder + line items

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-301** | 🔴 | ✅ | 🤖 | **Build quote from scratch.** /quotes/new → pick customer → add line item → preview → save → quote row in /quotes. |
| **TC-302** | 🔴 | ✅ | 🤖 | **Build quote from lead.** /leads → "Send quote" → /quotes/new prefilled with lead context (leadId, company, contact, plan). |
| **TC-303** | 🔴 | ✅ | 🤖 | **Line item picks correct rate from catalog.** "Google Workspace Starter" 50 seats annual → rate ₹1,632/yr (msrp × 12), amount ₹81,600. |
| **TC-304** | 🟡 | ✅ | 🤖 | **Fuzzy catalog match.** Lead has plan="Starter" → builder finds "Google Workspace Starter" via substring. (Per skill conventions.) |
| **TC-305** | 🟡 | ✅ | 🤖 | **Commitment dropdown changes display unit only, not annual total.** Switch monthly→quarterly→yearly → grand-total annual same, per-invoice changes. |
| **TC-306** | 🟡 | ✅ | 🤖 | **Discount applies before tax.** 20% discount on ₹81,600 → taxable ₹65,280 → 18% GST ₹11,750. |
| **TC-307** | 🟡 | ✅ | 🤖 | **Inter-state vs intra-state GST split.** customerState ≠ tenantState → IGST 18%; equal → CGST 9% + SGST 9% rounded correctly. |
| **TC-308** | 🟡 | ✅ | 🤖 | **Mixed commitments are allowed.** Add lines with annual_yearly + monthly + annual_quarterly → preview renders per-line units. |
| **TC-309** | 🟢 | ✅ | 👀 | **Add-on line items.** Add `kind='addon'` item → flagged in preview as add-on. |
| **TC-310** | 🟡 | ✅ | 👀 | **Notes section persists.** Type notes → save → reload → notes field intact. |
| **TC-311** | 🟢 | ⚠️ | 👀 | **Duplicate & edit existing quote.** Process button (now status-aware) → "Duplicate & edit" → /quotes/new pre-filled with all line items. |
| **TC-312** | 🟢 | ⚠️ | 👀 | **Margin pill colour codes.** Margin ≥ 18% emerald, 14-17% amber, <14% rose. |

---

# 4. Payment flow — atomic `record_payment`

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-401** | 🔴 | ✅ | 🤖 | **No-tenant call rejected.** RPC invoked without JWT → `No tenant context` error. (Smoke-tested in session.) |
| **TC-402** | 🔴 | ✅ | 🤖 | **amount ≤ 0 rejected.** record_payment(0)/(-50) → `amount must be > 0`. |
| **TC-403** | 🔴 | ✅ | 🤖 | **Invalid method rejected.** method='bitcoin' → `invalid payment method`. |
| **TC-404** | 🔴 | ✅ | 🤖 | **Empty reference rejected.** ref='   ' → `reference is required`. |
| **TC-405** | 🔴 | ✅ | 🤖 | **Cross-tenant attack blocked.** Tenant A's JWT, Tenant B's quote_id → `quote does not belong to your tenant`. |
| **TC-406** | 🔴 | ✅ | 🤖 | **Happy path — first payment converts lead.** Annual prospect quote, full payment → lead.stage='won', customer row created, subscription created, RV# issued, all in one transaction (verified via DO + ROLLBACK). |
| **TC-407** | 🔴 | ✅ | 🤖 | **Partial first payment activates service with outstanding.** Half amount → customer + subscription created, subscription.outstanding_amount = remaining, quote.payment_status='partial'. |
| **TC-408** | 🔴 | ✅ | 🤖 | **Second partial payment balances the quote.** Same quote, remaining amount → payment_status='received', outstanding=0. |
| **TC-409** | 🔴 | ✅ | 🤖 | **Post-invoice payment does NOT issue new RV.** Invoice exists on quote → record_payment runs, payment row created with `receipt_voucher_no = NULL`. |
| **TC-410** | 🔴 | ✅ | 🤖 | **Post-invoice full payment marks invoice paid.** Sum of post-invoice payments ≥ net_payable → invoice.status='paid', paid_date set. |
| **TC-411** | 🔴 | ✅ | 🤖 | **Monthly commitment skips subscription creation.** First payment on commitment='monthly' → no subscription row inserted (flex billing). |

---

# 5. Invoice generation + advance adjustment

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-501** | 🔴 | ✅ | 🤖 | **Invoice number is sequential per tenant per FY.** Issue 3 invoices → INV-2026-27-0001, 0002, 0003 in this tenant; other tenants unaffected. |
| **TC-502** | 🔴 | ✅ | 🤖 | **FY boundary resets on Apr 1.** Mar 31 issue → FY2526; Apr 1 issue → FY2627 (different counter starts). |
| **TC-503** | 🔴 | ✅ | 🤖 | **Two concurrent issues never collide.** Two parallel `next_document_number` calls → distinct numbers (UPSERT row lock). |
| **TC-504** | 🔴 | ✅ | 🤖 | **Invoice cannot be generated twice for same quote.** useGenerateInvoice on quote with existing invoice_id → throws `Invoice ... already exists`. |
| **TC-505** | 🔴 | ✅ | 🤖 | **Advance adjustment snapshot is frozen.** Generate invoice → invoice.adjusted_advances captures all received payments at that instant. Later refunds become Credit Notes, not edits. |
| **TC-506** | 🔴 | ✅ | 🤖 | **Net payable = amount − sum(advances).** Quote ₹96,288, advance ₹48,144 → invoice.net_payable=₹48,144. |
| **TC-507** | 🔴 | ✅ | 🤖 | **net_payable ≥ 0 invariant.** Force advances > amount → check constraint stops it (`net_payable >= 0 and <= amount`). |
| **TC-508** | 🟡 | ✅ | 🤖 | **first_advance_at drives the 30-day GST clock.** Set first_advance_at to today−25, due_date should be today+5 (CGST Rule 47). |
| **TC-509** | 🟡 | ⚠️ | 👀 | **Owner can set series start (onboarding from Tally).** Call set_document_series_start as owner → ok. Same as 'sales' role → error. **Status:** RPC built, manual flow only. |

---

# 6. Receipt voucher

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-601** | 🔴 | ✅ | 🤖 | **RV# format `RV-YYYY-YY-NNNN`.** First voucher of FY2526 → `RV-2025-26-0001`. |
| **TC-602** | 🔴 | ✅ | 🤖 | **RV issued only pre-invoice.** record_payment with no invoice → RV minted. With invoice → RV null. |
| **TC-603** | 🟡 | ✅ | 🤖 | **Backfill preserves existing RV numbers.** Old `RV-2026-0001` rows → counter seeded to max so next call doesn't collide. (Migration 0004 step 7.) |
| **TC-604** | 🟡 | ✅ | 👀 | **GST reverse-calc correct in RV PDF.** Gross ₹48,144 at 18% → taxable ₹40,800, total tax ₹7,344, CGST 9% ₹3,672, SGST 9% ₹3,672. |
| **TC-605** | 🟢 | ✅ | 👀 | **Amount-in-words renders Indian lakh/crore.** ₹1,25,000 → "One Lakh Twenty Five Thousand". |

---

# 7. Subscriptions & renewals

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-701** | 🔴 | ✅ | 🤖 | **Annual quote auto-creates subscription on first payment.** record_payment on commitment=annual_* → subscription with renewal_date=+1yr, mrr=quote.amount/12. |
| **TC-702** | 🟡 | ✅ | 🤖 | **Vendor detected from plan name.** "Google Workspace ..." → vendor='google'; "M365 ..."/"Microsoft ..." → microsoft; "Zoho ..." → zoho. |
| **TC-703** | 🟡 | ✅ | 👀 | **Outstanding amount surfaces on subscription card.** sub.outstanding_amount > 0 → red badge "₹X due". |
| **TC-704** | 🟡 | ⚠️ | 👀 | **Multi-quote customer outstanding update.** Tech debt: subsequent record_payment updates ALL subs with outstanding>0 of that customer. Acceptable for single-quote customer, broken for multi-quote. **Fix:** add subscriptions.quote_id FK + scope update. |
| **TC-705** | 🟡 | ⚠️ | 👀 | **Renewal risk model is mock.** /renewals risk score uses id-hash for last-login/tickets/NPS. Need real signals from Google CSP API + support tickets. |
| **TC-706** | 🟡 | ❌ | 🤖 | **T-90/60/30/7 renewal alert cron.** Vercel cron + email/WhatsApp dispatch. Not built. |
| **TC-707** | 🟡 | ❌ | 🤖 | **Subscription seat usage sync.** sub.used should reflect actual seats consumed from CSP API. Currently 0/manual. |
| **TC-708** | 🟢 | ❌ | 🤖 | **Subscription cancel + write-off flow.** Schema has write_off_reason/written_off_at but no UI button. |

---

# 8. PDF documents

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-801** | 🔴 | ✅ | 🤖 | **Quote PDF generates valid file.** Click Download PDF on /quotes/Q-XXX → blob with %PDF magic + %EOF tail. |
| **TC-802** | 🔴 | ✅ | 🤖 | **Invoice PDF generates valid file.** Same on /invoices View → blob valid. |
| **TC-803** | 🔴 | ✅ | 🤖 | **Receipt voucher PDF generates valid file.** Same on /payments Receipt → blob valid. |
| **TC-804** | 🔴 | ✅ | 👀 | **Tenant branding pulled correctly.** Logged in as Anutech Digital → all 3 PDFs show "Anutech Digital", not "Client A". |
| **TC-805** | 🟡 | ✅ | 👀 | **GST split (CGST+SGST vs IGST) correct in PDFs.** Per interState flag. |
| **TC-806** | 🟡 | ✅ | 👀 | **Advance adjustment block renders in Invoice PDF.** If `adjusted_advances` non-empty → emerald block with each voucher + net payable. |
| **TC-807** | 🟡 | ✅ | 👀 | **Long product names wrap in PDF.** Description column flex:4 → wraps without breaking rate/amount alignment. (fx-1024 in test catalog.) |
| **TC-808** | 🟡 | ✅ | 👀 | **Many line items don't tear rows.** 12 line items → page break occurs between rows, never inside (wrap=false on tr). (fx-1023.) |
| **TC-809** | 🟡 | ✅ | 👀 | **Lakh + crore formatting.** ₹16.3L total (1000 seats × ₹1,632) and crore-scale (₹85L+) → Indian grouping. |
| **TC-810** | 🟡 | ✅ | 🤖 | **All 19 catalog fixtures generate valid PDFs.** Bulk run on /dev/pdf-test → 19/19 pass. |
| **TC-811** | 🟢 | ✅ | 👀 | **Empty line items renders placeholder.** Empty array → "No line items." inline message; totals block skipped. |

---

# 9. Search, filter, sort

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-901** | 🟡 | ✅ | 👀 | **Quotes tab filters work.** All / Draft / Sent / Viewed / Accepted / Expired — count badges match filtered rows. |
| **TC-902** | 🟡 | ✅ | 👀 | **Invoices tab filters.** All / Paid / Pending / Overdue / Draft. |
| **TC-903** | 🟡 | ✅ | 👀 | **Payments tab filters.** All / Received / Refunded. |
| **TC-904** | 🟢 | ✅ | 👀 | **Subscriptions: All / Active / Expiring 30d / Expired tabs.** |
| **TC-905** | 🟢 | ✅ | 👀 | **Customer search by name / domain.** Type in /customers search → real-time filter. |
| **TC-906** | 🟢 | ⚠️ | 🤖 | **Case-insensitive search.** "sharma" matches "Sharma Consulting" (ilike). Status: assumed but not verified. |

---

# 10. Multi-tenant isolation (SECURITY) — 🔴 ALL CRITICAL

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-1001** | 🔴 | ✅ | 🤖 | **SELECT respects RLS on every table.** Tenant A's authed client `select *` from tenants/users/customers/items/leads/quotes/invoices/subscriptions/payments → only A's rows returned. |
| **TC-1002** | 🔴 | ✅ | 🤖 | **INSERT with wrong tenant_id rejected.** Tenant A tries to insert row with B's tenant_id → RLS check `with check tenant_id = current_tenant_id()` blocks. |
| **TC-1003** | 🔴 | ✅ | 🤖 | **UPDATE on cross-tenant row no-ops.** Tenant A `update where id = <B's row id>` → 0 rows affected (RLS USING filter excludes). |
| **TC-1004** | 🔴 | ✅ | 🤖 | **DELETE on cross-tenant row no-ops.** Same as above for delete. |
| **TC-1005** | 🔴 | ✅ | 🤖 | **record_payment with cross-tenant quote_id rejected.** Verified in session. |
| **TC-1006** | 🔴 | ✅ | 🤖 | **next_document_number isolated per tenant.** Two tenants both issue invoices → each gets their own 0001, 0002 sequence. |
| **TC-1007** | 🔴 | ✅ | 🤖 | **Payments table doesn't allow DELETE.** Only refund (status update) — no policy granted. |
| **TC-1008** | 🔴 | ❌ | 🤖 | **Service role key NOT in browser bundle.** grep production build for sb_secret_ → 0 occurrences. Manual verify needed. |
| **TC-1009** | 🔴 | ❌ | 🤖 | **Playwright cross-tenant suite.** Blocked on service role key rotation. See tasks #8-12 in tracker. |

---

# 11. State transition guards

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-1101** | 🟡 | ✅ | 🤖 | **Quote payment_status terminal at 'invoiced'.** record_payment with existing invoice → preserves 'invoiced' (never downgrades to 'partial' or 'received'). |
| **TC-1102** | 🟡 | ✅ | 🤖 | **Invoice status transitions valid.** draft → pending → paid OR pending → overdue → paid. Void from anywhere by owner only. |
| **TC-1103** | 🟡 | ✅ | 🤖 | **Lead stage enum constrained.** Try `update leads set stage='garbage'` → enum check error. |
| **TC-1104** | 🟡 | ✅ | 🤖 | **Document series counter never decrements.** UPSERT with last_number + 1 only — cannot go backwards via normal path. |
| **TC-1105** | 🟡 | ✅ | 🤖 | **Receipt voucher uniqueness per tenant per RV#.** Unique index on (tenant_id, receipt_voucher_no) where receipt_voucher_no is not null. |
| **TC-1106** | 🟡 | ✅ | 🤖 | **Lead promoted to 'won' only on first payment of prospect.** Not on subsequent payments. |
| **TC-1107** | 🟢 | ⚠️ | 👀 | **Quote action button matches payment state.** Verified visually in this session. |

---

# 12. Edge cases

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-1201** | 🟡 | ✅ | 👀 | **Tenant with no GSTIN.** PDFs/dialogs hide the GSTIN row gracefully (no "GSTIN: null"). |
| **TC-1202** | 🟡 | ✅ | 👀 | **Tenant with no address/phone/email.** All 3 PDFs handle missing optional contact fields. |
| **TC-1203** | 🟡 | ✅ | 👀 | **Quote with 0 line items.** Preview & PDF render "No line items." placeholder; totals block skipped. |
| **TC-1204** | 🟡 | ✅ | 👀 | **1000 seats, lakh-scale amount.** Indian number grouping (₹16,32,000), tabular alignment preserved. |
| **TC-1205** | 🟡 | ✅ | 👀 | **Customer with very long name.** Wraps in Bill-to block without breaking layout. |
| **TC-1206** | 🟡 | ⚠️ | 👀 | **Tenant name with special chars (e.g. "M&S Tech").** Should escape correctly in PDF + HTML. Not explicitly tested. |
| **TC-1207** | 🟡 | ⚠️ | 👀 | **Quote.notes with multi-paragraph content.** Long notes shouldn't push footer off page (verified in fx-1041). |
| **TC-1208** | 🟢 | ✅ | 👀 | **Discount 100%.** Taxable becomes 0, tax 0, grand total 0 — math holds. |
| **TC-1209** | 🟢 | ✅ | 👀 | **GST rate 0% (exports, future).** CGST+SGST rows still render with ₹0. |
| **TC-1210** | 🟢 | ✅ | 👀 | **Validity 1 day vs 365 days.** Expires-on date computed correctly. |

---

# 13. Errors & resilience

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-1301** | 🔴 | ✅ | 🤖 | **Atomic record_payment — no orphan on mid-flight failure.** Single transaction → if subscription insert fails (forced), no payment row commits. |
| **TC-1302** | 🔴 | ✅ | 🤖 | **Concurrent record_payment on same quote serialized.** SELECT FOR UPDATE on quote → second call waits, sees first call's payment, doesn't double-convert lead. |
| **TC-1303** | 🟡 | ⚠️ | 👀 | **Network drop during page load.** Skeleton renders, retries silently via TanStack Query. **Status:** TanStack handles; manual interruption test pending. |
| **TC-1304** | 🟡 | ⚠️ | 👀 | **Stale tab refetch on focus.** TanStack default refetchOnWindowFocus — quote that changed in another tab updates. |
| **TC-1305** | 🟡 | ✅ | 👀 | **Toast error on RPC failure.** record_payment that throws → sonner toast shows error message (verified visually). |
| **TC-1306** | 🟡 | ✅ | 👀 | **Empty state on every list.** /leads /customers /quotes /invoices /payments /subscriptions /items — all render EmptyState component when no rows. |
| **TC-1307** | 🟡 | ✅ | 👀 | **Loading skeleton on every list.** Same set — Skeleton component during isLoading. |
| **TC-1308** | 🔴 | ❌ | 🤖 | **error.tsx boundary per route.** CLAUDE.md §11 requires per-page error.tsx. **Status:** not built; uncaught errors fall to Next.js default. |

---

# 14. Integrations (external APIs) — ❌ MOSTLY NOT BUILT

| ID | Severity | Status | Auto? | Scenario |
|---|---|---|---|---|
| **TC-1401** | 🟡 | ❌ | 🤖 | **Razorpay payment link generation.** Create link from quote → returns short_url. |
| **TC-1402** | 🟡 | ❌ | 🤖 | **Razorpay webhook → record_payment.** payment.captured webhook → POST /api/webhooks/razorpay → atomic record_payment fires with razorpay reference. |
| **TC-1403** | 🟡 | ❌ | 🤖 | **Resend email send with PDF attachment.** sendQuoteEmail(quoteId) → fetches PDF blob, attaches, sends; quote.status → 'sent'. |
| **TC-1404** | 🟡 | ❌ | 🤖 | **ClearTax IRP — invoice IRN generation.** Generate invoice → POST to IRP → store gst_irn on invoice row. |
| **TC-1405** | 🟡 | ❌ | 🤖 | **Google CSP API — sub creation.** Closed-Won → provision in Partner Portal → store csp_subscription_id. |
| **TC-1406** | 🟡 | ❌ | 🤖 | **Gupshup WhatsApp — quote sent notification.** Quote status → 'sent' triggers WhatsApp template "Your quote {{id}} is ready". |
| **TC-1407** | 🟡 | ❌ | 🤖 | **Renewal alert cron.** Daily 9am IST → fetch subs with renewal_date in T-90/60/30/7 → send email + WhatsApp. |
| **TC-1408** | 🟢 | ❌ | 🤖 | **Gemini AI lead scoring.** GeminiCard shows AI insights — currently UI shell. |

---

# How to run the manual smoke (pre-dogfood)

In one ~30-min sitting at Client A, execute these in order. Each step roughly maps to a critical case above.

1. **Auth** — sign up `excel-test-1@example.test`, confirm tenant created, log out + log back in.
2. **Catalog** — go to /items, verify 3-5 seeded items (Google Workspace tiers, M365). If empty, run `seed.sql`.
3. **Lead** — /leads → Add Lead "Smoke Test Co" Rajesh@smoketest.in plan="Google Workspace Standard" 25 seats. Drag through Kanban to "Quote".
4. **Quote** — Click lead → "Send quote" → /quotes/new pre-filled. Verify line item rate is right (~₹4,080/seat/yr if Standard). Discount 10%. Save as Draft.
5. **Send** — Open quote → "Send via email" — mailto: opens, body signed off as your tenant name (TC-207).
6. **Customer accept** — Copy customer link, open in incognito → /quote/[id]/accept renders, click Accept.
7. **Record payment** — Back in app → /quotes/[id] shows status='accepted'. Record full payment via UPI ref. Should fire: lead→won, customer created, subscription created, RV-2025-26-0001 issued.
8. **Quotes list** — Verify Q-XXX shows "● Invoiced" (after invoice generated) or "● Paid" (TC-901).
9. **Generate invoice** — Click "Generate invoice" (button label per TC-1107). Invoice INV-2025-26-0001 created.
10. **Invoiced button** — Quotes list Action column shows "Invoiced" — click → jumps to /invoices, dialog auto-opens (verified TC-1107).
11. **Download all 3 PDFs** — Quote PDF / Invoice PDF / Receipt Voucher PDF — open each, confirm Anutech Digital branding + correct amounts (TC-801-804).
12. **Dashboard** — /dashboard shows MRR > 0, active subs = 1, greeting uses your name + tenant (TC-19 / TC-102).
13. **Multi-tenant smoke** — Log out, log in as e2e-tenant-a@resellersos.test → confirm NONE of your data is visible.

If all 13 pass → ship to first external customer.

---

# Backlog — turn these into Playwright suites

Order of impact for automated suites once test users + service-role key are sorted:

1. **Multi-tenant isolation** (TC-1001 to TC-1008) — single suite, ~150 lines, catches the deal-breaker class of bugs.
2. **record_payment matrix** (TC-401 to TC-411) — 11 scenarios as `.spec.ts` with DO + ROLLBACK pattern from session.
3. **Invoice generation** (TC-501 to TC-508).
4. **PDF generation** (TC-810 — already automatable by extending /dev/pdf-test eval).
5. **Lead → cash happy path** (the 13-step manual smoke above, end-to-end).

---

# Notes

- **121 total cases** across 14 angles. **92 pass today**, 14 partial, 15 not built. The not-built bucket is mostly external integrations + the Playwright harness — both are tracked in TASKS (#8-12, #1401-1408).
- **Use this doc before customer #2.** When Client A's run is stable, walk through critical (🔴) + high (🟡) cases as the bar for adding a second customer.
- **Refresh cadence:** Update the coverage matrix at the top after every significant feature ship. Each new RPC / page / integration gets new TC-XXX entries.
