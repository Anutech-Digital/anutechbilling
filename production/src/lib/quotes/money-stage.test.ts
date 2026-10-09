import { describe, it, expect } from "vitest";
import { moneyStage, quoteMoneyActions, splitBilledCycleOf, type QuoteMoneyInput } from "./money-stage";
import { rupee } from "@/lib/utils";

const q = (over: Partial<QuoteMoneyInput> = {}): QuoteMoneyInput => ({
  status: "accepted", paymentStatus: "none", invoiceId: null,
  total: 45360, received: 0,
  ...over,
});

/**
 * ─── THE LIVE DEAD END ──────────────────────────────────────────────────────
 * Q-2026-9776: accepted, ₹45,360, payment_status 'none' — the column DEFAULT. The page
 * offered no Record payment and no invoice button, so the deal could not be progressed
 * from its own screen at all.
 */
describe("an accepted quote is never a dead end", () => {
  it("offers BOTH actions when payment_status is the default 'none'", () => {
    const a = quoteMoneyActions(q({ paymentStatus: "none" }), rupee);
    expect(a.stage).toBe("unpaid");
    expect(a.canRecordPayment).toBe(true);
    expect(a.canGenerateInvoice).toBe(true);
  });

  it("treats 'none', 'awaiting' and null as the SAME state", () => {
    /* They say the same thing in plain English: accepted, no money yet. Splitting them is
       what produced a quote with no buttons. */
    for (const ps of ["none", "awaiting", null, undefined]) {
      expect(moneyStage(q({ paymentStatus: ps })), `payment_status ${ps}`).toBe("unpaid");
    }
  });

  it("names the amount to collect rather than saying 'awaiting payment'", () => {
    expect(quoteMoneyActions(q(), rupee).note).toContain("₹45,360");
  });

  it("every accepted, un-invoiced state can still take money", () => {
    for (const ps of ["none", "awaiting", "partial", null]) {
      expect(quoteMoneyActions(q({ paymentStatus: ps, received: ps === "partial" ? 10000 : 0 }), rupee)
        .canRecordPayment, `payment_status ${ps}`).toBe(true);
    }
  });
});

/**
 * ─── AN INVOICE DOES NOT WAIT FOR PAYMENT ───────────────────────────────────
 * The old rule allowed invoicing only once money had arrived. CGST §31(2) with Rule 47
 * requires the invoice within 30 days of supply and says nothing about payment — and a
 * B2B customer routinely needs the invoice before their accounts team will release the
 * money at all.
 */
describe("invoicing before payment", () => {
  it("is allowed on an accepted quote with nothing received", () => {
    expect(quoteMoneyActions(q({ received: 0 }), rupee).canGenerateInvoice).toBe(true);
  });

  it("says the invoice can be raised first, so nobody has to guess", () => {
    expect(quoteMoneyActions(q(), rupee).note).toMatch(/if the customer needs it first/i);
  });

  it("is NOT offered before acceptance — there is no supply to invoice yet", () => {
    for (const status of ["draft", "sent", "viewed"]) {
      expect(quoteMoneyActions(q({ status }), rupee).canGenerateInvoice, status).toBe(false);
    }
  });
});

describe("money already received", () => {
  it("part paid reports both figures and the balance", () => {
    const a = quoteMoneyActions(q({ received: 20000 }), rupee);
    expect(a.stage).toBe("partial");
    expect(a.outstanding).toBe(25360);
    expect(a.note).toContain("₹20,000");
    expect(a.note).toContain("₹25,360");
    expect(a.recordLabel).toBe("Record balance payment");
  });

  it("paid in full stops asking for money", () => {
    const a = quoteMoneyActions(q({ received: 45360 }), rupee);
    expect(a.stage).toBe("paid");
    expect(a.canRecordPayment).toBe(false);
    expect(a.canGenerateInvoice).toBe(true);
    expect(a.outstanding).toBe(0);
  });

  it("an overpayment is still 'paid', never a negative balance", () => {
    const a = quoteMoneyActions(q({ received: 50000 }), rupee);
    expect(a.stage).toBe("paid");
    expect(a.outstanding).toBe(0);
  });

  /**
   * The recorded payments are the truth; `payment_status` is a label somebody has to
   * remember to move. Where they disagree the rows win — the same derived-over-stored
   * rule as the already-quoted banner on /enquiries.
   */
  it("believes the recorded amount over a stale payment_status", () => {
    expect(moneyStage(q({ paymentStatus: "none", received: 20000 }))).toBe("partial");
    expect(moneyStage(q({ paymentStatus: "awaiting", received: 45360 }))).toBe("paid");
  });
});

describe("once an invoice exists", () => {
  it("the quote stops offering money actions", () => {
    /* Two places that both take payment against one deal is how the same rupee gets
       recorded twice. */
    const a = quoteMoneyActions(q({ invoiceId: "INV-ADPL-2026-27-0001" }), rupee);
    expect(a.stage).toBe("invoiced");
    expect(a.canRecordPayment).toBe(false);
    expect(a.canGenerateInvoice).toBe(false);
    expect(a.note).toMatch(/against the invoice, not against this quote/i);
  });

  it("an invoice_id wins even when payment_status disagrees", () => {
    expect(moneyStage(q({ invoiceId: "INV-1", paymentStatus: "awaiting" }))).toBe("invoiced");
  });
});

