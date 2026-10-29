/**
 * R-2099 — Banking → Reconcile, a money-in line from Razorpay ("…RAZORPAY PAYMENTS PVT LTD
 * PAYMENT AGGREGATOR…"): "Razorpay settlement".
 *
 * One press fetches the settlement from Razorpay and shows what it carried: each customer
 * payment matched to the app's payment, Razorpay's fee + GST on it, refunds, and the sum that
 * must equal the bank line. One more press reconciles all of it (reconcile_razorpay_settlement):
 * the payments are banked on this line and the fee is booked as Bank Charges (its GST as input
 * credit). A payment Razorpay settled that the app does not have is picked from the app's
 * payments of the same amount, or recorded first — the screen says which.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import type { SettlementPlan } from "@/lib/razorpay/settlement-match";
import { useRazorpaySettlement, useReconcileRazorpaySettlement } from "@/lib/queries/razorpay-settlement";

export interface RazorpaySettlementLine {
  id: string;
  credit: number;
}

/** What still stops the click once the owner's picks are counted (unmatched rows are fixed by a pick). */
export function remainingBlockers(plan: SettlementPlan, picks: Record<string, string>): string[] {
  const unmatched = plan.payments.filter((p) => p.paymentIds.length === 0);
  const pickable = new Set(unmatched.map((p) => p.problem));
  const left = plan.blockers.filter((b) => !pickable.has(b));
  for (const p of unmatched) {
    if (!picks[p.rzpId]) left.push(p.problem ?? `Pick the app payment for ${p.rzpId}.`);
  }
  return left;
}

