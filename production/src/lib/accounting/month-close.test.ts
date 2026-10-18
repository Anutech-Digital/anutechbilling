import { describe, it, expect } from "vitest";
import { evaluateMonthClose, isQuarterEnd, monthEndOf, type MonthCloseFacts } from "./month-close";

const base: MonthCloseFacts = {
  period: "2026-08", monthEnd: "2026-08-31", today: "2026-09-27",
  unreconciledBankLines: 0, bankAccounts: 1,
  activeEmployees: 3, salariesRun: 3, salariesUnpaid: 0,
  withheld: { tds: 2000, pf: 5400, esi: 0 },
  challans: { tds: true, pf: true, esi: false, mixed: false },
  outputGst: 90000, gstPaid: true,
  draftInvoices: 0, blockedItcCount: 0,
  booksLockedUntil: null,
  manual: { gstr1_filed: { done_at: "2026-09-10", done_by: null }, gstr3b_filed: { done_at: "2026-09-19", done_by: null } },
};

describe("month-end close", () => {
  it("helpers", () => {
    expect(monthEndOf("2026-02")).toBe("2026-02-28");
    expect(monthEndOf("2028-02")).toBe("2028-02-29");
    expect(isQuarterEnd("2026-09")).toBe(true);
    expect(isQuarterEnd("2026-08")).toBe(false);
  });

  it("everything done → ready to lock, lock is the only open step", () => {
    const c = evaluateMonthClose(base);
    expect(c.readyToLock).toBe(true);
    expect(c.steps.filter((s) => s.status === "todo").map((s) => s.key)).toEqual(["lock"]);
    expect(c.done).toBe(c.total - 1);
    expect(c.steps.find((s) => s.key === "tds_return_filed")).toBeUndefined();   // August is not a quarter end
  });

  it("a missing challan names the head and the amount, and blocks the lock", () => {
    const c = evaluateMonthClose({ ...base, challans: { tds: true, pf: false, esi: false, mixed: false } });
    const s = c.steps.find((x) => x.key === "statutory")!;
    expect(s.status).toBe("todo");
    expect(s.detail).toMatch(/PF ₹5,400/);
    expect(c.readyToLock).toBe(false);
  });

  it("a mixed challan covers every head", () => {
    const c = evaluateMonthClose({ ...base, challans: { tds: false, pf: false, esi: false, mixed: true } });
    expect(c.steps.find((x) => x.key === "statutory")!.status).toBe("done");
  });

  it("unreconciled bank lines and unpaid GST are todo; drafts and blocked ITC are warnings that do not block", () => {
    const c = evaluateMonthClose({ ...base, unreconciledBankLines: 3, gstPaid: false, draftInvoices: 2, blockedItcCount: 1 });
    const by = Object.fromEntries(c.steps.map((s) => [s.key, s.status]));
    expect(by.bank).toBe("todo");
    expect(by.gst_paid).toBe("todo");
    expect(by.drafts).toBe("warn");
    expect(by.itc).toBe("warn");
    expect(c.readyToLock).toBe(false);
    const c2 = evaluateMonthClose({ ...base, draftInvoices: 2, blockedItcCount: 1 });
    expect(c2.readyToLock).toBe(true);
  });

  it("R-1576: a vendor bill with no GST credit (proforma / no GSTIN) is an ITC warning too, pointing at Bills", () => {
    const c = evaluateMonthClose({ ...base, blockedBillItcCount: 2 });
    const s = c.steps.find((x) => x.key === "itc")!;
    expect(s.status).toBe("warn");
    expect(s.detail).toMatch(/2 vendor bill\(s\) give no GST credit/);
    expect(s.href).toBe("/accounting/bills");
    expect(evaluateMonthClose(base).steps.find((x) => x.key === "itc")!.status).toBe("done");
  });

  it("quarter end adds the TDS return step; an unticked manual step blocks", () => {
    const c = evaluateMonthClose({ ...base, period: "2026-09", monthEnd: "2026-09-30", today: "2026-10-05" });
    const s = c.steps.find((x) => x.key === "tds_return_filed")!;
    expect(s.kind).toBe("manual");
    expect(s.status).toBe("todo");
    expect(c.readyToLock).toBe(false);
  });

  it("locked books close the month", () => {
    const c = evaluateMonthClose({ ...base, booksLockedUntil: "2026-08-31" });
    expect(c.locked).toBe(true);
    expect(c.steps.find((x) => x.key === "lock")!.status).toBe("done");
    expect(c.done).toBe(c.total);
  });

  it("no GST, no staff, no bank → those steps are n/a and not counted", () => {
    const c = evaluateMonthClose({ ...base, outputGst: 0, activeEmployees: 0, salariesRun: 0, bankAccounts: 0, withheld: { tds: 0, pf: 0, esi: 0 } });
    expect(c.steps.filter((s) => s.status === "na").map((s) => s.key)).toEqual(["bank", "salaries", "statutory", "gst_paid"]);
    expect(c.total).toBe(c.steps.length - 4);
  });
});
