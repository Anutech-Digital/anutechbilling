// @vitest-environment jsdom
/**
 * R-356 — an open Bug Reports page keeps up with the AI.
 * 7 Oct: the AI marked report 54c57022 fixed (/api/agent/feedback-fixed) but the open page
 * kept it under Open with "Run AI Auto-Fix" until a reload. Pinned here:
 *  - when the row turns fixed in the DB, a refetch (tab comes back into view) moves it out
 *    of Open and a toast says where it went;
 *  - the queue polls every 30 s, only while the tab is visible;
 *  - a fixed card shows "Fixed by AI · R-354 · 279cb0d2 · note" and no Auto-Fix button.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, waitFor, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";

type Row = Record<string, unknown> & { id: string; status: string };
const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const toastSuccess = vi.hoisted(() => vi.fn());

/* A tiny PostgREST stand-in: chainable, filters on eq/in, resolves like the real builder. */
function builder(table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  const b = {
    select: () => b,
    order: () => b,
    limit: () => b,
    eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return b; },
    in: (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return b; },
    then: (ok: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: table === "feedback" ? db.rows.filter((r) => filters.every((f) => f(r))) : [], error: null }).then(ok),
  };
  return b;
}

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: builder }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { userId: "u1", fullName: "Pardeep", isPlatformAdmin: false }, isLoading: false }),
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));

import AdminFeedbackPage from "./page";
import { FEEDBACK_REFETCH_MS } from "@/lib/queries/feedback";

const base = (over: Partial<Row>): Row => ({
  id: "54c57022-0000-4000-8000-000000000001",
  title: "Tasks page shows the wrong date",
  problem_summary: "Tasks page shows the wrong date",
  body: "date galat",
  status: "open",
  reported_type: "bug",
  inferred_type: "bug",
  reported_severity: "medium",
  severity_score: 40,
  triage_status: "triaged",
  triage_mode: "stub",
  triage_notes: [],
  target_files: [],
  directive: "Fix it",
  route_pattern: "/tasks",
  page_path: "/tasks",
  reporter_name: "Pardeep",
  filed_via: null,
  created_at: "2026-10-07T05:00:00Z",
  resolved_at: null,
  resolution_note: null,
  checked_at: null,
  checked_by_name: null,
  dispatched_at: null,
  ...over,
});

let qc: QueryClient;
beforeEach(() => {
  db.rows = [base({})];
  toastSuccess.mockClear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); qc.clear(); });

const renderPage = () =>
  render(
    <QueryClientProvider client={qc}>
      <AdminFeedbackPage />
    </QueryClientProvider>,
  );

describe("Bug Reports page stays current (R-356)", () => {
  it("open → fixed in the DB: coming back to the tab moves the card out of Open and says so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    renderPage();
    const card = await screen.findByTestId(`feedback-card-${db.rows[0].id}`);
    expect(within(card).getByRole("button", { name: /Run AI Auto-Fix/ })).toBeTruthy();

    // The AI marks it fixed from outside (what /api/agent/feedback-fixed writes).
    db.rows = [base({
      status: "fixed",
      resolved_at: "2026-10-07T05:47:00Z",
      resolution_note: "AI ne theek kiya: R-354 (279cb0d2) - tasks date sahi. Staging par shaam 5 baje. Tab browser test.",
    })];
    vi.setSystemTime(Date.now() + FEEDBACK_REFETCH_MS + 1_000); // past staleTime
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });

    await waitFor(() => expect(screen.queryByTestId(`feedback-card-${db.rows[0].id}`)).toBeNull());
    expect(screen.queryByRole("button", { name: /Run AI Auto-Fix/ })).toBeNull();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [title, opts] = toastSuccess.mock.calls.at(-1)!;
    expect(title).toBe("Fixed by AI — moved to Fixed");
    expect((opts as { description: string }).description).toContain("R-354 · 279cb0d2");
    focusManager.setFocused(undefined);
  });

  it("polls every 30 s, and not in a background tab", async () => {
    renderPage();
    await screen.findByTestId(`feedback-card-${db.rows[0].id}`);
    // The queue list and the status/count read; the platform list is off for this user, and the
    // R-357 auto-send switch is a setting, not a list, so it does not poll.
    const queries = qc
      .getQueryCache()
      .findAll({ queryKey: ["feedback"] })
      .filter((q) => q.queryKey[1] !== "platform" && q.queryKey[1] !== "auto-send");
    expect(queries.length).toBeGreaterThanOrEqual(2); // list + statuses/counts
    for (const q of queries) {
      for (const o of q.observers) {
        expect(o.options.refetchInterval).toBe(30_000);
        expect(o.options.refetchIntervalInBackground).toBe(false);
      }
    }
  });

  it("a fixed card shows the AI receipt and only fixed-state buttons", async () => {
    db.rows = [base({
      status: "fixed",
      resolved_at: "2026-10-07T05:47:00Z",
      resolution_note: "AI ne theek kiya: R-354 (279cb0d2) - tasks date sahi.",
    })];
    renderPage();
    // Open tab is empty now; the Fixed tab carries it.
    await screen.findByText("Nothing open");
    await act(async () => { screen.getByRole("tab", { name: /Fixed/ }).click(); });
    const strip = await screen.findByTestId("ai-fixed-strip");
    expect(strip.textContent).toContain("Fixed by AI");
    expect(strip.textContent).toContain("R-354");
    expect(strip.textContent).toContain("279cb0d2");
    expect(strip.textContent).toContain("tasks date sahi.");
    expect(within(strip).getByRole("link", { name: /Open the page/ }).getAttribute("href")).toBe("/tasks");
    expect(screen.queryByRole("button", { name: /Run AI Auto-Fix/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Mark fixed$/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Reopen/ })).toBeTruthy();
  });

  it("a queued report says the AI worker has it", async () => {
    db.rows = [base({ status: "agent_queued", dispatched_at: "2026-10-07T05:10:00Z" })];
    renderPage();
    await screen.findByText("Nothing open");
    await act(async () => { screen.getByRole("tab", { name: /Queued for agent/ }).click(); });
    const strip = await screen.findByTestId("ai-queued-strip");
    expect(strip.textContent).toContain("AI worker has it");
  });
});
