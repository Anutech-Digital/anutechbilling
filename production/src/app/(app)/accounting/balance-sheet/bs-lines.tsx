/** Balance Sheet line + total primitives and the equity CSV rows — moved out of page.tsx (lint max-lines), no change. */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { StatementRow } from "@/components/ui/statement-row";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenRoute } from "@/lib/nav";
import { type BalanceSheetItem } from "@/lib/queries/balance-sheet";
import { fmtBS } from "./format";
import { type EquityGroup } from "@/lib/accounting/equity-section";

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold border-b border-hairline pb-2">
      {children}
    </h2>
  );
}


/** One solvency ratio chip inside the Financial-health banner. */
export function Ratio({ label, value, good, tip }: { label: string; value: string; good: boolean; tip: string }) {
  return (
    <div title={tip} className="min-w-0">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={`font-serif text-lg tabular-nums leading-tight ${good ? "text-emerald" : "text-rose"}`}>{value}</div>
    </div>
  );
}

/** Source-origin badge: 'auto' (pulled from records) vs 'manual' (owner-added)
 *  vs 'derived' (a balancing figure). Distinct colour + icon + explaining tooltip. */
export function OriginBadge({ kind, source }: { kind: "auto" | "manual" | "derived"; source?: string }) {
  const cfg = {
    auto:    { icon: "sparkles" as const, cls: "bg-indigo/10 text-indigo",     text: "auto",    tip: source ? `Auto — from ${source}` : "Auto — pulled from your ResellerOS records" },
    manual:  { icon: "edit" as const,     cls: "bg-amber-soft text-amber-ink", text: "manual",  tip: "Manual — you added this line by hand" },
    derived: { icon: "zap" as const,      cls: "bg-slate-soft text-slate",     text: "derived", tip: "Derived — computed so the sheet balances" },
  }[kind];
  return (
    <span title={cfg.tip} className={`inline-flex items-center gap-0.5 rounded-full ${cfg.cls} px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide align-middle`}>
      <Icon name={cfg.icon} size={9} /> {cfg.text}
    </span>
  );
}

export function BSLine({
  label, hint, amount, kind, source, href, onEdit, onDelete, onInfo,
}: {
  label: string; hint?: string; amount: number;
  kind?: "auto" | "manual" | "derived";
  source?: string; href?: string;
  onEdit?: () => void; onDelete?: () => void; onInfo?: () => void;
}) {
  const router = useRouter();
  /* R-255: a line links to its source page only when this role may open it — the guard used to
     send the accountant to the P&L, silently, from a link it could not follow. */
  const role = useCurrentUser().data?.role;
  const clickable = !!href && canOpenRoute(role, href);
  const go = () => { if (href && clickable) router.push(href as never); };
  return (
    <StatementRow
      clickable={clickable}
      className="flex items-start justify-between gap-3 py-1.5 group"
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
          {clickable && <Icon name="arrow_right" size={12} className="text-ink-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity" />}
          {/* R-1899: keyboard focus shows the row's buttons too, not only the mouse. */}
          {onEdit && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-ink-3 hover:text-ink transition-opacity" aria-label={`Edit ${label}`}>
              <Icon name="edit" size={12} />
            </button>
          )}
          {onDelete && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-ink-3 hover:text-rose transition-opacity" aria-label={`Remove ${label}`}>
              <Icon name="trash" size={12} />
            </button>
          )}
        </div>
        {hint && <div className="text-xs text-ink-3 mt-0.5 leading-snug">{hint}</div>}
      </div>
      <span className={`font-mono text-sm tabular-nums whitespace-nowrap shrink-0 ${amount < 0 ? "text-rose" : "text-ink"}`}>
        {fmtBS(amount)}
      </span>
    </StatementRow>
  );
}

/** Manual lines for a section — identical labels (e.g. two "Owner's capital")
 *  fold under ONE parent showing the combined total, expandable to the entries. */
export function ManualLines({
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

export function ManualGroup({
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
      <StatementRow
        clickable
        className="flex items-start justify-between gap-3 py-1.5"
        role="button" tabIndex={0} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
      >
        <div className="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
          <Icon name={open ? "chevron_down" : "arrow_right"} size={13} className="text-ink-3 shrink-0" />
          <span className="text-sm text-ink">{label}</span>
          <OriginBadge kind="manual" />
          <span className="text-xs text-ink-3">· {rows.length} entries</span>
        </div>
        <span className={`font-mono text-sm tabular-nums whitespace-nowrap shrink-0 ${total < 0 ? "text-rose" : "text-ink"}`}>{fmtBS(total)}</span>
      </StatementRow>
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

export function TotalLine({ label, amount, muted }: { label: string; amount: number; muted?: boolean }) {
  return (
    <StatementRow className={`mt-3 pt-2 pb-1 border-t ${muted ? "border-hairline" : "border-ink-2 border-t-2"} flex items-baseline justify-between gap-3`}>
      <span className={`${muted ? "text-sm text-ink-2" : "text-sm font-semibold text-ink"}`}>{label}</span>
      {/* R-1899: plain text-rose (no important flag) so the highlighted row can darken it to rose-ink. */}
      <span className={`font-mono tabular-nums whitespace-nowrap ${muted ? "text-base" : "font-serif text-xl"} ${amount < 0 ? "text-rose" : "text-ink"}`}>
        {fmtBS(amount)}
      </span>
    </StatementRow>
  );
}


/** R-1845: the equity section as CSV rows — group headings, lines, totals (same layout as the screen). */
export function equityCsvRows(groups: EquityGroup<BalanceSheetItem>[]): [string, number | string][] {
  const out: [string, number | string][] = [];
  for (const g of groups) {
    if (g.title) out.push([g.title, ""]);
    for (const r of g.rows) {
      if (r.kind === "manual") for (const i of r.items) out.push([i.label, i.amount]);
      else out.push([r.label, r.amount]);
    }
    if (g.total) out.push([`${g.total.label} (${g.total.hint})`, g.total.amount]);
  }
  return out;
}