describe("the other ends of the funnel", () => {
  it("a draft collects nothing", () => {
    const a = quoteMoneyActions(q({ status: "draft" }), rupee);
    expect(a.canRecordPayment).toBe(false);
    expect(a.canGenerateInvoice).toBe(false);
  });

  it("a SENT quote can still take money that arrived early", () => {
    /* Money sometimes lands before anyone presses Accept, and refusing to record it is
       how a real payment ends up in a WhatsApp thread instead of the books. */
    const a = quoteMoneyActions(q({ status: "sent" }), rupee);
    expect(a.stage).toBe("open");
    expect(a.canRecordPayment).toBe(true);
  });

  it("rejected and expired are closed", () => {
    for (const status of ["rejected", "expired", "lost"]) {
      expect(moneyStage(q({ status })), status).toBe("closed");
    }
  });
});

/* ── Money is read before the workflow status ─────────────────────────────────
   Q-ADPL-2026-27-0024, exactly as production held it: ₹38,232 quoted, ₹20,000 received by
   UPI with receipt voucher RV-ADPL-2026-27-0024, status still `sent` because nobody had
   pressed Mark accepted. The three money checks sat below `if (status !== "accepted")
   return "open"`, so the stage came back "open" and the page offered "Record payment" as
   though the account were empty. */
describe("a payment is not hidden by an unmoved status label", () => {
  const partOfIt = { total: 38232, received: 20000, status: "sent" as const, paymentStatus: "partial" as const, invoiceId: null };

  it("calls the real production row partial, not open", () => {
    expect(moneyStage(partOfIt)).toBe("partial");
  });

  it("offers the BALANCE, not a fresh payment", () => {
    const a = quoteMoneyActions(partOfIt, (n) => `₹${n.toLocaleString("en-IN")}`);
    expect(a.recordLabel).toBe("Record balance payment");
    expect(a.canRecordPayment).toBe(true);
    expect(a.note).toContain("₹20,000");
    expect(a.note).toContain("₹18,232");
  });

  it("reads the money whatever the status says", () => {
    for (const status of ["sent", "viewed", "accepted"] as const) {
      expect(moneyStage({ total: 100, received: 40, status, paymentStatus: null, invoiceId: null }), status).toBe("partial");
      expect(moneyStage({ total: 100, received: 100, status, paymentStatus: null, invoiceId: null }), status).toBe("paid");
    }
  });

  it("trusts the payment ROWS over the status column when they disagree", () => {
    /* payment_status says nothing arrived; a payment row says ₹40 did. The row wins. */
    expect(moneyStage({ total: 100, received: 40, status: "sent", paymentStatus: "none", invoiceId: null })).toBe("partial");
  });

  it("still lets an invoice outrank everything", () => {
    expect(moneyStage({ total: 100, received: 40, status: "sent", paymentStatus: "partial", invoiceId: "INV-1" })).toBe("invoiced");
  });

  it("keeps a dead quote closed even if money once landed on it", () => {
    /* Deliberate: offering "record the balance" on a rejected deal invites collecting
       against something nobody is selling. A refund is a different conversation. */
    for (const status of ["rejected", "expired"] as const) {
      expect(moneyStage({ total: 100, received: 40, status, paymentStatus: "partial", invoiceId: null }), status).toBe("closed");
    }
  });

  it("leaves an untouched quote where it was", () => {
    expect(moneyStage({ total: 100, received: 0, status: "draft", paymentStatus: "none", invoiceId: null })).toBe("draft");
    expect(moneyStage({ total: 100, received: 0, status: "sent", paymentStatus: "none", invoiceId: null })).toBe("open");
    expect(moneyStage({ total: 100, received: 0, status: "accepted", paymentStatus: "none", invoiceId: null })).toBe("unpaid");
  });
});

describe("R-446: a per-period plan never offers a whole-term GST invoice", () => {
  it("paid monthly quote: no Generate button, the note says each period is invoiced", () => {
    const a = quoteMoneyActions(q({ received: 45360, paymentStatus: "received", splitBilledCycle: "monthly" }), rupee);
    expect(a.canGenerateInvoice).toBe(false);
    expect(a.note).toContain("Billed monthly: each period gets its own GST invoice");
    expect(a.note).not.toContain("Raise the GST invoice");
  });
  it("unpaid / part-paid still take payment, without the invoice button", () => {
    const u = quoteMoneyActions(q({ splitBilledCycle: "quarterly" }), rupee);
    expect([u.canRecordPayment, u.canGenerateInvoice]).toEqual([true, false]);
    const p = quoteMoneyActions(q({ received: 1000, splitBilledCycle: "half_yearly" }), rupee);
    expect([p.canRecordPayment, p.canGenerateInvoice, p.recordLabel]).toEqual([true, false, "Record balance payment"]);
    expect(p.note).toContain("half-yearly");
  });
  it("yearly is unchanged", () => {
    expect(quoteMoneyActions(q({ received: 45360, splitBilledCycle: null }), rupee).canGenerateInvoice).toBe(true);
  });
  it("splitBilledCycleOf: subscriptions win, then the quote's own cycle", () => {
    expect(splitBilledCycleOf("yearly", ["monthly"])).toBe("monthly");
    expect(splitBilledCycleOf("monthly", ["yearly"])).toBeNull();
    expect(splitBilledCycleOf("monthly", [])).toBe("monthly");
    expect(splitBilledCycleOf(null, [])).toBeNull();
  });
});

describe("R-444 (2): the draft sentence shows once", () => {
  it("the money row has no draft note (the draft row already says it)", () => {
    expect(quoteMoneyActions(q({ status: "draft" }), rupee).note).toBe("");
  });
});
