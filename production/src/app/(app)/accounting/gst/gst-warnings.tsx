/**
 * The amber notices above the GST output table (moved out of page.tsx, which is at its
 * line limit): R-335 late credit notes, and R-1131 documents whose GST rate is missing.
 */
import type { GstReport } from "./cash-to-pay";

const alertClass = "mb-3 rounded-md bg-amber-soft/60 border border-amber/40 px-3 py-2 text-xs text-amber-ink leading-relaxed";

export function GstWarnings({ data }: { data: Pick<GstReport, "lateCreditNotes" | "rateMissingDocs"> }) {
  const late = data.lateCreditNotes;
  const missing = data.rateMissingDocs ?? 0;
  return (
    <>
      {late > 0 && (
        <div role="alert" className={alertClass}>
          <b>{late} late credit note{late === 1 ? "" : "s"}</b> — issued after GST s.34&apos;s
          limit for the invoice (30 Nov after its financial year, or the annual return date if earlier). They may not
          reduce output GST; confirm with your CA before filing. Marked &ldquo;Late&rdquo; below.
        </div>
      )}
      {missing > 0 && (
        <div role="alert" className={alertClass}>
          <b>GST rate missing on {missing} document{missing === 1 ? "" : "s"}</b> — no rate was saved and there is
          no tax figure to work it out from, so they are shown at 0%. Set the rate on the invoice, note or quote
          before filing.
        </div>
      )}
    </>
  );
}
