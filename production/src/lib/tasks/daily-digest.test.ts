/**
 * R-2929 — the morning task digest: who gets what, and what the message says.
 */
import { describe, it, expect } from "vitest";
import { TASK_OPEN_STATUSES } from "@/lib/queries/tasks";
import {
  TASK_CLOSED_STATUSES, closedStatusFilter, planTaskDigests, renderPersonalDigest, renderOwnerSummary,
  digestWhatsAppValues, type DigestPerson, type DigestTask,
} from "./daily-digest";

const TODAY = "2026-11-18";
/* IST day 18 Nov 2026 = 2026-11-17T18:30Z … 2026-11-18T18:30Z */
const task = (id: string, owner: string | null, due_at: string, title = `Task ${id}`): DigestTask =>
  ({ id, owner_id: owner, due_at, title });
const person = (id: string, over: Partial<DigestPerson> = {}): DigestPerson => ({
  id, name: `Person ${id}`, email: `${id}@example.invalid`, phone: null, role: "sales", isActive: true, ...over,
});

const OWNER = person("own", { name: "Asha Owner", role: "owner" });
const RAVI = person("ravi", { name: "Ravi Kumar" });
const MEENA = person("meena", { name: "Meena Shah" });

describe("which statuses are open", () => {
  it("no open status (lib/queries/tasks TASK_OPEN_STATUSES) is on the closed list", () => {
    /* The cron reads "everything not closed", so a new open status (in progress, on hold) is in
       the digest the day it is added to TASK_OPEN_STATUSES — nothing to change here. */
    expect(TASK_OPEN_STATUSES.filter((s) => (TASK_CLOSED_STATUSES as readonly string[]).includes(s))).toEqual([]);
  });
  it("the PostgREST filter is built from the list", () => {
    expect(closedStatusFilter()).toBe(`(${TASK_CLOSED_STATUSES.join(",")})`);
  });
});

