/**
 * R-2938 — the Tasks page's one filter bar: search, Status, Priority, Assignee — one line.
 *
 * It replaces the search box plus a row of person chips that wrapped onto two lines. Every
 * option carries its number (task-filters.ts: open tasks you get by picking it, the other
 * choices kept). The page owns the values (they live in the address); this only draws them.
 * `children` is the end of the line — the page puts its view switch there.
 */
"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TASK_PRIORITY_FILTERS, TASK_STATUS_FILTERS } from "@/lib/navigation/drilldown";
import { TASK_PRIORITY_META } from "./task-priority";
import { TASK_ROW_STATUS_META } from "./task-progress";
import {
  hasTaskFilters,
  type AssigneeOption, type TaskFilterCounts, type TaskFilters, type TaskPriorityFilter, type TaskStatusFilter,
} from "./task-filters";

const STATUS_LABEL = (s: TaskStatusFilter) => (s === "all" ? "All statuses" : TASK_ROW_STATUS_META[s].label);
const PRIORITY_LABEL = (p: TaskPriorityFilter) => (p === "all" ? "All priorities" : TASK_PRIORITY_META[p].label);

/** "High (5)" — the number is part of the option's name, so a screen reader says it too. */
const withCount = (label: string, n: number) => `${label} (${n})`;

export function TaskFilterBar({
  query, onQuery, filters, onStatus, onPriority, onAssignee, onClear, counts, assignees, showAssignee = true, children,
}: {
  query: string;
  onQuery: (next: string) => void;
  filters: TaskFilters;
  onStatus: (next: TaskStatusFilter) => void;
  onPriority: (next: TaskPriorityFilter) => void;
  onAssignee: (next: string) => void;
  /** Back to no Status / Priority / Assignee choice (the search stays). */
  onClear: () => void;
  counts: TaskFilterCounts;
  /** The teammates offered (task-filters.ts taskAssigneeOptions) — "Everyone" and "Mine" are added here. */
  assignees: readonly AssigneeOption[];
  /** False for a one-person company: "Everyone" and "Mine" would be the same list. */
  showAssignee?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="task-filter-bar">
      {/* R-2930: search — name, notes, or who the task is about. */}
      <div className="min-w-[14rem] max-w-md flex-1">
        <Input
          type="search"
          aria-label="Search tasks"
          placeholder="Search tasks — name, notes, customer or lead"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          prefix={<Icon name="search" size={14} />}
          autoComplete="off"
        />
      </div>

      <Select value={filters.status} onValueChange={(v) => onStatus(v as TaskStatusFilter)}>
        <SelectTrigger aria-label="Status" className="w-[164px] shrink-0"><SelectValue /></SelectTrigger>
        <SelectContent>
          {TASK_STATUS_FILTERS.map((s) => (
            <SelectItem key={s} value={s}>{withCount(STATUS_LABEL(s), counts.status[s])}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.priority} onValueChange={(v) => onPriority(v as TaskPriorityFilter)}>
        <SelectTrigger aria-label="Priority" className="w-[168px] shrink-0"><SelectValue /></SelectTrigger>
        <SelectContent>
          {TASK_PRIORITY_FILTERS.map((p) => (
            <SelectItem key={p} value={p}>{withCount(PRIORITY_LABEL(p), counts.priority[p])}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showAssignee && (
      <Select value={filters.assignee} onValueChange={onAssignee}>
        <SelectTrigger aria-label="Assignee" className="w-[176px] shrink-0"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{withCount("Everyone", counts.assignee.all)}</SelectItem>
          <SelectItem value="mine">{withCount("Mine", counts.assignee.mine)}</SelectItem>
          {assignees.map((a) => (
            <SelectItem key={a.id} value={a.id}>{withCount(a.label, counts.assignee.byOwner.get(a.id) ?? 0)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      )}

      {hasTaskFilters(filters) && (
        <IconButton icon="x" size="sm" aria-label="Clear filters" title="Clear filters" onClick={onClear} />
      )}

      {children}
    </div>
  );
}
