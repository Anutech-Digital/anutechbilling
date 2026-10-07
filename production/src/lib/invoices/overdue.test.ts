/**
 * R-060 — the Overdue tab must fill up on its own, and the page must not go back to
 * asking a column nobody writes.
 *
 * Two halves, deliberately:
 *   1. the arithmetic (this is a pure function, so it is tested as one)
 *   2. a source scan proving `/invoices` stopped reading `status === "overdue"` and
 *      `overdue_days` — because the defect this fixes is an ABSENCE of a writer, and no
 *      unit test of a helper can see a page that went back to the stored value (L85).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { invoiceIsOverdue, invoiceOverdueDays, invoiceBucket } from "./overdue";

const TODAY = "2026-09-30";
const inv = (o: Partial<Parameters<typeof invoiceIsOverdue>[0]>) => ({
  status: "pending", due_date: "2026-09-01", amount: 118000, paid_amount: 0, ...o,
});

describe("invoiceIsOverdue", () => {
  it("an unpaid invoice past its due date is overdue — the case that was invisible", () => {
    expect(invoiceIsOverdue(inv({ due_date: "2026-08-15" }), TODAY)).toBe(true);
  });

  it("is not overdue ON the due date, only after it", () => {
    /* Net-30 means the customer has all of day 30 to pay. Calling it late that morning
       would put a customer who is paying on time into the chase list. */
    expect(invoiceIsOverdue(inv({ due_date: TODAY }), TODAY)).toBe(false);
    expect(invoiceIsOverdue(inv({ due_date: "2026-09-29" }), TODAY)).toBe(true);
  });

  it("a settled or unreal invoice is never overdue", () => {
    for (const status of ["paid", "void", "draft", "cancelled"]) {
      expect(invoiceIsOverdue(inv({ status, due_date: "2020-01-01" }), TODAY), status).toBe(false);
    }
  });

  it("no due date is not overdue-since-forever", () => {
    /* decideDunning states the same rule in words: an invoice with no due date is one
       nobody gave a deadline. Inventing one starts chasing customers on terms they were
       never told. */
    expect(invoiceIsOverdue(inv({ due_date: null }), TODAY)).toBe(false);
  });

  it("fully paid but still marked pending is not overdue", () => {
    expect(invoiceIsOverdue(inv({ due_date: "2026-01-01", amount: 5000, paid_amount: 5000 }), TODAY)).toBe(false);
    // partly paid still is — the balance is late
    expect(invoiceIsOverdue(inv({ due_date: "2026-01-01", amount: 5000, paid_amount: 4999 }), TODAY)).toBe(true);
  });

  it("R-371: balance is net_payable − paid (credit note / advance), not amount − paid", () => {
    // Fully covered by a credit note + advance at issue → nothing owed → not overdue.
    expect(invoiceIsOverdue(inv({ due_date: "2026-01-01", amount: 5000, net_payable: 0 }), TODAY)).toBe(false);
    // net 4,000 with 4,000 received since → settled, even though amount − paid = 1,000.
    expect(invoiceIsOverdue(inv({ due_date: "2026-01-01", amount: 5000, net_payable: 4000, paid_amount: 4000 }), TODAY)).toBe(false);
    // still a balance after the credit note → overdue
    expect(invoiceIsOverdue(inv({ due_date: "2026-01-01", amount: 11800, net_payable: 10620 }), TODAY)).toBe(true);
  });

  it("honours a stored 'overdue' if one ever arrives", () => {
    /* Nothing writes it today. If a later cron or a data import does, the page must not
       argue with it — including when the due date is missing. */
    expect(invoiceIsOverdue(inv({ status: "overdue", due_date: null }), TODAY)).toBe(true);
  });
});

describe("invoiceOverdueDays", () => {
  it("counts whole days past the due date", () => {
    expect(invoiceOverdueDays(inv({ due_date: "2026-09-01" }), TODAY)).toBe(29);
    expect(invoiceOverdueDays(inv({ due_date: "2026-09-29" }), TODAY)).toBe(1);
  });

  it("is 0 for anything not overdue, rather than negative", () => {
    expect(invoiceOverdueDays(inv({ due_date: "2026-12-01" }), TODAY)).toBe(0);
    expect(invoiceOverdueDays(inv({ status: "paid", due_date: "2020-01-01" }), TODAY)).toBe(0);
  });

  it("crosses a month and a year boundary correctly", () => {
    expect(invoiceOverdueDays(inv({ due_date: "2025-12-31" }), "2026-01-01")).toBe(1);
    expect(invoiceOverdueDays(inv({ due_date: "2026-02-28" }), "2026-03-01")).toBe(1);
  });
});

describe("invoiceBucket", () => {
  it("moves an overdue invoice OUT of pending", () => {
    /* The tab counts and the row filter both call this, so an invoice appears in exactly
       one tab — what would have happened if the status had actually been written. */
    expect(invoiceBucket(inv({ due_date: "2026-08-01" }), TODAY)).toBe("overdue");
    expect(invoiceBucket(inv({ due_date: "2026-12-01" }), TODAY)).toBe("pending");
    expect(invoiceBucket(inv({ status: "paid" }), TODAY)).toBe("paid");
  });
});

describe("/invoices no longer asks the column nobody writes", () => {
  /* R-238: the badge label moved to invoice-status.ts (shared with /invoices/<id>), so the
     scan reads the page together with the file it delegates the label to. */
  const src = (readFileSync("src/app/(app)/invoices/page.tsx", "utf8")
    + readFileSync("src/app/(app)/invoices/invoice-status.ts", "utf8"))
    /* Comments stripped: the prose explaining why the old shape was removed must not
       satisfy a scan looking for that shape (L46). */
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    /* Trailing `// …` too, not just whole comment lines — the first draft of this scan
       went green against a line whose only match was the comment saying what had been
       removed. Anchored on line-start-or-whitespace so `https://` survives. */
    .replace(/(^|\s)\/\/[^\n]*/gm, "$1");

  it("renders the day count from the helper, not invoices.overdue_days", () => {
    /* `overdue_days` is `integer default 0` in the schema with no writer in any
       migration, route or trigger — so the badge it fed could only ever have said
       "Overdue 0d". */
    expect(src).not.toContain("overdue_days");
    expect(src).toContain("invoiceOverdueDays");
  });

  it("the tab, the counts and the KPI all go through the derived helpers", () => {
    expect(src).toContain("invoiceBucket");
    /* R-062/R-063: tab filter + counts go through invoiceChip, the KPI tiles through
       invoiceKpis — both of which decide overdue with invoiceIsOverdue. */
    expect(src).toContain("invoiceChip(i)");
    expect(src).toContain("invoiceChipCounts(");
    expect(src).toContain("invoiceKpis(");
    const kpis = readFileSync("src/lib/invoices/kpis.ts", "utf8");
    expect(kpis.split("invoiceIsOverdue(inv, today)").length - 1).toBe(2);
    // …and no filter is left comparing the stored status to the string.
    expect(src).not.toMatch(/status\s*===\s*"overdue"/);
  });
});
