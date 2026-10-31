# G-ZOHO plan: beat Zoho Books on daily work (31 Oct 2026)

Inputs: sales.md, banking.md, accounting.md, ux.md (this folder) + where-we-beat-zoho.md. Owner ask (31 Oct): deep audit Zoho Books, then build the improvements and make the app user friendly. Decisions are delegated. Prices and data repairs stay with Pardeep.

Board: goal card **G-ZOHO**, 33 new cards **R-2180..R-2212** (meta/nextId is now 2213), and 19 existing cards updated through the field `zohoAudit31Oct` instead of creating duplicates.

## Done when (3 measures)
1. Staging HDFC reconcile runs at **≥120 lines/hour** in a timed 1-hour session. Baseline is about 50/hour (R-2094). The observer (R-2169) times it.
2. Every **p1** card in G-ZOHO is done and checked on localhost. That includes R-1717, R-2179 and R-1678.
3. Every **"Not to claim yet"** item in where-we-beat-zoho.md is closed, and that section is then emptied. The items and the cards that close them:
   - Reconcile speed: R-2189, R-2195, R-2196.
   - Statement PDF + email: R-2200.
   - P&L drill that ties out: R-2181.
   - Quote → invoice in one step: R-2199.
   - Forex + export from USD receipts: R-1678, R-2171.
   - Full country list: R-2180.

**Owner rule, 31 Oct:** rates differ by commitment (Flexible vs Annual). Under Annual, changing the payment frequency must not change the per-month rate. This is being built in **R-2178**. R-2182, R-2193, R-2205, R-2206 and R-2208 wait for it.

## Waves and cards
Effort: S ≤1 day, M 2–4 days, L >1 week. **CO** means coordinator OK is needed before coding, because the card touches a shared file, a migration, or `package.json` (CLAUDE.local.md).

### Wave 1: p1 bugs + quick S wins (start now, run in parallel)
| id | title | pri | effort | depends | CO |
|---|---|---|---|---|---|
| R-2180 | Full ISO country list, searchable (Estonia, Cayman…) | p1 | S | – | – |
| R-2181 | P&L drill filtered by row; drill total = number clicked (net, no GST) | p1 | S | – | – |
| R-2182 | Quote detail "₹38,232 /month" → ₹3,186/month · ₹38,232/year | p1 | S | R-2178 | – |
| R-2183 | Customer Overview outstanding = Statement balance (one function) | p1 | S | – | – |
| R-2184 | TDS payment drawer says "still outstanding" + re-opens after save | p1 | S | – | – |
| R-2185 | Ctrl+K phone search by digits only | p1 | S | – | – |
| R-2186 | Sidebar visible on reload + instant click feedback | p1 | M | – | CO (app shell) |
| R-2187 | Dark mode follows OS setting | p1 | S | – | CO (root layout) |
| R-1717 *(existing, now p1)* | Subscriptions table fits 1280 | p1 | S | – | – |
| R-2179 *(existing)* | Part-paid seat-add invoice; un-reconcile also undoes subscription | p1 | M | R-2095, R-2178 | CO (migration) |
| R-2008 *(existing)* | Reconcile drawer: Save in sticky footer for every section | p1 | S | – | – |
| R-2188 | Books lock: English message + reason + log | p2 | S | – | CO (migration) |
| R-2189 | Reconcile "Save & next" + J/K/Enter/Esc | p2 | S | R-2008 | – |
| R-2190 | Banking English heads, "N lines to reconcile" queue, honest BRS | p2 | S | – | – |
| R-2191 | Exclude / Restore a bank line | p2 | S | – | CO (migration) |

