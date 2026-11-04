# UX audit: Zoho Books vs our Billing app (31 Oct 2026)

Asked by Pardeep on 31 Oct: run Zoho Books in the local browser, see how user-friendly it is, then make our app more user-friendly.

**How this was done**
- **Zoho Books:** the real org, strictly read-only. Forms were opened and filled, then cancelled. Nothing was saved, sent, matched or converted.
- **Our app:** run on localhost http://127.0.0.1:3001 as the local test owner (E2E Test Co).
  - Test data saved on localhost only: customer "Customer A" (a test GSTIN and a test phone number), quote Q-XXXX-27-0068, a part payment of ₹1,500 with 2% TDS, and a ₹1,000 credit note on INV-XXXX-27-0050.
- **Viewport:** the browser pane was 1483×846, plus a 375×812 mobile test.

**Caveats**
- localhost runs `next dev`, so our load times are inflated. A page compiles on its first visit. Treat our times as "relative", not absolute.
- Zoho is production.
- The local GSTIN lookup returns **mock** data, because Sandbox.co.in keys are not set.

---

## 1. Per-task comparison

"Clicks" counts clicks plus key presses, from the screen where the task starts. Typing into fields is counted separately.

| # | Task | Zoho clicks / screens | Ours clicks / screens | Who wins | Why |
|---|---|---|---|---|---|
| 1 | New customer + GSTIN autofill | 5 clicks, 2 screens. Path: Prefill link → modal → type GSTIN → Fetch → Prefill Details → Save. Fills company, legal and trade name, PAN, place of supply, GST treatment and address. A required "Custom Fields*" tab still has to be visited. | 4 clicks, 1 screen. Path: type GSTIN (instant "✓ Valid GSTIN · Delhi" and GST treatment auto-set) → Verify → **Fill form from GST** → Save. | **Ours (slightly)** | Inline validation and the auto GST treatment are better. But "Verify" then "Fill form" is 2 clicks where 1 would do. After save the page sat on `/customers/new` for about 10 s before redirecting, with no "saving…" state. The button says "Save company" but the toast says "Customer added". |
| 2 | Quote: 10 × GWS Starter, annual commit billed monthly → invoice | Quote form: pick customer (slow search, about 4 s spinner) and pick item (keyboard Enter works). Commit and billing frequency do **not** exist; they are faked with custom fields (Business Type, Subs Period, Total Licences, which repeats the qty) plus text in the description. Convert: 2 clicks (a "What's next? Convert" banner, or Convert → To Invoice) → prefilled invoice → Save. About 8 clicks and 3 screens in total. | Quote: customer prefilled from the profile → 1 click on a plan chip (qty 10 and Annual commitment are prefilled) → **"Change"** link → Payment frequency = Monthly → Save draft. That is 4 clicks. **There is no "Convert to invoice"**: the stepper runs Draft → Sent → Signed → Paid → Provisioned → Invoiced. You must Mark as sent → Mark accepted → Record payment. The tax invoice is raised only when an instalment is fully paid. "Activate now, pay later" is offered, then rejected for monthly quotes with a toast. About 10 clicks, 3 or 4 waits of 6 to 12 s each. | **Ours for the quote, Zoho for the conversion** | The commit/frequency model is far better than Zoho's custom fields. But payment frequency is hidden behind "Change". The quote detail **Total shows "₹38,232 /month"** when the real figure is ₹3,186/month (₹38,232 is the year): a money display bug. Quote → invoice has no one-step path. |
| 3 | Part payment with 2% TDS | Invoice → Record Payment (2 clicks) → type the amount → tick "Yes, Income TDS" → type the TDS amount by hand (no % calculation) → TDS account defaults to "Advance Tax" (wrong for most users) → Save as Paid. About 5 clicks and 3 typed fields. | Quote/invoice → Record payment drawer → tick "Customer deducted TDS" → section 194J defaults to 10% → type 2 (an inline warning explains 194J at 2%) → type 1500 → Confirm. About 4 clicks and 2 typed fields. Live TDS computation, net to bank, and a "What this does" box. | **Ours** | Auto TDS maths, a section picker and the warning are excellent. Problems: (a) with TDS ticked at the full amount, the summary says "₹54 … will still be outstanding, the quote stays partly paid" while the box above says the ₹54 is a TDS receivable. That is a contradiction on a money screen. (b) After saving, the drawer **re-opens** as "Record additional payment", so it looks as if the save failed. |
| 4 | Credit note against an invoice | Invoice → ⋯ → Create Credit Note → confirm modal "are you sure?" → full form (customer, place of supply, invoice#, invoice type, reason, line items) → Save. 4 clicks, 2 screens, 2 or more fields. | Invoice list row ⋯ → Issue credit note → drawer (amount prefilled to the full amount, reason defaulted, GST split shown, permanent-GSTR warning) → type amount → Issue. 3 clicks, 1 drawer, 1 field. | **Ours** | Fewer steps, honest warning, and the result shows inline in the list ("CN −₹1,000 · Net ₹94,993"). Problems: the drawer said "Amount still owed on this invoice: ₹95,993" for an invoice whose status is **Paid**. There are no line-level credits, and no toast with the CN number or PDF link afterwards. |
| 5 | Recurring / subscription bill | Recurring Invoices is **not in the Sales menu**; you have to know the URL or use "+". The form needs Profile Name. "Repeat every" defaults to **Week** (wrong for SaaS). Then 3 custom required fields. About 6 clicks and 5 fields. | Two ways. (a) It is created automatically by the quote payment (that is how the Customer A subscription appeared). (b) Subscriptions → "Add Subscription" modal ("1-click onboarding"), which re-asks customer, domain, contact, email, phone, state, GSTIN, vendor, plan, commitment and frequency. Its customer picker is a plain `<select>` of every customer, with no search. | **Ours (path a)**; path (b) is worse than Zoho | The quote-driven subscription is the right model. The Add Subscription modal is a second customer-creation form ("one way" rule broken). Its GSTIN field does not verify, and the plain select will not scale. |
| 6 | Reconcile one bank credit to an invoice | Banking overview shows "663 uncategorized — Categorize now" (1 click) → click a line → right panel "Best Matches (1)" → **Match**. 3 clicks. | Banking → overview cards. "View transactions" is a non-clickable span; only clicking the card title works. Then account → Unmatched tab → Reconcile → drawer (party guessed from the narration, bill pre-ticked, part-payment maths) → scroll to find the save button. About 5 clicks plus scrolling. The test account had no unmatched credits, so a debit was used to see the drawer. | **Zoho** | Zoho surfaces the work queue (uncategorized count) on the first screen and puts **Match** next to the best guess. Our drawer's guesses are good, but its sticky footer says "save with the button in the form above" with only Close beside it. The table headers are "NIKASI (DR.) / JAMA (CR.)", which breaks the English rule. The BRS page says "**Reconciled** — every bank line booked" while showing bank ₹0 against books ₹−50,000. |
| 7 | Customer outstanding + statement | The customer list has a Receivables column (0 clicks). Profile → Statement tab (2 clicks) gives a period picker, print, PDF, Excel and "Share via". | Profile → Outstanding card (1 click). Statement tab (1 more click) is a simple ledger: no period picker, no PDF, no send. | **Zoho** | **The Overview says "Outstanding ₹1,632" while the Statement tab says "Closing balance ₹1,554 credit"** for the same customer. One fact, two places, two opposite answers. Our statement cannot be sent to the customer. |
| 8 | P&L → drill into one number | Every account amount is a link (1 click to Account Transactions, 1 more to the source document). | Top-card totals and "58 invoices →" open a drill modal (1 click). **Category rows (e.g. Google Workspace ₹10,35,488) are not clickable.** | **Zoho** | The drill total does not match the number clicked. Revenue card ₹15,13,212 → "₹17,62,261 invoiced" → modal "TOTAL · 58 items ₹19,08,044". The modal includes GST and also lists the fully credited INV-0049 at ₹95,993. A user cannot tie the numbers out. |
| 9 | Global search: invoice by number, customer by phone | Search is module-scoped ("Search in Customers") and needs Enter. An invoice number typed from Home searched **Customers** and found nothing. The "/" shortcut did not focus it. | Ctrl+K palette: "0050" instantly shows quote, invoice and 2 payments, grouped. The phone number typed with a space finds the company and contact. **The same number as digits only gives "No results found."** | **Ours** | Cross-entity, instant, keyboard-first. Fix the digits-only phone miss: the company "Work phone" does not seem to be indexed the way `contact_phone` is. |
| 10 | Payment reminder (stopped before send) | Invoice → Reminders → Send Email (2 clicks) → full email composer with a template → Send. Stop/Start reminders and Expected Payment Date are in the same menu. Grammar slip in the template: "overdue by 1 days". | Customer profile shows a "Next best action" card → **Draft reminder with AI** (1 click) → editable text → Send via WhatsApp (or Copy / Redraft). 2 clicks. | **Ours (speed)**, Zoho (completeness) | Ours is faster and WhatsApp-native. But the draft names neither the invoice number nor a pay link, and there is no per-invoice reminder or "stop reminders" control. |

**Score:** ours wins 1, 3, 4, 5(a), 9 and 10; Zoho wins 6, 7 and 8; task 2 is split.

Our app has the better **model** of the business (commit and frequency, TDS maths, cross-entity search, honest warnings). Zoho has better **closure**: every screen ends in the obvious next button (Convert, Match, Statement PDF), every number is a link, and lists stay visible beside details.

### General UX

| Area | Zoho | Ours |
|---|---|---|
| Navigation | Fixed left menu plus a **split view**: list on the left, record on the right. You move between invoices without going back. | Grouped sidebar (Sales / Billing / Accounts …). Every record opens full-page and loses the list. After a full page load the sidebar is blank ("Loading…") for 5 to 15 s on dev. Clicking a sidebar item gives **no pending feedback** for 6 to 12 s on dev. |
| Empty states | Plain "There aren't any Customers". | Better. Profile cards say what is missing and offer the action ("No contact person yet", "Create first quote"). |
| Words and buttons | "Customer" everywhere. | "Company" (route `/customers`, button "Save company", toast "Customer added", breadcrumb "Companies"). Hindi column heads on the bank screen ("Nikasi / Jama"). |
| Fits 1280 | Wide tables scroll sideways: Quotes list, quote item table, invoice list. | Subscriptions table is 1435 px inside a 1147 px container **even at 1483 px**; Status and actions are off-screen. Quote, invoice and P&L screens fit. |
| Layout stability | Stable. | The invoices page renders, then a "Pending GST invoice generation" banner and the "New invoice" button pop in, pushing the table down about 75 px. A click aimed at a row menu landed on the wrong place during this audit. |
| Mobile (375 px) | Desktop layout shrunk to unreadable size, plus a "Not able to connect server" toast. Zoho relies on its native app. | Real mobile layout with a bottom tab bar, stacked cards, no horizontal scroll. But "New invoice" appears twice (header button plus FAB), the FAB covers card text, and the first invoice row is below the fold. |
| Dark mode | Not checked: no visible toggle in the header. | Toggle in the header; good contrast overall. It **ignores the OS setting** (`prefers-color-scheme: dark` with no saved choice still renders light). The "fill missing costs" link under Margin MTD is dim red on dark. |
| Keyboard | Enter selects in item pickers. "/" for search did not work in our test. | Ctrl+K palette, Alt+A "Add item" on the quote. **Ctrl+Enter does not save forms**; Save is only a mouse target, and the customer form shows it at the top and bottom only. |
| Speed feel | 2 to 5 s per screen; customer picker search was slow (spinner over 4 s). | Dev-mode inflated: 5 to 12 s per navigation, and save→redirect of about 10 s with only a toast. Needs a production-build check before any judgement. The missing progress feedback is a real issue either way. |
| Next-step button | "What's next?" banner on every invoice and quote. | Good on customer and quote ("Next best action", stepper). Missing after saving a customer (no immediate redirect) and after a credit note. |

---

## 2. Top 15 UX improvements for our app (ranked by daily time saved)

Paths are relative to `<repo>/production/src`.

### 1. Instant navigation feedback, and keep the sidebar mounted
- **Screen:** every page (sidebar and top bar).
- **Files:** `app/(app)/layout.tsx`, `app/(app)/loading.tsx`, the sidebar component under `components/layout/`.
- **Change:**
  - Show a top progress bar and highlight the clicked nav item the moment it is clicked (`useLinkStatus` / `useTransition`).
  - Render the sidebar from the static nav (`lib/nav.ts`) without waiting for the user/org query. Show only the org name as a skeleton.
- **Accept:**
  - The clicked item highlights in under 100 ms and the progress bar is visible until the route paints.
  - On a hard reload the nav items are visible on the first paint, not "Loading…".

### 2. Fix "₹38,232 /month" on monthly-billed annual quotes
- **Screen:** Quote detail → Totals breakdown.
- **File:** `app/(app)/quotes/[id]/page.tsx` ~L1555–1568.
- **Change:** when `billing_cycle === "monthly"` and the lines are annual commit, show "₹3,186 /month · ₹38,232 /year" (per-instalment first). Never append "/month" to a yearly total.
- **Accept:** for Q-XXXX-27-0068 the Totals card reads ₹3,186/month and ₹38,232/year. A unit test covers the annual × monthly, monthly × monthly and annual × yearly cases.

### 3. One "Convert to invoice" / next-step button on the quote
- **Screen:** Quote detail action bar.
- **Files:** `app/(app)/quotes/[id]/page.tsx`, `components/features/quotes/activate-on-credit-dialog.tsx`.
- **Change:**
  - Replace the 3 separate clicks (Mark as sent → Mark accepted → Record payment or Activate) with one primary button that names the next state ("Accepted — raise invoice / record payment"), as Zoho's "What's next?" does.
  - Hide or disable "Activate now, pay later" for monthly-instalment quotes instead of showing it and then rejecting it with a toast.
- **Accept:**
  - From a sent quote, an invoice or first payment request exists after at most 2 clicks.
  - A monthly quote never shows an action that only produces an error toast.

### 4. One balance per customer: Overview and Statement must agree
- **Screen:** Customer profile (Outstanding card and Statement tab).
- **File:** `components/features/customers/customer-profile.tsx`.
- **Change:**
  - Compute both from one function, so they show the same figure.
  - If some money is "advance received, invoice not raised yet", show it as one labelled line in both places, e.g. "Advance ₹1,554 against instalment 1, ₹1,632 still due".
- **Accept:** for Customer A the Outstanding card and the Statement closing balance show the same number with the same sign.

### 5. Statement: period picker, PDF and "Send to customer"
- **Screen:** Customer → Statement tab.
- **File:** `components/features/customers/customer-profile.tsx` (statement section). Reuse `lib/pdf/`.
- **Change:**
  - Add This month / Last month / FY / custom range.
  - Add Download PDF and a Send (email/WhatsApp) button that stops at a preview.
- **Accept:** a user can produce and preview a dated statement PDF in at most 3 clicks from the profile.

### 6. P&L: every number drills, and the drill totals tie out
- **Screen:** `/accounting/pnl`.
- **Files:** `app/(app)/accounting/pnl/page.tsx`, `components/features/accounting/pnl-drilldown-dialog.tsx`.
- **Change:**
  - Make each category row (Google Workspace, Software projects …) open the drill filtered to that category.
  - Show the modal total **in the same basis as the clicked figure** (taxable, net of credit notes). Add a footer line: "₹19,08,044 incl. GST − ₹2,49,049 GST − credit notes = ₹15,13,212".
- **Accept:**
  - Clicking any amount opens a list whose total equals that amount.
  - Fully credited invoices show as net ₹0.

### 7. Reconcile: a queue on the first screen and a one-click "Match"
- **Screens:** `/accounting/banking` and the account page.
- **Files:** `app/(app)/accounting/banking/page.tsx`, `app/(app)/accounting/banking/[id]/page.tsx`, `components/features/banking/reconcile-transaction-dialog.tsx`.
- **Change:**
  - Show "N lines to reconcile → Start" on the overview, across all accounts.
  - Make the whole card clickable ("View transactions" is a dead span today).
  - In the reconcile drawer, put the primary **Match / Save** button in the sticky footer, not inside the scrolled form.
  - Show the best match as one row with a Match button, as Zoho does.
- **Accept:**
  - From Banking, a suggested credit can be matched in at most 3 clicks with no scrolling.
  - The footer never says "use the button above".

### 8. Stop the invoices page from jumping after load
- **Screen:** `/invoices`.
- **File:** `app/(app)/invoices/page.tsx` (the "Pending GST invoice generation" banner and the header buttons).
- **Change:** reserve the banner's height, or render it below the table tabs. Render the "New invoice" button with the header, not after the data loads.
- **Accept:** Cumulative Layout Shift is 0.1 or less, measured by `PerformanceObserver('layout-shift')` on a cold load. The row ⋯ does not move after first paint.

### 9. List-plus-detail split view for invoices, quotes and customers
- **Screens:** `/invoices`, `/quotes`, `/customers`.
- **Files:** the list pages, plus a shared `components/shared/split-view` (new; ask Pardeep, because it is a shared component).
- **Change:** at 1280 px or wider, open the record in a right pane and keep the list (with its filters) on the left. Add ↑/↓ to move between records.
- **Accept:** a user can review 5 overdue invoices in a row without pressing Back or losing the filter.

### 10. TDS payment summary must not contradict itself, and the drawer must close on success
- **Screen:** Record payment drawer.
- **File:** `components/features/quotes/record-payment-dialog.tsx`.
- **Change:**
  - When net + TDS equals the amount due, the "What this does" box must say "settled in full (₹3,132 bank + ₹54 TDS receivable)", not "₹54 still outstanding".
  - After Confirm, close the drawer and show a toast naming the receipt (RV-…) with a "Record another" action. Do not re-open it as "Record additional payment".
  - Default the TDS rate from the customer's saved TDS profile.
- **Accept:**
  - Full-amount + 2% TDS shows "settled".
  - After saving, the drawer is closed and the stepper shows Paid or Part-paid.

### 11. Make payment frequency visible on the quote builder
- **Screen:** `/quotes/new`.
- **File:** `components/features/quotes/quote-builder.tsx`.
- **Change:**
  - Show "Billed: Yearly | Half-yearly | Quarterly | Monthly" as a visible segmented control next to the line's Commit select, not behind a "Change" link in the totals panel.
  - Give the select a real `<label>`; its accessible name is currently its value.
- **Accept:** a user can set annual commit + monthly billing without opening any hidden panel. Axe reports no unlabelled select on the page.

### 12. Phone search by digits
- **Screen:** Ctrl+K palette.
- **Files:** `components/layout/command-palette.tsx`, `lib/search/keywords.ts`.
- **Change:** index the company's own phone fields (work phone, mobile), not only `contact_phone`, through `phoneDigits()`. Make sure the palette's customer query selects those columns.
- **Accept:** the phone number as digits only, with a space, and with +91 all find Customer A.

### 13. One way to create a customer; searchable customer picker everywhere
- **Screen:** Subscriptions → Add Subscription modal.
- **File:** `components/features/subscriptions/add-subscription-dialog.tsx`.
- **Change:**
  - Replace the plain `<select>` of all customers with the existing `components/features/customers/customer-combobox.tsx`.
  - For a new customer, open the standard customer form (with GSTIN verify) in a side sheet, instead of the inline duplicate fields (name, domain, contact, email, phone, state, GSTIN).
- **Accept:**
  - Typing 3 letters filters customers.
  - A GSTIN entered for a new customer is verified exactly as on `/customers/new`.
  - No second customer form exists in the modal.

### 14. Save shortcuts and immediate post-save redirect on forms
- **Screens:** customer form, quote builder, payment and credit-note drawers.
- **Files:** `components/features/customers/customer-form-page.tsx`, `components/features/quotes/quote-builder.tsx`, and the drawers above.
- **Change:**
  - Ctrl+Enter (⌘+Enter) submits the primary action.
  - Keep a sticky footer with Save visible while scrolling.
  - Disable the primary button with "Saving…" until the redirect lands, so double submits are impossible.
  - Navigate optimistically to the new record.
- **Accept:**
  - Ctrl+Enter saves the customer.
  - Save stays visible at any scroll position.
  - No duplicate quote is possible by clicking Save twice during the redirect.

### 15. Plain English on the bank screens, and consistent "Customer" wording
- **Screens:** bank account page, customer pages.
- **Files:** `app/(app)/accounting/banking/[id]/page.tsx` ("Nikasi/Jama"), `components/features/customers/customer-profile.tsx` and `customer-form-page.tsx` ("Save company" vs "Customer added").
- **Change:**
  - Rename the columns to "Money out (Dr)" and "Money in (Cr)".
  - Pick one noun, "Customer", for the button, toast, breadcrumb and nav. Or, if "Company" is kept on purpose, use it in the toast too.
- **Accept:** a grep for `Nikasi|Jama` in the UI returns 0. The customer create flow uses one noun in button, toast and breadcrumb.

**Honourable mentions (smaller)**
- Credit-note drawer: say "Paid in full: crediting creates a refund/advance" instead of "Amount still owed ₹95,993" on a Paid invoice (`components/features/invoices/issue-credit-note-dialog.tsx`), and toast the CN number with a PDF link afterwards.
- Subscriptions table must fit 1280: collapse Seats, MRR and Margin into one column, and keep Status in view.
- Follow the OS dark-mode setting when the user has made no choice.
- Mobile `/invoices`: drop the duplicate header "New invoice" (keep the FAB) and move the invoice list above the KPI cards.
- AI reminder: include the invoice number(s) and pay link; add "Stop reminders" per customer.
- BRS: do not show "Reconciled" while bank and books differ.

---

## 3. What Zoho does badly that we must NOT copy

1. **Custom fields as a substitute for a model.** Business Type, Subs Period, Total Licences and Service Expiry Date are required on every quote and recurring invoice. They duplicate the line quantity and dates (one fact in two places) and are typed by hand. Keep commitment, frequency, seats and dates as real fields.
2. **Module-scoped search that needs Enter.** "Search in Customers" cannot find an invoice number. Keep our cross-entity, live Ctrl+K palette.
3. **Wrong defaults:**
   - Recurring "Repeat every: Week".
   - TDS account "Advance Tax".
   - TDS as a typed amount with no % calculation.
   - Customer picker search that spins over 4 s.
   Defaults must match how a reseller works (monthly or annual, TDS receivable, % with auto amount).
4. **"Are you sure?" before even opening a form.** The credit-note confirm modal appears before the form loads. Confirm only at the irreversible step, and explain the consequence there, as our CN drawer does.
5. **Hiding key features in menus or URLs.** Recurring Invoices is not in the Sales menu, and Credit Note is buried in ⋯. Our row-menu "Issue credit note" is better; keep primary actions visible.
6. **Desktop-only web.** On a phone, Zoho's web app is unusable and errors out. Keep our responsive layout.
7. **Wide tables with off-screen columns.** The Quotes list, invoice list and quote item table scroll sideways, and Status sits past the edge. Do not copy that density; our subscriptions table already has the same problem (see the honourable mentions above).
8. **Template sloppiness.** "overdue by 1 days", plus all-caps red threat text in the reminder email. Keep reminders short, polite, correct, and with a pay link.
9. **Required custom-field tabs on the customer form** ("Custom Fields*"): a hidden tab that blocks save. Never require a field the user cannot see.
