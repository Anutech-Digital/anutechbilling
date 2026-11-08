/**
 * R-2252 (Zoho Billing audit A17) — "Reduce seats" inside Manage seats, with the credit shown
 * before saving. Zoho shows ₹0 and hides the credit; here the owner sees, before pressing the
 * button: the unused days of the current part × the per-seat rate = the credit value (+GST), and
 * how it lands (R-2255): first it lowers what the part's invoice still asks for, the rest is the
 * customer's credit — never more than was received.
 *
 * The numbers come from the server (GET /api/subscriptions/[id]/reduce-seats) — the same function
 * the save uses — so the preview is what gets booked.
 *   · Now          → one credit note on the part's invoice; seats drop today.
 *   · End of term  → scheduled for the renewal date; no money, the seats stay until then.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/errors/toast-error";
import { DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee, formatDate } from "@/lib/utils";
import { formatPaise } from "@/lib/subscriptions/proration";
import { newIdempotencyKey } from "@/lib/ops/idempotency-key";
import type { Subscription } from "@/lib/supabase/database.types";
import type { SeatReductionValue, SeatReductionPreview } from "@/lib/subscriptions/seat-reduction";

interface PreviewResponse {
  seats: number;
  renewalDate: string | null;
  taxLabel: string;
  value: SeatReductionValue;
  preview: SeatReductionPreview | null;
  nceLocked: boolean;
  nceReason: string;
  scheduled: { seats_before: number; seats_after: number; effective_date: string } | null;
}

type Timing = "now" | "end_of_term";

interface Props {
  sub: Subscription;
  onCancel: () => void;
  onDone: () => void;
}

export default function ReduceSeatsPanel({ sub, onCancel, onDone }: Props) {
  const queryClient = useQueryClient();
  const [seatsStr, setSeatsStr] = React.useState("1");
  const [timing, setTiming] = React.useState<Timing>("now");
  const [data, setData] = React.useState<PreviewResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const seatsRemoved = Math.max(0, Math.min(4999, Math.round(Number(seatsStr) || 0)));

  /* One key per intent (R-060): a new seat count or timing is a new cut; a retry after an error is not. */
  const keyRef = React.useRef<string | null>(null);
  React.useEffect(() => { keyRef.current = null; setSubmitError(null); }, [sub.id, seatsRemoved, timing]);

  const [reloadTick, setReloadTick] = React.useState(0);
  React.useEffect(() => {
    /* A new count → the old preview goes at once, so the button never books figures not on screen. */
    setData(null);
    if (seatsRemoved < 1) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/subscriptions/${sub.id}/reduce-seats?seats=${seatsRemoved}`);
        const json = (await res.json().catch(() => null)) as (PreviewResponse & { error?: string }) | null;
        if (cancelled) return;
        if (!res.ok || !json) { setLoadError(json?.error ?? "Could not work out the credit. Try again."); setData(null); return; }
        setLoadError(null);
        setData(json);
      } catch {
        if (!cancelled) { setData(null); setLoadError("Could not reach the server to work out the credit. Check your connection."); }
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [sub.id, seatsRemoved, reloadTick]);

  const [removing, setRemoving] = React.useState(false);
  const removeScheduled = async () => {
    setRemoving(true);
    try {
      const res = await fetch(`/api/subscriptions/${sub.id}/reduce-seats`, { method: "DELETE" });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) { toast.error(json?.error ?? "The scheduled cut was not removed — try again."); return; }
      toast.success("Scheduled seat cut removed");
      setReloadTick((t) => t + 1);
    } catch (err) {
      toastError(err, { fallback: "Could not remove the scheduled cut.", description: "Check your connection, then try again." });
    } finally {
      setRemoving(false);
    }
  };

  const value = data?.value ?? null;
  const preview = data?.preview ?? null;
  const renewal = data?.renewalDate ?? sub.renewal_date ?? null;
  const seatsAfter = sub.seats - seatsRemoved;
  const tooMany = value && !value.ok && (value.code === "too_many" || value.code === "invalid_seats");
  const nowBlocked = timing === "now" && (
    !value?.ok || !preview?.canReduceNow || Boolean(data?.nceLocked)
  );
  const disabled = submitting || seatsRemoved < 1 || !data || Boolean(tooMany) || Boolean(data?.scheduled) || nowBlocked;

  const onSubmit = async () => {
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/subscriptions/${sub.id}/reduce-seats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seats_removed: seatsRemoved, timing, idempotency_key: keyRef.current }),
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        const msg = typeof json?.error === "string" ? json.error : "Seats not reduced — try again.";
        setSubmitError(msg);
        toast.error(msg, { description: "Nothing was changed." });
        return;
      }
      if (timing === "end_of_term") {
        toast.success(`Seat cut scheduled: ${sub.seats} → ${seatsAfter} seats on ${renewal ? formatDate(renewal) : "renewal"}`);
      } else {
        const cn = typeof json?.credit_note_id === "string" ? json.credit_note_id : null;
        toast.success(
          `${seatsRemoved} seat${seatsRemoved === 1 ? "" : "s"} removed — now ${seatsAfter} seats`,
          { description: cn ? `Credit note ${cn} for ${rupee(Number(json?.lower_open_amount ?? 0) + Number(json?.credit_amount ?? 0))}. Reduce the seats with the vendor too.` : "No credit note was needed. Reduce the seats with the vendor too." },
        );
      }
      void queryClient.invalidateQueries();
      onDone();
    } catch (err) {
      setSubmitError("Seats not reduced — could not reach the server. Check your connection, then try again.");
      toastError(err, { fallback: "Could not reduce seats.", description: "Pressing again will not reduce the seats twice." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto grid gap-4 [&>*]:min-w-0 px-5 pt-2 pb-5 md:px-6 md:pb-6" data-testid="reduce-seats-body">
        <div>
          <label htmlFor="reduce-seats-count" className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
            How many seats to remove?
          </label>
          <Input
            id="reduce-seats-count"
            type="number"
            min={1}
            max={Math.max(1, sub.seats - 1)}
            value={seatsStr}
            onChange={(e) => setSeatsStr(e.target.value)}
            aria-invalid={tooMany ? true : undefined}
            aria-describedby="reduce-seats-count-help"
            className="font-mono text-center"
          />
          <p id="reduce-seats-count-help" className={tooMany ? "text-2xs text-rose mt-1" : "text-2xs text-ink-3 mt-1"}>
            {tooMany && value && !value.ok ? value.message : `${sub.seats} seats now → ${Math.max(0, seatsAfter)} after.`}
          </p>
        </div>

        <fieldset>
          <legend className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">When</legend>
          <div className="grid grid-cols-2 gap-2">
            <Button variant={timing === "now" ? "primary" : "ghost"} size="sm" aria-pressed={timing === "now"} onClick={() => setTiming("now")}>
              Now, with credit
            </Button>
            <Button variant={timing === "end_of_term" ? "primary" : "ghost"} size="sm" aria-pressed={timing === "end_of_term"} onClick={() => setTiming("end_of_term")}>
              At end of term
            </Button>
          </div>
        </fieldset>

        {data?.scheduled && (
          <p role="status" className="rounded-md border border-amber/30 bg-amber/10 p-3 text-xs text-amber-ink">
            A seat cut is already scheduled: {data.scheduled.seats_before} → {data.scheduled.seats_after} seats on {formatDate(data.scheduled.effective_date)}. Remove it to make a different cut.
            <Button variant="ghost" size="sm" className="mt-2" onClick={removeScheduled} disabled={removing}>
              {removing ? "Removing…" : "Remove scheduled cut"}
            </Button>
          </p>
        )}

        {timing === "end_of_term" ? (
          <div className="bg-paper-2 rounded-md p-3 text-sm" data-testid="reduce-seats-eot">
            <p className="text-ink-2">
              Seats go from <b className="text-ink">{sub.seats}</b> to <b className="text-ink">{Math.max(0, seatsAfter)}</b> on{" "}
              <b className="text-ink">{renewal ? formatDate(renewal) : "the renewal date"}</b>. No credit — the customer keeps the seats they paid for until then.
            </p>
          </div>
        ) : value?.ok && preview ? (
          <div className="bg-paper-2 rounded-md p-3 text-sm" data-testid="reduce-seats-preview">
            <Row label={`Unused days (to ${formatDate(value.partEnd)})`} value={`${value.days} days`} />
            <Row label="Annual rate per seat" value={rupee(value.annualPerSeat)} />
            <Row label={`Value of ${value.seatsRemoved} seat${value.seatsRemoved === 1 ? "" : "s"} for those days`} value={rupee(value.subtotal)} top />
            <Row label={data?.taxLabel ?? "GST"} value={rupee(value.tax)} />
            <div className="flex justify-between pt-2 border-t border-hairline mb-2">
              <span className="font-medium text-ink">Credit value (incl GST)</span>
              <span className="font-serif text-lg tabular-nums text-ink" data-testid="reduce-seats-credit-value">{rupee(value.total)}</span>
            </div>
            <ul className="grid gap-1 text-xs text-ink-2" data-testid="reduce-seats-split">
              {preview.split.lines.map((l) => (
                <li key={l.kind} className={l.kind === "not-given" ? "text-amber-ink" : undefined}>{l.text}</li>
              ))}
            </ul>
            {preview.invoice && preview.split.documentPaise > 0 && (
              <p className="text-2xs text-ink-3 mt-2">
                One credit note on invoice {preview.invoice.id} for {formatPaise(preview.split.documentPaise)}.
              </p>
            )}
          </div>
        ) : value && !value.ok && !tooMany ? (
          <p className="rounded-md border border-amber/30 bg-amber/10 p-3 text-xs text-amber-ink">{value.message}</p>
        ) : !loadError ? (
          <p className="text-xs text-ink-3">Working out the credit…</p>
        ) : null}

        {timing === "now" && preview && !preview.canReduceNow && (
          <p role="status" className="rounded-md border border-amber/30 bg-amber/10 p-3 text-xs text-amber-ink">{preview.blockedReason}</p>
        )}
        {timing === "now" && data?.nceLocked && (
          <p role="status" className="rounded-md border border-amber/30 bg-amber/10 p-3 text-xs text-amber-ink">{data.nceReason}</p>
        )}

        <p className="text-2xs text-ink-3 leading-relaxed">
          Reduce the seats with the vendor (Google / Microsoft / Zoho) too — this changes the bill, not the vendor console.
        </p>

        {(loadError || submitError) && (
          <p role="alert" className="rounded-md border border-rose/40 bg-rose/5 px-3 py-2 text-xs text-rose">{submitError ?? loadError}</p>
        )}
      </div>

      <DialogFooter className="shrink-0 border-t border-hairline bg-paper px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6 md:pb-4" data-testid="dialog-sticky-footer">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button variant="primary" onClick={onSubmit} disabled={disabled}>
          {submitting
            ? "Saving…"
            : timing === "now"
              ? `Remove ${seatsRemoved} seat${seatsRemoved === 1 ? "" : "s"} now`
              : `Schedule for ${renewal ? formatDate(renewal) : "renewal"}`}
        </Button>
      </DialogFooter>
    </>
  );
}

function Row({ label, value, top }: { label: string; value: string; top?: boolean }) {
  return (
    <div className={top ? "flex justify-between gap-3 mb-1 pt-2 border-t border-hairline" : "flex justify-between gap-3 mb-1"}>
      <span className="text-ink-3">{label}</span>
      <span className="tabular-nums text-ink-2">{value}</span>
    </div>
  );
}
