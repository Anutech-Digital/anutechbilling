// @vitest-environment jsdom
/* R-2928 — "Remind" on a teammate's task row: the button shows only on someone else's open
   task, one press calls POST /api/tasks/remind and says "Reminder sent", a refusal (already
   reminded in the last hour) is said in the server's own words, and the row shows when the
   owner was last reminded. */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), h.toast) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}) }) }));

import { TaskRow } from "./task-row";
import type { TaskWithLink } from "@/lib/queries/tasks";
import type { TeamMember } from "@/lib/queries/team";

const ME = "u-me", HITESH = "u-hitesh";
const hitesh = { id: HITESH, full_name: "Hitesh", email: "h@example.test", role: "sales" } as unknown as TeamMember;
const task = (over: Partial<TaskWithLink> = {}): TaskWithLink =>
  ({
    id: "t1", title: "Call Amit", kind: "call", status: "pending", due_at: "2026-11-25T05:30:00Z",
    completed_at: null, completed_by: null, snooze_count: 0, notes: null, owner_id: HITESH,
    priority: "medium", progress: "not_started", last_followup_at: null, followup_count: 0,
    lead_id: null, quote_id: null, customer_id: null, subscription_id: null, leads: null, customers: null, quotes: null,
    ...over,
  }) as unknown as TaskWithLink;

function renderRow(t: TaskWithLink, meId: string | null | undefined = ME) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ul><TaskRow task={t} onEdit={() => {}} assignee={hitesh} meId={meId} /></ul>
    </QueryClientProvider>,
  );
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.values(h.toast).forEach((f) => f.mockClear());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const remindButton = () => screen.queryByRole("button", { name: /^Remind Hitesh: Call Amit$/ });

describe("R-2928 Remind on a task row", () => {
  it("a teammate's open task has the button; one press sends the reminder and says so", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, reminded: true, emailed: true }) });
    renderRow(task());
    const btn = remindButton();
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Reminder sent"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/tasks/remind");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ taskId: "t1" });
  });

  it("already reminded in the last hour: the server's reason is shown, not 'sent'", async () => {
    const why = "A reminder was already sent for this task in the last hour — you can remind again after 19 Nov 2026, 5:10 pm.";
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ ok: false, error: why }) });
    renderRow(task());
    fireEvent.click(remindButton()!);
    await waitFor(() => expect(h.toast.warning).toHaveBeenCalledWith(why));
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it("no button on my own task, an unassigned task, a done task, or before we know who is looking", () => {
    renderRow(task({ owner_id: ME }));
    expect(screen.queryByRole("button", { name: /^Remind/ })).toBeNull();
    cleanup();
    renderRow(task({ owner_id: null }));
    expect(screen.queryByRole("button", { name: /^Remind/ })).toBeNull();
    cleanup();
    renderRow(task({ status: "done" }));
    expect(screen.queryByRole("button", { name: /^Remind/ })).toBeNull();
    cleanup();
    renderRow(task(), null);
    expect(screen.queryByRole("button", { name: /^Remind/ })).toBeNull();
  });

  it("the row says when the owner was last reminded (IST); nothing when never", () => {
    renderRow(task({ last_followup_at: "2026-11-18T10:40:00Z" } as Partial<TaskWithLink>));
    expect(screen.getByTestId("task-last-reminded").textContent).toContain("Last reminded 18 Nov, 4:10 pm");
    cleanup();
    renderRow(task());
    expect(screen.queryByTestId("task-last-reminded")).toBeNull();
  });
});
