// @vitest-environment jsdom
/**
 * R-1655 (23 Oct 2026) — a failed LIST read must be an error, never an empty list.
 *
 * useQuotes() caught every PostgREST error, logged a warning and returned [] — so when quotes
 * failed to load, /quotes said "No quotes yet", the dashboard's quote figures read ₹0 and
 * Payments' "awaiting invoice" list was silently empty, each with no Try again.
 *
 *  1. useQuotes() with a failing PostgREST client ends in isError (not data: []).
 *  2. Ratchet over src/lib/queries: a queryFn that turns an error into `return []` (a catch
 *     block, or `if (error) return [];`) may only stay where it is written on purpose and
 *     documented. The count may only go down.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/supabase/client", () => {
  const failing = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "order", "eq", "range", "in", "limit"]) chain[m] = () => chain;
    chain.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { message: "permission denied for table quotes", code: "42501" } }).then(ok);
    return chain;
  };
  return { createClient: () => ({ from: failing }) };
});

afterEach(() => cleanup());

describe("useQuotes — a failed read is an error (R-1655)", () => {
  it("ends in isError, not an empty list", async () => {
    const { useQuotes } = await import("./quotes");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useQuotes(), { wrapper });
    await waitFor(() => expect(result.current.isError || result.current.isSuccess).toBe(true));
    expect(result.current.isError).toBe(true);
    expect(result.current.data).toBeUndefined();
  });
});

/** Swallowed list errors that are deliberate: file → how many, and why. */
const ALLOWED: Record<string, number> = {
  /* useRecentDepositTags: only pre-selects the usual "Received in" account; a failed read
     means "no history" and the sheet falls back to "Not sure yet" (documented there). */
  "bank.ts": 1,
};

function swallowCount(src: string): number {
  const ifError = src.match(/if\s*\(\s*\w*[eE]rr(?:or)?\s*\)\s*return\s*\[\s*\]\s*;/g)?.length ?? 0;
  const inCatch = src.match(/catch\s*(?:\([^)]*\))?\s*\{[^{}]*?return\s*\[\s*\]\s*;/g)?.length ?? 0;
  return ifError + inCatch;
}

describe("query modules do not turn a failed list read into [] (R-1655 ratchet)", () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

  it("scanner sees the old useQuotes pattern", () => {
    expect(swallowCount(`try { return await x(); } catch (error) {\n console.warn("e", error);\n return [];\n }`)).toBe(1);
    expect(swallowCount(`if (error) return [];`)).toBe(1);
  });

  it.each(files)("%s", (f) => {
    const n = swallowCount(readFileSync(join(dir, f), "utf8"));
    expect(n, `${f}: a failed read must throw so the page shows an error + Try again (CLAUDE.md §24)`).toBeLessThanOrEqual(ALLOWED[f] ?? 0);
  });
});
