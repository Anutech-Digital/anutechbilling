import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mergeEditions, liveGwMonthlyRate, liveMonthlyRate, suitePriceRows, emailFromRate, type LiveWorkspaceItem,
} from "./live-catalog";
import { LICENCE_EDITIONS, EDITION_MATRICES, MAIL_RATES } from "./data/catalog";

/* ─────────────────────────────────────────────────────────────────────────────
   Website ↔ app ka daam-connection. Do niyam pin hain:

   1. LIVE placeholder ko DHAK deta hai — app me daam badle to website wahi dikhaye.
      31 Aug 2026 ka asli farak: placeholder ₹136, asli catalogue ₹270. Website ₹136
      dikhaye aur app ₹270 ki quotation bheje, to wahi "document apne aap se asahmat"
      wali galti grahak ke saamne hoti.

   2. Merge kabhi daam GADHTA nahi — live me monthly tier na ho to monthlyOrNull null
      rehta hai aur UI "annual only" kehta hai. Annual se monthly nikalna wahi 12×/term
      wali class ki galti hai jo app me ek baar ho chuki hai.
   ───────────────────────────────────────────────────────────────────────────── */

/** Bilkul wahi jo endpoint 31 Aug 2026 ko deta hai. */
const LIVE: LiveWorkspaceItem[] = [
  { name: "Google Workspace Business Starter", annualPerSeatMo: 270, monthlyPerSeatMo: 325 },
];

describe("merge — live jeet-ta hai", () => {
  it("GW Business Starter ka placeholder (136/160) live (270/325) se dhak jata hai", () => {
    const merged = mergeEditions(LIVE);
    const starter = merged.find((e) => e.name === "GW Business Starter");
    expect(starter).toBeDefined();
    expect(starter!.annual).toBe(270);
    expect(starter!.monthlyOrNull).toBe(325);
    expect(starter!.live).toBe(true);
  });

  it("baaki edition waise hi rehte hain, live ka thappa NAHI lagta", () => {
    const merged = mergeEditions(LIVE);
    const m365 = merged.find((e) => e.name === "M365 Business Standard");
    expect(m365).toBeDefined();
    expect(m365!.live).toBeUndefined();
    expect(m365!.annual).toBe(770);
  });

  it("naya live product APPEND hota hai — website deploy ka intezaar nahi", () => {
    const merged = mergeEditions([
      ...LIVE,
      { name: "Google Workspace Business Standard Plus", annualPerSeatMo: 999, monthlyPerSeatMo: 1200 },
    ]);
    const added = merged.find((e) => e.name === "GW Business Standard Plus");
    expect(added).toBeDefined();
    expect(added!.annual).toBe(999);
    expect(added!.live).toBe(true);
  });

  it("live null (app nahi mila) → placeholder jaise the waise, page girta nahi", () => {
    const merged = mergeEditions(null);
    expect(merged.map((e) => e.name)).toEqual(LICENCE_EDITIONS.map((e) => e.name));
    expect(merged.every((e) => !e.live)).toBe(true);
  });
});

describe("merge — daam kabhi gadha nahi jata", () => {
  it("monthly tier na ho to monthlyOrNull NULL — annual se koi jugaad nahi", () => {
    const merged = mergeEditions([
      { name: "Google Workspace Business Starter", annualPerSeatMo: 270, monthlyPerSeatMo: null },
    ]);
    const starter = merged.find((e) => e.name === "GW Business Starter")!;
    expect(starter.monthlyOrNull).toBeNull();
    /* Calculator isi null par Monthly chip disable karta hai aur "annual only" likhta hai. */
  });
});

