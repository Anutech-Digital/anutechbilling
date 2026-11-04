# Google Workspace sales flow — test scenarios

Tester: Abhishek (with Claude) · App: local http://localhost:3001 (test data, demo login) · Browser: Chrome
Bugs go to the board (Kaam List) for Pardeep, each card says "Abhishek ne add kiya".

**Status:** ⏳ not started · 🔄 running · ✅ passed · ❌ bugs found (see cards)

## In simple words
Every scenario is the same 5 steps a real salesperson takes. Only the customer's situation changes.

### The 5 steps (same in every scenario)
| Step | What happens in real life | Tab / page used | Buttons and fields tested |
|---|---|---|---|
| 1. Lead | Customer calls, salesperson notes them down | **Sales & Pipeline** (left menu) | "Add lead" or "Quick add" → company, name, email, phone, state, plan, seats, billing → Save |
| 2. Follow-up | Customer says "call me later" | Lead panel → **Activity / Follow-ups** tab, or the **Tasks** page | "Log call", "No answer", "Add follow-up", time shortcuts ("Tomorrow 10 AM") |
| 3. Quote | Customer asks for the price | Lead panel → **Send quote** → **New quotation** page | Plan, seats, rate, place of supply (state), commitment (yearly/monthly), totals and GST, "Save draft", "Preview", "Save & send" |
| 4. Accept | Customer says yes | **Quote page** | "Mark as sent", "Mark accepted" |
| 5. Payment | Customer pays | **Quote page** → "Record payment" | Amount, domain, payment method (UPI/NEFT/Cash), UTR → Confirm; then checked the **Invoices** and **Subscriptions** pages |

