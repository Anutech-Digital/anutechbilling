# Design audit: ResellerOS (localhost:3001) vs Zoho Billing / Books (31 Oct 2026)

Method: skills `design-critique`, `layout-audit`, `accessibility-review` followed; every number below was measured this run in the Claude app browser pane, on localhost:3001 with the seeded E2E Test Co data (signed in as Owner, real rows on every list), at 1280×800 emulation and at the pane's own width (1326px). Contrast was computed (WCAG formula, opaque-background walk, translucent layers blended). Zoho numbers come from the Zoho Billing **test org 60094055943** (read only). Nothing was saved anywhere: every dialog/drawer was opened and closed with Escape/Cancel. The dark-theme pass used the app's own theme button and was switched back to light (browser-local only).

Prior audits not repeated: ux.md (#1 sidebar/feedback, #2 ₹/month, #4 balances, #6 P&L drill, #9 split view, #15 bank English) and plan.md cards R-2180…R-2212. Where a finding overlaps, the card id is named.

---

## 1. Pardeep ke liye 10 line (Hinglish)

1. Design ka base achha hai — rang (tokens), font scale, focus ring, dialogs sab ek system se bane hain. Zoho se zyada saaf aur "premium" lagta hai.
2. Sabse badi problem: **lists 1280 laptop pe fit nahi hoti.** Subscriptions table ko 1,435px chahiye, milta 944px — Renewal date, Status aur Actions screen ke bahar. Quotes mein Actions column kat jaata hai.
3. **Rows bahut moti hain** — Quotes ki ek row average 103px, Subscriptions 92px. Ek screen pe sirf 5–6 records dikhte hain; Zoho/Tally jaisa 12–15 dikhna chahiye.
4. **Kaam ki list neeche dab jaati hai** — Quotes ki pehli row 874px pe (800 ki screen pe dikhti hi nahi), Invoices 686px pe. Upar KPI dabbe + banner + 2–3 filter rows hain.
5. **Ek number 3 baar** — "Urgent 2" header line mein, dabbe mein, tab mein. Ye aapka "one fact one place" rule todta hai (Quotes, Renewals, Invoices, Customers sab mein).
6. **Orange (primary) button har jagah** — Quotes page pe 25 orange buttons. Jab sab "main" hai, kuch bhi main nahi. Ek screen = ek orange button.
7. Dark mode mein **har orange button ka white text padhne layak nahi** (2.99:1, chahiye 4.5). Ek line ka fix (button.tsx).
8. Invoices page pe "Fill missing costs" link **dikhta hi nahi** (1.05:1 — background jaisa rang). Ek line ka fix.
9. Drawers aur dialogs ka **Save button kabhi neeche chhupa** (Manage seats, Correct details, Reconcile) — scroll karke dhoondhna padta hai. Credit note drawer sahi hai: neeche fixed footer. Wahi sab jagah.
10. Rang/brand ke 2 faisle aapke: (a) Zoho jaisa compact "dense" mode default ho ya nahi, (b) paise ke numbers ka ek font (abhi 3 alag font mein dikhte hain).

---

## 2. Design-system findings (measured)

### 2.1 Tokens and colour
| Check | Measured | Verdict |
|---|---|---|
| Tokens in `globals.css` | 26 colour tokens light + same set in `.dark` | good base |
| Raw Tailwind palette in .tsx (app-wide grep) | **222** (`bg-emerald-500/10`, `text-rose-600` …) | finding |
| Bare `bg-white`/`text-white`/`text-black` | **95** | finding |
| Hex colours in .tsx | **596** (mostly PDFs/emails/charts — not all UI) | note |
| `text-ink-4` (placeholders / hints) on paper | **2.32:1** (on paper-2 2.17:1) — 98 uses | fails AA for any real text |
| `text-ink-3` on paper / paper-2 | 5.13 / 4.79 | pass |
| `rose` text on `rose-soft` | **4.20:1** | fails at body size |
| `amber` text on `amber-soft` | **4.30:1** | fails at body size |
| Token misuse: `text-accent` = **amber-soft** (a background colour) | `invoices/page.tsx:656` "Fill missing costs" = **1.05:1** light, 1.37:1 dark | bug |
| Raw `text-rose-600` (225,29,72) instead of token `rose` | `renewals/page.tsx:446,465,757` → 4.25:1 on paper-2 | finding |
| Input border (`border-hairline`) vs background | **1.23–1.25:1** (needs 3:1, WCAG 1.4.11) | finding |
| Dark theme follows OS? | No — `theme-provider.tsx` `defaultTheme="light"`; OS dark ignored | = **R-2187** |

### 2.2 Two pill/badge systems (one too many)
- `components/ui/badge.tsx` uses tokens (`bg-emerald-soft text-emerald` …) — 4.74–10.45:1, good.
- `components/ui/status-pill.tsx:28-104` uses **raw palette** (`bg-emerald-500/10 text-emerald-700 dark:text-emerald-300`, `blue`, `teal`, `slate`). Same meaning, two looks; status-pill skips the theme tokens entirely.
- On screens: Banking/Subscriptions use dot+word pills; Quotes uses `#0068` grey chips + coloured pills; Subscription drawer shows Status as plain text "Active"; Correct-details dialog shows raw enum `active`, `google` (lowercase DB values); phone subscription cards show `active`.
- Zoho uses one style: UPPERCASE coloured text, no pill (measured "Overdue by 10 days" 247,104,49 = **3.01:1**, "Live" 31,206,136 ≈ 2.1:1 — Zoho fails contrast; ours passes). Keep pills, but one component.

### 2.3 Type scale
- Floor 12px holds on every screen except **P&L chart axis 10–11px** (21 SVG labels, recharts default). `text-[Npx]` app-wide: 302 (173×12px, 105×13px, 2×11px). 13px is an unofficial rung used 105 times — sits between `xs` 12 and `sm` 14.
- Heading inconsistency: quote detail H1 = 36px serif; **invoice detail H1 = 16px mono** (`INV-XXXX-27-0059`). Same kind of page, two title systems.
- **Money in three typefaces** on P&L: serif 20, sans 31, mono 38 elements. Tiles = serif, statement = mono, notes = sans. Zoho: one sans for all money.
- Date formats mixed: "31 Oct 2026", ISO "2026-10-01 TO 2026-10-31" (P&L statement header), "25 Sept 2027" (phone subscription cards, `en-GB` "Sept"), native `dd-mm-yyyy` inputs. Negative money "₹-50,000" (banking card) and "₹-5.5L" (chart) vs "−₹20,364" elsewhere.

### 2.4 Buttons
- `<Button>` primitive 1,397 uses vs **673 raw `<button>`** (app-wide). Heights seen on one screen: 16, 24, 26, 28, 32, 33, 36, 38, 46px.
- `button.tsx:40` primary = `bg-amber text-white`; danger `bg-rose text-white`. **Dark mode: white on amber(249,104,31) = 2.99:1, white on rose(243,89,89) = 3.29:1** — every primary/danger button fails in dark. Light passes (≈4.7).
- Primary-colour count per screen (bg = amber): Quotes **25**, Invoices 10, Customer detail 7, Renewals 3. Rule: one primary per view.
- Disabled = `opacity .5` with no reason text (Reconcile "Choose what this money is for", "Record sale & reconcile ₹5,000" disabled until product picked; Cancel subscription). Credit-note "Issue credit note · ₹0" is **enabled at ₹0**.
- Small targets: dialog close X = **16×16px**; "Un-reconcile" text buttons 75×16px; header icons 32–40px on phone.

### 2.5 Tables
| Screen (1280×800) | Table needs | Has | Over | Off-screen columns | Avg row |
|---|---|---|---|---|---|
| Subscriptions | **1,435** | 944 | **491** | **Started, Renewal, Status, Actions** | 92px |
| Quotes | 1,089 | 959 | 130 | **Actions** | **103px** (min 53, max 139) |
| Customers | 1,009 | 959 | 50 | Unused credits squeezed to 38px, **Actions 0px** | 61px |
| Customer › Statement (pane 1326) | 862 | 622 | 240 | Debit/Credit/**Balance** behind scroll | – |
| Invoices | 959 | 1265 | fits | – | 69px |
| Bank account | 830 | 959 | fits, **129px dead strip** right of table | – | – |
| TDS receivable | 927 | fits | – | – | 70px (date + invoice no. wrap 2–3 lines in 75/96px cols) |
- Quotes column budget is wrong, not just too many columns: Quote col **has 175 / needs 103** (72px wasted) while Customer has 126 / needs 352 and Plan 100 / needs 329.
- Nested scroll boxes: bank table in `max-h-[calc(100vh-24rem)]` (`banking/[id]/page.tsx:404`) = 416px tall at 800 → ~6 rows, page scrollbar + table scrollbar; subscriptions 545px box; customer split view 3 nested scrollers.
- Sort headers: buttons with `title="Sort"`, **no `aria-sort`** on any `<th>` (Invoices 0/8).
- Quotes rows: `<tr>` opens on click but rows are not focusable (cursor pointer, no tabindex) — keyboard users must use the action column, which is off-screen.
- Zoho for comparison (test org, pane 1326): Invoices list needs 1,310 / has 1,062 (Amount & Balance Due off-screen); Subscriptions needs 1,610 / has 1,062 (Next Billing On off-screen). **Zoho has the same fit problem** — fixing ours is a real "better than Zoho" point.

### 2.6 Forms
- Labels: every input checked (reconcile, credit note, seats, correct details, cancel, settings 23 inputs) has a `<label for>` or aria-label — **CLEAN**.
- Mixed controls in one form (Correct subscription): custom combobox 36px (Plan, Vendor, Status) + native `<select>` 38px (Commitment, Frequency) + inputs 36/38px; three chevron styles.
- Manage seats: −/+ stepper buttons **and** native number spinner = two ways to change one number.
- Placeholder text `ink-4` 2.32:1 (credit note note field, search boxes).
- Settings › Company: **6 separate Save buttons**, first at y=1,913px, page ≈3,550px tall; none sticky.

### 2.7 Drawers vs dialogs (one pattern needed)
| Surface | Type | Width | Primary button | Visible without scroll at 846 tall? |
|---|---|---|---|---|
| Reconcile transaction | right sheet | 560 | **in the body**; footer has only "Close" + note "save with the button in the form above" | depends on section |
| Credit note | right sheet | 448 | sticky footer (Cancel / Issue) | yes — the model to copy |
| Subscription | right sheet | 480 | "Manage seats" full-width at top | yes |
| Manage seats | centred dialog (replaces the drawer) | 576 | footer at y=899 | **no** |
| Correct subscription | centred dialog | 448 | footer at y=863 | **no** |
| Cancel subscription | centred dialog | ~ 350 | in view | yes |
| P&L drill | centred dialog | ~ 576 | – | list box shows ~5.5 rows (240px) |
- Closing Manage seats / Correct details also closes the subscription drawer — the owner loses his place (Zoho returns to the record).
- Focus: drawers trap focus and the ring is visible (two-tone `paper 2px + amber 4px`, measured on reconcile tiles with a real Tab) — **CLEAN**.

---

## 3. Per screen

### Dashboard (/dashboard)
- Good: clear H1 greeting, 4 deal tiles + 4 company tiles, 310 text nodes with **0 contrast failures**, all buttons named.
- Wrong: three primary-weight actions in the header (Re-run setup, Quick add lead, New quote — only New quote is amber, fine) but the "Money is moving without being recorded" setup box sits in the main flow every day. Phone: page is **7,441px tall** (9 screens). Sidebar shows empty "Loading…" for ~3s on every full load (ux #1 / R-2186).
- Zoho: Home = 4 charts + receivables/payables strip; ours is richer but longer.

### Today (/today)
- Good: one list, most urgent first, "Open →" per row, 0 contrast fails, chips with counts.
- Wrong: "24d LATE" in the title + "24d late" chip = same fact twice per row (rule 1). Content column ≈900px of 1,025 — fine.
- Zoho has no equivalent — **we beat Zoho here**.

### Banking home (/accounting/banking)
- Good: total + count + tips strip, account cards.
- Wrong: cards are `<button>` (205px tall) — can't open in a new tab; no "N to reconcile" count on the card (Zoho shows uncategorised count + Reconcile button per account) → R-2190. Negative balance printed "₹-50,000".
- Primary = "Add account"; the daily task is reconcile.

### Bank account + Reconcile drawer
- Good: Balance / Opening / Reconciled-so-far progress bar; tabs are real `role=tab` with `aria-selected`; money-in/out chips have `aria-pressed`; reconcile tiles (`An open quote`, `A new sale`, `Advance`, `Several`) have `aria-pressed`, 64px tall, selected text 6.68:1.
- Wrong: headers "Nikasi (Dr.)" / "Jama (Cr.)" (`banking/[id]/page.tsx:414`) → English (R-2190). Two filter rows both showing "All 16". Nested 416px scroll box. 129px empty strip right of the table. Out total ₹1,27,960 in rose on paper-2 = 4.39:1. Reconcile drawer: save button inside the body, footer says "save with the button in the form above" (`reconcile-transaction-dialog.tsx:1377-1381`) → **R-2008**. "An open quote" tile is offered when the customer has nothing open (message only after click) — show the count on the tile ("Open quotes · 0") and disable it.
- Zoho: transaction list + right "Match / Categorise" panel, "Possible matches" shown first, footer Save — we already have the stronger money-in options.

### Quotes list (/quotes)
- Good: 683 text nodes 0 contrast fails; search + Export; status pills with words.
- Wrong: first row at **874px** (below an 800 screen) — strip header line repeats Pipeline/Sent/Accepted, then 6 tiles, a purple "Quote intelligence" card, a commitment banner, a "Show" select stretched to 916px, "My assigned/Team view" line. Table 130px over, **Actions off-screen**, avg row 103px (Customer and Plan wrap 4–5 lines). 25 amber buttons (every row's "Generate invoice"/"Record payment"/"WhatsApp" is primary). Rows clickable but not focusable.
- Zoho: list starts at y≈70, one line per row, one green "New" button, row actions in a hover/kebab.

### Quote detail
- Good: stepper Draft→Sent→Signed→Paid→Provisioned→Invoiced; one primary "Record instalment payment"; tables fit.
- Wrong: the primary sits mid-page (y=519), not in the header bar; header bar has 5 secondary buttons. No document preview — Zoho shows the actual PDF under a "What's next?" bar with exactly one green action.

### Invoices list
- Good: fits 1280 (959 table in 1,265); status chips; "Overdue (1)".
- Wrong: first row at 686px; "Fill missing costs" invisible (1.05:1, `invoices/page.tsx:656` `text-accent`); two tab rows ("All invoices 63" and "All 63"); `aria-sort` missing; phone: first invoice card at y=1,045 and two "New invoice" buttons (header + FAB).

### Invoice detail + credit note
- Good: credit-note drawer = best drawer in the app (labels, warning box, sticky footer).
- Wrong: detail column 702px of 1,025 (quote detail uses full width); H1 16px mono vs quote 36px serif; "Net payable ₹0" and "Balance due ₹0" both shown; on a **paid** invoice the amber primary is WhatsApp; CN primary enabled at ₹0. Zoho: split list + PDF preview + one "What's next" action (R-2210).

### Subscriptions list + drawer + Manage seats + Correct details + Cancel
- Good: drawer has one full-width primary (Manage seats) + 4 secondary; billing schedule card; cancel dialog uses rose danger + "Keep it"; chips have `aria-pressed`; phone uses cards (§20 done).
- Wrong: **table 491px over; Renewal/Status/Actions off-screen** (R-1717); 92px rows; seats/correct dialogs replace the drawer and hide Save below the fold; mixed select styles; raw enum values `active`, `google`; drawer Status as plain text.
- Zoho: list also overflows (Next Billing On off-screen) — we can beat it.

### Customers list + Overview / Statement
- Good: split view (list + detail) already like Zoho; KPI tiles; statement with closing balance.
- Wrong: page title "Companies" vs "Customer" elsewhere (ux #15); "45" shown 3 times (strip chip, tile, filter chip); two "Add company" amber buttons; Actions column 0px wide; sort chips without `aria-pressed`; selected customer not in the URL (`location.href` stays `/customers` — no back button / share link); 6 header actions + red "Delete" as a top-level button (Zoho keeps delete under "More"); KPI notes truncated without title ("Advance ₹1,554 against Q-F…" clipped 199px); statement table 862/622 so **Balance** is behind a scroll; late-fee segmented control uses solid black pill — a third active-state style.

### Renewals
- Good: urgent/upcoming/future buckets, tabs, forecast chart.
- Wrong: "Urgent 2 (₹4.3K)" in header line, tile and tab (3×); work list starts below the 6-month chart (mostly empty months); raw `text-rose-600` 4.25:1.

### Accounting P&L + drill
- Good: period chips + compare, tiles, statement, GST snapshot, drill dialog ties out (₹15,21,372 = Revenue).
- Wrong: statement starts ~690px; child lines (Google Workspace ₹10,43,648 …) don't drill (ux #6 / R-2181); "59 invoices →" opens "68 items" (CN/DN included — say "59 invoices + 9 notes"); ISO date header; chart labels 10–11px; money in 3 fonts; period chips lack `aria-pressed`.

### TDS receivable
- Good: lifecycle chips with counts, check-banner, 0 contrast fails, table fits.
- Wrong: no row action column (where does "mark certificate received" live?); Date (75px) and Invoice (96px) wrap to 2–3 lines → 70px rows; chips lack `aria-pressed`.

### Settings home
- Good: 23 inputs all labelled; GSTIN verify card.
- Wrong: one 3,550px page with **6 Save buttons**, first at 1,913px; tabs are only 6 (Zoho Settings is a searchable grid of ~40). Form 694px wide in 1,025 — fine.

---

## 4. Accessibility findings (WCAG 2.1 AA)

| # | Severity | SC | Element / where | Measured |
|---|---|---|---|---|
| A1 | major | 1.4.3 | Every primary & danger `<Button>` in **dark** theme (`button.tsx:40,43` `text-white`) | white on rgb(249,104,31) **2.99:1**; on rgb(243,89,89) 3.29:1 (need 4.5) |
| A2 | major | 1.4.3 | "Fill missing costs" button, Invoices margin tile (`invoices/page.tsx:656` `text-accent`) | **1.05:1** light, 1.37:1 dark |
| A3 | major | 1.4.3 | `text-ink-4` placeholders & hints (98 uses) | **2.32:1** on paper, 2.17:1 on paper-2 |
| A4 | major | 1.4.11 | Input / select borders (`input.tsx:51` `border-hairline`) | **1.23–1.25:1** (need 3:1); 1.09:1 inside the amber reconcile panel |
| A5 | minor | 1.4.3 | Raw `text-rose-600` on paper-2 (Renewals tiles, `renewals/page.tsx:446,465,757`) | 4.25:1 (12px), 4.34:1 (18px) |
| A6 | minor | 1.4.3 | Token `rose` on paper-2 / tinted panels: bank "Out ₹1,27,960", customer "To collect ₹3.3L", reconcile "−₹5,000" | 4.39 / 4.34 / 4.42:1 |
| A7 | minor | 1.4.3 | `ink-3` on reconcile bill panel (rgb 245,231,221) "Due" | 4.48:1 |
| A8 | minor | 4.1.2 | Theme button `topbar.tsx:142` — in dark mode it still announced "Switch to dark mode" | label did not update after toggle |
| A9 | minor | 4.1.2 | Filter/sort chips without `aria-pressed`: Customers (All/Has receivables/With subscriptions, sort chips), P&L period chips (This month/quarter/FY), TDS lifecycle chips | 0 of ~15 |
| A10 | minor | 1.3.1 | Sortable `<th>` without `aria-sort` (Invoices, Subscriptions, Customers) | 0 of 8 on Invoices |
| A11 | minor | 2.1.1 | Quotes table rows open on click but are not focusable | `<tr>` cursor:pointer, no tabindex |
| A12 | advisory | 2.5.5 (AAA) / 2.5.8 (2.2 AA) | Dialog close X 16×16; "Un-reconcile" 75×16; phone: 53 of 117 taps < 32px on Invoices | – |
| A13 | minor | 1.4.4 | P&L chart axis text 10–11px (recharts) | 21 labels |
- **CLEAN**: icon-button names (0 unnamed on 12 screens), form labels (0 unlabelled), focus ring (two-tone, visible on amber and inside drawers with real Tab), focus stays inside drawers, landmarks (`main` ×1, `nav` ×3), real tabs with `aria-selected`, reconcile tiles and bank chips with `aria-pressed`, truncation that clips mostly carries `title` (exceptions: customer list names 21–93px clipped, KPI notes).

---

## 5. Layout-fit findings at 1280

1. **Subscriptions** — needs 1,435 / has 944 (491 over); **Renewal, Status, Actions** off-screen; Renewal is the column the renewals work needs. Even at pane 1326 Renewal is off. → R-1717.
2. **Quotes** — 1,089 / 959; **Actions** off-screen; Quote column has 175 for 103 of text; avg row 103px.
3. **Customers** — 1,009 / 959; Actions column 0px, Unused credits 38px.
4. **Customer Statement** (split view) — 862 / 622; Balance behind a scroll.
5. **Above-the-fold**: first data row y = Quotes 874, Invoices 686, Customers 557, Subscriptions 536 (800 tall screen). Zoho Invoices: 151.
6. **Nested scroll** — bank table 416px box; subscriptions 545px box; 3 scrollers on customer split.
7. **Dialog Save below fold** — Manage seats (899 > 846), Correct subscription (863 > 846).
8. **Truncation without title** — customer names in list (Customer A … −21px, Customer F … −68/−93px), customer KPI notes (−52 to −199px).
- CLEAN: Invoices, TDS, P&L, Today, Dashboard fit; no page-level horizontal scroll on any screen (docOverflowX ≤ 0) at 1280 or 375.

---

## 6. Prioritised improvement table (best first; ⚡ = quick win)

| # | Title | Why for the owner | What to change | Pri | Effort | Files (guess) | Related card |
|---|---|---|---|---|---|---|---|
| 1 | ⚡ Primary/danger button text readable in dark | Orange buttons unreadable at night (2.99:1) | `text-white` → `text-paper` (flips in dark) or darker amber in dark tokens | p1 | S | `components/ui/button.tsx:40,43` | R-2187 |
| 2 | ⚡ "Fill missing costs" visible | Link is invisible, so costs never get filled | `text-accent` → `text-amber-ink` | p1 | S | `app/(app)/invoices/page.tsx:656` | – |
| 3 | Subscriptions table fits 1280, Renewal visible | Renewal date is the day's work; it's off-screen | Merge Started into Renewal cell, Vendor as icon, Seats+MRR one cell, actions → row kebab; target ≤944px | p1 | M | `app/(app)/subscriptions/page.tsx` | R-1717 |
| 4 | Quotes table fits; actions visible | "Generate invoice" button hidden by scroll | Re-budget columns (Quote 175→100), one-line Customer/Plan with title, actions into kebab + one secondary button | p1 | S | `app/(app)/quotes/page.tsx` | R-2199 |
| 5 | One primary per view | 25 orange buttons — eye can't find the next step | Row actions `variant="default"`; only page CTA amber; lint/test counting amber per page | p1 | M | quotes, invoices, customers pages | rule 3 |
| 6 | Work list above the fold | Have to scroll past tiles every visit | Collapse KPI strip by default to one line (remember per user), drop header-line duplicate numbers, move intelligence/commitment banners into the strip | p1 | M | quotes, invoices, renewals, customers, subscriptions pages | rule 1 |
| 7 | Dense rows (≤48px) | 5 rows per screen vs Zoho 12–15 | Single-line cells with truncate+title, secondary text on hover/drawer; row height 44–48 | p2 | M | shared `data-table.tsx` + list pages | – |
| 8 | Save always visible in drawers/dialogs | Owner scrolls to find Save; reconcile footer says "button above" | Sticky footer pattern of credit-note drawer everywhere | p1 | S | `reconcile-transaction-dialog.tsx:1377`, `add-seats-dialog.tsx`, `edit-subscription-dialog.tsx` | R-2008 |
| 9 | Seats/correct dialogs return to the drawer | Closing loses your place | Open as nested sheet step or reopen drawer on close | p2 | S | `components/features/subscriptions/*` | – |
| 10 | ⚡ Placeholder/hint contrast | Hints unreadable on laptop in daylight | `--ink-4` → ≈ #8A8273 (≥4.5:1 on paper) — keep lighter than ink-3 | p2 | S | `app/globals.css:16,79` | – |
| 11 | Input borders 3:1 | Fields hard to see on cream background | inputs use `border-hairline-strong` (and darken it to ≥3:1) | p2 | S | `components/ui/input.tsx:51`, select, textarea | – |
| 12 | One status pill component on tokens | Same status looks different on 4 screens; raw enums "active/google" | Port `status-pill.tsx` to tokens, use it in drawers/dialogs/phone cards; map enums to labels | p2 | M | `components/ui/status-pill.tsx`, `badge.tsx`, subscription drawer/dialog | rule 4 |
| 13 | Customers: Actions column + one "Add company" | Actions 0px; two identical primaries | Drop Unused credits to drawer, keep one Add button | p2 | S | `app/(app)/customers/page.tsx:960` | R-2209 |
| 14 | Statement fits / Balance visible | Running balance hidden behind scroll | Details column truncates, Debit/Credit/Balance fixed 96px each | p2 | S | customer statement component | R-2200 |
| 15 | Bank table: no nested scroll, fill width | 6 rows visible, empty strip | Remove `max-h-[calc(100vh-24rem)]`, sticky header on page scroll, table `w-full` | p2 | S | `accounting/banking/[id]/page.tsx:404` | R-2190 |
| 16 | ⚡ Bank headers in English | "Nikasi/Jama" breaks English UI | "Money out (Dr)" / "Money in (Cr)" | p2 | S | `accounting/banking/[id]/page.tsx:414` | R-2190 |
| 17 | Reconcile tiles show counts | Owner clicks "open quote" and only then learns none exist | "An open quote · 0" disabled when 0; preselect the only possible tile | p2 | S | `reconcile-transaction-dialog.tsx` | R-2189 |
| 18 | Invoice & quote detail: one layout | Two page designs for the same job | Same header (36px serif title, status pill, one primary in header, More menu), full width, PDF preview tab | p2 | M | `invoices/[id]`, `quotes/[id]` | R-2210 |
| 19 | One number format | "₹-50,000", "₹-5.5L", "Sept", ISO dates | `formatMoney` → "−₹50,000"; one `formatDate` (`d MMM yyyy`, "Sep") everywhere incl. P&L header and phone cards | p2 | S | `lib/format*`, banking card, P&L, subscription card | – |
| 20 | Money in one typeface | P&L shows 3 fonts for ₹ | Pick: serif for hero tiles only, mono (tabular) for all table money; never sans | p3 | S | P&L + tiles | **Pardeep taste** |
| 21 | Settings: one sticky Save per tab | 6 Save buttons, first at 1,913px | Split Company tab into sections with one sticky "Save changes" bar shown when dirty | p2 | M | `app/(app)/settings/*`, `gstin-verify-card.tsx`, `turnover-card.tsx` | – |
| 22 | ⚡ `aria-pressed` / `aria-sort` | Screen readers can't tell active filter/sort | Add to Customers/P&L/TDS chips and `SortHead` | p3 | S | customers page, P&L page, TDS page, `SortHead` | – |
| 23 | ⚡ Theme toggle label updates | Wrong announcement in dark | Render label after mount (`mounted && resolvedTheme`) | p3 | S | `components/layout/topbar.tsx:142` | R-2187 |
| 24 | ⚡ Raw rose-600 → token | Fails contrast, breaks dark tokens | `text-rose-600` → `text-rose-ink` | p3 | S | `renewals/page.tsx:446,465,757` | – |
| 25 | Disabled buttons say why | Faded button, no reason | Helper line under disabled primary ("Pick a product first"); CN disabled at ₹0 | p3 | S | reconcile dialog, credit-note drawer | rule 3 |
| 26 | Customer detail in URL | Back button / share link lose the customer | `?id=` on selection | p3 | S | `customers/page.tsx` | R-2210 |
| 27 | Delete under "More" | Red Delete next to Archive invites mistakes | Move Delete into More menu | p3 | S | customer detail header | – |
| 28 | One active-state style | Black pill, amber underline, bordered chip — 3 vocabularies | Tabs = underline; filters = bordered chip; segmented = paper-2 + shadow; no solid black | p3 | S | `customer-late-charges.tsx`, `invoice-late-charges.tsx` | – |
| 29 | Chart labels 12px | 10–11px axis unreadable on phone | recharts `tick={{fontSize:12}}` | p3 | S | P&L / renewals charts | – |
| 30 | Raw palette → tokens sweep | 222 raw colours + 95 white/black skip dark mode | Mechanical swap, screen by screen (badge first) | p3 | L | app-wide | – |

---

## 7. Where our design already beats Zoho (measured)
- **Contrast**: our list pages had 0–2 contrast failures per screen (light); Zoho's own status text "Overdue by 10 days" 3.01:1, "Live" ≈2.1:1 and the green "New" button 2.7:1 fail AA.
- **Focus ring**: two-tone ring visible on every surface incl. amber; drawers trap focus.
- **Labels**: 0 unlabelled inputs, 0 unnamed icon buttons across 12 screens.
- **Today page**: one prioritised work list across GST/TDS/overdue/tasks — Zoho has nothing like it.
- **Reconcile money-in choices** (open quote / new sale / advance / several) with plain-language help — Zoho's categorise panel is account-code driven.
- **Quote stepper** (Draft→…→Invoiced) and **billing schedule** on subscriptions — Zoho shows neither on the record.
- **Phone**: lists switch to cards (Subscriptions, Invoices, Bank lines), bottom nav, FAB; no page-level sideways scroll at 375px. Zoho Billing web on phone is the desktop table.
- **P&L drill ties out** with the total shown in the dialog.
- **Fit**: Zoho's own Invoices (1,310/1,062) and Subscriptions (1,610/1,062) tables overflow too — once #3/#4 land, ours fit where Zoho's don't.

---

## 8. Not checked
- Dark mode on Quotes and Bank account screens (did Invoices, Dashboard, Subscriptions); OS-dark auto switch (app ignores OS by design, R-2187).
- Phone pass on Customers and Today (page did not render while the pane tab was in the background); Quote detail/forms on phone.
- Zoho Books (books.zoho.in) screens — another agent held that tab; Zoho comparison is from Zoho Billing test org only (Invoices list + detail, Subscriptions list).
- Screen-reader announcement (no SR run); full Tab order of whole pages (only drawer focus checked with real Tab).
- Quote builder / new invoice forms, Payments received, Purchases, Month-end close.
- Print/PDF design of invoices and quotes.
- Loading/empty states beyond the skeletons seen (Today, Banking showed skeleton cards — fine).

## Decisions (31 Oct 2026, coordinator — Pardeep delegated: "audit ke analysis ke baad jo tumhe sahi lage wo karo app ke behtri ke liye aur logical aur practicle hona chahiye")
1. **Row density:** compact rows are the default for work lists (44–48px rows, 13–14px text), so a 1280×800 screen shows ~12 rows. No density toggle for now (one way).
2. **Money typeface:** every ₹ amount uses the app's sans font with tabular numbers (`tabular-nums`), right-aligned in tables. Serif only for page titles; mono only for document numbers.
3. **Hint text + input borders:** keep the cream paper; darken `ink-4` until it reaches ≥ 4.5:1 on paper and input borders until ≥ 3:1 (measure, don't eyeball). Nothing else in the palette changes.
4. **Dark mode:** follow the computer's setting while the user has not chosen one; the toggle stores a choice (R-2187). Fix dark-mode button contrast first (R-2261).
5. **Order of work:** quick wins (contrast, invisible link) → tables that don't fit at 1280 (Subscriptions, Quotes, Customer statement) → Save always visible in drawers/dialogs → one primary button per view + list above the fold → shared status pill → the rest.
