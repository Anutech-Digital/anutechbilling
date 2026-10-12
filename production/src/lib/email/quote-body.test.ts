import { describe, it, expect } from "vitest";
import { quoteEmailBody, cycleUnitSuffix, indianDate } from "./quote-body";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

/* ─────────────────────────────────────────────────────────────────────────────
   Do baar Pardeep ne ye chitthi padhi, aur dono baar sahi kami batayi.

   PEHLE — Q-ADPL-2026-27-0068, jaisa customer ke paas gaya:

     25 × Google Workspace Business Starter — ₹8,125
     Subtotal ₹8,125 · GST 18% ₹1,463 · TOTAL ₹9,588

   Uska jawab ek line me: "monthly quotation hai" — aur *monthly* shabd kahin nahi tha.
   ₹8,125 padhne me ek-baar ka lagta hai, ya saal ka. Usi mail ke saath laga PDF keh raha tha
   "Rs 325/seat/mo · Commitment — None, cancel any month".

   PHIR — usne kaha ise poora aur professional likho, aur wo bhi theek tha: ek B2B quotation
   ki chitthi jisme supplier ka GSTIN, date, place of supply aur CGST/SGST ka alag hisaab na
   ho, wo kisi ke accounts department ke kaam ki nahi hai. Unhe ye jaanne ke liye PDF kholna
   na pade ki bech kaun raha hai aur kis tax head par.
   ───────────────────────────────────────────────────────────────────────────── */

const FLEX: QuoteLineItem[] = [
  { name: "Google Workspace Business Starter", qty: 25, rate: 325, cost: 300, commitment: "monthly" },
] as unknown as QuoteLineItem[];

const ANNUAL: QuoteLineItem[] = [
  { name: "Google Workspace Business Starter", qty: 15, rate: 3240, cost: 3000, commitment: "annual_yearly" },
] as unknown as QuoteLineItem[];

const SUPPLIER = {
  name: "ANUTECH DIGITAL PVT LTD",
  gstin: "07ABDCA0298H1ZP",
  address: "Delhi",
  state: "Delhi",
  email: "sales@anutech.in",
  phone: "+91 98765 43210",
};

const TERMS = {
  payment: "100% in advance against our GST tax invoice",
  provisioning: "Accounts are provisioned within one working day of payment confirmation",
  migration: "Existing mail and data are migrated at no extra charge",
};

const base = {
  quoteId: "Q-ADPL-2026-27-0087",
  customerName: "Omega Co",
  supplier: SUPPLIER,
  discountPct: 0,
  discount: 0,
  taxRate: 18,
  interState: false,
  createdDate: "2026-08-31",
  expiresDate: "2026-09-07",
  terms: TERMS,
};

const monthly = quoteEmailBody({
  ...base, lineItems: FLEX, billingCycle: "monthly",
  subtotal: 8_125, tax: 1_463, total: 9_588,
});

const annual = quoteEmailBody({
  ...base, lineItems: ANNUAL, billingCycle: "yearly",
  subtotal: 48_600, tax: 8_748, total: 57_348,
});

describe("maasik quotation par MAASIK likha hota hai", () => {
  it("ASLI MAAMLA — har aankde ke saath /month", () => {
    /* Wahi kami thi. Ek jagah ikai chhoot jaye to padhne wala andaza lagayega. */
    expect(monthly).toContain("₹8,125/month");
    expect(monthly).toContain("₹9,588/month");
  });

  it("kul jod ka LABEL bhi batata hai ki ye har mahine dena hai", () => {
    expect(monthly).toContain("PAYABLE EACH MONTH");
  });

  it("per-seat rate apni ikai ke saath — yahi aankda grahak jaanchta hai", () => {
    expect(monthly).toContain("₹325 per seat per month");
  });

  it("billing ki shart apni line par, aur wo BECHNE wali baat hai", () => {
    expect(monthly).toContain("no commitment, cancel or change seats any month");
  });
});

describe("saalana par saalana", () => {
  it("koi /month nahi, aur rate per SAAL", () => {
    /* Flex ka rate per seat per MAHINA, annual ka per SAAL. Dono ko ek jaisa likhna wahi 12×
       ki galti hai — covering letter me. */
    expect(annual).toContain("₹3,240 per seat per year");
    expect(annual).not.toContain("/month");
    expect(annual).toContain("TOTAL PAYABLE");
    expect(annual).toContain("Annual commitment, billed yearly");
  });
});

describe("supplier ki pehchan — accounts department ke liye", () => {
  it("GSTIN, address aur sampark signature me", () => {
    expect(annual).toContain("GSTIN 07ABDCA0298H1ZP");
    expect(annual).toContain("sales@anutech.in");
    expect(annual).toContain("For ANUTECH DIGITAL PVT LTD");
  });

  it("quotation number, date aur validity — teeno", () => {
    expect(annual).toContain("Q-ADPL-2026-27-0087");
    expect(annual).toContain("31 Aug 2026");
    expect(annual).toContain("7 Sept 2026");
  });

  it("subject line, taaki file ki ja sake", () => {
    expect(annual).toContain("Sub:  Quotation for Google Workspace Business Starter — 15 seats");
  });

  it("HSN aur place of supply", () => {
    expect(annual).toContain("998313");
    expect(annual).toContain("Delhi (intra-state)");
  });
});

