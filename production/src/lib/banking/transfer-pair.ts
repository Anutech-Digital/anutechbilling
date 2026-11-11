/**
 * R-2656 (10 Nov 2026, G-RECON N3) — "Find transfer & reversal pairs": the words and the sums of the
 * preview. The pairing itself is on the server (bank_pair_candidates, migration
 * 20261111155249_r2656_bank_pair_detector.sql): two OPEN lines, same amount, opposite sides, at most
 * 3 days apart —
 *   'transfer' = two of the company's own accounts (FD / sweep / OD / card), with a transfer word, an
 *                FD / OD / credit-card account or the same bank reference;
 *   'reversal' = the same account, with a reversal word (REV / RET / UPIRET / I/W CHQ RET …) or the
 *                same bank reference.
 * Only 'sure' pairs (one possible partner on each side) are ever booked, and book_bank_pairs checks
 * that again on the server — this file never decides what is sure, it only counts and words it.
 */

export type PairKind = "transfer" | "reversal";
export type PairStatus = "sure" | "check" | "ambiguous" | "locked" | "other_side_booked";

export interface PairRow {
  kind: PairKind;
  status: PairStatus;
  reason: string;
  amount: number;
  out_txn_id: string;
  out_account_id: string;
  out_account: string;
  out_date: string;
  out_description: string | null;
  in_txn_id: string;
  in_account_id: string;
  in_account: string;
  in_date: string;
  in_description: string | null;
}

export const PAIR_KIND_LABEL: Record<PairKind, string> = {
  transfer: "Own transfer",
  reversal: "Reversal",
};

export const PAIR_STATUS_LABEL: Record<PairStatus, string> = {
  sure: "Ready to book",
  check: "Check by hand",
  ambiguous: "More than one match",
  locked: "Books locked",
  other_side_booked: "Other side already booked",
};

export interface PairSummary {
  sure: number;
  sureAmount: number;
  check: number;
  ambiguous: number;
  otherSideBooked: number;
  locked: number;
}

export function pairSummary(rows: readonly PairRow[]): PairSummary {
  const s: PairSummary = { sure: 0, sureAmount: 0, check: 0, ambiguous: 0, otherSideBooked: 0, locked: 0 };
  for (const r of rows) {
    if (r.status === "sure") { s.sure += 1; s.sureAmount += r.amount; }
    else if (r.status === "check") s.check += 1;
    else if (r.status === "ambiguous") s.ambiguous += 1;
    else if (r.status === "other_side_booked") s.otherSideBooked += 1;
    else s.locked += 1;
  }
  return s;
}

export interface PairToBook { out_txn_id: string; in_txn_id: string }

/**
 * What "Book" sends: the sure pairs, each line once. The server books only what IT finds sure at
 * that moment, so a line booked by hand since the preview is skipped there, not here.
 */
export function pairsToBook(rows: readonly PairRow[]): PairToBook[] {
  const seen = new Set<string>();
  const out: PairToBook[] = [];
  for (const r of rows) {
    if (r.status !== "sure" || seen.has(r.out_txn_id) || seen.has(r.in_txn_id)) continue;
    seen.add(r.out_txn_id);
    seen.add(r.in_txn_id);
    out.push({ out_txn_id: r.out_txn_id, in_txn_id: r.in_txn_id });
  }
  return out;
}

export interface BookPairsResult {
  run_id: string | null;
  booked: number;
  skipped: { out_txn_id: string | null; in_txn_id: string | null; reason: string }[];
}

export interface UndoPairsResult {
  run_id: string;
  undone: number;
  left: { out_txn_id: string; in_txn_id: string; txn_date: string; amount: number; reason: string }[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The result line after Book — what was booked and why the rest were not. */
export function bookResultText(r: BookPairsResult): { title: string; detail: string | null; tone: "success" | "warning" } {
  const skipped = r.skipped.length;
  if (r.booked === 0) {
    return {
      title: "Nothing was booked",
      detail: skipped ? `${plural(skipped, "pair")} not booked — ${r.skipped[0].reason}` : null,
      tone: "warning",
    };
  }
  return {
    title: `${plural(r.booked, "pair")} booked (${plural(r.booked * 2, "line")} reconciled)`,
    detail: skipped ? `${plural(skipped, "pair")} not booked — ${r.skipped[0].reason}` : null,
    tone: skipped ? "warning" : "success",
  };
}

export function undoResultText(r: UndoPairsResult): { title: string; detail: string | null; tone: "success" | "warning" } {
  const left = r.left.length;
  return {
    title: r.undone === 0 ? (left === 0 ? "Nothing left to undo" : "Nothing was undone") : `${plural(r.undone, "pair")} undone — the lines are open again`,
    detail: left ? `${plural(left, "pair")} left as ${left === 1 ? "it is" : "they are"} — ${r.left[0].reason}` : null,
    tone: left ? "warning" : "success",
  };
}
