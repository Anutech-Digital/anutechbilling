/**
 * R-2587 (8 Nov 2026, Pardeep) — each part of a quote billed in parts, with what came in.
 *
 * Staging Q-A378-27-0021, billed quarterly: Part 1 ₹81,350 + GST = ₹95,993, received ₹95,933.
 * The page said "₹60 due now" beside a big "Record instalment payment" and never named Part 2's
 * date, so it read as if the customer owed money today. Pardeep: "pehli kist aa chuki hai …
 * doosri kist ki date bhi show honi chahiye".
 *
 * Display only — the parts come from quoteInstalmentPlan() (lib/billing/instalments.ts) and the
 * money is spread over them in order, exactly like splitDue() / paidToDateOfPlan(). Nothing here
 * books or settles anything: a small shortfall is still owed until someone records or settles it.
 */
import type { InstalmentLine, QuoteInstalmentPlan } from "@/lib/billing/instalments";

/** How small a shortfall reads as "received (₹X short)" instead of a part payment: up to 1% of
 *  the part (bank charges, TDS rounding), never less than ₹1. ₹60 on ₹95,993 is 0.06%. */
export const SMALL_SHORT_PCT = 1;

export function isSmallShort(short: number, gross: number): boolean {
  if (!(short > 0)) return false;
  return short <= Math.max(1, Math.floor((gross * SMALL_SHORT_PCT) / 100));
}

export type PartState =
  /** Received in full. */
  | "paid"
  /** Received less a small difference (isSmallShort). */
  | "short"
  /** Some money in, a real balance still due. */
  | "part"
  /** Nothing in, its date has come. */
  | "due"
  /** Nothing in, its date is still ahead. */
  | "upcoming";

export interface PartStatus extends InstalmentLine {
  state: PartState;
  /** ₹ of the money received that this part took. */
  received: number;
  /** ₹ still missing on this part (0 when paid, gross when nothing came in). */
  short: number;
}

export interface InstalmentStatus {
  parts: PartStatus[];
  count: number;
  /** Parts received — in full or with a small difference. */
  settled: number;
  /** The part received with a small difference, if any. */
  smallShort: { index: number; amount: number } | null;
  /** The first part not received yet. */
  next: PartStatus | null;
}

export function instalmentStatus(
  plan: QuoteInstalmentPlan,
  args: { received: number; todayISO: string },
): InstalmentStatus {
  const today = args.todayISO.slice(0, 10);
  let left = Math.max(0, Math.round(args.received || 0));
  const parts: PartStatus[] = plan.lines.map((l) => {
    const took = Math.min(left, l.gross);
    left -= took;
    const short = l.gross - took;
    const state: PartState = short === 0 ? "paid"
      : took > 0 ? (isSmallShort(short, l.gross) ? "short" : "part")
      : l.billOn <= today ? "due" : "upcoming";
    return { ...l, state, received: took, short };
  });
  const settledParts = parts.filter((p) => p.state === "paid" || p.state === "short");
  const shortPart = parts.find((p) => p.state === "short") ?? null;
  return {
    parts,
    count: parts.length,
    settled: settledParts.length,
    smallShort: shortPart ? { index: shortPart.index, amount: shortPart.short } : null,
    next: parts.find((p) => p.state !== "paid" && p.state !== "short") ?? null,
  };
}

const shortText = (s: InstalmentStatus, rupee: (n: number) => string) =>
  s.smallShort ? ` (${rupee(s.smallShort.amount)} short)` : "";

/** "Part 1 of 4 received (₹60 short) · next part ₹95,993 on 1 Feb 2027" — null while the first
 *  part is not received (the ordinary "Record payment" line says it). */
export function instalmentHeadline(
  s: InstalmentStatus,
  fmtDate: (iso: string) => string,
  rupee: (n: number) => string,
): string | null {
  if (s.settled === 0) return null;
  const head = s.settled >= s.count
    ? `All ${s.count} parts received${shortText(s, rupee)}`
    : `Part ${s.settled} of ${s.count} received${shortText(s, rupee)}`;
  return s.next ? `${head} · next part ${rupee(s.next.gross)} on ${fmtDate(s.next.billOn)}` : head;
}

/** The PAID step's line: "Part 1 of 4 paid (₹60 short) · next on 1 Feb 2027". */
export function paidStepText(
  s: InstalmentStatus,
  fmtDate: (iso: string) => string,
  rupee: (n: number) => string,
): string | null {
  if (s.settled === 0) return null;
  if (s.settled >= s.count) return `All ${s.count} parts paid${shortText(s, rupee)}`;
  return `Part ${s.settled} of ${s.count} paid${shortText(s, rupee)}${s.next ? ` · next on ${fmtDate(s.next.billOn)}` : ""}`;
}
