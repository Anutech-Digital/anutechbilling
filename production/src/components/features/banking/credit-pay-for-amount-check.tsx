/**
 * R-1838 / R-2095 / R-2558 — the amount check under "This money is for:" on a money-in bank line:
 * exact / over (kept as credit) / short — and for a short receipt, why less came in (TDS deducted,
 * part payment, round-off). "TDS deducted" asks the section and the rate (R-2558: the customer's
 * deduction rate, never TDS ÷ part) and says the gross the TDS row will carry.
 * Moved out of credit-pay-for-section.tsx unchanged (R-2558, max-lines).
 * R-2192: ₹1 over is a round-off (never a ₹1 advance); a wire short by the bank's / SWIFT charge
 * offers "Bank / SWIFT charge ₹__ — settled in full" (Bank Charges expense).
 */
"use client";

import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import { overIsRoundOff, shortChoices, type AmountCheck, type ShortChoice } from "@/lib/banking/credit-pay-for";
import { TDS_SECTION_CHOICES } from "@/lib/banking/tds-section";

export function AmountCheckBox({ check, credit, due, choice, onChoice, section, onSection, rateText, onRate, rateReason, problem, gross, noRoundOff }: {
  check: AmountCheck; credit: number; due: number; choice: ShortChoice | null; onChoice: (c: ShortChoice) => void;
  /** R-2558: null = not chosen yet (the owner picks; nothing is guessed). */
  section: string | null; onSection: (s: string) => void;
  /** R-2558: the rate box — the customer's deduction rate, never TDS ÷ part. */
  rateText: string; onRate: (t: string) => void; rateReason: string | null; problem: string | null;
  /** R-2558: the gross the TDS row will carry (the server's R-2538 rule) for the typed rate. */
  gross: number | null; noRoundOff?: boolean;
}) {
  /* R-2192: a relink cannot settle by write-off — neither round-off nor bank charge. */
  const choices = shortChoices(check, due).filter((c) => !(noRoundOff && (c.value === "round_off" || c.value === "bank_charge")));
  if (check.kind === "exact") {
    return <p className="text-xs text-emerald inline-flex items-center gap-1"><Icon name="check" size={12} /> {rupee(credit)} received = {rupee(due)} due.</p>;
  }
  if (check.kind === "over" && overIsRoundOff(check) && !noRoundOff) {
    return (
      <p className="text-xs text-ink-2 bg-paper rounded-md border border-hairline px-2.5 py-2">
        {rupee(credit)} received is <b>{rupee(check.overBy)} more</b> than {rupee(due)} due — written off as round-off (Bank Charges); settled in full.
      </p>
    );
  }
  if (check.kind === "over") {
    return (
      <p className="text-xs text-ink-2 bg-paper rounded-md border border-hairline px-2.5 py-2">
        {rupee(credit)} received is <b>{rupee(check.overBy)} more</b> than {rupee(due)} due — the extra is kept as the customer&apos;s advance credit and used on their next bill.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-hairline bg-paper px-2.5 py-2 space-y-1.5">
      <p className="text-xs text-ink-2">
        {rupee(credit)} received is <b>{rupee(check.shortBy)} less</b> than {rupee(due)} due.
      </p>
      <div className={`grid grid-cols-1 gap-1.5 ${choices.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`} role="group" aria-label="Why less was received">
        {choices.map(({ value: k, label }) => (
          <button
            key={k}
            type="button"
            aria-pressed={choice === k}
            onClick={() => onChoice(k)}
            className={`rounded-md border px-2 py-1.5 text-xs font-medium text-left ${choice === k ? "border-amber bg-amber/10 text-amber-ink" : "border-hairline text-ink-2"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {choice === "bank_charge" && (
        <p className="text-xs text-ink-3">Booked as a Bank Charges expense on this bank line — the bill is settled in full.</p>
      )}
      {choice === "tds" && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <span>TDS section</span>
              <select value={section ?? ""} onChange={(e) => onSection(e.target.value)} aria-label="TDS section"
                className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40">
                {section === null && <option value="" disabled>Choose section</option>}
                {section !== null && !TDS_SECTION_CHOICES.some((c) => c.value === section) && <option value={section}>{section}</option>}
                {TDS_SECTION_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <span>TDS rate %</span>
              <Input type="number" inputMode="decimal" min={0} max={100} step="0.01" value={rateText}
                onChange={(e) => onRate(e.target.value)} aria-label="TDS rate %" className="h-7 w-20 text-xs" />
            </label>
          </div>
          {rateReason && <p className="text-xs text-ink-3">{rateReason}</p>}
          {problem
            ? <p className="text-xs text-amber-ink">{problem}</p>
            : <p className="text-xs text-ink-3 tabular-nums">Booked as TDS receivable — {section}{gross !== null ? `, gross ${rupee(gross)}` : ""} @ {rateText}% — collect the customer&apos;s Form 16A.</p>}
        </div>
      )}
    </div>
  );
}
