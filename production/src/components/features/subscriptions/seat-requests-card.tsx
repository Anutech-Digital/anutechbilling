"use client";

/**
 * Customer seat requests waiting on a rep.
 *
 * ─── APPROVE SHOWS THE MONEY BEFORE IT IS SPENT ─────────────────────────────
 * The pro-rata amount is computed here and shown on the row, so approving is not a
 * click into the unknown. It is a PREVIEW: the real charge is worked out server-side
 * at the moment of approval, because a seat change is priced to the renewal date and
 * the figure falls every day the request waits. Showing yesterday's number and
 * billing today's would be the same class of error as freezing the price at request
 * time.
 *
 * ─── A REQUEST THAT CANNOT BE APPROVED SAYS WHY, ON THE ROW ─────────────────
 * The subscription may have moved since it was raised, been paused, or the request
 * may be a reduction. Each of those greys the button AND prints the reason and the
 * next step (§24) — a disabled button with no explanation gets worked around by
 * hand, and then nobody closes the request.
 */
import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAskText } from "@/components/providers/confirm-provider";
import { cn, rupee, formatDate } from "@/lib/utils";
import type { SeatRequest, Subscription } from "@/lib/supabase/database.types";
import { assessRequest, previewCharge, requestBadge } from "@/lib/subscriptions/seat-request";
import { localDateISO } from "@/lib/leads/outcomes";
import { seatChargeWindow, seatTermEnd } from "@/lib/subscriptions/seat-charge-window";
import { istToday } from "@/lib/dates/ist";
import { useCustomer } from "@/lib/queries/customers";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { quotePlaceOfSupply } from "@/lib/quotes/quote-place-of-supply";

/**
 * R-803: the amount approving will charge — the same calculation and the same tax rule the
 * server applies (applySeatIncrease → addSeats → seatIncreaseCharge), so it equals the quote.
 * Was a flat 18% here, while the server zero-rates an export customer.
 */
function SeatChargePreview({ sub, seatsToAdd }: { sub: Subscription; seatsToAdd: number }) {
  const { data: customer } = useCustomer(sub.customer_id ?? undefined);
  const { data: me } = useCurrentUser();
  /* R-527: the same window the server charges — the current instalment on a split-billed
     subscription, else the rest of the term. Approval charges from today. */
  const window = sub.renewal_date ? seatChargeWindow(sub, istToday()) : null;
  if (!window) return null;
  const pos = quotePlaceOfSupply({
    customer: customer ?? null,
    seller: { state_code: me?.tenantStateCode, gstin: me?.tenantGstin },
  });
  const preview = previewCharge({
    currentSeats: sub.seats,
    currentMrr: sub.mrr,
    seatsToAdd,
    remainingDays: Math.max(0, window.remainingDays),
    termDays: window.termDays,
    taxRatePct: pos.isExport ? 0 : 18,
  });
  if (!preview) return null;
  return (
    <>
      <p className="font-serif text-lg font-semibold tabular-nums text-ink">
        {rupee(preview.total)}
      </p>
      <p className="text-3xs leading-snug text-ink-3">
        {pos.isExport ? "no GST (export)" : "incl. GST"} · {preview.remainingDays} days
        <br />
        then {rupee(preview.newMrr)}/mo
      </p>
    </>
  );
}

export function SeatRequestsCard({ requests, subscriptions, onDecided }: {
  requests: SeatRequest[];
  subscriptions: Subscription[];
  onDecided: () => void;
}) {
  /* window.prompt returned null in the desktop app, so Reject did nothing (R-052). */
  const askText = useAskText();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const pending = requests.filter((r) => r.status === "pending");
  const today = localDateISO(new Date());

  const decide = async (id: string, decision: "approved" | "rejected", note?: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/seat-requests/${id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not record the decision", {
          description: json.nextStep,
          duration: 10_000,
        });
        return;
      }
      if (json.warning) {
        toast.warning("Seats added, request not closed", { description: json.warning, duration: 15_000 });
      } else if (decision === "approved") {
        toast.success(`Approved — ${json.newSeats} seats, quote ${json.quoteId} for ${rupee(json.amount)}.`, {
          description: `Pro-rated over ${json.proRataDays} days to the renewal date.`,
          duration: 9000,
        });
      } else {
        toast.success("Rejected. The customer will see your note.");
      }
      onDecided();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (pending.length === 0) return null;

  return (
    <Card
      title="Seat requests"
      sub={`${pending.length} waiting on you`}
    >
      <ul className="divide-y divide-hairline">
        {pending.map((r) => {
          const sub = subscriptions.find((s) => s.id === r.subscription_id);
          const verdict = assessRequest({
            status: r.status,
            currentSeats: r.current_seats,
            requestedSeats: r.requested_seats,
            liveSeats: sub?.seats ?? r.current_seats,
            subscriptionStatus: (sub?.status ?? "active") as "active" | "paused" | "expired" | "cancelled",
            renewalDate: sub?.renewal_date ?? null,
            termEnd: sub ? seatTermEnd(sub) : null,
            today,
          });


          const badge = requestBadge(r.status);
          const delta = r.requested_seats - r.current_seats;

          return (
            <li key={r.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-ink">{r.customer_name}</p>
                    <Badge kind={badge.kind} size="sm">{badge.label}</Badge>
                  </div>
                  <p className="mt-0.5 text-[13px] text-ink-2">
                    {r.current_seats} → <b className="text-ink">{r.requested_seats}</b> seats
                    <span className={cn("ml-1.5 font-medium", delta > 0 ? "text-emerald" : "text-rose")}>
                      ({delta > 0 ? "+" : ""}{delta})
                    </span>
                    {sub && <span className="ml-1.5 text-ink-3">· {sub.plan}</span>}
                  </p>
                  {r.note && <p className="mt-1 text-[12px] italic leading-snug text-ink-3">“{r.note}”</p>}
                  <p className="mt-0.5 text-2xs text-ink-3">
                    Raised {formatDate(r.created_at)}
                    {r.requested_by_email && ` by ${r.requested_by_email}`}
                    {r.effective_on && ` · wanted from ${formatDate(r.effective_on)}`}
                  </p>

                  {!verdict.canApprove && (
                    <div className="mt-2 rounded-md border border-amber/50 bg-amber-soft/50 px-2.5 py-1.5">
                      <p className="text-[12px] font-medium text-amber-ink">{verdict.reason}</p>
                      <p className="mt-0.5 text-2xs leading-snug text-ink-2">{verdict.nextStep}</p>
                    </div>
                  )}
                </div>

                <div className="shrink-0 text-right">
                  {verdict.canApprove && sub && <SeatChargePreview sub={sub} seatsToAdd={verdict.seatsToAdd} />}
                  <div className="mt-2 flex gap-1.5">
                    <Button
                      size="sm"
                      disabled={!verdict.canApprove || busyId === r.id}
                      loading={busyId === r.id}
                      title={verdict.canApprove ? undefined : verdict.reason}
                      onClick={() => decide(r.id, "approved")}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === r.id}
                      onClick={async () => {
                        const note = await askText({ title: "Reject this request?", label: "Why? The customer sees this.", confirmLabel: "Reject", danger: true });
                        if (note === null) return;
                        decide(r.id, "rejected", note);
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 flex items-start gap-1.5 text-2xs leading-snug text-ink-3">
        <Icon name="alert" size={11} className="mt-px shrink-0" />
        Amounts shown are today&apos;s. A seat change is priced to the renewal date, so the
        figure falls each day — the real charge is worked out when you approve.
      </p>
    </Card>
  );
}
