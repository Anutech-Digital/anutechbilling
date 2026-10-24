/**
 * How a net result (profit or loss) is shown — one helper for every P&L place.
 *
 * R-1486 (17 Oct 2026): October's ₹68,100 LOSS rendered as "What's left → Net profit
 * ₹68,100" — the row passed Math.abs() and kept the label. A loss reads "Net loss" with a
 * minus sign in front of the rupee ("−₹68,100"); a profit is unchanged. The number itself
 * is never altered — only how it is labelled and signed.
 */
import { rupee } from "@/lib/utils";

type RupeeOpts = Parameters<typeof rupee>[1];

/**
 * A signed rupee figure with the minus in FRONT of the symbol ("−₹68,100"). `rupee()` puts
 * it after ("₹-68,100", and "₹-68.1K" compact), which reads like a typo. The sign follows
 * the rounded text, so −0.4 shows "₹0", never "−₹0".
 */
export function signedRupee(n: number, opts?: RupeeOpts): string {
  const text = rupee(Math.abs(n), opts);
  return n < 0 && text !== rupee(0, opts) ? `−${text}` : text;
}

export interface NetFigure {
  label: "Net profit" | "Net loss";
  text: string;
  isLoss: boolean;
}

/** The label and signed amount for a net result: −68100 → "Net loss", "−₹68,100". */
export function netFigure(n: number, opts?: RupeeOpts): NetFigure {
  const isLoss = n < 0;
  return { label: isLoss ? "Net loss" : "Net profit", text: signedRupee(n, opts), isLoss };
}
