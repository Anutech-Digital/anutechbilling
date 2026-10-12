import { describe, it, expect } from "vitest";
import { maskAuthorisedSellingPoints, buildSalesAgentPrompt } from "./sales-agent";
import { findPromises } from "./promise-check";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026, live, 70 seats. Pardeep ne mail bheja, draft bilkul sahi bana — aur RUKA:

     ai_action_log → reply.send / held
       'The draft commits us to something nobody authorised — it says "discount".'

   Draft ke do vaakya:

     "For 70 seats, our published 5% reseller volume discount applies."     ← chhoot mili
     "...Rs 3,078 per seat per year plus 18% GST after the discount."      ← ROKA GAYA

   `maskAuthorisedSellingPoints` sirf US vaakya ki chhoot deta hai jisme is deal ka
   authorised percent likha ho. Pehle me "5%" tha, doosre me sirf "the discount".

   GUARD SAHI HAI. Bina aankde wala discount-vaada theek wahi cheez hai jise wo pakadne ke
   liye bana hai, aur uske apne comment kehte hain ki use chaudा karna hi wo tarika hai
   jisse ek paise ka pehra marta hai.

   Par isse reply ek sikke ka uchhaal ban jata thi: wahi authorised 5% kabhi chala jata,
   kabhi ruk jata — is baat par ki model ne aankda dohraya ya nahi. (Ek ghanta pehle 100
   seats wali reply ne har baar "5%" likha tha aur chali gayi thi.)

   Isliye niyam PROMPT me gaya, guard me nahi. Ye file dono par zid karti hai — aur doosri
   wali zyada zaroori hai.
   ───────────────────────────────────────────────────────────────────────────── */

describe("guard KAMZOR nahi hua — sabse zaroori", () => {
  it("bina aankde wala 'discount' ab bhi pakda jata hai", () => {
    /* Wahi vaakya jo live ruka tha. Agar ye kabhi khaali ho gaya, matlab kisi ne guard
       dheela kar diya — aur tab ek aisa discount bhi nikal jayega jo app ne kabhi
       compute nahi kiya. */
    const held = maskAuthorisedSellingPoints(
      "Rs 3,078 per seat per year plus 18% GST after the discount.", 5);
    expect(held).toMatch(/\bdiscount\b/i);
    expect(findPromises(held).findings.some((f) => f.kind === "discount")).toBe(true);
  });

  it("model ka apna banaya discount ab bhi pakda jata hai", () => {
    const invented = maskAuthorisedSellingPoints("I can give you a 10% discount on this.", 5);
    expect(findPromises(invented).findings.some((f) => f.kind === "discount")).toBe(true);
  });

  it("slab kuch na de to koi discount chhoot nahi paata", () => {
    const none = maskAuthorisedSellingPoints("Here is a 5% discount.", 0);
    expect(findPromises(none).findings.some((f) => f.kind === "discount")).toBe(true);
  });
});

describe("aankde ke saath likha ho to chhoot milti hai — pehle bhi milti thi", () => {
  it("live wala pehla vaakya nikal jata hai", () => {
    const ok = maskAuthorisedSellingPoints(
      "For 70 seats, our published 5% reseller volume discount applies.", 5);
    expect(findPromises(ok).findings.some((f) => f.kind === "discount")).toBe(false);
  });
});

describe("prompt model se aankda dohrane ko kehta hai", () => {
  /* Nirdesh SYSTEM prompt me nahi, USER prompt me jata hai — rate card ke saath, jo har
     call par lib/pricing/volume-slabs.ts se banta hai. Isliye prompt ASLI me bana kar
     dekha ja raha hai, file padh kar nahi: file me likha hona aur model tak pahunchna
     do alag baatein hain. */
  const built = buildSalesAgentPrompt({
    lead: {
      leadId: "L-TEST",
      company: "Omega Co", contactName: "Pardeep", seats: 70,
      plan: "Google Workspace Business Starter", customerContact: "p@x.in",
      channel: "email" as const, existingQuoteId: null, deliveredQuoteId: null,
    },
    history: [],
    incoming: "mujje 70 email id ka quote chahiye google workspace business starter",
    catalog: [{ sku: "gw-starter", name: "Google Workspace Business Starter", vendor: "google", msrpPerSeatPerYear: 3240, wholesalePerSeatPerYear: 3000, monthlyFlexPerSeatPerMonth: null }],
    sellerName: "ANUTECH DIGITAL PVT LTD",
    sellerEmail: "sales@anutech.in",
  } as Parameters<typeof buildSalesAgentPrompt>[0]);
  const P = built.user;

  it("saaf likha hai ki 'discount' akela nahi aa sakta", () => {
    expect(P).toMatch(/MUST NEVER APPEAR WITHOUT ITS PERCENTAGE/i);
  });

  it("badal ke liye shabd bhi deta hai, sirf mana nahi karta", () => {
    /* "aisa mat likho" kaafi nahi — model ko chahiye ki uski jagah KYA likhe. Wahi seekh
       jo is file ke 26 Aug wale prompt-fix se aayi thi. */
    expect(P).toMatch(/volume rate/i);
  });

  it("wajah bhi batata hai, taaki niyam bemaani na lage", () => {
    expect(P).toMatch(/held for a human/i);
  });
});
