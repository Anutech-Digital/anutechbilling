import { describe, expect, it } from "vitest";
import { sortRows } from "@/lib/table/data-table";
import { BILL_SORT, billOutstanding, filterBills, readBillsView, type BillRowLike } from "./bills-table";

const bill = (o: Partial<BillRowLike>): BillRowLike => ({
  vendor_name: "Google", bill_no: "B-1", bill_date: "2026-09-01", total: 1000, paid_amount: 0, status: "unpaid", ...o,
});

const rows = [
  bill({ vendor_name: "zoho", bill_no: "Z-10", bill_date: "2026-08-15", total: 590, status: "paid", paid_amount: 590 }),
  bill({ vendor_name: "Google CSP", bill_no: "G-2", bill_date: "2026-09-20", total: 118000, status: "partial", paid_amount: 18000, vendor_gstin: "29ABCDE1234F1Z5" }),
  bill({ vendor_name: "Microsoft", bill_no: "", bill_date: "2026-07-01", total: 23600, category: "COGS-M365" }),
];

describe("R-214 bills list on DataTable", () => {
  it("sorts by amount as numbers, not text", () => {
    expect(sortRows(rows, BILL_SORT.amount, "asc").map((b) => b.total)).toEqual([590, 23600, 118000]);
    expect(sortRows(rows, BILL_SORT.amount, "desc").map((b) => b.total)).toEqual([118000, 23600, 590]);
  });

  it("sorts by bill date and vendor (case-insensitive)", () => {
    expect(sortRows(rows, BILL_SORT.date, "asc").map((b) => b.bill_date)).toEqual(["2026-07-01", "2026-08-15", "2026-09-20"]);
    expect(sortRows(rows, BILL_SORT.vendor, "asc").map((b) => b.vendor_name)).toEqual(["Google CSP", "Microsoft", "zoho"]);
  });

  it("puts a bill with no bill # last both ways", () => {
    expect(sortRows(rows, BILL_SORT.bill_no, "asc").at(-1)?.vendor_name).toBe("Microsoft");
    expect(sortRows(rows, BILL_SORT.bill_no, "desc").at(-1)?.vendor_name).toBe("Microsoft");
  });

  it("search matches vendor, bill #, GSTIN and category", () => {
    expect(filterBills(rows, "google").map((b) => b.bill_no)).toEqual(["G-2"]);
    expect(filterBills(rows, "z-10")).toHaveLength(1);
    expect(filterBills(rows, "29abcde")).toHaveLength(1);
    expect(filterBills(rows, "m365").map((b) => b.vendor_name)).toEqual(["Microsoft"]);
    expect(filterBills(rows, "  ")).toHaveLength(3);
    expect(filterBills(rows, "nothing")).toHaveLength(0);
  });

  it("outstanding is whole rupees and zero once paid", () => {
    expect(billOutstanding(rows[1])).toBe(100000);
    expect(billOutstanding(rows[0])).toBe(0);
    expect(billOutstanding(bill({ total: 1000, paid_amount: 1200 }))).toBe(0);
  });

  it("a saved view only restores valid filters", () => {
    const current = { from: "2026-04-01", to: "2026-10-06", status: "" as const, q: "" };
    expect(readBillsView({ from: "2026-05-01", to: "2026-06-30", status: "owed", q: "zoho" }, current))
      .toEqual({ from: "2026-05-01", to: "2026-06-30", status: "owed", q: "zoho" });
    expect(readBillsView({ from: "bad", to: 5, status: "deleted" }, current))
      .toEqual({ from: "2026-04-01", to: "2026-10-06", status: "", q: "" });
  });
});
