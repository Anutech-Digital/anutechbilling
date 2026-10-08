import { describe, it, expect } from "vitest";
import { quotePaymentState, leadsWithPayment } from "./won-paid";
import { paymentByLead } from "@/app/(app)/online-orders/order-payment";

describe("quotePaymentState — the one paid rule (R-375, shared with online orders R-351)", () => {
  it("received / invoiced = paid, partial = partial, anything else = none", () => {
    expect(["received", "invoiced", " partial ", "awaiting", "none", null, undefined, ""].map(quotePaymentState))
      .toEqual(["paid", "paid", "partial", "none", "none", "none", "none", "none"]);
  });

  it("online orders read the same rule", () => {
    const m = paymentByLead([
      { lead_id: "L1", payment_status: "partial", invoice_id: null, created_at: null },
      { lead_id: "L2", payment_status: "awaiting", invoice_id: null, created_at: null },
    ]);
    expect(m.get("L1")?.state).toBe(quotePaymentState("partial"));
    expect(m.get("L2")?.state).toBe("none");
  });
});

describe("leadsWithPayment", () => {
  it("a won lead with only an ACCEPTED (unpaid) quote has no payment", () => {
    const ids = leadsWithPayment([{ id: "L1" }], [{ lead_id: "L1", payment_status: "awaiting" }], []);
    expect(ids.has("L1")).toBe(false);
  });

  it("any part- or fully-paid quote of the lead counts (a paid re-quote)", () => {
    const ids = leadsWithPayment(
      [{ id: "L1" }, { id: "L2" }, { id: "L3" }],
      [
        { lead_id: "L1", payment_status: "none" },
        { lead_id: "L1", payment_status: "received" },
        { lead_id: "L2", payment_status: "partial" },
        { lead_id: "L3", payment_status: "invoiced" },
      ],
      [],
    );
    expect([...ids].sort()).toEqual(["L1", "L2", "L3"]);
  });

  it("a project deal counts once its project has a receipt", () => {
    const ids = leadsWithPayment(
      [{ id: "P1", project_id: "proj-a" }, { id: "P2", project_id: "proj-b" }, { id: "P3", project_id: null }],
      [],
      ["proj-a"],
    );
    expect([...ids]).toEqual(["P1"]);
  });

  it("ignores quotes of leads that were not asked about", () => {
    const ids = leadsWithPayment([{ id: "L1" }], [{ lead_id: "OTHER", payment_status: "received" }], []);
    expect(ids.size).toBe(0);
  });
});
