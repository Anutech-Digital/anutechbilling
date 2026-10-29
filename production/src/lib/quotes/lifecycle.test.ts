import { describe, it, expect } from "vitest";
import { quoteLifecycle, lifecycleSummary, type LifecycleInput } from "./lifecycle";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const q = (over: Partial<LifecycleInput> = {}): LifecycleInput => ({
  status: "draft", paymentStatus: "none", invoiceId: null,
  hasSignature: false, provisionStatus: "not_required", ...over,
});

const stateOf = (input: LifecycleInput, stage: string) =>
  quoteLifecycle(input).steps.find((s) => s.stage === stage)!.state;

describe("the six steps", () => {
  it("always renders all six, in the brief's order", () => {
    expect(quoteLifecycle(q()).steps.map((s) => s.stage))
      .toEqual(["draft", "sent", "signed", "paid", "provisioned", "invoiced"]);
  });

  it("a fresh draft has one current step and nothing else claimed", () => {
    const { steps } = quoteLifecycle(q());
    expect(steps.filter((s) => s.state === "done").map((s) => s.stage)).toEqual(["draft"]);
    expect(steps.filter((s) => s.state === "current")).toHaveLength(1);
    expect(steps.find((s) => s.state === "current")!.stage).toBe("sent");
  });

  it("exactly ONE step is ever current", () => {
    for (const input of [
      q(), q({ status: "sent" }), q({ status: "accepted" }),
      q({ status: "accepted", paymentStatus: "received" }),
      q({ status: "accepted", paymentStatus: "received", provisionStatus: "pending" }),
    ]) {
      expect(quoteLifecycle(input).steps.filter((s) => s.state === "current")).toHaveLength(1);
    }
  });
});

describe("every step is backed by a fact", () => {
  it("Sent means the quote left draft", () => {
    expect(stateOf(q(), "sent")).toBe("current");
    expect(stateOf(q({ status: "sent" }), "sent")).toBe("done");
  });

  it("Signed accepts a click-to-sign record", () => {
    const s = quoteLifecycle(q({ status: "sent", hasSignature: true, signerName: "Rakesh Kumar" }));
    const signed = s.steps.find((x) => x.stage === "signed")!;
    expect(signed.state).toBe("done");
    expect(signed.detail).toContain("Rakesh Kumar");
  });

  it("Signed ALSO accepts a plain acceptance, and says the difference", () => {
    /* Quotes accepted before signatures existed are genuinely accepted. Showing them
       as unsigned forever would make the bar lie about history. */
    const signed = quoteLifecycle(q({ status: "accepted" })).steps.find((x) => x.stage === "signed")!;
    expect(signed.state).toBe("done");
    expect(signed.detail).toMatch(/No online confirmation was recorded/);
  });

  it("Paid needs money, not acceptance", () => {
    expect(stateOf(q({ status: "accepted" }), "paid")).toBe("current");
    expect(stateOf(q({ status: "accepted", paymentStatus: "received" }), "paid")).toBe("done");
  });

  it("a PART payment is not Paid, and says so", () => {
    const paid = quoteLifecycle(q({ status: "accepted", paymentStatus: "partial" })).steps.find((s) => s.stage === "paid")!;
    expect(paid.state).toBe("current");
    expect(paid.detail).toMatch(/balance is still outstanding/);
  });

  it("Invoiced needs an invoice id", () => {
    expect(stateOf(q({ status: "accepted", paymentStatus: "received" }), "invoiced")).not.toBe("done");
    expect(stateOf(q({ status: "accepted", paymentStatus: "invoiced", invoiceId: "INV-1" }), "invoiced")).toBe("done");
  });
});

describe("Provisioned and Invoiced are NOT sequential", () => {
  it("a quote can be Invoiced while provisioning is still outstanding", () => {
    /* Under CGST §31 the invoice is issued on supply and cannot wait for mailboxes to
       be created. A bar that blocked Invoiced would show a correct sale as incomplete. */
    const input = q({ status: "accepted", paymentStatus: "invoiced", invoiceId: "INV-1", provisionStatus: "pending" });
    expect(stateOf(input, "invoiced")).toBe("done");
    expect(stateOf(input, "provisioned")).toBe("current");
  });

  it("a quote can be Provisioned before any invoice exists", () => {
    const input = q({ status: "accepted", paymentStatus: "received", provisionStatus: "done" });
    expect(stateOf(input, "provisioned")).toBe("done");
    expect(stateOf(input, "invoiced")).toBe("current");
  });
});

