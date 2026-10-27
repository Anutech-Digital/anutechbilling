"use client";
/**
 * R-1831: the result of an Auto-reconcile run, kept on the bank page until closed or the next
 * run. It used to be a toast that vanished in seconds — on staging (24 Oct) a 1,414-line run
 * that matched nothing looked like nothing had happened. Words: autoReconcileSummary.
 */
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { autoReconcileSummary, type AutoReconcileSummary } from "@/lib/queries/bank";

const TONE: Record<"success" | "info" | "warning", string> = {
  success: "border-emerald/30 bg-emerald-soft/40",
  info: "border-hairline-strong bg-paper-2/60",
  warning: "border-amber/30 bg-amber-soft/40",
};

export function AutoReconcileResult({
  summary, onShowUnmatched, onClose, unmatchedShown,
}: {
  summary: AutoReconcileSummary;
  onShowUnmatched: () => void;
  onClose: () => void;
  /** The Unmatched tab is already open — the button would do nothing. */
  unmatchedShown: boolean;
}) {
  const r = autoReconcileSummary(summary);
  return (
    <div role="status" className={`mb-4 rounded-md border px-4 py-3 ${TONE[r.tone]}`}>
      <div className="flex items-start gap-3">
        <Icon name={r.tone === "success" ? "check_circle" : "sparkles"} size={16} className="mt-0.5 shrink-0 text-ink-2" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">Auto-reconcile: {r.title}</p>
          {r.description && <p className="mt-0.5 text-xs text-ink-2 leading-snug">{r.description}</p>}
          {r.showUnmatched && !unmatchedShown && (
            <Button size="sm" variant="default" className="mt-2" onClick={onShowUnmatched}>
              Show unmatched lines
            </Button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the auto-reconcile result"
          className="shrink-0 rounded p-1 text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
