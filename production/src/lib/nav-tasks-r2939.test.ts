/**
 * R-2939 (20 Nov 2026) — Tasks is every seller's daily list, not a Sales page: it sat fifth in
 * the Sales app, under Orders (website). Now it is pinned at the top of the sidebar next to
 * Today, for the same roles as before. As a pinned row it is drawn as one link, so the Overdue
 * count shows again (an accordion parent draws no count); Overview / Calendar are the tabs on
 * the page (tasks-tabs.tsx) and stay in the nav for the route guard, Ctrl+K and breadcrumbs.
 */
import { describe, expect, it } from "vitest";
import { APP_NAV, allowedRoutesForRole, flattenNav, getCrumb, type UserRole } from "./nav";
import { NAV_APPS, PINNED_ITEM_IDS, appLabelForHref, buildSidebarApps } from "./nav-apps";
import { matchesAllTerms } from "./search/keywords";

const TASK_ROLES: UserRole[] = ["owner", "manager", "sales", "sales_senior"];

describe("R-2939 Tasks sits at the top of the sidebar", () => {
  it("is pinned right after Today, and no longer a Sales row", () => {
    expect(PINNED_ITEM_IDS.slice(0, 2)).toEqual(["today", "tasks"]);
    expect(NAV_APPS.flatMap((a) => a.itemIds)).not.toContain("tasks");
  });

  it("owner sees Today, Tasks, Dashboard… pinned; sales sees Tasks first", () => {
    expect(buildSidebarApps("owner").pinned.map((i) => i.id)).toEqual(["today", "tasks", "dashboard", "ai-entry", "team-chat"]);
    for (const role of ["sales", "sales_senior"] as const) {
      const m = buildSidebarApps(role);
      expect(m.pinned[0]?.id, role).toBe("tasks");
      expect(m.apps.flatMap((a) => a.items).map((i) => i.id), role).not.toContain("tasks");
    }
  });

  it("lives in the Home section, so its crumb and Ctrl+K group say Home", () => {
    const home = APP_NAV.find((s) => s.section === "Home")!;
    expect(home.items.map((i) => i.id).slice(0, 2)).toEqual(["today", "tasks"]);
    expect(APP_NAV.find((s) => s.section === "Sell")!.items.map((i) => i.id)).not.toContain("tasks");
    expect(getCrumb("/tasks")).toEqual(["Home", "Tasks"]);
    expect(appLabelForHref(buildSidebarApps("owner"), "/tasks/calendar")).toBe("Home");
  });

  it("keeps the same people and the same pages (route guard unchanged)", () => {
    for (const role of TASK_ROLES) {
      expect(allowedRoutesForRole(role), role).toEqual(expect.arrayContaining(["/tasks", "/tasks/overview", "/tasks/calendar"]));
    }
    for (const role of ["billing", "accountant", "support"] as const) {
      expect(buildSidebarApps(role).pinned.map((i) => i.id), role).not.toContain("tasks");
      expect(allowedRoutesForRole(role), role).not.toContain("/tasks");
    }
  });

  it("keeps the id 'tasks' (the Overdue count is keyed on it) and its two child pages", () => {
    const tasks = APP_NAV.flatMap((s) => s.items).find((i) => i.id === "tasks")!;
    expect(tasks.href).toBe("/tasks");
    expect(tasks.children?.map((c) => c.href)).toEqual(["/tasks/overview", "/tasks/calendar"]);
  });
});

describe("R-2939 Ctrl+K finds the Tasks pages by their full name", () => {
  const labelFor = (href: string) => flattenNav(APP_NAV).find((e) => e.item.href === href)!.item.label;

  it("names them Tasks overview / Tasks calendar (they were only Overview / Calendar)", () => {
    expect(labelFor("/tasks/overview")).toBe("Tasks overview");
    expect(labelFor("/tasks/calendar")).toBe("Tasks calendar");
    expect(matchesAllTerms([labelFor("/tasks/overview"), "Home"], "tasks overview")).toBe(true);
    expect(matchesAllTerms([labelFor("/tasks/calendar"), "Home"], "tasks calendar")).toBe(true);
  });

  it("and the breadcrumb says which Overview / Calendar it is", () => {
    expect(getCrumb("/tasks/overview")).toEqual(["Home", "Tasks overview"]);
    expect(getCrumb("/tasks/calendar")).toEqual(["Home", "Tasks calendar"]);
  });
});
