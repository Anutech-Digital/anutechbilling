# Manual full-flow test #2 — LEAD-first, complex deal (live app)

**Goal:** poora spine **lead → quote → (partial) pay → multiple subscriptions → invoice → upsell**,
plus real-world complexity: **inter-state IGST**, **multi-domain bulk deal**, **partial payment**.

**Live URL:** https://resellersos-1005662057478.asia-south1.run.app
**Test customer:** `ZZ BigCorp — 07 Aug`
**Time:** ~20 min

Har step ke neeche **✅ Expected**. Match na ho to screenshot bhejo.

> **Pehle ek baat (honest):** aaj bhi ek quote me **alag-alag PRODUCTS** (jaise Workspace + M365)
> abhi bhi **ek hi subscription** banate hain — wo multi-product→multi-sub redesign queue me hai.
> Par ek hi product ke **kai DOMAINS (bulk)** sahi tarike se **har domain ka alag subscription**
> banate hain — ye test wahi (built) wala complex case check karta hai.

---

## STEP 1 — Inbound lead banao
1. `/leads` → **Add lead**.
2. Company: `ZZ BigCorp — 07 Aug`, plan = **Google Workspace**, seats ≈ **15**.
3. **State:** koi aisa state chuno jo **tumhare (Anutech ke) state se ALAG** ho (IGST test ke liye).
4. Stage set karo (e.g. Quote/Demo), save.

✅ **Expected:** lead Kanban/list me dikhe, deal-value auto-calc ho, heat/priority badge aaye.

---

## STEP 2 — Lead se seedha quote
1. Us lead pe row-action / card se **"Send quote"** dabao.

✅ **Expected:** quote builder khule, **lead ka context prefilled** (naam + Google Workspace plan). Customer abhi prospect ho sakta hai — theek hai.

---

## STEP 3 — Bulk multi-domain line banao
1. Line Items me neeche **"Bulk / many domains"** button dabao.
2. Google Workspace choose karke **3 domains** add karo, jaise:
   - `alpha-zz.in` — 5 seats
   - `beta-zz.in` — 6 seats
   - `gamma-zz.in` — 4 seats

✅ **Expected:** ek **bulk line** bane jisme 3 domains dikhein, **qty = 15** (5+6+4, read-only — qty edit nahi, domains edit karo).

---

## STEP 4 — Inter-state → IGST check
Customer/prospect ka state tumhare state se alag hai, to:

✅ **Expected:** GST note **"⚠ Inter-state → IGST 18%"** dikhe (CGST+SGST split NAHI). Total me single 18% IGST.

---

## STEP 5 — Quote save
✅ **Expected:** `Q-2025-26-XXXX` number; expiry issue-date se pehle nahi.

---

## STEP 6 — PARTIAL payment (aadha abhi)
1. Quote pe **Record payment**.
2. Method = **Bank transfer**, reference = `NEFTZZ90001`.
3. **Amount field ko hand-edit** karke **total ka aadha** daalo (e.g. total ₹X hai to ₹X/2).
4. Save.

✅ **Expected:** success — payment record + customer auto-create + **bulk fan-out** ho. Outstanding = baaki aadha.

---

## STEP 7 — TEEN subscriptions bane? (bulk fan-out ka asli test)
1. `/subscriptions` → `ZZ BigCorp`.

✅ **Expected:** **3 alag subscriptions** —
- alpha-zz.in (5 seats), beta-zz.in (6), gamma-zz.in (4) — har ek pe sahi domain + seats + MRR.

---

## STEP 8 — Partial money-math
1. `/customers` → `ZZ BigCorp` → Receivables. Aur `/payments`, `/invoices` dekho.

✅ **Expected:**
- Receivables = **exactly baaki aadha** (na zyada na kam, double-count nahi).
- Payment row partial dikhe, LINKED DOCS me quote/subs.
- Invoice amount = full quote (invoice pura banta hai; payment partial).

---

## STEP 9 — Balance close karo
1. Dobara **Record payment** → baaki aadha amount → save.

✅ **Expected:** Receivables **₹0** ho jaye. (Chaho to STEP 6 me overpay karke dekho → extra **advance credit** ban-na chahiye.)

---

## STEP 10 — Lead ka kya hua?
1. `/leads` me `ZZ BigCorp` dhundo.

✅ **Expected:** lead **Won** ho gaya / customer ban gaya (dobara active lead me na dikhe).

---

## STEP 11 — Upsell / renewal-style (seat add)
1. `/subscriptions` → `alpha-zz.in` sub kholo → **Add seats** (5 → 8).

✅ **Expected:** ek naya **upsell quote** generate ho aur khul jaye (seat delta ke saath). Ye renewal/upsell path hai.

---

## STEP 12 — Final money-math
Σ(3 subscriptions ka value) == quote/invoice total; IGST 18% sahi; partial + balance == total.

✅ **Expected:** sab jagah number **consistent**. Koi mismatch = turant batao.

---

### (Optional) Advanced — TDS variant
Bade B2B customer 10% TDS kaat te hain. STEP 6 me **TDS checkbox** on karo →
"amount received" (bank) auto = remaining − TDS ho jaye, par quote **poora settle** ho (bank + TDS).
✅ Quote closed dikhe bhale bank me kam paisa aaya.

---

### Cleanup
`ZZ BigCorp` bhi delete nahi hoga (documents linked — guard). Test data hataana ho to bolo,
mai SQL se safe (un-match → delete) saaf kar dunga.

### Kya check ho raha hai
| Step | Feature |
|---|---|
| 1–2 | Lead create + lead→quote prefill |
| 3 | Bulk multi-domain line |
| 4 | Inter-state IGST branch |
| 6 | Partial payment (hand-edit amount) |
| 7 | **Bulk fan-out → 3 subscriptions** |
| 8–9 | Partial receivables math + balance close |
| 10 | Lead → Won/customer conversion |
| 11 | Seat upsell → renewal quote |
| 12 | End-to-end money-correctness |
| opt | TDS deduction path |
