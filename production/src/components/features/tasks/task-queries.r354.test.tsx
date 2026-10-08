// @vitest-environment jsdom
/* R-354 — /tasks: one click marks a task done at once (optimistic), a failed save puts it
   back with toastError, and the toast's Undo reopens it. The list read is one tenant-scoped
   request set with the lead / customer contact embedded — no per-row lookups. */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  updates: [] as { patch: Record<string, unknown>; id: unknown }[],
  fail: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: h.toastSuccess, error: vi.fn() }) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: h.toastError }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => {
          h.updates.push({ patch, id });
          const res = { data: { id, ...patch }, error: h.fail ? { message: "network down" } : null };
          const p = Promise.resolve(res);
          return Object.assign(p, { select: () => ({ single: () => Promise.resolve(res) }) });
        },
      }),
    }),
  }),
}));

import { useCompleteTask, patchTaskInCache, fetchTaskList, TASK_SELECT, UNDO_TOAST_MS } from "@/lib/queries/tasks";

const LIST_KEY = ["tasks", "list", "t1"];
const row = (id: string, status = "pending") => ({ id, status, completed_at: null, title: id });

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  qc.setQueryData(LIST_KEY, [row("a"), row("b")]);
  qc.setQueryData(["tasks", "count-due-or-overdue"], 2);
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, ...renderHook(() => useCompleteTask(), { wrapper }) };
}
const statusOf = (qc: QueryClient, id: string) =>
  (qc.getQueryData(LIST_KEY) as { id: string; status: string }[]).find((r) => r.id === id)?.status;

beforeEach(() => { h.updates.length = 0; h.fail = false; h.toastSuccess.mockReset(); h.toastError.mockReset(); });
afterEach(() => cleanup());

describe("R-354 one-click done", () => {
  it("marks the row done in the cache before the server answers, then offers a 5-second Undo", async () => {
    const { qc, result } = setup();
    act(() => result.current.mutate("a"));
    await waitFor(() => expect(statusOf(qc, "a")).toBe("done"));
    expect(statusOf(qc, "b")).toBe("pending");
    expect(qc.getQueryData(["tasks", "count-due-or-overdue"])).toBe(2); // non-row cache untouched
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    const [, opts] = h.toastSuccess.mock.calls[0];
    expect(opts.duration).toBe(UNDO_TOAST_MS);
    expect(UNDO_TOAST_MS).toBe(5000);
    expect(opts.action.label).toBe("Undo");
    expect(h.updates[0]).toEqual({ patch: { status: "done" }, id: "a" });

    // Undo → back to pending, completion stamps cleared, optimistically too.
    act(() => opts.action.onClick());
    await waitFor(() => expect(h.updates[1]).toEqual({ patch: { status: "pending", completed_at: null, completed_by: null }, id: "a" }));
    await waitFor(() => expect(statusOf(qc, "a")).toBe("pending"));
  });

  it("a failed save puts the row back and shows toastError", async () => {
    const { qc, result } = setup();
    h.fail = true;
    act(() => result.current.mutate("a"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(statusOf(qc, "a")).toBe("pending");
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });
});

describe("R-354 patchTaskInCache", () => {
  it("patches only the matching row, in lists and single-task entries", () => {
    const list = [row("a"), row("b")];
    expect(patchTaskInCache(list, "b", { status: "done" })).toEqual([row("a"), { ...row("b"), status: "done" }]);
    expect(patchTaskInCache(list, "zz", { status: "done" })).toBe(list);
    expect(patchTaskInCache(row("a"), "a", { status: "done" })).toEqual({ ...row("a"), status: "done" });
    expect(patchTaskInCache(7, "a", { status: "done" })).toBe(7);
    expect(patchTaskInCache(null, "a", { status: "done" })).toBeNull();
  });
});

describe("R-354 fetchTaskList — one tenant-scoped read with the contact embedded", () => {
  it("filters every request by tenant, embeds lead + customer contact, and makes no per-row calls", async () => {
    const calls: { table: string; select?: string; eqs: [string, unknown][] }[] = [];
    const chain = (rec: { table: string; select?: string; eqs: [string, unknown][] }, rows: unknown[]) => {
      const q: Record<string, unknown> = {
        select: (s: string) => { rec.select = s; return q; },
        eq: (c: string, v: unknown) => { rec.eqs.push([c, v]); return q; },
        in: () => q,
        order: () => q,
        range: () => Promise.resolve({ data: rows, error: null }),
        limit: () => Promise.resolve({ data: [row("d1", "done")], error: null }),
      };
      return q;
    };
    const db = {
      from: (table: string) => {
        const rec = { table, eqs: [] as [string, unknown][] };
        calls.push(rec);
        return chain(rec, [row("o1"), row("o2"), row("o3")]);
      },
    };
    const out = await fetchTaskList(db as unknown as Parameters<typeof fetchTaskList>[0], "tenant-1");
    expect(out.map((r) => r.id)).toEqual(["o1", "o2", "o3", "d1"]);
    expect(calls).toHaveLength(2); // open page + done — not one per task
    for (const c of calls) {
      expect(c.table).toBe("tasks");
      expect(c.select).toBe(TASK_SELECT);
      expect(c.eqs).toContainEqual(["tenant_id", "tenant-1"]);
    }
    expect(TASK_SELECT).toMatch(/leads\([^)]*contact_phone[^)]*\)/);
    expect(TASK_SELECT).toMatch(/customers\([^)]*contact_phone[^)]*contact_email[^)]*\)/);
  });
});
