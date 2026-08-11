# Manual full-flow test — money-spine (live app)

**Goal:** ek baar khud click karke verify karo ki `quote → pay → subscription → invoice`
poora sahi chal raha hai, aur aaj ke naye features live hain.

**Live URL:** https://resellersos-1005662057478.asia-south1.run.app
**Test customer ka naam:** `ZZ TEST Co — 07 Aug` (ZZ prefix se list me sabse neeche dikhega, baad me pehchan aasaan)
**Time:** ~15 min

Har step ke neeche **✅ Expected** likha hai — wahi dikhe to PASS, warna mujhe screenshot bhejo.

---

## STEP 1 — Naya quote (prospect mode) banao
1. `/quotes/new` kholo.
2. Customer Details me toggle **"New prospect"** pe rakho → naam likho: `ZZ TEST Co — 07 Aug`.
3. **Place of supply** me apna hi state (intra-state) choose karo.

✅ **Expected:** Prospect mode me sirf **Country + Place of supply** dikhe (blank grey website/GSTIN box NAHI). Neeche GST hint aaye.

---

## STEP 2 — Google Workspace line + DOMAIN (naya feature)
1. Line Items me **Google Workspace** (koi bhi plan) add karo.
2. Seats = **5**.
3. Us line pe naya **Domain** field bharo: `zztest-example.in`.

✅ **Expected:**
- Line pe domain input dikhe aur type ho jaye.
- Upar header/subline me quote ka **total (₹)** update ho.
- GST 18% dikhe (intra-state → CGST+SGST split).

---

## STEP 3 — Quote save + number/date check
1. Quote save karo.

✅ **Expected:**
- Quote number `Q-2025-26-XXXX` format me mile (JS random nahi).
- **Valid till / expiry date issue-date se pehle NAHI** honi chahiye.

---

## STEP 4 — Payment record karo (record_payment RPC — asli engine)
1. Quote pe **Record payment** kholo.
2. Method = **UPI / Bank transfer** (digital).
3. Reference field **khaali** chhod ke save try karo.
   ✅ **Expected:** validation error — "reference chahiye (≥4 chars + ek digit)".
4. Ab reference = `TESTUPI12345` bharo, amount = full quote amount, save karo.

✅ **Expected:** success toast — payment record + customer auto-create + subscription auto-create ek saath.

---

## STEP 5 — Subscription bana? (spine ka dil)
1. `/subscriptions` kholo → `ZZ TEST Co` dhundo.

✅ **Expected:**
- Nayi subscription bani ho — plan = Google Workspace, **seats = 5**, MRR sahi.
- Us pe **domain `zztest-example.in`** stamp ho (STEP 2 wala domain flow hua).

---

## STEP 6 — Payment received page
1. `/payments` kholo.

✅ **Expected:**
- Payment row dikhe — amount right-aligned, clean status, **LINKED DOCS** column me quote/subscription linked.
- Customer naam saaf (phone/GSTIN suffix ke bina).

---

## STEP 7 — Invoice raise hua? + due-date correctness (naya fix)
1. `/invoices` kholo → `ZZ TEST Co` ka invoice.

✅ **Expected:**
- Invoice raise ho, amount = quote/payment ke barabar.
- **Due date invoice-date se pehle NAHI** (migration 0175). Aging/overdue sahi.

---

## STEP 8 — Customer 360 + naya summary panel
1. `/customers` → `ZZ TEST Co` kholo.

✅ **Expected:**
- Quote-builder / customer view me **Customer Details summary** — Website · GSTIN · Place of supply saaf read-only panel (grey fake-input box nahi).
- MRR / Receivables / Credits sahi.

---

## STEP 9 — Delete guard (Zoho-parity, naya)
1. `ZZ TEST Co` ko **delete** karne ki koshish karo.

✅ **Expected:** delete **BLOCK** ho, itemised reason ke saath (e.g. "1 subscription, 1 payment, 1 invoice, 1 quote linked — pehle wo hatao"). Ye sahi behaviour hai.

---

## STEP 10 — Money-math cross-check
Quote total == Invoice total == Payment amount == Subscription-derived value.
GST: intra-state → CGST+SGST; agar dusre state ka customer banao → IGST.

✅ **Expected:** teenon jagah number **exact same**. Koi mismatch = money bug, turant batao.

---

### Cleanup
STEP 9 ke kaaran test customer delete nahi hoga (documents linked hain) — ye normal hai.
Agar test data hataana ho to bolo, mai SQL se (un-match → delete, salary/trigger safe) saaf kar dunga.

### Kya check kar rahe hain (summary)
| Step | Feature |
|---|---|
| 1–2 | Prospect toggle + per-line domain (naya) |
| 3 | Doc numbering + due-date ≥ issue-date |
| 4 | record_payment RPC + reference validation (naya) |
| 5 | Subscription auto-create + domain stamp |
| 6 | Payments page polish + LINKED DOCS |
| 7 | Invoice due-date fix (0175) |
| 8 | Customer summary panel (aaj ka) |
| 9 | Delete guard (0174, Zoho-parity) |
| 10 | End-to-end money-correctness |
