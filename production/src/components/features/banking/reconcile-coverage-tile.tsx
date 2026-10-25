/**
 * R-1869 — "Reconciled so far: ₹X of ₹Y" with a progress bar and the gap next to it.
 * Replaces the old "Balance in app" + "To reconcile" tiles: opening + reconciled lines only was
 * not a balance of anything and showed ₹-19,17,804 in red on a healthy account. This is the
 * coverage of the books (lib/banking/reconcile-coverage), never cash — every figure is ≥ 0.
 */
import { rupee } from "@/lib/utils";
import type { ReconcileCoverage } from "@/lib/banking/reconcile-coverage";

const lines = (n: number) => `${n.toLocaleString("en-IN")} ${n === 1 ? "line" : "lines"}`;

export function ReconcileCoverageTile({ c, onShowUnmatched }: { c: ReconcileCoverage; onShowUnmatched?: () => void }) {
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Reconciled so far</p>
      <p className="mt-1 font-serif text-2xl text-ink tabular-nums">
        {rupee(c.reconciledAmount)}
        <span className="text-sm font-sans text-ink-3"> of {rupee(c.totalAmount)}</span>
      </p>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-paper-2"
        role="progressbar"
        aria-label="Share of the account's money reconciled in your books"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={c.percent}
      >
        <div className={`h-full rounded-full ${c.done ? "bg-emerald" : "bg-amber"}`} style={{ width: `${c.percent}%` }} />
      </div>
      <p className="mt-1 text-xs text-ink-3">
        {c.totalLines === 0 ? "No lines imported yet" : c.done ? (
          <span className="text-emerald">{`All ${lines(c.totalLines)} reconciled ✓`}</span>
        ) : (
          <>
            {`${c.percent}% · `}
            {onShowUnmatched ? (
              <button type="button" onClick={onShowUnmatched} className="text-ink-2 underline-offset-2 hover:underline">
                {`${rupee(c.leftAmount)} still to reconcile (${lines(c.leftLines)})`}
              </button>
            ) : (
              <span className="text-ink-2">{`${rupee(c.leftAmount)} still to reconcile (${lines(c.leftLines)})`}</span>
            )}
          </>
        )}
      </p>
    </div>
  );
}
