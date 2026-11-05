/**
 * R-2496 — one books start per company. Owner decision 5 Nov 2026: Excel's books start 1 Apr 2025
 * (opening balances as at 31 Mar 2025). The setting wins; else the CA's opening date + 1; else none.
 */
import { describe, it, expect } from "vitest";
import {
  BOOKS_START_FALLBACK, BooksStartReadError, booksStartOf, openingDateMismatch, readBooksStart, reportStart,
  type BooksStartDb,
} from "./books-start";
import { retainedProfitRange } from "./balance-sheet-totals";

describe("R-2496 booksStartOf", () => {
  it("the owner's setting wins over the opening balances date (Excel: 1 Apr 2025)", () => {
    expect(booksStartOf({ booksStartDate: "2025-04-01", openingAsOf: "2026-03-31" }))
      .toEqual({ start: "2025-04-01", source: "setting", setting: "2025-04-01", openingAsOf: "2026-03-31" });
  });

  it("no setting → the day after the CA's opening balances date (what the app did before)", () => {
    expect(booksStartOf({ booksStartDate: null, openingAsOf: "2026-03-31" }))
      .toEqual({ start: "2026-04-01", source: "opening", setting: null, openingAsOf: "2026-03-31" });
  });

  it("neither → no start; whole-book reports read from the wide fallback, never a guessed 1 Apr", () => {
    const bs = booksStartOf({});
    expect(bs).toEqual({ start: null, source: null, setting: null, openingAsOf: null });
    expect(reportStart(bs)).toBe(BOOKS_START_FALLBACK);
    expect(reportStart(booksStartOf({ booksStartDate: "2025-04-01" }))).toBe("2025-04-01");
  });

  it("a timestamp from the database is cut to its date", () => {
    expect(booksStartOf({ booksStartDate: "2025-04-01T00:00:00+00:00" }).start).toBe("2025-04-01");
  });
});

describe("R-2496 openingDateMismatch — opening balances must be as at the day before the books start", () => {
  it("31 Mar 2025 with books from 1 Apr 2025 → fine", () => {
    expect(openingDateMismatch(booksStartOf({ booksStartDate: "2025-04-01", openingAsOf: "2025-03-31" }))).toBeNull();
  });
  it("31 Mar 2026 with books from 1 Apr 2025 → warn, says the date it should be", () => {
    expect(openingDateMismatch(booksStartOf({ booksStartDate: "2025-04-01", openingAsOf: "2026-03-31" })))
      .toEqual({ expected: "2025-03-31", actual: "2026-03-31" });
  });
  it("books start set, no opening balances yet → says which date to enter them as at", () => {
    expect(openingDateMismatch(booksStartOf({ booksStartDate: "2025-04-01" }))).toEqual({ expected: "2025-03-31", actual: null });
  });
  it("no books start set → nothing to compare (the opening date IS the start)", () => {
    expect(openingDateMismatch(booksStartOf({ openingAsOf: "2026-03-31" }))).toBeNull();
    expect(openingDateMismatch(booksStartOf({}))).toBeNull();
  });
});

describe("R-2496 the Balance Sheet's retained-profit range follows the books start", () => {
  it("no opening balances, books from 1 Apr 2025 → profit from 1 Apr 2025, not from the year 2000", () => {
    expect(retainedProfitRange(null, "2026-11-05", reportStart(booksStartOf({ booksStartDate: "2025-04-01" }))))
      .toEqual({ from: "2025-04-01", to: "2026-11-05", open: true });
  });
  it("opening balances as at 31 Mar 2025 → profit after that date", () => {
    expect(retainedProfitRange("2025-03-31", "2026-11-05", "2025-04-01").from).toBe("2025-04-01");
  });
});

/** A fake admin client: rows per table, the filters each read used. */
function fakeDb(tables: Record<string, { data?: unknown[]; error?: { code?: string; message?: string } }>) {
  const filters: Array<[string, string, unknown]> = [];
  const db: BooksStartDb = {
    from(table: string) {
      const res = tables[table] ?? { data: [] };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push([table, k, v]); return q; },
        order: () => q,
        limit: () => q,
        then: (ok: (v: { data: unknown; error: unknown }) => unknown) =>
          Promise.resolve({ data: res.error ? null : res.data ?? [], error: res.error ?? null }).then(ok),
      };
      return q as unknown as ReturnType<BooksStartDb["from"]>;
    },
  };
  return { db, filters };
}

describe("R-2496 readBooksStart — the server read Reconcile from Zoho uses", () => {
  it("reads the setting and the opening date, each filtered to the caller's own company", async () => {
    const { db, filters } = fakeDb({ tenants: { data: [{ books_start_date: "2025-04-01" }] }, opening_balances: { data: [{ as_of: "2026-03-31" }] } });
    const bs = await readBooksStart(db, "t-1");
    expect(bs.start).toBe("2025-04-01");
    expect(filters).toContainEqual(["tenants", "id", "t-1"]);
    expect(filters).toContainEqual(["opening_balances", "tenant_id", "t-1"]);
  });

  it("no setting → opening date + 1 (unchanged for every company that never set it)", async () => {
    const { db } = fakeDb({ tenants: { data: [{ books_start_date: null }] }, opening_balances: { data: [{ as_of: "2026-03-31" }] } });
    expect((await readBooksStart(db, "t-1")).start).toBe("2026-04-01");
  });

  it("a database without the new column (migration not run yet) reads as 'not set'", async () => {
    const { db } = fakeDb({ tenants: { error: { code: "42703", message: "column tenants.books_start_date does not exist" } }, opening_balances: { data: [] } });
    expect(await readBooksStart(db, "t-1")).toMatchObject({ start: null, source: null });
  });

  it("any other failed read throws — a money plan is never made on a guessed start", async () => {
    const { db } = fakeDb({ tenants: { error: { code: "57014", message: "timeout" } } });
    await expect(readBooksStart(db, "t-1")).rejects.toBeInstanceOf(BooksStartReadError);
    const { db: db2 } = fakeDb({ opening_balances: { error: { message: "boom" } } });
    await expect(readBooksStart(db2, "t-1")).rejects.toBeInstanceOf(BooksStartReadError);
  });
});
