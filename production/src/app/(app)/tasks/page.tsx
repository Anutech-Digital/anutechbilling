/**
 * Tasks — list of follow-up to-dos across the tenant.
 *
 * Tabs slice by due-time + status:
 *   • Today    — pending, due today (IST midnight to midnight)
 *   • Overdue  — pending, past today's start (the painful bucket)
 *   • Upcoming — pending, due from tomorrow onwards
 *   • Done     — completed (last 30 days, audit trail)
 *   • All      — everything
 *
 * Each row exposes Complete / Snooze / Open-linked-entity inline so
 * the rep can clear the queue without navigating away.
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { TASK_TABS } from "@/lib/navigation/drilldown";
import Link from "next/link";
import {
  useTasks,
  useCompleteTask,
  useSnoozeTask,
  useDeleteTask,
  type TaskBucket,
  type TaskWithLink,
} from "@/lib/queries/tasks";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import { useTeamMembers, memberLabel, type TeamMember } from "@/lib/queries/team";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { Card } from "@/components/ui/card";
import { Button, IconButton } from "@/components/ui/button";
import { FAB } from "@/components/ui/fab";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { IST_TZ } from "@/lib/dates/ist";
import type { TaskKind } from "@/lib/supabase/database.types";
import { leadTitle } from "@/lib/leads/display-name";

/** R-279: the linked lead's company, else its contact/email/phone; null when it has no name at all. */
function taskLeadName(task: TaskWithLink): string | null {
  if (!task.leads) return null;
  const t = leadTitle(task.leads);
  return t.source === "none" ? null : t.label;
}

// ─── Icon + label per kind ────────────────────────────────────────────────
const KIND_META: Record<TaskKind, { icon: string; label: string }> = {
  call:     { icon: "📞", label: "Call" },
  email:    { icon: "✉️", label: "Email" },
  meeting:  { icon: "📅", label: "Meeting" },
  followup: { icon: "🔁", label: "Follow-up" },
  custom:   { icon: "📋", label: "Task" },
};

