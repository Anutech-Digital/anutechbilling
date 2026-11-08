/**
 * R-2587 (8 Nov 2026, Pardeep) — the parts of a quote billed in parts, under the money row:
 * what each part got, what is short, and when the next one comes. Staging Q-A378-27-0021 said
 * only "₹60 due now" — not that Part 1 was in, nor when Part 2 is due.
 * Rows: every part with money in, the first part not received, then "N more parts".
 */
import type { InstalmentStatus, PartStatus } from "@/lib/quotes/instalment-status";
import { rupee, formatDate } from "@/lib/utils";
import { addDaysISO } from "@/lib/dates/ist";

/** periodEnd is exclusive — the last day shown is the day before. */
function lastDay(isoExclusive: string): string {
  return addDaysISO(isoExclusive.slice(0, 10), -1);
}

function stateText(p: PartStatus, lastReceivedOn: string | null, isLastWithMoney: boolean): string {
  const on = isLastWithMoney && lastReceivedOn ? ` on ${formatDate(lastReceivedOn)}` : "";
  switch (p.state) {
    case "paid":     return `Received${on}`;
    case "short":    return `Received ${rupee(p.received)}${on} · ${rupee(p.short)} short`;
    case "part":     return `${rupee(p.received)} received${on} · ${rupee(p.short)} still due`;
    case "due":      return `Due since ${formatDate(p.billOn)}`;
    case "upcoming": return `Due ${formatDate(p.billOn)} · payment request on ${formatDate(p.billOn)}`;
  }
}

export function InstalmentList({ status, lastReceivedOn }: { status: InstalmentStatus; lastReceivedOn: string | null }) {
  const withMoney = status.parts.filter((p) => p.received > 0);
  const shown = [...withMoney, ...(status.next && !withMoney.includes(status.next) ? [status.next] : [])];
  const rest = status.parts.filter((p) => !shown.includes(p));
  const lastWithMoney = withMoney[withMoney.length - 1] ?? null;
  return (
    <ul className="mt-2 space-y-1 text-xs" data-testid="instalment-list">
      {shown.map((p) => (
        <li key={p.index} className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-ink">Part {p.index} of {status.count}</span>
          <span className="text-ink-3">{formatDate(p.periodStart)} – {formatDate(lastDay(p.periodEnd))}</span>
          <span className="tabular-nums text-ink">{rupee(p.gross)}</span>
          <span className={p.state === "part" || p.state === "due" ? "text-rose" : p.state === "short" ? "text-amber-ink" : "text-ink-2"}>
            · {stateText(p, lastReceivedOn, p === lastWithMoney)}
          </span>
        </li>
      ))}
      {rest.length > 0 && (
        <li className="text-ink-3">
          {rest.length} more {rest.length === 1 ? "part" : "parts"} · {rupee(rest.reduce((s, p) => s + p.gross, 0))}
        </li>
      )}
    </ul>
  );
}
