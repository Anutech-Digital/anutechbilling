// @vitest-environment jsdom
/**
 * R-2364 — "Suggested matches" is read fresh each time a bank line is opened.
 *
 * 4 Nov Chrome (scenario zero-ref-credits): line 2 offered the receipt line 1 had just used. The
 * server now leaves such receipts out (migration 20261104060346, supabase/tests/
 * r2364_suggestions_skip_used.test.sql) — but the sheet cached each line's suggestions for 60 s,
 * so a line opened before line 1 was booked showed the old list again when reopened. Now the
 * suggestions are refetched when the sheet opens the line again.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: h.rpc }) }));

import { useSuggestMatches } from "@/lib/queries/bank";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const P1 = { match_type: "payment", match_id: "p1", match_label: "SCN Zero Ref Traders · BANK-line-1", match_amount: 5000, match_date: "2026-10-10", match_confidence: "high" };

describe("R-2364 — suggestions are never served from a stale cache", () => {
  it("reopening line 2 after line 1 was booked asks the server again and shows its new answer", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

    h.rpc.mockResolvedValueOnce({ data: [P1], error: null });
    const first = renderHook(() => useSuggestMatches("line-2"), { wrapper });
    await waitFor(() => expect(first.result.current.data).toEqual([P1]));
    first.unmount();

    // Line 1 is booked to P1 meanwhile; the server no longer offers P1 for line 2.
    h.rpc.mockResolvedValueOnce({ data: [], error: null });
    const again = renderHook(() => useSuggestMatches("line-2"), { wrapper });
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
    expect(h.rpc).toHaveBeenLastCalledWith("suggest_bank_transaction_matches", { p_bank_txn_id: "line-2" });
    await waitFor(() => expect(again.result.current.data).toEqual([]));
  });
});
