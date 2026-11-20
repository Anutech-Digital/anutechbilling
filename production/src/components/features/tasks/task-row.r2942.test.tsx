// @vitest-environment jsdom
/* R-2942 — on a 1280 px screen the one-line task row cut names short ("Set up seats (DNS, users)
   · T…": 212 px for a name that needs 254) while the type word ("Task", "Follow-up") sat beside
   it and the due column kept 17 px it never used. From 1280 to 1535 px the type word leaves the
   line — the icon carries it (hover text; still read out by a screen reader) — and the due
   column is as wide as its longest words. jsdom has no layout, so this pins the classes; the
   real widths are measured by the card test (e2e/cards/R-2942.spec.ts). */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}) }) }));

import { TaskRow } from "./task-row";
import type { TaskWithLink } from "@/lib/queries/tasks";
import type { TaskDensity } from "./task-view-pref";

const NOW = new Date("2026-11-20T12:00:00+05:30");
const task = (over: Partial<TaskWithLink> = {}): TaskWithLink =>
  ({
    id: "t1", title: "Set up seats (DNS, users) · T-L6-19Oct", kind: "followup", status: "pending", due_at: "2026-11-17T21:25:00+05:30",
    completed_at: null, completed_by: null, snooze_count: 0, notes: null, owner_id: null,
    priority: "medium", progress: "not_started", last_followup_at: null, followup_count: 0, link_url: null,
    lead_id: null, quote_id: null, customer_id: null, subscription_id: null, leads: null, customers: null, quotes: null,
    ...over,
  }) as unknown as TaskWithLink;

function renderRow(t: TaskWithLink, density: TaskDensity = "compact") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ul><TaskRow task={t} onEdit={() => {}} assignee={null} meId="u-me" density={density} now={NOW} /></ul>
    </QueryClientProvider>,
  );
  return screen.getByRole("listitem");
}
const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

afterEach(() => cleanup());

describe("R-2942 the one-line row gives the name the spare room at 1280", () => {
  it("the type word leaves the line from 1280 px (back from 1536 px) but is still read out", () => {
    const row = renderRow(task());
    const word = within(row).getByText("Follow-up");
    expect(classes(word)).toEqual(expect.arrayContaining(["xl:sr-only", "2xl:not-sr-only"]));
    // Not removed from the page: a phone (the wrapped layout) and a screen reader still get it.
    expect(classes(word)).not.toContain("hidden");
  });

  it("the type icon says the type on hover, so nothing is lost with the word off the line", () => {
    const row = renderRow(task({ kind: "meeting" }));
    expect(within(row).getByTitle("Meeting").textContent).toBe("📅");
  });

  it("the name keeps its full text on hover and is the part that shrinks", () => {
    const row = renderRow(task());
    const name = within(row).getByRole("button", { name: "Set up seats (DNS, users) · T-L6-19Oct" });
    expect(name.getAttribute("title")).toBe("Set up seats (DNS, users) · T-L6-19Oct");
    expect(classes(name)).toEqual(expect.arrayContaining(["truncate", "min-w-0"]));
  });

  it("a click on a cut name shows ALL of it (wrapped under the line), a second click folds it back", () => {
    const row = renderRow(task());
    const name = within(row).getByRole("button", { name: "Set up seats (DNS, users) · T-L6-19Oct" });
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("true");
    expect(classes(name)).not.toContain("truncate");
    expect(classes(name)).toEqual(expect.arrayContaining(["whitespace-normal", "break-words"]));
    fireEvent.click(name);
    expect(classes(name)).toContain("truncate");
  });

  it("the columns sit a little closer at 1280 (6px, not 8px) — 14px more for the name", () => {
    const row = renderRow(task());
    expect(classes(row.firstElementChild!)).toEqual(expect.arrayContaining(["gap-x-2", "xl:gap-x-1.5"]));
  });

  it("the due column is 124 px at 1280 — room for 'Overdue by 120 days', no more", () => {
    const row = renderRow(task());
    const due = within(row).getByText("Overdue by 3 days");
    expect(classes(due)).toContain("xl:w-[124px]");
    expect(classes(due)).not.toContain("xl:w-[132px]");
    expect(due.getAttribute("title")).toContain("Overdue by 3 days");
  });

  it("Comfortable is untouched: the type word shows as before", () => {
    const row = renderRow(task(), "comfortable");
    expect(row.getAttribute("data-density")).toBe("comfortable");
    expect([...row.querySelectorAll("*")].some((el) => classes(el).includes("xl:sr-only"))).toBe(false);
  });
});
