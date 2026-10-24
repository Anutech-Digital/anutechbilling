/**
 * Kharche ki category maangi jaye ya nahi — aur agar na mile to kya kehna hai.
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * `add-expense-dialog.tsx` ka schema `category: z.string().min(2)` maangta tha, HAMESHA.
 * Par wo khaana screen par sirf simple mode me hota hai:
 *
 *     {!showItems && (<FormField label="Category" required …>)}      // line ~775
 *
 * Bill upload karte hi form itemise mode me chala jata hai (har item ki apni category), aur
 * upar wala khaana gायab ho jata hai — par schema use phir bhi maangta raha. Nateeja:
 *
 *   · React Hook Form validation par ruk jata hai
 *   · Screen par koi error nahi, kyunki jis field par error hai wo render hi nahi hota
 *   · Koi toast nahi, button chalu dikhta hai, dabane par kuch nahi hota
 *   · Network par ek request tak nahi jaati
 *
 * 29 Aug 2026 ko ye browser me pakda gaya: Amazon ka asli tax invoice upload hua, AI ne sab
 * theek padha (vendor, GSTIN, bill no., ₹1,938, GST ₹295.63, HSN 9404 — Amazon ki apni CSV
 * se ek-ek milaya gaya), aur Save par kuch nahi hua. Chup-chaap.
 *
 * Ye CLAUDE.md §24 ka seedha ulanghan hai — "koi dead end nahi". Yahan dead end bhi tha aur
 * chup bhi. Aur ye sirf Amazon par nahi tha: **kisi bhi bill upload par** yahi hota.
 *
 * ─── ISLIYE FAISLA YAHAN HAI, SCHEMA ME NAHI ────────────────────────────────
 * Zod ek field ko "hamesha chahiye" ya "kabhi nahi" hi keh sakta hai. Yahan sach uske beech
 * me hai: itemise mode me category ITEM se aati hai, simple mode me form se. Wo shart is
 * function me likhi hai, aur uska jawab ek PADHNE LAYAK vaakya hai — taaki call site use
 * dikha sake, chahe field khud screen par ho ya na ho.
 */

export interface ExpenseCategoryInput {
  /** Itemise mode chalu hai (har line ki apni category)? */
  itemised: boolean;
  /** Upar wale khaane ki category — sirf simple mode me maujood hoti hai. */
  formCategory?: string | null;
  /** Har line ki category, itemise mode me. */
  itemCategories?: readonly (string | null | undefined)[];
}

const ok = (v: string | null | undefined): boolean =>
  typeof v === "string" && v.trim().length >= 2;

/**
 * `null` = sab theek. Warna wo vaakya jo user ko dikhana hai.
 *
 * Sandesh me "ab kya karein" hai, sirf "nahi ho sakta" nahi — §24. Aur wo Hinglish me hai,
 * baaki form ki tarah.
 */
export function expenseCategoryError(o: ExpenseCategoryInput | null | undefined): string | null {
  if (!o) return "Choose a category — it decides which expense account this is posted to.";

  if (o.itemised) {
    /* Ek bhi line ki category kaafi hai — baaki line uski chhaya me chali jaati hain (save
       par pehli category hi poore kharche ki ban-ti hai), aur har line par zid karna us
       jagah rukavat banata jahan aam taur par sab ek hi khaate ka hota hai.

       ⚠️ Aur upar wali (form ki) category BHI kaafi hai. Maine pehle iska ulta likha tha —
       "itemise me form wali nahi bachati" — aur uske liye ek test bhi likh diya tha. Wo
       maan-na GALAT tha, aur save ka apna code hamesha se ulta keh raha tha:

           category: l.category || values.category                    // catLines banate waqt
           catLines[0].category || values.category                    // save karte waqt

       Form wali category wahan pehle se fallback hai. Pardeep ne isi ko screen par pakda:
       AI ne bill padh kar "Staff Welfare" form me bhar di, save use khushi se le leta — par
       meri jaanch usi ko rok rahi thi, ek aisi baat par jo maine code se poochhi nahi thi.

       Jo jaanch save se ZYADA sakht ho, wo user ko us cheez par rokti hai jo ho sakti thi. */
    const any = (o.itemCategories ?? []).some(ok) || ok(o.formCategory);
    return any
      ? null
      : "Choose a category for the items — in the last column of the items table below.";
  }

  return ok(o.formCategory)
    ? null
    : "Choose a category in the 'Category' field above.";
}