### The customer situations
| # | Customer | Situation (what's different) |
|---|---|---|
| 1 | Sharma Traders | Normal case: 10 users, yearly, same state (Delhi) |
| 2 | Gupta Infotech | Customer in **another state** (Haryana) → tax must be IGST |
| 3 | Verma Clinic | **Monthly** plan instead of yearly |
| 4 | Singh Logistics | Pays **in two parts** (₹40,000, then ₹36,464) |
| 5 | Mehta Consultants | **Changes their mind**: 15 users → 12 after getting the quote |
| 6 | (test data) | **Wrong inputs**: empty fields, bad phone/email, 0 seats, negative/zero amounts |
| 7 | Sharma Traders (from #1) | **Existing customer adds 5 users** mid-year → charge only the remaining months; subscription 10 → 15 |
| 8 | Bansal Enterprises | **Customer says no** ("too expensive") → quote rejected, lead marked Lost with a reason |
| 9 | Gupta Infotech (from #2) | **Renewal**: yearly subscription about to end → Renewals tab → renewal quote → payment → subscription moves 1 year forward |
| 10 | Verma Clinic (from #3) + Sharma Traders (from #1) | **Customer cancels → refund**: no invoice → refund voucher; with an invoice → must be blocked (credit note first) |

Setup done once: Settings → Company state = Delhi; Products → "Google Workspace Business Starter" ₹270/month.

### Rules (from Abhishek, 8 Oct 2026)
- Scenarios cover the **Sales tab only**. The flow ends when the salesperson records the payment. (7, 9, 10 went into Billing by mistake; marked below, cards kept.)
- In each scenario test **every element**: tabs, buttons, fields, filters, search, sort, views, logic/maths.
- Order: finish **subscription (Google Workspace)** scenarios → then **one-time project** scenarios.

### Still to test: Sales tab, subscription (planned)
| # | Scenario | Sales tab pages / elements it covers |
|---|---|---|
| 11 | Website enquiry → lead — ✅ done 8 Oct, card R-456 | **Enquiries** page (list, filters, convert to lead), **Orders (website)** |
| 12 | Pipeline work — ✅ done 8 Oct, card R-457 | **Sales & Pipeline**: Kanban drag-drop between stages, List view, Filter, Sort, Search, My assigned / Team view, More menu |
| 13 | Lead details — ✅ done 9 Oct, cards R-458, R-459 | Lead panel: Edit, Archive, Delete, Email tab, Details tab, WhatsApp / Call / Email buttons, Smart Paste Text |
| 14 | Existing customer buys again — ✅ done 9 Oct, cards R-467, R-468 | Add lead → "Existing customer"; **Customers** and **Contacts** pages (search, open, history) |
| 15 | Quote extras — ✅ done 9 Oct, card R-469 | Quote builder: discount, Package, Bulk / many domains, Support plan, Preview, Download PDF, **Quotes** list (filters, search) |
| 16 | Deals view — ✅ done 9 Oct, card R-470 | **Deals** page: stages, filters, "Why deals are lost", forecast numbers |
| 17 | Tasks page — ✅ done 9 Oct, card R-471 | **Tasks**: Overdue / Today / Upcoming / Done tabs, complete, snooze, edit, delete |
| 18 | Other Sales pages — ✅ done 9 Oct, card R-472 | **Marketing Hub**, **Referrals**, **Partners**, **Products** (Sales side) — open, main buttons |

Then: **one-time project scenarios** (custom software / project enquiry → project quote → payment).

## Scenarios

| # | Scenario | Status | Date | Bugs / cards |
|---|---|---|---|---|
| 1 | Happy path — 10 users Business Starter, yearly, full payment, same state (Delhi → Delhi) | ❌ flow works, 4 bugs | 8 Oct 2026 | R-441, R-442, R-443, R-444 · run card T-gws-s1-20261008 |
| 2 | Customer in another state (Delhi → Haryana) — IGST on quote, receipt and invoice | ✅ IGST correct · 1 small-bugs card | 8 Oct 2026 | R-445 (+ notes on R-442, R-443) · run card T-gws-s2-20261008 |
| 3 | Monthly plan instead of yearly | ❌ flow works, 2 bugs | 8 Oct 2026 | R-446, R-447 (+ note on R-442) · run card T-gws-s3-20261008 |
| 4 | Part payment first, then the rest | ✅ passed, no new bugs | 8 Oct 2026 | run card T-gws-s4-20261008 |
| 5 | Customer changes seats → revised quote | ❌ 1 serious bug | 8 Oct 2026 | R-448 (p1) · run card T-gws-s5-20261008 |
| 6 | Wrong inputs — empty fields, short phone, bad email, 0 seats | ❌ several gaps | 8 Oct 2026 | R-449 (+ proof on R-448) · run card T-gws-s6-20261008 |
| 7 | ⚠️ BILLING (outside sales scope) — Existing customer adds 5 users mid-year (Sharma Traders 10 → 15) | ❌ add seats fails | 8 Oct 2026 | R-450 (p1), R-451 (+ proof on R-404) · run card T-gws-s7-20261008 |
| 8 | Customer says no → quote rejected, lead Lost | ✅ works · small gaps | 8 Oct 2026 | R-452 · run card T-gws-s8-20261008 |
| 9 | ⚠️ BILLING (outside sales scope) — Renewal → renewal quote → paid → subscription +1 year | ✅ works · small gaps | 8 Oct 2026 | R-453 (+ note on R-451) · run card T-gws-s9-20261008 |
| 10 | ⚠️ BILLING (outside sales scope) — Customer cancels → refund (with / without invoice) | ❌ refund works, cancel gaps | 8 Oct 2026 | R-455 · run card T-gws-s10-20261008 |

## Notes per scenario

### Setup (needed once after a DB rebuild)
- Settings → Company → state **Delhi (07)**.
- Products → Add item: `GW-STARTER` "Google Workspace Business Starter", ₹270/mo, cost ₹110/mo. Type the **monthly** box — typing the yearly box scrambles the number (R-441).

### Scenario 1 — 8 Oct 2026 (Sharma Traders, Amit Sharma)
| Step | Result |
|---|---|
| Lead | ✅ plan + 10 seats → deal ₹32,400 auto. ❌ no owner (R-442), Kanban stale till reload (R-410) |
| Call + follow-up task | ✅ call logged, lead → Contacted; task "Tomorrow 10 AM" saved, on Tasks page |
| Quote | ✅ all auto-filled, ₹32,400 + ₹5,832 = ₹38,232, Annual; Save & send tries email (R-408 fixed). ❌ Mark as sent doesn't move lead (R-443) |
| Accept | ✅ customer created, lead Won |
| Payment | ✅ ₹38,232 NEFT, invoice auto, subscription Active (MRR ₹2,700, renews 8 Oct 2027). ❌ "required" domain not enforced + small issues (R-444) |

### Scenario 2 — 8 Oct 2026 (Gupta Infotech, Rohit Gupta, Haryana)
| Step | Result |
|---|---|
| Lead (Quick add) | ✅ shows on Kanban at once. ❌ no owner (R-442) |
| Task (Tasks quick add) | ✅ "tomorrow 3 PM" → Fri 9 Oct 3 PM. ❌ not linked to the lead (R-445) |
| Quote | ✅ Haryana → IGST 18%: ₹16,200 + ₹2,916 = ₹19,116; customer Preview says "Haryana (06) · IGST". ❌ Bill To has no contact (R-445). Mark as sent moved the lead this time (R-443 is intermittent) |
| Accept | ✅ |
| Payment | ✅ UPI ₹19,116; invoice INV-DEMO-27-0002 inter-state IGST; receipt RV-DEMO-27-0002; subscription 5 seats, MRR ₹1,350, domain saved |

### Scenario 3 — 8 Oct 2026 (Verma Clinic, Dr. Neha Verma, monthly)
| Step | Result |
|---|---|
| Lead | ✅ Billing cycle Monthly saved; deal ₹9,720/yr with "₹810/month" note; owner saved this time |
| Task | ✅ "In 3 days" → 11 Oct |
| Quote | ❌ line came as Annual despite monthly lead (R-446); after switching to Monthly flex ✅ ₹810 + CGST ₹73 + SGST ₹73 = ₹956/invoice |
| Accept | ✅ lead → Quote Sent → customer |
| Payment | ✅ ₹956 cash (ref optional); subscription monthly, MRR ₹810, renews 8 Nov. ❌ "Generate GST Invoice" always refused on monthly (R-446); auto-invoice decision uses lead state (R-447). Month-1 invoice comes from the billing cron — not checked locally (no CRON_SECRET) |

### Scenario 4 — 8 Oct 2026 (Singh Logistics, Harpreet Singh, part payment)
| Step | Result |
|---|---|
| Lead | ✅ 20 seats → ₹64,800 |
| Follow-up ("No answer") | ✅ "comes back tomorrow" + Undo; stage stays New |
| Quote | ✅ ₹64,800 + ₹11,664 = ₹76,464, margin ₹38,400 |
| Accept | ✅ |
| Part payment ₹40,000 | ✅ "What this does" box correct; quote Partly paid; subscription starts (20 seats, MRR ₹5,400) |
| Balance ₹36,464 | ✅ remaining pre-filled; overpay warning; duplicate UTR blocked; invoice INV-DEMO-27-0003 ₹76,464 paid with 2 advances; still one subscription |

### Scenario 5 — 8 Oct 2026 (Mehta Consultants, Rakesh Mehta, 15 → 12 seats)
| Step | Result |
|---|---|
| Lead + quote 1 | ✅ 15 seats, ₹57,348, sent (follow-up task skipped — covered in 1–4) |
| Revise | ❌ no Edit on a sent quote; "Duplicate & edit" makes a new quote ✅ 12 seats ₹45,878, but no "revising" link to the old one |
| Accept + payment | ✅ UPI ₹45,878, invoice INV-DEMO-27-0004, subscription 12 seats |
| Old quote | ❌ still "sent"; customer link still shows "Accept this quote · ₹57,348"; lead still 15 seats / ₹48,600 (R-448) |

### Scenario 6 — 8 Oct 2026 (wrong inputs)
| Wrong input | Where | Result |
|---|---|---|
| Bad email "abc@" | Add lead | ✅ blocked "Invalid email" |
| Phone "12345" | Add lead | ❌ only a hint; lead saved with 12345 (R-449) |
| Seats 0, price −100 | Add lead → Enquiry | ❌ no warning; review shows them; silently dropped on save (R-449) |
| No state, then Save & send | Quote | ✅ blocked "Pick the customer's state first" |
| QTY 0 | Quote | ❌ box goes blank but line charges 1 seat (R-449) |
| Rate −100 | Quote | ❌ minus silently dropped → ₹100; ✅ below-cost guard: "needs approval first" |
| Amount ₹0 | Payment | ⚠️ blocked but no message, green "✓ ₹0" shown (R-449) |
| Amount −500 | Payment | ✅ "An amount cannot be negative — raise a credit note" |
| UPI UTR "12345" | Payment | ❌ accepted, payment saved (R-449) |
| Payment on old replaced quote | Payment | ❌ saved → 2nd subscription for the same customer (proof added to R-448) |

### Scenario 7 — 8 Oct 2026 (Sharma Traders adds 5 users)
| Step | Tab / button | Result |
|---|---|---|
| Open subscription | **Subscriptions** → Sharma Traders row | ✅ Active, 10 users, MRR ₹2,700 |
| Billing schedule | Subscription panel | ❌ dates 1 day late, already-paid year shown as "next" (R-451) |
| Add users | "Manage seats" → 5 | ✅ maths right: ₹16,200 + ₹2,916 = ₹19,116, new MRR ₹4,050 |
| Save | "Add 5 seats" | ❌ fails silently (503, missing database permission) (R-450) |
| Also found | every payment | ❌ bank account never saved — hard-coded "hdfc_primary" is not a real id (R-404) |

### Scenario 8 — 8 Oct 2026 (Bansal Enterprises says no)
| Step | Tab / button | Result |
|---|---|---|
| Lead + quote | Sales & Pipeline → Add lead; quote → Mark as sent | ✅ 8 users, ₹30,586 |
| Customer says no | Quote page → "Mark rejected" | ✅ quote Rejected. ❌ no reason asked, lead stays in Quote Sent, "Reopen" text but no button (R-452) |
| Mark lead Lost | Lead panel → Change stage → Lost | ✅ confirm → "Why was this lost?" → Price too high + note saved |
| Lost report | **Deals** page → "Why deals are lost" | ✅ 1 deal · ₹25.9K · Price too high 100%. ❌ no "Lost" entry in the lead's Activity (R-452) |

### Scenario 9 — 8 Oct 2026 (Gupta Infotech renewal)
| Step | Tab / button | Result |
|---|---|---|
| Setup | Subscriptions → Gupta → "Correct details" → start 20 Oct 2025 | ✅ renewal became 19 Oct 2026 ("in 11 days"). ⚠️ uses start+1yr−1day, payments use same date (note on R-451) |
| See renewal | **Renewals** → "Upcoming · 30d" | ✅ Gupta listed, forecast Oct ₹16.2K. ❌ "HIGH RISK 0% usage" though usage never checked (R-453) |
| Renewal quote | Row → "Generate quote" | ✅ Q-DEMO-27-0009 ₹19,116, marked Renewal. ❌ row still says "Generate quote" (R-453) |
| Accept + pay | Quote → Mark accepted → Record payment (UPI) | ✅ domain pre-filled; invoice INV-DEMO-27-0005 IGST. ❌ box says it "creates a subscription" (R-453) |
| Result | Subscriptions | ✅ same subscription moved 19 Oct 2026 → 19 Oct 2027, no duplicate |

### Scenario 10 — 8 Oct 2026 (cancel + refund)
| Step | Tab / button | Result |
|---|---|---|
| Refund (no invoice) | **Payments Received** → Verma ⋯ → "Refund payment" → reason → "Book refund" | ✅ RFV-DEMO-27-0001, payment "refunded", clear "send the money yourself" warning |
| After refund | Subscriptions | ❌ still Active, "₹956 due" (R-455) |
| Cancel subscription | Subscription panel → "Cancel / delete subscription" | ❌ only deletes (blocked for paid); had to use "Correct details → cancelled"; still "₹956 due" (R-455) |
| Refund (with invoice) | Payments Received → Sharma ⋯ → Refund | ✅ blocked: "first make a CREDIT NOTE" + Open quote button (warns only after confirm) |

### Scenario 11 — 8 Oct 2026 (website enquiry → lead, Sales tab)
Setup: local `.env.development.local` → `BUY_PAGE_TENANT_ID` = Demo company (otherwise the website form's company doesn't exist locally and the header says "Us").
| Step | Tab / element | Result |
|---|---|---|
| Empty form | Website **/enquiry** → Send enquiry | ✅ every required field flagged |
| Real enquiry | Kumar Pharma, Google Workspace, 12 users | ✅ lead created, message in Notes. ❌ "confirmation on its way" though email failed (R-456) |
| Enquiries page | **Enquiries**: Inbox, Starred, Converted Leads, Spam, Refresh | ✅ folders + empty states work. ❌ help text says form enquiries land here — they don't (R-456). Email inbox not testable locally |
| Lead card | **Sales & Pipeline** | ❌ shows "google-workspace", no deal value, "going cold" after 2 min, no owner (R-456, R-442) |
| Quote | Lead → Send quote | ✅ Business Starter × 12 = ₹45,878 auto-filled |
| Orders (website) | KPIs, All/Paid/Trials/Issues tabs, search | ✅ all respond, "Clear search", filter kept in URL (no local orders) |

### Scenario 12 — 8 Oct 2026 (Sales & Pipeline controls)
| Element | Result |
|---|---|
| Kanban drag-drop | ⚠️ not testable by automation (browser native drag) — check by hand |
| List view, "All leads 3" | ✅ (Kanban 2 + 1 Lost) |
| Sort (Value, Name A–Z) | ✅ kept in URL |
| Search | ✅ "kumar" = 1; ❌ no-result = blank page (R-432, existing) |
| Filter (Source, Clear all) | ✅ kept in URL; ❌ Stage filter has no Lost (R-457) |
| My assigned / Team view | ✅; ❌ "2 unassigned" counts a hidden Won lead; view not remembered on reload (R-457) |
| All leads dropdown, More → Show the numbers | ✅ counts and win rate correct, update live |
| Compact / Columns / bulk bar | ✅ |
| Bulk Contacted / Lost | ✅ Lost asks reason; ❌ checkboxes stuck after it until reload (R-457) |
| Bulk Won | ❌ no quote, no payment, no customer — still marked Won (R-457) |

Test data left behind (local only): lead L-MUZDGFGN (phone 12345), quote Q-DEMO-27-0007 (needs approval), ₹1,000 payment RV-DEMO-27-0007 on Q-DEMO-27-0005 + its 15-seat subscription.

Tester's note: a native dropdown (e.g. Billing cycle) must be set with the form tool, not by clicking its option — clicking lands outside the drawer and closes it (not an app bug).

### Scenario 13 — 9 Oct 2026 (lead details: Gupta Traders, Suresh Gupta, Delhi)
| Element | Result |
|---|---|
| Smart Paste (Add lead) | ❌ fills name/email/phone/product only; company, seats, GSTIN, state, billing left blank (R-459) |
| Add lead maths | ✅ 15 × ₹270 × 12 = ₹48,600 |
| Activity: note / No answer / Log call | ✅ saved; note alone moved lead New → Contacted (R-459) |
| Email button → Send | ❌ "That lead no longer exists" (404) — local no-VM service role can't see owned leads (R-458, p1) |
| WhatsApp | ✅ not configured locally → 409, nothing sent |
| Details tab | ✅ margin 59.3% / ₹28,800; Billing cycle Monthly saves |
| Edit | ✅ bad GSTIN check-digit error; 20 seats → ₹64,800 saved; ❌ edit not in Activity (R-459) |
| Archive | ❌ is really "Lost"; says "archived" even after Cancel (R-459) |
| Delete | ✅ confirm dialog (not pressed — permanent delete left to a person) |
| Quick add duplicate | ✅ warns "Already exists"; ❌ "Open existing lead" doesn't open the drawer (R-459) |
| Row ⋯ → Call tomorrow | ✅ follow-up 10 Oct; ❌ Follow-ups tab still says none (R-459) |

Test data left behind (local only): lead L-MUZHVGDU (Gupta Traders, 20 seats).
Note: local Postgres (ros-pg) stopped mid-test; restarted it and the app.

### Scenario 14 — 9 Oct 2026 (Sharma Traders buys 5 more seats)
| Element | Result |
|---|---|
| Customers page cards | ✅ Received ₹1,99,806 (₹2.0L), To collect ₹57,304 |
| Customers filters / sort | ✅ |
| Customers search | ❌ finds nothing (name, contact or phone) — no-VM gateway keeps the quotes (R-467, p1); phone not searched at all |
| Add lead → Existing customer picker | ❌ can't pick a customer — the list closes on click (R-468; check by hand) |
| Customer 360 → New quote | ✅ customer + Delhi filled; 5 × ₹3,240 = ₹16,200 + ₹2,916 = ₹19,116; margin ₹9,600 |
| Same product already active | ❌ no warning; after payment there are 2 separate Starter subscriptions (8 Oct + 9 Oct 2027) (R-468) |
| Sent → Accepted → UPI payment | ✅ INV-DEMO-27-0006; ❌ domain not pre-filled (R-468) |
| Customer 360 after | ✅ Lifetime paid ₹57,348, MRR ₹4,050; ❌ Contacts section says "no contact" (R-468) |
| Contacts page | ✅ 9 = 4 leads + 5 customers; search incl. phone works; open → Customer 360 |
| Leaving /customers or /leads | ❌ "Leave site? unsaved changes" with nothing changed (R-468) |

Test data left behind (local only): Q-DEMO-27-0010, INV-DEMO-27-0006, 2nd Sharma subscription (5 seats).

### Scenario 15 — 9 Oct 2026 (Kapoor Exports, new prospect, Maharashtra)
| Element | Result |
|---|---|
| Quotes list search (name, number) | ✅ |
| Quotes tabs | ❌ counts add to 11 for 10 quotes; Rejected sits under "Expired" (R-469) |
| Quote analytics "Pipeline ₹3.1L" | ❌ includes invoiced + rejected quotes; Pipeline margin ₹0 (R-469) |
| Package | ✅ none yet → "Create a package" link |
| Bulk / many domains | ✅ 6 + 4 seats × ₹3,240 = ₹32,400; ❌ bad domain ("kapoor global") and duplicate domain accepted silently (R-469) |
| Discount (rate ₹3,240 → ₹3,000) | ✅ −₹2,400 (7%), margin ₹16,800; ⚠️ discount not shown on quote page / PDF (Pardeep to decide) |
| Support plan (Standard, Add to catalog) | ✅ ₹9,996 added; ❌ labelled "Per seat per year" (R-469) |
| Totals | ✅ ₹39,996 + IGST ₹7,199 = ₹47,195 |
| Preview / Download PDF | ✅ same content; PDF saved to Downloads |

Test data left behind (local only): Q-DEMO-27-0011 (draft), catalog item "Demo Cloud Reseller Standard Support (Yearly)".

### Scenario 16 — 9 Oct 2026 (Deals page)
| Element | Result |
|---|---|
| Deals list / Kanban | ✅ 8 deals (6 Won, 2 Lost); Won column ₹1.6L (₹1,55,520) |
| More → Show the numbers | ✅ Win rate 75% (6 of 8); ❌ Open deals 1 / Pipeline ₹64.8K = a Contacted lead not on this page (R-470) |
| Why deals are lost (90d / 1y / All time) | ✅ ₹25.9K, Price too high 1, Not a fit 1 |
| Search | ✅ |
| Filter → Lost | ✅ in List; ❌ Kanban shows 0 (R-470) |
| Deal page (Mehta) | ❌ value still 15 seats after revise to 12; payments shown at 5:30 am at the bottom (R-470) |
| Won → Lost on a paid deal | ✅ blocked with "raise a credit note" (no Open invoice button) |
| Add deal | ✅ same form, plan + stage required (not saved) |

### Scenario 17 — 9 Oct 2026 (Tasks page)
| Element | Result |
|---|---|
| Tabs All / Today / Upcoming / Done | ✅ |
| Overdue tab | ❌ a task due today 10 am (now 12 pm) is not counted — "Inbox zero" (R-471) |
| Quick add ("Email Vikas Monday 11 AM") | ✅ Mon 12 Oct 11:00, type Email; ❌ not linked to the Bansal lead (R-471) |
| Edit (Tomorrow 10 AM, Related to Bansal) | ✅ saved, contact shown |
| Snooze | ✅ +1 day; ❌ no choice of time (R-471) |
| Complete → Done tab, sidebar badge | ✅; Undo toast too quick to test by automation — check by hand |
| Delete | ✅ confirm dialog (cancelled) |
| Add task validation | ✅ empty title blocked; ❌ past date accepted silently (R-471) |

Test data left behind (local only): tasks "Email Vikas", "Past date test", "Call Suresh Gupta 3 PMCall Suresh Gupta tomorrow" (garbled by a stuck page during automation, not an app bug).

### Scenario 18 — 9 Oct 2026 (Marketing Hub, Referrals, Partners, Products)
| Element | Result |
|---|---|
| Marketing Hub | ✅ 12 tools; Update Google Ads (Active, owner, link check) → 1/12 running; ❌ budget −5000 saved as ₹0 silently (R-472) |
| Referrals | ✅ empty states; Add referral on Gupta Infotech (10%, recurring) saved; ❌ no PAN check, no "Add partner" button (R-472) |
| Partners (sidebar) | ❌ distributor-only dead end, "DB-only setting" (R-472) |
| Products (/items) | ✅ 2 items, margin 59%; ❌ "Build this landing page in the next sprint" shown, support SKU contains the tenant id (R-472) |
| Packages | ✅ "Starter + Support Test" = ₹42,396/yr, margin 69% |

Test data left behind (local only): referral partner "Rakesh Verma Test" on Gupta Infotech, package "Starter + Support Test", Google Ads tool row.

**Subscription (Google Workspace) scenarios 1–18 done 9 Oct 2026. Next: one-time project scenarios.**

## Earlier runs (before this file)
- 7 Oct 2026 — one full flow with a custom item (lead → quote → payment → invoice). Bugs: R-404 … R-410 (R-408 fixed by Pardeep).
- 6 Oct 2026 — Billing tab pages: R-177, R-178 (both done).