describe("planTaskDigests", () => {
  it("splits a person's tasks into overdue and due today by the IST day; later tasks are left out", () => {
    const plan = planTaskDigests({
      today: TODAY,
      people: [OWNER, RAVI],
      tasks: [
        task("a", "ravi", "2026-11-15T06:00:00Z", "Call Sharma ji"),
        task("b", "ravi", "2026-11-17T18:29:00Z", "Send quote"),          // 17 Nov 23:59 IST → overdue
        task("c", "ravi", "2026-11-17T18:30:00Z", "Follow up with Mehta"), // 18 Nov 00:00 IST → today
        task("d", "ravi", "2026-11-18T18:30:00Z", "Tomorrow's task"),      // 19 Nov 00:00 IST → not in
      ],
    });
    expect(plan.personal).toHaveLength(1);
    expect(plan.personal[0].person.id).toBe("ravi");
    expect(plan.personal[0].overdue.map((t) => t.title)).toEqual(["Call Sharma ji", "Send quote"]);
    expect(plan.personal[0].today.map((t) => t.title)).toEqual(["Follow up with Mehta"]);
  });

  it("a person with nothing overdue or due today gets nothing", () => {
    const plan = planTaskDigests({
      today: TODAY, people: [OWNER, RAVI, MEENA],
      tasks: [task("a", "ravi", "2026-11-15T06:00:00Z"), task("z", "meena", "2026-11-25T06:00:00Z")],
    });
    expect(plan.personal.map((p) => p.person.id)).toEqual(["ravi"]);
  });

  it("nobody has anything → no digests and no owner summary", () => {
    const plan = planTaskDigests({ today: TODAY, people: [OWNER, RAVI], tasks: [task("z", "ravi", "2026-11-25T06:00:00Z")] });
    expect(plan.personal).toEqual([]);
    expect(plan.ownerSummaries).toEqual([]);
  });

  it("the owner gets ONE message: the team summary with their own tasks inside, not a second personal mail", () => {
    const plan = planTaskDigests({
      today: TODAY, people: [OWNER, RAVI, MEENA],
      tasks: [
        task("a", "ravi", "2026-11-15T06:00:00Z"), task("b", "ravi", "2026-11-18T06:00:00Z"),
        task("c", "meena", "2026-11-16T06:00:00Z"),
        task("d", "own", "2026-11-18T05:00:00Z", "Sign the lease"),
        task("e", null, "2026-11-10T05:00:00Z"),
      ],
    });
    expect(plan.personal.map((p) => p.person.id).sort()).toEqual(["meena", "ravi"]);
    expect(plan.ownerSummaries).toHaveLength(1);
    const s = plan.ownerSummaries[0];
    expect(s.person.id).toBe("own");
    expect(s.today.map((t) => t.title)).toEqual(["Sign the lease"]);
    expect(s.totals).toEqual({ overdue: 3, today: 2 });
    /* Most overdue first; the owner's own line is not repeated in the team list. */
    expect(s.team).toEqual([
      { name: "Ravi Kumar", overdue: 1, today: 1 },
      { name: "Meena Shah", overdue: 1, today: 0 },
      { name: "Not assigned", overdue: 1, today: 0 },
    ]);
  });

  it("someone who left (inactive) or has no email is not mailed, and the owner still sees their tasks", () => {
    const plan = planTaskDigests({
      today: TODAY,
      people: [OWNER, person("left", { name: "Old Hand", isActive: false }), person("nomail", { name: "No Mail", email: null })],
      tasks: [task("a", "left", "2026-11-15T06:00:00Z"), task("b", "nomail", "2026-11-15T06:00:00Z")],
    });
    expect(plan.personal).toEqual([]);
    expect(plan.skipped).toEqual([
      { userId: "left", reason: "inactive" },
      { userId: "nomail", reason: "no_email" },
    ]);
    expect(plan.ownerSummaries[0].team).toEqual([
      { name: "No Mail", overdue: 1, today: 0 },
      { name: "Old Hand (inactive)", overdue: 1, today: 0 },
    ]);
  });

  it("a task whose owner is not in the team list counts as not assigned", () => {
    const plan = planTaskDigests({ today: TODAY, people: [OWNER], tasks: [task("a", "ghost", "2026-11-15T06:00:00Z")] });
    expect(plan.ownerSummaries[0].team).toEqual([{ name: "Not assigned", overdue: 1, today: 0 }]);
  });
});

describe("renderPersonalDigest", () => {
  const msg = renderPersonalDigest({
    name: "Ravi Kumar", today: TODAY, tasksUrl: "https://app.example.invalid/tasks",
    overdue: [task("a", "ravi", "2026-11-15T06:00:00Z", "Call Sharma ji"), task("b", "ravi", "2026-11-17T06:00:00Z", "Send quote")],
    dueToday: [task("c", "ravi", "2026-11-18T09:00:00Z", "Follow up with Mehta")],
  });

  it("subject carries the date and both counts", () => {
    expect(msg.subject).toBe("Your tasks for 18 Nov 2026: 2 overdue, 1 due today");
  });

  it("body lists every overdue and today task by name", () => {
    expect(msg.text).toBe([
      "Hi Ravi,",
      "",
      "Overdue (2)",
      "- Call Sharma ji (was due 15 Nov 2026, 3 days late)",
      "- Send quote (was due 17 Nov 2026, 1 day late)",
      "",
      "Due today (1)",
      "- Follow up with Mehta (02:30 pm)",
      "",
      "Open your tasks: https://app.example.invalid/tasks",
    ].join("\n"));
  });

  it("only overdue → no empty 'Due today' heading", () => {
    const m = renderPersonalDigest({
      name: null, today: TODAY, tasksUrl: "https://x.invalid/tasks",
      overdue: [task("a", "ravi", "2026-11-15T06:00:00Z", "Call Sharma ji")], dueToday: [],
    });
    expect(m.subject).toBe("Your tasks for 18 Nov 2026: 1 overdue");
    expect(m.text).toContain("Hi,");
    expect(m.text).not.toContain("Due today");
  });

  it("a long list is cut at 20 with the rest counted", () => {
    const many = Array.from({ length: 23 }, (_, i) => task(`t${i}`, "ravi", "2026-11-15T06:00:00Z", `Old ${i}`));
    const m = renderPersonalDigest({ name: "Ravi", today: TODAY, tasksUrl: "https://x.invalid/tasks", overdue: many, dueToday: [] });
    expect(m.text).toContain("- Old 19 (");
    expect(m.text).not.toContain("- Old 20 (");
    expect(m.text).toContain("…and 3 more");
  });
});

