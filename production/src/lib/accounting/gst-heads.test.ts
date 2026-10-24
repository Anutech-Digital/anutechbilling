import { describe, it, expect } from "vitest";
import { expenseGstHeads, assumedGstTotal } from "./gst-heads";

/* ─────────────────────────────────────────────────────────────────────────────
   29 Aug 2026. Pardeep ka asli Amazon invoice:

       ALBERTO INFOTECH PRIVATE LIMITED (UP, GSTIN 09…)  →  ANUTECH (Delhi, 07…)
       Net ₹1,524.58 · Tax Rate 18% · Tax Type IGST · Tax ₹274.42 · Total ₹1,799

   App us par kehti thi: CGST ₹137 + SGST ₹137, IGST ₹0. GSTR-3B me wo galat khaana hai,
   aur GSTR-2B se mel nahi khayega.

   Aur aankda maujood tha: bill padhne wala AI `cgst`/`sgst`/`igst` alag maangta hai
   (read-bill.ts). `add-expense-dialog.tsx:261` unhe jod kar ek number bana deta tha.
   ───────────────────────────────────────────────────────────────────────────── */

describe("expenseGstHeads — naapa hua batwara", () => {
  it("IGST wale bill ko IGST hi rakhta hai — ASLI MAAMLA", () => {
    /* ₹274.42 poore rupaye me 274 hoke aata hai. */
    const h = expenseGstHeads({ gst_paid: 274, igst: 274, cgst: 0, sgst: 0 });
    expect(h).toEqual({ igst: 274, cgst: 0, sgst: 0, measured: true, assumption: null });
  });

  it("CGST+SGST wale bill ko waise hi rakhta hai", () => {
    const h = expenseGstHeads({ gst_paid: 180, cgst: 90, sgst: 90, igst: 0 });
    expect(h.cgst).toBe(90);
    expect(h.sgst).toBe(90);
    expect(h.igst).toBe(0);
    expect(h.measured).toBe(true);
  });

  it("ek rupaye ka rounding batware ko nahi phenkta", () => {
    /* Bill par paise hote hain (₹274.42), `expenses` poore rupaye rakhta hai. Us ek
       rupaye par sahi aankda phenk dena use maane hue se BADAL dena hoga — ulta nuksaan. */
    const h = expenseGstHeads({ gst_paid: 275, igst: 274 });
    expect(h.measured).toBe(true);
    expect(h.igst).toBe(274);
  });
});

describe("expenseGstHeads — jab batwara nahi hai", () => {
  it("batwara na ho to aadha-aadha, PAR measured=false", () => {
    /* Aadha-aadha maan-na apne aap me galat nahi hai — chhupana galat hai. */
    const h = expenseGstHeads({ gst_paid: 180 });
    expect(h.cgst + h.sgst).toBe(180);
    expect(h.igst).toBe(0);
    expect(h.measured).toBe(false);
    expect(h.assumption).toBeTruthy();
  });

  it("visham ginti par ek bhi rupaya nahi khota", () => {
    /* 181 ko aadha karne par 90.5 — agar dono taraf round kiya to 182 ya 180 ban jata,
       aur GST me ek rupaya bhi banta hua paisa hai. */
    const h = expenseGstHeads({ gst_paid: 181 });
    expect(h.cgst + h.sgst).toBe(181);
  });

  it("batwara kul se MEL NA KHAYE to bhi maana hua hi hai", () => {
    /* Aadha sach poore jhooth se kam khatarnak nahi hai jab wo sach jaisa dikhe. */
    const h = expenseGstHeads({ gst_paid: 500, igst: 274 });
    expect(h.measured).toBe(false);
    expect(h.assumption).toContain("does not match the total GST");
    expect(h.cgst + h.sgst).toBe(500);
  });

  it("wajah likhi hoti hai, taaki screen par dikh sake", () => {
    expect(expenseGstHeads({ gst_paid: 100 }).assumption).toMatch(/intra-state/);
  });
});

describe("expenseGstHeads — shunya aur kachra", () => {
  it("GST hai hi nahi to wo NAAPA HUA shunya hai, maana hua nahi", () => {
    /* Bina GST wale kharche par "maana hua" ka nishaan lagana report ko shor se bhar
       dega, aur phir asli chetavni usi shor me kho jayegi. */
    const h = expenseGstHeads({ gst_paid: 0 });
    expect(h.measured).toBe(true);
    expect(h.assumption).toBeNull();
    expect(h.igst + h.cgst + h.sgst).toBe(0);
  });

  it("null/undefined par crash nahi", () => {
    expect(expenseGstHeads(null).measured).toBe(true);
    expect(expenseGstHeads(undefined).cgst).toBe(0);
  });

  it("rinaatmak aur NaN ko shunya maanta hai", () => {
    const h = expenseGstHeads({ gst_paid: 100, igst: -50, cgst: NaN });
    expect(h.measured).toBe(false);
    expect(h.cgst + h.sgst).toBe(100);
  });

  it("rinaatmak jod kar kul se MEL nahi khila sakta — ASLI KHATRA", () => {
    /* Ye upar wale test se alag hai, aur zaroori hai. Agar rinaatmak value chal jaye to
       150 + (−50) = 100 hoke kul se MEL KHA JATA, aur ek bekaar batwara "naapa hua" ka
       thappa le leta. Ek negative CGST kisi bill par hota hi nahi; wo kharab data hai,
       aur kharab data ko sach ka darja nahi milna chahiye. */
    const h = expenseGstHeads({ gst_paid: 100, igst: 150, cgst: -50 });
    expect(h.measured).toBe(false);
    expect(h.igst).toBe(0);
    expect(h.cgst + h.sgst).toBe(100);
  });
});

describe("assumedGstTotal — ginti ke saath RAQAM", () => {
  it("kitne aur kitne ka — dono", () => {
    /* "3 row maani hui hain" kam batata hai: 3 row ₹40 ki bhi ho sakti hain aur ₹40,000
       ki bhi, aur return bharne wale ke liye wo do bilkul alag baatein hain. */
    const out = assumedGstTotal([
      { gst_paid: 274, igst: 274 },   // naapa
      { gst_paid: 1000 },             // maana
      { gst_paid: 500 },              // maana
      { gst_paid: 0 },                // GST hai hi nahi
    ]);
    expect(out).toEqual({ count: 2, amount: 1500 });
  });

  it("sab naapa hua ho to shunya", () => {
    expect(assumedGstTotal([{ gst_paid: 180, cgst: 90, sgst: 90 }])).toEqual({ count: 0, amount: 0 });
  });

  it("khaali list par shunya", () => {
    expect(assumedGstTotal([])).toEqual({ count: 0, amount: 0 });
  });
});
