// @vitest-environment jsdom
/* R-2933 — a task row shows who works on it with the owner (small avatars, names for screen
   readers) and the task's link; the "Working with" field lets up to 3 teammates be picked. */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}) }) }));

import { TaskRow } from "./task-row";
import { TaskCollaboratorsField } from "./task-collaborators-field";
import type { TaskWithLink } from "@/lib/queries/tasks";
import type { TeamMember } from "@/lib/queries/team";

const member = (id: string, name: string) =>
  ({ id, full_name: name, email: `${name.toLowerCase()}@example.test`, role: "sales", initials: null, color: null }) as unknown as TeamMember;
const HITESH = member("u-hitesh", "Hitesh"), PAWAN = member("u-pawan", "Pawan"), ABHI = member("u-abhi", "Abhishek"),
  RIYA = member("u-riya", "Riya"), ME = member("u-me", "Pardeep");

const task = (over: Record<string, unknown> = {}): TaskWithLink =>
  ({
    id: "t1", title: "Call Amit", kind: "call", status: "pending", due_at: "2026-11-25T05:30:00Z",
    completed_at: null, completed_by: null, snooze_count: 0, notes: null, owner_id: HITESH.id,
    priority: "medium", progress: "not_started", last_followup_at: null, followup_count: 0, link_url: null,
    lead_id: null, quote_id: null, customer_id: null, subscription_id: null, leads: null, customers: null, quotes: null,
    ...over,
  }) as unknown as TaskWithLink;

function renderRow(t: TaskWithLink, collaborators?: TeamMember[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ul><TaskRow task={t} onEdit={() => {}} assignee={HITESH} meId={ME.id} collaborators={collaborators} /></ul>
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("R-2933 the task row", () => {
  it("names the people working with the owner; nothing when there are none", () => {
    renderRow(task(), [PAWAN, ABHI]);
    const with_ = screen.getByTestId("task-collaborators");
    expect(with_.textContent).toContain("Working with Pawan, Abhishek");
    expect(with_.getAttribute("title")).toBe("Working with Pawan, Abhishek");
    cleanup();
    renderRow(task(), []);
    expect(screen.queryByTestId("task-collaborators")).toBeNull();
    cleanup();
    renderRow(task());
    expect(screen.queryByTestId("task-collaborators")).toBeNull();
  });

  it("opens the task's link in a new tab, named by its site", () => {
    renderRow(task({ link_url: "https://drive.google.com/file/d/abc/view" }));
    const a = screen.getByTestId("task-link");
    expect(a.getAttribute("href")).toBe("https://drive.google.com/file/d/abc/view");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.textContent).toContain("drive.google.com");
  });

  it("no link shown when there is none, or when the saved value is not a web address", () => {
    renderRow(task());
    expect(screen.queryByTestId("task-link")).toBeNull();
    cleanup();
    renderRow(task({ link_url: "javascript:alert(1)" }));
    expect(screen.queryByTestId("task-link")).toBeNull();
  });
});

describe("R-2933 the 'Working with' field", () => {
  function Field({ start = [] as string[] }) {
    const [v, setV] = React.useState<string[]>(start);
    return <TaskCollaboratorsField members={[ME, HITESH, PAWAN, ABHI, RIYA]} ownerId={HITESH.id} value={v} onChange={setV} />;
  }

  it("offers every teammate except the task's owner; a press picks, a second press removes", () => {
    render(<Field />);
    expect(screen.queryByRole("button", { name: "Hitesh" })).toBeNull();
    const pawan = screen.getByRole("button", { name: "Pawan" });
    expect(pawan.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pawan);
    expect(screen.getByRole("button", { name: "Pawan" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Pawan" }));
    expect(screen.getByRole("button", { name: "Pawan" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("after 3 picks the others are disabled and the field says why; removing one frees them", () => {
    render(<Field start={[ME.id, PAWAN.id, ABHI.id]} />);
    const riya = screen.getByRole("button", { name: "Riya" });
    expect(riya).toHaveProperty("disabled", true);
    expect(screen.getByText("3 of 3 picked — remove one to add another.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pawan" }));
    expect(screen.getByRole("button", { name: "Riya" })).toHaveProperty("disabled", false);
  });
});
