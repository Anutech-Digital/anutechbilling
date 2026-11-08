/**
 * R-2457 — `npm run card:check -- R-xxxx` (scripts/ops/card-check.mjs + card-check-lib.mjs).
 * Pure helpers only: reads a saved card file, prints its howToCheck with local links + which Local test
 * login to click + the data each step assumes, and builds the board patches (aiResult …).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normaliseCardId, cardFromFile, stepsOf, parseNavLinks, findPages, pickLoginRole, dataNeeds,
  scenariosFor, buildStartPatch, buildResultPatch, renderChecklist, parseCardCheckArgs,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../../scripts/ops/card-check-lib.mjs";
// @ts-expect-error — plain .mjs script, no types
import { SCENARIOS } from "../../scripts/dev/scenarios/index.mjs";

const NAV = fs.readFileSync(path.resolve(__dirname, "../../src/lib/nav.ts"), "utf8");
const LINKS = parseNavLinks(NAV);

describe("normaliseCardId", () => {
  it("accepts R-2448 / r-2448 / R2448 and refuses junk", () => {
    expect(normaliseCardId("R-2448")).toBe("R-2448");
    expect(normaliseCardId("r-2448")).toBe("R-2448");
    expect(normaliseCardId("R2448")).toBe("R-2448");
    expect(() => normaliseCardId("../../etc")).toThrow();
    expect(() => normaliseCardId("")).toThrow();
  });
});

describe("cardFromFile", () => {
  it("reads a plain card file and a {data} wrapped one; refuses a different id (R-008 vs R-088)", () => {
    expect(cardFromFile(JSON.stringify({ id: "R-2448", title: "t" }), "R-2448").title).toBe("t");
    expect(cardFromFile(JSON.stringify({ id: "R-2448", data: { id: "R-2448", title: "w" } }), "R-2448").title).toBe("w");
    expect(() => cardFromFile(JSON.stringify({ id: "R-088" }), "R-008")).toThrow(/R-088/);
    expect(() => cardFromFile("{nope", "R-1")).toThrow();
  });
});

describe("stepsOf", () => {
  it("array as is; a string split on lines / numbering; none → []", () => {
    expect(stepsOf({ howToCheck: ["a", " ", "b"] })).toEqual(["a", "b"]);
    expect(stepsOf({ howToCheck: "1. open X\n2. click Y" })).toEqual(["open X", "click Y"]);
    expect(stepsOf({})).toEqual([]);
  });
});

describe("parseNavLinks + findPages", () => {
  it("reads the sidebar's label → href pairs from src/lib/nav.ts", () => {
    expect(LINKS.length).toBeGreaterThan(50);
    expect(LINKS).toContainEqual({ label: "Quotes", href: "/quotes" });
    expect(LINKS).toContainEqual({ label: "Banking", href: "/accounting/banking" });
  });
  it("finds nav labels, everyday words and explicit paths in a Hinglish step", () => {
    const hrefs = (t: string) => findPages(t, LINKS).map((p: { href: string }) => p.href);
    expect(hrefs("Ek customer kholo jiska State 'Not known yet' ho, uska draft quote kholo")).toEqual(["/customers", "/quotes"]);
    expect(hrefs("Banking → HDFC line par Match dabao")).toEqual(["/accounting/banking"]);
    expect(hrefs("Chrome me localhost:3001/purchases/inbox kholo")).toEqual(["/purchases/inbox"]);
    expect(hrefs("Salary & Payroll Register kholo")).toContain("/accounting/salary-register");
    expect(hrefs("Terminal me npm run localhost:ready chalao")).toEqual([]);
  });
  it("does not turn a/b fractions or URLs to other sites into pages", () => {
    const hrefs = (t: string) => findPages(t, LINKS).map((p: { href: string }) => p.href);
    expect(hrefs("₹1,000 / month, 50/50 split, see https://example.com/x")).toEqual([]);
  });
});

describe("pickLoginRole", () => {
  it("defaults to owner; reads the role the steps name", () => {
    expect(pickLoginRole(["Quote kholo"])).toBe("owner");
    expect(pickLoginRole(["Local test login Accountant se andar jao"])).toBe("accountant");
    expect(pickLoginRole(["login → Sales"])).toBe("sales");
    expect(pickLoginRole(["Doosra owner (Owner 2) se login karo aur approve dabao"])).toBe("owner2");
    expect(pickLoginRole(["as manager open Tasks"])).toBe("manager");
    // R-2553: the Billing / Support Local test logins.
    expect(pickLoginRole(["Billing login: Payroll / Loans menu me nahi hain"])).toBe("billing");
    expect(pickLoginRole(["Support test login se /attendance/me kholo"])).toBe("support");
  });
});

describe("dataNeeds", () => {
  it("flags data the local test company may not have (4 Nov list)", () => {
    const needs = (t: string) => dataNeeds([t]).map((n: { need: string }) => n.need);
    expect(needs("customer jiska State 'Not known yet' ho")).toContain("customer with no state");
    expect(needs("USD INW lines dekho")).toContain("USD inward (INW) bank lines");
    expect(needs("do connected companies, network tab")).toContain("two connected local companies (network)");
    expect(needs("partially paid salary")).toContain("partly paid salary");
    expect(needs("Razorpay se pay karo")).toContain("Razorpay test key");
    expect(needs("HDFC 4523 line kholo")).toContain("a named real bank account / company (not in E2E Test Co)");
    expect(needs("Quotes kholo")).toEqual([]);
  });

  /* R-2458: each data need names the scenario that loads it — or says plainly why no fixture can. */
  it("maps each need to an existing scenario, or gives the reason there is none", () => {
    const names = new Set(SCENARIOS.map((s: { name: string }) => s.name));
    const one = (t: string) => dataNeeds([t])[0] as { need: string; scenario?: string; noFixture?: string };
    const cases: Array<[string, string]> = [
      ["customer jiska State 'Not known yet' ho", "customer-no-state"],
      ["'INW … USD1024.0@93.6' wali line", "usd-inw-lines"],
      ["Settings → Network: Connected businesses", "connected-companies"],
      ["Payroll → jis salary ka kuch hissa paid (Partially paid) hai", "salary-part-paid"],
      ["ek salary line jiski narration me FULL N FINAL ho", "salary-part-paid"],
      ["do credit lines, dono ka reference 000000000000000", "zero-ref-credits"],
      ["₹55 jaisa bacha hai, woh 'Small leftovers' group me", "small-leftover"],
      ["NBFC (Bajaj / Tata Capital) ko ₹10,000 se zyada interest", "nbfc-interest"],
      ["Settings me LUT number aur 'Valid up to' bharo", "lut-per-fy"],
      ["Sales login se ek quote kholo jo manager ne approve kiya hai", "approved-quote"],
      ["Renewals: Monthly commitment (flex)", "ads-month"],
    ];
    for (const [step, scn] of cases) {
      expect(one(step)?.scenario, step).toBe(scn);
      expect(names.has(scn), scn).toBe(true);
    }
    expect(one("Razorpay se pay karo")).toMatchObject({ need: "Razorpay test key" });
    expect(one("Razorpay se pay karo").noFixture).toMatch(/Settings → Integrations/);
    expect(one("Reconcile from Zoho chalao").noFixture).toMatch(/Zoho/);
    expect(one("Ek company kholo jisme sirf EK owner ho").noFixture).toMatch(/Owner 2/);
    expect(one("Banking → HDFC 4523 kholo").noFixture).toMatch(/SCN HDFC Current/);
  });

  it("does not point a lead's missing state, or ₹55,000, at a scenario (review R-2458)", () => {
    expect(dataNeeds(["Ek nayi lead banao jiska State khaali ho"])).toEqual([]);
    expect(dataNeeds(["Invoice ₹55,000 ka banao"])).toEqual([]);
    expect(dataNeeds(["₹55 bacha hai"])[0]).toMatchObject({ scenario: "small-leftover" });
    const out = renderChecklist({ card: { id: "R-2456", title: "t", howToCheck: ["Ek nayi lead banao jiska State khaali ho"] },
      host: "localhost:3001", links: LINKS, scenarios: SCENARIOS }).join("\n");
    expect(out).not.toMatch(/Test data:/);
    expect(out).toMatch(/No ready-made data for: none needed/);
  });
});

