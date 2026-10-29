// @vitest-environment jsdom
/* R-2056 — the one client helper for "rate fills itself, stays editable":
   Add bill uses it now; quotes / invoices can use the same hook later.
   fetch is mocked — no network. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useAutoFxRate, fxAutoReducer, FX_AUTO_START } from "./use-auto-fx-rate";
import type { FxRate } from "./rate-source";

const rateFor = (date: string): FxRate => ({
  rate: date === "2026-10-21" ? 94.7145 : 94.94, from: "USD", to: "INR", asOf: date,
  source: "fbil", kind: "reference", label: "FBIL reference rate (RBI)",
});
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    const date = new URL(url, "http://x").searchParams.get("date") ?? "2026-10-28";
    if (date === "2026-01-01") return { ok: false, status: 502, json: async () => ({ error: "down" }) };
    return { ok: true, status: 200, json: async () => rateFor(date) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("fxAutoReducer", () => {
  it("a fetched rate fills an untouched box; a typed rate is never overwritten", () => {
    let s = fxAutoReducer(FX_AUTO_START, { type: "fetched", rate: rateFor("2026-10-21") });
    expect(s.value).toBe("94.7145");
    expect(s.auto?.source).toBe("fbil");
    s = fxAutoReducer(s, { type: "typed", value: "95" });
    expect(s).toMatchObject({ value: "95", typed: true, auto: null });
    s = fxAutoReducer(s, { type: "fetched", rate: rateFor("2026-10-25") });
    expect(s.value).toBe("95");
  });
  it("reset (new bill read / currency) clears the typed flag so the next rate fills", () => {
    let s = fxAutoReducer(FX_AUTO_START, { type: "typed", value: "95" });
    s = fxAutoReducer(s, { type: "reset" });
    expect(s).toMatchObject({ value: "", typed: false, auto: null, failed: false });
  });
  it("a failed fetch leaves a typed or auto value alone, only flags failed on an empty box", () => {
    expect(fxAutoReducer(FX_AUTO_START, { type: "failed" })).toMatchObject({ value: "", failed: true });
    const typed = fxAutoReducer(FX_AUTO_START, { type: "typed", value: "95" });
    expect(fxAutoReducer(typed, { type: "failed" })).toMatchObject({ value: "95", failed: false });
  });
});

describe("useAutoFxRate", () => {
  it("foreign currency → fetches the bill date's rate and fills the box", async () => {
    const { result } = renderHook(() => useAutoFxRate("USD", "2026-10-21"));
    await waitFor(() => expect(result.current.value).toBe("94.7145"));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/fx/latest?from=USD&date=2026-10-21");
    expect(result.current.hint).toMatch(/^₹94\.7145 · FBIL\/RBI reference rate, 21 Oct 2026/);
  });

  it("INR → no fetch, nothing to fill", async () => {
    const { result } = renderHook(() => useAutoFxRate("INR", "2026-10-21"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.value).toBe("");
  });

  it("bill date changes → new rate; but a rate the user typed stays", async () => {
    const { result, rerender } = renderHook(({ d }) => useAutoFxRate("USD", d), { initialProps: { d: "2026-10-21" } });
    await waitFor(() => expect(result.current.value).toBe("94.7145"));
    rerender({ d: "2026-10-25" });
    await waitFor(() => expect(result.current.value).toBe("94.94"));
    act(() => result.current.setTyped("96.10"));
    rerender({ d: "2026-10-21" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(result.current.value).toBe("96.10");
    expect(result.current.hint).toBeNull();
  });

  it("no rate available → box stays empty, failed = true", async () => {
    const { result } = renderHook(() => useAutoFxRate("USD", "2026-01-01"));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.value).toBe("");
  });

  it("a half-typed date (not YYYY-MM-DD) does not fetch", async () => {
    renderHook(() => useAutoFxRate("USD", "2026-1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
