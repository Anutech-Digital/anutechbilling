// @vitest-environment jsdom
/**
 * R-2725 (Hitesh, 12 Nov 2026) — the Score column on the Employees table.
 *  1. The number is `usePerformance`'s own row (the Scorecards page's source) — the hook now
 *     says which employee a login is linked to; nothing here computes a score.
 *  2. employee → score map, the "—" case (no linked login), sorting, the scorecard link.
 *  3. The Scorecards page opened with ?user=<login> shows only that person.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  nextScoreSort, scorePeriodNow, scorecardHref, scoresByEmployee, sortEmployeesByScore,
} from "./employee-score";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  reads: [] as string[],
  search: "",
}));

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "order", "eq", "neq", "gte", "lt", "in", "range", "not", "limit"]) chain[m] = () => chain;
  chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
    h.reads.push(table);
    return Promise.resolve({ data: h.tables[table] ?? [], error: null }).then(ok, bad);
  };
  return chain;
}

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: (t: string) => chainFor(t) }) }));
vi.mock("@/lib/queries/team", () => ({
  useTeamMembers: () => ({
    data: [
      { id: "u-asha", full_name: "Asha", role: "sales" },
      { id: "u-ravi", full_name: "Ravi", role: "accountant" },
    ],
    isLoading: false, isError: false, error: null, refetch: () => {},
  }),
  memberLabel: (m: { full_name?: string }) => m.full_name ?? "",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.search),
}));

afterEach(() => {
  cleanup();
  h.tables = {};
  h.reads = [];
  h.search = "";
});

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
};

/** Asha: 2 quotes (10) + 1 deal won (40) = 50. Ravi: nothing = 0. */
function seed() {
  h.tables = {
    users: [{ id: "u-asha", employee_id: "e-asha" }, { id: "u-ravi", employee_id: null }],
    quotes: [{ owner_id: "u-asha", created_at: "2026-11-02" }, { owner_id: "u-asha", created_at: "2026-11-03" }],
    leads: [{ owner_id: "u-asha", value: 1000, stage: "won", updated_at: "2026-11-04" }],
  };
}

describe("usePerformance carries the linked employee (one source for the Score column)", () => {
  it("each row names its employee, with the page's own score", async () => {
    seed();
    const { usePerformance } = await import("@/lib/queries/performance");
    const { result } = renderHook(() => usePerformance("2026-11"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    const rows = result.current.data!;
    expect(rows.map((r) => [r.userId, r.employeeId, r.score])).toEqual([
      ["u-asha", "e-asha", 50],
      ["u-ravi", null, 0],
    ]);
    // The table's number IS that row's number.
    expect(scoresByEmployee(rows).get("e-asha")).toEqual({ userId: "u-asha", score: 50 });
  });

  it("one batched read for the whole table — each input table is read once, whatever the head-count", async () => {
    seed();
    const { usePerformance } = await import("@/lib/queries/performance");
    const { result } = renderHook(() => usePerformance("2026-11"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    const counts = new Map<string, number>();
    for (const t of h.reads) counts.set(t, (counts.get(t) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 1), JSON.stringify([...counts])).toBe(true);
  });

  it("reads nothing when switched off (a role that may not see scores)", async () => {
    seed();
    const { usePerformance } = await import("@/lib/queries/performance");
    const { result } = renderHook(() => usePerformance("2026-11", "month", { enabled: false }), { wrapper: wrap() });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reads).toEqual([]);
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});

describe("employee → score", () => {
  const rows = [
    { userId: "u1", employeeId: "e1", score: 90 },
    { userId: "u2", employeeId: null, score: 70 },
    { userId: "u3", employeeId: "e3", score: 0 },
    { userId: "u4", employeeId: "e1", score: 5 }, // a second login on e1 — the first row wins
  ];

  it("maps only linked logins; no login → no entry (the table shows —)", () => {
    const m = scoresByEmployee(rows);
    expect([...m.entries()]).toEqual([
      ["e1", { userId: "u1", score: 90 }],
      ["e3", { userId: "u3", score: 0 }],
    ]);
    expect(m.has("e2")).toBe(false);
    expect(scoresByEmployee(undefined).size).toBe(0);
  });

  it("a score of 0 is a score, not an empty state", () => {
    expect(scoresByEmployee(rows).get("e3")?.score).toBe(0);
  });

  it("sorts by score with the no-score people last, and leaves the list alone when off", () => {
    const emps = [{ id: "e2" }, { id: "e3" }, { id: "e1" }, { id: "e9" }];
    const m = scoresByEmployee(rows);
    expect(sortEmployeesByScore(emps, m, null).map((e) => e.id)).toEqual(["e2", "e3", "e1", "e9"]);
    expect(sortEmployeesByScore(emps, m, "desc").map((e) => e.id)).toEqual(["e1", "e3", "e2", "e9"]);
    expect(sortEmployeesByScore(emps, m, "asc").map((e) => e.id)).toEqual(["e3", "e1", "e2", "e9"]);
    expect(emps.map((e) => e.id)).toEqual(["e2", "e3", "e1", "e9"]); // not mutated
  });

  it("header click cycles list order → highest → lowest → list order", () => {
    expect(nextScoreSort(null)).toBe("desc");
    expect(nextScoreSort("desc")).toBe("asc");
    expect(nextScoreSort("asc")).toBe(null);
  });

  it("links to that login's scorecard", () => {
    expect(scorecardHref("u-asha")).toBe("/scorecard?user=u-asha");
  });

  it("the period is the IST month (00:30 IST on the 1st is already the new month)", () => {
    expect(scorePeriodNow(new Date("2026-10-31T19:00:00Z"))).toBe("2026-11");
    expect(scorePeriodNow(new Date("2026-10-31T18:00:00Z"))).toBe("2026-10");
  });
});

describe("Scorecards page — ?user=<login> shows that person only", () => {
  it("no ?user → everyone (old links keep working)", async () => {
    seed();
    const Page = (await import("@/app/(app)/scorecard/page")).default;
    render(React.createElement(Page), { wrapper: wrap() });
    await waitFor(() => expect(screen.getByText("Asha")).toBeTruthy());
    expect(screen.getByText("Ravi")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "All scorecards" })).toBeNull();
  });

  it("?user=u-asha → only Asha, her score, and a way back to everyone", async () => {
    seed();
    h.search = "user=u-asha";
    const Page = (await import("@/app/(app)/scorecard/page")).default;
    render(React.createElement(Page), { wrapper: wrap() });
    await waitFor(() => expect(screen.getByText("Asha")).toBeTruthy());
    expect(screen.queryByText("Ravi")).toBeNull();
    expect(screen.getByTestId("scorecard-score-u-asha").textContent).toBe("50");
    expect(screen.getByRole("link", { name: "All scorecards" }).getAttribute("href")).toBe("/scorecard");
  });

  it("?user=<someone who is not on the team> says so, with the way back — not a blank page", async () => {
    seed();
    h.search = "user=u-gone";
    const Page = (await import("@/app/(app)/scorecard/page")).default;
    render(React.createElement(Page), { wrapper: wrap() });
    await waitFor(() => expect(screen.getByText(/No scorecard for this person/)).toBeTruthy());
    expect(screen.queryByText("Asha")).toBeNull();
    expect(screen.getByRole("link", { name: "All scorecards" })).toBeTruthy();
  });
});
