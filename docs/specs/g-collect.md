# G-COLLECT — Payment Follow-up a team can work from

Spec started 3 Nov 2026 (manager session: page audit on localhost + staging, and web research).
Screen: `/collections` (Payment Follow-up). Code: `src/app/(app)/collections/page.tsx`,
`src/lib/queries/collections.ts`, `src/components/features/collections/*`, `src/lib/collections/*`.

## Goal

Open Payment Follow-up → on one screen see who to call **today**, how much is late by age, and
press one button per row.

Measure:
- at least 12 rows per screen at 1280 px;
- every overdue customer has an owner and a next date;
- small leftovers (≤ ₹500, or exactly a TDS %) closed in one click;
- no reminder goes to someone who promised, disputed or already paid.

## Users & flows

- **Owner / manager** — opens the page, reads the age tiles (Overdue · 0–30 · 31–60 · 61–90 · 90+ ·
  Not due yet; a click filters), assigns owners in bulk, reads the weekly report (folded below the list).
- **Collector (team member)** — opens the "Today" queue: follow-ups due today, promises due today,
  broken promises. Per row: one next-action button and a ⋯ menu (Follow-up, Send reminder,
  Record payment). Logs every call with an outcome (promise date + amount, disputed + reason,
  no answer) and a next date.
- **Send reminder** — one dialog: *This invoice* or *Full statement* (all open dues, PDF attached).
  The message carries a pay link for that amount (plus the online fee when the customer bears it —
  see [razorpay-fee.md](razorpay-fee.md)). WhatsApp first, email when there is no
  number. A person presses Send; nothing goes out by itself from the dialog.
- **Small leftovers** — balances ≤ ₹500 or equal to a TDS % sit in a "Small leftovers (N · ₹X)"
  group, with *Book as TDS* (opens Record payment, TDS ticked, bank ₹0) or *Write off* (reason).

## Rules

1. A promise to pay pauses automatic payment reminders (invoice-dunning email + WhatsApp) for that
   customer until the promise date; the day after, reminders resume.
2. "Disputed" + reason pauses chasing for the customer until *Mark dispute resolved* (logged).
3. Broken promise = promise date passed and not paid → flagged, sorted first.
4. Queue order = overdue ₹ × days late, broken promises boosted. One stage chip per row:
   Not contacted · Reminded · Promised · Broken · Disputed · Part-paid.
5. Not-due invoices are hidden by default and never listed as "never followed up".
6. Write-off of a small balance: owner / accountant only, with a reason, through an atomic RPC;
   only ≤ ₹500. TDS leftovers go through the existing Record TDS path, not a write-off.
7. Balance comes from one source (same as Customer Aging); paging past 1,000 rows keeps working.
8. A late fee, if ever added, needs a GST document (debit note) — never a silent balance change.

## Data

- `payment_followups` — `outcome` gains `disputed` / `dispute_resolved` (no migration, R-2411).
- Small-balance write-off: invoice `written_off_at` set by a new atomic RPC (R-2410 migration + SQL test).
- R-2415 adds `invoice_payment_links` (tenant, invoice or statement key, Razorpay link id, amount,
  status, timestamps; RLS) so one bill has one live link.
- Helpers: `collectionHold`, `holdLabel`, `stageFor` (`src/lib/collections/followup-rules.ts`).

## Constraints

- Razorpay payment-link code (R-1608) was built for quotes and sends its own email; until R-2415 the
  reminder carries a UPI (`upi://pay`) link, which opens GPay/PhonePe on a phone but not on desktop.
- WhatsApp Business API messages need Meta-approved templates; send in Indian working hours.
- Renewals for Indian cards cannot rely on card retries; UPI AutoPay / e-NACH is the path (later goal).
- MSME 45-day line and late-fee interest: CA must confirm first — not in this goal.

## Metrics (R-2414)

- DSO = (AR at period end ÷ credit sales in period) × days.
- Best DSO = (not-yet-due AR ÷ credit sales) × days; average days late = DSO − Best DSO.
- CEI = (opening AR + credit sales − closing AR) ÷ (opening AR + credit sales − closing current AR) × 100.
- Promise-kept rate = promises paid in full by their date ÷ promises that fell due.

## Owner decisions

| Question | Answer | Who / when |
|---|---|---|
| Razorpay pay link per bill in reminders? | Yes — card R-2415 | Pardeep, 3 Nov |
| Who pays the gateway fee on that link? | Customer by default, exceptions — see [razorpay-fee.md](razorpay-fee.md) | Pardeep, 3 Nov |
| Small-leftover limit | ₹500 built as default; open (R-2410 `needsDecision`) | open |
| Hold also stops renewal notices / auto-pause? | Default: only payment reminders are held (R-2411) | open |
| Hold per customer or per invoice? | Default: whole customer (R-2411) | open |
| Show MSME 45-day / late fee line? | Not in this goal (needs CA) | Pardeep, 3 Nov |

## Cards graph

`dependsOn` (card ← what it needs first):

| Card | Needs first |
|---|---|
| R-2408 Worklist layout | — |
| R-2411 Promise & dispute hold | — |
| R-2412 One Send reminder + pay link | — |
| R-2409 Today queue + priority + stage | R-2408, R-2411 |
| R-2410 Small leftovers in one click | R-2408 |
| R-2414 Metrics (DSO, CEI, promise-kept) | R-2408 |
| R-2413 Bulk: owner / reminder / statement | R-2409, R-2410, R-2414, R-2411, R-2412 |
| R-2415 Razorpay link per bill | R-2412, R-2413 (same Send reminder file), R-2416 (fee policy) |

Waves (cards in one wave never share a file; R-2409, R-2410, R-2414 all edit
`collections/page.tsx`, so each gets its own wave):

- Wave 1 (parallel): R-2408, R-2411, R-2412.
- Wave 2: R-2409 · Wave 3: R-2410 · Wave 4: R-2414.
- Wave 5: R-2413 · Wave 6: R-2415.

Board status is the truth for what is built; this spec does not track it.
