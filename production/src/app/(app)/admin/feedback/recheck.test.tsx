// @vitest-environment jsdom
/**
 * R-393 — Pardeep 7 Oct: "Re-triage ka kya kaam hai". Triage runs on its own, so the button
 * left the action row and lives in Details as "Re-check type & score", with a one-line hint.
 * Pinned: not in the row, present once Details is open, and it still calls the same
 * useTriageFeedback mutation (POST /api/feedback/triage with this report's id).
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));

import AdminFeedbackPage from "./page";
import { RECHECK_HINT } from "./recheck";

const ID = "54c57022-0000-4000-8000-000000000009";
const row = (over: Record<string, unknown> = {}) => ({
  id: ID, title: "Tasks date wrong", problem_summary: "Tasks date wrong", body: "date galat",
  status: "open", reported_type: "bug", inferred_type: "bug", reported_severity: "medium",
  severity_score: 40, triage_status: "triaged", triage_mode: "stub", triage_notes: [],
  target_files: [], directive: "Fix it", route_pattern: "/tasks", page_path: "/tasks",
  reporter_name: "Pardeep", filed_via: null, created_at: "2026-10-07T05:00:00Z",
  resolved_at: null, resolution_note: null, checked_at: null, checked_by_name: null,
  dispatched_at: null, ...over,
});

let qc: QueryClient;
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ mode: "stub" }), { status: 200 }));
beforeEach(() => {
  db.rows = [row()];
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); qc.clear(); vi.unstubAllGlobals(); });

const renderPage = () =>
  render(<QueryClientProvider client={qc}><AdminFeedbackPage /></QueryClientProvider>);

describe("Re-check type & score lives in Details (R-393)", () => {
  it("the action row has no Re-triage / Triage button", async () => {
    renderPage();
    const card = await screen.findByTestId(`feedback-card-${ID}`);
    expect(within(card).queryByRole("button", { name: /triage/i })).toBeNull();
    expect(within(card).queryByRole("button", { name: /Re-check type & score/ })).toBeNull();
    expect(within(card).getByRole("button", { name: /Run AI Auto-Fix/ })).toBeTruthy();
  });

  it("Details shows the item with its hint, and it calls the same triage mutation", async () => {
    renderPage();
    const card = await screen.findByTestId(`feedback-card-${ID}`);
    fireEvent.click(within(card).getByRole("button", { name: /Details/ }));
    const item = within(card).getByTestId("recheck-type-score");
    expect(item.textContent).toContain(RECHECK_HINT);
    fireEvent.click(within(item).getByRole("button", { name: "Re-check type & score" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/feedback/triage", expect.objectContaining({ method: "POST" })));
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const init = calls.find(([url]) => url === "/api/feedback/triage")![1];
    expect(JSON.parse(init.body as string)).toEqual({ feedbackId: ID });
  });

  it("the help line under the buttons no longer mentions Re-triage", async () => {
    renderPage();
    const card = await screen.findByTestId(`feedback-card-${ID}`);
    expect(card.textContent).not.toMatch(/Re-triage/);
  });
});
