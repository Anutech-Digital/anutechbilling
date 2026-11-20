/**
 * R-2942 (20 Nov 2026) — Reports → Team tasks is the "Team" tab of the Tasks pages (R-2939).
 * Opening it made the sidebar jump to the Accounts app (the report's home) and the Tasks row
 * lost its highlight, so the menu said you had left Tasks while the tab strip said you had not.
 * Rule: a page that is a tab of a sidebar row belongs to that row in the sidebar.
 */
import { describe, expect, it } from "vitest";
import { APP_NAV, TAB_PAGE_OWNER, allowedRoutesForRole, flattenNav, getCrumb, tabOwnerOf } from "./nav";
import { appForPath, appLabelForHref, buildSidebarApps, sidebarAppForPath } from "./nav-apps";
import { TASKS_TABS } from "@/components/features/tasks/tasks-tabs";

describe("R-2942 tabOwnerOf — a page drawn as a tab of another row", () => {
  it("Team tasks belongs to the Tasks row", () => {
    expect(tabOwnerOf("/reports/team-tasks")).toBe("tasks");
    expect(tabOwnerOf("/reports/team-tasks/")).toBe("tasks");
  });

  it("no other page does — not the other reports, not the Tasks pages themselves", () => {
    for (const path of ["/reports", "/reports/team-tasks-old", "/reports/team-performance", "/tasks", "/tasks/overview", "/dashboard", "", null, undefined]) {
      expect(tabOwnerOf(path), String(path)).toBeNull();
    }
  });

  it("every owner is a real top-level row and every tab page a real nav page", () => {
    const top = new Set(APP_NAV.flatMap((s) => s.items.map((i) => i.id)));
    const pages = new Set(flattenNav(APP_NAV).map((e) => e.item.href));
    for (const [href, owner] of Object.entries(TAB_PAGE_OWNER)) {
      expect(top.has(owner), `${owner} is a sidebar row`).toBe(true);
      expect(pages.has(href), `${href} is in the nav`).toBe(true);
    }
  });

  it("covers every Tasks tab that is not under /tasks (a new tab cannot forget the rule)", () => {
    const tasks = APP_NAV.flatMap((s) => s.items).find((i) => i.id === "tasks")!;
    const own = new Set([tasks.href, ...(tasks.children ?? []).map((c) => c.href)]);
    for (const tab of TASKS_TABS.filter((t) => !own.has(t.href))) {
      expect(tabOwnerOf(tab.href), `${tab.label} tab (${tab.href})`).toBe("tasks");
    }
  });
});

describe("R-2942 sidebarAppForPath — the Team tab does not switch the sidebar to Accounts", () => {
  it.each(["owner", "manager"] as const)("%s: Team tasks keeps the app you were in (null, like /tasks)", (role) => {
    const model = buildSidebarApps(role);
    expect(appForPath(model, "/reports/team-tasks"), "the report itself lives in Accounts").toBe("accounts");
    expect(sidebarAppForPath(model, "/reports/team-tasks")).toBeNull();
    expect(sidebarAppForPath(model, "/tasks")).toBeNull();
  });

  it("every other page answers as appForPath does", () => {
    const model = buildSidebarApps("owner");
    for (const path of ["/leads", "/reports", "/accounting/pnl", "/invoices/abc-123", "/dashboard", "/platform", "/reports/team-performance"]) {
      expect(sidebarAppForPath(model, path), path).toBe(appForPath(model, path));
    }
  });

  it("a role without the Tasks row is not affected (the page answers as before)", () => {
    const model = buildSidebarApps("owner");
    const noTasks = { ...model, pinned: model.pinned.filter((p) => p.id !== "tasks") };
    expect(sidebarAppForPath(noTasks, "/reports/team-tasks")).toBe("accounts");
  });

  it("nothing else about the page changes: guard, Ctrl+K group and breadcrumb", () => {
    expect(allowedRoutesForRole("owner")).toContain("/reports/team-tasks");
    expect(allowedRoutesForRole("sales")).not.toContain("/reports/team-tasks");
    expect(appLabelForHref(buildSidebarApps("owner"), "/reports/team-tasks")).toBe("Accounts");
    expect(getCrumb("/reports/team-tasks").at(-1)).toBe("Team tasks");
  });
});