describe("quote page ka GW rate", () => {
  it("Starter ka flexible rate uthata hai", () => {
    expect(liveGwMonthlyRate(LIVE)).toBe(325);
  });
  it("app na mile to null — QuoteBuilder placeholder par gir jata hai", () => {
    expect(liveGwMonthlyRate(null)).toBeNull();
    expect(liveGwMonthlyRate([])).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   R-076 (7 Oct 2026): Microsoft 365 aur Zoho bhi live. Pehle sirf GW live tha — M365/Zoho
   ke daam catalog.ts me typed the, catalogue badalne par website purana daam dikhati thi.
   Neeche ke aankde sirf TEST input hain (jaanboojh kar fallback se alag), asli daam nahi.
   ───────────────────────────────────────────────────────────────────────────── */
const SUITES_LIVE: LiveWorkspaceItem[] = [
  { name: "Google Workspace Business Starter", annualPerSeatMo: 270, monthlyPerSeatMo: 325, vendor: "google" },
  { name: "Microsoft 365 Business Basic", annualPerSeatMo: 151, monthlyPerSeatMo: 181, vendor: "microsoft" },
  { name: "Microsoft 365 Business Standard", annualPerSeatMo: 777, monthlyPerSeatMo: null, vendor: "microsoft" },
  { name: "Zoho Workplace Standard", annualPerSeatMo: 93, monthlyPerSeatMo: 113, vendor: "zoho" },
];

describe("R-076 — M365 aur Zoho bhi catalogue se", () => {
  it("M365 Basic/Standard ka typed daam live se dhak jata hai", () => {
    const merged = mergeEditions(SUITES_LIVE);
    const basic = merged.find((e) => e.name === "M365 Business Basic")!;
    expect(basic).toMatchObject({ annual: 151, monthlyOrNull: 181, live: true });
    const std = merged.find((e) => e.name === "M365 Business Standard")!;
    expect(std).toMatchObject({ annual: 777, monthlyOrNull: null, live: true });
  });

  it("'Zoho Workplace Standard' fallback 'Zoho Workplace' par baithta hai — doosra Zoho card nahi", () => {
    const merged = mergeEditions(SUITES_LIVE);
    const zoho = merged.filter((e) => /^zoho/i.test(e.name));
    expect(zoho).toHaveLength(1);
    expect(zoho[0]).toMatchObject({ name: "Zoho Workplace", annual: 93, monthlyOrNull: 113, live: true });
  });

  it("M365 kabhi 'GW …' naam se nahi judta (vendor tag ho ya na ho)", () => {
    const untagged = SUITES_LIVE.map(({ vendor: _v, ...rest }) => rest);
    for (const live of [SUITES_LIVE, untagged]) {
      const names = mergeEditions(live).map((e) => e.name);
      expect(names.some((n) => /^GW (Microsoft|Zoho)/i.test(n))).toBe(false);
      expect(names.filter((n) => n.startsWith("M365 "))).toEqual(["M365 Business Basic", "M365 Business Standard"]);
    }
  });

  it("catalogue me naya M365 product APPEND hota hai, M365 naam se", () => {
    const merged = mergeEditions([
      { name: "Microsoft 365 Business Premium", annualPerSeatMo: 1555, monthlyPerSeatMo: 1777, vendor: "microsoft" },
    ]);
    expect(merged.find((e) => e.name === "M365 Business Premium")).toMatchObject({ annual: 1555, live: true });
  });

  it("catalogue me M365/Zoho na ho to typed fallback hi rehta hai", () => {
    const merged = mergeEditions([SUITES_LIVE[0]]);
    const fallback = LICENCE_EDITIONS.find((e) => e.name === "M365 Business Basic")!;
    expect(merged.find((e) => e.name === "M365 Business Basic")).toMatchObject({ annual: fallback.annual, monthly: fallback.monthly });
    expect(merged.find((e) => e.name === "M365 Business Basic")!.live).toBeUndefined();
  });

  it("liveMonthlyRate har suite ka apna entry rate deta hai; GW rate M365 se nahi bigadta", () => {
    expect(liveMonthlyRate(SUITES_LIVE, "microsoft")).toBe(181);
    expect(liveMonthlyRate(SUITES_LIVE, "zoho")).toBe(113);
    expect(liveGwMonthlyRate([SUITES_LIVE[1], SUITES_LIVE[0]])).toBe(325);
    expect(liveMonthlyRate([SUITES_LIVE[0]], "zoho")).toBeNull();
  });
});

describe("R-076 — compare page ka daam row", () => {
  it("M365/Zoho ke cell live daam dikhate hain; catalogue me jo nahi hai uska typed cell rehta hai", () => {
    const rows = suitePriceRows(mergeEditions(SUITES_LIVE));
    const typed = (suite: string) => EDITION_MATRICES[suite].rows.find((r) => /price per seat/i.test(r[0]))!;
    expect(rows["Microsoft 365"]).toEqual(["₹151/mo", "₹777/mo", typed("Microsoft 365")[3]]);
    expect(rows.Zoho).toEqual([typed("Zoho")[1], "₹93/mo", typed("Zoho")[3]]);
    expect(rows["Google Workspace"][0]).toBe("₹270/mo");
    expect(Object.values(rows).flat()).not.toContain("—");
  });
});

describe("R-076 — header ka 'Mailboxes from ₹…' teaser", () => {
  it("live editions aur Anutech Mail me sabse sasta — typed nahi", () => {
    const cheapZoho: LiveWorkspaceItem[] = [{ name: "Zoho Workplace Standard", annualPerSeatMo: 61, monthlyPerSeatMo: null, vendor: "zoho" }];
    expect(emailFromRate(mergeEditions(cheapZoho))).toBe(Math.min(MAIL_RATES["Anutech Mail"], 61));
    expect(emailFromRate(mergeEditions(null))).toBe(
      Math.min(MAIL_RATES["Anutech Mail"], ...LICENCE_EDITIONS.map((e) => e.annual)),
    );
  });

  it("Header me ₹ ka koi typed 'Mailboxes from' aankda nahi bacha", () => {
    const src = readFileSync(join(process.cwd(), "src", "site", "components", "chrome", "Header.tsx"), "utf8");
    expect(src).not.toMatch(/Mailboxes from ₹\d/);
    expect(src).toContain("emailFromRate");
  });
});
