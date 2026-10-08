/**
 * Apprentice Academy — staff side (R-149, phase 1).
 *
 * Overview · Apprentices · Review queue · Curriculum. A mentor sees only the apprentices
 * they mentor (RLS); owner / manager see and add everyone. The apprentice's own screen is
 * /learn — a separate area with no access to company data.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FormField } from "@/components/ui/label";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useTeamMembers } from "@/lib/queries/team";
import {
  useApprentices, usePrograms, useAcademyTasks, useSubmissions, useSaveApprentice, useLoadDefaultProgram,
  APPRENTICE_STATUS_LABEL, type Apprentice,
} from "@/lib/queries/academy";
import { ReviewTaskCard } from "@/components/features/academy/review-task-card";
import { ScoreChip } from "@/components/features/academy/performance-card";
import { SkillsList } from "@/components/features/academy/skills-list";
import { computePerformance, type Performance } from "@/lib/academy/performance";
import { useEvaluations } from "@/lib/queries/academy";

type Tab = "overview" | "apprentices" | "review" | "curriculum";

export default function AcademyPage() {
  const me = useCurrentUser().data;
  const canManage = me?.role === "owner" || me?.role === "manager";
  const apprentices = useApprentices();
  const tasks = useAcademyTasks();
  const programs = usePrograms();
  const [tab, setTab] = React.useState<Tab>("overview");
  const [edit, setEdit] = React.useState<Apprentice | "new" | null>(null);

  const list = React.useMemo(() => apprentices.data ?? [], [apprentices.data]);
  const allTasks = React.useMemo(() => tasks.data ?? [], [tasks.data]);
  const today = istToday();
  const toReview = allTasks.filter((t) => t.status === "submitted");
  const dueToday = allTasks.filter((t) => t.due_date === today && t.status !== "completed");
  const done = allTasks.filter((t) => t.status === "completed").length;
  const completion = allTasks.length ? Math.round((done / allTasks.length) * 100) : 0;
  const nameOf = (id: string) => list.find((a) => a.id === id)?.full_name ?? "Apprentice";
  const allSubs = useSubmissions(allTasks.map((t) => t.id));
  const allEvals = useEvaluations();
  /* Phase 2 (R-150): one score per apprentice, computed from their own rows. */
  const perfOf = React.useMemo(() => {
    const m = new Map<string, Performance>();
    for (const a of list) {
      const tasksA = allTasks.filter((t) => t.apprentice_id === a.id);
      const ids = new Set(tasksA.map((t) => t.id));
      m.set(a.id, computePerformance({
        tasks: tasksA,
        submissions: (allSubs.data ?? []).filter((s) => ids.has(s.task_id)),
        evaluations: (allEvals.data ?? []).filter((e) => e.apprentice_id === a.id),
        today,
      }));
    }
    return m;
  }, [list, allTasks, allSubs.data, allEvals.data, today]);
  const scored = list.map((a) => perfOf.get(a.id)?.score).filter((x): x is number => x != null);
  const avgScore = scored.length ? Math.round(scored.reduce((s, x) => s + x, 0) / scored.length) : null;
  const atRisk = list.filter((a) => (perfOf.get(a.id)?.alerts.length ?? 0) > 0 && a.status === "active");

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Team</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Apprentice Academy</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            Learn → practice → submit → review → improve. {canManage ? "Add apprentices, give each a mentor, assign tasks and review their work." : "Your apprentices, their tasks and work waiting for your review."}
          </p>
        </div>
        {canManage && <Button variant="primary" icon="plus" onClick={() => setEdit("new")}>Add apprentice</Button>}
      </div>

      <TabBar
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        items={[
          { id: "overview", label: "Overview" },
          { id: "apprentices", label: "Apprentices", count: list.length },
          { id: "review", label: "Review queue", count: toReview.length, dot: toReview.length ? "amber" : undefined },
          { id: "curriculum", label: "Curriculum" },
        ]}
      />

      {tab === "overview" && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <Kpi label="Apprentices" value={list.length} />
            <Kpi label="Active" value={list.filter((a) => a.status === "active").length} />
            <Kpi label="Tasks due today" value={dueToday.length} />
            <Kpi label="Waiting for review" value={toReview.length} tone={toReview.length ? "amber" : undefined} />
            <Kpi label="Tasks completed" value={`${completion}%`} />
            <Kpi label="Average performance" value={avgScore == null ? "—" : `${avgScore}/100`} />
            <Kpi label="Need attention" value={atRisk.length} tone={atRisk.length ? "amber" : undefined} />
          </div>
          {list.length === 0 && !apprentices.isLoading ? (
            <Card className="py-6">
              <EmptyState icon="award" title={canManage ? "No apprentices yet" : "No apprentices assigned to you"}
                body={canManage ? "Start with the curriculum, then add your first apprentice and pick their mentor." : "When an owner makes you someone's mentor, they appear here."}
                action={canManage ? <Button variant="primary" icon="plus" onClick={() => setEdit("new")}>Add apprentice</Button> : undefined} />
            </Card>
          ) : (
            <>
            {atRisk.length > 0 && (
              <Card className="p-5 border-2 border-red-ink/30">
                <h2 className="font-serif text-lg mb-3 text-red-ink">Needs attention</h2>
                <ul className="divide-y divide-hairline">
                  {atRisk.map((a) => (
                    <li key={a.id} className="py-2.5 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link href={`/academy/${a.id}` as Route} className="font-semibold text-ink hover:text-amber-ink">{a.full_name}</Link>
                        <p className="text-xs text-red-ink">{perfOf.get(a.id)!.alerts.join(" · ")}</p>
                      </div>
                      <ScoreChip perf={perfOf.get(a.id)!} />
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <Card className="p-5">
              <h2 className="font-serif text-lg mb-3">Waiting for your review</h2>
              {toReview.length === 0 ? (
                <p className="text-sm text-ink-3">Nothing to review right now.</p>
              ) : (
                <ul className="divide-y divide-hairline">
                  {toReview.slice(0, 5).map((t) => (
                    <li key={t.id} className="py-2.5 flex items-center justify-between gap-3">
                      <span className="text-sm"><b>{nameOf(t.apprentice_id)}</b> · {t.title}</span>
                      <Button size="sm" variant="outline" onClick={() => setTab("review")}>Review</Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            </>
          )}
        </div>
      )}

      {tab === "apprentices" && (
        apprentices.isLoading ? <Skeleton className="h-40" /> : list.length === 0 ? (
          <Card className="py-6"><EmptyState icon="users" title="No apprentices yet" body={canManage ? "Add your first apprentice." : "None assigned to you."} /></Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((a) => {
              const mine = allTasks.filter((t) => t.apprentice_id === a.id);
              const pct = mine.length ? Math.round((mine.filter((t) => t.status === "completed").length / mine.length) * 100) : 0;
              return (
                <Card key={a.id} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/academy/${a.id}` as Route} className="font-semibold text-ink hover:text-amber-ink">{a.full_name}</Link>
                      <p className="text-xs text-ink-3">{a.code}{a.course ? ` · ${a.course}` : ""}{a.start_date ? ` · from ${formatDate(a.start_date, "short")}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      <Badge kind={a.status === "active" ? "success" : a.status === "dropped" ? "danger" : "muted"} size="sm">{APPRENTICE_STATUS_LABEL[a.status] ?? a.status}</Badge>
                      {a.user_id && <Badge kind="info" size="sm">Has login</Badge>}
                    </div>
                  </div>
                  {perfOf.get(a.id) && <ScoreChip perf={perfOf.get(a.id)!} />}
                  <div>
                    <div className="flex justify-between text-xs text-ink-3 mb-1"><span>Tasks completed</span><span className="tabular-nums">{pct}% · {mine.length} task{mine.length === 1 ? "" : "s"}</span></div>
                    <div className="h-2 rounded-full bg-paper-2 overflow-hidden"><div className="h-full bg-emerald" style={{ width: `${pct}%` }} /></div>
                  </div>
                  <div className="flex gap-2">
                    <Link href={`/academy/${a.id}` as Route} className="text-sm font-semibold text-amber-ink hover:underline">Open →</Link>
                    {canManage && <button type="button" className="text-sm text-ink-3 hover:text-ink" onClick={() => setEdit(a)}>Edit</button>}
                  </div>
                </Card>
              );
            })}
          </div>
        )
      )}

      {tab === "review" && <ReviewQueue taskIds={toReview.map((t) => t.id)} nameOf={nameOf} />}

      {tab === "curriculum" && (
        <div className="space-y-4"><CurriculumTab canManage={canManage} loading={programs.isLoading} data={programs.data} /><SkillsList canManage={canManage} /></div>
      )}

      {edit && <ApprenticeDialog apprentice={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "amber" }) {
  return (
    <Card className="p-4">
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</p>
      <p className={`font-serif text-2xl mt-1 tabular-nums ${tone === "amber" ? "text-amber-ink" : "text-ink"}`}>{value}</p>
    </Card>
  );
}

function ReviewQueue({ taskIds, nameOf }: { taskIds: string[]; nameOf: (id: string) => string }) {
  const tasks = useAcademyTasks();
  const subs = useSubmissions(taskIds);
  const list = (tasks.data ?? []).filter((t) => taskIds.includes(t.id));
  if (list.length === 0) return <Card className="py-6"><EmptyState icon="check" title="Nothing to review" body="Submitted work shows up here." /></Card>;
  return (
    <div className="space-y-3">
      {list.map((t) => (
        <ReviewTaskCard key={t.id} task={t} apprenticeName={nameOf(t.apprentice_id)}
          submissions={(subs.data ?? []).filter((s) => s.task_id === t.id)} />
      ))}
    </div>
  );
}

function CurriculumTab({ canManage, loading, data }: { canManage: boolean; loading: boolean; data?: ReturnType<typeof usePrograms>["data"] }) {
  const load = useLoadDefaultProgram();
  if (loading) return <Skeleton className="h-40" />;
  const programs = data?.programs ?? [];
  if (programs.length === 0) {
    return (
      <Card className="py-6">
        <EmptyState icon="award" title="No curriculum yet"
          body="Load the AI-Assisted Software Development program: 7 modules from computer basics to Claude Code and real company projects."
          action={canManage ? <Button variant="primary" loading={load.isPending} onClick={() => load.mutate()}>Load the program</Button> : undefined} />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {programs.map((p) => (
        <Card key={p.id} className="p-5 space-y-4">
          <div>
            <h2 className="font-serif text-xl">{p.name}</h2>
            {p.description && <p className="text-sm text-ink-3 mt-1">{p.description}</p>}
          </div>
          <ol className="grid gap-3 md:grid-cols-2">
            {(data?.modules ?? []).filter((m) => m.program_id === p.id).map((m) => (
              <li key={m.id} className="rounded-lg border border-hairline p-3">
                <p className="font-semibold text-ink">Module {m.position} — {m.title}</p>
                <p className="text-xs text-ink-3 mt-1">{m.topics.join(" · ")}</p>
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}

function ApprenticeDialog({ apprentice, onClose }: { apprentice: Apprentice | null; onClose: () => void }) {
  const save = useSaveApprentice();
  const team = useTeamMembers();
  const programs = usePrograms();
  const a = apprentice;
  const [f, setF] = React.useState({
    full_name: a?.full_name ?? "", email: a?.email ?? "", phone: a?.phone ?? "",
    date_of_birth: a?.date_of_birth ?? "", qualification: a?.qualification ?? "", institute: a?.institute ?? "",
    course: a?.course ?? "", joining_date: a?.joining_date ?? "", start_date: a?.start_date ?? "", end_date: a?.end_date ?? "",
    program_id: a?.program_id ?? "", mentor_user_id: a?.mentor_user_id ?? "", status: a?.status ?? "active",
    address: a?.address ?? "", emergency_contact_name: a?.emergency_contact_name ?? "", emergency_contact_phone: a?.emergency_contact_phone ?? "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const nul = (v: string) => (v.trim() ? v.trim() : null);
  const selectCls = "w-full h-10 rounded-lg border border-hairline-strong bg-paper px-3 text-sm";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>{a ? `Edit ${a.full_name}` : "Add apprentice"}</DialogTitle>
          <DialogDescription>Basics now, the rest any time. The email is what they will sign in with.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3 max-h-[65vh] overflow-y-auto pr-1" onSubmit={(e) => {
          e.preventDefault();
          if (f.end_date && f.start_date && f.end_date < f.start_date) return;
          save.mutate({
            id: a?.id, full_name: f.full_name.trim(), email: nul(f.email), phone: nul(f.phone), date_of_birth: nul(f.date_of_birth),
            qualification: nul(f.qualification), institute: nul(f.institute), course: nul(f.course), joining_date: nul(f.joining_date),
            start_date: nul(f.start_date), end_date: nul(f.end_date), program_id: nul(f.program_id), mentor_user_id: nul(f.mentor_user_id),
            status: f.status, address: nul(f.address), emergency_contact_name: nul(f.emergency_contact_name), emergency_contact_phone: nul(f.emergency_contact_phone),
          }, { onSuccess: onClose });
        }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Full name" required htmlFor="ap-name"><Input id="ap-name" value={f.full_name} onChange={set("full_name")} autoFocus required minLength={2} /></FormField>
            <FormField label="Email (sign-in)" htmlFor="ap-email"><Input id="ap-email" type="email" value={f.email} onChange={set("email")} /></FormField>
            <FormField label="Mobile" htmlFor="ap-phone"><Input id="ap-phone" inputMode="tel" value={f.phone} onChange={set("phone")} /></FormField>
            <FormField label="Date of birth" htmlFor="ap-dob"><Input id="ap-dob" type="date" value={f.date_of_birth} onChange={set("date_of_birth")} /></FormField>
            <FormField label="Mentor" htmlFor="ap-mentor">
              <select id="ap-mentor" className={selectCls} value={f.mentor_user_id} onChange={set("mentor_user_id")}>
                <option value="">— Pick a mentor —</option>
                {/* Phase 1: mentors are owners / managers — the only staff who can open the Academy. */}
                {(team.data ?? []).filter((m) => m.role === "owner" || m.role === "manager").map((m) => <option key={m.id} value={m.id}>{m.full_name ?? m.email}</option>)}
              </select>
            </FormField>
            <FormField label="Training program" htmlFor="ap-program">
              <select id="ap-program" className={selectCls} value={f.program_id} onChange={set("program_id")}>
                <option value="">— None yet —</option>
                {(programs.data?.programs ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>
            <FormField label="Start date" htmlFor="ap-start"><Input id="ap-start" type="date" value={f.start_date} onChange={set("start_date")} /></FormField>
            <FormField label="End date" htmlFor="ap-end"><Input id="ap-end" type="date" value={f.end_date} onChange={set("end_date")} /></FormField>
            <FormField label="Qualification" htmlFor="ap-qual"><Input id="ap-qual" value={f.qualification} onChange={set("qualification")} placeholder="e.g. BCA, 12th" /></FormField>
            <FormField label="College / institute" htmlFor="ap-inst"><Input id="ap-inst" value={f.institute} onChange={set("institute")} /></FormField>
            <FormField label="Degree / course" htmlFor="ap-course"><Input id="ap-course" value={f.course} onChange={set("course")} /></FormField>
            <FormField label="Joining date" htmlFor="ap-join"><Input id="ap-join" type="date" value={f.joining_date} onChange={set("joining_date")} /></FormField>
            <FormField label="Status" htmlFor="ap-status">
              <select id="ap-status" className={selectCls} value={f.status} onChange={set("status")}>
                {Object.entries(APPRENTICE_STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </FormField>
            <FormField label="Address" htmlFor="ap-addr"><Input id="ap-addr" value={f.address} onChange={set("address")} /></FormField>
            <FormField label="Emergency contact" htmlFor="ap-ecn"><Input id="ap-ecn" value={f.emergency_contact_name} onChange={set("emergency_contact_name")} /></FormField>
            <FormField label="Emergency phone" htmlFor="ap-ecp"><Input id="ap-ecp" inputMode="tel" value={f.emergency_contact_phone} onChange={set("emergency_contact_phone")} /></FormField>
          </div>
          {f.end_date && f.start_date && f.end_date < f.start_date && <p className="text-sm text-red-ink">End date is before the start date.</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
