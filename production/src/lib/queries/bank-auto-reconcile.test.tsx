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

describe("R-1657 / R-1831 — the final summary names what was left, why, and what to do", () => {
  const S = (o: Partial<Parameters<typeof autoReconcileSummary>[0]>) =>
    autoReconcileSummary({ checked: 0, reconciled: 0, review: 0, no_match: 0, low_confidence: 0, ambiguous: 0, failed: 0, ...o });

  it("matched N, left M with a reason + step for each kind", () => {
    const s = S({ checked: 10, reconciled: 6, review: 4, no_match: 1, low_confidence: 1, ambiguous: 1, failed: 1 });
    expect(s.title).toBe("6 matched · 4 lines left for you");
    expect(s.description).toBe(
      "1 line fits two records equally — open each and pick one. 1 line has only a weak match — open each and confirm it. " +
      "1 line has no payment, expense or salary record in the books yet — add or import those records, then run again. 1 line could not be saved — run again.",
    );
    expect(s.showUnmatched).toBe(true);
  });

  it("R-1831: staging 24 Oct — 1,414 lines, 0 matched, all no-match → a calm, plain reason and a next step", () => {
    const s = S({ checked: 1414, reconciled: 0, review: 1414, no_match: 1414 });
    expect(s.title).toBe("0 matched");
    expect(s.description).toBe(
      "None of these 1,414 lines has a payment, expense or salary record in the books yet. Add or import those records first, then run Auto-reconcile again — or open a line and book it from Reconcile.",
    );
    expect(s.tone).toBe("info");          // calm, not an error
    expect(s.showUnmatched).toBe(true);   // next step: Show unmatched lines
  });

  it("0 matched but some lines need a choice → says which, not 'no record'", () => {
    const s = S({ checked: 5, reconciled: 0, review: 5, no_match: 3, ambiguous: 2 });
    expect(s.title).toBe("0 matched · 5 lines left for you");
    expect(s.description).toMatch(/^2 lines fit two records equally/);
  });

  it("nothing to do / everything matched", () => {
    expect(S({}).title).toBe("Nothing to match — every line is already reconciled");
    expect(S({}).showUnmatched).toBe(false);
    expect(S({ checked: 3, reconciled: 3 }).title).toBe("3 matched — every line is reconciled");
  });
});

describe("R-1831 — the result stays on the page (no vanishing toast)", () => {
  it("a 0-match run shows no toast; the summary is the hook's data for the page panel", async () => {
    h.rpc.mockResolvedValueOnce(chunk({ checked: 1414, review: 1414, no_match: 1414, done: true }));
    const { result } = setup();
    act(() => result.current.mutate("acc-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.info).not.toHaveBeenCalled();
    expect(h.success).not.toHaveBeenCalled();
    expect(autoReconcileSummary(result.current.data!).title).toBe("0 matched");
  });

  it("the panel shows the reason and a 'Show unmatched lines' step", async () => {
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const { AutoReconcileResult } = await import("@/components/features/banking/auto-reconcile-result");
    const onShow = vi.fn();
    render(
      <AutoReconcileResult
        summary={{ checked: 1414, reconciled: 0, review: 1414, no_match: 1414, low_confidence: 0, ambiguous: 0, failed: 0 }}
        unmatchedShown={false} onShowUnmatched={onShow} onClose={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Auto-reconcile: 0 matched");
    expect(screen.getByRole("status").textContent).toContain("Add or import those records first");
    fireEvent.click(screen.getByRole("button", { name: "Show unmatched lines" }));
    expect(onShow).toHaveBeenCalledOnce();
  });
});
