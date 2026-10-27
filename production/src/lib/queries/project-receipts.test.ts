import { describe, it, expect } from "vitest";
import { receiptMilestones, isInterState, allocateProjectReceiptArgs, allocateProjectReceiptCall } from "./project-receipts";

describe("receiptMilestones — a new project created from a bank receipt", () => {
  it("receipt is the whole value → one Full payment milestone", () => {
    expect(receiptMilestones(540_000, 540_000)).toEqual([{ label: "Full payment", total_amount: 540_000, due_date: null }]);
  });
  it("receipt is part of it → Advance (this receipt) + Balance (the rest), adding up to the total", () => {
    const m = receiptMilestones(1_000_000, 540_000);
    expect(m.map((x) => x.label)).toEqual(["Advance", "Balance"]);
    expect(m[0].total_amount).toBe(540_000);
    expect(m.reduce((s, x) => s + x.total_amount, 0)).toBe(1_000_000);
  });
});

describe("isInterState — place of supply from the two records", () => {
  it("same state → CGST+SGST, different → IGST", () => {
    expect(isInterState("07", "07")).toBe(false);
    expect(isInterState("07", "09")).toBe(true);
  });
  it("either state missing → unknown, never a guessed false", () => {
    expect(isInterState("07", null)).toBeNull();
    expect(isInterState(null, "07")).toBeNull();
    expect(isInterState("07", " ")).toBeNull();
  });
});

describe("allocateProjectReceiptArgs — R-1995 one receipt, many instalments", () => {
  it("keeps the given (FIFO) order, drops untouched lines, sends whole rupees", () => {
    const args = allocateProjectReceiptArgs({
      bankTxnId: "t1", projectId: "p1",
      allocations: [
        { milestoneId: "m1", amount: 118_000, raiseInvoice: true },
        { milestoneId: "m3", amount: 0, raiseInvoice: true },
        { milestoneId: "m2", amount: 118_000.4, raiseInvoice: false },
      ],
      reference: "  ",
    });
    expect(args.p_allocations).toEqual([
      { milestone_id: "m1", amount: 118_000, raise_invoice: true },
      { milestone_id: "m2", amount: 118_000, raise_invoice: false },
    ]);
    expect(args.p_reference).toBeNull();
    expect(args.p_received_at).toBeNull();
  });
});

describe("allocateProjectReceiptCall — R-1998 picks the RPC: with TDS → allocate_project_receipt_with_tds", () => {
  const base = { bankTxnId: "t1", projectId: "p1", allocations: [{ milestoneId: "m1", amount: 236_000, raiseInvoice: true }] };
  it("no TDS → R-1995's allocate_project_receipt, no p_tds argument", () => {
    const c = allocateProjectReceiptCall(base);
    expect(c.fn).toBe("allocate_project_receipt");
    expect("p_tds" in c.args).toBe(false);
  });
  it("TDS → allocate_project_receipt_with_tds with {section, rate_pct, amount}", () => {
    const c = allocateProjectReceiptCall({ ...base, tds: { section: "194J", ratePct: 10, amount: 23_600 } });
    expect(c.fn).toBe("allocate_project_receipt_with_tds");
    expect(c.args).toMatchObject({ p_bank_txn_id: "t1", p_project_id: "p1", p_tds: { section: "194J", rate_pct: 10, amount: 23_600 } });
  });
});