### Wave 2: reconcile speed + money correctness
| id | title | pri | effort | depends | CO |
|---|---|---|---|---|---|
| R-2192 | ₹1 tolerance round-off + SWIFT/bank charge on receipts | p1 | S | – | CO |
| R-2193 | Monthly-flex + one-time lines in one sale | p1 | M | R-2178 | CO |
| R-1678 *(existing, now p1)* | Forex gain/loss on USD receipts | p1 | M | R-2192 | CO |
| R-2171 *(existing, narrowed)* | Export invoice under LUT from a USD receipt (GSTR-1 6A) | p1 | M | R-2180, R-1678 | CO |
| R-2194 | Record TDS on an already-reconciled receipt | p2 | S | – | CO |
| R-2195 | Bank rules that act (auto-book, run on unmatched, undo run) | p2 | M | R-1919, R-2191 | CO |
| R-2196 | Bulk select + bulk actions on bank lines | p2 | M | R-2191, R-2195 | CO |
| R-2197 | Razorpay month batch + "Reconcile all ready" | p2 | M | R-2099, R-2192 | – |
| R-2198 | "Pay now" link in invoice email, dunning, AI reminder | p2 | S | – | – |
| R-2199 | Quote → invoice in ≤2 clicks; no refused buttons | p2 | S | R-1726 | – |
| R-2200 | Statement: period picker, PDF, Send (preview) | p2 | S | R-2183 | – |

### Wave 3: GST / accounting model
| id | title | pri | effort | depends | CO |
|---|---|---|---|---|---|
| R-2201 | GST return filing register + "ready to file" checklist | p2 | M | R-2188 | CO · **needsDecision** |
| R-2202 | Services/Migration revenue family + reclassify with history | p2 | S | R-2181 | CO |
| R-2203 | Audit trail for every writer + History drawer | p2 | M | R-2188 | CO |
| R-2204 | Reversal pair / expense refund / payment returned | p2 | M | R-2179 | CO |
| R-2205 | subscriptions.commitment column (Annual / Flexible) | p2 | M | R-2178 | CO |
| R-2206 | Credit note with lines → seats + next part follow | p2 | M | R-2205, R-2178 | CO |
| R-336 *(existing)* | TDS sections under the Income Tax Act 2025 | p1 | S | CA answer | **needsDecision** |
| R-2173 *(existing)* | Correct invoice date while GST unfiled | p1 | M | R-2201, R-2203 | CO |

### Wave 4: UX polish
| id | title | pri | effort | depends | CO |
|---|---|---|---|---|---|
| R-2207 | Frequency visible on the quote builder; Ctrl+Enter; sticky Save; "Saving…" | p2 | S | R-2182 | – |
| R-2208 | Add Subscription: searchable picker + one customer form | p3 | M | R-2178 | – |
| R-2209 | Invoices CLS, mobile button, one noun "Customer", honest CN drawer, GSTIN 1-click | p3 | S | – | CO (nav.ts label) |
| R-2210 | List + detail split view (invoices, quotes, customers) | p3 | M | R-2209 | CO (shared component) |

### DESIGN wave: reserved
zaudit-design is writing `design.md` in this folder. Its cards will be added here and on G-ZOHO (`waves.DESIGN`) once that file is ready. The DESIGN wave runs after Wave 4 and before Wave 5. Visual changes should land after the W4 layout changes so nothing is done twice.

### Wave 5: purchases + management P&L
| id | title | pri | effort | depends | CO |
|---|---|---|---|---|---|
| R-2211 | Vendor credits (credit memos → apply / refund, ITC) | p3 | M | – | CO |
| R-2212 | Recurring bills / expenses | p3 | M | R-2195 | CO |
| R-2156 *(existing)* | P&L matched view (COGS by service month, prepaid spread) | p1 | L | R-2181, R-2202 | CO |

### Later (no card yet, on purpose)
These are lower value ÷ effort, or deliberately not copied:
- FD interest with TDS 194A + FD register.
- Narrow CA adjustment entry.
- Scheduled reports to owner/CA.
- Partial unlock window.
- Price lists.
- GSTR-9.
- IMS.
- Scheduled AA fetch.
- Cheque register.
- Many lines → one record.
- Mileage.
- Paise on bank lines (L).
- Customer portal (R-049, now buildable by us).
- e-invoice (R-044, only above ₹5 Cr AATO).

