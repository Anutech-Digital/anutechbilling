/**
 * Project Sale detail — the deal, its milestone schedule, and payments.
 *
 * Per milestone the operator can: raise a GST Tax Invoice, then record the
 * payment (optionally linking the real bank credit line). Receivable = total −
 * payments received. Revenue lands in the normal invoices table on raise.
 */
"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import {
  useProjectSale,
  useRaiseMilestoneInvoice,
  useAcceptProjectQuote,
  type ProjectMilestoneRow,
  type ProjectQuoteLine,
} from "@/lib/queries/projects";
import { rupee, formatDate, daysBetween } from "@/lib/utils";
import { toast } from "sonner";
import type { Route } from "next";
import { useCustomer } from "@/lib/queries/customers";
import { RecordProjectPaymentDialog } from "@/components/features/projects/record-project-payment-dialog";
import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";
import { AddLabourDialog } from "@/components/features/projects/add-labour-dialog";
import { ProjectTasks } from "@/components/features/projects/project-tasks";
import { useRemoveProjectLabour, useSaveProjectLabour, useUpdateProjectDates, type ProjectLabourLine } from "@/lib/queries/projects";
import { Input } from "@/components/ui/input";

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { data, isLoading } = useProjectSale(id);
  const { data: customer } = useCustomer(data?.project.customer_id ?? undefined);
  const raise = useRaiseMilestoneInvoice();
  const accept = useAcceptProjectQuote();
  const [payFor, setPayFor] = React.useState<ProjectMilestoneRow | null>(null);
  const [addCostOpen, setAddCostOpen] = React.useState(false);
  const [editCost, setEditCost] = React.useState<import("@/lib/queries/expenses").Expense | null>(null);
  const [addLabourOpen, setAddLabourOpen] = React.useState(false);
  const [editLabour, setEditLabour] = React.useState<ProjectLabourLine | null>(null);
  const updateDates = useUpdateProjectDates();
  const [datesEdit, setDatesEdit] = React.useState(false);
  const [startVal, setStartVal] = React.useState("");
  const [targetVal, setTargetVal] = React.useState("");

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1000px] mx-auto space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!data?.project) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1000px] mx-auto">
        <Card><EmptyState icon="alert" title="Project not found" body="This project sale doesn't exist or isn't in your workspace." /></Card>
      </div>
    );
  }

  const { project, milestones, payments, paid, receivable, costs, costTotal, labour, labourTotal } = data;
  const isQuote = project.status === "quoted";
  const lines = (project.line_items ?? []) as ProjectQuoteLine[];

  // ── Per-project P&L (all ex-GST, so revenue vs cost compare like-for-like) ──
  // Total cost = external expenses + allocated employee labour (labour is a
  // management overlay — it does NOT double-count in the company P&L).
  // Contract view = the whole deal's expected margin (full contract vs all costs).
  // Booked-to-date = realized so far (ex-GST value of INVOICED milestones vs costs).
  const totalCost = costTotal + labourTotal;
  const gstDiv = 1 + (project.gst_rate ?? 0) / 100;
  const contractRevenue = project.taxable_amount ?? 0;
  const bookedRevenue = Math.round(
    milestones.filter((m) => m.invoice_id).reduce((s, m) => s + (m.total_amount ?? 0), 0) / (gstDiv || 1),
  );
  const contractProfit = contractRevenue - totalCost;
  const bookedProfit = bookedRevenue - totalCost;
  const pct = (profit: number, rev: number) => (rev > 0 ? Math.round((profit / rev) * 100) : 0);

  // ── Timeline: start → target, duration, days-left / overdue ──
  const todayStr = new Date().toISOString().slice(0, 10);
  const durationDays = project.start_date && project.target_date ? daysBetween(project.start_date, project.target_date) : null;
  // Auto-suggest labour months from the project duration (full automation:
  // labour cost period follows the real project length).
  const suggestedMonths = durationDays && durationDays > 0 ? Math.max(1, Math.round(durationDays / 30.44)) : 1;
  const daysLeft = project.target_date ? daysBetween(todayStr, project.target_date) : null;
  const isDone = project.status === "completed" || project.status === "cancelled";
  const openDatesEditor = () => { setStartVal(project.start_date ?? ""); setTargetVal(project.target_date ?? ""); setDatesEdit(true); };
  const saveDates = async () => {
    await updateDates.mutateAsync({ id: project.id, startDate: startVal || null, targetDate: targetVal || null }).catch(() => {});
    setDatesEdit(false);
  };

  const handleRaise = async (m: ProjectMilestoneRow) => {
    await raise.mutateAsync({ milestoneId: m.id, projectId: project.id }).catch(() => {});
  };

  // GST-correctness nudge: a linked customer missing GSTIN/state can't get a
  // fully compliant tax invoice (CGST/SGST vs IGST + their ITC).
  const gstMissing = customer ? (!customer.gstin || !customer.state) : false;

  const customerLink = typeof window !== "undefined" ? `${window.location.origin}/project-quote/${project.id}` : "";
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(customerLink); toast.success("Customer link copied"); }
    catch { toast.error("Could not copy"); }
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1000px] mx-auto">
      <Link href="/projects" className="text-xs text-ink-3 hover:text-ink inline-flex items-center gap-1 mb-3">
        <Icon name="arrow_left" size={12} /> Project Sales
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">{project.customer_name}</p>
            <h1 className="font-serif text-3xl md:text-4xl leading-tight">{project.title}</h1>
            {project.description && <p className="text-sm text-ink-3 mt-1 max-w-prose">{project.description}</p>}
          </div>
          <Badge kind={project.status === "completed" ? "success" : project.status === "cancelled" ? "muted" : isQuote ? "info" : "warning"}>
            {project.status === "completed" ? "Completed" : project.status === "cancelled" ? "Cancelled" : isQuote ? "Quotation" : "Active"}
          </Badge>
        </div>
      </div>

      {/* Quotation banner — share link + accept, before it's an active project */}
      {isQuote && (
        <Card className="mb-6 border-indigo/30 bg-indigo-soft/20">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">This is a quotation — not yet accepted.</p>
              <p className="text-[12px] text-ink-3 mt-1">
                Send the customer this link. When they accept, it becomes an active project and you can raise milestone invoices.
              </p>
              <div className="flex items-center gap-2 mt-2">
                <code className="text-[11px] bg-paper border border-hairline rounded px-2 py-1 truncate max-w-[280px]">{customerLink}</code>
                <Button size="sm" variant="outline" icon="copy" onClick={copyLink}>Copy link</Button>
              </div>
            </div>
            <Button
              variant="primary" icon="check"
              loading={accept.isPending}
              onClick={() => accept.mutate(project.id)}
            >
              Mark accepted
            </Button>
          </div>
        </Card>
      )}

      {/* Line items (the quote) */}
      {lines.length > 0 && (
        <Card className="mb-6 overflow-hidden">
          <div className="px-5 py-3 border-b border-hairline"><h2 className="text-sm font-semibold text-ink">Quoted items</h2></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[420px]">
              <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="text-left px-5 py-2">Item</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">Rate</th>
                  <th className="text-right px-5 py-2">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="px-5 py-2 text-ink">{l.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-2">{l.qty}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-2">{rupee(l.rate)}</td>
                    <td className="px-5 py-2 text-right tabular-nums text-ink">{rupee(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Timeline — start → target, with days-left / overdue */}
      <Card className="mb-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-x-6 gap-y-2 flex-wrap">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Start</p>
              <p className="text-sm text-ink mt-0.5">{project.start_date ? formatDate(project.start_date) : "—"}</p>
            </div>
            <Icon name="arrow_right" size={14} className="text-ink-3" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Target</p>
              <p className="text-sm text-ink mt-0.5">{project.target_date ? formatDate(project.target_date) : "—"}</p>
            </div>
            {durationDays != null && durationDays > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Duration</p>
                <p className="text-sm text-ink mt-0.5">{durationDays} days (~{suggestedMonths} mo)</p>
              </div>
            )}
            {project.target_date && !isDone && daysLeft != null && (
              <span className={`text-xs font-medium rounded-full px-2.5 py-1 ${daysLeft < 0 ? "bg-rose-soft text-rose" : daysLeft <= 7 ? "bg-amber-soft text-amber-ink" : "bg-emerald-soft text-emerald"}`}>
                {daysLeft < 0 ? `${-daysLeft} days overdue` : daysLeft === 0 ? "Due today" : `${daysLeft} days left`}
              </span>
            )}
          </div>
          {!datesEdit && (
            <Button size="sm" variant="outline" icon="edit" onClick={openDatesEditor}>
              {project.start_date || project.target_date ? "Edit dates" : "Set dates"}
            </Button>
          )}
        </div>
        {datesEdit && (
          <div className="mt-3 flex items-end gap-3 flex-wrap">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold block mb-1">Start</label>
              <Input type="date" value={startVal} onChange={(e) => setStartVal(e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold block mb-1">Target</label>
              <Input type="date" value={targetVal} onChange={(e) => setTargetVal(e.target.value)} />
            </div>
            <Button size="sm" variant="primary" onClick={saveDates} loading={updateDates.isPending}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setDatesEdit(false)}>Cancel</Button>
          </div>
        )}
      </Card>

      {/* Money summary */}
      <Card className="mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Sum label="Taxable value"       value={rupee(project.taxable_amount)} />
          <Sum label={`GST @ ${project.gst_rate}%`} value={rupee(project.gst_amount)} sub={project.inter_state ? "IGST" : "CGST + SGST"} />
          <Sum label="Total (incl GST)"     value={rupee(project.total_amount)} strong />
          <Sum label="Outstanding"          value={rupee(receivable)} tone={receivable > 0 ? "rose" : "emerald"} />
        </div>
        <p className="text-[11px] text-ink-3 mt-3">
          Collected {rupee(paid)} of {rupee(project.total_amount)} · SAC {project.sac_code}
        </p>
      </Card>

      {/* Profit & Loss — this project's costs vs revenue (all ex-GST). */}
      <Card className="mb-6">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h2 className="text-sm font-semibold text-ink">Profit &amp; Loss</h2>
          {!isQuote && (
            <Button size="sm" variant="outline" icon="plus" onClick={() => { setEditCost(null); setAddCostOpen(true); }}>
              Add cost
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Sum label="Contract value" value={rupee(contractRevenue)} sub="ex-GST" />
          <Sum label="Costs" value={rupee(costTotal)} sub="external" tone={costTotal > 0 ? "rose" : "ink"} />
          <Sum label="Labour" value={rupee(labourTotal)} sub="allocated" tone={labourTotal > 0 ? "rose" : "ink"} />
          <Sum label="Expected profit" value={rupee(contractProfit)} tone={contractProfit >= 0 ? "emerald" : "rose"} strong />
          <Sum label="Margin" value={`${pct(contractProfit, contractRevenue)}%`} tone={contractProfit >= 0 ? "emerald" : "rose"} />
        </div>
        <p className="text-[11px] text-ink-3 mt-3">
          Booked to date: {rupee(bookedRevenue)} invoiced − {rupee(totalCost)} costs ={" "}
          <span className={bookedProfit >= 0 ? "text-emerald" : "text-rose"}>{rupee(bookedProfit)}</span>{" "}
          ({pct(bookedProfit, bookedRevenue)}%). External costs are ex-GST; labour is allocated salary (management view — it doesn&apos;t double-count in your overall P&amp;L).
        </p>
      </Card>

      {/* GST-details nudge — a B2B tax invoice needs the customer's GSTIN + state */}
      {gstMissing && customer && (
        <Card className="mb-6 border-amber/40 bg-amber-soft/25">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-2 min-w-0">
              <Icon name="alert" size={16} className="text-amber-ink mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-ink">Add {customer.name}&apos;s GST details</p>
                <p className="text-[12px] text-ink-3 mt-1 max-w-prose">
                  This customer is missing {!customer.gstin && "GSTIN"}{!customer.gstin && !customer.state && " and "}{!customer.state && "state"}.
                  Without them the tax invoice can&apos;t split CGST/SGST vs IGST correctly, and the customer can&apos;t claim input credit. Add them before raising more invoices.
                </p>
              </div>
            </div>
            <Link href={`/customers/${customer.id}?edit=1` as Route}>
              <Button size="sm" variant="outline" icon="edit">Complete customer</Button>
            </Link>
          </div>
        </Card>
      )}

      {/* Milestones */}
      <CollapsibleCard title="Milestones" summary={`(${milestones.length})`} className="mb-6">
        <div className="divide-y divide-hairline">
          {milestones.map((m) => {
            const msPays  = payments.filter((p) => p.milestone_id === m.id);
            const reconciled = msPays.some((p) => p.bank_txn_id);
            // How much of THIS milestone has actually come in — so a part-payment
            // shows on the milestone (received vs still-due), not just "Invoiced".
            const paidSoFar = msPays.reduce((s, p) => s + (p.amount ?? 0), 0);
            const balance   = Math.max(0, m.total_amount - paidSoFar);
            const partial   = m.status !== "paid" && paidSoFar > 0;
            const impact = milestoneImpact(m, reconciled, paidSoFar, balance);
            return (
            <div key={m.id} className="px-5 py-3">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{m.seq}. {m.label}</p>
                  <p className="text-[11px] text-ink-3">
                    {m.due_date ? `Due ${formatDate(m.due_date)}` : "No due date"}
                    {m.invoice_id && <> · Invoice <span className="font-mono">{m.invoice_id}</span></>}
                  </p>
                </div>
                <div className="text-right whitespace-nowrap">
                  <div className="font-mono text-sm text-ink">{rupee(m.total_amount)}</div>
                  {partial && (
                    <div className="text-[10px]">
                      <span className="text-emerald">{rupee(paidSoFar)} received</span>
                      <span className="text-ink-3"> · </span>
                      <span className="text-amber-ink">{rupee(balance)} baaki</span>
                    </div>
                  )}
                </div>
                <MilestoneStatus status={m.status} partial={partial} />
                <div className="flex gap-2">
                  {isQuote ? (
                    <span className="text-[11px] text-ink-3 italic">Accept quotation to bill</span>
                  ) : (
                    <>
                      {!m.invoice_id && (
                        <Button size="sm" variant="outline" loading={raise.isPending} onClick={() => handleRaise(m)}>
                          Raise invoice
                        </Button>
                      )}
                      {m.status !== "paid" && (
                        <Button size="sm" variant="primary" onClick={() => setPayFor(m)}>
                          {partial ? "Record balance" : "Record payment"}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {/* Impact / next-step — plain-language effect of the current state */}
              {!isQuote && impact && (
                <div className={`mt-2 flex items-start gap-1.5 text-[11px] rounded-md px-2.5 py-1.5 ${impact.tone === "warn" ? "bg-amber-soft/40 text-amber-ink" : impact.tone === "ok" ? "bg-emerald-soft/40 text-emerald" : "bg-paper-2/60 text-ink-3"}`}>
                  <Icon name={impact.tone === "warn" ? "alert" : impact.tone === "ok" ? "check_circle" : "info"} size={13} className="mt-0.5 shrink-0" />
                  <span>{impact.text}</span>
                </div>
              )}
            </div>
          );})}
        </div>
      </CollapsibleCard>

      {/* Payments */}
      <CollapsibleCard title="Payments received" summary={`(${payments.length}) · ${rupee(paid)}`} className="mt-6">
        {payments.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-3 text-center">No payments recorded yet.</p>
        ) : (
          <div className="divide-y divide-hairline">
            {payments.map((p) => (
              <div key={p.id} className="px-5 py-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{rupee(p.amount)}</p>
                  <p className="text-[11px] text-ink-3">
                    {formatDate(p.received_at)}{p.method ? ` · ${p.method}` : ""}{p.reference ? ` · ${p.reference}` : ""}
                    {p.bank_txn_id && <> · <span className="text-emerald">bank-reconciled</span></>}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>

      {/* Team / Labour — employees allocated to this project (drive the P&L above). */}
      <CollapsibleCard
        title="Team / Labour"
        summary={labour.length > 0 ? `(${labour.length}) · ${rupee(labourTotal)}` : undefined}
        className="mt-6"
        action={!isQuote ? (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => { setEditLabour(null); setAddLabourOpen(true); }}>Add labour</Button>
        ) : undefined}
      >
        {labour.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-3 text-center">
            No employees on this project yet.{!isQuote && " Attach team members so their salary time counts in the profit."}
          </p>
        ) : (
          <div className="divide-y divide-hairline">
            {labour.map((l) => (
              <LabourRow key={l.id} line={l} projectId={project.id} projectStart={project.start_date} projectTarget={project.target_date} />
            ))}
          </div>
        )}
      </CollapsibleCard>

      {/* Roadmap & tasks — assign delivery work to the project's team */}
      <div className="mt-6">
        <ProjectTasks
          projectId={project.id}
          team={labour}
          project={{
            title:        project.title,
            customerName: project.customer_name,
            value:        project.taxable_amount ?? 0,
            startDate:    project.start_date,
            targetDate:   project.target_date,
          }}
        />
      </div>

      {/* Costs — expenses tagged to this project (drive the P&L above) */}
      <CollapsibleCard
        title="Costs"
        summary={costs.length > 0 ? `(${costs.length}) · ${rupee(costTotal)}` : undefined}
        className="mt-6"
        action={!isQuote ? (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => { setEditCost(null); setAddCostOpen(true); }}>Add cost</Button>
        ) : undefined}
      >
        {costs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-3 text-center">
            No costs recorded for this project yet.{!isQuote && " Add labour, subcontract, tools, etc. to see the real profit."}
          </p>
        ) : (
          <div className="divide-y divide-hairline">
            {costs.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { setEditCost(c); setAddCostOpen(true); }}
                className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-paper-2/40 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{c.category}{c.vendor_name ? ` · ${c.vendor_name}` : ""}</p>
                  <p className="text-[11px] text-ink-3">
                    {formatDate(c.expense_date)}
                    {c.description ? ` · ${c.description}` : ""}
                    {!c.paid && <> · <span className="text-amber-ink">unpaid</span></>}
                  </p>
                </div>
                <div className="font-mono text-sm text-ink whitespace-nowrap">{rupee(c.amount)}</div>
              </button>
            ))}
          </div>
        )}
      </CollapsibleCard>

      {addCostOpen && (
        <AddExpenseDialog
          onClose={() => { setAddCostOpen(false); setEditCost(null); }}
          expense={editCost}
          projectId={project.id}
          projectTitle={project.title}
        />
      )}

      <AddLabourDialog
        open={addLabourOpen}
        onClose={() => { setAddLabourOpen(false); setEditLabour(null); }}
        projectId={project.id}
        existing={editLabour}
        projectStart={project.start_date}
        projectTarget={project.target_date}
      />

      <RecordProjectPaymentDialog
        open={payFor !== null}
        onOpenChange={(o) => { if (!o) setPayFor(null); }}
        milestone={payFor}
        projectId={project.id}
      />
    </div>
  );
}

/** A card whose whole body collapses when you click its header (chevron).
 *  Shows a small summary next to the title when collapsed. Optional right-side
 *  action (e.g. an "Add" button) stays clickable and doesn't toggle. */
function CollapsibleCard({
  title, summary, action, defaultOpen = true, className, children,
}: {
  title: string;
  summary?: React.ReactNode;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Card className={`overflow-hidden ${className ?? ""}`}>
      <div className="px-5 py-3 border-b border-hairline flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
          aria-expanded={open}
        >
          <Icon name={open ? "chevron_down" : "chevron_right"} size={15} className="text-ink-3 shrink-0" />
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {summary && <span className="text-[11px] text-ink-3 tabular-nums">{summary}</span>}
        </button>
        {action}
      </div>
      {open && children}
    </Card>
  );
}

/** One Team/Labour row — collapsed shows a summary; expands inline to edit
 *  (%, from/to dates, note) with a live cost preview + Save / Remove. */
function LabourRow({ line, projectId, projectStart, projectTarget }: { line: ProjectLabourLine; projectId: string; projectStart: string | null; projectTarget: string | null }) {
  const save = useSaveProjectLabour();
  const remove = useRemoveProjectLabour();
  const [open, setOpen] = React.useState(false);
  const [percent, setPercent] = React.useState(String(line.percent));
  const [from, setFrom] = React.useState(line.start_date ?? "");
  const [to, setTo] = React.useState(line.end_date ?? "");
  const [note, setNote] = React.useState(line.note ?? "");

  // Re-seed if the row's data changes underneath (after a save/refetch).
  React.useEffect(() => {
    setPercent(String(line.percent));
    setFrom(line.start_date ?? "");
    setTo(line.end_date ?? "");
    setNote(line.note ?? "");
  }, [line.percent, line.start_date, line.end_date, line.note]);

  const pctN = Number(percent) || 0;
  const months = from && to ? Math.max(0.5, Math.round((daysBetween(from, to) / 30.44) * 2) / 2) : line.months;
  const previewCost = Math.round(line.monthlyGross * (pctN / 100) * months);
  const dirty = pctN !== line.percent || (from || null) !== (line.start_date ?? null) || (to || null) !== (line.end_date ?? null) || (note.trim() || null) !== (line.note ?? null);
  // Bound the allocation inside the project's timeline.
  const beforeStart = !!(projectStart && from && from < projectStart);
  const afterTarget = !!(projectTarget && to && to > projectTarget);
  const badRange = !!(from && to && from > to);
  const valid = pctN > 0 && pctN <= 100 && months > 0 && !badRange && !beforeStart && !afterTarget;

  async function handleSave() {
    if (!valid) return;
    await save.mutateAsync({ id: line.id, projectId, employeeId: line.employee_id, percent: pctN, months, startDate: from || null, endDate: to || null, note: note.trim() || null }).catch(() => {});
    setOpen(false);
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-paper-2/40 transition-colors"
        aria-expanded={open}
      >
        <Icon name={open ? "chevron_down" : "chevron_right"} size={14} className="text-ink-3 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">{line.employeeName}{line.designation ? ` · ${line.designation}` : ""}</p>
          <p className="text-[11px] text-ink-3">
            {line.percent}% × {line.months} month{line.months === 1 ? "" : "s"} · {rupee(line.monthlyGross)}/mo
            {line.start_date && line.end_date ? ` · ${formatDate(line.start_date)} → ${formatDate(line.end_date)}` : ""}
            {line.note ? ` · ${line.note}` : ""}
          </p>
        </div>
        <div className="font-mono text-sm text-ink whitespace-nowrap">{rupee(line.cost)}</div>
      </button>

      {open && (
        <div className="px-5 pb-4 pt-1 bg-paper-2/30">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold block mb-1">Time (%)</label>
              <Input type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold block mb-1">From</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold block mb-1">To</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div className="mt-3">
            <label className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold block mb-1">Note</label>
            <Input placeholder="e.g. backend development" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {badRange && <p className="mt-2 text-[11px] text-rose">To date must be after From date.</p>}
          {beforeStart && <p className="mt-2 text-[11px] text-rose">Can&apos;t start before the project ({formatDate(projectStart!)}).</p>}
          {afterTarget && <p className="mt-2 text-[11px] text-rose">Ends after the project target ({formatDate(projectTarget!)}).</p>}
          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[11px] text-ink-3">
              Cost: <span className="font-semibold text-ink">{rupee(previewCost)}</span> = {rupee(line.monthlyGross)}/mo × {pctN}% × {months} mo
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" icon="trash" onClick={() => remove.mutate(line.id)}>Remove</Button>
              <Button size="sm" variant="primary" onClick={handleSave} disabled={!valid || !dirty} loading={save.isPending}>Save</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Sum({ label, value, sub, strong, tone = "ink" }: {
  label: string; value: string; sub?: string; strong?: boolean; tone?: "ink" | "rose" | "emerald";
}) {
  const c = tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : "text-ink";
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">{label}</p>
      <p className={`font-serif text-xl mt-1 ${c} ${strong ? "font-semibold" : ""}`}>{value}</p>
      {sub && <p className="text-[10px] text-ink-3">{sub}</p>}
    </div>
  );
}

/** Plain-language effect of a milestone's current state — what's done + what's next. */
function milestoneImpact(
  m: ProjectMilestoneRow,
  reconciled: boolean,
  paidSoFar = 0,
  balance = 0,
): { text: string; tone: "warn" | "ok" | "info" } | null {
  // Part-paid (not yet fully settled) — show received vs still-due.
  if (m.status !== "paid" && paidSoFar > 0) {
    return {
      tone: "warn",
      text: m.invoice_id
        ? `Invoice raised (revenue & GST booked). ${rupee(paidSoFar)} aa gaya, ${rupee(balance)} abhi baaki (outstanding).`
        : `${rupee(paidSoFar)} received, ${rupee(balance)} baaki. No GST invoice yet — raise it to book revenue & GST.`,
    };
  }
  if (m.status === "paid") {
    if (!m.invoice_id) {
      return {
        tone: "warn",
        text: "Payment received — outstanding reduced. But no GST invoice yet, so revenue & GST aren't booked in the P&L. Raise the invoice to record them.",
      };
    }
    return {
      tone: reconciled ? "ok" : "warn",
      text: reconciled
        ? "Invoiced + paid — revenue & GST booked, and the bank credit is reconciled. Fully done."
        : "Invoiced + paid — revenue & GST booked. Tip: link the bank credit so it reconciles with your statement.",
    };
  }
  if (m.status === "invoiced") {
    return { tone: "info", text: "Invoice raised — revenue & GST booked. Awaiting the customer's payment (shows as outstanding)." };
  }
  return null; // pending — no billing yet
}

function MilestoneStatus({ status, partial }: { status: ProjectMilestoneRow["status"]; partial?: boolean }) {
  if (status === "paid")     return <Badge kind="success" size="sm" dot>Paid</Badge>;
  if (partial)               return <Badge kind="warning" size="sm" dot>Part paid</Badge>;
  if (status === "invoiced") return <Badge kind="warning" size="sm" dot>Invoiced</Badge>;
  return <Badge kind="muted" size="sm" dot>Pending</Badge>;
}
