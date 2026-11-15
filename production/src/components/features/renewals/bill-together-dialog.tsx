"use client";

/**
 * R-2808 (R-2805, Pratik — ITBUZZ: Business Standard + Business Starter were on ONE bill last cycle,
 * Renewals offered two "Bill next part" buttons) — "Bill together": ONE proforma with one line per
 * subscription's next part. Every line that can join is ticked (Pardeep 14 Nov: "selected by default");
 * unticking drops it from the total and from the proforma. A subscription the route says cannot join
 * stays unticked with its reason. Nothing is emailed here — like Bill next part, the proforma shows
 * "Ready to send" until it goes out. Talks only to lib/renewals/bill-together.ts (R-2807's route).
 */
import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LoadErrorInline } from "@/components/shared/load-error";
import { rupee } from "@/lib/utils";
import { formatForeign, isForeignCurrency } from "@/lib/currency";
import { periodText } from "@/lib/billing/proforma";
import {
  billTogetherAvailable, fetchBillTogetherPreview, type BillTogetherPreview, type BillTogetherSub,
} from "@/lib/renewals/bill-together";

export const BILL_TOGETHER = "Bill together";

/** Is the R-2807 route there (and allowed for this login)? Until it lands (404) the screen shows nothing. */
export function useBillTogetherAvailable(enabled = true): boolean {
  return useBillTogetherProbe(enabled) === "on";
}

const PROBE_RETRY_MS = 1000;

/** "pending" while the probe is out — Bill next part waits for it before offering Create (no fail-open, code review). */
export function useBillTogetherProbe(enabled = true): "pending" | "on" | "off" {
  const { data, isPending, isError } = useQuery({
    queryKey: ["renewals", "bill-together", "available"],
    enabled,
    staleTime: 10 * 60_000,
    /* R-2832 (rev-r2808 F6): a 5xx / network error is not "no" — retry twice a second apart, and while it
       stays in error ask again every minute, so one transient 500 never hides the box for 10 minutes. */
    retry: 2,
    retryDelay: PROBE_RETRY_MS,
    refetchInterval: (q) => (q.state.status === "error" ? 60_000 : false),
    queryFn: () => billTogetherAvailable(),
  });
  if (!enabled) return "off";
  if (isError) return "off";   // a network error: the server still refuses a second bill for a grouped part (R-2806 edge H)
  return isPending ? "pending" : data ? "on" : "off";
}

export function useBillTogetherPreview(ids: readonly string[], enabled: boolean) {
  return useQuery({
    queryKey: ["renewals", "bill-together", "preview", [...ids].sort().join(",")],
    enabled: enabled && ids.length > 0,
    retry: false,
    queryFn: (): Promise<BillTogetherPreview> => fetchBillTogetherPreview(ids),
  });
}

const canJoin = (s: BillTogetherSub) => s.reasons.length === 0 && !!s.line;

/** Rupees → whole paise (the sum is done in paise so float tails never show — R-2832 F3). */
const toPaise = (n: number) => Math.round(n * 100);

/**
 * The total of the ticked lines, worked the way the proforma is (lib/renewals/bill-together-preview.ts total,
 * the RPC): taxable summed in paise, GST = round(total taxable × rate) on the whole bill (one rate — mixed
 * rates are refused), gross = taxable + GST. So the figure the user confirms is the proforma's (R-2832 F3).
 */
export function tickedTotal(subs: readonly BillTogetherSub[], ticked: ReadonlySet<string>) {
  const lines = subs.filter((s) => s.line && ticked.has(s.subscriptionId) && canJoin(s)).map((s) => s.line!);
  const taxableP = lines.reduce((t, l) => t + toPaise(l.taxable), 0);
  const taxable = taxableP / 100;
  const tax = lines.length > 0 ? Math.round((taxable * lines[0].taxRate) / 100) : 0;
  return { taxable, tax, gross: (taxableP + toPaise(tax)) / 100 };
}

