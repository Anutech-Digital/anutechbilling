/**
 * R-472 — the Marketing Hub "Monthly budget (₹)" box. −5000 used to save as ₹0 with no
 * message (`Number(budget) || 0` on a value the DB clamps). Now a wrong value is named
 * and Save waits until it is fixed. Whole rupees (AGENTS.md §1).
 */
export function budgetProblem(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null; // blank = no budget
  const n = Number(s);
  if (!Number.isFinite(n)) return "Enter the budget in rupees, e.g. 5000.";
  if (n < 0) return "Budget cannot be below ₹0. Leave it blank for no budget.";
  if (!Number.isInteger(n)) return "Enter whole rupees, without paise.";
  return null;
}

/** The value to save — call only when budgetProblem() is null. */
export function budgetToSave(raw: string): number {
  const s = raw.trim();
  return s === "" ? 0 : Number(s);
}
