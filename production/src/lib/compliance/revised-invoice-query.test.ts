/* R-1531 — the revised-invoice loader: the right filters, paged, and a failed read rejects (§17c). */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => { throw new Error("not used"); } }));
vi.mock("./gst-registration-query", () => ({ useGstRegistration: () => ({}) }));

import { loadRevisedInvoiceBills } from "./revised-invoice-query";

type Call = [string, ...unknown[]];

function fakeClient(pages: { data: unknown[] | null; error: unknown }[]) {
  const calls: Call[][] = [];
  let n = 0;
  const client = {
    from(table: string) {
      const log: Call[] = [["from", table]];
      calls.push(log);
      const q: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "lte", "order"]) {
        q[m] = (...a: unknown[]) => { log.push([m, ...a]); return q; };
      }
      q.range = (...a: unknown[]) => { log.push(["range", ...a]); return Promise.resolve(pages[n++] ?? { data: [], error: null }); };
      return q;
    },
  };
  return { client: client as never, calls };
}

describe("loadRevisedInvoiceBills", () => {
  it("reads only issued, unregistered Bills of Supply in the window, ordered by id", async () => {
    const { client, calls } = fakeClient([{ data: [{ id: "BOS-1" }], error: null }]);
    const rows = await loadRevisedInvoiceBills(client, { from: "2026-09-01", to: "2026-10-10" });
    expect(rows).toEqual([{ id: "BOS-1" }]);
    const log = calls[0];
    expect(log).toContainEqual(["from", "invoices"]);
    expect(log).toContainEqual(["eq", "document_kind", "bill_of_supply"]);
    expect(log).toContainEqual(["eq", "supplier_gst_status", "unregistered"]);
    expect(log).toContainEqual(["in", "status", ["pending", "paid", "overdue"]]);
    expect(log).toContainEqual(["gte", "invoice_date", "2026-09-01"]);
    expect(log).toContainEqual(["lte", "invoice_date", "2026-10-10"]);
    expect(log).toContainEqual(["order", "id", { ascending: true }]);
  });

  it("pages past 1000 rows", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `BOS-${i}` }));
    const { client, calls } = fakeClient([{ data: full, error: null }, { data: [{ id: "BOS-x" }], error: null }]);
    const rows = await loadRevisedInvoiceBills(client, { from: "2026-09-01", to: "2026-10-10" });
    expect(rows).toHaveLength(1001);
    expect(calls).toHaveLength(2);
  });

  it("a failed read rejects — never an empty list", async () => {
    const { client } = fakeClient([{ data: null, error: { message: "permission denied", code: "42501" } }]);
    await expect(loadRevisedInvoiceBills(client, { from: "2026-09-01", to: "2026-10-10" })).rejects.toBeTruthy();
  });
});