export function BillTogetherDialog({ ids, customerName, open, onOpenChange, onConfirm, busy }: {
  /** The subscriptions asked for (ticked rows / the suggested group). */
  ids: readonly string[];
  customerName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The ticked, joinable subscriptions — the caller POSTs them. */
  onConfirm: (ids: string[]) => void;
  busy: boolean;
}) {
  const { data: preview, error, isLoading, refetch } = useBillTogetherPreview(ids, open);
  const [ticked, setTicked] = React.useState<Set<string>>(() => new Set());
  /* every line that can join starts ticked (Pardeep 14 Nov) — ONCE per opening: a background refetch never
     re-ticks a line the user dropped; a line that can no longer join is left out by `chosen` below */
  const seeded = React.useRef<string | null>(null);
  const idsKey = ids.join(",");
  React.useEffect(() => {
    if (!preview || seeded.current === idsKey) return;
    seeded.current = idsKey;
    setTicked(new Set(preview.subs.filter(canJoin).map((s) => s.subscriptionId)));
  }, [preview, idsKey]);

  const subs = preview?.subs ?? [];
  const chosen = subs.filter((s) => canJoin(s) && ticked.has(s.subscriptionId)).map((s) => s.subscriptionId);
  const total = tickedTotal(subs, ticked);
  /* R-2832 F3: paise shown — a bill's lines and total are to the paisa, never rounded to whole rupees */
  const money = (n: number) => (preview && isForeignCurrency(preview.currency) ? formatForeign(n, preview.currency) : rupee(n, { decimals: 2 }));
  const toggle = (id: string, on: boolean) => setTicked((t) => {
    const n = new Set(t);
    if (on) n.add(id); else n.delete(id);
    return n;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogTitle className="font-serif text-xl text-ink">{BILL_TOGETHER} — one proforma</DialogTitle>
        <DialogDescription className="text-sm text-ink-2">
          {customerName}. One proforma with a line for each ticked subscription&apos;s next part. Untick one to bill it on its own.
          Nothing is emailed now.
        </DialogDescription>

        {isLoading && <p className="mt-4 text-sm text-ink-3">Loading what will be billed…</p>}
        {error && <div className="mt-4"><LoadErrorInline what="what will be billed" error={error} onRetry={() => void refetch()} /></div>}

        {preview && (
          <div className="mt-4 space-y-3">
            <ul className="divide-y divide-hairline rounded-lg border border-hairline text-sm" data-testid="bill-together-lines">
              {subs.map((s) => {
                const join = canJoin(s);
                const boxId = `bt-${s.subscriptionId}`;
                return (
                  <li key={s.subscriptionId} className="flex items-start gap-2.5 px-3 py-2" data-testid="bill-together-line">
                    <input id={boxId} type="checkbox" className="mt-1 cursor-pointer accent-amber disabled:cursor-not-allowed"
                      checked={join && ticked.has(s.subscriptionId)} disabled={!join || busy}
                      onChange={(e) => toggle(s.subscriptionId, e.target.checked)} />
                    <div className="min-w-0 flex-1">
                      <label htmlFor={boxId} className="block cursor-pointer font-medium text-ink">{s.plan ?? "Subscription"}</label>
                      {s.line && (
                        <p className="tabular-nums text-ink-2">
                          {s.line.seats} seats{s.line.seatRate != null ? ` × ${money(s.line.seatRate)}` : ""} · {periodText(s.line.periodStart, s.line.periodEnd)}
                          {" "}· {money(s.line.taxable)} + GST {s.line.taxRate}% {money(s.line.tax)}
                        </p>
                      )}
                      {s.reasons.map((r) => (
                        <p key={r.code} className="text-2xs text-rose" data-testid="bill-together-reason">{r.text}</p>
                      ))}
                      {s.onTogetherBill && (
                        <p className="text-2xs text-ink-3">
                          Already on {s.onTogetherBill.quoteId} —{" "}
                          <Link className="font-medium text-ink underline underline-offset-2 hover:text-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                            href={`/quotes/${encodeURIComponent(s.onTogetherBill.quoteId)}`}>Open it</Link>
                        </p>
                      )}
                    </div>
                    {s.line && (
                      <span className={join && ticked.has(s.subscriptionId) ? "shrink-0 tabular-nums font-medium text-ink" : "shrink-0 tabular-nums text-ink-3 line-through"}>
                        {money(s.line.gross)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="flex items-baseline justify-between text-sm" data-testid="bill-together-total">
              <span className="text-ink-2">Total ({chosen.length} line{chosen.length === 1 ? "" : "s"})</span>
              <span className="tabular-nums font-semibold text-ink">
                {money(total.taxable)} + GST {money(total.tax)} = {money(total.gross)}
              </span>
            </p>
            {chosen.length < 2 && (
              <p className="text-2xs text-ink-3" role="status">Tick at least two subscriptions — one alone is billed with Bill next part.</p>
            )}
            <p className="text-2xs text-ink-3">
              One proforma from the PI series. When it is paid, ONE tax invoice is raised and each subscription moves to its next part.
            </p>
          </div>
        )}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => onConfirm(chosen)} disabled={!preview || chosen.length < 2} loading={busy}>
            Create proforma
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
