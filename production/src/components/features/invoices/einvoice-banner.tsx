/**
 * R-337 — the amber "e-Invoice IRN" notice. Presentational only: the text comes from
 * lib/compliance/einvoice.ts. A warning, never a block — the app does not make IRNs yet.
 */
import { Icon } from "@/components/ui/icon";
import type { EinvoiceNoticeText } from "@/lib/compliance/einvoice";

export function EinvoiceBanner({ notice, className = "" }: { notice: EinvoiceNoticeText | null; className?: string }) {
  if (!notice) return null;
  return (
    <div
      role="note"
      data-einvoice-banner
      className={`flex gap-2.5 rounded-md border border-amber/40 bg-amber/10 px-3 py-2.5 text-[13px] leading-relaxed ${className}`}
    >
      <Icon name="alert" size={14} className="text-amber mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold text-ink">{notice.title}</p>
        <p className="text-ink-2">{notice.body}</p>
      </div>
    </div>
  );
}
