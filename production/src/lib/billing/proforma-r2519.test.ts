/**
 * R-2519 (Pardeep, 6 Nov 2026 — "Zoho ki tarah proforma bhejna"). Staging BITDECENTRO
 * Q-A378-27-0947: one click made a 1 × ₹5,100 "One-time" QUOTATION at 17 seats, marked Sent though
 * nothing was mailed, due 12 Oct in its notes and 6 Nov on the page. Zoho's PI/26-27/1296 was
 * 18 × ₹300 = ₹5,400 + IGST = ₹6,372. These pin the pure rules of the new Bill-next-part preview,
 * the proforma's shown state and the reminder ladder (before due, on due, urgent after).
 */
import { describe, it, expect } from "vitest";
import {
  isProformaNumber, nextPeriods, partAmounts, parseBillNextBody, defaultSeatRate,
  proformaShownState, proformaDocumentTitle,
} from "./proforma";
import { requestReminderStep, requestReminderText } from "./part-requests";

describe("R-2519 — the Bill-next-part preview", () => {
  it("BITDECENTRO: 18 × ₹300 = ₹5,400 + 18% = ₹6,372 (Zoho PI/26-27/1296)", () => {
    expect(partAmounts({ seats: 18, seatRate: 300, taxRate: 18 })).toEqual({ taxable: 5400, tax: 972, gross: 6372 });
    expect(partAmounts({ seats: 17, seatRate: 300, taxRate: 18 })).toEqual({ taxable: 5100, tax: 918, gross: 6018 });
    expect(partAmounts({ seats: 5, seatRate: 1000, taxRate: 0 })).toEqual({ taxable: 5000, tax: 0, gross: 5000 });
  });

  it("the default per-seat rate is the part's taxable ÷ seats (₹5,100 / 17 = ₹300); not exact → null", () => {
    expect(defaultSeatRate({ seats: 17, partTaxable: 5100 })).toBe(300);
    expect(defaultSeatRate({ seats: 3, partTaxable: 2000 })).toBeNull();
    expect(defaultSeatRate({ seats: 0, partTaxable: 2000 })).toBeNull();
  });

  it("the next N periods, back to back, end inclusive (monthly from 12 Oct: 12 Oct–11 Nov, 12 Nov–11 Dec)", () => {
    expect(nextPeriods({ cycle: "monthly", firstStart: "2026-10-12", count: 2 })).toEqual([
      { start: "2026-10-12", end: "2026-11-11" },
      { start: "2026-11-12", end: "2026-12-11" },
    ]);
    expect(nextPeriods({ cycle: "quarterly", firstStart: "2026-01-31", count: 2 })).toEqual([
      { start: "2026-01-31", end: "2026-04-29" },
      { start: "2026-04-30", end: "2026-07-30" },
    ]);
    expect(nextPeriods({ cycle: "monthly", firstStart: "2026-10-12", count: 0 })).toEqual([]);
  });

  it("the body: periods 1–12 (default 1); seats and rate together or not at all; whole numbers", () => {
    expect(parseBillNextBody({})).toEqual({ periods: 1, seats: null, seatRate: null });
    expect(parseBillNextBody(null)).toEqual({ periods: 1, seats: null, seatRate: null });
    expect(parseBillNextBody({ periods: 2, seats: 18, seatRate: 300 })).toEqual({ periods: 2, seats: 18, seatRate: 300 });
    expect(parseBillNextBody({ periods: 13 })).toHaveProperty("error");
    expect(parseBillNextBody({ periods: 0 })).toHaveProperty("error");
    expect(parseBillNextBody({ seats: 18 })).toHaveProperty("error");
    expect(parseBillNextBody({ seats: 1.5, seatRate: 300 })).toHaveProperty("error");
    expect(parseBillNextBody({ seats: 18, seatRate: -1 })).toHaveProperty("error");
  });
});

