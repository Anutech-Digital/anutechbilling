/**
 * Tasks — list of follow-up to-dos across the tenant.
 *
 * R-354 (7 Oct 2026, Pardeep's AI Help report): one read of every open task + recent done
 * ones, grouped by IST day into Overdue (red count) / Today / Upcoming / No date / Done
 * (collapsed, at the bottom). One click on the circle = done, with Undo in the toast. The
 * linked lead / customer's phone and email sit on the row (call / WhatsApp / copy). A
 * quick-add bar at the top takes "Call Amit tomorrow 3 PM" + Enter.
 *
 * The tab (R-118) narrows the list to one group; "All" shows every group. Tab and person
 * filter live in the URL (R-286), and `?task=<id>` opens that task (R-341).
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { TASK_TABS } from "@/lib/navigation/drilldown";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useTaskList, TASK_SELECT, type TaskBucket, type TaskWithLink } from "@/lib/queries/tasks";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import { TaskRow, taskLeadName } from "@/components/features/tasks/task-row";
import { TaskQuickAdd } from "@/components/features/tasks/task-quick-add";
import { groupTasks, type TaskGroup, type TaskGroupId } from "@/components/features/tasks/task-groups";
import { useTeamMembers, memberLabel } from "@/lib/queries/team";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FAB } from "@/components/ui/fab";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// ─── Page ─────────────────────────────────────────────────────────────────
export default function TasksPage() {
  const [tab, setTab] = useUrlChoice<TaskBucket>("tab", TASK_TABS, "all"); // R-118; R-354: All = grouped view
  const [addOpen, setAddOpen] = React.useState(false);
  const [editingTask, setEditingTask] = React.useState<TaskWithLink | null>(null);

  /* R-341: `/tasks?task=<id>` opens that task's dialog — the lead Activity tab's task rows
     link here. Fetched by id, not looked up in the list: the task a rep just clicked must
     open even when it is not among the rows shown. Opened once per id; closing the dialog
     drops the param so a reload does not pop it back up. */
  const [taskParam, setTaskParam] = useUrlState("task", "");
  const linkedTask = useQuery({
    queryKey: ["tasks", "one", taskParam],
    enabled: taskParam !== "",
    queryFn: async (): Promise<TaskWithLink | null> => {
      const { data, error } = await createClient()
        .from("tasks")
        .select(TASK_SELECT)
        .eq("id", taskParam)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as TaskWithLink | null;
    },
  });
  const openedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!taskParam || openedFor.current === taskParam || !linkedTask.isSuccess) return;
    openedFor.current = taskParam;
    if (linkedTask.data) setEditingTask(linkedTask.data);
    else { toast.error("That task no longer exists."); setTaskParam(""); }
  }, [taskParam, linkedTask.isSuccess, linkedTask.data, setTaskParam]);
  const closeEditing = React.useCallback(() => {
    setEditingTask(null);
    if (taskParam) setTaskParam("");
  }, [taskParam, setTaskParam]);

  const { data: me, isLoading: meLoading } = useCurrentUser();
  const list = useTaskList(me?.tenantId);
  const { data: members = [] } = useTeamMembers();
  const memberById = React.useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const [assignee, setAssignee] = useUrlState("assignee", "all"); // R-286: survives Back

  const tasks = React.useMemo(() => list.data ?? [], [list.data]);

  // Per-person open task counts — the "workload at a glance".
  const openByOwner = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (t.status === "done" || t.status === "cancelled" || !t.owner_id) continue;
      m.set(t.owner_id, (m.get(t.owner_id) ?? 0) + 1);
    }
    return m;
  }, [tasks]);
  const totalOpen = React.useMemo(() => tasks.filter((t) => t.status === "pending" || t.status === "snoozed").length, [tasks]);
  const myOpen = me?.userId ? openByOwner.get(me.userId) ?? 0 : 0;

  const mineOrTheirs = React.useMemo(
    () =>
      assignee === "all"  ? tasks :
      assignee === "mine" ? tasks.filter((t) => t.owner_id === me?.userId) :
                            tasks.filter((t) => t.owner_id === assignee),
    [tasks, assignee, me?.userId],
  );
  const groups = React.useMemo(() => groupTasks(mineOrTheirs), [mineOrTheirs]);
  const count = (id: TaskGroupId) => groups.find((g) => g.id === id)?.tasks.length ?? 0;
  const openCount = count("overdue") + count("today") + count("upcoming") + count("nodate");

  const tabs: TabBarItem[] = [
    { id: "all",      label: "All",      count: openCount },
    { id: "overdue",  label: "Overdue",  count: count("overdue"),  dot: "rose"    },
    { id: "today",    label: "Today",    count: count("today"),    dot: "amber"   },
    { id: "upcoming", label: "Upcoming", count: count("upcoming"), dot: "indigo"  },
    { id: "done",     label: "Done",     count: count("done"),     dot: "emerald" },
  ];

  const shown: TaskGroup<TaskWithLink>[] = groups.filter(
    (g) => g.tasks.length > 0 && (tab === "all" || g.id === tab),
  );
  const [doneOpen, setDoneOpen] = React.useState(false);

  const isLoading = meLoading || (!!me?.tenantId && list.isLoading);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1100px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Sales</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Tasks</h1>
          <p className="text-sm text-ink-3 mt-1">
            Follow-ups, calls, emails, meetings — everything you owe future-you.
          </p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
          Add task
        </Button>
      </div>

      <TaskQuickAdd />

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
      ) : list.error ? (
        <EmptyState
          icon="alert"
          title="Couldn't load your tasks"
          body="Something went wrong fetching your tasks. This isn't 'inbox zero' — check your connection and try again."
          action={<Button variant="primary" icon="refresh" onClick={() => void list.refetch()}>Retry</Button>}
          compact
        />
      ) : shown.length === 0 ? (
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
              ? "Tick a task's circle to mark it done — it shows up here."
              : "Type one in the quick-add box above, or schedule a follow-up from a lead, customer or quote."
          }
          compact
        />
      ) : (
        <div className="space-y-4">
          {shown.map((g) => {
            const foldable = g.id === "done" && tab === "all";
            return (
              <section key={g.id} aria-labelledby={`task-group-${g.id}`}>
                <h2 id={`task-group-${g.id}`} className="mb-1.5 px-1">
                  {foldable ? (
                    <button
                      type="button"
                      onClick={() => setDoneOpen((o) => !o)}
                      aria-expanded={doneOpen}
                      className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-ink-3 hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                    >
                      <Icon name={doneOpen ? "chevron_down" : "chevron_right"} size={14} />
                      {g.label}
                      <GroupCount id={g.id} n={g.tasks.length} />
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-ink-3">
                      {g.label}
                      <GroupCount id={g.id} n={g.tasks.length} />
                    </span>
                  )}
                </h2>
                {(!foldable || doneOpen) && (
                  <Card>
                    <ul className="divide-y divide-hairline">
                      {g.tasks.map((t) => (
                        <TaskRow key={t.id} task={t} onEdit={setEditingTask} assignee={t.owner_id ? memberById.get(t.owner_id) : null} />
                      ))}
                    </ul>
                  </Card>
                )}
              </section>
            );
          })}
        </div>
      )}

      <AddTaskDialog open={addOpen} onOpenChange={setAddOpen} linkTo={null} />

      {/* Edit an existing task (title / type / due / notes). The link stays as-is. */}
      {editingTask && (
        <AddTaskDialog
          open
          onOpenChange={(o) => { if (!o) closeEditing(); }}
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

// ─── Group heading count — Overdue's is red so it is never missed ────────────
function GroupCount({ id, n }: { id: TaskGroupId; n: number }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 tabular-nums normal-case tracking-normal",
        id === "overdue" ? "bg-rose text-white" : "bg-paper-2 text-ink-3",
      )}
    >
      {n}
    </span>
  );
}

// ─── Workload filter chip (per-person open-task count) ──────────────────────
function WorkloadChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
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
