// @vitest-environment jsdom
/* R-2937 — the one-line (compact) task row and the Comfortable card: the compact row says the
   due in words, keeps the description closed until its name is clicked, and still carries the
   status menu, priority and actions; Comfortable is the earlier card with everything showing. */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}) }) }));

import { TaskRow } from "./task-row";
import type { TaskWithLink } from "@/lib/queries/tasks";
import type { TeamMember } from "@/lib/queries/team";
import type { TaskDensity } from "./task-view-pref";

const NOW = new Date("2026-11-20T12:00:00+05:30");
const HITESH = { id: "u-hitesh", full_name: "Hitesh Kumar", email: "h@example.test", role: "sales", initials: "HK" } as unknown as TeamMember;
const task = (over: Partial<TaskWithLink> = {}): TaskWithLink =>
  ({
    id: "t1", title: "Call Amit", kind: "call", status: "pending", due_at: "2026-11-17T21:25:00+05:30",
    completed_at: null, completed_by: null, snooze_count: 0, notes: "Ask about the renewal quote", owner_id: HITESH.id,
    priority: "high", progress: "not_started", last_followup_at: null, followup_count: 0, link_url: null,
    lead_id: null, quote_id: null, customer_id: "c1", subscription_id: null, leads: null,
    customers: { name: "Acme Traders", contact_name: null, contact_phone: "9876543210", contact_email: null }, quotes: null,
    ...over,
  }) as unknown as TaskWithLink;

function renderRow(t: TaskWithLink, density: TaskDensity = "compact") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ul><TaskRow task={t} onEdit={() => {}} assignee={HITESH} meId="u-me" density={density} now={NOW} /></ul>
    </QueryClientProvider>,
  );
  return screen.getByRole("listitem");
}

afterEach(() => cleanup());

describe("R-2937 the one-line task row (what /tasks shows by default)", () => {
  it("says how late the task is in words", () => {
    const row = renderRow(task());
    expect(row.getAttribute("data-density")).toBe("compact");
    expect(within(row).getByText("Overdue by 3 days")).toBeTruthy();
    // The full date is in the hover text (with the words again, in case they are cut off), not on the line.
    expect(within(row).getByText("Overdue by 3 days").getAttribute("title")).toBe("Overdue by 3 days — Due Tue, 17 Nov 2026, 9:25 pm");
    expect(row.textContent).not.toContain("⚠ Overdue");
  });

  it("due later today reads 'Today 3 pm'", () => {
    const row = renderRow(task({ due_at: "2026-11-20T15:00:00+05:30" }));
    expect(within(row).getByText("Today 3 pm")).toBeTruthy();
  });

  it("carries name, type, whom it is about, assignee, priority, status and the actions", () => {
    const row = renderRow(task());
    const r = within(row);
    expect(r.getByRole("checkbox", { name: "Mark done: Call Amit" })).toBeTruthy();
    expect(r.getByRole("button", { name: "Call Amit" })).toBeTruthy();
    expect(r.getByText("Call")).toBeTruthy(); // the task type, small and grey
    expect(r.getByRole("link", { name: "Acme Traders" }).getAttribute("href")).toBe("/customers/c1");
    expect(r.getByText("Assigned to Hitesh Kumar")).toBeTruthy(); // the avatar's name for a screen reader
    expect(r.getByText("High")).toBeTruthy();
    expect(r.getByRole("button", { name: /^Status: Not started/ })).toBeTruthy();
    for (const name of [/^Remind Hitesh Kumar: Call Amit$/, "Edit task", "Snooze", "Delete"]) {
      expect(r.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("keeps the description and contact closed until the name is clicked", () => {
    const row = renderRow(task());
    const r = within(row);
    const name = r.getByRole("button", { name: "Call Amit" });
    expect(name.getAttribute("aria-expanded")).toBe("false");
    expect(name.getAttribute("title")).toContain("Ask about the renewal quote"); // hover shows it
    expect(r.queryByText("Ask about the renewal quote")).toBeNull();
    expect(r.queryByRole("link", { name: "Call 9876543210" })).toBeNull();

    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("true");
    expect(r.getByText("Ask about the renewal quote")).toBeTruthy();
    expect(r.getByRole("link", { name: "Call 9876543210" })).toBeTruthy();
    expect(r.getByText("Due Tue, 17 Nov 2026, 9:25 pm")).toBeTruthy();
    expect(document.getElementById(name.getAttribute("aria-controls")!)).not.toBeNull();

    fireEvent.click(name);
    expect(r.queryByText("Ask about the renewal quote")).toBeNull();
  });

  it("a done task shows its date, never 'Overdue', and no actions", () => {
    const row = renderRow(task({ status: "done" }));
    expect(within(row).getByText("Tue, 17 Nov")).toBeTruthy();
    expect(row.textContent).not.toContain("Overdue");
    expect(within(row).queryByRole("button", { name: "Edit task" })).toBeNull();
    expect(within(row).getByRole("button", { name: /^Status: Done/ })).toBeTruthy();
  });
});

describe("R-2937 Comfortable — the earlier card", () => {
  it("shows the description, contact and the dated '⚠ Overdue' line straight away", () => {
    const row = renderRow(task(), "comfortable");
    const r = within(row);
    expect(row.getAttribute("data-density")).toBe("comfortable");
    expect(r.getByText("Ask about the renewal quote")).toBeTruthy();
    expect(r.getByRole("link", { name: "Call 9876543210" })).toBeTruthy();
    expect(row.textContent).toContain("⚠ Overdue · ");
    expect(r.queryByText("Overdue by 3 days")).toBeNull();
    expect(r.getByText("Hitesh Kumar")).toBeTruthy(); // the assignee chip with the name
    expect(r.getByRole("button", { name: /^Status: Not started/ })).toBeTruthy();
    expect(r.getByRole("button", { name: "Edit task" })).toBeTruthy();
  });
});

describe("R-2937 a row drawn without a density (the calendar's day list)", () => {
  it("stays the roomy card, as before", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ul><TaskRow task={task()} onEdit={() => {}} assignee={HITESH} /></ul>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("listitem").getAttribute("data-density")).toBe("comfortable");
  });
});
