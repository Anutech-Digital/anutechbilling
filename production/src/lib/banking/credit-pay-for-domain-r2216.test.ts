/**
 * R-2216 (July staging reconcile): a sale of 4 Zoho invoices mixed one-time and subscription lines.
 * One-time lines had no End-domain box, so the domains typed box-by-box (in Zoho's line order)
 * landed on the wrong subscription lines. Each line now carries its own domain and its own stable
 * key; the payload puts the domain inside that line's object — never a parallel array by position.
 */
import { describe, it, expect } from "vitest";
import { saleLineFromItem, saleLinesPayload, type SaleLine } from "./credit-pay-for";
type CatalogRow = Parameters<typeof saleLineFromItem>[0];

const ws = { id: "WS", name: "Google Workspace Business Starter", vendor: "google", msrp: 136, wholesale: 110, item_type: "subscription", is_active: true, prices: {} } as unknown as CatalogRow;
const setup = { id: "SETUP", name: "Setup fee", vendor: "anutech", msrp: 5000, wholesale: 0, item_type: "one_time", is_active: true, prices: {} } as unknown as CatalogRow;

function sale(): SaleLine[] {
  return [
    { ...saleLineFromItem(setup), domain: "links.example.in" },
    { ...saleLineFromItem(ws), domain: "a.example.in" },
    { ...saleLineFromItem(ws), domain: "b.example.in" },
  ];
}

describe("R-2216 each sale line keeps its own end-domain", () => {
  it("every new line gets its own stable key (rows are keyed by it, never by position)", () => {
    const [x, y, z] = sale();
    expect(x.key).toBeTruthy();
    expect(new Set([x.key, y.key, z.key]).size).toBe(3);
  });

  it("[one-time, annual, annual] → each annual line's own domain sits inside its own line object", () => {
    const p = saleLinesPayload(sale());
    expect(p.map((l) => l.commitment)).toEqual(["one_time", "annual_yearly", "annual_yearly"]);
    expect(p[0]).not.toHaveProperty("domain");          // one-time files no subscription
    expect(p[1]).toMatchObject({ item_id: "WS", domain: "a.example.in" });
    expect(p[2]).toMatchObject({ item_id: "WS", domain: "b.example.in" });
  });

  it("removing a line does not shift the other lines' domains", () => {
    const [one, a, b] = sale();
    expect(saleLinesPayload([one, b])[1]).toMatchObject({ domain: "b.example.in" });
    expect(saleLinesPayload([a, b]).map((l) => l.domain)).toEqual(["a.example.in", "b.example.in"]);
  });

  it("re-ordered lines take their domains with them", () => {
    const [one, a, b] = sale();
    expect(saleLinesPayload([b, one, a]).map((l) => ("domain" in l ? l.domain : null))).toEqual(["b.example.in", null, "a.example.in"]);
  });

  it("a one-time line switched to Annual keeps the domain typed on it", () => {
    const [one] = sale();
    expect(saleLinesPayload([{ ...one, cycle: "annual_yearly" }])[0]).toMatchObject({ domain: "links.example.in" });
  });
});
