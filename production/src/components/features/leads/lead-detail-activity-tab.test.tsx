// @vitest-environment jsdom
//
// R-341 (7 Oct 2026, Pardeep on lead L-MUWVLYIU's Activity tab): "ye clickable hone chahiye
// aur related document open kare click par". The href rules are in lib/leads/timeline.test.ts;
// this checks what the operator gets: the whole row is a real link (keyboard + screen reader
// reach it by its text), and rows with no page of their own are not links.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LeadActivityTab, type LeadActivityTabProps } from "./lead-detail-activity-tab";
import { buildTimeline } from "@/lib/leads/timeline";

afterEach(cleanup);

const timeline = buildTimeline({
  activities: [{ id: "a1", kind: "email", detail: "Sent pricing", created_at: "2026-10-01T10:00:00Z" }],
  quotes: [{ id: "Q-FBB9-27-0009", status: "accepted", amount: 50_000, created_at: "2026-10-02T09:00:00Z" }],
  tasks: [{ id: "t-1", title: "Call back", status: "pending", created_at: "2026-10-03T08:00:00Z" }],
});

function renderTab() {
  const props = {
    lead: { id: "L-1", company: "Acme", contact_phone: null },
    noteDraft: "", setNoteDraft: () => {},
    logActivity: { mutate: () => {} },
    callLog: { run: () => {}, dialog: null },
    runOutcome: async () => {},
    timeline,
  } as unknown as LeadActivityTabProps;
  return render(<LeadActivityTab {...props} />);
}

describe("LeadActivityTab — rows open their record (R-341)", () => {
  it("the quote row is one link to that quote, named by its text", () => {
    renderTab();
    const link = screen.getByRole("link", { name: /Quote accepted/ });
    expect(link.getAttribute("href")).toBe("/quotes/Q-FBB9-27-0009");
    expect(link.textContent).toContain("Q-FBB9-27-0009");
  });

  it("the task row opens the tasks page on that task", () => {
    renderTab();
    expect(screen.getByRole("link", { name: /Task — Call back/ }).getAttribute("href"))
      .toBe("/tasks?tab=all&task=t-1");
  });

  it("an email activity has no page of its own, so it is plain text, not a link", () => {
    renderTab();
    expect(screen.getByText("Email sent").closest("a")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("linked rows show a focus ring (keyboard users see where they are)", () => {
    renderTab();
    for (const a of screen.getAllByRole("link")) expect(a.className).toContain("focus-visible:ring-2");
  });
});
