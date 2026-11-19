/**
 * R-2931 — the month grid of /tasks/calendar. Presentational: the page gives it the tasks by
 * IST day (calendar-grid.ts) and hears which day was pressed and which task was dropped where.
 *
 * A day cell is clickable anywhere; the day number is the real button (keyboard + screen
 * reader), named with the date and how many tasks are due. Open tasks can be dragged to
 * another day (mouse only — the task's Edit dialog is the keyboard way to change a due date).
 */
"use client";

import * as React from "react";
import { formatIstDate, formatIstTime, toIstDate } from "@/lib/dates/ist";
import { cn } from "@/lib/utils";
import { monthWeeks, taskTone, WEEKDAYS, type TaskTone } from "./calendar-grid";

/** Task names shown in one day cell before "+N more". */
export const MAX_CHIPS = 3;
const DRAG_TYPE = "text/plain";

export const TONE_ORDER: readonly TaskTone[] = ["overdue", "today", "upcoming", "done"];
export const TONE_LABEL: Record<TaskTone, string> = { overdue: "Overdue", today: "Today", upcoming: "Upcoming", done: "Done" };
export const TONE_DOT: Record<TaskTone, string> = { overdue: "bg-rose", today: "bg-amber", upcoming: "bg-indigo", done: "bg-emerald" };
const TONE_CHIP: Record<TaskTone, string> = {
  overdue: "border-rose bg-rose-soft/60 text-ink",
  today: "border-amber bg-amber-soft text-ink",
  upcoming: "border-indigo bg-indigo-soft/60 text-ink",
  done: "border-emerald bg-emerald-soft/60 text-ink-2 line-through",
};

export interface GridTask {
  id: string;
  title: string;
  due_at: string;
  status: "pending" | "snoozed" | "done" | "cancelled";
}

export function MonthGrid<T extends GridTask>({ month, byDay, selectedDay, now, onSelectDay, onMoveTask }: {
  month: string;
  byDay: ReadonlyMap<string, T[]>;
  selectedDay: string | null;
  now: Date;
  onSelectDay: (day: string) => void;
  onMoveTask: (taskId: string, day: string) => void;
}) {
  const weeks = React.useMemo(() => monthWeeks(month), [month]);
  const today = toIstDate(now);
  const [dropDay, setDropDay] = React.useState<string | null>(null);
  const lastRowStart = weeks.length * 7 - 7;

  return (
    <div className="rounded-lg border border-hairline bg-paper overflow-hidden">
      <div className="grid grid-cols-7 border-b border-hairline bg-paper-2 text-2xs sm:text-xs font-semibold uppercase tracking-wider text-ink-3">
        {WEEKDAYS.map((d) => <div key={d} className="px-1.5 sm:px-2 py-1.5">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {weeks.flat().map((day, i) => {
          const list = byDay.get(day) ?? [];
          const inMonth = day.slice(0, 7) === month;
          const isToday = day === today;
          const selected = day === selectedDay;
          const count = list.length === 0 ? "no tasks" : `${list.length} task${list.length === 1 ? "" : "s"}`;
          return (
            <div
              key={day}
              data-testid={`day-${day}`}
              onClick={() => onSelectDay(day)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dropDay !== day) setDropDay(day);
              }}
              onDragLeave={() => setDropDay((d) => (d === day ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                setDropDay(null);
                const id = e.dataTransfer.getData(DRAG_TYPE);
                if (id) onMoveTask(id, day);
              }}
              className={cn(
                "min-h-[68px] sm:min-h-[104px] min-w-0 cursor-pointer border-hairline p-1 sm:p-1.5 transition-colors hover:bg-paper-2/60",
                i % 7 !== 6 && "border-r",
                i < lastRowStart && "border-b",
                !inMonth && "bg-paper-2/40",
                selected && "bg-amber-soft/50 ring-2 ring-inset ring-amber",
                dropDay === day && "bg-indigo-soft/50",
              )}
            >
              <button
                type="button"
                aria-label={`${formatIstDate(day)}${isToday ? ", today" : ""}, ${count}`}
                aria-pressed={selected}
                onClick={(e) => { e.stopPropagation(); onSelectDay(day); }}
                className={cn(
                  "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                  isToday ? "bg-ink text-paper font-semibold" : inMonth ? "text-ink" : "text-ink-3",
                )}
              >
                {Number(day.slice(8, 10))}
              </button>
              {/* Phone: a count only — seven columns leave no room for names. */}
              {list.length > 0 && (
                <p className="sm:hidden mt-1 text-2xs text-ink-2 tabular-nums">{list.length} due</p>
              )}
              <ul className="hidden sm:block mt-1 space-y-0.5">
                {list.slice(0, MAX_CHIPS).map((task) => {
                  const tone = taskTone(task, now);
                  const open = task.status !== "done";
                  return (
                    <li
                      key={task.id}
                      data-testid="task-chip"
                      data-tone={tone}
                      draggable={open}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, task.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      title={`${task.title} — ${formatIstTime(task.due_at)} · ${TONE_LABEL[tone]}`}
                      className={cn("truncate rounded-sm border-l-2 px-1 py-0.5 text-2xs leading-tight", TONE_CHIP[tone], open && "cursor-grab")}
                    >
                      {task.title}
                    </li>
                  );
                })}
                {list.length > MAX_CHIPS && (
                  <li className="px-1 text-2xs text-ink-3">+{list.length - MAX_CHIPS} more</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
