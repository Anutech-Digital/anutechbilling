/**
 * Project task roadmap — an ordered checklist per project, each task assignable
 * to an employee who's on the project's team (project_labour). Owner/manager use
 * this to plan delivery and hand work to the team.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useConfirm } from "@/components/providers/confirm-provider";
import { formatDate, rupee } from "@/lib/utils";
import { toast } from "sonner";
import {
  useProjectTasks, useCreateProjectTask, useUpdateProjectTask, useDeleteProjectTask,
  useCreateProjectTasksBulk, generateProjectPlan, type PlannedTask,
} from "@/lib/queries/projects";
import type { ProjectTaskStatus } from "@/lib/supabase/database.types";

type TeamMember = { employee_id: string; employeeName: string };
export type ProjectSummary = { title: string; customerName: string; value: number; startDate: string | null; targetDate: string | null };

const STATUS_META: Record<ProjectTaskStatus, { label: string; kind: "muted" | "warning" | "success" }> = {
  todo:        { label: "To do",       kind: "muted" },
  in_progress: { label: "In progress", kind: "warning" },
  done:        { label: "Done",        kind: "success" },
};
const STATUS_ORDER: ProjectTaskStatus[] = ["todo", "in_progress", "done"];

export function ProjectTasks({ projectId, team, project }: { projectId: string; team: TeamMember[]; project?: ProjectSummary }) {
  const q = useProjectTasks(projectId);
  const create = useCreateProjectTask();
  const update = useUpdateProjectTask();
  const del = useDeleteProjectTask();
  const confirm = useConfirm();

  const [title, setTitle] = React.useState("");
  const [assignee, setAssignee] = React.useState<string>("none");
  const [due, setDue] = React.useState("");
  const [aiOpen, setAiOpen] = React.useState(false);

  const tasks = q.data ?? [];
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const pct = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0;

  async function add() {
    const t = title.trim();
    if (!t) return;
    await create.mutateAsync({
      projectId, title: t,
      assigneeId: assignee === "none" ? null : assignee,
      dueDate: due || null,
      seq: tasks.length,
    });
    setTitle(""); setAssignee("none"); setDue("");
  }

  return (
    <Card
      title="Roadmap & tasks"
      sub={tasks.length > 0 ? `${doneCount}/${tasks.length} done · ${pct}%` : "Plan the delivery — assign work to the team"}
    >
      {/* AI planner — ask for details, get a full explanation + ready tasks. */}
      {project && (
        <div className="mb-3">
          <Button variant="default" icon="sparkles" onClick={() => setAiOpen(true)}>
            Plan with AI
          </Button>
          <span className="text-[11px] text-ink-3 ml-2">Project ki detail do → explanation + tasks ban jaayenge</span>
        </div>
      )}

      {/* Progress bar */}
      {tasks.length > 0 && (
        <div className="mb-3 h-1.5 rounded-full bg-paper-2 overflow-hidden">
          <div className="h-full bg-emerald transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      {/* Task list */}
      {q.isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-ink-3 py-2">Abhi koi task nahi. Neeche pehla task add karo aur team member ko assign karo.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {tasks.map((t) => {
            const done = t.status === "done";
            const overdue = t.due_date && !done && new Date(t.due_date) < new Date();
            return (
              <li key={t.id} className="flex items-center gap-2 py-2 flex-wrap">
                {/* Quick done toggle */}
                <button type="button" aria-label="Toggle done"
                  onClick={() => update.mutate({ id: t.id, projectId, patch: { status: done ? "todo" : "done" } })}
                  className={`shrink-0 grid place-items-center h-5 w-5 rounded border ${done ? "bg-emerald border-emerald text-paper" : "border-hairline-strong text-transparent hover:border-emerald"}`}>
                  <Icon name="check" size={13} />
                </button>

                <span className={`flex-1 min-w-[8rem] text-sm ${done ? "line-through text-ink-3" : "text-ink"}`}>{t.title}</span>

                {/* Assignee */}
                <Select value={t.assignee_employee_id ?? "none"}
                  onValueChange={(v) => update.mutate({ id: t.id, projectId, patch: { assignee_employee_id: v === "none" ? null : v } })}>
                  <SelectTrigger className="h-7 w-[9.5rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {team.map((m) => <SelectItem key={m.employee_id} value={m.employee_id}>{m.employeeName}</SelectItem>)}
                  </SelectContent>
                </Select>

                {/* Status */}
                <Select value={t.status}
                  onValueChange={(v) => update.mutate({ id: t.id, projectId, patch: { status: v as ProjectTaskStatus } })}>
                  <SelectTrigger className="h-7 w-[7.5rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}
                  </SelectContent>
                </Select>

                {t.due_date && (
                  <Badge kind={overdue ? "danger" : "muted"} size="sm">{formatDate(t.due_date)}</Badge>
                )}

                <button type="button" aria-label="Delete task"
                  onClick={async () => { if (await confirm({ title: "Delete this task?", body: t.title, danger: true, confirmLabel: "Delete" })) del.mutate({ id: t.id, projectId }); }}
                  className="shrink-0 text-ink-3 hover:text-rose p-1">
                  <Icon name="trash" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add task */}
      <div className="mt-3 pt-3 border-t border-hairline flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[12rem]">
          <Input placeholder="e.g. Finalise database schema" value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        </div>
        <Select value={assignee} onValueChange={setAssignee}>
          <SelectTrigger className="h-9 w-[9.5rem] text-sm"><SelectValue placeholder="Assign to" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Unassigned</SelectItem>
            {team.map((m) => <SelectItem key={m.employee_id} value={m.employee_id}>{m.employeeName}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" className="w-[9rem]" value={due} onChange={(e) => setDue(e.target.value)} />
        <Button variant="primary" icon="plus" loading={create.isPending} disabled={!title.trim()} onClick={add}>Add task</Button>
      </div>

      {team.length === 0 && (
        <p className="text-[11px] text-ink-3 mt-2">
          Tip: is project ki <b>Team</b> me employees add karo (upar Labour section), phir unhe tasks assign kar paoge.
        </p>
      )}

      {project && aiOpen && (
        <AiPlanDialog projectId={projectId} team={team} project={project} startSeq={tasks.length} onClose={() => setAiOpen(false)} />
      )}
    </Card>
  );
}

// ── AI planner dialog ────────────────────────────────────────────────────────
function AiPlanDialog({ projectId, team, project, startSeq, onClose }: {
  projectId: string; team: TeamMember[]; project: ProjectSummary; startSeq: number; onClose: () => void;
}) {
  const bulk = useCreateProjectTasksBulk();
  const [details, setDetails] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [explanation, setExplanation] = React.useState("");
  const [rows, setRows] = React.useState<{ title: string; phase?: string; assigneeId: string }[]>([]);
  const [stub, setStub] = React.useState(false);

  // Match an AI-suggested assignee name to a team member id (else "none").
  function matchAssignee(name?: string): string {
    if (!name) return "none";
    const n = name.trim().toLowerCase();
    return team.find((m) => m.employeeName.toLowerCase() === n)?.employee_id ?? "none";
  }

  async function generate() {
    setGenerating(true);
    try {
      const plan = await generateProjectPlan({
        title: project.title, customer: project.customerName, value: project.value,
        startDate: project.startDate, targetDate: project.targetDate,
        details: details.trim() || undefined,
        team: team.map((m) => m.employeeName),
      });
      setExplanation(plan.explanation);
      setStub(plan.mode === "stub");
      setRows((plan.tasks as PlannedTask[]).map((t) => ({ title: t.title, phase: t.phase, assigneeId: matchAssignee(t.assignee) })));
    } catch (e) { toast.error((e as Error).message); }
    finally { setGenerating(false); }
  }

  async function createAll() {
    if (rows.length === 0) return;
    await bulk.mutateAsync({
      projectId,
      startSeq,
      tasks: rows.map((r) => ({ title: r.title, assigneeId: r.assigneeId === "none" ? null : r.assigneeId })),
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Icon name="sparkles" size={18} className="text-amber" /> AI project plan</DialogTitle>
          <DialogDescription>
            {project.title} · {project.customerName} · {rupee(project.value)}
            {project.targetDate ? ` · deadline ${formatDate(project.targetDate)}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[65vh] overflow-y-auto -mx-1 px-1">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-1">Project details / requirements</label>
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3}
              placeholder="e.g. Accounting software for a Pvt Ltd — GST invoicing, bank reconciliation, P&L, multi-user. Tech: web app. Client wants demo every 2 weeks."
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm" />
            <p className="text-[11px] text-ink-3 mt-1">Jitni detail doge, plan utna sahi banega. Team ({team.length}) ko tasks bant diye jaayenge.</p>
          </div>

          <Button variant="default" icon="sparkles" loading={generating} onClick={generate} className="w-full justify-center">
            {explanation || rows.length ? "Regenerate plan" : "Generate plan"}
          </Button>

          {stub && (explanation || rows.length > 0) && (
            <p className="text-[11px] text-amber-ink">AI key nahi mili — sample plan dikha rahe hain. Real AI ke liye Settings → Integrations me Gemini key daalo.</p>
          )}

          {explanation && (
            <div className="rounded-lg border border-hairline bg-paper-2/40 p-3">
              <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-1">Project explanation</div>
              <p className="text-[13px] text-ink-2 whitespace-pre-wrap leading-relaxed">{explanation}</p>
            </div>
          )}

          {rows.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-1.5">{rows.length} tasks — assign + edit before adding</div>
              <ul className="space-y-1.5">
                {rows.map((r, i) => (
                  <li key={i} className="flex items-center gap-2 flex-wrap rounded-md border border-hairline p-2">
                    {r.phase && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo/10 text-indigo shrink-0">{r.phase}</span>}
                    <span className="flex-1 min-w-[8rem] text-[13px] text-ink">{r.title}</span>
                    <Select value={r.assigneeId} onValueChange={(v) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, assigneeId: v } : x))}>
                      <SelectTrigger className="h-7 w-[9.5rem] text-[12px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {team.map((m) => <SelectItem key={m.employee_id} value={m.employee_id}>{m.employeeName}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <button type="button" aria-label="Remove" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-ink-3 hover:text-rose p-1">
                      <Icon name="x" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" icon="plus" loading={bulk.isPending} disabled={rows.length === 0} onClick={createAll}>
            Add {rows.length || ""} tasks to roadmap
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