describe("R-2519 — what the proforma shows", () => {
  const base = { isPartRequest: true, status: "sent", cancelledAt: null, invoiceId: null, paymentStatus: "awaiting", mailed: false, dueOn: "2026-11-06", todayISO: "2026-11-06" };

  it("never mailed → 'Ready to send', not 'Sent' (Q-0947 said Sent with no email)", () => {
    expect(proformaShownState(base)).toEqual({ label: "Ready to send", kind: "info" });
  });
  it("mailed and not yet due → null (the normal Sent badge stands)", () => {
    expect(proformaShownState({ ...base, mailed: true })).toBeNull();
  });
  it("past its pay-by date and unpaid → 'Expired' (still payable; reminders go on)", () => {
    expect(proformaShownState({ ...base, mailed: true, todayISO: "2026-11-07" })).toEqual({ label: "Expired", kind: "danger" });
  });
  it("cancelled → 'Cancelled', for any quote", () => {
    expect(proformaShownState({ ...base, isPartRequest: false, status: "rejected", cancelledAt: "2026-11-06T06:00:00Z" }))
      .toEqual({ label: "Cancelled", kind: "muted" });
  });
  it("money or an invoice → null (the payment badge says it)", () => {
    expect(proformaShownState({ ...base, invoiceId: "INV-1", todayISO: "2026-12-01" })).toBeNull();
    expect(proformaShownState({ ...base, paymentStatus: "partial", todayISO: "2026-12-01" })).toBeNull();
  });
  it("an ordinary quote keeps its own badge", () => {
    expect(proformaShownState({ ...base, isPartRequest: false })).toBeNull();
  });
  it("the PI series and the document title", () => {
    expect(isProformaNumber("PI-A378-27-0001")).toBe(true);
    expect(isProformaNumber("Q-A378-27-0947")).toBe(false);
    expect(proformaDocumentTitle({ isPartRequest: true })).toBe("Proforma Invoice");
    expect(proformaDocumentTitle({ isPartRequest: false })).toBeNull();
  });
});

describe("R-2519 — the proforma reminder ladder (Zoho's 'Urgent: Service Renewal')", () => {
  const base = { dueOn: "2026-11-12", open: true, amountDue: 6372, graceDays: 7 };
  it("a heads-up within 3 days BEFORE the due date, once — only when the proforma went out earlier", () => {
    expect(requestReminderStep({ ...base, todayISO: "2026-11-08", lastStep: "request_sent", lastSentOn: "2026-11-06" })).toBeNull();
    expect(requestReminderStep({ ...base, todayISO: "2026-11-09", lastStep: "request_sent", lastSentOn: "2026-11-06" })).toBe("pre_due");
    expect(requestReminderStep({ ...base, todayISO: "2026-11-10", lastStep: "pre_due", lastSentOn: "2026-11-09" })).toBeNull();
    expect(requestReminderStep({ ...base, todayISO: "2026-11-09", lastStep: "request_sent", lastSentOn: "2026-11-09" })).toBeNull();
  });
  it("on the due date, once — not when the proforma itself went out that day", () => {
    expect(requestReminderStep({ ...base, todayISO: "2026-11-12", lastStep: "pre_due", lastSentOn: "2026-11-09" })).toBe("due_today");
    expect(requestReminderStep({ ...base, todayISO: "2026-11-12", lastStep: "request_sent", lastSentOn: "2026-11-12" })).toBeNull();
    expect(requestReminderStep({ ...base, todayISO: "2026-11-12", lastStep: "due_today", lastSentOn: "2026-11-12" })).toBeNull();
  });
  it("after it: Day 1, Day 3, final — as before", () => {
    expect(requestReminderStep({ ...base, todayISO: "2026-11-13", lastStep: "due_today", lastSentOn: "2026-11-12" })).toBe("reminder");
    expect(requestReminderStep({ ...base, todayISO: "2026-11-15", lastStep: "reminder" })).toBe("retry");
    expect(requestReminderStep({ ...base, todayISO: "2026-11-19", lastStep: "retry" })).toBe("final");
  });
  it("a proforma's mails: 'Proforma Invoice' when new, 'Urgent: Service renewal' once overdue", () => {
    const common = { customerName: "Bitdecentro", companyName: "Anutech", quoteId: "PI-A378-27-0001",
      part: "Google Workspace · bit.in · 18 seats · 12 Nov–11 Dec 2026 (part 1 of 1)", amount: "₹6,372", dueOn: "12 Nov 2026", payUrl: null };
    const n = requestReminderText({ ...common, step: "new" });
    expect(n.subject).toBe("Proforma Invoice PI-A378-27-0001 — ₹6,372");
    expect(n.body).toContain("Here is your proforma invoice PI-A378-27-0001 for Google Workspace · bit.in · 18 seats · 12 Nov–11 Dec 2026 (part 1 of 1). It is due on 12 Nov 2026.");
    expect(requestReminderText({ ...common, step: "pre_due" }).subject).toBe("Renewal due on 12 Nov 2026 — PI-A378-27-0001 (₹6,372)");
    expect(requestReminderText({ ...common, step: "due_today" }).subject).toBe("Renewal due today — PI-A378-27-0001 (₹6,372)");
    expect(requestReminderText({ ...common, step: "reminder" }).subject).toBe("Urgent: Service renewal — PI-A378-27-0001 (₹6,372) is overdue");
    expect(requestReminderText({ ...common, step: "final" }).subject).toBe("Urgent: Service renewal — PI-A378-27-0001 (₹6,372) is overdue");
    expect(requestReminderText({ ...common, step: "reminder" }).body).toContain("Reply to this email for the payment details.");
  });
});

