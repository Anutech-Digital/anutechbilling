import { describe, it, expect } from "vitest";
import { withInvoiceIssued, leadStageNow, rejectLeadOffer, lostActivityDetail, type LeadStageRead } from "./quote-page-actions";
import { quoteLifecycle } from "./lifecycle";
import { moneyStage } from "./money-stage";

describe("withInvoiceIssued (R-409)", () => {
  it("marks the cached quote invoiced so the button goes and the Invoiced step ticks", () => {
    const before = { id: "Q-1", status: "accepted", invoice_id: null as string | null, payment_status: "received" as string | null };
    const after = withInvoiceIssued(before, "INV-DEMO-27-0001");
    expect(after.invoice_id).toBe("INV-DEMO-27-0001");
    expect(moneyStage({ status: after.status, paymentStatus: after.payment_status, invoiceId: after.invoice_id, total: 100, received: 100 })).toBe("invoiced");
    const steps = quoteLifecycle({
      status: "accepted", paymentStatus: "invoiced", invoiceId: after.invoice_id,
      hasSignature: false, provisionStatus: "not_required", signerName: null, paid: true,
    }).steps;
    expect(steps.find((s) => s.stage === "invoiced")?.state).toBe("done");
    expect(before.invoice_id).toBeNull();   // not mutated
  });
});

function fakeDb(result: { data: { stage: string | null } | null; error: unknown } | Error): LeadStageRead {
  return () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result));
}

describe("leadStageNow (R-443)", () => {
  it("reads the stage from the database even when the page has not loaded the lead", async () => {
    expect(await leadStageNow(fakeDb({ data: { stage: "contact" }, error: null }), undefined)).toBe("contact");
  });

  it("falls back to the cached stage only if the read fails", async () => {
    expect(await leadStageNow(fakeDb({ data: null, error: { message: "x" } }), "demo")).toBe("demo");
    expect(await leadStageNow(fakeDb(new Error("network")), "trial")).toBe("trial");
  });
});

describe("rejectLeadOffer (R-452)", () => {
  it("offers Lost when this was the lead's only open quote", () => {
    expect(rejectLeadOffer({
      quoteId: "Q-8", lead: { stage: "quote" },
      leadQuotes: [{ id: "Q-8", status: "sent" }, { id: "Q-7", status: "expired", superseded_by: "Q-8" }],
    })).toEqual({ offer: true, note: null });
  });

  it("does not offer it when another quote is still open", () => {
    const r = rejectLeadOffer({ quoteId: "Q-8", lead: { stage: "quote" }, leadQuotes: [{ id: "Q-8", status: "sent" }, { id: "Q-9", status: "draft" }] });
    expect(r.offer).toBe(false);
    expect(r.note).toContain("Q-9");
  });

  it("leaves won, lost and lead-less quotes alone", () => {
    expect(rejectLeadOffer({ quoteId: "Q-8", lead: { stage: "won" }, leadQuotes: [] }).offer).toBe(false);
    expect(rejectLeadOffer({ quoteId: "Q-8", lead: { stage: "lost" }, leadQuotes: [] }).offer).toBe(false);
    expect(rejectLeadOffer({ quoteId: "Q-8", lead: null, leadQuotes: [] })).toEqual({ offer: false, note: null });
  });

  it("writes a readable timeline line", () => {
    expect(lostActivityDetail("Q-8", "price", null)).toBe("Lost — Price too high. Quote Q-8 rejected");
    expect(lostActivityDetail("Q-8", "other", "went in-house")).toBe("Lost — Other. Quote Q-8 rejected · went in-house");
  });
});
