/**
 * R-2939 (20 Nov 2026) — the strip of links at the top of every Tasks page:
 * Overview · List · Calendar · Team. Four pages about the same tasks had no common way to move
 * between them (a "List view" button here, a sidebar child row there).
 *
 *   • Links, not buttons: each tab is its own page (/tasks/overview, /tasks, /tasks/calendar,
 *     /reports/team-tasks), so it is a <nav> of links and the open one carries
 *     aria-current="page" — Tab reaches each, Enter opens it, middle-click opens a new tab.
 *   • Team is Reports → Team tasks (R-2932), an owner / manager page. It is offered only to a
 *     role the route guard lets in (the same rule the menu and Ctrl+K use), so nobody is
 *     shown a tab that bounces. No role yet (still loading) → not shown — except on the Team
 *     page itself: whoever is looking at it was let in, and the open page always has its tab.
 *
 * <TasksTabsBar> is the strip in its page-wide wrapper: drawn by app/(app)/tasks/layout.tsx
 * for the three Tasks pages and by the Team tasks report above its own content, so the strip
 * sits at the same place on all four and does not jump when you switch.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { paletteMayOpen } from "@/components/layout/palette-access";
import { cn } from "@/lib/utils";

export type TasksTabId = "overview" | "list" | "calendar" | "team";

export interface TasksTab {
  id: TasksTabId;
  label: string;
  href: string;
}

/** In display order. */
export const TASKS_TABS: readonly TasksTab[] = [
  { id: "overview", label: "Overview", href: "/tasks/overview" },
  { id: "list", label: "List", href: "/tasks" },
  { id: "calendar", label: "Calendar", href: "/tasks/calendar" },
  { id: "team", label: "Team", href: "/reports/team-tasks" },
];

/** Which tab the address is on; null when it is none of them. */
export function activeTasksTab(pathname: string | null | undefined): TasksTabId | null {
  const path = (pathname ?? "").replace(/\/+$/, "");
  return TASKS_TABS.find((t) => t.href === path)?.id ?? null;
}

/** The tabs to show: Team only when the route guard admits its page for this role, or when
 *  it is the open page (`active`). */
export function tasksTabsFor(role: string | null | undefined, active: TasksTabId | null = null): TasksTab[] {
  return TASKS_TABS.filter((t) => t.id !== "team" || active === "team" || paletteMayOpen(role, t.href));
}

export function TasksTabs({ className }: { className?: string }) {
  const pathname = usePathname();
  const { data: me } = useCurrentUser();
  const active = activeTasksTab(pathname);
  const role = me?.role;
  const tabs = React.useMemo(() => tasksTabsFor(role, active), [role, active]);

  return (
    /* The hairline is on the wrapper and the scroll on the <nav>: a scrolling box with a child
       pulled 1px over its edge gets a vertical scrollbar (ui/tabs.tsx, R-1410). */
    <div className={cn("border-b border-hairline", className)}>
      <nav aria-label="Tasks views" data-testid="tasks-tabs" className="flex gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const isActive = t.id === active;
          return (
            <Link
              key={t.id}
              href={t.href as Route}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                /* min-h-11 = 44px touch target on a phone (production/CLAUDE.md §20). */
                "inline-flex min-h-11 items-center whitespace-nowrap rounded-t-md border-b-2 px-3 text-sm transition-colors md:min-h-9",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset",
                isActive
                  ? "border-amber font-semibold text-ink"
                  : "border-transparent text-ink-2 hover:bg-paper-2 hover:text-ink",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** The strip in the page-wide wrapper every Tasks page shares (max 1100px, the pages' side
 *  padding), so it lines up with their headings. */
export function TasksTabsBar() {
  return (
    <div className="mx-auto max-w-[1100px] px-4 pt-3 md:px-6 md:pt-4 lg:px-8">
      <TasksTabs />
    </div>
  );
}
