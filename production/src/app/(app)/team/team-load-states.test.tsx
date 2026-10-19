// @vitest-environment jsdom
/**
 * R-1533 — the Team page has three states, never two.
 * Before: both queries defaulted to `[]` and the page never read isLoading / isError, so a
 * failed load showed "Members 0" and an empty table — the owner reads "my whole team is
 * gone". Pinned here: loading shows a skeleton (no 0), a failed load says so with Try again
 * (no 0, no raw database text), and only a SUCCESSFUL empty load shows zero.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Result = { data: unknown; error: unknown };
const db = vi.hoisted(() => ({
  users: null as null | (() => Promise<{ data: unknown; error: unknown }>),
}));

function builder(table: string) {
  const b = {
    select: () => b, order: () => b, is: () => b, eq: () => b, limit: () => b,
    then: (ok: (v: Result) => unknown, bad?: (e: unknown) => unknown) => {
      const p: Promise<Result> = table === "users" && db.users ? db.users() : Promise.resolve({ data: [], error: null });
      return p.then(ok, bad);
    },
  };
  return b;
}

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: builder }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { userId: "u1", role: "owner", tenantId: "t1" }, isLoading: false }),
}));
vi.mock("@/components/features/team/pending-join-requests-card", () => ({ PendingJoinRequestsCard: () => null }));
vi.mock("@/components/features/team/claim-colleague-card", () => ({ ClaimColleagueCard: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import TeamPage from "./page";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TeamPage /></QueryClientProvider>);
}

/** The big number under the "Members" KPI label. */
function membersKpi(): string {
  const label = screen.getByText("Members");
  return (label.closest("div")?.parentElement?.textContent ?? "").replace("Members", "");
}

beforeEach(() => { db.users = null; vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Team page — loading / error / empty are different (R-1533)", () => {
  it("while loading: a skeleton, and the member count is not 0", () => {
    db.users = () => new Promise(() => {});
    renderPage();
    expect(screen.getByTestId("team-loading")).toBeTruthy();
    expect(membersKpi()).not.toMatch(/\b0\b/);
  });

  it("a failed load says so, offers Try again, never shows 0 or raw database text", async () => {
    let calls = 0;
    db.users = () => {
      calls += 1;
      return Promise.resolve({ data: null, error: { message: 'permission denied for table users', code: "42501" } });
    };
    renderPage();
    await screen.findByText(/didn.t load/i);
    expect(screen.queryByText(/permission denied for table/)).toBeNull();
    expect(membersKpi()).not.toMatch(/\b0\b/);
    const before = calls;
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });

  it("a successful load with members shows them", async () => {
    db.users = () => Promise.resolve({
      data: [{ id: "u1", full_name: "Pardeep", email: "p@x.in", role: "owner", initials: "P", color: null, is_active: true, can_view_deals: true, manager_id: null, gets_new_leads: true }],
      error: null,
    });
    renderPage();
    await waitFor(() => expect(membersKpi()).toMatch(/1/));
    expect(screen.queryByText(/didn.t load/i)).toBeNull();
    expect(screen.queryByTestId("team-loading")).toBeNull();
  });
});
