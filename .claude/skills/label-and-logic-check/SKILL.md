---
name: label-and-logic-check
description: Check a card's words and rules BEFORE building and before calling it done — a button label that reads like a status, a second name for an action the app already names, a "fix" that passes on synthetic data but not on the owner's real path, or a null/empty value that means different things to different readers. Load at the start of every card that adds or renames a label, a button, a status, a money rule or a filter — and on every card that touches a screen (§4: nine screen and data-entry rules) — and again before writing aiResult. Every rule here is a real mistake from 19–21 Oct 2026 that the owner caught, not the tests.
---

# label-and-logic-check

Written 20 Oct 2026 after the owner (Pardeep) asked: "tum ye choti choti logical point me itni
galti kyo karte ho". Tests were green each time; the owner still found the problem in minutes.
The pattern was always the same: a decision was made without first checking what the app
already says, or without walking the owner's real path. This skill makes those two checks
mandatory. Add a rule at the bottom every time the owner catches a new one.

---

## 1. Labels — run before you name anything

**1a. A button says what pressing it DOES. Never a status.**
- ✗ "Pay" on a row where we RECEIVE money (reads as us paying) — R-1697.
- ✗ "Payment aaya" (reads as a message, "payment has come") — R-1697, rejected by the owner.
- ✓ "Record payment" — the action, and the word Zoho Books / Tally users already know.
Test: read the label aloud with "Click to …" in front. If it doesn't make sense, it's wrong.

**1b. One action = one name across the whole app.** Before choosing a label, search for it:
```bash
cd production && grep -rn "Record payment\|Payment received\|<your idea>" src --include=*.tsx | head
```
If the same page or flow already names the action, reuse that exact wording. The dues "Pay"
button sat under a header button already called "Record payment — multiple invoices".

**1c. Words an Indian accountant already knows.** Prefer Zoho Books / Tally vocabulary
(Record payment, Credit note, Receipt voucher, Outstanding, TDS receivable) over invented ones
("close the loop", "MTD" without explanation). All screen text is English, helper text and
tooltips included — see §4 rule 4.

**1d. Customer-facing vs staff-only.** Anything rendered inside a "this is how the customer will
see it" area, a PDF, an email or a public page must contain nothing internal. ✗ "Internal: this
is a prospect — customer record pending payment" printed under Bill to (R-1673). Staff notes go
in chrome OUTSIDE the document.

**1e. A count or amount must say whose it is.** ✗ "Paid ₹2,46,564" on a subscription row that is
really the customer's total across all quotes (R-1701). If a number is per customer, say so or
don't put it on a per-subscription row.

## 2. Logic — run before you call a money fix done

**2a. Reproduce the owner's EXACT path, not a synthetic one.** R-1675's first fix guarded the
catalogue re-price effect and its test passed; on staging the owner's quote had come from a LEAD,
and the lead-plan prefill overwrote the saved rate anyway. Write the test from the real record's
shape (where it came from, what it links to, which fields are empty), then fix.

**2b. Say what empty / null means — at every reader.** R-1668 stored "one-time" as "no
commitment"; older annual lines also had no commitment; two SQL functions defaulted null to
annual, `record_payment` treated it as one-off (R-1686/R-1688). Before giving a missing value a
meaning, grep every reader of that field and list what each does with null. If they disagree,
add an explicit marker instead.

**2c. "Latest per customer" is almost never right for a per-row action.** A customer can have
two subscriptions, two quotes, two invoices. A map keyed by customer_id that keeps "the latest"
(R-1701 `quoteByCustomer`) sends one row's action to another row's record. Key per-row actions
by the row's own id.

**2d. Ages and due dates count from when the money became DUE**, not from the customer's first
ever payment (R-1701: "166d" on a subscription started 10 days earlier). A wrong age drives a
wrong suspend / write-off suggestion.

**2e. A silent drop is a bug even when nothing errors.** The PDF reader returned 200 for every
chunk and still left lines out (R-1693). For money imports, prove completeness (balance chain,
row counts) and block the import when it isn't proven.

**2f. Two names for the same thing on one screen** (e.g. "Awaiting GST Invoice" vs "Awaiting
Invoice" for one number) means one of them is wrong or the number is shown twice. Fix the
duplication, don't rename one of them.

## 3. Before writing aiResult

- [ ] Every new/renamed label passed 1a–1e (paste the grep from 1b into your notes).
- [ ] The test reproduces the owner's real record shape (2a), and fails on the old code.
- [ ] Every null/empty field you touched has one meaning at every reader (2b).
- [ ] Per-row actions are keyed by the row's own id (2c).
- [ ] UI card: the §4 screen and data-entry checklist passed (one line per rule in your notes).
- [ ] UI card: design-critique, accessibility-review and layout-audit were run (CLAUDE.md §9).
- [ ] Say in aiResult what you did NOT check (e.g. "real PDF only on staging").

## 4. Screen and data-entry rules (Pardeep, 21 Oct 2026)

From the 21 Oct review: design ~7/10, data entry ~6/10, and most mistakes were again found by
the owner AFTER the build. Run this checklist on every card that touches a screen, before
building and again before aiResult. Where a rule already lives elsewhere, the link is the rule;
this list does not restate it.

- [ ] **1. One fact, one place.** A number or status appears once per screen. ✗ /payments showed
  "Awaiting Invoice ₹55.9K (3)" twice, as a strip and as a box. Same family as 2f.
- [ ] **2. Statuses never contradict.** A closed document (rejected, cancelled, expired) shows no
  live-money status, and a count equals the rows it opens. ✗ Rejected quote showing "Awaiting
  payment" (R-1718). ✗ "Out for Review ₹0 (0)" over a list of 9 rows (R-1713).
- [ ] **3. The primary button is the right next step for THIS state.** ✗ "Send on WhatsApp" as
  the main button on a rejected quote (R-1724). Wording of the button: 1a–1b.
- [ ] **4. One screen, one language: English** (R-246) — labels, helper text, tooltips, toasts.
  ✗ "chalu/hataye"; tooltip "Customer ne paisa diya — yahan darj karo". Hinglish is for chat
  with Pardeep, never for the UI.
- [ ] **5. Tables fit a 1280px laptop with today's action column visible** without a side
  scroll; if they can't, use cards. ✗ Renewals Action column cut off at 1280 (R-1720). Measure
  with `layout-audit`; phone rules are CLAUDE.md §20.
- [ ] **6. One task, one way.** Every entry point to a task opens the same dialog with the same
  defaults. ✗ Three different ways to record a payment.
- [ ] **7. Ask only what the task needs.** Setup fields live in setup, not in a money dialog.
  ✗ "Customer domain" inside the Record payment dialog.
- [ ] **8. Fewest steps, smart defaults.** Count the clicks against Zoho Books / Tally; when
  there is one option (or one usual option), pre-select it. ✗ The first payment took 6 steps
  (lead → quote → send → mark accepted → invoice → record payment), and "Received in" defaulted
  to "Not sure yet" with only one bank account.
- [ ] **9. Every card carries 2–3 of the owner's own examples, and the first test uses them.**
  Same as 2a; a card without examples gets them before it is built.

## 5. New rules (append one line per owner catch: date · card · rule)

- 20 Oct 2026 · R-1697 · Button labels are actions; reuse the page's existing name for the action.
- 21 Oct 2026 · R-1725 · Nine screen and data-entry rules (§4), checked on every card that touches a screen.
