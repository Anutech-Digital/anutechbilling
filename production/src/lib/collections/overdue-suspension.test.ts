import { describe, it, expect } from "vitest";
import { istToday } from "@/lib/dates/ist";
import {
  DEFAULT_SUSPEND_DAYS,
  NOTICE_GRACE_DAYS,
  decideOverdueSuspension,
  noticeFromDay,
  oldestOverdueInvoice,
  overdueDays,
  pauseOnDate,
  suspendThreshold,
  suspensionNoticeMessage,
  writeOffCandidates,
  type OverdueInvoice,
} from "./overdue-suspension";

const inv = (p: Partial<OverdueInvoice> & { id: string }): OverdueInvoice =>
  ({ status: "overdue", amount: 10000, net_payable: null, paid_amount: 0, due_date: "2026-09-01", ...p });

describe("day count is IST calendar days", () => {
  it("00:10 IST on 17 Oct is already the 17th (UTC still says the 16th)", () => {
    const at = new Date("2026-10-16T18:40:00Z");          // 00:10 IST, 17 Oct
    expect(at.toISOString().slice(0, 10)).toBe("2026-10-16");
    const today = istToday(at);
    expect(today).toBe("2026-10-17");
    expect(overdueDays("2026-10-01", today)).toBe(16);
  });

  it("23:50 IST is still the same IST day", () => {
    expect(istToday(new Date("2026-10-16T18:20:00Z"))).toBe("2026-10-16");
  });

  it("due today = 0, due yesterday = 1, due tomorrow = -1", () => {
    expect(overdueDays("2026-10-07", "2026-10-07")).toBe(0);
    expect(overdueDays("2026-10-06", "2026-10-07")).toBe(1);
    expect(overdueDays("2026-10-08", "2026-10-07")).toBe(-1);
  });

  it("crosses a month end correctly", () => {
    expect(overdueDays("2026-09-25", "2026-10-10")).toBe(15);
  });
});

describe("oldestOverdueInvoice", () => {
  const today = "2026-10-07";

  it("picks the oldest unpaid, past-due invoice", () => {
    const o = oldestOverdueInvoice([
      inv({ id: "B", due_date: "2026-09-20" }),
      inv({ id: "A", due_date: "2026-09-10" }),
      inv({ id: "C", due_date: "2026-10-10" }),               // not yet due
    ], today);
    expect(o).toEqual({ invoiceId: "A", dueDate: "2026-09-10", amountDue: 10000, daysOverdue: 27 });
  });

  it("a part payment keeps the invoice unpaid, at the remaining balance", () => {
    const o = oldestOverdueInvoice([inv({ id: "A", paid_amount: 4000 })], today);
    expect(o?.amountDue).toBe(6000);
  });

  it("a credit note that brings net_payable down to what was paid settles it", () => {
    expect(oldestOverdueInvoice([inv({ id: "A", net_payable: 4000, paid_amount: 4000 })], today)).toBeNull();
  });

  it("a partial credit note lowers the balance (net_payable wins over amount)", () => {
    expect(oldestOverdueInvoice([inv({ id: "A", net_payable: 7000 })], today)?.amountDue).toBe(7000);
  });

  it("paid, void, draft and no-due-date invoices are never candidates", () => {
    expect(oldestOverdueInvoice([
      inv({ id: "P", status: "paid" }),
      inv({ id: "V", status: "void" }),
      inv({ id: "D", status: "draft" }),
      inv({ id: "N", due_date: null }),
      inv({ id: "T", due_date: today }),                      // due today is not overdue
    ], today)).toBeNull();
  });

  it("a tie on due date goes to the lower id", () => {
    expect(oldestOverdueInvoice([inv({ id: "Z" }), inv({ id: "M" })], today)?.invoiceId).toBe("M");
  });
});

describe("threshold and dates", () => {
  it("bad or missing N falls back to 15", () => {
    expect(suspendThreshold(null)).toBe(DEFAULT_SUSPEND_DAYS);
    expect(suspendThreshold(0)).toBe(15);
    expect(suspendThreshold(400)).toBe(15);
    expect(suspendThreshold(2.5)).toBe(15);
    expect(suspendThreshold(30)).toBe(30);
  });

  it("notice starts grace days before the limit, never before day 1", () => {
    expect(NOTICE_GRACE_DAYS).toBe(3);
    expect(noticeFromDay(15)).toBe(13);
    expect(noticeFromDay(2)).toBe(1);
  });

  it("pause date is the later of (due + N + 1) and (notice + grace)", () => {
    expect(pauseOnDate("2026-09-01", 15, "2026-09-14")).toBe("2026-09-17");   // on time
    expect(pauseOnDate("2026-09-01", 15, "2026-09-25")).toBe("2026-09-28");   // late notice → full grace
  });
});

