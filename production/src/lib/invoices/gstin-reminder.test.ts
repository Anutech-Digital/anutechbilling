import { describe, it, expect } from "vitest";
import { issueConsequences, type QuoteToInvoice } from "./issue-consequences";
import type { SeriesState } from "@/lib/actions/consequence";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026, Pardeep ne ek asli AI reply padh kar kaha:

     "quotation bhejte waqt gst number ki jarurat nahi hoti, wo to invoice ke waqt padti
      hai — par compulsory invoice me bhi nahi hai kyoki kai logo ke pass gst number hota
      hi nahi. Par reminder jarur hona chahiye invoice ke waqt."

   Wo teeno baaton par sahi hain, kanoon me bhi: CGST Rule 46(b) kharidaar ka GSTIN tab
   maangta hai JAB wo registered ho. Bina GSTIN wale ko di gayi supply ek poori tarah
   valid B2C tax invoice hai.

   Isliye ye ek YAAD-DAHANI hai, rukavat nahi. Aur ye file khaas kar us farak par zid
   karti hai — kyunki rok lag jana ek poori shreni ke asli customer ko baahar kar dega.
   ───────────────────────────────────────────────────────────────────────────── */

const SERIES: SeriesState = {
  prefix: "INV", docCode: "ADPL", fiscalYear: "FY2627", lastNumber: 39,
} as SeriesState;

const quote = (over: Partial<QuoteToInvoice> = {}): QuoteToInvoice => ({
  id: "Q-ADPL-2026-27-0040",
  customerName: "Omega Co",
  amount: 363204,
  paymentTermsDays: 30,
  ...over,
});

const textOf = (q: QuoteToInvoice) =>
  issueConsequences({ quote: q, series: SERIES }).consequences.map((c) => c.text).join(" | ");

describe("GSTIN na ho to YAAD dilata hai", () => {
  it("null par reminder aata hai, aur customer ka naam leta hai", () => {
    const t = textOf(quote({ customerGstin: null }));
    expect(t).toMatch(/GSTIN/);
    expect(t).toMatch(/Omega Co/);
  });

  it("khaali string bhi 'nahi hai' hi hai", () => {
    expect(textOf(quote({ customerGstin: "   " }))).toMatch(/GSTIN/i);
  });

  it("sandesh batata hai ki ye VALID hai — customer ko na-kabil nahi thehrata", () => {
    /* "kai logo ke pass gst number hota hi nahi." Agar ye line dar paida kare, to
       operator bina GSTIN wale customer ko invoice dena hi band kar dega. */
    const t = textOf(quote({ customerGstin: null }));
    expect(t).toMatch(/B2C/);
    expect(t).toMatch(/valid/i);
  });

  it("sandesh batata hai ki nuksaan kya hai, aur kis taraf", () => {
    const t = textOf(quote({ customerGstin: null }));
    expect(t).toMatch(/input credit/i);
    expect(t).toMatch(/cannot be corrected|credit note/i);
  });
});

describe("GSTIN ho, ya poochha hi na gaya ho — tab CHUP", () => {
  it("GSTIN maujood ho to koi reminder nahi", () => {
    expect(textOf(quote({ customerGstin: "07ABDCA0298H1ZP" }))).not.toMatch(/GSTIN/);
  });

  it("caller ne bataya hi nahi (undefined) — tab bhi chup", () => {
    /* Andaza nahi lagata. Har invoice par ek jhoothi chetavni wo chetavni hai jise koi
       nahi padhta, aur ise usi din padha jana hai jis din ye sach hai. */
    expect(textOf(quote({}))).not.toMatch(/GSTIN/);
  });
});

describe("ROKTA NAHI — sabse zaroori baat", () => {
  /* Dialog `blocked` aise nikalta hai (confirm-issue-dialog.tsx):
       tone === "warning" && /no amount|nothing can be issued/i.test(text)
     Naya reminder bhi "warning" hai, isliye uska MATN us regex se nahi milna chahiye —
     warna bina GSTIN wale har customer ka invoice hi ruk jayega. */
  const BLOCKING = /no amount|nothing can be issued/i;

  it("reminder ka matn blocking wale regex se nahi milta", () => {
    const c = issueConsequences({ quote: quote({ customerGstin: null }), series: SERIES })
      .consequences.find((x) => /GSTIN/.test(x.text))!;
    expect(c).toBeDefined();
    expect(BLOCKING.test(c.text)).toBe(false);
  });

  it("bina GSTIN wale poore quote par bhi kuch block nahi hota", () => {
    const blocked = issueConsequences({ quote: quote({ customerGstin: null }), series: SERIES })
      .consequences.some((c) => c.tone === "warning" && BLOCKING.test(c.text));
    expect(blocked).toBe(false);
  });

  it("par ₹0 wala quote ab bhi rukta hai — purani rok toothi nahi", () => {
    const blocked = issueConsequences({ quote: quote({ amount: 0, customerGstin: null }), series: SERIES })
      .consequences.some((c) => c.tone === "warning" && BLOCKING.test(c.text));
    expect(blocked).toBe(true);
  });
});

describe("AI quote ke waqt GSTIN NAHI maangta", () => {
  it("sales agent ke prompt me saaf mana kiya gaya hai", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const p = readFileSync(join(process.cwd(), "src", "lib", "ai", "sales-agent.ts"), "utf8");
    /* Asli reply jo Pardeep ne pakdi:
         "Share your company's GSTIN and billing address and I will issue the formal invoice."
       Prompt me kahin ye maanga nahi gaya tha — model ne khud joda, kyunki wo Indian B2B
       ki tarah sunai deta hai. Isliye ab saaf MANA likha hai. */
    expect(p).toMatch(/NEVER ASK FOR A GSTIN/);
    expect(p).toMatch(/billing address/i);
  });
});
