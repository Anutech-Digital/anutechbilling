# Zoho Books vs our Billing app: Accountant, GST & compliance, reports, UX

Audit date: 31 Oct 2026. Read-only audit, with no code, board or DB changes.
Code read from `anutech/manager-pardeep` @ `cb40226d1` (fetched 31 Oct 09:08 IST) with `git grep`/`git show`. All file paths below are relative to `production/`.
Zoho facts come from Zoho's official help docs: `zoho.com/books/help/llms.txt`, `zoho.com/in/books/help/llms.txt`, and the pages under accountant/transaction-lock, accountant/bulk-update, accountant/manual-journal, reports/manage-reports, reports/custom-reports, reports/activity, in/gst/filing-approval, in/gst/gstr1-filing, in/gst/gst-filing (3B), in/gst/ims, and in/settings/tds-and-tcs-updates.
I did not open the real Zoho org in a browser. The docs were enough for this area.
Board cards read: R-2156, R-2171, R-2173, R-1823.

Verdict key: **we-better** / **parity** / **gap** (ours exists but is weaker) / **missing** / **n/a** (does not apply to a SaaS reseller).
Impact runs from 1 to 5 (5 = money or compliance risk now). Effort: S ≈ 1 day, M ≈ 2–4 days, L ≈ 1–2 weeks.

---

## 1. Headline findings

1. **The transaction lock exists. The "no transaction lock" pain is out of date.** We have `tenants.books_locked_until` plus the trigger `tg_books_locked` on about 26 money tables (`supabase/migrations/20260927120000_books_lock.sql`, extended in `20261018195438_r1584_books_lock_more_tables.sql:130-165`). Only the owner or the accountant can set it (`20261017002400_r1132_books_lock_accountant.sql`), and only the owner can lift it. What is still weak compared with Zoho:
   - There is no reason field and no log when the lock is set or lifted.
   - There is no partial unlock (a dated window plus a reason).
   - The block message is still in Hinglish and names the raw table (`r1584…sql:133`, e.g. "Books … tak lock hain (vendor_bills · …)"), which breaks our English-UI rule.
   - The lock is bypassed by the service role. Imports and crons write into locked months silently.
   - I did not check whether the lock is actually *set* on staging or live. If it is null, it protects nothing.
2. **The P&L drill-down is not filtered by row (confirmed).** The product sub-rows call `onOpen={() => setDrill("revenue")}` and `onOpen={() => setDrill("cogs")}` and drop the row (`src/app/(app)/accounting/pnl/page.tsx:331-333` and `:370-372`). Only expenses pass a category (`:403`). `PnLDrillKind` is just `"revenue" | "cogs" | "expenses"` (`src/components/features/accounting/pnl-drilldown-dialog.tsx:38`). This is why the Microsoft 365 row opens all 197 invoices (R-2156 alsoDo).
3. **Migration revenue is misclassified (confirmed).** `public.revenue_family()` takes the **item vendor first** (`supabase/migrations/20261024110239_r1835_pnl_revenue_by_product.sql:49`). A "migration to Google" sold on the M365-migration item therefore lands in Microsoft. There is no vendor-neutral "Services / Migration" family and no bulk reclassify (Zoho has Accountant → Bulk Update).
4. **Invoice dates bunched on the entry date (R-2173).** 88 staging invoices are dated 29–30 Oct, and 12 of them belong to Apr–Sep receipts. There is no safe "correct invoice date" action, and no **per-period "GST return filed" record** to guard it. The month-close tick is a checklist row (`month_close_checks`), not a return-filing record with an ARN or date that other code can trust.
5. **GST filing readiness: strong worksheets, but no filing pipe.** We build GSTR-1 tables plus the portal JSON (`src/lib/gst/gstr1.ts:260`, download at `src/app/(app)/accounting/gst/page.tsx:237-244`), the HSN summary (`gstr1.ts:209`), a 3B worksheet including RCM 3.1(d) (`src/lib/gst/gstr3b.ts:14`), 2B reconcile (`src/lib/gst/gstr2b.ts`), a compare of the filed GSTR-1 JSON against our books (`gst/page.tsx:461`), and invoice GST checks (`src/lib/gst/mismatch.ts:103`). Missing:
   - Push to GSTN and file with OTP.
   - IMS (Invoice Management System) accept/reject.
   - e-invoice IRN. The code says "does NOT generate IRNs yet, R-044 waiting on GSP" (`src/lib/compliance/einvoice.ts:11`).
   - GSTR-9.
   - A single "ready to file" verdict per period.
