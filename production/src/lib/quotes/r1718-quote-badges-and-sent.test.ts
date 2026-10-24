/* R-1718 (local check, 21 Oct 2026).
   (1) Q-F588-27-0031 (T-A1-20Oct) as the local DB holds it: status `rejected`, payment_status
       `awaiting` (rejecting does not reset it). The header showed "Rejected" AND "Awaiting
       payment" — a closed quote is not waiting for money.
   (2) Q-F588-27-0034 / -0037: accepted without any email (quote_send_log has no row for
       them) — the activity said "Sent to customer — Quote shared with …". */
import { describe, it, expect } from "vitest";
import { unifiedStatus, cashNote, quotePaymentBadge } from "./status-badge";
import { quoteSentEvent } from "./sent-event";
import type { Quote } from "@/lib/supabase/database.types";

type Fields = Pick<Quote, "status" | "payment_status" | "amount" | "payment_amount"> & { superseded_by?: string | null };
const q = (over: Partial<Fields>): Fields =>
  ({ status: "sent", payment_status: "none", amount: 0, payment_amount: 0, ...over }) as Fields;

describe("R-1718 a closed quote shows no payment status", () => {
  const q0031 = q({ status: "rejected", payment_status: "awaiting", amount: 3813, payment_amount: null as unknown as number });

  it("the real rejected row: Rejected only — no 'Awaiting payment' badge or cash note", () => {
    expect(unifiedStatus(q0031).label).toBe("Rejected");
    expect(quotePaymentBadge(q0031)).toBeNull();
    expect(cashNote(q0031)).toBeNull();
  });

  it("expired and replaced quotes do not wait for money either", () => {
    for (const closed of [q({ status: "expired", payment_status: "awaiting" }), q({ status: "expired", payment_status: "awaiting", superseded_by: "Q-2" })]) {
      expect(quotePaymentBadge(closed)).toBeNull();
      expect(cashNote(closed)).toBeNull();
    }
  });

  it("an open quote still says Awaiting payment", () => {
    const open = q({ status: "accepted", payment_status: "awaiting", amount: 1180 });
    expect(quotePaymentBadge(open)).toBe("awaiting");
    expect(cashNote(open)).toEqual({ text: "Awaiting payment", tone: "waiting" });
  });

  it("money that really came in is still shown on a closed quote (a payment is a fact)", () => {
    expect(quotePaymentBadge(q({ status: "rejected", payment_status: "partial", amount: 100, payment_amount: 40 }))).toBe("partial");
    expect(quotePaymentBadge(q({ status: "expired", payment_status: "received" }))).toBe("received");
  });

  it("'none' is never a badge", () => {
    expect(quotePaymentBadge(q({ status: "sent", payment_status: "none" }))).toBeNull();
  });
});

describe("R-1718 'Sent to customer' only when an email really went", () => {
  const base = { customer_name: "T-V7 Test" };

  it("accepted with no send row (Q-0034 / Q-0037): no 'Sent to customer' line", () => {
    const e = quoteSentEvent({ ...base, status: "accepted" }, []);
    expect(e?.title).not.toBe("Sent to customer");
    expect(e).toBeNull();
  });

  it("Mark as sent (status sent, no send row): the app's own words — 'Marked as sent'", () => {
    const e = quoteSentEvent({ ...base, status: "sent" }, []);
    expect(e?.title).toBe("Marked as sent");
    expect(e?.body).toMatch(/no email/i);
  });

  it("a failed or stubbed email is not 'sent'", () => {
    const e = quoteSentEvent({ ...base, status: "sent" }, [
      { status: "failed", sent_at: "2026-10-21T03:58:30Z", recipient_email: "a@b.in" },
      { status: "stubbed", sent_at: "2026-10-21T04:00:00Z", recipient_email: "a@b.in" },
    ]);
    expect(e?.title).toBe("Marked as sent");
  });

  it("a real email: 'Sent to customer', to whom and when", () => {
    const e = quoteSentEvent({ ...base, status: "accepted" }, [
      { status: "failed", sent_at: "2026-10-20T10:00:00Z", recipient_email: "x@b.in" },
      { status: "sent", sent_at: "2026-10-21T05:00:00Z", recipient_email: "owner@t-v7.in" },
    ]);
    expect(e).toEqual({ title: "Sent to customer", body: "Quote emailed to owner@t-v7.in", at: "2026-10-21T05:00:00Z" });
  });

  it("a draft has no sent line", () => {
    expect(quoteSentEvent({ ...base, status: "draft" }, [])).toBeNull();
  });
});
