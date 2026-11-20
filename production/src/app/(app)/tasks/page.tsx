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
 *
 * R-2930: a Summary strip on top — the app's one collapsible KPI strip (R-2266): the closed
 * line carries Open / Overdue / Today / Done this week, opened it shows them as four cards and
 * a click on a card goes to its tab (Open → All, Done this week → Done). A search box (name,
 * notes, the lead / customer / deal it is about; `?q=`). Upcoming is split into "This week"
 * (due by Sunday, IST) and "Later". Cards, tabs and list count the same tasks (person filter +
 * search); "Done this week" is counted on the server when no search is typed, because the page
 * holds only the 100 most recently completed tasks.
 *
 * R-2937: a task is ONE line by default (name, whom it is about, people, priority, status, due
 * in words, actions) so a 1280×800 screen shows 12+ of them; "Comfortable" brings back the
 * roomy card and the choice is remembered on this browser (task-view-pref.ts). The group
 * headings (Overdue / Today / This week / Later / Done) stay stuck under the top bar while
 * their group scrolls. The title, quick-add and "Add task" share one line to leave the list
 * the room.
 *
 * R-2938: ONE filter bar — search, Status, Priority, Assignee, each option with its number
 * (task-filters.ts) — in place of the search box plus the person chips that wrapped onto two
 * lines. The three choices live in the address (`?status=&priority=&assignee=`), so a reload,
 * Back or a link (the Overview donuts) opens the same view; the Summary strip, the tabs and
 * the list all read the same filtered tasks.
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { TASK_PRIORITY_FILTERS, TASK_STATUS_FILTERS, TASK_TABS } from "@/lib/navigation/drilldown";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useTaskList, TASK_SELECT, type TaskBucket, type TaskWithLink } from "@/lib/queries/tasks";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import { TaskRow, taskLeadName } from "@/components/features/tasks/task-row";
import { TaskQuickAdd } from "@/components/features/tasks/task-quick-add";
import { useTaskDensity } from "@/components/features/tasks/task-view-pref";
import { TaskFilterBar } from "@/components/features/tasks/task-filter-bar";
import {
  hasTaskFilters, matchesTaskFilters, taskAssigneeOptions, taskFilterCounts,
  type TaskFilters, type TaskPriorityFilter, type TaskStatusFilter,
} from "@/components/features/tasks/task-filters";
import { groupTasks, taskTabCounts, type TaskGroupId } from "@/components/features/tasks/task-groups";
import { istWeekBounds, matchesTaskSearch, taskSections, taskSummary, type TaskSection } from "@/components/features/tasks/task-overview";
import { KPI } from "@/components/shared/kpi";
import { CollapsibleKpiStrip, StripFact } from "@/components/shared/collapsible-kpi-strip";
import { istDayStartUtc, addDaysISO, toIstDate } from "@/lib/dates/ist";
import { useTeamMembers } from "@/lib/queries/team";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useTaskCollaborators } from "@/lib/queries/task-collaborators";
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
    else {
      toast.error("That task no longer exists.", {
        description: "It was deleted, or it isn't shared with you. Showing all tasks.",
      });
      setTaskParam("");
    }
  }, [taskParam, linkedTask.isSuccess, linkedTask.data, setTaskParam]);
  /* R-1535: a FAILED read is not "no longer exists" — keep ?task= and offer Try again. */
  const taskErrorShown = React.useRef<number | null>(null);
  const { isError: linkedTaskFailed, error: linkedTaskError, errorUpdatedAt: linkedTaskErrorAt, refetch: refetchLinkedTask } = linkedTask;
  React.useEffect(() => {
    if (!taskParam || !linkedTaskFailed || taskErrorShown.current === linkedTaskErrorAt) return;
    taskErrorShown.current = linkedTaskErrorAt;
    // A failed READ: fixed words on screen, the raw text in the console (§11).
    console.error("[tasks] ?task= read failed", linkedTaskError);
    toast.error("This task couldn't be opened.", {
      description: "The task was not removed — it just couldn't be loaded. Try again in a moment.",
      action: { label: "Try again", onClick: () => void refetchLinkedTask() },
      duration: 10_000,
    });
  }, [taskParam, linkedTaskFailed, linkedTaskError, linkedTaskErrorAt, refetchLinkedTask]);
  const closeEditing = React.useCallback(() => {
    setEditingTask(null);
    if (taskParam) setTaskParam("");
  }, [taskParam, setTaskParam]);

  const { data: me, isLoading: meLoading } = useCurrentUser();
  const list = useTaskList(me?.tenantId);
  const { data: members = [], isSuccess: teamLoaded } = useTeamMembers();
  const memberById = React.useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  /* R-2933: who works with each task's owner. Its own read — if it fails the list still shows. */
  const { data: collaborators } = useTaskCollaborators(me?.tenantId);
  const collaboratorsOf = React.useCallback(
    (taskId: string) => (collaborators?.get(taskId) ?? []).flatMap((id) => memberById.get(id) ?? []),
    [collaborators, memberById],
  );
  const [assigneeParam, setAssignee] = useUrlState("assignee", "all"); // R-286: survives Back
  /* R-2938: my own id in the address (Reports → Team tasks links by id) is "Mine". */
  const assignee = me?.userId && assigneeParam === me.userId ? "mine" : assigneeParam;
  const [query, setQuery] = useUrlState("q", ""); // R-2930: search, survives Back / reload
  /* R-2938: Status and Priority live in the address too; an unknown value reads as "all". */
  const [status, setStatus] = useUrlChoice<TaskStatusFilter>("status", TASK_STATUS_FILTERS, "all");
  const [priority, setPriority] = useUrlChoice<TaskPriorityFilter>("priority", TASK_PRIORITY_FILTERS, "all");
  const filters: TaskFilters = React.useMemo(() => ({ status, priority, assignee }), [status, priority, assignee]);
  const filtered = hasTaskFilters(filters);
  /* A Status / Priority pick is a narrowing the empty list must explain; a person alone is not
     (their empty Overdue tab is still "Inbox zero"). */
  const narrowedByBar = status !== "all" || priority !== "all";
  const clearFilters = React.useCallback(() => {
    setStatus("all"); setPriority("all"); setAssignee("all");
  }, [setStatus, setPriority, setAssignee]);

  const tasks = React.useMemo(() => list.data ?? [], [list.data]);
  /* R-471: a task moves to Overdue the minute its time passes — re-group once a minute so
     the page does not wait for a reload to agree with the row's "⚠ Overdue". */
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  /* R-2930: search narrows the same set the cards, tabs and list all read. The list follows
     the typing a beat behind (deferred), so a long list never makes the box lag. */
  const search = React.useDeferredValue(query).trim();
  const searched = React.useMemo(
    () => (search ? tasks.filter((t) => matchesTaskSearch(t, search)) : tasks),
    [tasks, search],
  );
  /* R-2938: the filter bar narrows that set; Summary, tabs and list all read `visible`. */
  const visible = React.useMemo(
    () => (filtered ? searched.filter((t) => matchesTaskFilters(t, filters, me?.userId)) : searched),
    [searched, filtered, filters, me?.userId],
  );
  /* The number beside each option: what picking it would show, the search and the other choices kept. */
  const optionCounts = React.useMemo(() => taskFilterCounts(searched, filters, me?.userId), [searched, filters, me?.userId]);
  const today = toIstDate(now);
  const assigneeOptions = React.useMemo(
    () => taskAssigneeOptions(members, tasks, me?.userId, assignee, today, teamLoaded),
    [members, tasks, me?.userId, assignee, today, teamLoaded],
  );
  const groups = React.useMemo(() => groupTasks(visible, now), [visible, now]);
  const summary = React.useMemo(() => taskSummary(visible, now), [visible, now]);
  /* "Done this week" — the page holds only the 100 newest completed tasks, so without a search
     (or a Status / Priority choice) the number is counted on the server (same person filter,
     IST week Monday–Sunday). */
  const week = istWeekBounds(now);
  const doneOwner = assignee === "all" ? null : assignee === "mine" ? me?.userId ?? null : assignee;
  const doneWeek = useQuery({
    queryKey: ["tasks", "done-this-week", me?.tenantId, week.start, assignee === "all" ? "all" : doneOwner],
    enabled: !!me?.tenantId && (assignee === "all" || !!doneOwner),
    queryFn: async (): Promise<number> => {
      let q = createClient().from("tasks").select("id", { count: "exact", head: true })
        .eq("tenant_id", me!.tenantId).eq("status", "done")
        .gte("completed_at", istDayStartUtc(week.start).toISOString())
        .lt("completed_at", istDayStartUtc(addDaysISO(week.end, 1)).toISOString());
      if (doneOwner) q = q.eq("owner_id", doneOwner);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
  });
  /* The server count knows only the person. Status = Done does not narrow the done tasks, so it keeps the exact count. */
  const narrowedOnPage = !!search || priority !== "all" || (status !== "all" && status !== "done");
  const doneThisWeek = narrowedOnPage ? summary.doneThisWeek : doneWeek.data ?? summary.doneThisWeek;
  // R-1416: "All" counts what the All list shows — Done included.
  const counts = taskTabCounts(groups);

  const tabs: TabBarItem[] = [
    { id: "all",      label: "All",      count: counts.all },
    { id: "overdue",  label: "Overdue",  count: counts.overdue,  dot: "rose"    },
    { id: "today",    label: "Today",    count: counts.today,    dot: "amber"   },
    { id: "upcoming", label: "Upcoming", count: counts.upcoming, dot: "indigo"  },
    { id: "done",     label: "Done",     count: counts.done,     dot: "emerald" },
  ];

  /* R-2930: Upcoming renders as "This week" + "Later"; both belong to the Upcoming tab. */
  const shown: TaskSection<TaskWithLink>[] = React.useMemo(
    () => taskSections(groups, now).filter((s) => s.tasks.length > 0 && (tab === "all" || s.group === tab)),
    [groups, now, tab],
  );
  const [doneOpen, setDoneOpen] = React.useState(false);
  const [density, setDensity] = useTaskDensity(me?.userId); // R-2937: one line (default) or Comfortable; remembered per user
  const compact = density === "compact";

  const isLoading = meLoading || (!!me?.tenantId && list.isLoading);

  return (
    /* 1100px: the width of the Tasks tabs strip above (tasks-tabs.tsx, R-2939) and of Overview /
       Calendar, so the four pages line up. */
    <div className="p-4 md:p-6 lg:p-8 max-w-[1100px] mx-auto">
      {/* Header — R-2937: title, quick-add and "Add task" on one line (the list needs the height). */}
      <div className="flex items-start gap-3 flex-wrap mb-3">
        <h1 className="font-serif text-2xl md:text-3xl leading-9">Tasks</h1>
        <TaskQuickAdd className="flex-1 min-w-[16rem]" />
        <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
          Add task
        </Button>
      </div>

      {/* R-2930: summary — the app's one KPI strip (closed: numbers on the line; open: cards).
          A failed read shows no numbers: "0 overdue" above an error would be a false all-clear. */}
      {!list.error && (
        <CollapsibleKpiStrip
          stripId="tasks"
          userId={me?.userId}
          title="Summary"
          summary={isLoading ? null : (
            <>
              <StripFact label="Open" value={summary.open} />
              <StripFact label="Overdue" value={summary.overdue} tone={summary.overdue > 0 ? "rose" : "default"} />
              <StripFact label="Today" value={summary.today} tone={summary.today > 0 ? "amber" : "default"} />
              <StripFact label="Done this week" value={doneThisWeek} tone="emerald" />
            </>
          )}
        >
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="task-summary">
            <KPI label="Open" value={summary.open} loading={isLoading} icon="clock" onClick={() => setTab("all")} />
            <KPI label="Overdue" value={summary.overdue} loading={isLoading} icon="alert" accent={summary.overdue > 0 ? "rose" : "ink"} onClick={() => setTab("overdue")} />
            <KPI label="Today" value={summary.today} loading={isLoading} icon="calendar" accent={summary.today > 0 ? "amber" : "ink"} onClick={() => setTab("today")} />
            <KPI label="Done this week" value={doneThisWeek} loading={isLoading} icon="check" accent="emerald" onClick={() => setTab("done")} />
          </div>
        </CollapsibleKpiStrip>
      )}

      {/* R-2938: one filter bar — search, Status, Priority, Assignee. R-2937's view switch ends the line. */}
      <TaskFilterBar
        query={query}
        onQuery={setQuery}
        filters={filters}
        onStatus={setStatus}
        onPriority={setPriority}
        onAssignee={setAssignee}
        onClear={clearFilters}
        counts={optionCounts}
        assignees={assigneeOptions}
        showAssignee={members.length > 1 || assignee !== "all"}
      >
        {/* One switch, on = the roomy card. aria-pressed says which view is showing. */}
        <Button
          type="button"
          size="sm"
          variant="default"
          icon="layout"
          aria-pressed={!compact}
          title={compact ? "Show each task as a roomy card" : "Show each task on one line"}
          onClick={() => setDensity(compact ? "comfortable" : "compact")}
          className={cn("ml-auto shrink-0", !compact && "border-amber bg-amber-soft text-amber-ink hover:bg-amber-soft")}
        >
          Comfortable
        </Button>
      </TaskFilterBar>

      {/* Tabs */}
      <div className="mb-3">
        <TabBar items={tabs} value={tab} onChange={(v) => setTab(v as TaskBucket)} />
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {(compact ? [0, 1, 2, 3, 4, 5] : [0, 1, 2]).map((i) => <Skeleton key={i} className={compact ? "h-8" : "h-20"} />)}
        </div>
      ) : list.error ? (
        <EmptyState
          icon="alert"
          title="Couldn't load your tasks"
          body="Something went wrong fetching your tasks. This isn't 'inbox zero' — check your connection and try again."
          action={<Button variant="primary" icon="refresh" onClick={() => void list.refetch()}>Retry</Button>}
          compact
        />
      ) : shown.length === 0 && (search || narrowedByBar) && counts.all > 0 ? (
        /* The search / filters found tasks — just not in this tab. Say so, and take the person there. */
        <EmptyState
          icon="search"
          title={search ? `Nothing in this tab matches “${search}”` : "Nothing in this tab matches the filters"}
          body={`${counts.all} matching ${counts.all === 1 ? "task is" : "tasks are"} in other tabs.`}
          action={<Button variant="primary" icon="search" onClick={() => setTab("all")}>Show all matches</Button>}
          compact
        />
      ) : shown.length === 0 && narrowedByBar ? (
        /* R-2938: nothing passes the Status / Priority / Assignee choice (with or without a search). */
        <EmptyState
          icon="filter"
          title={search ? `No tasks match “${search}” with these filters` : "No tasks match these filters"}
          body="Pick another Status, Priority or Assignee, or clear the filters to see every task."
          action={<Button variant="default" icon="x" onClick={clearFilters}>Clear filters</Button>}
          compact
        />
      ) : shown.length === 0 && search ? (
        <EmptyState
          icon="search"
          title={`No tasks match “${search}”`}
          body="Check the spelling, or clear the search to see every task."
          action={<Button variant="default" icon="x" onClick={() => setQuery("")}>Clear search</Button>}
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
        <div className={compact ? "space-y-2" : "space-y-4"} data-testid="task-list" data-density={density}>
          {shown.map((g) => {
            const foldable = g.id === "done" && tab === "all" && !search && status !== "done"; // a search, or Status = Done, shows its Done matches
            return (
              <section key={g.id} aria-labelledby={`task-group-${g.id}`}>
                {/* R-2937: the heading stays under the top bar (h-14) while its group scrolls. */}
                <h2
                  id={`task-group-${g.id}`}
                  data-testid="task-group-heading"
                  className="sticky top-14 z-10 -mx-1 mb-1 flex items-center rounded-sm bg-paper-2/95 px-2 py-1 backdrop-blur-sm"
                >
                  {foldable ? (
                    <button
                      type="button"
                      onClick={() => setDoneOpen((o) => !o)}
                      aria-expanded={doneOpen}
                      className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-ink-3 hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                    >
                      <Icon name={doneOpen ? "chevron_down" : "chevron_right"} size={14} />
                      {g.label}
                      <GroupCount id={g.group} n={g.tasks.length} />
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-ink-3">
                      {g.label}
                      <GroupCount id={g.group} n={g.tasks.length} />
                    </span>
                  )}
                </h2>
                {(!foldable || doneOpen) && (
                  /* One-line rows fill the card edge to edge (no inner padding) — the name gets the width. */
                  <Card flush={compact ? "clip" : undefined}>
                    <ul className={cn("divide-y divide-hairline", compact && "overflow-hidden rounded-lg")}>
                      {g.tasks.map((t) => (
                        <TaskRow key={t.id} task={t} onEdit={setEditingTask} assignee={t.owner_id ? memberById.get(t.owner_id) : null} meId={me?.userId} collaborators={collaboratorsOf(t.id)} density={density} now={now} />
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
        /* R-2937: the heading band is paper-2, so the quiet pill is paper with a hairline. */
        id === "overdue" ? "bg-rose text-white" : "border border-hairline bg-paper text-ink-2",
      )}
    >
      {n}
    </span>
  );
}