6. **New compliance risk: TDS under the Income Tax Act 2025.** ITA 2025 replaced ITA 1961 on 1 Apr 2026 and renumbered the TDS sections. Zoho ships an auto-migration (end-dating the old rates on 31 Mar 2026). Our 26Q rates still use 1961 codes (`src/lib/accounting/tds-rates.ts:19-24`: 194C/194J/194I/194H/194A/194Q, labelled "FY 2026-27"), and `tds-26q.ts:90` defaults to "194Q". The partner split already uses s.393(3) (`src/lib/accounting/partner-appropriation.ts:18`), so the codebase is inconsistent. This needs CA confirmation of the exact codes the FY 26-27 return utility expects.
7. **Architecture difference to state honestly.** We are single-entry "books-lite", not double-entry: "har record apni table me hai, journal nahi" (`src/lib/accounting/trial-balance.ts`, header). There is no chart of accounts, no manual or recurring or reverse journals, and no fiscal-year close. The TB/BS balance through a labelled "Difference — opening capital & retained earnings b/f" plug, plus `balance_sheet_items` and `opening_balances`.
   - This is a deliberate trade-off and it serves the owner well.
   - The cost is that a CA cannot post an adjusting entry (accrual, provision, depreciation true-up, forex) anywhere except "manual BS line" or Tally.
   - **Do not rebuild Zoho's full general ledger.** Add a narrow "Adjustment entry" (see #8 in the top 10).

---

## 2. Capability table