export function RazorpaySettlementSection({ line, onDone }: { line: RazorpaySettlementLine; onDone: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [settlementId, setSettlementId] = React.useState<string | null>(null);
  const [picks, setPicks] = React.useState<Record<string, string>>({});
  React.useEffect(() => { setOpen(false); setSettlementId(null); setPicks({}); }, [line.id]);

  const q = useRazorpaySettlement(line.id, settlementId, open);
  const rec = useReconcileRazorpaySettlement();

  if (!open) {
    return (
      <div className="rounded-md border border-indigo/40 bg-indigo/5 p-3 flex items-center justify-between gap-3">
        <p className="text-xs text-ink-2 leading-relaxed min-w-0">
          <b className="text-ink">Razorpay settlement?</b> One credit for many customer payments, less Razorpay&apos;s fee and GST.
          Fetch it from Razorpay to match every payment and book the fee in one step.
        </p>
        <Button size="sm" variant="primary" icon="download" onClick={() => setOpen(true)}>Fetch settlement</Button>
      </div>
    );
  }

  const r = q.data;
  const plan = r?.state === "plan" ? r.plan : null;
  const blockers = plan ? remainingBlockers(plan, picks) : [];

  async function reconcile() {
    try {
      const done = await rec.mutateAsync({ txnId: line.id, settlementId: plan?.settlement.id ?? settlementId, picks });
      toast.success(`Settlement reconciled: ${done.payments} payment${done.payments === 1 ? "" : "s"}, Razorpay fee ${rupee(done.fee)} booked`, {
        description: done.fee_booked_now < done.fee
          ? `${rupee(done.fee - done.fee_booked_now)} of the fee was already booked on single payments.`
          : `The fee is in Bank Charges; its GST (${rupee(done.fee_gst_now)}) is input credit when the Razorpay vendor has its GSTIN.`,
      });
      onDone();
    } catch (e) {
      toast.error("The settlement was not reconciled", {
        description: e instanceof Error ? e.message : "Nothing was saved. Fetch the settlement again and retry.",
        action: { label: "Fetch again", onClick: () => { void q.refetch(); } },
      });
    }
  }

  return (
    <div className="rounded-md border border-indigo/40 bg-indigo/5 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink-2 inline-flex items-center gap-1.5">
          <Icon name="receipt" size={14} /> Razorpay settlement
        </p>
        <button type="button" className="text-xs text-ink-3 underline" onClick={() => setOpen(false)}>Close</button>
      </div>

      {q.isLoading && <p className="text-xs text-ink-3">Fetching the settlement from Razorpay…</p>}

      {q.isError && (
        <div className="text-xs text-rose-ink space-y-1">
          <p>{q.error instanceof Error ? q.error.message : "Could not fetch the settlement."}</p>
          <Button size="sm" variant="default" onClick={() => { void q.refetch(); }}>Try again</Button>
        </div>
      )}

      {r?.state === "no_keys" && (
        <p className="text-xs text-ink-2">
          {r.message}{" "}
          <Link href={"/settings?tab=integrations" as never} className="text-indigo underline">Open Settings → Integrations</Link>
        </p>
      )}

      {(r?.state === "error" || r?.state === "not_found") && (
        <div className="text-xs text-ink-2 space-y-1">
          <p>{r.message}</p>
          <Button size="sm" variant="default" onClick={() => { void q.refetch(); }}>Fetch again</Button>
        </div>
      )}

      {r?.state === "many" && (
        <div className="space-y-1.5">
          <p className="text-xs text-ink-2">{r.message}</p>
          {r.options.map((o) => (
            <div key={o.id} className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-paper px-2.5 py-1.5">
              <span className="text-xs text-ink">{o.id} · {rupee(o.amount)} · UTR {o.utr ?? "—"} · {formatDate(new Date(o.createdAt * 1000).toISOString())}</span>
              <Button size="sm" variant="default" onClick={() => setSettlementId(o.id)}>Use this</Button>
            </div>
          ))}
        </div>
      )}

      {plan && (
        <>
          <p className="text-xs text-ink-3">
            {plan.settlement.id}{plan.settlement.utr ? ` · UTR ${plan.settlement.utr}` : ""} · {formatDate(new Date(plan.settlement.createdAt * 1000).toISOString())}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-ink-3 text-left">
                  <th className="py-1 pr-2 font-medium">Payment</th>
                  <th className="py-1 pr-2 font-medium">In the app</th>
                  <th className="py-1 pr-2 font-medium text-right">Amount</th>
                  <th className="py-1 font-medium text-right">Fee + GST</th>
                </tr>
              </thead>
              <tbody>
                {plan.payments.map((p) => (
                  <tr key={p.rzpId} className="border-t border-hairline align-top">
                    <td className="py-1.5 pr-2 font-mono text-ink-2">{p.rzpId}</td>
                    <td className="py-1.5 pr-2">
                      {p.paymentIds.length > 0 ? (
                        <span className={p.problem ? "text-rose-ink" : "text-ink"}>
                          {p.customer ?? "Payment"}{p.quoteId ? ` · ${p.quoteId}` : ""}
                          {p.matchedBy === "order" && <span className="text-ink-3"> (by order)</span>}
                          {p.matchedBy === "picked" && <span className="text-ink-3"> (picked)</span>}
                        </span>
                      ) : p.candidates.length > 0 ? (
                        <select
                          aria-label={`App payment for ${p.rzpId}`}
                          value={picks[p.rzpId] ?? ""}
                          onChange={(e) => setPicks((cur) => ({ ...cur, [p.rzpId]: e.target.value }))}
                          className="w-full rounded-md border border-amber/60 bg-paper px-2 py-1 text-xs text-ink"
                        >
                          <option value="">Not in the app — pick the payment…</option>
                          {p.candidates.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.customer_name ?? "Payment"} · {rupee(c.amount)} · {formatDate(c.received_at)}{c.quote_id ? ` · ${c.quote_id}` : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-amber-ink">Not in the app — record it on its quote with reference {p.rzpId}</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{rupee(p.amount)}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink-3">{rupee(p.fee)}</td>
                  </tr>
                ))}
                {plan.refunds.map((x) => (
                  <tr key={x.rzpId} className="border-t border-hairline">
                    <td className="py-1.5 pr-2 font-mono text-ink-2">{x.rzpId}</td>
                    <td className={`py-1.5 pr-2 ${x.problem ? "text-rose-ink" : "text-ink"}`}>Refund of {x.rzpPaymentId ?? "a payment"}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">−{rupee(x.amount)}</td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="text-xs grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 tabular-nums">
            <dt className="text-ink-3">{plan.payments.length} payment{plan.payments.length === 1 ? "" : "s"}</dt><dd className="text-right">{rupee(plan.totals.gross)}</dd>
            {plan.totals.refunds > 0 && <><dt className="text-ink-3">Refunds</dt><dd className="text-right">−{rupee(plan.totals.refunds)}</dd></>}
            <dt className="text-ink-3">Razorpay fee (incl. GST {rupee(plan.totals.feeGst)})</dt><dd className="text-right">−{rupee(plan.totals.fee)}</dd>
            {plan.totals.other !== 0 && <><dt className="text-ink-3">Adjustments</dt><dd className="text-right">{rupee(plan.totals.other)}</dd></>}
            <dt className="text-ink font-medium border-t border-hairline pt-0.5">Settlement</dt><dd className="text-right font-medium border-t border-hairline pt-0.5">{rupee(plan.totals.net)}</dd>
            <dt className="text-ink-3">This bank line</dt><dd className={`text-right ${plan.totals.net === Math.round(plan.totals.bank) ? "text-emerald" : "text-rose-ink"}`}>{rupee(plan.totals.bank)}</dd>
          </dl>

          {blockers.length > 0 && (
            <ul className="text-xs text-amber-ink bg-amber-soft/40 rounded-md px-3 py-2 space-y-1 list-disc list-inside">
              {blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            {blockers.length === 0 ? (
              <Button size="sm" variant="primary" icon="check" loading={rec.isPending} onClick={() => { void reconcile(); }}>
                Reconcile settlement
              </Button>
            ) : (
              <Button size="sm" variant="default" onClick={() => { void q.refetch(); }}>Fetch again</Button>
            )}
            <span className="text-xs text-ink-3">
              Links {plan.payments.length} payment{plan.payments.length === 1 ? "" : "s"} to this line and books the fee as Bank Charges (GST as input credit).
            </span>
          </div>
        </>
      )}
    </div>
  );
}
