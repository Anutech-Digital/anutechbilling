/**
 * R-2350: the Security log list — one row per customer / lead detail opened, or export.
 * Presentational only; the page loads the rows and the names.
 */
"use client";

import Link from "next/link";
import type { Route } from "next";
import { Badge } from "@/components/ui/badge";
import {
  actionLabel, detailText, recordHref, recordText, whenText, RECORD_TYPE_LABEL, type SecurityLogRow,
} from "@/lib/security-log/log";

export interface LogTableProps {
  rows: readonly SecurityLogRow[];
  personOf: (userId: string | null) => string;
}

export function LogTable({ rows, personOf }: LogTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-hairline bg-paper">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-paper-2 text-left text-xs uppercase tracking-wider text-ink-3">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">When</th>
            <th scope="col" className="px-3 py-2 font-semibold">Person</th>
            <th scope="col" className="px-3 py-2 font-semibold">Action</th>
            <th scope="col" className="px-3 py-2 font-semibold">Record</th>
            <th scope="col" className="px-3 py-2 font-semibold">Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const href = recordHref(r);
            const text = recordText(r);
            return (
              <tr key={`${r.record_type}-${r.id}`} className="border-t border-hairline align-top" data-testid={`security-row-${r.id}`}>
                <td className="px-3 py-2 whitespace-nowrap text-ink-2">{whenText(r.at)}</td>
                <td className="px-3 py-2 text-ink">{personOf(r.user_id)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <Badge kind={r.action === "export" ? "warning" : "muted"} size="sm">{actionLabel(r)}</Badge>
                </td>
                <td className="px-3 py-2">
                  <span className="mr-1.5 text-xs text-ink-3">{RECORD_TYPE_LABEL[r.record_type] ?? r.record_type}</span>
                  {href ? (
                    <Link href={href as Route} className="text-ink underline-offset-2 hover:underline [overflow-wrap:anywhere]">{text}</Link>
                  ) : (
                    <span className="text-ink [overflow-wrap:anywhere]">{text}</span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-ink-3">{detailText(r) || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
