import { describe, it, expect } from "vitest";
import { buildRateCard } from "./rate-card";
import { TLDS, CERTS, MAIL_RATES } from "./data/catalog";
import { HOSTING_TIERS } from "./data/hosting-landing-v2";
import { mergeEditions } from "./live-catalog";

const card = buildRateCard({ tlds: TLDS, hosting: HOSTING_TIERS, editions: mergeEditions(null), mailRates: MAIL_RATES, certs: CERTS });
const section = (id: string) => card.find((s) => s.id === id)!;

describe("rate card (R-075) — the same numbers the product pages show", () => {
  it("has the four product lines, each linking to its page", () => {
    expect(card.map((s) => s.id)).toEqual(["domains", "hosting", "email", "ssl"]);
    expect(card.map((s) => s.href)).toEqual(["/domains", "/hosting", "/email", "/ssl"]);
  });

  it("every domain row is the catalogue's register / renew / transfer", () => {
    const d = section("domains");
    expect(d.rows).toHaveLength(TLDS.length);
    const com = d.rows.find((r) => r.name === ".com")!;
    const src = TLDS.find((t) => t.tld === ".com")!;
    expect(com.cells).toEqual([`₹${src.reg.toLocaleString("en-IN")}`, `₹${src.renew.toLocaleString("en-IN")}`, `₹${src.transfer.toLocaleString("en-IN")}`]);
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
