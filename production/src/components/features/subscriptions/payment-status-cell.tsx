"use client";
/**
 * R-2382 — the Payment cell of the Subscriptions list (one line + a small second line)
 * and the "Paid · Due · Overdue" chips beside the billing-cycle chips. The words and the
 * colour come from subscriptionPaymentStatus() (lib/subscriptions/payment-status.ts).
 */
import { cn } from "@/lib/utils";
import {
  type PaymentFilter, type PaymentStatus, type PaymentTone,
} from "@/lib/subscriptions/payment-status";

const TONE_TEXT: Record<PaymentTone, string> = {
  success: "text-emerald",
  danger: "text-rose",
  warning: "text-amber-ink",
  muted: "text-ink-3",
};

export function PaymentStatusCell({ status }: { status: PaymentStatus }) {
  return (
    <div data-payment-kind={status.kind} className="min-w-0">
      <div className={cn("text-xs font-semibold leading-snug break-words", TONE_TEXT[status.tone])}>
        {status.label}
      </div>
      {status.detail && (
        <div className="mt-0.5 text-3xs text-ink-3 tabular-nums leading-snug break-words">{status.detail}</div>
      )}
    </div>
  );
}

const CHIPS: { value: Exclude<PaymentFilter, "">; label: string; hint: string }[] = [
  { value: "paid", label: "Paid", hint: "This period is paid" },
  { value: "due", label: "Due", hint: "Money owed on this subscription" },
  { value: "overdue", label: "Overdue", hint: "Owed and past its due date" },
];

export function PaymentFilterChips({
  counts, value, onChange,
}: {
  counts: Record<Exclude<PaymentFilter, "">, number>;
  value: PaymentFilter;
  onChange: (next: PaymentFilter) => void;
}) {
  return (
    <div role="group" aria-label="Payment" className="inline-flex flex-wrap gap-1 bg-paper-2 rounded-md p-0.5">
      {CHIPS.map((c) => {
        const on = value === c.value;
        return (
          <button
            key={c.value}
            type="button"
            aria-pressed={on}
            title={c.hint}
            /* A second click on the chosen chip clears it — "All" without a fourth chip. */
            onClick={() => onChange(on ? "" : c.value)}
            className={cn(
              "px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer inline-flex items-center gap-1.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              on ? "bg-paper text-ink shadow-xs font-semibold" : "text-ink-3 hover:text-ink",
            )}
          >
            {c.label}
            <span className={cn("tabular-nums font-normal", c.value === "overdue" && counts.overdue > 0 ? "text-rose" : "text-ink-3")}>
              {counts[c.value]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