/* R-2458: the 29 cards waiting for a localhost check on 4 Nov — each one's checklist names the data to load
   (a scenario) or says no ready-made data exists and why. Steps are the cards' own howToCheck, shortened. */
describe("card:check names the fixture for the 4 Nov cards", () => {
  const cards: Array<[string, string[], string | null]> = [
    ["R-2363", ["Customers list me Pathak Fabrication par 'State missing' badge", "Not known yet"], "customer-no-state"],
    ["R-2376", ["Business Loans: NBFC (Bajaj / Tata Capital) ko is saal ₹10,000 se zyada interest"], "nbfc-interest"],
    ["R-2413", ["localhost:3001/collections kholo → 3 customers ke aage tick lagao"], "small-leftover"],
    ["R-2421", ["Payment Follow-up kholo: koi poora unpaid chhota bill (₹354)"], "small-leftover"],
    ["R-2422", ["Renewals kholo: 'Monthly commitment (flex)'"], "ads-month"],
    ["R-2424", ["Record payment: Reference 000000000000000"], "zero-ref-credits"],
    ["R-2425", ["Banking → 'INW … USD1024.0@93.6' wali line"], "usd-inw-lines"],
    ["R-2427", ["jis INW USD line ka invoice app me pehle se USD me hai"], "usd-inw-lines"],
    ["R-2428", ["salary line jiski narration me FULL N FINAL ho"], "salary-part-paid"],
    ["R-2430", ["do alag credit lines, dono ka reference 000000000000000"], "zero-ref-credits"],
    ["R-2431", ["Renewals: monthly (flex) rows bhi gine"], "ads-month"],
    ["R-2433", ["Company A me Settings → Network kholo"], "connected-companies"],
    ["R-2434", ["Purchases → Inbox → 'From network' me woh Pending dikhe"], "connected-companies"],
    ["R-2440", ["USD wali line (jaise 'USD1024.0@93.6') par 'No LUT for FY 2026-27'"], "usd-inw-lines"],
    ["R-2441", ["Quotes kholo, apna (owner) ek quote jisme approval chahiye"], "approved-quote"],
    ["R-2442", ["Customers mein ek customer kholo jiski State 'Not known yet' hai"], "customer-no-state"],
    ["R-2444", ["Settings → Company: LUT for exports (one per financial year)"], "lut-per-fy"],
    ["R-2445", ["Settings → Network kholo: 'Prove you own this GSTIN'"], "connected-companies"],
    ["R-2447", ["Sales login se ek quote kholo jo manager ne approve kiya hai"], "approved-quote"],
    ["R-2448", ["Ek customer kholo jiska State 'Not known yet' ho"], "customer-no-state"],
    ["R-2449", ["Purchases → Purchase Inbox → 'From network' tab"], "connected-companies"],
    ["R-2450", ["Anutech (connected customer) ko gaya invoice: 'Network · Pending'"], "connected-companies"],
    ["R-2432", ["Distributor company me linked reseller ke liye ek DRAFT invoice"], "connected-companies"],
    // no ready-made data: the reason is printed instead
    ["R-2415", ["Settings → Integrations me Razorpay TEST key (rzp_test_…) save ho"], null],
    ["R-2439", ["Razorpay test key ho to TEST MODE dikhe"], null],
    ["R-2426", ["Ek company kholo jisme sirf EK owner ho"], null],
    ["R-2371", ["jis Money-in line me humara apna company naam ho"], null],
    ["R-2423", ["Quotes list kholo, ek payment request (renewal part) wali row"], null],
    ["R-2456", ["Ek nayi lead banao jiska State khaali ho"], null],
  ];
  it("covers all 29 cards", () => expect(new Set(cards.map((c) => c[0])).size).toBe(29));
  for (const [id, howToCheck, scn] of cards) {
    it(`${id} → ${scn ?? "no fixture (reason)"}`, () => {
      const out = renderChecklist({ card: { id, title: "t", howToCheck }, host: "localhost:3001", links: LINKS, scenarios: SCENARIOS }).join("\n");
      if (scn) expect(out).toContain(`node scripts/dev/scenario.mjs ${scn}`);
      else expect(out).toMatch(/No ready-made data/);
      // the old "fixtures card R-2458" pointer is gone now that the fixtures exist
      expect(out).not.toMatch(/fixtures card R-2458/);
    });
  }
});

