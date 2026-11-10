/**
 * R-2665 (10 Nov 2026) — statements with ONE amount column and a separate debit / credit FLAG
 * column, e.g. HDFC credit-card "Billed statements" (.xls):
 *   Transaction type · Primary / Addon Customer Name · Date & Time · Description · REWARDS · AMT · Debit / Credit
 * "Date & Time" is one cell ("03/04/2025 / 16:50" — the date part is read, the time dropped),
 * AMT is the amount, and the flag is "" for a spend (money out) and "Cr" for a payment / refund
 * (money in). There is no running balance — none is invented (R-1693: the chain check then says
 * it did not run).
 *
 * Before this, the header "Debit / Credit" matched the Debit alias ("debit …"), so the FLAG
 * column was read as the debit amount, AMT was never read, every line was skipped and the import
 * said "Couldn't parse".
 */

/** Normalised (statement-parse normaliseHeader) names of a side-flag column. */
export const FLAG_HEADERS = [
  "debit credit", "credit debit", "dr cr", "cr dr",
  "debit credit indicator", "dr cr indicator", "debit credit flag",
];

/** Normalised names of the one amount column a flag layout has. */
export const AMOUNT_HEADERS = ["amt", "amount", "transaction amount", "amount rs", "amount in rs", "amount inr", "txn amount"];

/**
 * The flag cell → the side. HDFC leaves the cell EMPTY for a spend and writes "Cr" for money in;
 * other banks write Dr / Cr in full. `blankIsDebit`: only for a file that never writes Dr itself
 * (the HDFC way) — elsewhere a blank says nothing. Anything else → null: the line is skipped and
 * counted with a warning, never guessed.
 */
export function flagSide(cell: string | undefined, blankIsDebit: boolean): "debit" | "credit" | null {
  const t = (cell ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (t === "") return blankIsDebit ? "debit" : null;
  if (t === "dr" || t === "d" || t === "debit") return "debit";
  if (t === "cr" || t === "c" || t === "credit") return "credit";
  return null;
}

/** The warning for lines whose flag said neither side. */
export function unknownFlagWarning(n: number, seen: readonly string[]): string {
  const shown = seen.slice(0, 3).map((s) => (s ? `"${s}"` : "nothing (blank)")).join(", ");
  return `${n} line${n === 1 ? " was" : "s were"} skipped — the Debit / Credit column says ${shown}, which is neither Cr (money in) nor Dr / blank (money out). Check ${n === 1 ? "it" : "them"} in the statement.`;
}