| # | Capability | Zoho Books (India) | Ours (file:line) | Verdict | Impact | Effort |
|---|---|---|---|---|---|---|
| **A. Accountant** |
| 1 | Chart of accounts | Full CoA, sub-accounts, account types, import | None. Fixed heads: expense categories `src/lib/accounting/expense-categories.ts`, GST heads `gst-heads.ts`, BS heads via `report_balance_sheet` | missing (by design) | 2 | L |
| 2 | Manual journals | Manual, recurring, reverse journals, journal templates, 13th-month adjustment journal | None. Manual BS lines (`balance_sheet_items`) only. "journal" appears only in day-book/TB comments | missing | 3 | M (narrow adjustment entry) |
| 3 | Opening balances | Per-account opening balances at the migration date | `opening_balances` table (locked via r1584), opening invoices (`src/app/(app)/invoices/opening-invoice-detail.tsx:5`), opening capital / RE on the BS page | parity (for our scope) | 2 | – |
| 4 | Transaction locking | Lock per module (Sales / Purchases / Banking / Accounts) or all. **Reason required** to lock and unlock. **Partial unlock** for a date range with a reason. Can be disabled | Single date `tenants.books_locked_until`, DB trigger on about 26 tables (`migrations/20260927120000_books_lock.sql`, `20261018195438_r1584…sql:130-165`). Owner/accountant lock, owner-only unlock (`20261017002400_r1132…sql`). UI `src/components/features/accounting/books-lock-card.tsx`. Hinglish error at `r1584…sql:133`. No reason, no log, no partial unlock. Service role bypasses it | gap (strong core, weak edges) | 4 | S + M |
| 5 | Fiscal-year close | No formal close. Retained earnings are automatic | No close. RE b/f is a plug / manual entry. Month-end close checklist `src/lib/accounting/month-close.ts:10` (auto + manual ticks, lock as the final step) | we-better (month close) / gap (year close) | 2 | M |
| 6 | Bulk update (reclassify) | Accountant → Bulk Update: filter transactions, move them to another account, with history | Bulk bars on expenses and invoices (`src/app/(app)/accounting/expenses/page.tsx`, `src/app/(app)/invoices/page.tsx`). No reclassify for revenue family or expense category with history | gap | 4 (migration revenue pain) | S–M |
| 7 | Reconcile accounts | Bank reconcile. Account reconcile for non-bank accounts | Bank BRS `src/app/(app)/accounting/banking/brs`, rules `banking/rules`, Google bill check `accounting/google-bill-check`, vendor statement `src/lib/accounting/vendor-statement.ts`, TDS 26AS match `src/lib/accounting/tds-26as.ts` | we-better (reseller-specific) | – | – |
| 8 | Currency adjustment / forex | Base-currency adjustment, realised and unrealised forex gain/loss | None. A USD receipt leaves a false INR due (R-2171, R-1678) | missing | 3 | M |
| 9 | Budgets | Budgets vs actuals | None | missing | 1 | M |
| 10 | Fixed assets / depreciation | Fixed assets module | `accounting/assets`, `src/lib/accounting/depreciation.ts` | parity | – | – |
| 11 | Export to CA software | DATEV (EU). Tally migration *into* Zoho | Tally XML day book `src/lib/accounting/tally-vouchers.ts:92`, party ledger `ledger-export.ts` | we-better (India) | – | – |
| **B. GST & compliance** |
| 12 | GSTR-1 | Push to GSTN, file with OTP, failed-transaction re-push, pull e-invoice data, mark unfiled | Section builder + portal JSON + offline CSV (`src/lib/gst/gstr1.ts:260`, download `src/app/(app)/accounting/gst/page.tsx:237-244`). Filed-JSON vs books compare (`gst/page.tsx:461`, `src/lib/gst/gstr1a.ts`) | gap (no direct filing) | 3 | L (GSP) |
| 13 | GSTR-3B | Summary, mark previous filed, ITC reversed / reclaim, push, record tax paid, file | Worksheet with 3.1(a)(b)(d), 3.2 (`src/lib/gst/gstr3b.ts`), tax payments `src/lib/accounting/tax-payments.ts` | gap (copy-paste filing) | 3 | L |
| 14 | Return filing status per period | "Mark as Filed" / "Mark as Unfiled" per return per period. **Filing approval workflow** (up to 5 approvers) | Only a tick in `month_close_checks` (`migrations/20260927200000_month_close.sql:9`). No ARN, no unfiled state, nothing other code can query | gap | 5 (guards R-2173 and the lock) | M |
| 15 | GSTR-2B / IMS | 2B reconcile. IMS pull, accept/reject/pending, push | 2B JSON upload reconcile `src/lib/gst/gstr2b.ts` (matched / differs / only-in-2B / only-in-books). No IMS | parity (2B) / missing (IMS) | 2 | M |
| 16 | GSTR-9 annual | Built in | None | missing | 2 | M |
| 17 | e-Invoicing (IRN/QR) | Auto IRN + QR on save, cancel within window, sandbox | Warnings only by AATO bracket (`src/lib/compliance/einvoice.ts:11`, `src/components/features/compliance/turnover-card.tsx:56`). R-044 GSP pending | missing (required only above ₹5 Cr AATO) | 2 now / 5 when over ₹5 Cr | L |
| 18 | e-Way bill | Generate, multi-vehicle | Not built | n/a (services only) | 0 | – |
| 19 | HSN/SAC summary | HSN per item | SAC 998313 constant `src/lib/gst/hsn.ts:6`. HSN table per catalogue item `gstr1.ts:209` | parity | – | – |
| 20 | GSTIN validation | Format check + fetch details | Checksum `isValidGstin` (`src/lib/utils`), GSTN lookup via Sandbox `src/lib/compliance/gst-registration-server.ts`, `src/lib/gst/gstin-details.ts` (R-2168) | parity | – | – |
| 21 | Reverse charge | RCM tax on bills, 3B | 3B 3.1(d) imported services (Google Ireland / Meta / AWS) `src/lib/gst/gstr3b.ts:14`, bill ITC `src/lib/gst/bill-itc.ts` | parity | – | – |
| 22 | Exports / LUT | Export invoice with/without payment, LUT | LUT reminders (`src/lib/compliance/obligations.ts`, R-334), `src/lib/gst/export-lut.ts`. But overseas invoices come out as "B2C invoice", dated today, with a 49-country list (R-2171) | gap | 3 | M |
| 23 | Filing readiness | Implicit (push errors appear at filing) | `auditInvoiceGst` `src/lib/gst/mismatch.ts:103`, credit-note deadline `src/lib/gst/credit-note-deadline.ts`, month close. No single per-period "ready" verdict | gap (parts exist) | 5 | M |
| **C. TDS & audit trail** |
| 24 | TDS payable returns | TDS liabilities, challans, **ITA 2025 section auto-migration** | 26Q rows `src/app/(app)/accounting/expenses/tds-26q.ts:62`, 24Q `accounting/salary-register/tds-24q.ts`, due dates `src/lib/compliance/tds-due.ts`. **1961 section codes for FY 26-27** (`src/lib/accounting/tds-rates.ts:19-24`) | gap (compliance) | 4 | S |
| 25 | TDS receivable / certificates | Income TDS on invoices | TDS receivable + 26AS match + Form 16A tracking + year-end (`accounting/tds-receivable`, `src/lib/accounting/tds-26as.ts`, `tds-match.ts`, `tds-mismatch.ts`) | we-better | – | – |
| 26 | Audit trail | Activity log report with audit trail (history of changes), export | `activity_log.changes` old→new per column, deleted row kept whole (`migrations/20260927150000_audit_log_values.sql`). Viewer `src/app/(app)/activity/page.tsx` (owner/manager). Fires only for signed-in users, so imports and crons are invisible. Lock changes not logged | gap (MCA Rule 3(1) needs a non-disableable trail for *all* edits) | 4 | M |
| **D. Reports** |
| 27 | P&L | P&L, compare periods, drill to transactions, cash/accrual basis | Rich P&L `src/app/(app)/accounting/pnl/page.tsx`: compare, waterfall, product split (`report_pnl_revenue_by_product`), honest "unknown" rows, COGS estimate (R-2095). **Sub-row drill not filtered** (`:331-333`, `:370-372`). **COGS by bill date, not service month** (R-2156) | gap (trust) | 5 | S (drill) / L (matching) |
| 28 | Balance sheet | Standard | `accounting/balance-sheet`, `src/lib/accounting/balance-sheet-totals.ts`, equity section, partner split | parity | – | – |
| 29 | Cash flow | Cash flow statement | `accounting/cash-flow`, `src/lib/accounting/cash-flow-lines.ts` | parity | – | – |
| 30 | Trial balance / day book / ledger | Standard | `accounting/trial-balance`, `day-book`, `ledger` (Dr/Cr, CA format) | parity | – | – |
| 31 | AR/AP ageing | Ageing summary and details | `accounting/aging`, `src/lib/accounting/receivables-due.ts`, MSME 45-day `src/lib/accounting/msme.ts` | we-better (MSME) | – | – |
| 32 | Sales by customer / item | Many sales reports | Per-customer profitability `accounting/profitability`, revenue by product family, SaaS metrics `accounting/saas-metrics` | parity | – | – |
| 33 | Custom report builder | Create/clone custom reports, show/hide columns, layout, share with users | None (fixed pages). Reports hub `src/app/(app)/reports/page.tsx` is MRR/funnel | missing | 2 | L |
| 34 | Scheduled reports | Schedule any report by email, weekly summary, role-based report access | Only the owner digest (`src/lib/digest/owner-digest.ts`) and the error digest (`src/lib/automation/jobs.ts:49`) | missing | 3 | M |
| 35 | Report export | PDF/XLS/CSV with layout configuration | Print `src/lib/reports/print.ts`, CSV/XLSX on ledger and banking, export log (`logExport`) | parity- | 2 | S |
| 36 | Dashboards | Home dashboard widgets | Accounting overview `src/app/(app)/accounting/page.tsx`, `/today`, P&L charts | parity | – | – |
| **E. Cross-cutting** |
| 37 | Roles / permissions | Users and roles, custom roles, per-module rights | Fixed roles owner/manager/billing/accountant enforced in DB (`current_user_has_role`) and nav (`src/lib/nav.ts`). No custom roles | parity- (fixed roles fit a small team) | 2 | – |
| 38 | Approvals | Transaction approval (simple / multi-level / custom), GST filing approval | Quote margin/discount approval. No GST-filing approval | gap | 2 | M |
| 39 | Workflow rules | Rules → email alert / field update / webhook / custom function, workflow logs | Fixed jobs `src/lib/automation/jobs.ts` with run history and a gate. No user-defined rules | gap (deliberate) | 2 | – |
| 40 | Custom fields | On every module | None (only in the Zoho importer, `src/lib/integrations/zoho-books/api.ts`) | missing (deliberate) | 1 | – |
| 41 | Templates / branding | PDF and HTML templates, email templates | Invoice/quote PDF `src/lib/pdf`, company settings | parity- | 2 | M |
| 42 | Email / WhatsApp notifications | Email alerts. WhatsApp via integration | WhatsApp reminders (`src/app/(app)/marketing/whatsapp/reminders`), email digests | we-better (WhatsApp native) | – | – |
| 43 | Import / export / backup | Import every module, export, backup | Zoho Books importer `src/app/api/integrations/zoho-books/import/route.ts`, contacts, bank statements, `settings/backup` | parity | – | – |
| 44 | API / webhooks | Full REST API (read+write), outbound webhooks in workflows | `/api/v1/*` read-only. Scopes are only `read` and `telecalling` (`src/lib/api-keys/scopes.ts:12`). No outbound webhooks | gap | 2 | M |
| 45 | Multi-org | Multiple orgs per login, accountant "Manage clients" | One tenant per user | missing | 1 (2 for a CA firm) | L |
| 46 | Mobile | Native apps | Responsive web + `src/app/(app)/mobile` | gap | 2 | L |
| 47 | Search / shortcuts | Global search | Ctrl+K search-all, g-chords, j/k lists (`src/lib/keyboard/shortcuts.ts`) | we-better | – | – |
| 48 | Reporting tags / branches | Tags on transactions for reports | Product family only | missing | 1 | M |

