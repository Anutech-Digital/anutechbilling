/**
 * R-1760 — the owner's dry run (22 Oct, localhost): 1,245 new customers, 1,371 live
 * subscriptions, 246 open invoices. One call for all of it met the 8 s statement timeout;
 * in parts of 150 it is 21 calls, each a fraction of a second (SQL test: slowest 248 ms).
 */
import { describe, it, expect } from "vitest";
import { IMPORT_PART_ROWS, countParts, importPercent, importProgressText } from "./import-parts";

const owner = { customers: 1245, subscriptions: 1371, invoices: 246 };

describe("Zoho import in parts", () => {
  it("the owner's plan is split into many parts of 150 rows", () => {
    expect(IMPORT_PART_ROWS).toBe(150);
    expect(countParts(owner)).toBe(9 + 10 + 2);
    expect(countParts({ customers: 0, subscriptions: 0, invoices: 0 })).toBe(1);
    expect(countParts({ customers: 150, subscriptions: 1, invoices: 0 })).toBe(2);
  });

  it("progress reads like the card: Importing… 300 of 1,245 customers", () => {
    expect(importProgressText({ stage: "customers", offset: 300, totals: owner, done: false })).toBe("Importing… 300 of 1,245 customers");
    expect(importProgressText({ stage: "subscriptions", offset: 0, totals: owner, done: false })).toBe("Importing… 0 of 1,371 subscriptions");
    expect(importProgressText({ stage: "invoices", offset: 150, totals: owner, done: false })).toBe("Importing… 150 of 246 invoices");
    expect(importProgressText({ stage: "done", offset: 0, totals: owner, done: true })).toBe("Import finished");
  });

  it("percent runs over all three stages", () => {
    expect(importPercent({ stage: "customers", offset: 0, totals: owner, done: false })).toBe(0);
    expect(importPercent({ stage: "subscriptions", offset: 0, totals: owner, done: false })).toBe(Math.round((1245 / 2862) * 100));
    expect(importPercent({ stage: "invoices", offset: 246, totals: owner, done: false })).toBe(100);
    expect(importPercent({ stage: "done", offset: 0, totals: owner, done: true })).toBe(100);
  });
});

describe("R-1766: undo progress", () => {
  it("reads like the import: Undoing… 300 of 1,371 subscriptions removed, then customers", async () => {
    const { undoProgressText, UNDO_STOPPED_TEXT } = await import("./import-parts");
    expect(undoProgressText({ subscriptions_removed: 300, subscriptions_total: 1371, customers_removed: 0, customers_total: 1245 }))
      .toBe("Undoing… 300 of 1,371 subscriptions removed");
    expect(undoProgressText({ subscriptions_removed: 1371, subscriptions_total: 1371, customers_removed: 500, customers_total: 1245 }))
      .toBe("Undoing… 500 of 1,245 customers removed");
    expect(undoProgressText({})).toBe("Undoing…");
    expect(UNDO_STOPPED_TEXT).toBe("Undo stopped part way — press Undo import to continue.");
  });
});
