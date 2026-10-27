/**
 * R-2006 — the Reconcile sheet's shell: "Who is this money for?" tiles, the chosen tile's
 * heading with "← Change", and the sticky footer (Save + amount check).
 *
 * Only layout lives here. Every booking (RPC, money rule) stays in its own section or in
 * reconcile-transaction-dialog.tsx; a tile just decides WHICH of those sections is shown.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";

export type WhoTile =
  | "customer" | "vendor" | "employee" | "owner" | "loan" | "tax" | "tax_refund" | "transfer" | "other";

interface TileDef { id: WhoTile; label: string; hint: string; icon: string }

/* Money in: the commonest first (a customer paying). */
export const MONEY_IN_TILES: readonly TileDef[] = [
  { id: "customer",   label: "Customer",        hint: "Payment for a sale, invoice or project", icon: "users" },
  { id: "owner",      label: "Owner",           hint: "Capital or a loan from the owner",      icon: "user" },
  { id: "loan",       label: "Loan / EMI",      hint: "A loan received or given back",         icon: "wallet" },
  { id: "employee",   label: "Employee return", hint: "Unused advance coming back",            icon: "briefcase" },
  { id: "transfer",   label: "Own transfer",    hint: "From your other bank account",          icon: "refresh" },
  { id: "tax_refund", label: "Tax refund",      hint: "Income tax / GST refund",               icon: "receipt" },
  { id: "other",      label: "Other / manual",  hint: "Interest, reversal, anything else",     icon: "more_horizontal" },
];

/* Money out: a vendor first (most money out pays a bill). */
export const MONEY_OUT_TILES: readonly TileDef[] = [
  { id: "vendor",   label: "Vendor",             hint: "Pay bills, a new bill or an advance", icon: "building" },
  { id: "employee", label: "Employee / salary",  hint: "Salary, advance, incentive",          icon: "briefcase" },
  { id: "owner",    label: "Owner",              hint: "Drawings or paid to a director",      icon: "user" },
  { id: "loan",     label: "Loan / EMI",         hint: "EMI or a loan given / repaid",        icon: "wallet" },
  { id: "tax",      label: "Tax / GST / TDS",    hint: "ESI, PF, TDS, GST, income tax",       icon: "shield" },
  { id: "transfer", label: "Own transfer",       hint: "To your other bank account",          icon: "refresh" },
  { id: "other",    label: "Bank charge / other", hint: "Book an expense, or mark manually",  icon: "more_horizontal" },
];

export function tilesFor(isCredit: boolean): readonly TileDef[] {
  return isCredit ? MONEY_IN_TILES : MONEY_OUT_TILES;
}

export function tileLabel(isCredit: boolean, id: WhoTile): string {
  return tilesFor(isCredit).find((t) => t.id === id)?.label ?? "";
}

/** "Who is this money for?" — a radiogroup: arrows move, Enter / Space picks. */
export function WhoTiles({ isCredit, value, onPick }: { isCredit: boolean; value: WhoTile | null; onPick: (t: WhoTile) => void }) {
  const tiles = tilesFor(isCredit);
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const focusable = Math.max(0, tiles.findIndex((t) => t.id === value));
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + tiles.length) % tiles.length;
    refs.current[next]?.focus();
  };
  return (
    <div>
      <p id="who-tiles-label" className="text-xs font-semibold text-ink-2 mb-2">Who is this money for?</p>
      <div role="radiogroup" aria-labelledby="who-tiles-label" className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {tiles.map((t, i) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={i === focusable ? 0 : -1}
              onClick={() => onPick(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={`min-w-0 rounded-md border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/50 ${on ? "border-amber bg-amber-soft/40" : "border-hairline bg-paper hover:border-hairline-strong"}`}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                <Icon name={t.icon} size={14} className={on ? "text-amber-ink" : "text-ink-3"} />
                <span className="truncate">{t.label}</span>
              </span>
              <span className="mt-0.5 block text-xs text-ink-3 leading-snug">{t.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The chosen tile's title row: "← Change" goes back to the tiles. */
export function ChosenTileBar({ label, onChange }: { label: string; onChange?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs font-semibold text-ink-2">
        This money is for: <span className="text-ink">{label}</span>
      </p>
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          aria-label="Change who this money is for"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-amber-ink underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/50"
        >
          ← Change
        </button>
      )}
    </div>
  );
}

/** Holds a tile's sections; when they render nothing for this line, says so in one line. */
export function SectionSlot({ empty, children }: { empty: string; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [isEmpty, setIsEmpty] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setIsEmpty(el.childElementCount === 0);
    update();
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true });
    return () => mo.disconnect();
  }, []);
  return (
    <>
      <div ref={ref} className="space-y-4">{children}</div>
      {isEmpty && <p className="text-xs text-ink-3">{empty}</p>}
    </>
  );
}

/** What a section hands the sticky footer: its Save button and what it books. */
export interface FooterSave {
  label: string;
  onSave: () => void;
  /** Set → the Save button is disabled and this sentence says why. */
  disabledReason?: string | null;
  loading?: boolean;
  /** Rupees this save books from the bank line (default: the whole line). */
  booked?: number;
}

/** "Bank ₹X = ₹Y ✓" when the save books the whole line, else "₹Z left". */
export function amountCheckText(lineAmount: number, booked: number): { text: string; ok: boolean } {
  if (booked === lineAmount) return { text: `Bank ${rupee(lineAmount)} = ${rupee(booked)} ✓`, ok: true };
  const left = lineAmount - booked;
  return left > 0
    ? { text: `Bank ${rupee(lineAmount)} · ${rupee(booked)} booked · ${rupee(left)} left`, ok: false }
    : { text: `Bank ${rupee(lineAmount)} · ${rupee(-left)} more than the line`, ok: false };
}

/** Sticky footer: the chosen section's Save (when it hands one over) + the amount check + Close. */
export function ReconcileFooter({ amount, save, hint, onClose }: {
  amount: number;
  save: FooterSave | null;
  /** Shown when there is no footer Save (no tile yet, or the section keeps its own button). */
  hint: string;
  onClose: () => void;
}) {
  const check = save ? amountCheckText(amount, save.booked ?? amount) : null;
  return (
    <div className="sticky bottom-0 border-t border-hairline bg-paper px-5 py-3 space-y-2" data-testid="reconcile-footer">
      <div className="flex items-start justify-between gap-3">
        <p className={`text-xs tabular-nums ${check ? (check.ok ? "text-emerald-ink" : "text-amber-ink") : "text-ink-3"}`}>
          {check ? check.text : <>Bank {rupee(amount)} · {hint}</>}
        </p>
      </div>
      {save?.disabledReason && <p className="text-xs text-ink-3">{save.disabledReason}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        {save && (
          <Button
            type="button"
            variant="primary"
            icon="check"
            disabled={Boolean(save.disabledReason) || save.loading}
            loading={save.loading}
            onClick={save.onSave}
          >
            {save.label}
          </Button>
        )}
      </div>
    </div>
  );
}
