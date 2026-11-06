"use client";

/**
 * R-2519 (Pardeep, 6 Nov 2026 — "Zoho ki tarah proforma bhejna") — Renewals → "Bill next part"
 * opens this preview instead of saving in one click (staging BITDECENTRO Q-A378-27-0947 was made
 * at the stored 17 seats with no look first). The owner sees the next period(s) as seats × ₹ a
 * seat with GST, may change the seats, the rate or how many periods, and then creates the
 * proforma(s). Nothing is emailed here — each proforma shows "Ready to send" until it goes out.
 * A seat change reaches the subscription only when the proforma is paid (or accepted).
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { formatDate, rupee } from "@/lib/utils";
import { readJsonSafe } from "@/app/(app)/renewals/reminders";
import { LoadErrorInline } from "@/components/shared/load-error";
import { MAX_BILL_PERIODS, partAmounts, periodText } from "@/lib/billing/proforma";
import type { BillNextPreview } from "@/lib/billing/proforma";
import { istToday } from "@/lib/dates/ist";

export interface BillNextChoice { periods: number; seats: number | null; seatRate: number | null }

export function BillNextPartDialog({ sub, open, onOpenChange, onConfirm, busy }: {
  sub: { id: string; customer_name: string; plan: string | null };
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (choice: BillNextChoice) => void;
  busy: boolean;
}) {
  const [periods, setPeriods] = React.useState(1);
  const [seats, setSeats] = React.useState("");
  const [rate, setRate] = React.useState("");
  React.useEffect(() => { if (open) { setPeriods(1); setSeats(""); setRate(""); } }, [open, sub.id]);

  const { data: preview, error, isLoading, refetch } = useQuery({
    queryKey: ["subscriptions", sub.id, "bill-next-preview", periods],
    enabled: open,
    queryFn: async (): Promise<BillNextPreview> => {
      const res = await fetch(`/api/subscriptions/${sub.id}/generate-renewal-quote?periods=${periods}`);
      const json = (await readJsonSafe(res)) as { preview?: BillNextPreview; error?: string };
      if (!res.ok || !json.preview) throw new Error(json.error ?? `Could not load the preview (${res.status})`);
      return json.preview;
    },
  });

  /* The fields start from the subscription's own figures once the preview is in. */
  React.useEffect(() => {
    if (!preview) return;
    setSeats((s) => (s === "" ? String(preview.seats) : s));
    setRate((r) => (r === "" && preview.seatRate != null ? String(preview.seatRate) : r));
  }, [preview]);

  const seatsN = Number(seats);
  const rateN = Number(rate);
  const valid = Number.isInteger(seatsN) && seatsN >= 1 && Number.isInteger(rateN) && rateN >= 0 && rate !== "";
  const amounts = preview && valid ? partAmounts({ seats: seatsN, seatRate: rateN, taxRate: preview.taxRate }) : null;
  const changed = !!preview && valid && (seatsN !== preview.seats || rateN !== preview.seatRate);
  /* Not exact per seat (₹2,000 over 3 seats): the proforma keeps the part's own amount unless a rate is typed. */
  const noRate = preview?.seatRate == null && rate === "";

  const confirm = () => {
    if (!preview) return;
    onConfirm({ periods, seats: changed ? seatsN : null, seatRate: changed ? rateN : null });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="font-serif text-xl text-ink">Bill next part — proforma</DialogTitle>
        <DialogDescription className="text-sm text-ink-2">
          {sub.customer_name}{sub.plan ? ` · ${sub.plan}` : ""}. Check the seats and the rate before the proforma is made.
          Nothing is emailed now.
        </DialogDescription>

        {isLoading && <p className="mt-4 text-sm text-ink-3">Loading what will be billed…</p>}
        {error && <div className="mt-4"><LoadErrorInline what="what will be billed" error={error} onRetry={() => void refetch()} /></div>}

        {preview && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <FormField label="Seats" htmlFor="bnp-seats" required>
                <Input id="bnp-seats" name="seats" type="number" min={1} step={1} value={seats}
                  onChange={(e) => setSeats(e.target.value)} />
              </FormField>
              <FormField label={`₹ a seat (${preview.cycle === "monthly" ? "a month" : "a period"})`} htmlFor="bnp-rate" required={!noRate}>
                <Input id="bnp-rate" name="seat_rate" type="number" min={0} step={1} value={rate}
                  onChange={(e) => setRate(e.target.value)} placeholder={noRate ? "As billed" : undefined} />
              </FormField>
              <FormField label="Periods" htmlFor="bnp-periods" required>
                <Input id="bnp-periods" name="periods" type="number" min={1} max={MAX_BILL_PERIODS} step={1} value={periods}
                  onChange={(e) => setPeriods(Math.min(MAX_BILL_PERIODS, Math.max(1, Math.round(Number(e.target.value) || 1))))} />
              </FormField>
            </div>

            <ul className="divide-y divide-hairline rounded-lg border border-hairline text-sm" data-testid="bill-next-periods">
              {preview.periods.map((p) => (
                <li key={p.start} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-ink">{periodText(p.start, p.end)}</span>
                  {p.existing ? (
                    <span className="text-ink-3">
                      {p.existing.kind === "invoice" ? `Invoiced (${p.existing.id})` : `Has ${p.existing.id} (${p.existing.status})`}
                    </span>
                  ) : (
                    <span className="tabular-nums text-ink-2">
                      {amounts ? `${seatsN} × ${rupee(rateN)} = ${rupee(amounts.taxable)} + GST ${rupee(amounts.tax)} = ${rupee(amounts.gross)}` : rupee(preview.amounts.gross)}
                    </span>
                  )}
                </li>
              ))}
            </ul>

            <p className="text-2xs text-ink-3">
              One proforma per period, from the PI series, due from {formatDate(preview.firstStart > istToday() ? preview.firstStart : istToday())} + the customer&apos;s payment terms.
              {changed ? ` The subscription moves to ${seatsN} seats only when a proforma is paid.` : ""}
              {" "}A period that already has a proforma keeps it{changed ? " (its seats and rate are changed if it is unpaid)" : ""}.
            </p>
          </div>
        )}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={confirm} disabled={!preview || (!valid && !noRate)} loading={busy}>
            {periods > 1 ? `Create ${periods} proformas` : "Create proforma"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
