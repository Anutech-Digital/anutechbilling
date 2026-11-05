"use client";

/**
 * R-1678 — Banking → Reconcile → "This money is for": a ₹ credit that settles invoices in a foreign
 * currency. The sheet says what it books (settled in full, the gap to "Exchange gain / loss
 * (realised)") and, for a ₹ credit, lets the operator say it was NOT an exchange difference — then it is
 * booked in ₹ as usual (part payment / TDS / advance; code review 5 Nov: an Indian customer billed in
 * USD may have deducted TDS, or a gateway fee). An inward remittance in that currency has no ₹ choice:
 * it settles its invoices (R-2427).
 */
import { splitFxText, type FxChoice, type SplitFx } from "@/lib/banking/item-fx-pay";

export type { FxChoice };

export function FxSettleNote({ fx, choice, onChoice }: { fx: SplitFx; choice: FxChoice; onChoice: (c: FxChoice) => void }) {
  const canChoose = fx.remittance === null;
  return (
    <div className="space-y-1.5">
      {canChoose && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" role="group" aria-label="What the difference is">
          {([["fx", "Exchange difference — settle in full"], ["rupee", "Not exchange — book in ₹ (part / TDS / advance)"]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={choice === k} onClick={() => onChoice(k)}
              className={`rounded-md border px-2 py-1.5 text-xs font-medium text-left ${choice === k ? "border-amber bg-amber/10 text-amber-ink" : "border-hairline text-ink-2"}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      {(choice === "fx" || !canChoose) && (
        <p className="text-xs text-ink-2 bg-paper rounded-md border border-hairline px-2.5 py-2 break-words">{splitFxText(fx)}</p>
      )}
    </div>
  );
}
