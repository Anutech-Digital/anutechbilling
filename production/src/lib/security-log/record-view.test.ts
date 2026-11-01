// @vitest-environment jsdom
/**
 * R-2350 (G-DPDP): opening a customer's or a lead's detail records one access-log row.
 *   - one call per detail open, with the record type + id (company and user come from the
 *     session in log_record_view(), never from here);
 *   - the same record again within 10 minutes sends nothing (the database also debounces);
 *   - a failed write never throws — the screen still opens;
 *   - the customer profile and the lead drawer both call it; the list pages do not.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHook } from "@testing-library/react";
import { logRecordView, resetRecordViewMemory, useRecordView, RECORD_VIEW_WINDOW_MS, type RecordViewWriter } from "./record-view";

beforeEach(() => resetRecordViewMemory());

const okWriter = () => vi.fn<RecordViewWriter>(async () => ({ error: null }));

describe("logRecordView", () => {
  it("sends one call per open with the record type and id", async () => {
    const w = okWriter();
    expect(await logRecordView("customer", "c-1", w, 1_000)).toBe(true);
    expect(w).toHaveBeenCalledTimes(1);
    expect(w).toHaveBeenCalledWith({ p_record_type: "customer", p_record_id: "c-1" });
  });

  it("does not send the same record again within 10 minutes, and does after", async () => {
    const w = okWriter();
    await logRecordView("lead", "L-1", w, 0);
    expect(await logRecordView("lead", "L-1", w, RECORD_VIEW_WINDOW_MS - 1)).toBe(false);
    expect(w).toHaveBeenCalledTimes(1);
    expect(await logRecordView("lead", "L-1", w, RECORD_VIEW_WINDOW_MS)).toBe(true);
    expect(w).toHaveBeenCalledTimes(2);
  });

  it("a different record (or type) is its own call", async () => {
    const w = okWriter();
    await logRecordView("lead", "L-1", w, 0);
    await logRecordView("lead", "L-2", w, 0);
    await logRecordView("customer", "L-1", w, 0);
    expect(w).toHaveBeenCalledTimes(3);
  });

  it("sends nothing without an id", async () => {
    const w = okWriter();
    expect(await logRecordView("customer", null, w)).toBe(false);
    expect(await logRecordView("customer", "  ", w)).toBe(false);
    expect(w).not.toHaveBeenCalled();
  });

  it("never throws: an error result or a rejected call is only a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(logRecordView("customer", "c-1", async () => ({ error: { message: "denied" } }))).resolves.toBe(true);
    await expect(logRecordView("customer", "c-2", async () => { throw new Error("offline"); })).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("useRecordView", () => {
  it("logs once when a record opens, again for another record, not on re-render", () => {
    const w = okWriter();
    const { rerender } = renderHook(({ id }) => useRecordView("customer", id, w), { initialProps: { id: null as string | null } });
    expect(w).not.toHaveBeenCalled();
    rerender({ id: "c-1" });
    rerender({ id: "c-1" });
    expect(w).toHaveBeenCalledTimes(1);
    rerender({ id: "c-2" });
    expect(w).toHaveBeenCalledTimes(2);
  });
});

describe("wiring — detail opens log, lists do not", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC = join(HERE, "..", "..");
  const read = (p: string) => readFileSync(join(SRC, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("the customer profile (page + /customers side pane) logs the customer it shows", () => {
    expect(read("components/features/customers/customer-profile.tsx")).toMatch(/useRecordView\(\s*"customer"\s*,\s*customer \? params\.id : null\s*\)/);
  });

  it("the lead drawer logs the lead it shows", () => {
    expect(read("components/features/leads/lead-detail-sheet.tsx")).toMatch(/useRecordView\(\s*"lead"\s*,\s*lead\?\.id \?\? null\s*\)/);
  });

  it("the list pages make no access-log call (no extra request per list render)", () => {
    for (const p of ["app/(app)/customers/page.tsx", "app/(app)/leads/page.tsx"]) {
      expect(read(p)).not.toMatch(/useRecordView|log_record_view/);
    }
  });
});
