import { describe, it, expect } from "vitest";
import { quoteListTab, quoteTabCounts, isPipelineQuote } from "./list-tab";

describe("quoteListTab (R-469)", () => {
  it("puts a rejected quote under Rejected, not Expired", () => {
    expect(quoteListTab({ status: "rejected", payment_status: "none" })).toBe("rejected");
    expect(quoteListTab({ status: "expired", payment_status: "none" })).toBe("expired");
  });

  it("an invoiced quote with a balance is Awaiting payment only", () => {
    expect(quoteListTab({ status: "accepted", payment_status: "invoiced", invoice_id: "INV-1", amount: 38232, payment_amount: 0 })).toBe("awaiting");
    expect(quoteListTab({ status: "accepted", payment_status: "invoiced", invoice_id: "INV-1", amount: 38232, payment_amount: 38232 })).toBe("invoiced");
  });

  it("accepted and unpaid-awaiting go to their own tabs", () => {
    expect(quoteListTab({ status: "accepted", payment_status: "awaiting" })).toBe("awaiting");
    expect(quoteListTab({ status: "accepted", payment_status: "received" })).toBe("accepted");
    expect(quoteListTab({ status: "draft", payment_status: "none" })).toBe("draft");
    expect(quoteListTab({ status: "viewed", payment_status: "none" })).toBe("viewed");
  });

  it("tab counts add up to All (Abhishek's 10 quotes)", () => {
    const quotes = [
      { status: "draft", payment_status: "none" },
      { status: "accepted", payment_status: "received" },
      { status: "accepted", payment_status: "invoiced", invoice_id: "I3", amount: 100, payment_amount: 0 },
      ...Array.from({ length: 6 }, (_, i) => ({ status: "accepted", payment_status: "invoiced", invoice_id: `I${i + 10}`, amount: 100, payment_amount: 100 })),
      { status: "rejected", payment_status: "none" },
    ];
    const c = quoteTabCounts(quotes);
    const sum = c.draft + c.sent + c.viewed + c.accepted + c.awaiting + c.invoiced + c.rejected + c.expired;
    expect(c.all).toBe(10);
    expect(sum).toBe(10);
    expect(c.rejected).toBe(1);
    expect(c.expired).toBe(0);
  });
});

describe("isPipelineQuote", () => {
  it("counts only open quotes", () => {
    expect(isPipelineQuote({ status: "draft" })).toBe(true);
    expect(isPipelineQuote({ status: "sent" })).toBe(true);
    expect(isPipelineQuote({ status: "viewed" })).toBe(true);
    expect(isPipelineQuote({ status: "accepted" })).toBe(false);
    expect(isPipelineQuote({ status: "rejected" })).toBe(false);
    expect(isPipelineQuote({ status: "expired" })).toBe(false);
    expect(isPipelineQuote({ status: "draft", payment_status: "invoiced", invoice_id: "INV-1" })).toBe(false);
  });
});