describe("renderOwnerSummary", () => {
  it("team lines first, then the owner's own tasks", () => {
    const m = renderOwnerSummary({
      name: "Asha Owner", today: TODAY, tasksUrl: "https://app.example.invalid/tasks",
      totals: { overdue: 3, today: 2 },
      team: [{ name: "Ravi Kumar", overdue: 2, today: 1 }, { name: "Not assigned", overdue: 1, today: 0 }],
      overdue: [], dueToday: [task("d", "own", "2026-11-18T05:00:00Z", "Sign the lease")],
    });
    expect(m.subject).toBe("Team tasks for 18 Nov 2026: 3 overdue, 2 due today");
    expect(m.text).toBe([
      "Hi Asha,",
      "",
      "Team tasks: 3 overdue, 2 due today",
      "- Ravi Kumar: 2 overdue, 1 due today",
      "- Not assigned: 1 overdue",
      "",
      "Your own tasks",
      "",
      "Due today (1)",
      "- Sign the lease (10:30 am)",
      "",
      "Open tasks: https://app.example.invalid/tasks",
    ].join("\n"));
  });

  it("owner has no task of their own → no 'Your own tasks' block", () => {
    const m = renderOwnerSummary({
      name: "Asha", today: TODAY, tasksUrl: "https://x.invalid/tasks", totals: { overdue: 1, today: 0 },
      team: [{ name: "Ravi Kumar", overdue: 1, today: 0 }], overdue: [], dueToday: [],
    });
    expect(m.text).not.toContain("Your own tasks");
  });
});

describe("digestWhatsAppValues — the three {{n}} of the task_daily_digest template", () => {
  it("name, counts, then the task names on one line (a template value cannot hold a new line)", () => {
    const v = digestWhatsAppValues({
      name: "Ravi Kumar",
      overdue: [task("a", "ravi", "2026-11-15T06:00:00Z", "Call  Sharma ji\nabout renewal")],
      dueToday: [task("c", "ravi", "2026-11-18T09:00:00Z", "Follow up with Mehta")],
    });
    expect(v).toEqual(["Ravi", "1 overdue, 1 due today", "Call Sharma ji about renewal; Follow up with Mehta"]);
  });

  it("more than five tasks → five names and a count", () => {
    const many = Array.from({ length: 8 }, (_, i) => task(`t${i}`, "ravi", "2026-11-15T06:00:00Z", `Old ${i}`));
    const v = digestWhatsAppValues({ name: null, overdue: many, dueToday: [] });
    expect(v[0]).toBe("there");
    expect(v[2]).toBe("Old 0; Old 1; Old 2; Old 3; Old 4 (+3 more)");
  });

  it("owner summary: the team lines go in the third value", () => {
    const v = digestWhatsAppValues({
      name: "Asha Owner", overdue: [], dueToday: [], totals: { overdue: 3, today: 1 },
      team: [{ name: "Ravi Kumar", overdue: 2, today: 1 }, { name: "Not assigned", overdue: 1, today: 0 }],
    });
    expect(v).toEqual(["Asha", "3 overdue, 1 due today", "Ravi Kumar: 2 overdue, 1 due today; Not assigned: 1 overdue"]);
  });
});
