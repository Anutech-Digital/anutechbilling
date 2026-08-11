/**
 * PnLDrilldownDialog — click a P&L line to see the transactions behind it.
 *
 * The P&L Report shows summary rows (Revenue, COGS, Operating expenses). Each
 * of those is the SUM of real records in the selected period. This dialog is
 * the "show me the rows" popup: pick a kind + the same date range and it lists
 * every underlying transaction, with a total that reconciles to the P&L line.
 *
 *   revenue  → invoices issued in the period (pending / paid / overdue)
 *   cogs     → vendor bills categorised COGS-* (shown at pre-GST subtotal)
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
import { rupee, formatDate } from "@/lib/utils";

export type PnLDrillKind = "revenue" | "cogs" | "expenses";

interface DrillRow {
  id:      string;
  date:    string;
  primary: string;   // main label (customer / vendor / category)
  sub:     string;   // secondary (invoice no + status / category / vendor·method)
  amount:  number;   // the value that feeds the P&L line
}

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  kind:         PnLDrillKind | null;
  range:        { from: string; to: string };
  /** When set on an "expenses" drill, show only this category's entries. */
  expenseCategory?: string | null;
}

const META: Record<PnLDrillKind, { title: string; desc: string; href: string; hrefLabel: string; tone: "ink" | "rose"; groupLabel: string }> = {
  revenue: {
    title: "Revenue — invoices in this period",
    desc:  "Every invoice issued in the range (pending, paid or overdue). Accrual basis — counted on invoice date, not payment date.",
    href:  "/invoices",
    hrefLabel: "Open Invoices",
    tone:  "ink",
    groupLabel: "customer",
  },
  cogs: {
    title: "COGS — vendor bills in this period",
    desc:  "Vendor bills categorised as cost-of-goods (Google / Microsoft / Zoho wholesale). Shown at pre-GST cost — the amount that reduces gross margin.",
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

function useDrilldown(kind: PnLDrillKind | null, range: { from: string; to: string }, enabled: boolean, expenseCategory?: string | null) {
  return useQuery({
    queryKey: ["accounting", "pnl-drill", kind, range, expenseCategory ?? null],
    enabled:  enabled && !!kind,
    queryFn: async (): Promise<DrillRow[]> => {
      const supabase = createClient();

      if (kind === "revenue") {
        const { data, error } = await supabase
          .from("invoices")
          .select("id, customer_name, invoice_date, amount, status")
          .gte("invoice_date", range.from)
          .lte("invoice_date", range.to)
          .in("status", ["pending", "paid", "overdue"])
          .order("invoice_date", { ascending: false });
        if (error) throw error;
        return (data ?? []).map((i) => ({
          id:      i.id,
          date:    i.invoice_date,
          primary: i.customer_name || "Customer",
          sub:     `${i.id} · ${i.status}`,
          amount:  i.amount ?? 0,
        }));
      }

      if (kind === "cogs") {
        const { data, error } = await supabase
          .from("vendor_bills")
          .select("id, vendor_name, bill_no, bill_date, subtotal, category")
          .gte("bill_date", range.from)
          .lte("bill_date", range.to)
          .like("category", "COGS-%")
          .order("bill_date", { ascending: false });
        if (error) throw error;
        return (data ?? []).map((b) => ({
          id:      b.id,
          date:    b.bill_date,
          primary: b.vendor_name || "Vendor",
          sub:     [b.category?.replace(/^COGS-/, ""), b.bill_no].filter(Boolean).join(" · "),
          amount:  b.subtotal ?? 0,
        }));
      }

      // expenses
      let q = supabase
        .from("expenses")
        .select("id, category, vendor_name, description, expense_date, amount, payment_method")
        .gte("expense_date", range.from)
        .lte("expense_date", range.to);
      if (expenseCategory) q = q.eq("category", expenseCategory);
      const { data, error } = await q.order("expense_date", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((e) => {
        // Primary = who we paid (the employee for salaries, the vendor otherwise)
        // so grouping buckets by payee — e.g. each employee's salary total —
        // instead of one giant "Salaries" bucket. Category + period go in the
        // detail line; the trailing " — <name>" is stripped (it's the header).
        const period = (e.description ?? "").split(" — ")[0].trim();
        return {
          id:      e.id,
          date:    e.expense_date,
          primary: e.vendor_name || e.category || "Expense",
          sub:     [e.category, period || e.payment_method].filter(Boolean).join(" · ") || "—",
          amount:  e.amount ?? 0,
        };
      });
    },
  });
}

export function PnLDrilldownDialog({ open, onOpenChange, kind, range, expenseCategory }: Props) {
  const { data: rows, isLoading } = useDrilldown(kind, range, open, expenseCategory);
  const meta = kind ? META[kind] : null;
  const amountColor = meta?.tone === "rose" ? "text-rose" : "text-ink";
  const title = kind === "expenses" && expenseCategory ? `${expenseCategory} — this period` : (meta?.title ?? "Details");

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
  React.useEffect(() => { setSearch(""); setGrouped(false); setOpenGroups(new Set()); }, [kind, open, expenseCategory]);
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
          <p className="text-[11px] text-ink-3 mt-1">
            {range.from} to {range.to}
          </p>
        </DialogHeader>

        {/* Search + group controls */}
        {hasData && (
          <div className="px-5 pt-3 pb-2 flex items-center gap-2 border-b border-hairline">
            <div className="relative flex-1">
              <Icon name="search" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
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
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : !hasData ? (
            <div className="rounded-md border border-dashed border-hairline bg-paper-2/20 px-4 py-8 text-center">
              <Icon name="inbox" size={20} className="text-ink-3 mx-auto mb-1" />
              <p className="text-sm text-ink-2">No transactions in this period</p>
              <p className="text-[11px] text-ink-3 mt-1">
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
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-2 truncate group-hover:text-ink">
                          {g.key} <span className="text-ink-3">· {g.rows.length}</span>
                        </span>
                      </span>
                      <span className={`font-mono text-sm font-semibold ${amountColor}`}>{rupee(g.subtotal)}</span>
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
                                  <p className="text-[11px] text-ink-3 truncate">{r.sub}</p>
                                </div>
                                <div className="text-right whitespace-nowrap">
                                  <p className={`font-mono text-sm ${amountColor}`}>{rupee(r.amount)}</p>
                                  <p className="text-[11px] text-ink-3">{formatDate(r.date)}</p>
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
                    <p className="text-[11px] text-ink-3 truncate">{r.sub}</p>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <p className={`font-mono text-sm ${amountColor}`}>{rupee(r.amount)}</p>
                    <p className="text-[11px] text-ink-3">{formatDate(r.date)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {hasData && filtered.length > 0 && (
          <div className="px-5 py-3 border-t border-hairline flex items-center justify-between gap-3 bg-paper-2/30">
            <span className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">
              {grouped ? `${groups.length} ${groups.length === 1 ? "group" : "groups"} · ` : ""}
              Total · {filtered.length} {filtered.length === 1 ? "item" : "items"}
              {search.trim() ? " (filtered)" : ""}
            </span>
            <span className={`font-mono text-base font-semibold ${amountColor}`}>{rupee(total)}</span>
          </div>
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
