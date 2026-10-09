import { describe, it, expect } from "vitest";
import { unifiedStatus, cashNote, outstanding } from "./status-badge";
import type { Quote } from "@/lib/supabase/database.types";

type Fields = Pick<Quote, "status" | "payment_status" | "amount" | "payment_amount">;
const q = (over: Partial<Fields>): Fields =>
  ({ status: "sent", payment_status: "none", amount: 0, payment_amount: 0, ...over }) as Fields;

describe("a payment is never hidden by the quote's status", () => {
  /**
   * THE ROW THAT PROMPTED THIS, exactly as production held it:
   * Q-ADPL-2026-27-0024 · ₹38,232 · ₹20,000 received · status `sent`.
   * The list showed "Out for review", which reads as "nothing has happened yet".
   */
  const theRealOne = q({ status: "sent", payment_status: "partial", amount: 38232, payment_amount: 20000 });

  it("labels the real production row as part-paid, not as out for review", () => {
    expect(unifiedStatus(theRealOne).label).toBe("Partly paid");
    expect(unifiedStatus(theRealOne).label).not.toBe("Out for review");
  });

  it("says part-paid whatever the workflow status claims", () => {
    /* The old code only reached the payment checks from `status === "accepted"`. Every
       one of these fell through to the status switch and lost the payment entirely. */
    for (const status of ["draft", "sent", "viewed", "accepted", "expired"] as const) {
      expect(unifiedStatus(q({ status, payment_status: "partial", amount: 100, payment_amount: 40 })).label, status)
        .toBe("Partly paid");
    }
  });

  it("does the same for fully received and for invoiced", () => {
    for (const status of ["draft", "sent", "viewed", "accepted"] as const) {
      expect(unifiedStatus(q({ status, payment_status: "received" })).label, status).toBe("Paid");
      expect(unifiedStatus(q({ status, payment_status: "invoiced" })).label, status).toBe("Invoiced");
    }
  });

  it("gives part-paid a tone that does not read as routine", () => {
    /* Amber is what this list uses for "Out for review" and "expiring soon". Half-collected
       money should not look like a reminder to send an email. */
    expect(unifiedStatus(theRealOne).kind).toBe("danger");
    expect(unifiedStatus(q({ status: "sent" })).kind).toBe("warning");
  });

  it("leaves the plain workflow statuses alone", () => {
    expect(unifiedStatus(q({ status: "draft" })).label).toBe("Draft");
    expect(unifiedStatus(q({ status: "sent" })).label).toBe("Out for review");
    expect(unifiedStatus(q({ status: "viewed" })).label).toBe("Viewed");
    expect(unifiedStatus(q({ status: "rejected" })).label).toBe("Rejected");
    expect(unifiedStatus(q({ status: "expired" })).label).toBe("Expired");
    expect(unifiedStatus(q({ status: "accepted" })).label).toBe("Accepted");
  });

  it("calls a replaced quote Replaced, not Expired (R-448)", () => {
    expect(unifiedStatus({ ...q({ status: "expired" }), superseded_by: "Q-1-R2" })).toEqual({ label: "Replaced", kind: "muted" });
  });
});

describe("the cash note carries both halves for a part-paid quote", () => {
  it("states what came in AND what is left", () => {
    /* Either number alone misleads: "₹18,232 left" hides that most of it is collected,
       "₹20,000 paid" hides that it is not finished. */
    const note = cashNote(q({ payment_status: "partial", amount: 38232, payment_amount: 20000 }));
    expect(note?.tone).toBe("owed");
    expect(note?.text).toContain("₹20,000 paid");
    expect(note?.text).toContain("₹18,232 left");
  });

  it("formats in Indian digit grouping, not thousands", () => {
    const note = cashNote(q({ payment_status: "partial", amount: 1500000, payment_amount: 500000 }));
    expect(note?.text).toContain("₹5,00,000");   // not 500,000
    expect(note?.text).toContain("₹10,00,000");
  });

  it("shows only the due figure once an invoice exists", () => {
    const note = cashNote(q({ payment_status: "invoiced", amount: 1000, payment_amount: 400 }));
    expect(note?.text).toBe("₹600 due");
  });

  it("says awaiting payment when nothing has arrived", () => {
    expect(cashNote(q({ payment_status: "awaiting" }))?.tone).toBe("waiting");
    expect(cashNote(q({ status: "accepted", payment_status: "none" }))?.tone).toBe("waiting");
  });

  it("stays silent when there is nothing to say", () => {
    expect(cashNote(q({ status: "draft" }))).toBeNull();
    expect(cashNote(q({ status: "rejected" }))).toBeNull();
    // Fully settled: no note, the "Paid" badge already says it.
    expect(cashNote(q({ payment_status: "received", amount: 500, payment_amount: 500 }))).toBeNull();
  });

  it("never reports a negative balance when the customer overpaid", () => {
    expect(outstanding({ amount: 1000, payment_amount: 1200 })).toBe(0);
    expect(cashNote(q({ payment_status: "partial", amount: 1000, payment_amount: 1200 }))).toBeNull();
  });
});
