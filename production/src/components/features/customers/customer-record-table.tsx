/**
 * Clickable record table for the customer page (Transactions, Statement, Projects).
 *
 * R-1521 (17 Oct 2026, Pardeep): a row on the Transactions tab did nothing when clicked —
 * only quotes and projects had a click, and even those were a JS push, so Ctrl+click,
 * middle-click and "open in new tab" did not work. Now a row carries an `href`:
 *   · the reference cell is a real <a> (RowLink) — Tab reaches it, Enter opens it,
 *     Ctrl/⌘+click and middle-click open a new tab like any link;
 *   · the rest of the row opens the same address (Ctrl/⌘+click on the row → new tab too).
 * Extracted from customer-profile.tsx so the behaviour can be tested on its own.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export interface RecordRow {
  cells: React.ReactNode[];
  /** Where the row's document lives — preferred over onClick. */
  href?: string | null;
  /** Accessible name for the row when it opens something. */
  label?: string;
  onClick?: () => void;
}

/** The reference text as a real link. Stops the click so the row does not open it twice. */
export function RowLink({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <Link
      href={href as Route}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="text-amber-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm"
    >
      {children}
    </Link>
  );
}

/** A click on a link / button inside the row is that control's, not the row's. */
function fromInnerControl(e: React.SyntheticEvent): boolean {
  const t = e.target as HTMLElement | null;
  const hit = t?.closest?.("a,button,input,select,textarea");
  return !!hit && hit !== e.currentTarget;
}

export function RecordTable({ head, rows }: { head: string[]; rows: RecordRow[] }) {
  const router = useRouter();
  const activate = (r: RecordRow, newTab: boolean) => {
    if (r.href) {
      if (newTab) window.open(r.href, "_blank", "noopener");
      else router.push(r.href as Route);
      return;
    }
    r.onClick?.();
  };
  const opens = (r: RecordRow) => !!r.href || !!r.onClick;

  return (
    <>
      {/* Mobile: each row as a stacked label→value card (table side-scrolls on
          phones, §20). Uses the column heads as labels so it stays generic. */}
      <ul className="md:hidden space-y-2">
        {rows.map((r, i) => (
          <li key={i}>
            {/* R-468 (7): never a button ELEMENT here — the cells hold their own buttons (expand
                chevron, delete payment), and a button inside a button is invalid HTML (React logged
                a hydration error on every Transactions open).
                R-1521: a row with an address is NOT role="button" either — it holds a real <a>
                (RowLink), and a link inside a button is the same nesting problem for a screen
                reader. Keyboard users Tab to that link; the card itself only takes the tap.
                role="button" is kept only for a row that opens via onClick and holds no link. */}
            <div
              role={!r.href && r.onClick ? "button" : undefined}
              tabIndex={!r.href && r.onClick ? 0 : undefined}
              aria-label={!r.href && r.onClick ? r.label : undefined}
              data-href={r.href ?? undefined}
              onClick={opens(r) ? (e) => { if (!fromInnerControl(e)) activate(r, e.ctrlKey || e.metaKey); } : undefined}
              onKeyDown={!r.href && r.onClick ? (e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(r, false); }
              } : undefined}
              className={cn(
                "w-full text-left rounded-md border border-hairline bg-paper p-3 space-y-1.5",
                opens(r) ? "cursor-pointer hover:bg-paper-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber" : "cursor-default",
              )}
            >
              {r.cells.map((cell, j) => (
                <div key={j} className="flex items-baseline justify-between gap-3">
                  <span className="text-3xs uppercase tracking-wider text-ink-3 shrink-0">{head[j]}</span>
                  <span className="text-sm text-ink-2 text-right min-w-0 break-words">{cell}</span>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {/* Desktop / tablet table */}
      <div className="hidden md:block border border-hairline rounded-md overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-paper-2/50">
            <tr>
              {head.map((h, j) => (
                <th key={`${h}-${j}`} className="text-left px-3 py-2 text-3xs font-semibold text-ink-3 uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r, i) => (
              <tr
                key={i}
                data-href={r.href ?? undefined}
                onClick={opens(r) ? (e) => { if (!fromInnerControl(e)) activate(r, e.ctrlKey || e.metaKey); } : undefined}
                /* Middle-click on the row opens a new tab, like the link in it. */
                onAuxClick={r.href ? (e) => { if (e.button === 1 && !fromInnerControl(e)) activate(r, true); } : undefined}
                className={cn("hover:bg-paper-2/30", opens(r) && "cursor-pointer")}
              >
                {r.cells.map((cell, j) => <td key={j} className="px-3 py-2 text-ink-2 whitespace-nowrap">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
