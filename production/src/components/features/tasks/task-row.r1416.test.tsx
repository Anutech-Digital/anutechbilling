// @vitest-environment jsdom
/* R-1416 — Pawan (staging, 12 Oct): a task in Done could not be un-completed. Its circle was
   disabled. Now the ticked circle is a real checkbox that reopens the task (status back to
   pending, completion stamps cleared) — by click or keyboard. */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  updates: [] as { patch: Record<string, unknown>; id: unknown }[],
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => {
          h.updates.push({ patch, id });
          const res = { data: { id, ...patch }, error: null };
          return Object.assign(Promise.resolve(res), { select: () => ({ single: () => Promise.resolve(res) }) });
        },
      }),
    }),
  }),
}));

import { TaskRow } from "./task-row";
import type { TaskWithLink } from "@/lib/queries/tasks";

const task = (status: "pending" | "done"): TaskWithLink =>
  ({
    id: "t1", title: "Call Amit", kind: "call", status, due_at: "2026-10-10T05:30:00Z",
    completed_at: status === "done" ? "2026-10-10T06:00:00Z" : null, completed_by: null,
    snooze_count: 0, notes: null, owner_id: null, lead_id: null, quote_id: null,
    customer_id: null, subscription_id: null, leads: null, customers: null, quotes: null,
  }) as unknown as TaskWithLink;

function renderRow(status: "pending" | "done") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ul><TaskRow task={task(status)} onEdit={() => {}} /></ul>
    </QueryClientProvider>,
  );
}

beforeEach(() => { h.updates.length = 0; });
afterEach(() => cleanup());

describe("R-1416 un-complete a Done task", () => {
  it("the Done row's circle is an enabled, checked checkbox that reopens the task", async () => {
    renderRow("done");
    const box = screen.getByRole("checkbox", { name: /mark not done: call amit/i });
    expect(box).toHaveProperty("disabled", false);
    expect(box.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(box);
    await waitFor(() => expect(h.updates).toHaveLength(1));
    expect(h.updates[0]).toEqual({ id: "t1", patch: { status: "pending", completed_at: null, completed_by: null } });
  });

  it("an open row's circle still marks the task done", async () => {
    renderRow("pending");
    const box = screen.getByRole("checkbox", { name: /mark done: call amit/i });
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box);
    await waitFor(() => expect(h.updates).toHaveLength(1));
    expect(h.updates[0].patch).toEqual({ status: "done" });
  });
});
