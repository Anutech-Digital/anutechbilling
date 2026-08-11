/**
 * Balance Sheet — statement of financial position.
 *
 * Assets = Liabilities + Equity, as of today. Auto figures come from ResellerOS
 * records (cash & bank, receivables, TDS receivable, payables, GST); the
 * operator adds manual lines for what the app doesn't track (fixed assets,
 * loans, owner's capital, drawings). Equity's "retained earnings" is derived so
 * the sheet always balances.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/providers/confirm-provider";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel,
} from "@/components/ui/select";
import { rupee, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import {
  useBalanceSheetAuto,
  useBalanceSheetItems,
  useCreateBalanceSheetItem,
  useUpdateBalanceSheetItem,
  useDeleteBalanceSheetItem,
  type BalanceSheetItem,
} from "@/lib/queries/balance-sheet";
import type { BalanceSheetSection } from "@/lib/supabase/database.types";

export default function BalanceSheetPage() {
  const { data: auto, isLoading: autoLoading } = useBalanceSheetAuto();
  const { data: items, isLoading: itemsLoading } = useBalanceSheetItems();
  const del = useDeleteBalanceSheetItem();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = React.useState(false);
  const [editItem, setEditItem] = React.useState<BalanceSheetItem | null>(null);
  const [retainedInfoOpen, setRetainedInfoOpen] = React.useState(false);
  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const loading = autoLoading || itemsLoading;

  const manual = (section: BalanceSheetSection) => (items ?? []).filter((i) => i.section === section);
  const sum = (rows: BalanceSheetItem[]) => rows.reduce((s, r) => s + r.amount, 0);

  // GST: positive → payable (liability); negative → ITC credit (asset).
  const gst = auto?.gstPayable ?? 0;
  const gstCredit = gst < 0 ? -gst : 0;
  const gstPayable = gst > 0 ? gst : 0;

  const autoAssets =
    (auto?.cashAndBank ?? 0) + (auto?.receivables ?? 0) + (auto?.projectReceivable ?? 0) + (auto?.tdsReceivable ?? 0)
    + (auto?.employeeLoans ?? 0) + (auto?.prepaidAdvances ?? 0) + (auto?.fixedAssets ?? 0) + gstCredit;
  const autoLiab = (auto?.payables ?? 0) + (auto?.salaryPayable ?? 0) + (auto?.salaryDuesPayable ?? 0) + (auto?.reimbursementsPayable ?? 0) + (auto?.creditCardPayable ?? 0) + (auto?.emiLoansPayable ?? 0) + (auto?.businessLoansPayable ?? 0) + gstPayable;

  const manualAssetRows = manual("asset");
  const manualLiabRows  = manual("liability");
  const manualEqRows    = manual("equity");

  const totalAssets = autoAssets + sum(manualAssetRows);
  const totalLiab   = autoLiab + sum(manualLiabRows);
  const netWorth    = totalAssets - totalLiab;                 // = total equity
  const retained    = netWorth - sum(manualEqRows);            // balancing plug

  // ── Solvency ratios (liquidity + leverage) ──────────────────────────────
  // Current = liquid within a year. Long-term items (fixed assets, staff loans,
  // EMI / business loans) are EXCLUDED from the current buckets.
  const currentAssets =
    (auto?.cashAndBank ?? 0) + (auto?.receivables ?? 0) + (auto?.projectReceivable ?? 0)
    + (auto?.tdsReceivable ?? 0) + gstCredit + sum(manualAssetRows);
  const currentLiab =
    (auto?.payables ?? 0) + (auto?.salaryPayable ?? 0) + (auto?.salaryDuesPayable ?? 0)
    + (auto?.reimbursementsPayable ?? 0) + (auto?.creditCardPayable ?? 0) + gstPayable + sum(manualLiabRows);
  const currentRatio = currentLiab > 0 ? currentAssets / currentLiab : null;   // ≥1 = can cover short-term dues
  const debtToEquity = netWorth > 0 ? totalLiab / netWorth : null;             // null = negative equity (insolvent)

  // Export the full sheet as a CSV the owner can hand to their CA (mirrors GST/P&L).
  function exportCSV() {
    if (!auto) return;
    downloadCSV(
      `balance-sheet-${today}.csv`,
      ["Line", "Amount (INR)"],
      [
        ["As of date", today],
        ["", ""],
        ["ASSETS", ""],
        ["Cash & bank", auto.cashAndBank ?? 0],
        ["Accounts receivable", auto.receivables ?? 0],
        ["Project receivable", auto.projectReceivable ?? 0],
        ["TDS receivable", auto.tdsReceivable ?? 0],
        ["Employee loans (advances)", auto.employeeLoans ?? 0],
        ["Prepaid / vendor advances", auto.prepaidAdvances ?? 0],
        ["Fixed assets", auto.fixedAssets ?? 0],
        ["GST input credit (ITC)", gstCredit],
        ...manualAssetRows.map((r): [string, number] => [r.label, r.amount]),
        ["Total assets", totalAssets],
        ["", ""],
        ["LIABILITIES", ""],
        ["Accounts payable", auto.payables ?? 0],
        ["Salary payable", auto.salaryPayable ?? 0],
        ["Statutory dues payable", auto.salaryDuesPayable ?? 0],
        ["Reimbursements payable", auto.reimbursementsPayable ?? 0],
        ["Credit card payable", auto.creditCardPayable ?? 0],
        ["EMI loans payable", auto.emiLoansPayable ?? 0],
        ["Business loans payable", auto.businessLoansPayable ?? 0],
        ["GST payable", gstPayable],
        ...manualLiabRows.map((r): [string, number] => [r.label, r.amount]),
        ["Total liabilities", totalLiab],
        ["", ""],
        ["EQUITY", ""],
        ...manualEqRows.map((r): [string, number] => [r.label, r.amount]),
        ["Retained earnings (derived)", retained],
        ["Net worth (total equity)", netWorth],
      ],
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Balance Sheet</h1>
          <p className="text-sm text-ink-3 mt-1">
            What you own vs what you owe · as of {formatDate(today)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon="download" onClick={exportCSV} disabled={loading || !auto}>
            Export CSV
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            Add line
          </Button>
        </div>
      </div>

      {/* Headline summary — Net worth reads FIRST (was buried at the very bottom
          after ~15 detail lines). Assets · Liabilities · Net worth up top. */}
      {!loading && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Card className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Total assets</div>
            <div className="font-serif text-2xl mt-1 tabular-nums text-ink">{rupee(totalAssets, { compact: true })}</div>
          </Card>
          <Card className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Total liabilities</div>
            <div className="font-serif text-2xl mt-1 tabular-nums text-ink">{rupee(totalLiab, { compact: true })}</div>
          </Card>
          <Card className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Net worth</div>
            <div className={`font-serif text-2xl mt-1 tabular-nums ${netWorth >= 0 ? "text-emerald" : "text-rose"}`}>{rupee(netWorth, { compact: true })}</div>
          </Card>
        </div>
      )}

      {/* Honesty note */}
      <Card className="mb-6 bg-paper-2/40 p-3">
        <p className="text-[11px] text-ink-3 leading-relaxed flex items-start gap-1.5">
          <Icon name="info" size={13} className="mt-0.5 shrink-0" />
          <span>
            Auto figures (cash &amp; bank, receivables, TDS, payables, GST) come from your
            ResellerOS records. Add manual lines for anything the app doesn&apos;t track —
            fixed assets, loans, owner&apos;s capital, drawings — to make this a complete,
            CA-ready sheet. <b>Equity&apos;s retained earnings is derived so the sheet balances.</b>
          </span>
        </p>
      </Card>

      {/* Financial-health / solvency indicator — prominent rose banner when net
          worth is negative, subtle green strip when solvent. Shows the key
          liquidity + leverage ratios with plain-English tooltips. */}
      {!loading && auto && (
        <Card className={`mb-6 p-4 ${netWorth < 0 ? "border-rose/40 bg-rose/5" : "border-emerald/30 bg-emerald-soft/20"}`}>
          <div className="flex items-start gap-3">
            <Icon name={netWorth < 0 ? "alert" : "check_circle"} size={18} className={`mt-0.5 shrink-0 ${netWorth < 0 ? "text-rose" : "text-emerald"}`} />
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-semibold ${netWorth < 0 ? "text-rose" : "text-emerald"}`}>
                {netWorth < 0
                  ? `Net worth negative — liabilities exceed assets by ${rupee(Math.abs(netWorth))}`
                  : "Solvent — assets exceed liabilities"}
              </p>
              <p className="text-[12px] text-ink-3 mt-0.5 leading-relaxed">
                {netWorth < 0
                  ? "Books show the business owes more than it owns. Add owner's capital, collect receivables, or clear dues to turn this positive."
                  : "Healthy net worth. Keep the current ratio above 1 to comfortably cover short-term dues."}
              </p>
              <div className="flex gap-x-6 gap-y-2 flex-wrap mt-2.5">
                <Ratio label="Current ratio"  value={currentRatio == null ? "—" : currentRatio.toFixed(2)}
                  good={currentRatio != null && currentRatio >= 1}
                  tip="Current assets ÷ current liabilities. ≥ 1 means short-term dues are covered." />
                <Ratio label="Debt-to-equity" value={debtToEquity == null ? "n/a" : debtToEquity.toFixed(2)}
                  good={debtToEquity != null && debtToEquity <= 2}
                  tip="Total liabilities ÷ net worth. Lower = less leveraged. n/a when equity is negative." />
                <Ratio label="Net worth" value={fmtBS(netWorth)} good={netWorth >= 0}
                  tip="Total assets − total liabilities." />
              </div>
            </div>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[1, 2].map((i) => <Skeleton key={i} className="h-96 rounded-lg" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* ── ASSETS ── */}
            <Card className="p-5 md:p-6">
              <SectionTitle>Assets</SectionTitle>
              <div className="space-y-1 mt-3">
                <BSLine label="Cash & bank balances" amount={auto?.cashAndBank ?? 0} kind="auto" source="Banking" href="/accounting/banking" />
                <BSLine label="Trade receivables" hint="customers' unpaid balances" amount={auto?.receivables ?? 0} kind="auto" source="unpaid invoices" href="/invoices" />
                {(auto?.projectReceivable ?? 0) > 0 && (
                  <BSLine label="Project receivables" hint="one-time / custom project sales, unpaid" amount={auto?.projectReceivable ?? 0} kind="auto" source="project invoices" href="/invoices" />
                )}
                <BSLine label="TDS receivable" hint="credits from customers' TDS" amount={auto?.tdsReceivable ?? 0} kind="auto" source="TDS Receivable" href="/accounting/tds-receivable" />
                {(auto?.employeeLoans ?? 0) > 0 && (
                  <BSLine label="Employee loans / advances" hint="outstanding, owed back" amount={auto?.employeeLoans ?? 0} kind="auto" source="Loans" href="/accounting/loans" />
                )}
                {(auto?.prepaidAdvances ?? 0) > 0 && (
                  <BSLine label="Prepaid / vendor advances" hint="paid, not yet consumed" amount={auto?.prepaidAdvances ?? 0} kind="auto" source="Prepaid" href="/accounting/prepaid" />
                )}
                {(auto?.fixedAssets ?? 0) > 0 && (
                  <BSLine label="Fixed assets (EMI purchases)" hint="vehicles, equipment at cost" amount={auto?.fixedAssets ?? 0} kind="auto" source="Assets & EMIs" href="/accounting/assets" />
                )}
                {gstCredit > 0 && <BSLine label="GST input credit (ITC)" amount={gstCredit} kind="auto" source="GST Reports" href="/accounting/gst" />}
                <ManualLines
                  rows={manualAssetRows}
                  onEdit={setEditItem}
                  onDelete={async (r) => { if (await confirm({ title: "Remove line?", body: `Remove "${r.label}" from the balance sheet?`, confirmLabel: "Remove", danger: true })) del.mutate(r.id); }}
                />
              </div>
              <TotalLine label="Total Assets" amount={totalAssets} />
            </Card>

            {/* ── LIABILITIES + EQUITY ── */}
            <Card className="p-5 md:p-6">
              <SectionTitle>Liabilities</SectionTitle>
              <div className="space-y-1 mt-3">
                <BSLine label="Trade payables" hint="unpaid vendor bills" amount={auto?.payables ?? 0} kind="auto" source="COGS Bills" href="/accounting/bills" />
                {(auto?.salaryPayable ?? 0) > 0 && (
                  <BSLine label="Salary payable" hint="payroll run, not yet paid out" amount={auto?.salaryPayable ?? 0} kind="auto" source="Payroll" href="/payroll" />
                )}
                {(auto?.salaryDuesPayable ?? 0) > 0 && (
                  <BSLine label="Salary dues payable" hint="withheld TDS/PF/ESI, not yet remitted" amount={auto?.salaryDuesPayable ?? 0} kind="auto" source="Payroll" href="/payroll" />
                )}
                {(auto?.reimbursementsPayable ?? 0) > 0 && (
                  <BSLine label="Reimbursements payable" hint="expenses paid from someone's own card, not yet repaid" amount={auto?.reimbursementsPayable ?? 0} kind="auto" source="Reimbursements" href="/accounting/reimbursements" />
                )}
                {(auto?.creditCardPayable ?? 0) > 0 && (
                  <BSLine label="Credit card payable" hint="company credit cards ka owe / udhari" amount={auto?.creditCardPayable ?? 0} kind="auto" source="Banking" href="/accounting/banking" />
                )}
                {(auto?.emiLoansPayable ?? 0) > 0 && (
                  <BSLine label="EMI / asset loans" hint="outstanding financing on purchases" amount={auto?.emiLoansPayable ?? 0} kind="auto" source="Assets & EMIs" href="/accounting/assets" />
                )}
                {(auto?.businessLoansPayable ?? 0) > 0 && (
                  <BSLine label="Bank / business loans" hint="outstanding principal on borrowings" amount={auto?.businessLoansPayable ?? 0} kind="auto" source="Business Loans" href="/accounting/business-loans" />
                )}
                {gstPayable > 0 && (
                  <BSLine label="GST payable" hint={`net, ${auto?.fyLabel ?? "this FY"} — before filing`} amount={gstPayable} kind="auto" source="GST Reports" href="/accounting/gst" />
                )}
                <ManualLines
                  rows={manualLiabRows}
                  onEdit={setEditItem}
                  onDelete={async (r) => { if (await confirm({ title: "Remove line?", body: `Remove "${r.label}" from the balance sheet?`, confirmLabel: "Remove", danger: true })) del.mutate(r.id); }}
                />
              </div>
              <TotalLine label="Total Liabilities" amount={totalLiab} muted />

              <div className="mt-6">
                <SectionTitle>Equity (net worth)</SectionTitle>
                <div className="space-y-1 mt-3">
                  <ManualLines
                    rows={manualEqRows}
                    onEdit={setEditItem}
                    onDelete={async (r) => { if (await confirm({ title: "Remove line?", body: `Remove "${r.label}" from the balance sheet?`, confirmLabel: "Remove", danger: true })) del.mutate(r.id); }}
                  />
                  <BSLine
                    label="Retained earnings"
                    hint="derived so the sheet balances"
                    amount={retained}
                    kind="derived"
                    onInfo={() => setRetainedInfoOpen((o) => !o)}
                  />
                  {retainedInfoOpen && (
                    <div className="mt-1 mb-1 rounded-md border border-hairline bg-paper-2/40 p-3 text-[12px] text-ink-2 leading-relaxed">
                      <p className="font-semibold text-ink mb-1.5 flex items-center gap-1.5">
                        <Icon name="info" size={13} className="text-amber-ink" /> How retained earnings is derived
                      </p>
                      <p className="mb-2">
                        This is a <b>balancing figure</b>, not a stored P&amp;L number — it&apos;s whatever makes
                        <b> Assets = Liabilities + Equity</b> hold exactly.
                      </p>
                      <div className="font-mono text-[11px] space-y-1 bg-paper rounded p-2 border border-hairline">
                        <div className="flex justify-between gap-3"><span>Total assets</span><span className="tabular-nums">{fmtBS(totalAssets)}</span></div>
                        <div className="flex justify-between gap-3"><span>− Total liabilities</span><span className="tabular-nums">{fmtBS(totalLiab)}</span></div>
                        <div className="flex justify-between gap-3"><span>− Owner&apos;s capital &amp; other manual equity</span><span className="tabular-nums">{fmtBS(sum(manualEqRows))}</span></div>
                        <div className="flex justify-between gap-3 border-t border-hairline pt-1 font-semibold text-ink"><span>= Retained earnings</span><span className="tabular-nums">{fmtBS(retained)}</span></div>
                      </div>
                      <p className="mt-2 text-[11px] text-ink-3">
                        A true P&amp;L-based figure (cumulative net income − owner drawings) needs closed-period books — a future enhancement. For now this keeps the sheet balanced and CA-explainable.
                      </p>
                    </div>
                  )}
                </div>
                <TotalLine label="Total Equity" amount={netWorth} muted />
              </div>

              <div className="mt-4 border-t-2 border-ink pt-3">
                <TotalLine label="Total Liabilities + Equity" amount={totalLiab + netWorth} />
              </div>
            </Card>
          </div>

          {/* Balance check — always balanced by construction */}
          <Card className="mt-6 p-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Icon name="check_circle" size={18} className="text-emerald" />
              <span className="text-sm text-ink-2">
                Balanced: <b>Assets {rupee(totalAssets)}</b> = <b>Liabilities + Equity {rupee(totalLiab + netWorth)}</b>
              </span>
            </div>
            <span className={`font-serif text-2xl ${netWorth >= 0 ? "text-emerald" : "text-rose"}`}>
              Net worth {rupee(netWorth)}
            </span>
          </Card>
        </>
      )}

      <AddLineDialog open={addOpen} onClose={() => setAddOpen(false)} />
      {editItem && <EditLineDialog item={editItem} onClose={() => setEditItem(null)} />}
    </div>
  );
}

// ── Line + total primitives ─────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold border-b border-hairline pb-2">
      {children}
    </h2>
  );
}

// Indian accounting notation — negatives in parentheses + red, e.g. (₹2,86,708).
function fmtBS(amount: number): string {
  return amount < 0 ? `(${rupee(Math.abs(amount))})` : rupee(amount);
}

/** One solvency ratio chip inside the Financial-health banner. */
function Ratio({ label, value, good, tip }: { label: string; value: string; good: boolean; tip: string }) {
  return (
    <div title={tip} className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={`font-serif text-lg tabular-nums leading-tight ${good ? "text-emerald" : "text-rose"}`}>{value}</div>
    </div>
  );
}

/** Source-origin badge: 'auto' (pulled from records) vs 'manual' (owner-added)
 *  vs 'derived' (a balancing figure). Distinct colour + icon + explaining tooltip. */
function OriginBadge({ kind, source }: { kind: "auto" | "manual" | "derived"; source?: string }) {
  const cfg = {
    auto:    { icon: "sparkles" as const, cls: "bg-indigo/10 text-indigo",     text: "auto",    tip: source ? `Auto — from ${source}` : "Auto — pulled from your ResellerOS records" },
    manual:  { icon: "edit" as const,     cls: "bg-amber-soft text-amber-ink", text: "manual",  tip: "Manual — you added this line by hand" },
    derived: { icon: "zap" as const,      cls: "bg-slate-soft text-slate",     text: "derived", tip: "Derived — computed so the sheet balances" },
  }[kind];
  return (
    <span title={cfg.tip} className={`inline-flex items-center gap-0.5 rounded-full ${cfg.cls} px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide align-middle`}>
      <Icon name={cfg.icon} size={9} /> {cfg.text}
    </span>
  );
}

function BSLine({
  label, hint, amount, kind, source, href, onEdit, onDelete, onInfo,
}: {
  label: string; hint?: string; amount: number;
  kind?: "auto" | "manual" | "derived";
  source?: string; href?: string;
  onEdit?: () => void; onDelete?: () => void; onInfo?: () => void;
}) {
  const router = useRouter();
  const clickable = !!href;
  const go = () => { if (href) router.push(href as never); };
  return (
    <div
      className={`flex items-start justify-between gap-3 py-1.5 group rounded-md ${clickable ? "cursor-pointer hover:bg-paper-2/50 -mx-2 px-2" : ""}`}
      {...(clickable ? {
        role: "button", tabIndex: 0, onClick: go,
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } },
        title: "Open the source ledger",
      } : {})}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm text-ink">{label}</span>
          {kind && <OriginBadge kind={kind} source={source} />}
          {onInfo && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onInfo(); }}
              className="text-ink-3 hover:text-amber-ink transition-colors" aria-label={`How ${label} is calculated`} title="How this is calculated">
              <Icon name="info" size={13} />
            </button>
          )}
          {clickable && <Icon name="arrow_right" size={12} className="text-ink-3 opacity-0 group-hover:opacity-100 transition-opacity" />}
          {onEdit && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-ink transition-opacity" aria-label={`Edit ${label}`}>
              <Icon name="edit" size={12} />
            </button>
          )}
          {onDelete && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-rose transition-opacity" aria-label={`Remove ${label}`}>
              <Icon name="trash" size={12} />
            </button>
          )}
        </div>
        {hint && <div className="text-[11px] text-ink-3 mt-0.5 leading-snug">{hint}</div>}
      </div>
      <span className={`font-mono text-sm tabular-nums whitespace-nowrap shrink-0 ${amount < 0 ? "text-rose" : "text-ink"}`}>
        {fmtBS(amount)}
      </span>
    </div>
  );
}

/** Manual lines for a section — identical labels (e.g. two "Owner's capital")
 *  fold under ONE parent showing the combined total, expandable to the entries. */
function ManualLines({
  rows, onEdit, onDelete,
}: {
  rows: BalanceSheetItem[];
  onEdit: (r: BalanceSheetItem) => void;
  onDelete: (r: BalanceSheetItem) => void;
}) {
  // Preserve first-seen order of labels.
  const order: string[] = [];
  const byLabel = new Map<string, BalanceSheetItem[]>();
  for (const r of rows) {
    if (!byLabel.has(r.label)) { byLabel.set(r.label, []); order.push(r.label); }
    byLabel.get(r.label)!.push(r);
  }
  return (
    <>
      {order.map((label) => {
        const rs = byLabel.get(label)!;
        if (rs.length === 1) {
          return <BSLine key={rs[0].id} label={label} amount={rs[0].amount} kind="manual"
            onEdit={() => onEdit(rs[0])} onDelete={() => onDelete(rs[0])} />;
        }
        return <ManualGroup key={label} label={label} rows={rs} onEdit={onEdit} onDelete={onDelete} />;
      })}
    </>
  );
}

function ManualGroup({
  label, rows, onEdit, onDelete,
}: {
  label: string; rows: BalanceSheetItem[];
  onEdit: (r: BalanceSheetItem) => void;
  onDelete: (r: BalanceSheetItem) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div>
      <div
        className="flex items-start justify-between gap-3 py-1.5 rounded-md cursor-pointer hover:bg-paper-2/50 -mx-2 px-2"
        role="button" tabIndex={0} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
      >
        <div className="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
          <Icon name={open ? "chevron_down" : "arrow_right"} size={13} className="text-ink-3 shrink-0" />
          <span className="text-sm text-ink">{label}</span>
          <OriginBadge kind="manual" />
          <span className="text-[11px] text-ink-3">· {rows.length} entries</span>
        </div>
        <span className={`font-mono text-sm tabular-nums whitespace-nowrap shrink-0 ${total < 0 ? "text-rose" : "text-ink"}`}>{fmtBS(total)}</span>
      </div>
      {open && (
        <div className="pl-5 border-l border-hairline ml-1">
          {rows.map((r) => (
            <BSLine key={r.id} label={r.notes?.trim() || label} amount={r.amount}
              onEdit={() => onEdit(r)} onDelete={() => onDelete(r)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TotalLine({ label, amount, muted }: { label: string; amount: number; muted?: boolean }) {
  return (
    <div className={`mt-3 pt-2 border-t ${muted ? "border-hairline" : "border-ink-2 border-t-2"} flex items-baseline justify-between gap-3`}>
      <span className={`${muted ? "text-sm text-ink-2" : "text-sm font-semibold text-ink"}`}>{label}</span>
      <span className={`font-mono tabular-nums whitespace-nowrap ${muted ? "text-base text-ink" : "font-serif text-xl text-ink"} ${amount < 0 ? "!text-rose" : ""}`}>
        {fmtBS(amount)}
      </span>
    </div>
  );
}

// ── Add manual line dialog ────────────────────────────────────────────────
const SECTIONS: { value: BalanceSheetSection; label: string; examples: string }[] = [
  { value: "asset",     label: "Asset",     examples: "Fixed assets, deposits, investments" },
  { value: "liability", label: "Liability", examples: "Bank loan, unsecured loan, other dues" },
  { value: "equity",    label: "Equity",    examples: "Owner's capital, drawings (as negative)" },
];

// Guided categories for the Add-line dialog — a non-CA owner picks what a line
// *is*, and we file it under the correct section automatically. `contra` items
// (drawings, depreciation) reduce their side, so we store them as negative even
// if the owner types a positive number — removing the classic sign mistake.
type BSCategory = {
  value: string; label: string; section: BalanceSheetSection;
  examples: string; contra?: boolean;
};
const CATEGORIES: BSCategory[] = [
  { value: "fixed_asset",     label: "Fixed asset",        section: "asset",     examples: "Laptop, furniture, vehicle, machinery" },
  { value: "current_asset",   label: "Deposit / advance",  section: "asset",     examples: "Security deposit, advance paid, investment" },
  { value: "depreciation",    label: "Depreciation (–)",   section: "asset",     examples: "Wear-down of a fixed asset — reduces its value", contra: true },
  { value: "long_term_loan",  label: "Long-term loan",     section: "liability", examples: "Bank term loan, vehicle / equipment loan" },
  { value: "short_term_due",  label: "Short-term due",     section: "liability", examples: "Unsecured loan, friend/family loan, other payable" },
  { value: "owners_capital",  label: "Owner's capital",    section: "equity",    examples: "Money you put into the business" },
  { value: "drawings",        label: "Owner's drawings (–)", section: "equity",  examples: "Money you took out for personal use", contra: true },
];

const schema = z.object({
  label:  z.string().min(2, "Name required"),
  amount: z.coerce.number().int(),
  notes:  z.string().optional(),
});
type FormData = z.infer<typeof schema>;

function EditLineDialog({ item, onClose }: { item: BalanceSheetItem; onClose: () => void }) {
  const update = useUpdateBalanceSheetItem();
  const [label, setLabel] = React.useState(item.label);
  const [amount, setAmount] = React.useState(String(item.amount));

  async function submit() {
    const amt = Math.round(Number(amount));
    if (!label.trim() || !Number.isFinite(amt)) return;
    await update.mutateAsync({ id: item.id, label: label.trim(), amount: amt });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Edit line</DialogTitle>
          <DialogDescription>Update this manual balance-sheet line — e.g. reduce a loan balance after an EMI.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Label</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Amount (₹)</label>
            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="mt-1 text-[11px] text-ink-3">Negative allowed (e.g. depreciation, drawings).</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button variant="primary" loading={update.isPending} disabled={!label.trim()} onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddLineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateBalanceSheetItem();
  const [categoryValue, setCategoryValue] = React.useState<string>("fixed_asset");

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { amount: 0 },
  });

  React.useEffect(() => { if (!open) { reset(); setCategoryValue("fixed_asset"); } }, [open, reset]);

  const category = CATEGORIES.find((c) => c.value === categoryValue) ?? CATEGORIES[0];

  const onSubmit = async (data: FormData) => {
    // File under the category's section; contra items (drawings/depreciation)
    // are stored negative so they reduce their side even if typed positive.
    const amt = category.contra ? -Math.abs(data.amount) : data.amount;
    await create.mutateAsync({
      section: category.section,
      label: data.label.trim(),
      amount: amt,
      notes: category.label,          // remember what kind of line this is
    });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Add balance-sheet line</DialogTitle>
          <DialogDescription>
            Add something the app doesn&apos;t track automatically — a fixed asset, a loan,
            owner&apos;s capital, etc. Pick what it is and we&apos;ll file it correctly.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField label="What kind of line?" required htmlFor="bs-category">
            <Select value={categoryValue} onValueChange={setCategoryValue}>
              <SelectTrigger id="bs-category"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["asset", "liability", "equity"] as BalanceSheetSection[]).map((sec) => {
                  const group = CATEGORIES.filter((c) => c.section === sec);
                  const secLabel = SECTIONS.find((s) => s.value === sec)?.label ?? sec;
                  return (
                    <SelectGroup key={sec}>
                      <SelectLabel>{secLabel}</SelectLabel>
                      {group.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-ink-3 mt-1">
              Goes under <b>{SECTIONS.find((s) => s.value === category.section)?.label}</b> · e.g. {category.examples}
            </p>
          </FormField>

          <FormField label="Name" required htmlFor="bs-label">
            <Input id="bs-label" placeholder="e.g. Office laptop, HDFC term loan, Owner's capital" error={errors.label?.message} {...register("label")} />
          </FormField>

          <FormField label="Amount (₹)" required htmlFor="bs-amount">
            <Input id="bs-amount" type="number" prefix="₹" error={errors.amount?.message} {...register("amount")} />
            <p className="text-[10px] text-ink-3 mt-1">
              {category.contra
                ? "Just type the amount — we'll record it as a reduction automatically."
                : "Enter the current value / outstanding balance."}
            </p>
          </FormField>

          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting || create.isPending}>Add line</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