### Where Zoho's UX is clearly better (copy the idea)
- **Every report number drills to exactly the transactions behind it, with the same filter.** Ours drills only at the top level (#27).
- **Lock with reason, plus partial unlock for a window.** A mistake in a closed month gets a short, logged, self-expiring window. It does not need a full unlock and re-lock (#4).
- **Mark return as Filed / Unfiled per period.** This is the anchor that every other "is this month closed?" check can read (#14).
- **Bulk Update with history** for reclassifying wrongly coded transactions before audit (#6).
- **Scheduled reports** (monthly P&L and ageing emailed to the owner and the CA) (#34).
- **Activity log as a filterable, exportable report per record** (#26).

### What NOT to copy
- **A full chart of accounts or journal engine.** It is an L–XL rewrite of the BS/TB/P&L RPCs with high regression risk. Our single-entry design plus honest plugs is easier for the owner. Add a narrow adjustment entry and keep the Tally export as the CA's double-entry path.
- **Four module-wise lock dates.** One date plus partial unlock covers our team, and four dates breaks the "one way to do it" rule.
- **A generic workflow-rule builder and custom fields everywhere.** These break "one fact, one place" and "few steps". Keep coded jobs.
- **e-Way bill.** We sell services, so there is nothing to build.
- **Zoho's Push to GSTN *before* e-invoicing.** Zoho itself allows GSTR-1 filing only for orgs with e-invoicing enabled. The JSON download plus the filed-vs-books compare is enough below ₹5 Cr AATO. Revisit when the GSP decision (R-044) is made.

---

## 3. Top 10 improvements, ranked by value ÷ effort

Weights: impact (1–5) ÷ effort (S=1, M=2, L=4). Real pains get a boost.

### 1. P&L sub-row drill-down filtered by the row (impact 4, S). Part of R-2156 alsoDo
- **Spec:** Widen `PnLDrillKind` to `{ kind: "revenue" | "cogs"; family?: RevenueFamily; vendor?: string }`.
  - `SubRows onOpen={(line) => setDrill({kind, family: line.key})}` at `pnl/page.tsx:333` and `:372`.
  - The dialog filters invoice lines with the same `public.revenue_family()` SQL (pass `p_family` to the drill RPC; do not re-classify in TS).
  - COGS lines filter vendor bills by vendor.
  - The footer shows "Total ₹X = row ₹X". If they differ, show a red mismatch note. Never hide the gap.
  - The COGS drill also lists the R-2095 estimate rows, so the drill total equals the card total (the ₹34,167 gap in R-2156).
- **Test:** A Vitest component test with a 3-family fixture: clicking "Microsoft 365" shows only Microsoft rows, and the sum equals the row amount. A COGS drill with an estimate includes the estimate row. A Playwright check on localhost Excel Oct: the M365 row opens 15 invoices, not 197.

### 2. TDS sections under the Income Tax Act 2025 (impact 4, S). Confirm codes with the CA first
- **Spec:** `tds-rates.ts` becomes date-effective: `{ section1961, section2025, ratePct, from, to }`.
  - Rows dated on or after 1 Apr 2026 show and export the 2025 section/payment code. Older rows keep 1961.
  - 26Q/24Q builders (`tds-26q.ts:62`, `tds-24q.ts`) read the code by the payment date.
  - The `"194Q"` default at `tds-26q.ts:90` moves into the table.
  - One code table only, shared with `partner-appropriation.ts`.
- **Test:** Unit test: an expense on 31 Mar 2026 gives 194J. The same expense on 1 Apr 2026 gives the 2025 code. 26Q rows for a mixed quarter carry both correctly.

### 3. Books-lock hardening, small part (impact 3, S)
- **Spec:**
  - The English message in `tg_books_locked`: "Books are locked up to {date}. This {friendly name: Vendor bill / Invoice / Bank line} dated {d} is in a locked month. The owner can open a window on Accounting → Month-end close." Use a `table → label` map in SQL.
  - `set_books_lock(p_until, p_reason)` writes `activity_log` (old → new date, reason). Reason is required when the lock moves back.
  - The lock card shows the last 5 lock changes.
  - Add an alert on the overview when the lock is null and a GST month is filed (until #5 lands, use the month-close tick).
- **Test:** A pgTAP-style SQL test (pattern of `supabase/tests/books_lock.test.sql`): the error text has no Hinglish and no raw table name. Moving the lock back without a reason raises. A log row exists after each change.

### 4. Vendor-neutral service family + bulk reclassify with history (impact 4, S–M). Fixes the migration revenue pain
- **Spec:**
  - Add a `services` family (migration, setup, support-time) to `public.revenue_family`. A line whose text matches `migrat` → `services`, **before** the vendor rule (`r1835…sql:49`).
  - Add a catalogue item "Email migration (service)" with vendor `null`.
  - Accountant → "Reclassify lines" lists invoice lines filtered by family/text/date, select many, set `revenue_family_override` on the line, with a reason.
  - The override is respected by the SQL function, logged to activity, and blocked inside the locked period.
  - The P&L split re-adds to the total (existing guard in `revenue-family.ts`).
- **Test:** SQL test: the line "Migration from M365 to Google Workspace" is classified `services`. The override wins. The override in a locked month is refused. P&L family sums still equal `report_pnl` revenue.

### 5. GST return filing register + "ready to file" verdict (impact 5, M)
- **Spec:**
  - New table `gst_return_filings(tenant_id, return_type 'GSTR1'|'GSTR3B'|'CMP08'|'GSTR9', period, status 'not_filed'|'filed', filed_on, arn, filed_by, unfiled_reason)`.
  - "Mark as filed" (with ARN, optional upload of the filed JSON, which reuses the `gstr1a` compare) and "Mark as unfiled" (owner, with reason).
  - The GST page header per period shows a readiness checklist computed from existing libraries:
    - invoices missing GSTIN/POS (`mismatch.ts`);
    - B2B with an invalid GSTIN;
    - invoices dated after the receipt or **bunched dates** (more than N invoices on one day whose receipts fall in other months), which is exactly the R-2173 signal;
    - credit notes past the deadline;
    - 2B not reconciled;
    - HSN summary built;
    - books lock behind the period.
  - Green/amber/red. "Mark filed" offers "Lock books up to {period end}".
  - Month close reads this table instead of its own tick.
- **Test:** Unit test on the readiness evaluator with fixtures for each red reason. A SQL test that marking filed twice is idempotent and that unfile requires the owner plus a reason. On localhost September: 12 "other-month" invoices flag amber "dates bunched on 29–30 Oct".

### 6. "Correct invoice date" owner action, as decided in R-2173 (impact 5, M). Depends on #5
- **Spec:**
  - An RPC `correct_invoice_date(p_invoice, p_new_date, p_reason)`, owner only.
  - Allowed only if both the old and the new month have GSTR-1 `not_filed` (from #5) and both are after `books_locked_until`.
  - Refused if an IRN exists or the invoice was emailed (then only a credit note).
  - If the financial year changes, re-number within the target FY series.
  - Writes activity_log (old → new, reason).
  - Then a staging repair run on the 88 invoices (owner decision, listed under R-1823).
- **Test:** A SQL test matrix covering unfiled → ok, filed → refused, locked → refused, IRN → refused, FY change → new number in the right series. The P&L month totals move. Localhost first.

### 7. Audit trail report covering every writer (impact 4, M). Statutory: MCA Rule 3(1)
- **Spec:**
  - `log_row_change` also logs service-role writes with `actor = 'system:<job>'` (set via `set_config('app.actor', …)` in crons and imports) instead of skipping them.
  - Add triggers to `invoices`, `payments`, `vendor_bills` and `expenses` if any of these are missing.
  - The Activity page gains filters (record type, record id, user, date, action) and a per-record "History" drawer opened from the invoice, bill and expense pages.
  - CSV export.
  - The activity_log policy forbids delete and update for everyone.
- **Test:** SQL test: an update by the service role creates a log row with the system actor. Delete on activity_log is refused for the owner. A component test: the invoice "History" lists the date change from #6.

### 8. Narrow "Adjustment entry" for the CA (impact 3, M)
- **Spec:**
  - One screen: date, from-head → to-head (from the fixed head list used by the BS/P&L: e.g. "Provision for expenses", "Forex gain/loss", "Depreciation adjustment", "Prior-period income"), amount, narration, optional auto-reverse on the 1st of next month.
  - Stored in `adjustment_entries`, read by `report_pnl` and `report_balance_sheet`, books-locked, audit-logged, exported to Tally as a Journal voucher.
  - This is *not* a chart of accounts.
- **Test:** A SQL test that the P&L and BS both move by the amount and the TB difference line is unchanged. The lock applies. The Tally XML contains a JOURNAL voucher with balanced Dr/Cr.

### 9. Scheduled reports to owner and CA (impact 3, M)
- **Spec:**
  - A new automation job `report-schedule`, monthly on the 3rd at 09:00 IST: P&L (both views once #10 lands), AR ageing, GST readiness for last month, TDS due.
  - Emailed as a PDF (`src/lib/reports/print.ts`) plus CSV to recipients set in Settings → Company (owner plus the CA email).
  - Reuse the owner-digest HTML and the gate and run history.
- **Test:** A unit test for the schedule calculation (IST, month boundary). A job test with mocked mail asserting 4 attachments and recipients. A manual run from the automation page on localhost.

### 10. P&L management (matched) view, as decided in R-2156 (impact 5, L)
- **Spec:** As in R-2156:
  - The vendor bill gets `service_from` / `service_to` (default = previous month for Google/Microsoft portal bills, parsed from a reference like "Google Portal Bill (Aug 2026)").
  - COGS goes to the service month. A missing month shows an accrued estimate from the subscription book, marked, and replaced when the bill arrives.
  - Prepaid multi-month revenue is spread evenly, with the unearned part as "Advance billing" on the BS.
  - A toggle "Management (matched)" (default for the owner) versus "As invoiced (GST)" (CA). The drill-down obeys #1.
- **Test:** The R-2156 howToCheck on localhost Excel Oct: the Aug Google bill moves to Aug COGS, Oct shows the estimate, a yearly invoice gives 1/12 per month, drill totals equal card totals, and the GST view is byte-identical to today.

**Also on the list (valuable, but behind the ten above):**
- Forex gain/loss on USD receipts and export invoices under LUT (R-2171, R-1678): impact 3, M.
- Partial unlock window (owner, from–to, reason, auto-expires in 48h) on top of #3: impact 3, M.
- GSTR-9 worksheet: impact 2, M.
- IMS accept/reject: impact 2, M.
- e-invoice via GSP (R-044): only when AATO approaches ₹5 Cr.
- Write scopes and outbound webhooks for the API: impact 2, M.

---

## 4. Notes for Pardeep
- **Before telling anyone "we have no lock", check whether `books_locked_until` is actually set on staging and live.** If it is null, set it up to the last filed GSTR-3B month. That is a decision for you, not code.
- Items #1–#4 are about one day each and remove three of the five real pains (drill-down, migration revenue, lock gaps) plus a new compliance risk (ITA 2025 TDS codes).
- #5 and #6 together fix invoice-date bunching safely. Build #5 first, because R-2173's decision already assumes a "GSTR-1 filed flag" that does not exist yet.
