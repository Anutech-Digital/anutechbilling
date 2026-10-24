// @vitest-environment jsdom
/**
 * R-1657 — bank auto-reconcile runs on the server, not as a browser loop.
 *
 * Before: for every unmatched line the browser called suggest_bank_transaction_matches and then
 * reconcile_bank_txn — 2 round trips per line, and closing the tab left the job half done.
 * Now: one auto_reconcile_bank_account call per chunk of 500 lines (migration
 * 20261024001702; the match rule itself is proven unchanged by
 * supabase/tests/r1657_auto_reconcile.test.sql). These tests count the network calls.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), success: vi.fn(), info: vi.fn() }));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: h.success, info: h.info, error: vi.fn() }) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: h.rpc, from: h.from }) }));

import { useAutoReconcile, autoReconcileSummary, AUTO_RECONCILE_CHUNK } from "@/lib/queries/bank";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const chunk = (o: Partial<Record<string, unknown>>) => ({
  data: { checked: 0, reconciled: 0, review: 0, no_match: 0, low_confidence: 0, ambiguous: 0, failed: 0, last_id: null, done: true, ...o },
  error: null,
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useAutoReconcile(), { wrapper });
}

describe("R-1657 — auto-reconcile is one server call per chunk", () => {
  it("an account of 300 unmatched lines = exactly 1 network request, no per-line calls", async () => {
    h.rpc.mockResolvedValueOnce(chunk({ checked: 300, reconciled: 280, review: 20, ambiguous: 12, no_match: 8, last_id: "t300", done: true }));
    const { result } = setup();
    act(() => result.current.mutate("acc-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("auto_reconcile_bank_account", { p_account_id: "acc-1", p_limit: AUTO_RECONCILE_CHUNK });
    expect(h.from).not.toHaveBeenCalled();
    expect(result.current.data).toMatchObject({ checked: 300, reconciled: 280, review: 20 });
  });

  it("1,200 lines = 3 chunked calls, each continuing after the last line, totals added up", async () => {
    h.rpc
      .mockResolvedValueOnce(chunk({ checked: 500, reconciled: 400, review: 100, no_match: 100, last_id: "t500", done: false }))
      .mockResolvedValueOnce(chunk({ checked: 500, reconciled: 450, review: 50, ambiguous: 50, last_id: "t1000", done: false }))
      .mockResolvedValueOnce(chunk({ checked: 200, reconciled: 190, review: 10, failed: 10, last_id: "t1200", done: true }));
    const { result } = setup();
    act(() => result.current.mutate("acc-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.rpc).toHaveBeenCalledTimes(3);
    expect(h.rpc.mock.calls.map((c) => c[1].p_after)).toEqual([undefined, "t500", "t1000"]);
    expect(result.current.data).toMatchObject({ checked: 1200, reconciled: 1040, review: 160, no_match: 100, ambiguous: 50, failed: 10 });
    expect(result.current.progress).toBeNull(); // cleared when the run ends
  });

  it("a server error stops the run and surfaces it (no silent half-done)", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: "Only an owner, manager, accountant or billing user can match bank lines" } });
    const { result } = setup();
    act(() => result.current.mutate("acc-1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("R-1657 — the final summary names what was left and why", () => {
  it("matched N, left M with reasons", () => {
    const s = autoReconcileSummary({ checked: 10, reconciled: 6, review: 4, no_match: 1, low_confidence: 1, ambiguous: 1, failed: 1 });
    expect(s.title).toBe("6 matched · 4 left for you to check");
    expect(s.description).toBe(
      "Left: 1 with two equal matches · 1 with no match · 1 with only a weak match · 1 could not be saved. Open Unmatched to finish them.",
    );
  });

  it("nothing to do / nothing matched", () => {
    expect(autoReconcileSummary({ checked: 0, reconciled: 0, review: 0, no_match: 0, low_confidence: 0, ambiguous: 0, failed: 0 }).title)
      .toBe("All already reconciled");
    expect(autoReconcileSummary({ checked: 2, reconciled: 0, review: 2, no_match: 2, low_confidence: 0, ambiguous: 0, failed: 0 }).title)
      .toBe("No sure match found · 2 left for you to check");
  });
});
