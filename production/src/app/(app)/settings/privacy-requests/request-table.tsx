/**
 * R-2013: the Privacy requests list — one row per confirmed request: who, what, received,
 * due by (with an Overdue badge), status, and the next steps (Export JSON / CSV, Mark
 * corrected, Close). Presentational only; the page wires the actions.
 */
"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IST_TZ } from "@/lib/dates/ist";
import { dueState, kindLabel, STATUS_LABEL, type PrivacyRequestRow } from "@/lib/privacy/requests";

export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00+05:30`) : new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST_TZ });
}

export interface RequestTableProps {
  rows: readonly PrivacyRequestRow[];
  todayIst: string;
  busyId?: string | null;
  onExport: (r: PrivacyRequestRow, format: "json" | "csv") => void;
  onCorrected: (r: PrivacyRequestRow) => void;
  onClose: (r: PrivacyRequestRow) => void;
}

export function RequestTable({ rows, todayIst, busyId, onExport, onCorrected, onClose }: RequestTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-hairline bg-paper">
      <table className="w-full min-w-[880px] text-sm">
        <thead className="bg-paper-2 text-left text-xs uppercase tracking-wider text-ink-3">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">Person</th>
            <th scope="col" className="px-3 py-2 font-semibold">Request</th>
            <th scope="col" className="px-3 py-2 font-semibold">Received</th>
            <th scope="col" className="px-3 py-2 font-semibold">Due by</th>
            <th scope="col" className="px-3 py-2 font-semibold">Status</th>
            <th scope="col" className="px-3 py-2 font-semibold text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const due = dueState(r.due_by, r.status, todayIst);
            const found = r.lead_ids.length + r.customer_ids.length;
            const busy = busyId === r.id;
            return (
              <tr key={r.id} className="border-t border-hairline align-top" data-testid={`privacy-row-${r.id}`}>
                <td className="px-3 py-2">
                  <div className="font-medium text-ink">{r.full_name}</div>
                  <div className="text-xs text-ink-3 [overflow-wrap:anywhere]">{r.email}{r.phone ? ` · ${r.phone}` : ""}</div>
                  <div className="text-xs text-ink-3">{found === 0 ? "No matching lead or customer" : `${r.lead_ids.length} lead${r.lead_ids.length === 1 ? "" : "s"}, ${r.customer_ids.length} customer${r.customer_ids.length === 1 ? "" : "s"}`}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="text-ink">{kindLabel(r.kind)}</div>
                  {r.details && <div className="max-w-[260px] text-xs text-ink-3 [overflow-wrap:anywhere]">{r.details}</div>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-ink-2">{shortDate(r.verified_at)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="text-ink-2">{shortDate(r.due_by)}</div>
                  {r.status !== "closed" && (
                    <Badge kind={due.overdue ? "danger" : due.daysLeft <= 7 ? "warning" : "muted"} size="sm">{due.label}</Badge>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <Badge kind={r.status === "closed" ? "success" : r.status === "corrected" ? "info" : "outline"} size="sm">{STATUS_LABEL[r.status]}</Badge>
                  {r.exported_at && <div className="mt-1 text-xs text-ink-3">Exported {shortDate(r.exported_at)}</div>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button size="sm" variant="default" icon="download" disabled={busy || found === 0} onClick={() => onExport(r, "json")} aria-label={`Export ${r.full_name}'s data as JSON`}>JSON</Button>
                    <Button size="sm" variant="default" icon="download" disabled={busy || found === 0} onClick={() => onExport(r, "csv")} aria-label={`Export ${r.full_name}'s data as CSV`}>CSV</Button>
                    {r.status === "open" && (
                      <Button size="sm" variant="default" disabled={busy} onClick={() => onCorrected(r)}>Mark corrected</Button>
                    )}
                    {r.status !== "closed" && (
                      <Button size="sm" variant="primary" disabled={busy} onClick={() => onClose(r)}>Close</Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
