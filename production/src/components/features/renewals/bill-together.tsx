"use client";

/**
 * R-2808 — the Renewals side of "Bill together" (R-2805):
 *  - BillTogetherGroups: the subscriptions billed together last cycle (suggestBillTogether), one box
 *    per customer, every subscription ALREADY TICKED (Pardeep 14 Nov: "un subscription ko group me
 *    selected by default dikhao") — "Bill together" is one click; untick one to leave it out.
 *  - useBillTogether: opens the dialog for some subscriptions and makes the ONE proforma (POST).
 * Shown only when the R-2807 route answers (useBillTogetherProbe) — merged before it lands, it shows nothing.
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

interface Target { ids: string[]; customerName: string }

export function useBillTogether({ canQuotes }: { canQuotes: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [target, setTarget] = React.useState<Target | null>(null);
  const [busy, setBusy] = React.useState(false);
  /* the dialog open right now, for a create that finishes later (a toast Retry may finish under another group) */
  const openNow = React.useRef<Target | null>(null);
  React.useEffect(() => { openNow.current = target; }, [target]);
  /* R-2832 (rev-r2808 F2): ONE request in flight — a double click or the toast's Retry pressed while a POST
     is still out never sends a second one (state updates too late for a same-tick second click). */
  const inFlight = React.useRef(false);

  /* `from` = the dialog it was asked from, passed in (not read from `target`) so the toast's Retry still works
     after that dialog closed */
  async function create(ids: string[], from: Target) {
    const { customerName } = from;
    if (inFlight.current) {
      toast.info("A proforma is still being created — wait for it, then try again.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const made = await createTogetherProforma(ids);
      void qc.invalidateQueries({ queryKey: ["subscriptions"] });
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["renewals", "bill-together"] });
      void qc.invalidateQueries({ queryKey: queryKeys.collections() });
      toast.success(made.alreadyExisted
        ? `Opening the existing proforma ${made.quoteId} for ${customerName}`
        : `Proforma ${made.quoteId} created for ${ids.length} subscriptions of ${customerName} — not sent yet`, { duration: 6000 });
      /* another group's dialog opened meanwhile (a Retry that finished later) stays open — never closed or left */
      const mine = openNow.current === null || openNow.current === from;
      if (mine) setTarget(null);
      /* like Bill next part: open it to check and send (roles that can open quotes) */
      if (mine && canQuotes && made.href) router.push(made.href as never);
    } catch (err) {
      toastError(err, { fallback: "Could not create the proforma", action: { label: "Retry", onClick: () => void create(ids, from) } });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const dialog = target && (
    <BillTogetherDialog ids={target.ids} customerName={target.customerName} open busy={busy}
      onOpenChange={(v) => { if (!v && !busy) setTarget(null); }}
      onConfirm={(ids) => void create(ids, target)} />
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

/**
 * R-2832 (rev-r2808 F5): a row's "Bills with …" hint. With two or more of its group still ticked it opens
 * Bill together with them; under two it says "tick at least two" and only tells how, instead of opening a
 * near-empty dialog.
 */
export function togetherHint(
  hint: { group: BillTogetherGroup; text: string },
  off: ReadonlySet<string>,
  open: (ids: string[], customerName: string) => void,
): { text: string; title?: string; onClick: () => void } {
  const { group } = hint;
  const on = tickedOf(group, off);
  if (on.length >= 2) return { text: hint.text, onClick: () => open(on, group.customerName) };
  const how = `Tick at least two subscriptions of ${group.customerName} in the Bill together box above to bill them on one proforma.`;
  /* the instruction first — a long hint is cut at its end (truncate); the plan names stay in the tooltip */
  return { text: `Tick at least two — ${hint.text.charAt(0).toLowerCase()}${hint.text.slice(1)}`, title: `${hint.text}. ${how}`, onClick: () => toast.info(how) };
}

/**
 * The suggested groups, every subscription ticked by default. `off` is kept by the page so the row hint uses it too.
 * `pending` (R-2832 F6): the availability check is still out — the same rows show, nothing can be pressed, so
 * the box does not pop in and push the table down once the check answers.
 */
export function BillTogetherGroups({ groups, subOf, onBill, off, onToggle, pending = false }: {
  groups: readonly BillTogetherGroup[];
  subOf: (id: string) => GroupSub | undefined;
  onBill: (ids: string[], customerName: string) => void;
  off: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
  pending?: boolean;
}) {
  if (groups.length === 0) return null;
  return (
    <section aria-label="Bill together" aria-busy={pending || undefined} data-testid="bill-together-groups" className="border-b border-hairline bg-amber/5 px-3 py-1.5">
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
                    <input type="checkbox" className="cursor-pointer accent-amber disabled:cursor-wait" checked={!off.has(id)} disabled={pending}
                      aria-label={`Bill together — ${g.customerName} · ${label}`}
                      onChange={(e) => onToggle(id, e.target.checked)} />
                    {label}
                  </label>
                );
              })}
              <Button variant="primary" size="sm" disabled={pending || on.length < 2} onClick={() => onBill(on, g.customerName)}
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
