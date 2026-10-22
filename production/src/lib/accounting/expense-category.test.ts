import { describe, it, expect } from "vitest";
import { expenseCategoryError } from "./expense-category";

/* ─────────────────────────────────────────────────────────────────────────────
   29 Aug 2026, browser me pakda gaya. Amazon ka asli tax invoice upload kiya gaya, AI ne
   sab theek padha — vendor "Coca Industries", GSTIN 23EZFPS9892N2Z7, bill TLTK-4450,
   ₹1,938, GST ₹295.63, HSN 9404 (har aankda Amazon ki apni CSV se milaya gaya) — aur
   "Save expense" dabane par KUCH NAHI HUA.

   Wajah: schema `category` HAMESHA maangta tha, par wo khaana sirf simple mode me render
   hota hai. Bill upload karte hi form itemise mode me chala jata hai aur khaana gायab ho
   jata hai. React Hook Form ek aise field par ruk raha tha jo screen par tha hi nahi:

     · koi error message nahi (jis field par error hai wo render nahi hota)
     · koi toast nahi
     · button chalu dikhta hai
     · network par ek request tak nahi

   CLAUDE.md §24: "koi dead end nahi". Yahan dead end bhi tha aur chup bhi.
   ───────────────────────────────────────────────────────────────────────────── */

describe("expenseCategoryError — itemise mode", () => {
  it("item par category ho to rukavat NAHI — ASLI MAAMLA", () => {
    /* Bill upload wala raasta yahi hai, aur yahi teen hafte se chup-chaap rukа hua tha. */
    expect(expenseCategoryError({
      itemised: true, formCategory: "", itemCategories: ["Travel"],
    })).toBeNull();
  });

  it("kai line me se EK ki category kaafi hai", () => {
    /* Save par pehli category hi poore kharche ki ban-ti hai, isliye har line par zid
       karna sirf rukavat banata — aur aam taur par sab ek hi khaate ka hota hai. */
    expect(expenseCategoryError({
      itemised: true, itemCategories: [null, "", "Office Supplies", undefined],
    })).toBeNull();
  });

  it("kisi bhi line par category na ho to ROKTA hai, aur batata hai KAHAN", () => {
    const msg = expenseCategoryError({ itemised: true, itemCategories: ["", null] });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/item/i);
  });

  it("upar wali category itemise mode me BHI bachati hai — meri hi galti ka test", () => {
    /* Ye test pehle ISKA ULTA kehta tha, aur wo galat tha.

       Maine maan liya tha ki itemise mode me save sirf item ki category leta hai. Save ka
       apna code hamesha se ulta keh raha tha:

           category: l.category || values.category
           catLines[0].category || values.category

       Pardeep ne screen par pakda: AI ne bill padh kar "Staff Welfare" FORM me bhar di, save
       use le leta — par meri jaanch usi ko rok rahi thi, ek aisi baat par jo maine code se
       poochhi nahi thi. Jo jaanch save se zyada sakht ho, wo user ko us cheez par rokti hai
       jo ho sakti thi. */
    expect(expenseCategoryError({
      itemised: true, formCategory: "Travel", itemCategories: ["", ""],
    })).toBeNull();
  });

  it("na item par, na form par — tab hi rokta hai", () => {
    expect(expenseCategoryError({
      itemised: true, formCategory: "", itemCategories: ["", null],
    })).toBeTruthy();
  });
});

describe("expenseCategoryError — simple mode", () => {
  it("category ho to rukavat nahi", () => {
    expect(expenseCategoryError({ itemised: false, formCategory: "Hosting" })).toBeNull();
  });

  it("khaali ho to rokta hai, aur batata hai KAHAN", () => {
    const msg = expenseCategoryError({ itemised: false, formCategory: "" });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/upar|Category/i);
  });

  it("sirf space, ya ek akshar — dono khaali hi hain", () => {
    expect(expenseCategoryError({ itemised: false, formCategory: "   " })).toBeTruthy();
    expect(expenseCategoryError({ itemised: false, formCategory: "A" })).toBeTruthy();
  });

  it("item ki category simple mode me nahi bachati", () => {
    expect(expenseCategoryError({
      itemised: false, formCategory: "", itemCategories: ["Travel"],
    })).toBeTruthy();
  });
});

describe("expenseCategoryError — sandesh khud ek raasta ho", () => {
  it("har sandesh me 'ab kya karein' hota hai, sirf 'nahi ho sakta' nahi", () => {
    /* §24. Ek "Category required" wala sandesh us user ke liye bekaar hai jise wo khaana
       dikh hi nahi raha — isiliye ye bug itni der chhupa raha. */
    for (const o of [
      { itemised: true,  itemCategories: [] },
      { itemised: false, formCategory: "" },
    ] as const) {
      const msg = expenseCategoryError(o)!;
      expect(msg.length).toBeGreaterThan(30);
      expect(msg).toMatch(/^Choose a category/);
      expect(msg).not.toMatch(/chuniye|kharcha|khaane|nahi/);
    }
  });

  it("null par crash nahi, aur chup bhi nahi", () => {
    /* Khaamoshi hi wo bug thi. `null` par `null` lautana use dobara paida kar deta. */
    expect(expenseCategoryError(null)).toBeTruthy();
    expect(expenseCategoryError(undefined)).toBeTruthy();
  });
});
