/**
 * PnLDrilldownDialog — click a P&L line to see the transactions behind it.
 *
 * The P&L Report shows summary rows (Revenue, COGS, Operating expenses) and their sub-rows
 * (Revenue by product, Licence cost by vendor, expenses by category). Each is the SUM of real
 * records in the selected period. This dialog lists exactly the records behind the row clicked,
 * with a total that equals the row (R-2181: "Total ₹X = <row> ₹X", a red note when it does not —
 * never hidden).
 *
 *   revenue  → SQL report_pnl_revenue_lines: invoices, credit notes (−) and debit notes of the
 *              period, ex-GST, only the row's product families (lib/accounting/pnl-drill.ts)
 *   cogs     → COGS vendor bills of the row's vendor at what the P&L counts (pre-GST + GST that
 *              is not credit) + the estimated parts (R-2095)
 *   expenses → operating expenses in the period
 *
 * Read-only. No money is written here — it's a lens onto existing data.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { DIRECTOR_REMUNERATION_CATEGORY, SALARIES_CATEGORY, pnlCategoryOf } from "@/lib/accounting/director-remuneration";
import { fetchDirectorPayroll } from "@/lib/queries/director-payroll";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { rupee, formatDate } from "@/lib/utils";
import { signedRupee } from "@/lib/accounting/net-figure";
import type { CogsEstimateBasis } from "@/lib/accounting/pnl";
import {
  cogsDrillRows, drillTie, revenueDrillRows,
  type CogsBillRow, type DrillRow, type PnLDrillKind, type PnLDrillTarget, type RevenueLineRow,
} from "@/lib/accounting/pnl-drill";

export type { PnLDrillKind, PnLDrillTarget } from "@/lib/accounting/pnl-drill";

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  /** What was clicked: the line, its sub-row filter and the amount shown on it. */
  target:       PnLDrillTarget | null;
  range:        { from: string; to: string };
  /** R-2095: the licence cost is (partly) estimated — show how, on the COGS drill. */
  cogsEstimate?: CogsEstimateBasis | null;
}

const META: Record<PnLDrillKind, { title: string; desc: string; href: string; hrefLabel: string; tone: "ink" | "rose"; groupLabel: string }> = {
  revenue: {
    title: "Revenue — invoices in this period",
    desc:  "Invoices issued in the range, less credit notes and plus debit notes dated in it. Amounts are before GST (GST is collected for the government, not earned). Accrual basis — counted on the document date, not the payment date.",
    href:  "/invoices",
    hrefLabel: "Open Invoices",
    tone:  "ink",
    groupLabel: "customer",
  },
  cogs: {
    title: "Cost of goods — vendor bills in this period",
    desc:  "Vendor bills categorised as cost of goods (Google / Microsoft / Zoho wholesale), at pre-GST cost plus any GST that cannot be claimed back — the amount that reduces gross margin. A vendor with no bill yet shows its estimate.",
    href:  "/accounting/bills",
    hrefLabel: "Open Vendor Bills",
    tone:  "rose",
    groupLabel: "vendor",
  },
  expenses: {
    title: "Operating expenses — this period",
    desc:  "All operating expenses booked in the range (rent, salaries, software, marketing…). GST paid is shown separately in the GST snapshot.",
    href:  "/accounting/expenses",
    hrefLabel: "Open Expenses",
    tone:  "rose",
    groupLabel: "payee",
  },
};

type RevenueLinesRpc = (
  fn: "report_pnl_revenue_lines", args: { p_from: string; p_to: string; p_families: string[] | null },
) => PromiseLike<{ data: RevenueLineRow[] | null; error: { code?: string; message: string } | null }>;

