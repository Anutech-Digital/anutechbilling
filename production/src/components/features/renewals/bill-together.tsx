"use client";

/**
 * R-2808 — the Renewals side of "Bill together" (R-2805):
 *  - BillTogetherGroups: the subscriptions billed together last cycle (suggestBillTogether), one box
 *    per customer, every subscription ALREADY TICKED (Pardeep 14 Nov: "un subscription ko group me
 *    selected by default dikhao") — "Bill together" is one click; untick one to leave it out.
 *  - useBillTogether: opens the dialog for some subscriptions and makes the ONE proforma (POST).
 * Shown only when the R-2807 route answers (useBillTogetherAvailable) — merged before it lands, it shows nothing.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/errors/toast-error";
import { queryKeys } from "@/lib/queries/keys";
import { createTogetherProforma, type BillTogetherGroup } from "@/lib/renewals/bill-together";
import { BILL_TOGETHER, BillTogetherDialog } from "./bill-together-dialog";

export function useBillTogether({ canQuotes }: { canQuotes: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [target, setTarget] = React.useState<{ ids: string[]; customerName: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function create(ids: string[]) {
    if (!target) return;
    setBusy(true);
    try {
      const made = await createTogetherProforma(ids);
      void qc.invalidateQueries({ queryKey: ["subscriptions"] });
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["renewals", "bill-together"] });
      void qc.invalidateQueries({ queryKey: queryKeys.collections() });
      toast.success(made.alreadyExisted
        ? `Opening the existing proforma ${made.quoteId} for ${target.customerName}`
        : `Proforma ${made.quoteId} created for ${ids.length} subscriptions of ${target.customerName} — not sent yet`, { duration: 6000 });
      setTarget(null);
      /* like Bill next part: open it to check and send (roles that can open quotes) */
      if (canQuotes && made.href) router.push(made.href as never);
    } catch (err) {
      toastError(err, { fallback: "Could not create the proforma", action: { label: "Retry", onClick: () => void create(ids) } });
    } finally {
      setBusy(false);
    }
  }

  const dialog = target && (
    <BillTogetherDialog ids={target.ids} customerName={target.customerName} open busy={busy}
      onOpenChange={(v) => { if (!v && !busy) setTarget(null); }}
      onConfirm={(ids) => void create(ids)} />
  );
  return { open: (ids: string[], customerName: string) => setTarget({ ids, customerName }), dialog };
}

export interface GroupSub { id: string; plan: string | null; seats: number | null }

/** Why the group was suggested — the box never says "billed together" for a same-domain match (code review). */
export const GROUP_WHY: Record<BillTogetherGroup["why"], string> = {
  "same-bill": "Billed together last time",
  "same-domain": "Same domain and period",
};

/** The subscriptions of a group still ticked (`off` = the ones unticked; a new group starts all ticked). */
export const tickedOf = (g: BillTogetherGroup, off: ReadonlySet<string>) => g.subIds.filter((id) => !off.has(id));

/** The suggested groups, every subscription ticked by default. `off` is kept by the page so the row hint uses it too. */
export function BillTogetherGroups({ groups, subOf, onBill, off, onToggle }: {
  groups: readonly BillTogetherGroup[];
  subOf: (id: string) => GroupSub | undefined;
  onBill: (ids: string[], customerName: string) => void;
  off: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <section aria-label="Bill together" data-testid="bill-together-groups" className="border-b border-hairline bg-amber/5 px-3 py-1.5">
      <p className="text-2xs font-medium text-ink-3">Bill together — one proforma for these subscriptions of one customer</p>
      {/* R-2821: compact — a few groups show at once, the rest scroll inside (keyboard: Tab to the list) */}
      <ul className="mt-1 max-h-24 space-y-1 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber" tabIndex={0} aria-label="Subscriptions billed together">
        {groups.map((g) => {
          const on = tickedOf(g, off);
          return (
            <li key={g.subIds.join(",")} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="bill-together-group">
              <span className="font-medium text-ink">{g.customerName}</span>
              <span className="text-2xs text-ink-3" data-testid="bill-together-why">{GROUP_WHY[g.why]}</span>
              {g.subIds.map((id) => {
                const s = subOf(id);
                const label = `${s?.plan ?? "Subscription"}${s?.seats != null ? ` · ${s.seats} seats` : ""}`;
                return (
                  <label key={id} className="inline-flex cursor-pointer items-center gap-1.5 text-ink-2">
                    <input type="checkbox" className="cursor-pointer accent-amber" checked={!off.has(id)}
                      aria-label={`Bill together — ${g.customerName} · ${label}`}
                      onChange={(e) => onToggle(id, e.target.checked)} />
                    {label}
                  </label>
                );
              })}
              <Button variant="primary" size="sm" disabled={on.length < 2} onClick={() => onBill(on, g.customerName)}
                aria-label={`${BILL_TOGETHER} — ${g.customerName} (${on.length})`}>
                {BILL_TOGETHER}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
