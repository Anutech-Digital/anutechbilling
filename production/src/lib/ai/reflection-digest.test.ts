import { describe, it, expect } from "vitest";
import { reflectionEmail, type ReflectionReport } from "./reflection-digest";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026. `ai-reflection` cron chalu kiya gaya, aur agla sawaal wahi tha jo hona
   chahiye tha: **jawab jayega kahan?** Wo `console.info` karta tha — yaani Cloud Logging,
   jahan koi nahi jata. Chalu tha, par kisi tak pahunchta nahi tha.

   Ab wo apna email bhejta hai — par SIRF tab jab kuch kehne layak ho. Ye file usi shart
   par pehra deti hai, dono taraf se.
   ───────────────────────────────────────────────────────────────────────────── */

const base = (over: Partial<ReflectionReport> = {}): ReflectionReport => ({
  tenantId: "fbb976f1-9090-4f10-9726-0901bd144e42",
  tenantName: "ANUTECH DIGITAL PVT LTD",
  leadsSeen: 3,
  topStall: null,
  withheld: "Only 3 leads had a customer message in this window. Ranking needs at least 25.",
  ...over,
});

describe("kehne ko kuch na ho to CHUP — sabse zaroori", () => {
  it("aaj ki asli halat par koi mail nahi", () => {
    /* Live naapa gaya: ANUTECH 3 lead, Demo Co 0, Gammaco 0 — koi ranking nahi, koi block
       nahi. Is halat me mail aana hi galat hoga. */
    expect(reflectionEmail([
      base({ leadsSeen: 3 }),
      base({ tenantId: "democo", tenantName: "Demo Co", leadsSeen: 0 }),
      base({ tenantId: "gammaco", tenantName: "Gamma Co", leadsSeen: 0 }),
    ])).toBeNull();
  });

  it("khaali list par bhi null", () => {
    expect(reflectionEmail([])).toBeNull();
  });

  it("sirf `withheld` hone se mail nahi banta", () => {
    /* Warna har subah "ranking nahi di gayi" wala mail aata — hafte bhar me wo divar ka
       kagaz ban jata, aur jis subah kaam ka hota us subah bhi delete ho jata. */
    expect(reflectionEmail([base({ withheld: "kuch bhi" })])).toBeNull();
  });
});

describe("kehne ko kuch ho to bolta hai", () => {
  it("ranking mile to mail banta hai aur uska naam bhi wahi hota hai", () => {
    const m = reflectionEmail([base({
      leadsSeen: 40, topStall: "price", stalledCount: 12, withheld: "",
    })])!;
    expect(m).toBeTruthy();
    expect(m.subject).toContain("price");
    expect(m.text).toContain("12 lead");
  });

  it("topBlock 25 lead se NEECHE bhi bolta hai — yahi aaj ka asli faayda hai", () => {
    /* 30 Aug ko yahi hua tha: sahi reply "discount" shabd par ruk gayi thi. Wo dhoondhne
       me teen deploy aur ek haath se likhi SQL lagi. Agli subah ye mail me aa jata.

       Ranking ko sample chahiye kyunki wo customers ke baare me anumaan hai. "AI ko kisne
       roka" ginti hai — app ke apne inkaar ki — usme sample ki shart nahi lagti. */
    const m = reflectionEmail([base({
      leadsSeen: 3,
      topBlock: { reason: 'it says "discount". A promise in our name needs a person behind it.', count: 4 },
    })])!;
    expect(m).toBeTruthy();
    expect(m.text).toContain("discount");
    expect(m.text).toContain("4 baar");
    expect(m.subject).toMatch(/roka/i);
  });

  it("sirf haan-wale seat band ho tab bhi bolta hai", () => {
    const m = reflectionEmail([base({ acceptedByBand: [{ band: "21-50", accepted: 2 }] })])!;
    expect(m.text).toContain("21-50");
  });

  it("jo tenant chup hai wo mail me aata hi nahi", () => {
    const m = reflectionEmail([
      base({ tenantName: "ANUTECH", topStall: "price", stalledCount: 9, withheld: "" }),
      base({ tenantId: "gammaco", tenantName: "Gamma Co", leadsSeen: 0 }),
    ])!;
    expect(m.text).toContain("ANUTECH");
    expect(m.text).not.toContain("Gammaco");
  });
});

describe("mail khud padhne layak ho", () => {
  it("subject me nateeja hota hai, 'Daily reflection' nahi", () => {
    /* Ek subject jo sirf "Daily reflection" kahe, padhne wale ko mail kholne par majboor
       karta hai sirf ye jaanne ke liye ki kholna zaroori tha ya nahi. */
    const m = reflectionEmail([base({ topStall: "seats", stalledCount: 7, withheld: "" })])!;
    expect(m.subject).not.toMatch(/daily reflection/i);
    expect(m.subject).toContain("seats");
  });

  it("saaf likha hai ki ye ginti hai, model ka anumaan nahi", () => {
    /* Padhne wale ko pata hona chahiye ki ye kitna bharosemand hai. */
    const m = reflectionEmail([base({ topStall: "price", stalledCount: 5, withheld: "" })])!;
    expect(m.text).toMatch(/ginti/i);
    expect(m.text).toMatch(/prompt me nahi likha/i);
  });

  it("tenantName na ho to id ka tukda dikhata hai, khaali nahi", () => {
    const m = reflectionEmail([base({ tenantName: null, topStall: "price", stalledCount: 5, withheld: "" })])!;
    expect(m.text).toContain("fbb976f1");
  });
});
