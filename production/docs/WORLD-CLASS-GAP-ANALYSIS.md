# ResellerOS — World-Class Gap Analysis

**Date:** 2026-08-09
**Method:** 5 parallel code-cited UX studies of the live app (working dir `production/`), across 5 lenses:
onboarding/first-run/trust · navigation & IA · money-spine workflow · human-behaviour/psychology · visual polish & design-system.
**Audience lens:** non-technical Indian cloud-reseller SME owner — Hinglish, WhatsApp-native, distrustful of software that touches money, works in short bursts on phone + desktop.

**Compass:** money-correctness is now the *finished* layer (audit done, invariants locked). The gap to world-class is no longer *correctness* — it's **delivery, trust-signalling, and polish**. This doc is the map for that phase.

---

## Verdict (honest, one line)

The money-spine (**lead → quote → pay → customer**) is genuinely near world-class. The app stops being world-class **after the money lands** and **outside the desktop screen** — the invoice can't be delivered, the app never reaches the owner's phone, and a set of fake/stub/jargon/dark-mode issues quietly leak "this software is unfinished."

Nothing here is a rebuild. These are **finishing moves**.

---

## What's already at the bar (do NOT regress)

- **Honest money handling** — prospect→customer activation notice, overpayment saved as advance credit (not lost), truthful "no subscription created" warning, stub-mode honesty on reminders, atomic `record_payment_with_tds`. This is exactly what earns a distrustful owner's trust.
- **Celebration moments** — 🎉 toasts on payment/renewal/full-paid; data-driven `GettingStartedCard` with real ✓ ticks.
- **A real "what to do today"** — dashboard Today's Focus + "Chase the cash" + Coming Up. Strongest habit hook already present (it just needs to *push*, not wait to be visited).
- **Leads screen is WhatsApp-native** — one-tap Call (`tel:`) + free `wa.me` share. This is the model the money screens must copy.
- **Customer-facing quote-accept** — accept / request-changes / pay-online (Razorpay) / print, with correct messaging when Razorpay isn't wired.
- **Design foundation** — token system, primitives (`Button/Badge/Card/KPI/StatStrip/EmptyState`), `rupee()`/`num()`, global `:focus-visible`. World-class-capable; the problem is uneven *adherence*, not the system.
- **Reference-quality pages (the internal bar):** `customers`, `customers/[id]`, `projects`, `quotes`, `invoices`, `payments`, `subscriptions`, `contacts`. Match everything to `customers/page.tsx`.

---

## The gaps — ranked by "what blocks world-class"

Themes that surfaced in **multiple** lenses are ranked highest (independent confirmation = real).

### TIER 1 — Money-trust + reach (blocks world-class directly)

