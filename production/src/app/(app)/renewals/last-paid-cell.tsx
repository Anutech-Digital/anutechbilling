"use client";
/**
 * R-2422 — the Renewals row's "Last paid" line (under the customer): invoice (link) · date, then
 * ₹ amount · method · History (a small popover with the last 3 payments). "— never paid in the
 * app" when nothing was received against this subscription's quotes / invoices. Rules and words:
 * ./last-paid.ts; the batched read: ./last-paid-data.ts.
 */
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { lastPaidSummary, NEVER_PAID, type LastPaid, type PaidLine } from "./last-paid";

function DocLink({ line, canInvoices, canQuotes }: { line: PaidLine; canInvoices: boolean; canQuotes: boolean }) {
  const s = lastPaidSummary(line);
  if (!s.doc) return null;
  const href = s.docKind === "invoice" ? (canInvoices ? invoiceHref(s.doc) : null) : (canQuotes ? `/quotes/${encodeURIComponent(s.doc)}` : null);
  return href
    ? <Link href={href as never} className="font-mono underline underline-offset-2 hover:text-ink">{s.doc}</Link>
    : <span className="font-mono">{s.doc}</span>;
}

export function LastPaidLine({ paid, loading, failed, canInvoices, canQuotes, className }: {
  paid: LastPaid | undefined;
  /** The read is still running — show nothing rather than a false "never paid". */
  loading: boolean;
  /** The read failed — say so; never a false "never paid". */
  failed: boolean;
  canInvoices: boolean;
  canQuotes: boolean;
  className?: string;
}) {
  if (loading) return null;
  if (failed) return <p className={cn("text-2xs text-ink-3", className)}>Last paid: couldn&apos;t load — reload the page</p>;
  if (!paid) return <p className={cn("text-2xs text-ink-3", className)}>Last paid {NEVER_PAID}</p>;
  const s = lastPaidSummary(paid.last);
  const full = `Last paid: ${s.doc ?? "—"} · ${s.date} · ${s.amount} · ${s.method}${s.shared ? ` (${s.shared})` : ""}`;
  return (
    <div className={cn("min-w-0 text-2xs text-ink-2", className)} title={full}>
      <p className="truncate">
        <span className="text-ink-3">Last paid </span>
        <DocLink line={paid.last} canInvoices={canInvoices} canQuotes={canQuotes} />
        {s.doc ? " · " : ""}<span className="tabular-nums">{s.date}</span>
      </p>
      <p className="truncate">
        <span className="font-medium tabular-nums text-ink">{s.amount}</span> · {s.method}
        {s.shared ? ` · ${s.shared}` : ""}
        {" · "}
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm"
              aria-label="Show the last 3 payments">
              History
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-3">
            <p className="mb-2 text-xs font-semibold text-ink">Last {paid.history.length} payment{paid.history.length === 1 ? "" : "s"}</p>
            <ul className="space-y-1.5">
              {paid.history.map((h) => {
                const x = lastPaidSummary(h);
                return (
                  <li key={h.paymentId} className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-ink-2">
                      <span className="tabular-nums">{x.date}</span>{x.doc ? " · " : ""}
                      <DocLink line={h} canInvoices={canInvoices} canQuotes={canQuotes} />
                      {` · ${x.method}${x.shared ? ` · ${x.shared}` : ""}`}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums text-ink">{x.amount}</span>
                  </li>
                );
              })}
            </ul>
          </PopoverContent>
        </Popover>
      </p>
    </div>
  );
}