function useDrilldown(target: PnLDrillTarget | null, range: { from: string; to: string }, enabled: boolean) {
  const kind = target?.kind ?? null;
  return useQuery({
    queryKey: ["accounting", "pnl-drill", kind, range, target?.families ?? null, target?.excludeFamilies ?? null,
               target?.vendors ?? null, target?.estimates ?? null, target?.projectCost ?? null, target?.category ?? null],
    enabled:  enabled && !!kind,
    queryFn: async (): Promise<DrillRow[]> => {
      const supabase = createClient();

      if (kind === "revenue") {
        /* R-2181: the same rows report_pnl_revenue_by_product adds up (ex-GST, net of notes,
           sales only — R-1739), only the families of the row clicked. */
        const rpc = supabase.rpc as unknown as RevenueLinesRpc;
        const { data, error } = await rpc.call(supabase, "report_pnl_revenue_lines", {
          p_from: range.from, p_to: range.to,
          p_families: target?.families && target.families.length > 0 ? target.families : null,
        });
        if (error) throw new Error(error.message);
        return revenueDrillRows(data ?? [], target ?? {});
      }

      if (kind === "cogs") {
        const [{ data, error }, { data: tenant }] = await Promise.all([
          supabase
            .from("vendor_bills")
            .select("id, vendor_name, bill_no, bill_date, subtotal, category, cgst, sgst, igst, document_type, vendor_gstin")
            .gte("bill_date", range.from)
            .lte("bill_date", range.to)
            .like("category", "COGS-%")
            .order("bill_date", { ascending: false }),
          supabase.from("tenants").select("state_code, gstin").limit(1).maybeSingle(),
        ]);
        if (error) throw error;
        /* Our state, as report_pnl reads it — for the bill's GST credit check (R-1576). */
        const own = tenant?.state_code?.trim() || stateCodeFromGstin(tenant?.gstin ?? null) || null;
        return cogsDrillRows((data ?? []) as CogsBillRow[], target ?? {}, own, range);
      }

      // expenses
      const expenseCategory = target?.category ?? null;
      /* R-1852: a director-employee's payroll is on the P&L's Director's Remuneration line, so
         that line's drill-down lists it and the Salaries one does not — the rows add up to the line. */
      const payLine = expenseCategory === SALARIES_CATEGORY || expenseCategory === DIRECTOR_REMUNERATION_CATEGORY;
      const directorIds = new Set(payLine ? (await fetchDirectorPayroll(supabase)).map((p) => p.id) : []);
      let q = supabase
        .from("expenses")
        .select("id, category, vendor_name, description, expense_date, amount, payment_method")
        .gte("expense_date", range.from)
        .lte("expense_date", range.to);
      if (payLine) q = q.in("category", [SALARIES_CATEGORY, DIRECTOR_REMUNERATION_CATEGORY]);
      else if (expenseCategory) q = q.eq("category", expenseCategory);
      const { data, error } = await q.order("expense_date", { ascending: false });
      if (error) throw error;
      const rows = payLine ? (data ?? []).filter((e) => pnlCategoryOf(e, directorIds) === expenseCategory) : (data ?? []);
      return rows.map((e) => {
        // Primary = who we paid (the employee for salaries, the vendor otherwise)
        // so grouping buckets by payee — e.g. each employee's salary total —
        // instead of one giant "Salaries" bucket. Category + period go in the
        // detail line; the trailing " — <name>" is stripped (it's the header).
        const period = (e.description ?? "").split(" — ")[0].trim();
        return {
          id:      e.id,
          date:    e.expense_date,
          primary: e.vendor_name || e.category || "Expense",
          sub:     [directorIds.has(e.id) ? `${DIRECTOR_REMUNERATION_CATEGORY} (payroll)` : e.category, period || e.payment_method].filter(Boolean).join(" · ") || "—",
          amount:  e.amount ?? 0,
        };
      });
    },
  });
}

