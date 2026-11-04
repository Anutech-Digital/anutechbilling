/**
 * R-2428 — set a salary record's loss of pay so its net is what was really paid.
 * The same arithmetic as pay_salary / adjust_salary_lop (whole rupees):
 *   earned = max(gross − LOP, 0) + incentive
 *   net    = earned − advance recovered − TDS − PF − ESI − other deductions
 */
export type LopRecord = {
  gross: number; incentive: number; advance_recovered: number;
  tds: number; pf: number; esi: number; other_deduction: number;
  paid_amount: number;
};

const deductions = (p: LopRecord) => p.advance_recovered + p.tds + p.pf + p.esi + p.other_deduction;

export function netAfterLop(p: LopRecord, lopAmount: number): number {
  return Math.max(p.gross - Math.max(0, Math.round(lopAmount)), 0) + p.incentive - deductions(p);
}

/** The LOP that makes the net equal `targetNet` (e.g. the amount the bank paid). Null when no LOP can. */
export function lopForNet(p: LopRecord, targetNet: number): number | null {
  const lop = p.gross + p.incentive - deductions(p) - Math.round(targetNet);
  if (lop < 0 || lop > p.gross) return null;
  return lop;
}

/** Why this LOP cannot be saved (the RPC refuses the same), or null. */
export function lopProblem(p: LopRecord, lopAmount: number, reason: string): string | null {
  if (!Number.isFinite(lopAmount) || lopAmount < 0) return "Loss of pay cannot be below ₹0.";
  if (lopAmount > p.gross) return `Loss of pay cannot be more than the gross salary (₹${p.gross}).`;
  const net = netAfterLop(p, lopAmount);
  if (net < 0) return "Deductions would be more than the earned pay.";
  if (net < p.paid_amount) return `The bank has already paid ₹${p.paid_amount} — the net cannot go below that.`;
  if (reason.trim().length < 3) return "Say why the salary is changed.";
  return null;
}