describe("decideOverdueSuspension (N = 15, due 1 Sep)", () => {
  const oldest = (today: string) => oldestOverdueInvoice([inv({ id: "INV-1", due_date: "2026-09-01" })], today);
  const base = (today: string, noticeSentOn: string | null = null) => decideOverdueSuspension({
    enabled: true, thresholdDays: 15, subscriptionStatus: "active", oldest: oldest(today), noticeSentOn,
  }, today);

  it("switch off → nothing, however late", () => {
    const d = decideOverdueSuspension({
      enabled: false, thresholdDays: 15, subscriptionStatus: "active", oldest: oldest("2026-12-01"), noticeSentOn: null,
    }, "2026-12-01");
    expect(d.action).toBe("none");
  });

  it("day 12 → nothing yet", () => {
    expect(base("2026-09-13").action).toBe("none");
  });

  it("day 13 → final notice, pause on 17 Sep", () => {
    const d = base("2026-09-14");
    expect(d.action).toBe("notice");
    expect(d.pauseOn).toBe("2026-09-17");
  });

  it("notice sent, day 15 → still waiting (not more than 15 days yet)", () => {
    expect(base("2026-09-16", "2026-09-14").action).toBe("none");
  });

  it("notice sent, day 16 → pause", () => {
    const d = base("2026-09-17", "2026-09-14");
    expect(d.action).toBe("suspend");
    expect(d.daysOverdue).toBe(16);
    expect(d.reason).toContain("INV-1");
  });

  it("never pauses without a notice, even very late — it sends the notice first", () => {
    const d = base("2026-10-30");
    expect(d.action).toBe("notice");
    expect(d.pauseOn).toBe("2026-11-02");
  });

  it("a late notice still gets the full grace period", () => {
    expect(base("2026-10-01", "2026-09-30").action).toBe("none");
    expect(base("2026-10-03", "2026-09-30").action).toBe("suspend");
  });

  it("only active subscriptions are paused", () => {
    const d = decideOverdueSuspension({
      enabled: true, thresholdDays: 15, subscriptionStatus: "paused", oldest: oldest("2026-10-01"), noticeSentOn: "2026-09-14",
    }, "2026-10-01");
    expect(d.action).toBe("none");
  });

  it("fully paid (no oldest) → nothing", () => {
    const d = decideOverdueSuspension({
      enabled: true, thresholdDays: 15, subscriptionStatus: "active", oldest: null, noticeSentOn: "2026-09-14",
    }, "2026-10-01");
    expect(d.action).toBe("none");
  });
});

describe("writeOffCandidates", () => {
  it("only invoices MORE than 180 days overdue with money owed, oldest first", () => {
    const today = "2026-10-07";
    const rows = writeOffCandidates([
      inv({ id: "AT180", due_date: "2026-04-10" }),            // exactly 180 → not yet
      inv({ id: "D181", due_date: "2026-04-09" }),
      inv({ id: "D300", due_date: "2025-12-11", paid_amount: 2500 }),
      inv({ id: "PAID", due_date: "2025-01-01", status: "paid" }),
      inv({ id: "CN", due_date: "2025-01-01", net_payable: 0 }),
    ], today);
    expect(overdueDays("2026-04-10", today)).toBe(180);
    expect(rows.map((r) => r.invoiceId)).toEqual(["D300", "D181"]);
    expect(rows[0].amountDue).toBe(7500);
  });
});

describe("suspensionNoticeMessage", () => {
  it("names the invoice, amount, service and pause date, and says payment turns it back on", () => {
    const m = suspensionNoticeMessage({
      customerName: "Ravi Kumar", invoiceId: "INV-1", amountDue: "₹10,000", dueDate: "01 Sep 2026",
      pauseOn: "17 Sep 2026", service: "Business Starter for ravi.in", sellerName: "Anutech", payInstruction: "",
    });
    expect(m.subject).toContain("17 Sep 2026");
    expect(m.text).toContain("Hi Ravi,");
    expect(m.text).toContain("Business Starter for ravi.in will be paused on 17 Sep 2026");
    expect(m.text).toContain("turns it back on");
  });
});
