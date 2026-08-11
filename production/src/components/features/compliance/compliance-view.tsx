/**
 * ComplianceView — the shared Private-Limited statutory tracker.
 *
 * Renders the obligation catalog (lib/compliance/obligations.ts) as a due-date
 * worklist: overdue + due-soon float to the top, each row can be marked filed
 * (date + optional challan/SRN reference + notes), which persists in
 * compliance_log. Used by /compliance (all categories, with filter chips) and
 * the category sub-pages (ROC, Income Tax & TDS) via `fixedCategories`.
 *
 * NOT tax advice — due dates are the India standard and shift with extensions +
 * turnover/audit status, so the page shows a "confirm with your CA" caveat.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { formatDate } from "@/lib/utils";
import {
  buildComplianceRows, CATEGORY_META,
  type ComplianceCategory, type ComplianceRow, type ComplianceStatus,
} from "@/lib/compliance/obligations";
import {
  useComplianceLog, toFiledMap, useMarkComplianceFiled, useUnmarkComplianceFiled,
} from "@/lib/queries/compliance";

const STATUS_META: Record<ComplianceStatus, { label: string; cls: string; icon: string }> = {
  overdue:  { label: "Overdue",  cls: "bg-rose/10 text-rose",          icon: "alert" },
  due_soon: { label: "Due soon", cls: "bg-amber-soft text-amber-ink",  icon: "clock" },
  upcoming: { label: "Upcoming", cls: "bg-paper-2 text-ink-2",         icon: "clock" },
  filed:    { label: "Filed",    cls: "bg-emerald/10 text-emerald",    icon: "check_circle" },
};

function dueText(r: ComplianceRow): string {
  if (r.status === "filed") return `Filed ${r.filedDate ? formatDate(r.filedDate) : ""}`.trim();
  if (r.daysToDue === 0) return "Due today";
  if (r.daysToDue < 0) return `${Math.abs(r.daysToDue)} day${Math.abs(r.daysToDue) === 1 ? "" : "s"} overdue`;
  return `in ${r.daysToDue} day${r.daysToDue === 1 ? "" : "s"}`;
}

export function ComplianceView({
  title, subtitle, fixedCategories,
}: {
  title: string;
  subtitle: string;
  fixedCategories?: ComplianceCategory[];
}) {
  const logQ = useComplianceLog();
  const mark = useMarkComplianceFiled();
  const unmark = useUnmarkComplianceFiled();
  const [catFilter, setCatFilter] = React.useState<ComplianceCategory | "all">("all");
  const [filing, setFiling] = React.useState<ComplianceRow | null>(null);
  const [guide, setGuide] = React.useState<ComplianceRow | null>(null);

  const today = React.useMemo(() => new Date(), []);
  const filedMap = React.useMemo(() => toFiledMap(logQ.data), [logQ.data]);

  const cats: ComplianceCategory[] | undefined = fixedCategories
    ?? (catFilter === "all" ? undefined : [catFilter]);
  const rows = React.useMemo(
    () => buildComplianceRows(today, filedMap, cats),
    [today, filedMap, cats],
  );

  const overdue = rows.filter((r) => r.status === "overdue").length;
  const dueSoon = rows.filter((r) => r.status === "due_soon").length;
  const filedCount = rows.filter((r) => r.status === "filed").length;

  const showChips = !fixedCategories;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-3">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Compliance</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">{title}</h1>
        <p className="text-sm text-ink-2 mt-1">{subtitle}</p>
      </div>

      {/* Honesty caveat — this is a reminder, not tax advice. */}
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-hairline bg-paper-2/40 px-3 py-2 text-[12px] text-ink-2">
        <Icon name="info" size={14} className="text-amber-ink shrink-0 mt-0.5" />
        <p>
          Standard due dates for an Indian Private Limited company. Exact dates change with
          government extensions and depend on your turnover / audit status — <b>confirm each with your CA</b>.
          Marking an item filed only records it here for your tracking.
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <KPI label="Overdue"   value={String(overdue)}  tone={overdue > 0 ? "rose" : undefined} />
        <KPI label="Due soon"  value={String(dueSoon)}  tone={dueSoon > 0 ? "amber" : undefined} sub="next 15 days" />
        <KPI label="Filed"     value={String(filedCount)} tone={filedCount > 0 ? "emerald" : undefined} />
      </div>

      {/* Category chips (all-view only) */}
      {showChips && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <Chip active={catFilter === "all"} onClick={() => setCatFilter("all")}>All</Chip>
          {(Object.keys(CATEGORY_META) as ComplianceCategory[]).map((c) => (
            <Chip key={c} active={catFilter === c} onClick={() => setCatFilter(c)}>{CATEGORY_META[c].label}</Chip>
          ))}
        </div>
      )}

      {logQ.isLoading ? (
        <div className="space-y-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => {
            const sm = STATUS_META[r.status];
            return (
              <li key={r.ob.key}>
                <Card className={`p-3.5 ${r.status === "overdue" ? "border-l-2 border-l-rose" : ""}`}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`inline-flex items-center gap-1 rounded-full ${sm.cls} px-2 py-0.5 text-[10px] font-medium`}>
                          <Icon name={sm.icon} size={11} /> {sm.label}
                        </span>
                        <span className="font-medium text-ink">{r.ob.name}</span>
                        {r.ob.form && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-paper-2 text-ink-3">{r.ob.form}</span>}
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo/10 text-indigo">
                          {CATEGORY_META[r.ob.category].short}
                        </span>
                      </div>
                      <div className="text-[12px] text-ink-3 mt-1">
                        <span className="text-ink-2">{r.inst.periodLabel}</span>
                        {" · due "}{formatDate(r.inst.dueDate)}
                        {r.status !== "filed" && (
                          <span className={r.status === "overdue" ? "text-rose font-medium" : "text-ink-2"}> · {dueText(r)}</span>
                        )}
                        {r.status === "filed" && <span className="text-emerald"> · {dueText(r)}</span>}
                      </div>
                      {r.ob.applies && <div className="text-[11px] text-ink-3 mt-1">{r.ob.applies}</div>}
                      <div className="flex items-center gap-3 mt-1.5">
                        {r.ob.penalty && <span className="text-[11px] text-rose/80">Late: {r.ob.penalty}</span>}
                        {r.ob.link && (
                          <a href={r.ob.link} target="_blank" rel="noopener noreferrer"
                            className="text-[11px] text-amber-ink hover:underline inline-flex items-center gap-1">
                            <Icon name="external" size={11} /> {r.ob.authority}
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      {r.status === "filed" ? (
                        <Button variant="ghost" className="h-7 px-2 text-[11px]"
                          loading={unmark.isPending}
                          onClick={() => unmark.mutate({ obligation_key: r.ob.key, period_key: r.inst.periodKey })}>
                          Undo
                        </Button>
                      ) : (
                        <>
                          {r.ob.filingSteps && (
                            <Button variant={r.status === "overdue" ? "primary" : "default"} icon="rocket" className="h-7 px-2.5 text-[11px]"
                              onClick={() => setGuide(r)}>
                              How to file
                            </Button>
                          )}
                          <Button variant="ghost" icon="check" className="h-7 px-2.5 text-[11px]"
                            onClick={() => setFiling(r)}>
                            Mark filed
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
          {rows.length === 0 && (
            <Card className="p-6 text-center text-sm text-ink-3">No obligations in this category.</Card>
          )}
        </ul>
      )}

      {guide && (
        <FilingGuideDialog
          row={guide}
          onClose={() => setGuide(null)}
          onMarkFiled={() => { const r = guide; setGuide(null); setFiling(r); }}
        />
      )}

      {filing && (
        <MarkFiledDialog
          row={filing}
          pending={mark.isPending}
          onClose={() => setFiling(null)}
          onSubmit={async (vals) => {
            await mark.mutateAsync({
              obligation_key: filing.ob.key,
              period_key: filing.inst.periodKey,
              period_label: filing.inst.periodLabel,
              due_date: filing.inst.dueDate,
              filed_date: vals.filedDate,
              reference: vals.reference || null,
              notes: vals.notes || null,
            });
            setFiling(null);
          }}
        />
      )}
    </div>
  );
}

function FilingGuideDialog({
  row, onClose, onMarkFiled,
}: {
  row: ComplianceRow;
  onClose: () => void;
  onMarkFiled: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>How to file — {row.ob.name}</DialogTitle>
          <DialogDescription>{row.inst.periodLabel} · due {formatDate(row.inst.dueDate)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Honest scope: ResellerOS helps you prepare; submission is on the portal. */}
          <div className="flex items-start gap-2 rounded-md border border-hairline bg-paper-2/50 px-3 py-2 text-[12px] text-ink-2">
            <Icon name="info" size={14} className="text-amber-ink shrink-0 mt-0.5" />
            <p>
              ResellerOS gives you the figures + steps. The actual submission happens on the government
              portal ({row.ob.authority}) — {row.ob.category === "gst"
                ? "direct one-click e-filing needs a GST Suvidha Provider (a future add-on)."
                : "and needs your DSC / OTP, so it's done by you or your CA."}
            </p>
          </div>

          {row.ob.dataHref && (
            <Link href={row.ob.dataHref.href as never}
              className="flex items-center gap-2 rounded-md border border-amber/40 bg-amber-soft/40 px-3 py-2 text-[13px] font-medium text-amber-ink hover:bg-amber-soft/70">
              <Icon name="chart" size={15} /> {row.ob.dataHref.label}
              <Icon name="arrow_right" size={14} className="ml-auto" />
            </Link>
          )}

          <ol className="space-y-2">
            {row.ob.filingSteps?.map((step, i) => (
              <li key={i} className="flex gap-2.5 text-[13px] text-ink-2 leading-relaxed">
                <span className="shrink-0 w-5 h-5 rounded-full bg-ink text-paper grid place-items-center text-[11px] font-semibold">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          {row.ob.link && (
            <a href={row.ob.link} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[13px] text-amber-ink hover:underline">
              <Icon name="external" size={14} /> Open {row.ob.authority} portal
            </a>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Close</Button>
          <Button type="button" variant="primary" icon="check" onClick={onMarkFiled}>
            I&apos;ve filed — mark it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MarkFiledDialog({
  row, pending, onClose, onSubmit,
}: {
  row: ComplianceRow;
  pending: boolean;
  onClose: () => void;
  onSubmit: (vals: { filedDate: string; reference: string; notes: string }) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [filedDate, setFiledDate] = React.useState(today);
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Mark filed — {row.ob.name}</DialogTitle>
          <DialogDescription>{row.inst.periodLabel} · was due {formatDate(row.inst.dueDate)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField label="Filed on" htmlFor="cf_date">
            <Input id="cf_date" type="date" value={filedDate} onChange={(e) => setFiledDate(e.target.value)} />
          </FormField>
          <FormField label="Reference (challan / SRN / ARN)" htmlFor="cf_ref">
            <Input id="cf_ref" placeholder="e.g. SRN AB1234567" value={reference} onChange={(e) => setReference(e.target.value)} />
          </FormField>
          <FormField label="Notes" htmlFor="cf_notes">
            <Input id="cf_notes" placeholder="Optional" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={pending}
            onClick={() => onSubmit({ filedDate, reference, notes })}>
            Mark filed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-colors ${
        active ? "bg-amber text-white border-amber" : "bg-paper border-hairline text-ink-2 hover:border-hairline-strong"
      }`}>
      {children}
    </button>
  );
}

function KPI({ label, value, tone, sub }: {
  label: string; value: string; tone?: "emerald" | "rose" | "amber"; sub?: string;
}) {
  const colorClass = tone === "emerald" ? "text-emerald" : tone === "rose" ? "text-rose" : tone === "amber" ? "text-amber-ink" : "text-ink";
  return (
    <Card className="p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5 truncate">{label}</div>
      <div className={`font-serif text-xl md:text-2xl ${colorClass} leading-tight`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-3 truncate">{sub}</div>}
    </Card>
  );
}