describe("a skipped step is shown as skipped, never as done", () => {
  it("nothing to provision renders as skipped", () => {
    /* Marking it done would claim work happened that nobody did. */
    const step = quoteLifecycle(q({ status: "accepted", paymentStatus: "received" }))
      .steps.find((s) => s.stage === "provisioned")!;
    expect(step.state).toBe("skipped");
    expect(step.detail).toMatch(/Nothing on this quote needs setting up/);
  });

  it("a skipped step is never the current one", () => {
    const { steps } = quoteLifecycle(q({ status: "accepted", paymentStatus: "received" }));
    expect(steps.find((s) => s.state === "current")!.stage).toBe("invoiced");
  });

  it("a FAILED provisioning is todo with the reason, not a tick", () => {
    const step = quoteLifecycle(q({ status: "accepted", paymentStatus: "received", provisionStatus: "failed" }))
      .steps.find((s) => s.stage === "provisioned")!;
    expect(step.state).not.toBe("done");
    expect(step.detail).toMatch(/failed/);
  });
});

describe("dead quotes", () => {
  it.each(["rejected", "expired"] as const)("a %s quote has NO current step", (status) => {
    /* A pulsing "current" step on a dead quote suggests somebody is working on it. */
    const { steps, dead } = quoteLifecycle(q({ status, hasSignature: false }));
    expect(dead).toBe(true);
    expect(steps.filter((s) => s.state === "current")).toHaveLength(0);
  });

  it("still shows how far it got", () => {
    const { steps } = quoteLifecycle(q({ status: "rejected" }));
    expect(steps.find((s) => s.stage === "sent")!.state).toBe("done");
  });
});

describe("lifecycleSummary", () => {
  it("names what the quote is waiting on", () => {
    expect(lifecycleSummary(quoteLifecycle(q({ status: "sent" })).steps)).toBe("Waiting on: Signed");
  });

  it("reports completion when nothing is outstanding", () => {
    const done = q({ status: "accepted", paymentStatus: "invoiced", invoiceId: "INV-1", hasSignature: true, provisionStatus: "done" });
    expect(lifecycleSummary(quoteLifecycle(done).steps)).toBe("Invoiced — complete");
  });
});

/* R-159: invoicing before payment must not tick "Paid". */
describe("paid step follows the money, not the invoice (R-159)", () => {
  const base = { status: "accepted" as const, paymentStatus: "invoiced" as const, invoiceId: "INV-1", hasSignature: false, provisionStatus: "not_required" as const };
  it("invoiced with nothing received → Paid is still to do, and says the money is due", () => {
    const paid = quoteLifecycle({ ...base, paid: false }).steps.find((s) => s.stage === "paid")!;
    expect(paid.state).not.toBe("done");
    expect(paid.detail).toBe("Invoiced before payment — the money is still due.");
  });
  it("invoiced and paid in full → Paid is done", () => {
    expect(quoteLifecycle({ ...base, paid: true }).steps.find((s) => s.stage === "paid")!.state).toBe("done");
  });
  it("the quote page passes the money-based answer", () => {
    expect(readFileSync(join(__dirname, "../../app/(app)/quotes/[id]/page.tsx"), "utf8")).toMatch(/paid: quoteIsPaid\(quote\)/);
  });
});

/* R-2101 (29 Oct 2026, localhost): a 2-subscription quarterly sale, Q1 paid ₹95,993, got ONE
   combined part invoice (R-2092) — and the quote page still said "INVOICED – No invoice yet",
   because a part's invoice is linked through subscription_billings, not quotes.invoice_id. */
describe("a sale billed in parts: the parts' invoices tick Invoiced (R-2101)", () => {
  const sale = { status: "accepted" as const, paymentStatus: "received" as const, invoiceId: null, hasSignature: true, provisionStatus: "not_required" as const, paid: true };
  it("Q1's combined invoice → Invoiced is done and names it", () => {
    const step = quoteLifecycle({ ...sale, partInvoices: ["INV-1111-27-0016"] }).steps.find((s) => s.stage === "invoiced")!;
    expect(step.state).toBe("done");
    expect(step.detail).toBe("Tax invoice INV-1111-27-0016 issued for the paid part. Each later part is invoiced when it is paid.");
  });
  it("no part invoiced yet → still No invoice yet", () => {
    const step = quoteLifecycle({ ...sale, partInvoices: [] }).steps.find((s) => s.stage === "invoiced")!;
    expect(step.state).not.toBe("done");
    expect(step.detail).toBe("No invoice yet.");
  });
  it("the quote page passes the parts' invoices", () => {
    expect(readFileSync(join(__dirname, "../../app/(app)/quotes/[id]/page.tsx"), "utf8")).toMatch(/partInvoices: partInvoices/);
  });
});