#### 1. The invoice cannot be delivered to the customer — the spine dead-ends at "Download PDF"
*(money-spine #1, human-behaviour #2/#3, nav — cross-confirmed by 3 lenses → the single biggest gap)*
- Quotes have a full send suite (email dialog, WhatsApp dialog with PDF attach, copy-link). The **tax invoice has none** — the only "send"-shaped button on the invoices list (`invoices/page.tsx:828`, "Send reminder") just navigates to the customer page and sends nothing. `tax-invoice-dialog.tsx:181-210` toolbar = Download PDF + Close only.
- For a WhatsApp-first reseller, the tax invoice **is** the thing customers nag for ("bhai invoice bhejo"). The app coaches beautifully to the invoice, then abandons him to download + manually re-attach in WhatsApp — the exact friction he uses pen-paper to avoid.
- **Fix:** Reuse the existing `SendWhatsAppDialog` + `SendQuoteDialog` on the invoice (list row, detail, and the "fully paid → invoice generated" success toast). Attach the PDF (renderer exists in `lib/pdf`).

#### 2. WhatsApp share is gated behind the paid Meta Cloud API — which is "Not setup" on day 1
*(human-behaviour #3)*
- `send-whatsapp-dialog.tsx:99-104` uses Cloud API with a "24-hour window" caveat; dashboard shows `WhatsApp (Gupshup): Not setup`. Meanwhile leads use a free `wa.me` deep link that *just works* (`leads/page.tsx:1234`).
- On day 1 the owner has NOT done the multi-week Meta BSP verification, so the flagship "Send via WhatsApp" on money docs silently fails while the humble leads screen works — he concludes the feature is broken.
- **Fix:** Default quote/invoice WhatsApp share to the **free `wa.me` deep link** (prefilled Hinglish text + "attach the PDF"). Cloud API becomes an optional automation upgrade, not a prerequisite.

#### 3. The app is pull-only — it never reaches the owner where he lives
*(human-behaviour #1/#8)*
- No web-push / FCM / WhatsApp-to-owner anywhere. Crons email *customers*, never the owner. The notification bell sources only tasks + new leads — **overdue receivables and renewals-due are absent from the one proactive surface.**
- This persona works in bursts and lives in WhatsApp notifications. A CRM he must *remember* to open becomes a passive DB he abandons by week 3. Habit is built by the tool initiating contact.
- **Fix:** Daily/weekly **WhatsApp digest to the owner's own number** ("Aaj ka kaam: 2 renewals · ₹45k collect karna hai · 1 hot lead thanda ho raha") on existing plumbing. Feed overdue receivables + renewals-due into the notification bell. This one change turns a database into a daily ritual.

#### 4. Honesty violations on money screens (directly break the co-pilot charter)
*(human-behaviour #5, onboarding #2/#3)*
- **Fabricated reason:** `renewals/page.tsx:780` hardcodes *"low seat usage + poor NPS"* — but `renewalRisk()` explicitly *removed* NPS/login signals as fabricated. An owner who never collected NPS catches the lie → distrusts every number.
- **Fake integration success:** setup wizard marks Razorpay "set up" on a click that connects nothing (`setup/page.tsx:260,300`) → owner believes he can take live payments; trust collapses at the worst moment (a failed customer UPI).
- **Estimated margin shown as fact:** quote builder shows a confident "Your margin 25%" from a 70%-cost *assumption* with no "est." badge (`quote-builder.tsx:55`).
- **Fix:** Generate renewal copy from the *real* `risk.reasons[]`; gate green integration ticks behind a verified connection (honest fallback copy already exists); badge margin "Est." until a real per-line cost is entered.

#### 5. Fake / stub / dead buttons scattered across money screens
*(onboarding #1, money-spine #7, human-behaviour #10, visual-polish #7 — 4 lenses)*
- Setup wizard's **Import step is a total no-op** — the one step meant to create first value does nothing (no file input, "Load sample" loads nothing, template = "coming soon"). New owner lands on a still-empty dashboard → "product is broken."
- `renewals` Export → "coming soon"; `online-orders` Refresh → fake "Refreshed" toast, Export → does nothing, Automation rules → toast. A fake "Refreshed" is worse than no button.
- **Fix:** Wire the wizard Import to the already-built `import-customers-dialog` + a `seed_sample_data` RPC; ship the CSV exports (data is already in memory) or remove the buttons. **No stub toasts on money screens.**

### TIER 2 — Language, findability, mobile (blocks daily confidence)

#### 6. English/accounting jargon he won't parse
*(human-behaviour #4, nav #8)*
- MRR, ARR, "Receivables", "Churn risk", "Cadence", "write off as bad debt", "reconciliation", "Parent Accounts", "Customer Aging". MBA-English on the money screens makes the numbers feel like they belong to *the software*, not to *him*.
- **Fix:** Plain Hinglish-friendly labels with the English term as a small subtitle for the CA: MRR → "Har mahine ka pakka income"; Receivables due → "Paisa aana baaki / To collect"; Churn risk → "Chhodne ka risk"; Aging → "Kisne paisa dena hai"; Write off → "Doobt gaya".

#### 7. Global search & "record a payment" fail the daily money tasks
*(nav #1/#2)*
- Command palette placeholder promises "invoices…" but only searches leads/customers/quotes/contacts — **invoices, payments, subscriptions, items, projects return nothing.** And there is no first-class "Record a payment" or "Create invoice" action anywhere (palette quick-actions, or a FAB on `/payments`) — the #1 daily task is buried (Payments → find quote → open → pay).
- **Fix:** Wire invoices/payments/subscriptions/items into the palette (copy the Quotes block); add "Record payment" + "Create invoice" to palette Quick Actions and a FAB on `/payments`.

#### 8. Mobile is rep-shaped, not owner-shaped
*(nav #3/#4/#10, onboarding #4, visual-polish #8)*
- Owner gets the same bottom-nav tabs as a rep (Deals · Tasks) — money (Payments/Customers/Renewals) is a drawer-dig away. No mobile breadcrumb/back on detail pages. Money "why" tooltips are hover-only (dead on touch). Salary register has raw tables with no card fallback (§20 violation). Touch targets `h-8`/`h-9` (32-36px) below the 44px rule.
- **Fix:** Owner/manager bottom nav → money-first (Home · Payments · Customers · Renewals · More); compact mobile back+title header on detail pages; convert money tooltips to tap-popovers; card fallback for salary register; bump mobile touch targets to ≥44px.

### TIER 3 — Polish & consistency (the "same app" feeling)

#### 9. Dark mode is visibly broken on the "older cohort" pages
*(visual-polish #1)*
- Dark mode is a *shipped* feature (topbar toggle + `enableSystem`), but ~47 numeric-palette usages (`bg-emerald-50`, `text-rose-600`, `bg-blue-50`…) don't flip — mainly on **`renewals`, `online-orders`, `lead-gen`, `reports`, `setup`**. In dark mode these render light banners / pale text on dark = low-contrast or invisible.
- **Fix:** Replace numeric palette with tokens (`text-emerald`, `bg-amber-soft`, `text-rose`…); add an ESLint ban on `(bg|text|border)-(emerald|rose|amber|indigo|blue|green|red)-[0-9]` so it can't regress.

#### 10. Money rendered in two different fonts; hand-rolled stat cards; container/heading drift
*(visual-polish #2/#3/#4/#5/#6)*
- Money is JetBrains Mono on Projects/P&L/GST/Aging but sans `tabular-nums` on Customers/Invoices/Quotes → "different app" feeling. 3 page-container recipes + 3 h1 patterns. 8+ pages re-roll their own stat tile instead of `KPI`/`StatStrip`. Money colour semantics (rose=owed, emerald=credit) applied inconsistently.
- **Fix (high ROI, low risk):** extract `<PageShell>`, `<PageHeader>`, and a shared `<Money value tone>` component; adopt `KPI`/`StatStrip` everywhere. Bring the 4-page "less-polished cohort" up to the `customers/page.tsx` bar.

#### 11. Customer-facing buy page bypasses the design system
*(visual-polish #9)*
- `buy/workspace` — the storefront, highest-stakes surface — has 71 raw hex colours and 40+ raw `₹{...}` concatenations instead of `rupee()` (loses lakh grouping + null handling), and won't track tokens/dark-mode at all.
- **Fix:** route all money through `rupee()`; convert to tokens.

### TIER 4 — Compliance / feature-completeness on the trust path

#### 12. e-invoice IRN is display-only
*(money-spine #3)*
- The doc says "GST-compliant Tax Invoice" and shows an IRN slot, but nothing generates it (ClearTax IRP is a separate P0). An always-blank IRN on a "compliant" invoice reads as broken/fake.
- **Fix:** Ship IRP (P0), or until then hide the IRN line when absent and label "Tax Invoice (e-invoice pending)". (This is a known money-spine launch blocker, tracked separately.)

#### 13. Smaller workflow rough edges
- Sent-quote shows 3 competing CTAs incl. two primaries — make "Record payment" the single primary (money-spine #4).
- Invoice list has select-all checkboxes with no bulk action — wire "bulk send reminder / export" or remove (money-spine #5).
- Typed prospect can't enter a GSTIN on a quote (3 inconsistent GST-capture UIs) — extract one `<GstIdentityFields>` (money-spine #6).
- No undo anywhere; write-off reason uses native `prompt()` (may no-op in mobile webview) — add undo-toasts + a proper dialog (human-behaviour #6).
- Payment reference mandatory on mobile — allow "Received (add ref later)" (human-behaviour #11).
- Financial Reports mis-filed under "Engage" (marketing) — move to Accounting (nav #7).
- Empty states never offer "explore with sample data" though `EmptyState` supports it (onboarding #7).

---

## Prioritized roadmap (impact vs effort)

**Do first — biggest perceived-quality jump, all reuse existing plumbing:**
1. **Send invoice via WhatsApp/email** (Tier 1 #1) — reuse quote's send dialogs.
2. **Free `wa.me` default for quote+invoice share** (Tier 1 #2) — one line, unblocks day-1.
3. **Kill honesty violations + fake buttons** (Tier 1 #4, #5) — fabricated NPS, fake Razorpay success, wizard Import no-op, "coming soon" exports.

**Next — turns the app into a daily habit:**
4. **WhatsApp daily digest to the owner + money-at-risk in the bell** (Tier 1 #3).
5. **Hinglish labels for jargon** (Tier 2 #6) — cheap, high trust.
6. **Search covers money objects + "Record payment" first-class + FAB on /payments** (Tier 2 #7).
7. **Owner-shaped mobile** (Tier 2 #8).

**Systemic guardrails (so the bar can't regress):**
8. **Fix dark-mode numeric palette + ESLint ban** (Tier 3 #9).
9. **Extract `<PageShell>`, `<PageHeader>`, `<Money>`; adopt `KPI`/`StatStrip`; fix buy-page** (Tier 3 #10, #11).

**Known P0s (tracked elsewhere, sit on the trust path):**
10. Razorpay live + GST e-invoice IRN (Tier 4 #12).

**The through-line:** world-class here = **honesty + reach + polish**, not more features. Get the invoice into the customer's WhatsApp, get the app onto the owner's phone, remove every control that lies, and speak his language — that closes most of the visible gap.
