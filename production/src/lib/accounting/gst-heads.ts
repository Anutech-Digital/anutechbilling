/**
 * Ek kharche ka GST kis KHAANE me jata hai — IGST, ya CGST + SGST.
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * GST report (`accounting/gst/page.tsx`) har expense ke liye ye karti thi:
 *
 *     igst: 0,
 *     cgst: Math.round(g / 2),
 *     sgst: g - cgst,
 *
 * Yaani HAR kharche ka GST aadha-aadha CGST/SGST **maan liya** jata tha, aur IGST hamesha
 * shunya. Comment me likha tha ki ye jaan-boojhkar hai aur "worksheet me flag" hoga — par
 * 29 Aug 2026 ko screen par dhoondha, koi flag nahi tha. Padhne wale ko kabhi pata nahi
 * chalta tha ki ye aankda naapa hua hai ya maana hua.
 *
 * Aur wo maan-na aksar galat hi hota hai. Us din ka asli invoice:
 *
 *     Amazon (ALBERTO INFOTECH, UP-09)  →  ANUTECH (Delhi-07)
 *     Tax Type: IGST   ₹274.42
 *
 *     app kehti thi:   CGST ₹137 + SGST ₹137,  IGST ₹0
 *
 * GSTR-3B ke Table 4(A)(5) me IGST, CGST aur SGST alag column hain. Galat khaane me daala
 * gaya credit GSTR-2B se mel nahi khata, aur wo farq return bharte waqt saamne aata hai —
 * jab use theek karna sabse mehnga hota hai.
 *
 * ─── AANKDA PEHLE SE MAUJOOD THA ────────────────────────────────────────────
 * Sabse buri baat: bill padhne wala AI ye teeno alag-alag nikalta hai (`read-bill.ts` ka
 * prompt `cgst`, `sgst`, `igst` maangta hai). Phir `add-expense-dialog.tsx:261` unhe
 * `cgst + sgst + igst` karke ek number bana deta tha, aur batwara wahin mar jata tha.
 *
 * Isliye ye file do cheezein karti hai: jahan batwara maujood ho wahan use PADHTI hai, aur
 * jahan na ho wahan saaf kehti hai ki ye **maana hua** hai — chhupati nahi.
 */

import { splitIntraStateTax } from "@/lib/gst/tax-split";

export interface GstHeadsInput {
  /** Kul GST — hamesha maujood (`expenses.gst_paid`). */
  gst_paid?: number | null;
  /** Naapa hua batwara, agar bill se mila ho. */
  igst?: number | null;
  cgst?: number | null;
  sgst?: number | null;
}

export interface GstHeads {
  igst: number;
  cgst: number;
  sgst: number;
  /** `true` = ye batwara BILL se aaya. `false` = maana gaya hai. */
  measured: boolean;
  /** Maana gaya ho to kyun — screen par dikhane ke liye. `null` jab naapa hua ho. */
  assumption: string | null;
}

const n = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

const ASSUMED =
  "The bill had no IGST / CGST split — treated as intra-state and split half-and-half";

/**
 * Batwara nikalo.
 *
 * Naapa hua tab maana jata hai jab teeno me se kam se kam ek maujood ho AUR unka jod kul
 * GST se mel khata ho. "Mel khana" par ek rupaye ki chhoot hai: bill par paise hote hain
 * (₹274.42) aur `expenses` poore rupaye me rakhta hai, to rounding ka ek rupaya bachta hai.
 * Us ek rupaye par poore batware ko phenk dena ulta nuksaan hai — wo sahi aankde ko maane
 * hue se badal deta.
 */
export function expenseGstHeads(e: GstHeadsInput | null | undefined): GstHeads {
  const total = n(e?.gst_paid);
  const igst = n(e?.igst);
  const cgst = n(e?.cgst);
  const sgst = n(e?.sgst);
  const split = igst + cgst + sgst;

  if (total === 0) {
    /* GST hai hi nahi — yahan "maana hua" kehna galat hoga. Shunya ek naapa hua shunya hai. */
    return { igst: 0, cgst: 0, sgst: 0, measured: true, assumption: null };
  }

  if (split > 0 && Math.abs(split - total) <= 1) {
    return { igst, cgst, sgst, measured: true, assumption: null };
  }

  /* Yahan pahunchne ka matlab: ya to batwara hai hi nahi, ya wo kul se mel nahi khata.
     Doosri soorat bhi "maana hua" hai — aadha sach poore jhooth se kam khatarnak nahi hai
     jab wo sach jaisa dikhe. */
  /* Shared CGST/SGST rule (lib/gst/tax-split.ts) — same split the invoice and GSTR-1 use. */
  const half = splitIntraStateTax(total);
  return {
    igst: 0,
    cgst: half.cgst,
    sgst: half.sgst,
    measured: false,
    assumption:
      split > 0
        ? `The bill's split (₹${split}) does not match the total GST (₹${total}) — treated as intra-state and split`
        : ASSUMED,
  };
}

/**
 * Kitne rupaye ka GST maane hue batware par khada hai.
 *
 * Ye report ke sir par ek hi line me dikhane ke liye hai. "3 row maani hui hain" kam
 * batata hai — 3 row ₹40 ki bhi ho sakti hain aur ₹40,000 ki bhi, aur return bharne wale
 * ke liye wo do bilkul alag baatein hain.
 */
export function assumedGstTotal(rows: readonly GstHeadsInput[]): { count: number; amount: number } {
  let count = 0;
  let amount = 0;
  for (const r of rows) {
    const h = expenseGstHeads(r);
    if (!h.measured) { count += 1; amount += n(r.gst_paid); }
  }
  return { count, amount };
}
