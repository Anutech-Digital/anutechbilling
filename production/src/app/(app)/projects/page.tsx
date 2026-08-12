/**
 * Project Sales — one-time / custom-software deals billed in milestones.
 *
 * Separate from subscription reselling: each project has a taxable contract
 * value + GST, an installment schedule, and its own receivable. No renewal.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import { useProjectSales, type ProjectSaleWithTotals } from "@/lib/queries/projects";
import { rupee, formatDate, daysBetween } from "@/lib/utils";
import { CreateProjectDialog } from "@/components/features/projects/create-project-dialog";
import { CreateProjectQuoteDialog } from "@/components/features/projects/create-project-quote-dialog";

export default function ProjectsPage() {
  const router = useRouter();
  const { data: projects, isLoading } = useProjectSales();
  const [addOpen, setAddOpen] = React.useState(false);
  const [quoteOpen, setQuoteOpen] = React.useState(false);
  const [kpiOpen, setKpiOpen] = React.useState(true);

  const totalValue = (projects ?? []).reduce((s, p) => s + p.total_amount, 0);
  const totalRecv  = (projects ?? []).reduce((s, p) => s + p.receivable, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Project Sales</h1>
          <p className="text-sm text-ink-3 mt-1">
            One-time sales like custom software — billed in milestones, with proper GST invoices. No subscription.
          </p>
        </div>
        <div className="hidden md:flex gap-2">
          <Button variant="default" icon="plus" onClick={() => setAddOpen(true)}>
            New project
          </Button>
          <Button variant="primary" icon="file" onClick={() => setQuoteOpen(true)}>
            New quotation
          </Button>
        </div>
      </div>

      {/* Collapsible Project Sales Analytics Banner */}
      {!isLoading && projects && projects.length > 0 && (
        <div className="mb-6 bg-paper border border-hairline rounded-lg overflow-hidden transition-all shadow-xs">
          <button
            type="button"
            onClick={() => setKpiOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Icon name="bar_chart" size={15} className="text-amber-ink" />
              <span className="font-semibold text-ink">Project Sales Revenue &amp; Profit</span>
              <span className="text-ink-3">·</span>
              <span className="text-ink-2 font-mono font-medium">Projects: <b className="text-ink">{projects.length}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">Contract Value: <b className="text-amber-ink">{rupee(totalValue, { compact: true })}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">Outstanding: <b className="text-rose-600">{rupee(totalRecv, { compact: true })}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">Collected: <b className="text-emerald">{rupee(totalValue - totalRecv, { compact: true })}</b></span>
            </div>
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0 ml-2">
              <span>{kpiOpen ? "Collapse" : "Expand"}</span>
              <Icon name={kpiOpen ? "chevron_up" : "chevron_down"} size={14} />
            </div>
          </button>

          {kpiOpen && (
            <div className="p-3 border-t border-hairline bg-paper">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <Stat label="Projects" value={String(projects.length)} />
                <Stat label="Total contract value" value={rupee(totalValue, { compact: true })} />
                <Stat label="Outstanding" value={rupee(totalRecv, { compact: true })} tone={totalRecv > 0 ? "rose" : "ink"} />
                <Stat label="Collected" value={rupee(totalValue - totalRecv, { compact: true })} tone="emerald" />
              </div>
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40 rounded-lg" />)}
        </div>
      ) : !projects || projects.length === 0 ? (
        <Card>
          <EmptyState
            icon="package"
            title="No project sales yet."
            body="Sell custom software or any one-time project as a product. Create a project, set the milestone schedule, and raise a GST tax invoice per milestone."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>New project</Button>}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onOpen={() => router.push(`/projects/${p.id}` as Route)} />
          ))}
        </div>
      )}

      <CreateProjectDialog open={addOpen} onOpenChange={setAddOpen} />
      <CreateProjectQuoteDialog open={quoteOpen} onOpenChange={setQuoteOpen} />
      <FAB icon="file" label="New quotation" onClick={() => setQuoteOpen(true)} />
    </div>
  );
}

function Stat({ label, value, tone = "ink" }: { label: string; value: string; tone?: "ink" | "rose" | "emerald" }) {
  const c = tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : "text-ink";
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">{label}</p>
      <p className={`font-serif text-2xl mt-1 ${c}`}>{value}</p>
    </div>
  );
}

function ProjectCard({ project, onOpen }: { project: ProjectSaleWithTotals; onOpen: () => void }) {
  const pct = project.total_amount > 0 ? Math.round((project.paid / project.total_amount) * 100) : 0;
  const done = project.status === "completed" || project.status === "cancelled";
  const daysLeft = project.target_date ? daysBetween(new Date().toISOString().slice(0, 10), project.target_date) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left w-full rounded-lg border border-hairline bg-paper hover:border-hairline-strong hover:shadow-md transition-all p-5"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">{project.customer_name}</p>
          <h3 className="font-semibold text-ink truncate mt-0.5">{project.title}</h3>
        </div>
        <Badge
          kind={project.status === "completed" ? "success" : project.status === "cancelled" ? "muted" : project.status === "quoted" ? "info" : "warning"}
          size="sm"
        >
          {project.status === "completed" ? "Completed" : project.status === "cancelled" ? "Cancelled" : project.status === "quoted" ? "Quotation" : "Active"}
        </Badge>
      </div>

      <div className="border-t border-hairline pt-3 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-ink-3">Contract (incl GST)</span>
          <span className="font-mono text-sm text-ink">{rupee(project.total_amount)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-ink-3">Outstanding</span>
          <span className={`font-mono text-sm ${project.receivable > 0 ? "text-rose" : "text-emerald"}`}>
            {rupee(project.receivable)}
          </span>
        </div>
        {/* Costing — cost (external + labour) + profit/margin */}
        {((project.costTotal ?? 0) + (project.labourTotal ?? 0) > 0) && (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-ink-3">Cost</span>
              <span className="font-mono text-sm text-ink-2">{rupee((project.costTotal ?? 0) + (project.labourTotal ?? 0))}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-ink-3">Profit</span>
              <span className={`font-mono text-sm ${(project.profit ?? 0) >= 0 ? "text-emerald" : "text-rose"}`}>
                {rupee(project.profit ?? 0)} <span className="text-[10px]">({project.marginPct ?? 0}%)</span>
              </span>
            </div>
          </>
        )}
        {/* collected progress */}
        <div className="h-1.5 rounded-full bg-paper-2 overflow-hidden">
          <div className="h-full bg-emerald" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[10px] text-ink-3">{pct}% collected</p>

        {/* Timeline — start → target with days left / overdue */}
        {(project.start_date || project.target_date) && (
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] text-ink-3 inline-flex items-center gap-1">
              <Icon name="clock" size={11} className="text-ink-3" />
              {project.start_date ? formatDate(project.start_date) : "—"} → {project.target_date ? formatDate(project.target_date) : "—"}
            </span>
            {project.target_date && !done && daysLeft != null && (
              <span className={`text-[10px] font-medium rounded-full px-1.5 py-0.5 ${daysLeft < 0 ? "bg-rose-soft text-rose" : daysLeft <= 7 ? "bg-amber-soft text-amber-ink" : "bg-emerald-soft text-emerald"}`}>
                {daysLeft < 0 ? `${-daysLeft}d overdue` : daysLeft === 0 ? "due today" : `${daysLeft}d left`}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
