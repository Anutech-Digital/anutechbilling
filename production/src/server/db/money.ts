/**
 * Money crosses into Postgres in WHOLE RUPEES (AGENTS.md, CLAUDE.md §13) — never paise,
 * never a fraction. JavaScript numbers do not enforce that, so every amount handed to a
 * money function goes through rupees() first and a bad value stops here, before a payment
 * row is written.
 */
export function rupees(value: unknown, field = "amount"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number of rupees`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be whole rupees — got ${value} (paise or a fraction)`);
  }
  // record_payment takes integer (int4). Above this a value would overflow, not round.
  if (Math.abs(value) > 2_147_483_647) {
    throw new Error(`${field} is out of range for a rupee amount`);
  }
  return value;
}
