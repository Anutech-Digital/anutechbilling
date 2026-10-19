/**
 * R-1006 — logExport writes one row through log_export(), and never breaks the export.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { countJsonRows, exportKey, logExport, type ExportLogWriter } from "./index";

afterEach(() => vi.restoreAllMocks());

describe("exportKey — same report, same key", () => {
  it.each([
    ["day-book-2026-04-01-to-2026-04-30.csv", "day-book"],
    ["trial-balance-2026-10-19.csv", "trial-balance"],
    ["ECR-202609.txt", "ecr"],
    ["BRS-HDFC-Current-2026-10-19.csv", "brs-hdfc-current"],
    ["GSTR1_07AAACX1234A1Z5_2026-09-01_to_2026-09-30.json", "gstr1-07aaacx1234a1z5"],
    ["customers", "customers"],
    ["Salary-Register-2026-09.csv", "salary-register"],
    ["", "export"],
  ])("%j → %j", (name, key) => {
    expect(exportKey(name)).toBe(key);
  });

  it("keeps the key within the column limit", () => {
    expect(exportKey("x".repeat(500)).length).toBe(200);
  });
});

describe("countJsonRows", () => {
  it("counts records one and two levels down", () => {
    expect(countJsonRows([1, 2, 3])).toBe(3);
    expect(countJsonRows({ customers: [1, 2], meta: { v: 1 } })).toBe(2);
    expect(countJsonRows({ tables: { customers: [1, 2], invoices: [1] } })).toBe(3);
    expect(countJsonRows(null)).toBe(0);
  });
});

describe("logExport", () => {
  it("calls log_export with the key, row count and format — and nothing that names a company", async () => {
    const writer = vi.fn<ExportLogWriter>(async () => ({ error: null }));
    await logExport({ what: "day-book-2026-04-01-to-2026-04-30.csv", rowCount: 12, format: "csv" }, writer);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith({ p_what: "day-book", p_row_count: 12, p_format: "csv" });
    // The database takes the company from the session; the browser must never send one.
    expect(Object.keys(writer.mock.calls[0][0])).not.toContain("p_tenant_id");
  });

  it("clamps a bad row count to a whole, non-negative number", async () => {
    const writer = vi.fn<ExportLogWriter>(async () => ({ error: null }));
    await logExport({ what: "x", rowCount: -3, format: "csv" }, writer);
    await logExport({ what: "x", rowCount: Number.NaN, format: "csv" }, writer);
    await logExport({ what: "x", rowCount: 4.7, format: "csv" }, writer);
    expect(writer.mock.calls.map((c) => c[0].p_row_count)).toEqual([0, 0, 4]);
  });

  it("a database error is a warning, not a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writer: ExportLogWriter = async () => ({ error: { message: "permission denied" } });
    await expect(logExport({ what: "customers", rowCount: 1, format: "csv" }, writer)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
  });

  it("a thrown / rejected writer (network down) never rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writer: ExportLogWriter = () => Promise.reject(new Error("Failed to fetch"));
    await expect(logExport({ what: "customers", rowCount: 1, format: "csv" }, writer)).resolves.toBeUndefined();
    const throwing: ExportLogWriter = () => { throw new Error("boom"); };
    await expect(logExport({ what: "customers", rowCount: 1, format: "csv" }, throwing)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
