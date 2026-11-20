// @vitest-environment jsdom
/* R-2939 — one strip of links (Overview · List · Calendar · Team) on every Tasks page: the open
   page is marked, and Team (Reports → Team tasks, owner / manager) is not offered to a role
   the route guard would bounce. */
import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

let pathname = "/tasks";
let role: string | undefined = "owner";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: role ? { role } : undefined }) }));

import { TASKS_PAGE_WIDTH, TasksTabs, TasksTabsBar, activeTasksTab, tasksTabsFor } from "./tasks-tabs";

afterEach(() => cleanup());

const show = (path: string, as: string | undefined = "owner") => {
  pathname = path;
  role = as;
  render(<TasksTabs />);
  return within(screen.getByRole("navigation", { name: "Tasks views" }));
};

describe("R-2939 tasksTabsFor", () => {
  it("owner and manager get all four, in the order Overview · List · Calendar · Team", () => {
    for (const r of ["owner", "manager"] as const) {
      expect(tasksTabsFor(r).map((t) => [t.label, t.href])).toEqual([
        ["Overview", "/tasks/overview"],
        ["List", "/tasks"],
        ["Calendar", "/tasks/calendar"],
        ["Team", "/reports/team-tasks"],
      ]);
    }
  });

  it("sales roles get no Team tab — that report is owner / manager only", () => {
    for (const r of ["sales", "sales_senior"] as const) {
      expect(tasksTabsFor(r).map((t) => t.label)).toEqual(["Overview", "List", "Calendar"]);
    }
  });

  it("no role yet (still loading) → the three Tasks pages, no Team", () => {
    expect(tasksTabsFor(undefined).map((t) => t.label)).toEqual(["Overview", "List", "Calendar"]);
  });

  it("on the Team page itself the Team tab is always there — the open page has its tab while the role loads", () => {
    expect(tasksTabsFor(undefined, "team").map((t) => t.label)).toEqual(["Overview", "List", "Calendar", "Team"]);
    // Being on another tab opens nothing for sales.
    expect(tasksTabsFor("sales", "list").map((t) => t.label)).toEqual(["Overview", "List", "Calendar"]);
  });
});

describe("R-2939 activeTasksTab", () => {
  it("picks the tab from the address", () => {
    expect(activeTasksTab("/tasks")).toBe("list");
    expect(activeTasksTab("/tasks/")).toBe("list");
    expect(activeTasksTab("/tasks/overview")).toBe("overview");
    expect(activeTasksTab("/tasks/calendar")).toBe("calendar");
    expect(activeTasksTab("/reports/team-tasks")).toBe("team");
  });

  it("a page that is none of them marks nothing", () => {
    expect(activeTasksTab("/reports")).toBeNull();
    expect(activeTasksTab("/tasks-archive")).toBeNull();
    expect(activeTasksTab(null)).toBeNull();
  });
});

describe("R-2939 <TasksTabs>", () => {
  it("draws four links for the owner and marks only the open page", () => {
    const nav = show("/tasks/calendar");
    const links = nav.getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Overview", "List", "Calendar", "Team"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/tasks/overview", "/tasks", "/tasks/calendar", "/reports/team-tasks"]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, null, "page", null]);
  });

  it("marks List on /tasks and Team on the report", () => {
    expect(show("/tasks").getByRole("link", { name: "List" }).getAttribute("aria-current")).toBe("page");
    cleanup();
    expect(show("/reports/team-tasks").getByRole("link", { name: "Team" }).getAttribute("aria-current")).toBe("page");
  });

  it("a sales login sees three tabs, no Team", () => {
    const nav = show("/tasks", "sales");
    expect(nav.getAllByRole("link").map((a) => a.textContent)).toEqual(["Overview", "List", "Calendar"]);
    expect(nav.queryByRole("link", { name: "Team" })).toBeNull();
  });

  it("every tab shows a focus ring for keyboard users and is 44px tall on a phone", () => {
    for (const a of show("/tasks").getAllByRole("link")) {
      expect(a.className).toContain("focus-visible:ring-2");
      expect(a.className.split(/\s+/)).toContain("min-h-11");
    }
  });

  it("the Team page shows its own tab, marked, even before the role has loaded", () => {
    const links = show("/reports/team-tasks", undefined).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Overview", "List", "Calendar", "Team"]);
    expect(links[3].getAttribute("aria-current")).toBe("page");
  });
});

/* R-2942 — the strip and the four pages were capped at 1100px (long task names were cut on the
   list while the screen had room). They share ONE width now, the app's listing width. */
describe("R-2942 one width for the whole Tasks section", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const PAGES = [
    "src/app/(app)/tasks/page.tsx",
    "src/app/(app)/tasks/overview/page.tsx",
    "src/app/(app)/tasks/calendar/page.tsx",
    "src/app/(app)/reports/team-tasks/page.tsx",
  ];

  it("is the listing width (production/CLAUDE.md: listing pages are max-w-[1800px])", () => {
    expect(TASKS_PAGE_WIDTH.split(" ")).toEqual(expect.arrayContaining(["mx-auto", "max-w-[1800px]"]));
  });

  it("the tab strip uses it", () => {
    pathname = "/tasks";
    role = "owner";
    render(<TasksTabsBar />);
    const bar = screen.getByTestId("tasks-tabs-bar");
    for (const c of TASKS_PAGE_WIDTH.split(" ")) expect(bar.className.split(" ")).toContain(c);
  });

  it.each(PAGES)("%s uses it, and carries no width of its own", (rel) => {
    const src = read(rel);
    expect(src).toContain("TASKS_PAGE_WIDTH");
    expect(src).not.toContain("max-w-[1100px]");
    // One wrapper per page: no second page-wide max width beside the shared one.
    expect(src).not.toContain("max-w-[1800px]");
  });

  it.each(PAGES.slice(0, 3))("%s has no 'Sales' eyebrow above its title (Tasks left the Sales app in R-2939)", (rel) => {
    expect(read(rel).replace(/[ \t\r\n]+/g, "")).not.toContain(">Sales</p>");
  });
});
