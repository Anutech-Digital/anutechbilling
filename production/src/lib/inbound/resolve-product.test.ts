import { describe, it, expect } from "vitest";
import { resolveProduct, type ProductMatcher } from "./resolve-product";

/* ─────────────────────────────────────────────────────────────────────────────
   31 Aug 2026 ki asli reply:

     "mujhe 48 email id google workspace starter ke liye qutoe chahiye monthly par"

   Seats, product, term — teeno. App ne daam bhi bata diya aur quotation ka vaada bhi kiya,
   phir draft kuch nahi kiya. Catalogue me naam "Google Workspace Business Starter" hai;
   customer ne "google workspace starter" likha. `findProduct` poora naam maangta hai.

   AI fallback isi ke liye 30 Aug ko bana tha — par sirf CREATE branch par laga tha. Reply
   wali branch, jahan customer asli me intezaar karta hai, chhoot gayi.
   ───────────────────────────────────────────────────────────────────────────── */

/* Module mock nahi — function andar bheja jata hai. Wajah resolve-product.ts me likhi hai:
   ek async mock jo throw karta hai, use vitest khud "unhandled" gin kar test laal kar deta
   hai, chahe code ne use theek se pakad liya ho. */
let calls = 0;
const matcher = (fn: (a: Parameters<ProductMatcher>[0]) => Promise<unknown>): ProductMatcher =>
  ((a) => { calls++; return fn(a); }) as ProductMatcher;
const never = matcher(async () => { throw new Error("model ko bulaya hi nahi jana chahiye tha"); });

const STARTER = { id: "i1", name: "Google Workspace Business Starter" };
const STANDARD = { id: "i2", name: "Google Workspace Business Standard" };
const CATALOGUE = [STARTER, STANDARD];
const GEMINI = { apiKey: "k", model: "m", tenantId: null };

const REAL_REPLY = "mujhe 48 email id google workspace starter ke liye qutoe chahiye monthly par";



describe("pakka matcher pehle", () => {
  it("exact mil gaya to model ko chhua bhi nahi jata", async () => {
    /* Muft, turant, nishchit — aur ek API call bachi. */
    calls = 0;
    const r = await resolveProduct({ exact: STARTER, text: REAL_REPLY, catalogue: CATALOGUE, gemini: GEMINI }, never);
    expect(r?.entry).toBe(STARTER);
    expect(r?.source).toBe(STARTER.name);
    expect(calls, "exact match ke baad AI nahi chalna chahiye").toBe(0);
  });
});

describe("chooka to AI se poochho — YAHI ASLI MAAMLA HAI", () => {
  it("'google workspace starter' catalogue ki row par pahunch jata hai", async () => {
    const r = await resolveProduct(
      { exact: null, text: REAL_REPLY, catalogue: CATALOGUE, gemini: GEMINI },
      matcher(async () => ({ id: "i1", name: STARTER.name })));
    expect(r?.entry).toBe(STARTER);
    /* Source par likha hona chahiye ki ye ANDAZA hai — timeline padhne wale insaan ko dikhna
       chahiye ki naam model ne chuna, customer ne nahi. */
    expect(r?.source).toContain("AI");
  });

  it("model ne jo id di wo CALLER ke catalogue se hi uthai jati hai", async () => {
    /* Daam usi row se aata hai. Model ka apna object aage bhar dena wo jagah hoti jahan ek
       nakli naam asli daam ke saath chhap jata. */
    const r = await resolveProduct(
      { exact: null, text: REAL_REPLY, catalogue: CATALOGUE, gemini: GEMINI },
      matcher(async () => ({ id: "i2", name: "kuch aur likha hua" })));
    expect(r?.entry).toBe(STANDARD);
    expect(r?.entry.name).toBe(STANDARD.name);
  });

  it("model ne aisi id di jo catalogue me hai hi nahi → null", async () => {
    const r = await resolveProduct(
      { exact: null, text: REAL_REPLY, catalogue: CATALOGUE, gemini: GEMINI },
      matcher(async () => ({ id: "i-nahi-hai", name: "Microsoft 365" })));
    expect(r).toBeNull();
  });

  it("model ne mana kiya → null", async () => {
    const r = await resolveProduct(
      { exact: null, text: REAL_REPLY, catalogue: CATALOGUE, gemini: GEMINI },
      matcher(async () => null));
    expect(r).toBeNull();
  });
});

describe("kabhi phenkta nahi — enquiry ke raaste me nahi aana", () => {
  it("model phat gaya to null, exception nahi", async () => {
    /* Ye call inbound-email ke raaste par hai. Ek na-mila product ka matlab pehle bhi "koi
       quote nahi" tha; ab bhi wahi hai — par enquiry darj ho chuki hai aur wo bachni chahiye. */
    const r = await resolveProduct(
      { exact: null, text: REAL_REPLY, catalogue: CATALOGUE, gemini: GEMINI },
      matcher(async () => { throw new Error("429 quota"); }));
    expect(r).toBeNull();
  });

  it("bina key, khaali catalogue, khaali matn — teeno par model bulaya hi nahi jata", async () => {
    calls = 0;
    for (const args of [
      { exact: null, text: REAL_REPLY, catalogue: CATALOGUE, gemini: { apiKey: null, model: "m", tenantId: null } },
      { exact: null, text: REAL_REPLY, catalogue: [], gemini: GEMINI },
      { exact: null, text: "   ", catalogue: CATALOGUE, gemini: GEMINI },
    ]) {
      expect(await resolveProduct(args, never)).toBeNull();
    }
    expect(calls, "in me se kisi par bhi model nahi chhoona chahiye").toBe(0);
  });
});