describe("scenariosFor", () => {
  it("names the R-1957 scenario whose cards list the card", () => {
    const s = SCENARIOS[0];
    expect(scenariosFor(s.cards[0], SCENARIOS)).toContain(s.name);
    expect(scenariosFor("R-99999", SCENARIOS)).toEqual([]);
  });
});

describe("board patches", () => {
  const now = "2026-11-04T02:30:00Z";
  it("start: checkRunning + checkStartedAt + checkNow", () => {
    expect(buildStartPatch(now, "Steps padh raha hai")).toEqual({ checkRunning: true, checkStartedAt: now, checkNow: "Steps padh raha hai" });
  });
  it("result: needs ✓ or ⚠ first; clears checkRunning / checkRequested / checkNow; never touches status", () => {
    const p = buildResultPatch(now, "✓ Quote ke buttons grey dikhe");
    expect(p).toEqual({ aiResult: "✓ Quote ke buttons grey dikhe", aiResultAt: now, checkRequested: false, checkRunning: false, checkNow: { __delete__: true } });
    expect(p).not.toHaveProperty("status");
    expect(() => buildResultPatch(now, "looks fine")).toThrow(/✓|⚠/);
    expect(() => buildResultPatch("4 Nov", "✓ x")).toThrow(/date -u|ISO/);
  });
});

