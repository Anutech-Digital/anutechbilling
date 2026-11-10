/**
 * R-2227 (Zoho Billing A3) — "Change plan" for a licence subscription mid-term
 * (e.g. Business Starter → Business Standard).
 *
 * Pick the new plan and the seats; the preview comes FROM THE SERVER (POST …/change-plan with
 * preview: true) — the same buildPlanChange() and the same books-read money as the quote it then
 * saves, so the preview and the quote cannot differ (R-803) and the credit is never more than was
 * billed / paid (R-2255). Shows: the new plan for the days left, less the unused current plan, the
 * net to pay. Creates a DRAFT quote and opens it; the plan changes when the quote is paid and the
 * renewal date stays. A cheaper plan / fewer seats are refused with the next step.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee, formatDate } from "@/lib/utils";
import type { Item, Subscription } from "@/lib/supabase/database.types";
import { subscriptionProducts } from "@/lib/subscriptions/catalog-options";
import { planChangeTargets, type PlanChangeCalc } from "@/lib/subscriptions/change-plan";

interface Props {
  sub:          Subscription;
  catalog:      readonly Item[];
  open:         boolean;
  onOpenChange: (v: boolean) => void;
}

const SELECT_CLS =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40 disabled:opacity-70";
const money = (n: number) => rupee(n, { decimals: Number.isInteger(n) ? 0 : 2 });

type Preview = { calc: PlanChangeCalc } | { error: string } | null;

async function postChange(subId: string, body: object): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
  const res = await fetch(`/api/subscriptions/${subId}/change-plan`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { ok: res.ok, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

export default function ChangePlanDialog({ sub, catalog, open, onOpenChange }: Props) {
  const router = useRouter();
  const targets = React.useMemo(
    () => planChangeTargets(sub, subscriptionProducts(catalog.filter((i) => i.is_active !== false))),
    [sub, catalog],
  );
  const [toId, setToId] = React.useState<string>("");
  const [seatsStr, setSeatsStr] = React.useState(String(sub.seats ?? 1));
  const [preview, setPreview] = React.useState<Preview>(null);
  const [loading, setLoading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  React.useEffect(() => {
    if (open) { setToId(targets[0]?.id ?? ""); setSeatsStr(String(sub.seats ?? 1)); }
  }, [open, sub.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const seats = Number.parseInt(seatsStr, 10);

  React.useEffect(() => {
    if (!open || !toId || !Number.isSafeInteger(seats) || seats < 1) { setPreview(null); return; }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      postChange(sub.id, { to_item_id: toId, seats, preview: true })
        .then(({ ok, json }) => {
          if (!live) return;
          setPreview(ok && json?.calc ? { calc: json.calc as PlanChangeCalc } : { error: String(json?.error ?? "Could not work out the change.") });
        })
        .catch(() => { if (live) setPreview({ error: "Could not reach the server. Check your connection, then try again." }); })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [open, sub.id, toId, seats]);

  const target = targets.find((t) => t.id === toId);
  const calc = preview && "calc" in preview ? preview.calc : null;

  const onSubmit = async () => {
    if (!calc || !toId) return;
    setSubmitting(true);
    try {
      const { ok, json } = await postChange(sub.id, { to_item_id: toId, seats });
      if (!ok || !json?.quoteId) {
        const msg = String(json?.error ?? "Could not create the plan change quote.");
        setPreview({ error: msg });
        toast.error(msg, { description: "No quote was made." });
        return;
      }
      toast.success(`Plan change quote ${String(json.quoteId)} created (${rupee(Number(json.amount ?? 0))} incl. GST) — opening it now`);
      onOpenChange(false);
      router.push(`/quotes/${String(json.quoteId)}`);
    } catch (err) {
      toastError(err, { fallback: "Could not create the plan change quote." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">Subscription · Change plan</p>
          <h2 className="font-serif text-2xl text-ink">{sub.customer_name}</h2>
          <p className="text-xs text-ink-2 mt-1">
            {sub.plan} · {sub.seats} seat{sub.seats === 1 ? "" : "s"} · renews {sub.renewal_date ? formatDate(sub.renewal_date) : "—"}
          </p>
        </header>

        {targets.length === 0 ? (
          <p role="alert" className="rounded-md border border-rose/40 bg-rose/5 px-3 py-2 text-xs text-rose mb-4">
            No other plan from this vendor is in your catalogue. Add it under Products first.
          </p>
        ) : (
          <div className="grid grid-cols-[1fr_7rem] gap-3 mb-4">
            <div>
              <label htmlFor="change-plan-to" className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">New plan</label>
              <select id="change-plan-to" value={toId} onChange={(e) => setToId(e.target.value)} className={SELECT_CLS}>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} — {money(t.annualSellPerSeat)}/seat/yr</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="change-plan-seats" className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Seats</label>
              <Input id="change-plan-seats" type="number" min={sub.seats ?? 1} value={seatsStr}
                onChange={(e) => setSeatsStr(e.target.value)} className="font-mono text-center" />
            </div>
          </div>
        )}

        {calc && target ? (
          <div className="bg-paper-2 rounded-md p-3 mb-4 text-sm" data-testid="change-plan-calc" aria-busy={loading}>
            <div className="flex justify-between mb-1">
              <span className="text-ink-3">Charged for</span>
              <span className="tabular-nums text-ink-2">{formatDate(calc.from)} – {formatDate(calc.to)}{calc.parts ? " (this billing part)" : ""}</span>
            </div>
            <div className="flex justify-between gap-3 mb-1">
              <span className="text-ink-3">{target.name}: {calc.newSeats} × {money(calc.newPerSeat)}</span>
              <span className="tabular-nums text-ink-2">{money(calc.newCharge)}</span>
            </div>
            <div className="flex justify-between gap-3 mb-1">
              <span className="text-ink-3">Less unused {sub.plan}: {calc.oldSeats} × {money(calc.oldPerSeat)}</span>
              <span className="tabular-nums text-ink-2">−{money(calc.credit)}</span>
            </div>
            {calc.credit < calc.unused && (
              <p className="text-2xs text-amber-ink mb-1">
                Unused value is {money(calc.unused)}, but only {money(calc.credit)} is credited — no more than what was paid for this term.
              </p>
            )}
            <div className="flex justify-between pt-2 border-t border-hairline">
              <span className="font-medium text-ink">To pay, before GST</span>
              <span className="font-serif text-lg tabular-nums text-ink" data-testid="change-plan-net">{rupee(calc.net)}</span>
            </div>
            <p className="text-2xs text-ink-3 mt-2">
              {rupee(calc.total)} incl. GST. The renewal date stays {sub.renewal_date ? formatDate(sub.renewal_date) : "the same"};
              the plan changes to {target.name} ({rupee(calc.newMrr)}/month) when the quote is paid.
            </p>
          </div>
        ) : preview && "error" in preview ? (
          <p role="alert" className="rounded-md border border-rose/40 bg-rose/5 px-3 py-2 text-xs text-rose mb-4">{preview.error}</p>
        ) : targets.length > 0 ? (
          <p className="text-xs text-ink-3 mb-4">{loading ? "Working out the change…" : "Pick the new plan and seats."}</p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          {calc && (
            <Button variant="primary" icon="zap" onClick={onSubmit} disabled={submitting || loading}>
              {submitting ? "Creating…" : "Create plan change quote"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
