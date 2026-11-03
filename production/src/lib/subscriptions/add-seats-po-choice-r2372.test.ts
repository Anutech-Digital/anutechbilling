/**
 * R-2372 — Manage seats drafted a purchase order nobody asked for (staging, 2 Nov:
 * PO-A378-27-0775 appeared beside the seat quote on Abacus). addSeats() now writes a
 * draft PO ONLY when the operator ticked "Also draft a purchase order"; otherwise the
 * quote and the seat change happen exactly as before and no PO row is written.
 */
import { describe, it, expect } from "vitest";
import { addSeats, type AddSeatsInput } from "./add-seats";

interface Captured { quotes: Record<string, unknown>[]; purchaseOrders: Record<string, unknown>[]; docTypes: string[] }

function fakeSupabase(captured: Captured) {
  const table = (name: string) => ({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    insert: (row: Record<string, unknown>) => {
      if (name === "quotes") captured.quotes.push(row);
      if (name === "purchase_orders") captured.purchaseOrders.push(row);
      return Promise.resolve({ error: null });
    },
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  });
  return {
    from: (name: string) => table(name),
    rpc: (fn: string, args: { p_doc_type?: string }) => {
      if (fn === "next_document_number") {
        captured.docTypes.push(String(args?.p_doc_type));
        return Promise.resolve({ data: args?.p_doc_type === "purchase_order" ? "PO-TEST-0001" : "Q-TEST-0001", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as AddSeatsInput["supabase"];
}

function futureISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function run(over: Partial<AddSeatsInput> = {}) {
  const captured: Captured = { quotes: [], purchaseOrders: [], docTypes: [] };
  const args: AddSeatsInput = {
    supabase: fakeSupabase(captured),
    subscriptionId: "sub-1", tenantId: "tenant-1", customerId: "cust-1", customerName: "Abacus",
    plan: "Google Workspace Business Starter", vendor: "google", domain: "abacus.example",
    currentSeats: 34, currentMrr: 8917, additionalSeats: 1,
    renewalDate: futureISO(200), graceDays: 7, taxRatePct: 18, termDays: 365,
    ...over,
  };
  return { captured, result: addSeats(args) };
}

describe("R-2372: Manage seats drafts a PO only when asked", () => {
  it("not asked (the default) → quote made, NO purchase order, no PO number used up", async () => {
    const { captured, result } = run();
    const r = await result;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.poId).toBeNull();
    expect(captured.quotes).toHaveLength(1);
    expect(captured.purchaseOrders).toHaveLength(0);
    expect(captured.docTypes).not.toContain("purchase_order");
  });

  it("explicitly false → no purchase order", async () => {
    const { captured, result } = run({ draftPurchaseOrder: false });
    await result;
    expect(captured.purchaseOrders).toHaveLength(0);
  });

  it("ticked → one draft PO for the added seats, linked to the quote", async () => {
    const { captured, result } = run({ draftPurchaseOrder: true });
    const r = await result;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.poId).toBe("PO-TEST-0001");
    expect(captured.purchaseOrders).toHaveLength(1);
    expect(captured.purchaseOrders[0]).toMatchObject({ status: "draft", seats: 1, subscription_id: "sub-1" });
    expect(String(captured.purchaseOrders[0].notes)).toContain("Q-TEST-0001");
  });
});