describe("GST ka head — jaise invoice raise hoga", () => {
  it("intra-state par CGST + SGST, aadha-aadha", () => {
    expect(annual).toContain("CGST 9%");
    expect(annual).toContain("SGST 9%");
    expect(annual).not.toContain("IGST");
  });

  it("dono aadhe jod kar POORA tax bante hain", () => {
    /* Ye rate se dobara nahi ginte — row ne jo `tax` maana hai, uske do aadhe hone chahiye.
       8,748 vishham hai, to 4,374 + 4,374 = 8,748 milna chahiye, 8,749 nahi. */
    const odd = quoteEmailBody({
      ...base, lineItems: ANNUAL, billingCycle: "yearly",
      subtotal: 48_600, tax: 8_749, total: 57_349,
    });
    const nums = [...odd.matchAll(/[CS]GST 9%\s+₹([\d,]+)/g)]
      .map((m) => Number(m[1].replace(/,/g, "")));
    expect(nums).toHaveLength(2);
    expect(nums[0] + nums[1]).toBe(8_749);
  });

  it("inter-state par ek hi IGST line", () => {
    const igst = quoteEmailBody({
      ...base, interState: true, lineItems: ANNUAL, billingCycle: "yearly",
      subtotal: 48_600, tax: 8_748, total: 57_348,
    });
    expect(igst).toContain("IGST 18%");
    expect(igst).not.toContain("CGST");
    expect(igst).toContain("Delhi (inter-state)");
  });
});

describe("vaade template ke nahi, tenant ke hote hain", () => {
  it("terms diye to chhapte hain", () => {
    expect(annual).toContain("100% in advance against our GST tax invoice");
    expect(annual).toContain("no extra charge");
  });

  it("terms na do to TERMS ka poora hissa hi nahi", () => {
    /* "Free migration" ek COMMERCIAL vaada hai. Ye repo model ko aisa vaada gadhne nahi deta,
       to template ko bhi nahi dena chahiye — doosre reseller ka offer alag hoga. */
    const bare = quoteEmailBody({
      ...base, terms: undefined, expiresDate: null,
      lineItems: FLEX, billingCycle: "monthly",
      subtotal: 8_125, tax: 1_463, total: 9_588,
    });
    expect(bare).not.toContain("TERMS");
    expect(bare).not.toContain("no extra charge");
    /* Par baaki chitthi poori rehni chahiye. */
    expect(bare).toContain("PAYABLE EACH MONTH");
    expect(bare).toContain("For ANUTECH DIGITAL PVT LTD");
  });

  it("aadhe terms par sirf wahi line", () => {
    const some = quoteEmailBody({
      ...base, terms: { payment: "Net 15 days" },
      lineItems: ANNUAL, billingCycle: "yearly",
      subtotal: 48_600, tax: 8_748, total: 57_348,
    });
    expect(some).toContain("Net 15 days");
    expect(some).not.toContain("no extra charge");
  });
});

describe("discount tabhi jab ho", () => {
  it("0% par discount ki line hi nahi", () => {
    /* Flex par discount lagta hi nahi (Pardeep ka niyam), to "Discount 0%" sirf sawaal
       paida karta. */
    expect(monthly).not.toContain("Discount");
  });

  it("hone par ikai ke saath", () => {
    const withDisc = quoteEmailBody({
      ...base, lineItems: ANNUAL, billingCycle: "yearly",
      discountPct: 3, discount: 1_458, subtotal: 48_600, tax: 8_486, total: 55_628,
    });
    expect(withDisc).toContain("Discount 3%");
    expect(withDisc).toContain("-₹1,458");
  });
});

describe("date app ke apne format me", () => {
  it("2026-09-07 nahi, 7 Sept 2026", () => {
    /* Maine pehle apna alag formatter likha tha jo "07 Sep" deta tha; koi doosri screen aisa
       nahi dikhati. Ek app, ek date format. */
    expect(annual).toContain("7 Sept 2026");
    expect(annual).not.toContain("2026-09-07");
  });

  it("khaali ya galat date par wo line hi nahi aati", () => {
    expect(indianDate("kuch bhi nahi")).toBeNull();
    expect(indianDate(null)).toBeNull();
  });
});

describe("ikai ka naksha", () => {
  it("chaaron cycle", () => {
    expect(cycleUnitSuffix("monthly")).toBe("/month");
    expect(cycleUnitSuffix("quarterly")).toBe("/quarter");
    expect(cycleUnitSuffix("half_yearly")).toBe("/half-year");
    expect(cycleUnitSuffix("yearly")).toBe("");
  });
});

describe("adhoori jaankari par bhi chitthi theek rehti hai", () => {
  it("grahak ka naam na ho", () => {
    const anon = quoteEmailBody({
      ...base, customerName: "   ", lineItems: FLEX, billingCycle: "monthly",
      subtotal: 8_125, tax: 1_463, total: 9_588,
    });
    expect(anon).toContain("Dear Sir/Madam,");
  });

  it("supplier ka GSTIN ya state na ho to wo line chhoot jati hai, galat nahi chhapti", () => {
    const thin = quoteEmailBody({
      ...base, supplier: { name: "Some Reseller" },
      lineItems: FLEX, billingCycle: "monthly",
      subtotal: 8_125, tax: 1_463, total: 9_588,
    });
    expect(thin).not.toContain("GSTIN");
    expect(thin).not.toContain("Place of supply");
    expect(thin).toContain("For Some Reseller");
  });
});