Never copy: a full chart of accounts or journal engine, module-wise lock dates, custom fields or a workflow builder, sales orders or challans, e-way bill.

## Dependency graph (critical paths)
```
R-2178 ──► R-2182 ──► R-2207
   │  └──► R-2193
   │  └──► R-2205 ──► R-2206
   │  └──► R-2208
   └──► R-2179 ──► R-2204
R-2008 ──► R-2189            (reconcile speed chain)
R-2191 ──► R-2195 ──► R-2196
R-1919 ──┘        └──► R-2212
R-2192 ──► R-1678 ──► R-2171 ◄── R-2180
R-2192 ──► R-2197 ◄── R-2099
R-2183 ──► R-2200 (+ uses R-2198 pay link)
R-2181 ──► R-2202 ──► R-2156
R-2188 ──► R-2201 ──► R-2173
R-2188 ──► R-2203 ──┘
R-1726 ──► R-2199
R-2209 ──► R-2210
```
Same-file serialisation: the reconcile files (`reconcile-transaction-dialog.tsx`, `banking/[id]/page.tsx`) are shared by R-2008 → R-2189 → R-2190 → R-2191 → R-2196 → R-2204. Run them one after another on the same lock, not in parallel. `record-payment-dialog.tsx` is shared by R-2184 → R-2194 → R-2207. `issue-credit-note-dialog.tsx` is shared by R-2206, R-2207 and R-2209.

## Expected time saved
| area | today | after | cards |
|---|---|---|---|
| Bank reconcile speed | ~50 lines/h | ≥120 lines/h. Save & next saves ~8–10 s per line; rules auto-book ~25–35 % of lines; bulk handles same-type batches; Exclude clears junk | R-2189, R-2195, R-2196, R-2191, R-2190, R-2008 |
| Monthly reconcile (~130 money-in + debits) | ~3 h | ~1–1.25 h (≈2 h/month saved) | as above + R-2192, R-2197 |
| Razorpay settlements | 5–7 open per month, ~5–10 min each | one batch, ~5 min total | R-2197 |
| Workarounds (two sales for flex + one-time, ₹1 dues, TDS after the fact, reversal repairs, FX dues) | ~3–5 min each, plus owner data repairs | 0 | R-2193, R-2192, R-2194, R-2204, R-1678 |
| Month-end check (P&L tie-out, GST readiness) | ~45 min | ~10 min | R-2181, R-2201, R-2202 |
| Statement request | ~10 min by hand | 3 clicks | R-2200 |
| Quote → invoice | 3–4 waits, ~2 min | ≤2 clicks | R-2199 |
| Navigation | repeat clicks, blank sidebar | instant feedback | R-2186 |

## Decisions needed from Pardeep
1. **R-336:** the TDS section and payment codes under the Income Tax Act 2025 for FY 26-27. The CA must confirm them. R-390 (194J at 10 % vs 2 %) is the same CA question.
2. **R-2201:**
   - Track only GSTR-1 and 3B for now (recommended), or CMP-08 and GSTR-9 too?
   - Should "Mark filed" lock the books automatically, or only offer to (recommended: offer)?
   - ARN back-fill for Apr–Sep 2026 on staging/live is your data step.
3. **R-1678:** the ledger name "Exchange gain / loss (realised)". Confirm with the CA.
4. Is `books_locked_until` actually set on staging and live? accounting.md §4 says that if it is null, it protects nothing. Setting it is your call.
5. **Measure 1:** agree a staging timing session (1 hour, observer timing) once Wave 1 and Wave 2 are trained to staging. This follows the ≥20-card train rule.
6. **Coordinator OK** for the cards marked CO. Most are migrations, plus R-2186/R-2187 (app shell and root layout), R-2209 (nav label) and R-2210 (new shared component).
