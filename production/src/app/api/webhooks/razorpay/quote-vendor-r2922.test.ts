/* R-2922 (18 Nov 2026): a part payment request's line now carries its subscription's catalogue item (item_id),
   like a renewal quotation's line. A paid part request is a period of a subscription that is already running —
   the Razorpay settlement must read its vendor exactly as before R-2922 (from the plan's wording), so a hosting
   or domain catalogue item on a part line never queues a new hosting account or a domain registration. */
import { describe, it, expect } from "vitest";
import { domainItemIdsForQuote, isPartRequestLine, vendorForQuote } from "./quote-vendor.server";

type Db = Parameters<typeof vendorForQuote>[0];

/** A catalogue with a hosting tier named "Starter", a domain item and a Workspace licence; records every read. */
function fakeDb() {
  const rows = [
    { id: "HOST-STARTER", vendor: "hosting" },
    { id: "DOM-IN", vendor: "domain" },
    { id: "GW-STR", vendor: "google" },
  ];
  const asked: string[][] = [];
  const db = {
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => { asked.push(ids); return { data: rows.filter((r) => ids.includes(r.id)) }; },
      }),
    }),
  } as unknown as Db;
  return { db, asked };
}

/** As the R-2922 migration writes a part line (supabase/tests/r2922_part_request_like_renewal.test.sql). */
const partLine = (itemId: string, id = "part-2") => ({
  id, name: "Starter · acme.in · 1 seat · 15 Oct–14 Nov 2026 (part 2 of 12)", description: "Payment for month 2 · 15 Oct–14 Nov 2026",
  qty: 1, rate: 250, per_seat: true, cost: 150, one_time: true, item_id: itemId, period_start: "2026-10-15", period_end: "2026-11-14",
});

describe("R-2922 — a part request's catalogue item never decides what the Razorpay settlement provisions", () => {
  it("isPartRequestLine: only the database's own part lines", () => {
    expect(isPartRequestLine(partLine("HOST-STARTER"))).toBe(true);
    expect(isPartRequestLine(partLine("HOST-STARTER", "part-2-1"))).toBe(true);          // billed together
    expect(isPartRequestLine({ id: "part-2", item_id: "X" })).toBe(false);                 // not one-time → an ordinary line
    expect(isPartRequestLine({ id: "renewal-1", one_time: true, item_id: "X" })).toBe(false);
    expect(isPartRequestLine({ id: "partner-1", one_time: true })).toBe(false);
    expect(isPartRequestLine({ one_time: true, item_id: "X" })).toBe(false);
    expect(isPartRequestLine(null)).toBe(false);
  });

  it("a part request of a hosting plan named 'Starter': the vendor is read as before R-2922 (the plan's wording), no catalogue read", async () => {
    const { db, asked } = fakeDb();
    expect(await vendorForQuote(db, [partLine("HOST-STARTER")], "Starter")).toBe("other");
    expect(await vendorForQuote(db, [partLine("GW-STR")], "Google Workspace Business Starter")).toBe("google");
    expect((await domainItemIdsForQuote(db, [partLine("DOM-IN")])).size).toBe(0);
    expect(asked).toEqual([]);
  });

  it("a bill-together part request (several part lines) is read the same way", async () => {
    const { db, asked } = fakeDb();
    expect(await vendorForQuote(db, [partLine("HOST-STARTER", "part-2-1"), partLine("DOM-IN", "part-2-2")], "Starter + .in domain")).toBe("domain");   // the wording, as before
    expect(asked).toEqual([]);
  });

  it("a sale is unchanged: the catalogue decides (a hosting tier named 'Starter' is hosting; a domain item is a domain line)", async () => {
    const { db } = fakeDb();
    expect(await vendorForQuote(db, [{ id: "li-1", name: "Starter", item_id: "HOST-STARTER", qty: 1, rate: 250 }], "Starter")).toBe("hosting");
    expect(await vendorForQuote(db, [{ id: "li-1", name: "Migration", item_id: "GW-STR", one_time: true }], "Something")).toBe("google");   // a one-time SALE line still counts
    expect([...(await domainItemIdsForQuote(db, [{ id: "li-2", name: ".in", item_id: "DOM-IN", domain: "acme.in" }]))]).toEqual(["DOM-IN"]);
    expect(await vendorForQuote(db, [{ name: "Hand typed" }], "cPanel hosting")).toBe("hosting");
  });
});
