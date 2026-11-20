/**
 * R-2939 (20 Nov 2026) — every Tasks page (/tasks, /tasks/overview, /tasks/calendar) opens under
 * the same strip of tabs: Overview · List · Calendar · Team. One layout, so a new Tasks page
 * gets the strip without remembering to add it.
 */
import type { ReactNode } from "react";
import { TasksTabsBar } from "@/components/features/tasks/tasks-tabs";

export default function TasksLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <TasksTabsBar />
      {children}
    </>
  );
}
