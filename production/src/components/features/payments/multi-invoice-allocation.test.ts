import { describe, expect, it } from "vitest";
import { fifoAllocate, lineTdsHint, openInvoicesOldestFirst, summarise, toRpcAllocations } from "./multi-invoice-allocation";

const inv = (id: string, date: string, amount: number, paid = 0, status = "pending") =>
  ({ id, invoice_date: date, due_date: null, amount, net_payable: amount, paid_amount: paid, status, tax_rate: 18 });

describe("R-1525 openInvoicesOldestFirst", () => {
  it("drops paid / void / settled invoices and sorts by date then id", () => {
    const out = openInvoicesOldestFirst([
      inv("I3", "2026-09-01", 1180),
      inv("I1", "2026-07-01", 1180),
      inv("I2", "2026-07-01", 2360, 360),
      inv("PAID", "2026-01-01", 1180, 0, "paid"),
      inv("VOID", "2026-01-01", 1180, 0, "void"),
      inv("DONE", "2026-01-01", 1180, 1180),
    ]);
    expect(out.map((r) => [r.id, r.due])).toEqual([["I1", 1180], ["I2", 2000], ["I3", 1180]]);
  });
});

describe("R-1525 fifoAllocate", () => {
  const list = [{ id: "I1", due: 1180 }, { id: "I2", due: 2360 }, { id: "I3", due: 1180 }];
  it("pays oldest first, last one partial, the rest get 0", () => {
    expect(fifoAllocate(4040, list).map((l) => l.amount)).toEqual([1180, 2360, 500]);
    expect(fifoAllocate(1000, list).map((l) => l.amount)).toEqual([1000, 0, 0]);
  });
  it("more than all dues → every invoice full; the rest is not allocated", () => {
    const lines = fifoAllocate(5000, list);
    expect(lines.map((l) => l.amount)).toEqual([1180, 2360, 1180]);
    expect(summarise(5000, lines, list)).toMatchObject({ allocated: 4720, remaining: 280, problem: null });
  });
  it("paise and negatives never reach a line", () => {
    expect(fifoAllocate(-5, list).map((l) => l.amount)).toEqual([0, 0, 0]);
    expect(fifoAllocate(1180.9, list).map((l) => l.amount)).toEqual([1180, 0, 0]);
  });
});

describe("R-1525 summarise — the same refusals the RPC makes, said before Save", () => {
  const list = [{ id: "I1", due: 1180 }, { id: "I2", due: 2360 }];
  it("over an invoice's due", () => {
    const s = summarise(1500, [{ invoiceId: "I1", amount: 1500, tds: 0 }], list);
    expect(s.overDue).toEqual(["I1"]);
    expect(s.problem).toMatch(/I1 gets more than its due/);
  });
  it("TDS counts toward the due", () => {
    const s = summarise(1100, [{ invoiceId: "I1", amount: 1100, tds: 100 }], list);
    expect(s.problem).toMatch(/I1 gets more than its due/);
  });
  it("lines above the amount received", () => {
    const s = summarise(1000, [{ invoiceId: "I1", amount: 1180, tds: 0 }], list);
    expect(s.problem).toMatch(/only ₹1,000 came in/);
  });
  it("advance left while every line is part-paid", () => {
    const s = summarise(1000, [{ invoiceId: "I1", amount: 600, tds: 0 }], list);
    expect(s.remaining).toBe(400);
    expect(s.problem).toMatch(/pay the oldest one in full first/);
  });
  it("advance left after a full invoice is fine", () => {
    const s = summarise(1500, [{ invoiceId: "I1", amount: 1180, tds: 0 }, { invoiceId: "I2", amount: 0, tds: 0 }], list);
    expect(s).toMatchObject({ remaining: 320, anyFull: true, problem: null });
    expect(s.used).toHaveLength(1);
  });
  it("a TDS line that settles the invoice counts as full", () => {
    const s = summarise(1180, [{ invoiceId: "I1", amount: 1080, tds: 100 }, { invoiceId: "I2", amount: 100, tds: 0 }], list);
    expect(s).toMatchObject({ anyFull: true, remaining: 0, problem: null });
  });
  it("nothing received / nothing applied", () => {
    expect(summarise(0, [], list).problem).toMatch(/amount received/);
    expect(summarise(500, [{ invoiceId: "I1", amount: 0, tds: 0 }], list).problem).toMatch(/at least one invoice/);
  });
});

describe("R-1525 lineTdsHint", () => {
  it("₹1,180 invoice, ₹1,080 paid → ₹100 = 10% TDS on ₹1,000 (194J)", () => {
    const m = lineTdsHint(inv("I1", "2026-07-01", 1180), { amount: 1080, tds: 0 });
    expect(m).toMatchObject({ section: "194J", ratePct: 10, tds: 100 });
  });
  it("no hint once TDS is entered, or when the line pays everything", () => {
    expect(lineTdsHint(inv("I1", "2026-07-01", 1180), { amount: 1080, tds: 100 })).toBeNull();
    expect(lineTdsHint(inv("I1", "2026-07-01", 1180), { amount: 1180, tds: 0 })).toBeNull();
  });
});

describe("R-1525 toRpcAllocations", () => {
  it("drops empty lines and sends TDS only when there is some", () => {
    expect(toRpcAllocations([
      { invoiceId: "I1", amount: 1080, tds: 100, tdsSection: "194J", tdsRatePct: 10 },
      { invoiceId: "I2", amount: 0, tds: 0 },
      { invoiceId: "I3", amount: 500, tds: 0 },
    ])).toEqual([
      { invoice_id: "I1", amount: 1080, tds_amount: 100, tds_section: "194J", tds_rate_pct: 10 },
      { invoice_id: "I3", amount: 500 },
    ]);
  });
});