describe("R-2519 — the proforma line on the paper", () => {
  it("'Per seat · 12 Nov–11 Dec 2026', not 'One-time'", async () => {
    const { partLineUnitLabel, periodText } = await import("./proforma");
    expect(partLineUnitLabel({ per_seat: true, period_start: "2026-11-12", period_end: "2026-12-11" })).toBe("Per seat · 12 Nov–11 Dec 2026");
    expect(partLineUnitLabel({ per_seat: false, period_start: "2026-11-12", period_end: "2026-12-11" })).toBe("For 12 Nov–11 Dec 2026");
    expect(partLineUnitLabel({ per_seat: true })).toBe("Per seat");
    expect(partLineUnitLabel({})).toBeNull();
    expect(periodText("2026-12-12", "2027-01-11")).toBe("12 Dec 2026–11 Jan 2027");
  });
});

describe("R-2519 — bill the next N periods", () => {
  it("bills through the start of the Nth period (never before today)", async () => {
    const { billThroughDay } = await import("@/lib/renewals/bill-next.server");
    // BITDECENTRO on 6 Nov: 12 Oct–11 Nov is due; N = 2 also bills 12 Nov–11 Dec now.
    expect(billThroughDay("2026-10-12", "monthly", 1, "2026-11-06")).toBe("2026-11-06");
    expect(billThroughDay("2026-10-12", "monthly", 2, "2026-11-06")).toBe("2026-11-12");
    expect(billThroughDay("2026-10-12", "monthly", 3, "2026-11-06")).toBe("2026-12-12");
    expect(billThroughDay("2026-11-01", "quarterly", 2, "2026-11-06")).toBe("2027-02-01");
  });
});

describe("R-2519 — what Bill next part says", () => {
  it("a PI- proforma: made, not emailed", async () => {
    const { nextPartMessage } = await import("@/lib/renewals/split-billed-next-part");
    const m = nextPartMessage("BITDECENTRO", { raised: [], requests: [{ period_index: 1, quote_id: "PI-A378-27-0001" }], requestsOpen: [] }, null);
    expect(m).toEqual({ ok: true, href: "/quotes/PI-A378-27-0001",
      text: "Proforma Invoice PI-A378-27-0001 made for BITDECENTRO's next part — not emailed yet. Its tax invoice is raised when it is paid." });
  });
});

describe("R-2519 — Cancel / Undo cancel (coordinator, Q-A378-27-0947)", () => {
  it("offered on an open, unpaid, uninvoiced quote; never on add-seats, money in, an invoice, or a closed one", async () => {
    const { cancelQuoteAction, parseCancelReason } = await import("./proforma");
    const open = { status: "sent", cancelledAt: null, invoiceId: null, receivedSoFar: 0, isAddSeats: false };
    expect(cancelQuoteAction(open)).toBe("cancel");
    expect(cancelQuoteAction({ ...open, status: "draft" })).toBe("cancel");
    expect(cancelQuoteAction({ ...open, receivedSoFar: 100 })).toBeNull();
    expect(cancelQuoteAction({ ...open, invoiceId: "INV-1" })).toBeNull();
    expect(cancelQuoteAction({ ...open, isAddSeats: true })).toBeNull();
    expect(cancelQuoteAction({ ...open, status: "rejected" })).toBeNull();
    expect(cancelQuoteAction({ ...open, status: "rejected", cancelledAt: "2026-11-06T06:00:00Z" })).toBe("undo");
    expect(parseCancelReason({ reason: "  no " })).toHaveProperty("error");
    expect(parseCancelReason({ reason: " Wrong seats, re-billing at 18 " })).toEqual({ reason: "Wrong seats, re-billing at 18" });
  });
});

describe("R-2519 — the quotes list reads Cancelled", () => {
  it("a cancelled quote is 'Cancelled', a rejected one stays 'Rejected'", async () => {
    const { unifiedStatus } = await import("@/lib/quotes/status-badge");
    const q = { status: "rejected" as const, payment_status: "none" as const, amount: 6018, payment_amount: 0 };
    expect(unifiedStatus({ ...q, cancelled_at: "2026-11-06T06:00:00Z" }, "2026-11-06")).toEqual({ label: "Cancelled", kind: "muted" });
    expect(unifiedStatus(q, "2026-11-06").label).not.toBe("Cancelled");
  });
});