export function PnLDrilldownDialog({ open, onOpenChange, target, range, cogsEstimate }: Props) {
  const kind = target?.kind ?? null;
  const expenseCategory = target?.category ?? null;
  /* The estimate's working only on a drill that lists an estimated part. */
  const estimate = kind === "cogs" && (target?.vendors === undefined || (target?.estimates?.length ?? 0) > 0) ? cogsEstimate ?? null : null;
  const { data: rows, isLoading, isError } = useDrilldown(target, range, open);
  const meta = kind ? META[kind] : null;
  const amountColor = meta?.tone === "rose" ? "text-rose" : "text-ink";
  /* A sub-row (a product, a vendor, a category) is named in the title. */
  const subRow = (kind === "revenue" && (target?.families || target?.excludeFamilies)) || (kind === "cogs" && target?.vendors);
  const title = kind === "expenses" && expenseCategory ? `${expenseCategory} — this period`
    : subRow && target?.label ? `${target.label} — ${kind === "revenue" ? "revenue" : "cost of goods"} this period`
    : (meta?.title ?? "Details");

  const [search, setSearch] = React.useState("");
  const [grouped, setGrouped] = React.useState(false);
  // Groups start collapsed (headers + subtotals only); click a header to slide
  // its rows open. A search auto-reveals all so matches aren't hidden.
  const [openGroups, setOpenGroups] = React.useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  // Fresh controls each time the dialog opens or the line changes.
  React.useEffect(() => { setSearch(""); setGrouped(false); setOpenGroups(new Set()); }, [target, open]);
  // Collapse everything again whenever grouping is toggled on.
  React.useEffect(() => { if (grouped) setOpenGroups(new Set()); }, [grouped]);

  // Search filters on the visible text (primary + sub). Total + count always
  // reflect what's shown, so a filtered/grouped view still reconciles to itself.
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows ?? [];
    return (rows ?? []).filter((r) => `${r.primary} ${r.sub}`.toLowerCase().includes(q));
  }, [rows, search]);

  const total = filtered.reduce((s, r) => s + r.amount, 0);
  /* The tie is on EVERY row of the drill, not the searched subset. */
  const allTotal = (rows ?? []).reduce((s, r) => s + r.amount, 0);
  const tie = !isLoading && !isError && rows ? drillTie(allTotal, target?.expected) : null;

  // Group by the main label (category / customer / vendor), biggest group first.
  const groups = React.useMemo(() => {
    const m = new Map<string, { rows: DrillRow[]; subtotal: number }>();
    for (const r of filtered) {
      const g = m.get(r.primary) ?? { rows: [], subtotal: 0 };
      g.rows.push(r); g.subtotal += r.amount;
      m.set(r.primary, g);
    }
    return [...m.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.subtotal - a.subtotal);
  }, [filtered]);

  const hasData = rows && rows.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] p-0 gap-0 flex flex-col max-h-[85vh]">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-hairline">
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            {meta?.desc}
          </DialogDescription>
          <p className="text-xs text-ink-3 mt-1">
            {range.from} to {range.to}
          </p>
        </DialogHeader>

        {/* Search + group controls */}
        {hasData && (
          <div className="px-5 pt-3 pb-2 flex items-center gap-2 border-b border-hairline">
            <div className="relative flex-1">
              <Icon name="search" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input aria-label="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="w-full rounded-md border border-hairline bg-paper pl-7 pr-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
              />
            </div>
            <button
              type="button"
              onClick={() => setGrouped((v) => !v)}
              aria-pressed={grouped}
              title={`Group by ${meta?.groupLabel ?? "type"}`}
              className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                grouped ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline text-ink-2 hover:border-hairline-strong"
              }`}
            >
              <Icon name="layout" size={13} /> Group
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
          {estimate && <CogsEstimateCard basis={estimate} />}
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : isError ? (
            <div role="alert" className="rounded-md border border-rose/40 bg-rose/5 px-4 py-6 text-center">
              <p className="text-sm text-rose">The transactions could not load.</p>
              <p className="text-xs text-ink-3 mt-1">Close this and click the row again. If it keeps failing, tell the person who looks after the app.</p>
            </div>
          ) : !hasData ? (
            <div className="rounded-md border border-dashed border-hairline bg-paper-2/20 px-4 py-8 text-center">
              <Icon name="inbox" size={20} className="text-ink-3 mx-auto mb-1" />
              <p className="text-sm text-ink-2">{estimate ? "No vendor bills in this period yet" : "No transactions in this period"}</p>
              <p className="text-xs text-ink-3 mt-1">
                Nothing recorded between {range.from} and {range.to}.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-dashed border-hairline bg-paper-2/20 px-4 py-8 text-center">
              <Icon name="search" size={18} className="text-ink-3 mx-auto mb-1" />
              <p className="text-sm text-ink-2">No matches for “{search}”</p>
            </div>
          ) : grouped ? (
            <div className="space-y-2">
              {groups.map((g) => {
                const isOpen = search.trim() !== "" || openGroups.has(g.key);
                return (
                  <div key={g.key} className="border-b border-hairline last:border-0">
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.key)}
                      aria-expanded={isOpen}
                      className="w-full flex items-center justify-between gap-3 py-2 text-left group"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <Icon
                          name="chevron_down"
                          size={13}
                          className={`text-ink-3 shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`}
                        />
                        <span className="text-2xs font-semibold uppercase tracking-wider text-ink-2 truncate group-hover:text-ink">
                          {g.key} <span className="text-ink-3">· {g.rows.length}</span>
                        </span>
                      </span>
                      <span className={`font-mono text-sm font-semibold ${amountColor}`}>{signedRupee(g.subtotal)}</span>
                    </button>
                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div
                          key="body"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: "easeInOut" }}
                          className="overflow-hidden"
                        >
                          <ul className="divide-y divide-hairline pl-[18px] pb-1">
                            {g.rows.map((r) => (
                              <li key={r.id} className="flex items-center gap-3 py-2">
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs text-ink-3 truncate">{r.sub}</p>
                                </div>
                                <div className="text-right whitespace-nowrap">
                                  <p className={`font-mono text-sm ${amountColor}`}>{signedRupee(r.amount)}</p>
                                  <p className="text-xs text-ink-3">{formatDate(r.date)}</p>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {filtered.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink truncate">{r.primary}</p>
                    <p className="text-xs text-ink-3 truncate">{r.sub}</p>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <p className={`font-mono text-sm ${amountColor}`}>{signedRupee(r.amount)}</p>
                    <p className="text-xs text-ink-3">{formatDate(r.date)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {hasData && filtered.length > 0 && (
          <div className="px-5 py-3 border-t border-hairline flex items-center justify-between gap-3 bg-paper-2/30">
            <span className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
              {grouped ? `${groups.length} ${groups.length === 1 ? "group" : "groups"} · ` : ""}
              Total · {filtered.length} {filtered.length === 1 ? "item" : "items"}
              {search.trim() ? " (filtered)" : ""}
            </span>
            <span className={`font-mono text-base font-semibold ${amountColor}`}>{signedRupee(total)}</span>
          </div>
        )}

        {/* R-2181: the drill total against the number clicked — said when equal, red when not. */}
        {tie && target?.expected != null && (
          tie.ties ? (
            <p data-testid="pnl-drill-tie" className="px-5 py-2 border-t border-hairline text-xs text-ink-2">
              Total {signedRupee(allTotal)} = {target.label ?? "row"} {signedRupee(target.expected)}
            </p>
          ) : (
            <p data-testid="pnl-drill-tie" role="alert" className="px-5 py-2 border-t border-hairline text-xs text-rose">
              Total {signedRupee(allTotal)} does not match {target.label ?? "the row"} {signedRupee(target.expected)} — a gap of {rupee(Math.abs(tie.diff))}.
              The list may be missing a document, or the row counts one the list does not.
            </p>
          )
        )}

        {meta && (
          <div className="px-5 py-3 border-t border-hairline">
            <Link
              href={meta.href as never}
              className="text-xs text-amber-ink hover:underline inline-flex items-center gap-1"
            >
              {meta.hrefLabel} <Icon name="arrow_right" size={12} />
            </Link>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * R-2095 (staging P&L, 30 Oct 2026): an estimated licence cost opened an empty bill list. The
 * estimate's working, and the next step that makes it exact — a vendor bill.
 */
export function CogsEstimateCard({ basis }: { basis: CogsEstimateBasis }) {
  return (
    <section aria-label="How the licence cost is estimated" className="mb-3 rounded-md border border-amber/40 bg-amber-soft/30 p-3 space-y-2">
      <p className="text-sm text-ink">
        <span className="font-semibold">{rupee(basis.estimated)} estimated</span>
        {basis.ratioPct !== null
          ? <> = licence revenue {rupee(basis.licenceRevenue)} × {basis.ratioPct}% (what your subscriptions cost you ÷ what they are priced at)</>
          : <> from your subscriptions' wholesale cost</>}
        .
      </p>
      {basis.vendors.length > 0 && (
        <table className="w-full text-xs tabular-nums">
          <thead className="text-ink-3">
            <tr>
              <th className="text-left font-medium">Vendor (no bill yet)</th>
              <th className="text-right font-medium">Subs · seats</th>
              <th className="text-right font-medium">Price</th>
              <th className="text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {basis.vendors.map((v) => (
              <tr key={v.vendor} className="border-t border-hairline">
                <td className="py-1 text-ink-2">{v.label}</td>
                <td className="py-1 text-right text-ink-2">{v.subscriptions} · {v.seats}</td>
                <td className="py-1 text-right text-ink-2">{rupee(v.bookRevenue)}</td>
                <td className="py-1 text-right text-ink-2">{rupee(v.bookCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xs text-ink-3">Enter the vendor's invoice (Google / Microsoft / Zoho) to replace the estimate with the real cost.</p>
        <Link href={"/accounting/bills?add=1" as never} className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
          <Icon name="plus" size={13} /> Add vendor bill
        </Link>
      </div>
    </section>
  );
}