describe("renderChecklist", () => {
  it("prints the login, numbered steps with full local links and the data warnings", () => {
    const out = renderChecklist({
      card: { id: "R-2448", title: "Quote buttons need state", status: "review", howToCheck: ["Ek customer kholo jiska State 'Not known yet' ho, uska draft quote kholo"] },
      host: "localhost:3001", links: LINKS, scenarios: SCENARIOS,
    }).join("\n");
    expect(out).toMatch(/R-2448/);
    expect(out).toMatch(/Local test login → Owner/);
    expect(out).toMatch(/E2E Test Co/);
    expect(out).toMatch(/1\. Ek customer kholo/);
    expect(out).toMatch(/http:\/\/localhost:3001\/customers/);
    expect(out).toMatch(/http:\/\/localhost:3001\/quotes/);
    expect(out).toMatch(/customer with no state/);
    expect(out).toMatch(/localhost:ready/);
  });
  it("says so plainly when a card has no howToCheck", () => {
    expect(renderChecklist({ card: { id: "R-1", title: "x" }, host: "localhost:3001", links: LINKS, scenarios: [] }).join("\n")).toMatch(/no howToCheck/i);
  });
});

describe("parseCardCheckArgs", () => {
  it("id + flags; refuses a non-local host and unknown flags", () => {
    expect(parseCardCheckArgs(["R-2448"])).toMatchObject({ id: "R-2448", host: "localhost:3001", start: false, result: null });
    expect(parseCardCheckArgs(["r-2448", "--card", "x.json", "--start", "--now", "Login"])).toMatchObject({ id: "R-2448", card: "x.json", start: true, now: "Login" });
    expect(parseCardCheckArgs(["R-1", "--result", "✓ ok"]).result).toBe("✓ ok");
    expect(() => parseCardCheckArgs(["R-1", "--host", "staging.example.com"])).toThrow(/not local/);
    expect(() => parseCardCheckArgs(["R-1", "--status", "done"])).toThrow(/Unknown/);
  });
});
