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
