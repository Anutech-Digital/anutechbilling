"use client";
/**
 * R-2410 — the folded "Small leftovers (N · ₹X)" group under the Payment Follow-up list.
 * Balances up to ₹500, or exactly the TDS the customer withheld, are closed here instead of
 * chased (rules: lib/collections/small-leftovers.ts). Per line:
 *   - Book as TDS            → the existing Record payment sheet in TDS mode (./leftover-tds-dialog)
 *   - Write off              → reason (the same ask-a-reason dialog as /payments' Write off) →
 *                              write_off_small_invoice_balance (owner / accountant, ≤ ₹500)
 * Anyone else sees why they cannot and who can (§24).
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAskText } from "@/components/providers/confirm-provider";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import { rupee } from "@/lib/utils";
import type { CollectionRow } from "@/lib/queries/collections";
import { SMALL_LEFTOVER_LIMIT, leftoverLines, mayCloseLeftovers, type LeftoverLine } from "@/lib/collections/small-leftovers";
import { CustomerName, MaybeLink, type CanOpen } from "./owed-cells";
import { BookTdsSheet } from "./leftover-tds-dialog";

/** What write_off_small_invoice_balance answers (migration 20261103121500). */
interface SmallWriteOffResult { invoice_id: string; amount: number; written_off_at: string; record_id: string }
type SmallWriteOffRpc = (
  fn: "write_off_small_invoice_balance",
  args: { p_invoice_id: string; p_reason: string },
) => PromiseLike<{ data: SmallWriteOffResult | null; error: { message: string } | null }>;

export function useWriteOffSmallBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { invoiceId: string; reason: string }): Promise<SmallWriteOffResult> => {
      const supabase = createClient();
      /* Newer than the generated types; the same narrow cast as write_off_subscription. */
      const rpc = supabase.rpc as unknown as SmallWriteOffRpc;
      const { data, error } = await rpc.call(supabase, "write_off_small_invoice_balance", {
        p_invoice_id: v.invoiceId,
        p_reason:     v.reason.trim(),
      });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("The write-off was not confirmed — refresh the page to see whether it was saved.");
      return data;
    },
    onSuccess: (r) => {
      invalidateReceivables(qc);
      toast.success(`${rupee(r.amount)} on ${r.invoice_id} written off`, {
        description: "It leaves Payment Follow-up and the reminders. The invoice itself stays as issued (GST unchanged).",
      });
    },
    onError: (e: Error) => toastError(e, {
      fallback: "Not written off.",
      description: "Nothing changed. Refresh the page and try again.",
    }),
  });
}

export function SmallLeftovers({
  rows, total, role, canOpen,
}: {
  rows: readonly CollectionRow[];
  /** Amount due of `rows`, whole rupees. */
  total: number;
  role: string | null;
  canOpen: CanOpen;
}) {
  const [open, setOpen] = React.useState(false);
  const [tdsFor, setTdsFor] = React.useState<string | null>(null);
  const askText = useAskText();
  const writeOff = useWriteOffSmallBalance();
  const lines = leftoverLines(rows);
  if (lines.length === 0) return null;
  const mayClose = mayCloseLeftovers(role);

  const onWriteOff = async (l: LeftoverLine) => {
    const reason = await askText({
      title: `Write off ${rupee(l.item.amountDue)} on ${l.item.label}?`,
      body: `${l.row.customerName} will not be chased for it again — no follow-up, no reminders. The invoice stays issued as it is (GST unchanged); the reason is kept on it and in Accounting > Aging.`,
      label: "Reason (for audit)",
      placeholder: "e.g. Paid ₹1 short — round-off",
      confirmLabel: "Write off",
      danger: true,
    });
    if (reason) writeOff.mutate({ invoiceId: l.item.id, reason });
  };

  return (
    <section className="mt-4" aria-label="Small leftovers">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink"
      >
        <Icon name={open ? "chevron_down" : "chevron_right"} size={14} />
        Small leftovers ({lines.length} · {rupee(total)})
      </button>
      <p className="mt-0.5 text-xs text-ink-3">
        Balances up to {rupee(SMALL_LEFTOVER_LIMIT)}, or exactly the TDS the customer withheld — kept out of the list above.
        {mayClose ? " Book the TDS or write the balance off to close them." : " Only the owner or the accountant can close them — ask one of them."}
      </p>
      {open && (
        <Card className="mt-2 p-0 overflow-hidden">
          <ul className="divide-y divide-hairline">
            {lines.map((l) => (
              <li key={`${l.row.key}:${l.item.kind}:${l.item.id}`} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="truncate font-medium text-ink" title={l.row.customerName}><CustomerName r={l.row} canOpen={canOpen} /></div>
                    <div className="flex flex-wrap items-baseline gap-x-2 text-2xs text-ink-3">
                      <span className="uppercase tracking-wider">{l.item.kind === "invoice" ? "Inv" : "Sub"}</span>
                      <MaybeLink href={l.item.href} canOpen={canOpen} className="font-mono text-xs">{l.item.label}</MaybeLink>
                      {l.item.daysOverdue > 0 && <span>{l.item.daysOverdue} {l.item.daysOverdue === 1 ? "day" : "days"} late</span>}
                    </div>
                  </div>
                  <span className="w-20 text-right font-mono font-semibold tabular-nums text-ink">{rupee(l.item.amountDue)}</span>
                  {l.item.tdsHint
                    ? <Badge kind="warning" size="sm" title={`${l.item.tdsHint.ratePct}% of the pre-GST ${rupee(l.item.tdsHint.base)}`}>Looks like TDS {l.item.tdsHint.section} {l.item.tdsHint.ratePct}%</Badge>
                    : <Badge kind="muted" size="sm">Small balance</Badge>}
                  <div className="flex items-center gap-1.5">
                    {!mayClose ? null : (
                      <>
                        {l.canBookTds && (
                          <Button type="button" size="sm" variant="default" icon="rupee"
                            aria-label={`Book ${rupee(l.item.amountDue)} on ${l.item.label} as TDS`}
                            onClick={() => setTdsFor(l.item.id)}>
                            Book as TDS
                          </Button>
                        )}
                        {l.canWriteOff && (
                          <Button type="button" size="sm" variant={l.canBookTds ? "outline" : "default"}
                            disabled={writeOff.isPending}
                            aria-label={`Write off ${rupee(l.item.amountDue)} on ${l.item.label}`}
                            onClick={() => { void onWriteOff(l); }}>
                            Write off
                          </Button>
                        )}
                        {!l.canBookTds && !l.canWriteOff && (
                          <span className="text-2xs text-ink-3">Open the {l.item.kind === "invoice" ? "invoice" : "subscription"} to settle it.</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {tdsFor === l.item.id && l.item.tdsHint && (
                  <BookTdsSheet
                    invoiceId={l.item.id}
                    tds={{ section: l.item.tdsHint.section, ratePct: l.item.tdsHint.ratePct }}
                    onClose={() => setTdsFor(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
