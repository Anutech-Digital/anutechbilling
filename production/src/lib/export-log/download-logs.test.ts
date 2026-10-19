/**
 * R-1006 — the shared download paths call logExport: lib/csv downloadCSV (used by most export
 * buttons) and lib/reports/print printReport (the PDF of a report). And the file still
 * downloads when the log write fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logExport = vi.fn(async () => {});
vi.mock("@/lib/export-log", () => ({ logExport }));

const { downloadCSV } = await import("@/lib/csv");
const { printReport } = await import("@/lib/reports/print");

let clicked: string[] = [];

beforeEach(() => {
  clicked = [];
  logExport.mockClear();
  const anchor = { href: "", download: "", click() { clicked.push(this.download); } };
  vi.stubGlobal("document", {
    title: "ResellerOS",
    createElement: () => anchor,
    body: { appendChild: () => {}, removeChild: () => {} },
  });
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
  vi.stubGlobal("window", { print: vi.fn(), addEventListener: () => {}, removeEventListener: () => {}, setTimeout: () => 0 });
});

afterEach(() => vi.unstubAllGlobals());

describe("downloadCSV (lib/csv) logs every export", () => {
  it("downloads the file and logs name, data-row count and csv", () => {
    downloadCSV("customers-2026-10-19.csv", ["Name"], [["A"], ["B"], ["C"]]);
    expect(clicked).toEqual(["customers-2026-10-19.csv"]);
    expect(logExport).toHaveBeenCalledWith({ what: "customers-2026-10-19.csv", rowCount: 3, format: "csv" });
  });

  it("still downloads when the log write fails", () => {
    logExport.mockImplementationOnce(() => Promise.reject(new Error("down")).catch(() => {}));
    downloadCSV("leads.csv", ["Name"], [["A"]]);
    expect(clicked).toEqual(["leads.csv"]);
  });
});

describe("printReport (report → PDF) logs the export", () => {
  it("logs the report title as a pdf export", () => {
    printReport("saas-metrics-2026-10-19", 14);
    expect(logExport).toHaveBeenCalledWith({ what: "saas-metrics-2026-10-19", rowCount: 14, format: "pdf" });
  });
});