// ─── Page ─────────────────────────────────────────────────────────────────
export default function TasksPage() {
  const [tab, setTab] = useUrlChoice<TaskBucket>("tab", TASK_TABS, "today"); // R-118
  const [addOpen, setAddOpen] = React.useState(false);
  const [editingTask, setEditingTask] = React.useState<TaskWithLink | null>(null);

  // We pull each bucket independently for accurate counts on the tab badges.
  // For a typical SMB tenant (<200 active tasks) this is fine. Could
  // consolidate into one query + client-side bucket later if it matters.
  const today    = useTasks("today");
  const overdue  = useTasks("overdue");
  const upcoming = useTasks("upcoming");
  const done     = useTasks("done");

  const active = tab === "today" ? today
               : tab === "overdue" ? overdue
               : tab === "upcoming" ? upcoming
               : tab === "done" ? done
               : today; // 'all' falls back to today initially — handled below
  const all = useTasks("all");

  const tabs: TabBarItem[] = [
    { id: "today",    label: "Today",    count: today.data?.length    ?? 0, dot: "amber"   },
    { id: "overdue",  label: "Overdue",  count: overdue.data?.length  ?? 0, dot: "rose"    },
    { id: "upcoming", label: "Upcoming", count: upcoming.data?.length ?? 0, dot: "indigo"  },
    { id: "done",     label: "Done",     count: done.data?.length     ?? 0, dot: "emerald" },
    { id: "all",      label: "All",      count: all.data?.length      ?? 0 },
  ];

  const { data: members = [] } = useTeamMembers();
  const { data: me } = useCurrentUser();
  const memberById = React.useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const [assignee, setAssignee] = useUrlState("assignee", "all"); // R-286: survives Back

  // Per-person open (pending) task counts — the "workload at a glance".
  const openByOwner = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const t of all.data ?? []) {
      if (t.status !== "pending" || !t.owner_id) continue;
      m.set(t.owner_id, (m.get(t.owner_id) ?? 0) + 1);
    }
    return m;
  }, [all.data]);
  const totalOpen = React.useMemo(() => (all.data ?? []).filter((t) => t.status === "pending").length, [all.data]);
  const myOpen = me?.userId ? openByOwner.get(me.userId) ?? 0 : 0;

  const rawVisible = tab === "all" ? (all.data ?? []) : (active.data ?? []);
  const visibleTasks =
    assignee === "all"  ? rawVisible :
    assignee === "mine" ? rawVisible.filter((t) => t.owner_id === me?.userId) :
                          rawVisible.filter((t) => t.owner_id === assignee);
  const isLoading = tab === "all" ? all.isLoading : active.isLoading;
  // Honest error surface — without this a failed load renders a cheerful
  // "Nothing on your plate today." (false positive). Capture + retry instead.
  const loadError = tab === "all" ? all.error : active.error;
  const refetchTasks = tab === "all" ? all.refetch : active.refetch;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1100px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            Sales
          </p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Tasks</h1>
          <p className="text-sm text-ink-3 mt-1">
            Follow-ups, calls, emails, meetings — everything you owe future-you.
          </p>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => setAddOpen(true)}
        >
          Add task
        </Button>
      </div>

      {/* Tabs */}
      <div className="mb-3">
        <TabBar items={tabs} value={tab} onChange={(v) => setTab(v as TaskBucket)} />
      </div>

      {/* Workload — per-person open-task counts + quick "Mine" toggle. Click to filter. */}
      {members.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <WorkloadChip label="👥 Everyone" count={totalOpen} active={assignee === "all"} onClick={() => setAssignee("all")} />
          {me?.userId && (
            <WorkloadChip label="🙋 Mine" count={myOpen} active={assignee === "mine"} onClick={() => setAssignee("mine")} />
          )}
          {members.filter((m) => m.id !== me?.userId).map((m) => (
            <WorkloadChip
              key={m.id}
              label={memberLabel(m)}
              count={openByOwner.get(m.id) ?? 0}
              active={assignee === m.id}
              onClick={() => setAssignee(m.id)}
            />
          ))}
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : loadError ? (
        <EmptyState
          icon="alert"
          title="Couldn't load your tasks"
          body="Something went wrong fetching your tasks. This isn't 'inbox zero' — check your connection and try again."
          action={<Button variant="primary" icon="refresh" onClick={() => void refetchTasks()}>Retry</Button>}
          compact
        />
      ) : visibleTasks.length === 0 ? (
        <EmptyState
          icon={tab === "done" ? "check_circle" : "clock"}
          title={
            tab === "today"    ? "Nothing on your plate today."
          : tab === "overdue"  ? "Inbox zero on overdue — well done."
          : tab === "upcoming" ? "Nothing scheduled ahead."
          : tab === "done"     ? "No completed tasks yet."
          :                      "No tasks at all."
          }
          body={
            tab === "done"
              ? "Mark tasks done to populate this audit log."
              : "Open a lead, customer, or quote and schedule a follow-up from there — or add one directly."
          }
          action={
            tab !== "done"
              ? <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add task</Button>
              : undefined
          }
          compact
        />
      ) : (
        <Card>
          <ul className="divide-y divide-hairline">
            {visibleTasks.map((t) => (
              <TaskRow key={t.id} task={t} onEdit={setEditingTask} assignee={t.owner_id ? memberById.get(t.owner_id) : null} />
            ))}
          </ul>
        </Card>
      )}

      <AddTaskDialog open={addOpen} onOpenChange={setAddOpen} linkTo={null} />

      {/* Edit an existing task (title / type / due / notes). The link stays as-is. */}
      {editingTask && (
        <AddTaskDialog
          open
          onOpenChange={(o) => { if (!o) setEditingTask(null); }}
          linkTo={null}
          linkLabel={taskLeadName(editingTask) ?? editingTask.customers?.name ?? editingTask.quotes?.customer_name ?? undefined}
          task={editingTask}
        />
      )}

      {/* Mobile primary — the header "Add task" scrolls away behind a long queue. */}
      <FAB icon="plus" label="Add task" onClick={() => setAddOpen(true)} />
    </div>
  );
}

// ─── Workload filter chip (per-person open-task count) ──────────────────────
function WorkloadChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline text-ink-2 hover:bg-paper-2",
      )}
    >
      <span>{label}</span>
      <span className={cn("rounded-full px-1.5 tabular-nums", active ? "bg-amber/25 text-amber-ink" : "bg-paper-2 text-ink-3")}>{count}</span>
    </button>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────
