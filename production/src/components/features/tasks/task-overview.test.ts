import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { istWeekBounds, matchesTaskSearch, taskSections, taskSummary } from "./task-overview";
import { groupTasks, taskTabCounts } from "./task-groups";

const NOW = new Date("2026-11-18T06:30:00Z"); // Wed 18 Nov 2026, 12:00 IST

describe("R-2930 search", () => {
  const task = {
    title: "Call Amit about renewal", notes: "Ask for the PO number",
    leads: null, customers: { name: "Acme Pvt Ltd", contact_name: "Ravi Kumar" }, quotes: null,
  };
  it("finds by name, by notes and by the customer it is about — any case", () => {
    expect(matchesTaskSearch(task, "amit")).toBe(true);
    expect(matchesTaskSearch(task, "PO number")).toBe(true);
    expect(matchesTaskSearch(task, "ACME")).toBe(true);
    expect(matchesTaskSearch(task, "ravi")).toBe(true);
  });
  it("every word must match (in any order); a word that is nowhere hides the task", () => {
    expect(matchesTaskSearch(task, "renewal amit")).toBe(true);
    expect(matchesTaskSearch(task, "amit invoice")).toBe(false);
  });
  it("a lead shown only by its email or phone is found by them", () => {
    const lead = { title: "Follow up", leads: { company: "", contact_name: null, contact_email: "ravi@acme.example", contact_phone: "9876543210" } };
    expect(matchesTaskSearch(lead, "ravi")).toBe(true);
    expect(matchesTaskSearch(lead, "98765")).toBe(true);
  });
  it("an empty search shows everything", () => {
    expect(matchesTaskSearch(task, "   ")).toBe(true);
  });
  it("a lead's company and contact are searched too", () => {
    const lead = { title: "Follow up", leads: { company: "Beta Traders", contact_name: "Sunil" } };
    expect(matchesTaskSearch(lead, "beta")).toBe(true);
    expect(matchesTaskSearch(lead, "sunil")).toBe(true);
  });
});

describe("R-2930 week", () => {
  it("runs Monday to Sunday in IST", () => {
    expect(istWeekBounds(NOW)).toEqual({ start: "2026-11-16", end: "2026-11-22" });
    expect(istWeekBounds(new Date("2026-11-22T18:00:00Z"))).toEqual({ start: "2026-11-16", end: "2026-11-22" }); // Sun 23:30 IST
    expect(istWeekBounds(new Date("2026-11-22T18:31:00Z"))).toEqual({ start: "2026-11-23", end: "2026-11-29" }); // Mon 00:01 IST
  });
});

const t = (id: string, due: string, status = "pending", completed_at: string | null = null) =>
  ({ id, status, due_at: due, completed_at }) as never as { id: string; status: "pending"; due_at: string; completed_at: string | null };

const TASKS = [
  t("overdue", "2026-11-10T04:00:00Z"),
  t("today", "2026-11-18T10:00:00Z"),
  t("fri", "2026-11-20T04:00:00Z"),
  t("sun-late", "2026-11-22T18:00:00Z"),        // Sunday 23:30 IST — still this week
  t("next-mon", "2026-11-22T18:31:00Z"),        // Monday 00:01 IST — later
  t("next-month", "2026-12-15T04:00:00Z"),
  t("done-mon", "2026-11-16T04:00:00Z", "done", "2026-11-16T05:00:00Z"),
  t("done-last-week", "2026-11-12T04:00:00Z", "done", "2026-11-15T10:00:00Z"), // Sunday of LAST week
  t("cancelled", "2026-11-19T04:00:00Z", "cancelled"),
];

describe("R-2930 summary cards", () => {
  it("Open / Overdue / Today / Done this week", () => {
    expect(taskSummary(TASKS, NOW)).toEqual({ open: 6, overdue: 1, today: 1, doneThisWeek: 1 });
  });
  it("agrees with the tabs: Open = Overdue + Today + Upcoming", () => {
    const c = taskTabCounts(groupTasks(TASKS, NOW));
    const s = taskSummary(TASKS, NOW);
    expect(s.open).toBe(c.overdue + c.today + c.upcoming);
    expect(s.overdue).toBe(c.overdue);
    expect(s.today).toBe(c.today);
  });
});

describe("R-2930 Upcoming is split into This week and Later", () => {
  const sections = taskSections(groupTasks(TASKS, NOW), NOW);
  it("sections in order, with English labels", () => {
    expect(sections.map((s) => `${s.id}:${s.label}`)).toEqual([
      "overdue:Overdue", "today:Today", "week:This week", "later:Later", "nodate:No date", "done:Done",
    ]);
  });
  it("due by Sunday (IST) is This week; Monday 00:01 is Later", () => {
    expect(sections.find((s) => s.id === "week")!.tasks.map((x) => x.id)).toEqual(["fri", "sun-late"]);
    expect(sections.find((s) => s.id === "later")!.tasks.map((x) => x.id)).toEqual(["next-mon", "next-month"]);
  });
  it("both halves belong to the Upcoming tab, and nothing is lost or doubled", () => {
    const up = sections.filter((s) => s.group === "upcoming");
    expect(up.map((s) => s.id)).toEqual(["week", "later"]);
    expect(up.reduce((n, s) => n + s.tasks.length, 0)).toBe(taskTabCounts(groupTasks(TASKS, NOW)).upcoming);
  });
});

describe("R-2930 the Tasks page uses these", () => {
  const page = readFileSync(join(__dirname, "../../../app/(app)/tasks/page.tsx"), "utf8");
  it("the summary is the app's one collapsible KPI strip, and is not shown when the read failed", () => {
    expect(page).toMatch(/\{!list\.error && \(\s*<CollapsibleKpiStrip\s+stripId="tasks"/);
    expect(page).toMatch(/<StripFact label="Done this week" value=\{doneThisWeek\}/);
  });
  it("Done this week is counted on the server (the page holds only the newest 100 done), inside this company", () => {
    const q = page.slice(page.indexOf('"done-this-week"'), page.indexOf("const doneThisWeek"));
    expect(q).toMatch(/count: "exact", head: true/);
    expect(q).toMatch(/\.eq\("tenant_id", me!\.tenantId\)\.eq\("status", "done"\)/);
    expect(q).toMatch(/\.gte\("completed_at", istDayStartUtc\(week\.start\)/);
  });
  it("search, tabs and list read one filtered set", () => {
    expect(page).toMatch(/groupTasks\(visible, now\)/);
    expect(page).toMatch(/taskSummary\(visible, now\)/);
    expect(page).toMatch(/taskSections\(groups, now\)/);
  });
});
