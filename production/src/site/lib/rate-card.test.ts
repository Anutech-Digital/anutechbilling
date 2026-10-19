import { describe, it, expect } from "vitest";
import { buildRateCard, PRICE_AT_SEARCH, type RateTld } from "./rate-card";
import { CERTS, MAIL_RATES } from "./data/catalog";
import { HOSTING_TIERS } from "./data/hosting-landing-v2";
import { mergeEditions } from "./live-catalog";

/* Live rows as getSiteTldPrices returns them (R-1599) — one unknown transfer, one TLD unpriced. */
const LIVE_TLDS: RateTld[] = [
  { tld: ".in", use: "Indian businesses", reg: 799, renew: 899, transfer: 799, live: true },
  { tld: ".com", use: "Anything", reg: 1049, renew: 1250, transfer: null, live: true },
  { tld: ".io", use: "SaaS", reg: null, renew: null, transfer: null, live: false },
];
const card = buildRateCard({ tlds: LIVE_TLDS, hosting: HOSTING_TIERS, editions: mergeEditions(null), mailRates: MAIL_RATES, certs: CERTS });
const section = (id: string) => card.find((s) => s.id === id)!;

describe("rate card (R-075) — the same numbers the product pages show", () => {
  it("has the four product lines, each linking to its page", () => {
    expect(card.map((s) => s.id)).toEqual(["domains", "hosting", "email", "ssl"]);
    expect(card.map((s) => s.href)).toEqual(["/domains", "/hosting", "/email", "/ssl"]);
  });

  it("every domain row is the live register / renew / transfer (R-1599)", () => {
    const d = section("domains");
    expect(d.rows).toHaveLength(LIVE_TLDS.length);
    const com = d.rows.find((r) => r.name === ".com")!;
    expect(com.cells).toEqual(["₹1,049", "₹1,250", "—"]);
    expect(com.live).toBe(true);
  });

  it("a TLD with no live price says 'Price at search' across the row, never a number", () => {
    const io = section("domains").rows.find((r) => r.name === ".io")!;
    expect(io.cells).toEqual([PRICE_AT_SEARCH]);
    expect(io.live).toBe(false);
  });

  it("hosting rows are HOSTING_TIERS — the /hosting prices, whole rupees (R-1465)", () => {
    const h = section("hosting");
    expect(h.rows.map((r) => r.name)).toEqual(HOSTING_TIERS.map((t) => t.name));
    const first = HOSTING_TIERS[0];
    expect(h.rows[0].cells[1]).toBe(`₹${Math.round(first.yearlyMo).toLocaleString("en-IN")}`);
  });

  it("email starts with Anutech Mail, then the editions /email shows", () => {
    const e = section("email");
    expect(e.rows[0]).toMatchObject({ name: "Anutech Mail", cells: [`₹${MAIL_RATES["Anutech Mail"]} · term on the quote`] });
    expect(e.rows.slice(1).map((r) => r.name)).toEqual(mergeEditions(null).map((x) => x.name));
  });

  it("a live edition with no flexible tier shows a dash, never an invented monthly price", () => {
    const c = buildRateCard({
      tlds: [], hosting: [], mailRates: {}, certs: [],
      editions: [{ name: "GW Business Starter", note: "", annual: 270, monthly: 0, monthlyOrNull: null, live: true }],
    });
    expect(c[2].rows[0]).toMatchObject({ cells: ["₹270", "—"], live: true });
  });

  it("the free certificate reads Free, paid ones carry their unit", () => {
    const s = section("ssl");
    expect(s.rows[0].cells[0]).toBe("Free");
    expect(s.rows.find((r) => r.name === "Positive SSL")!.cells[0]).toBe("₹899/yr");
  });
});