function TaskRow({ task, onEdit, assignee }: { task: TaskWithLink; onEdit: (t: TaskWithLink) => void; assignee?: TeamMember | null }) {
  const completeTask = useCompleteTask();
  const snoozeTask   = useSnoozeTask();
  const deleteTask   = useDeleteTask();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const due = new Date(task.due_at);
  const now = Date.now();
  const isOverdue = task.status === "pending" && due.getTime() < now;
  const isDone    = task.status === "done";
  const kindMeta  = KIND_META[task.kind];

  // Linked entity — for the "open" button. At most one of these is set.
  const linkHref =
      task.lead_id         ? `/leads?lead=${task.lead_id}`
    : task.quote_id        ? `/quotes/${task.quote_id}`
    : task.customer_id     ? `/customers/${task.customer_id}`
    : task.subscription_id ? `/subscriptions`
    : null;
  // Who the task is about — pulled from the linked lead / customer / quote.
  const relatedName =
      taskLeadName(task)         ?? task.customers?.name
    ?? task.quotes?.customer_name ?? null;
  // Show the related name (clickable); fall back to a generic label if the
  // linked row has no name or the task is linked only to a subscription.
  const linkLabel =
      relatedName
    ?? (task.lead_id         ? "Open lead"
      : task.quote_id        ? "Open quote"
      : task.customer_id     ? "Open customer"
      : task.subscription_id ? "Open subscription"
      : null);

  return (
    <li
      className={cn(
        "px-4 py-3 flex items-start gap-3 transition-colors",
        isOverdue && "bg-rose-soft/30",
        isDone    && "opacity-60",
      )}
    >
      {/* Complete checkbox */}
      <button
        type="button"
        onClick={() => !isDone && completeTask.mutate(task.id)}
        disabled={isDone}
        title={isDone ? "Completed" : "Mark done"}
        aria-label={isDone ? "Completed" : "Mark done"}
        className={cn(
          "mt-1 w-5 h-5 rounded-full border shrink-0 transition-colors flex items-center justify-center",
          isDone
            ? "bg-emerald border-emerald text-paper"
            : "border-hairline-strong hover:bg-emerald-soft hover:border-emerald",
        )}
      >
        {isDone && <Icon name="check" size={12} />}
      </button>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base leading-none">{kindMeta.icon}</span>
          <p className={cn("font-medium text-ink", isDone && "line-through")}>{task.title}</p>
          <Badge kind="muted">{kindMeta.label}</Badge>
          {assignee && (
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-soft/60 text-indigo px-2 py-0.5 text-2xs font-medium" title={`Assigned to ${memberLabel(assignee)}`}>
              <Icon name="user" size={10} /> {memberLabel(assignee)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 text-[12px]">
          <span className={cn(
            "tabular-nums",
            isOverdue ? "text-rose font-medium" :
            isDone    ? "text-ink-3" :
                        "text-ink-2",
          )}>
            {isOverdue && "⚠ Overdue · "}
            {due.toLocaleString("en-IN", {
              weekday: "short", day: "numeric", month: "short",
              hour: "2-digit", minute: "2-digit", timeZone: IST_TZ,
            })}
          </span>
          {task.snooze_count > 0 && (
            <span className="text-ink-3 text-2xs">snoozed {task.snooze_count}×</span>
          )}
          {linkHref && linkLabel && (
            <Link
              href={linkHref as any}
              className="text-amber-ink hover:underline text-2xs inline-flex items-center gap-0.5"
            >
              <Icon name="external" size={10} /> {linkLabel}
            </Link>
          )}
        </div>
        {task.notes && (
          <p className="text-[12px] text-ink-3 mt-1.5 whitespace-pre-line">{task.notes}</p>
        )}
      </div>

      {/* Actions */}
      {!isDone && (
        <div className="flex gap-0.5 shrink-0">
          <IconButton
            icon="edit"
            size="sm"
            variant="ghost"
            aria-label="Edit task"
            title="Edit task"
            onClick={() => onEdit(task)}
          />
          <IconButton
            icon="clock"
            size="sm"
            variant="ghost"
            aria-label="Snooze 1 day"
            title="Snooze 1 day"
            onClick={() => snoozeTask.mutate({ id: task.id })}
          />
          <IconButton
            icon="trash"
            size="sm"
            variant="ghost"
            aria-label="Delete"
            title="Delete"
            onClick={() => setConfirmOpen(true)}
          />
        </div>
      )}

      {/* Delete confirmation — an in-app dialog (native window.confirm is
          suppressed in some browsers/embeds and always returns false, which
          made delete silently fail). */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon name="trash" size={18} className="text-rose" />
              Delete this task?
            </DialogTitle>
            <DialogDescription>
              &ldquo;{task.title}&rdquo; permanently delete ho jayegi. Ye undo nahi hoga.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              icon="trash"
              loading={deleteTask.isPending}
              onClick={() => {
                deleteTask.mutate(task.id, {
                  onSuccess: () => setConfirmOpen(false),
                });
              }}
            >
              Delete task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
