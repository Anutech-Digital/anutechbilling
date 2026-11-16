/**
 * R-2654 — Razorpay settlements, a whole month at once (pure: no I/O).
 *
 * R-2099 reconciles ONE Razorpay settlement bank line at a time (fetch, check, Reconcile — 3-4 min a
 * line; 138 lines open on 10 Nov). The month batch reads the month's settlements from Razorpay ONCE
 * and pairs every open Razorpay line of the account with its settlement here:
 *
 *   1. by UTR — the settlement's UTR appears in the line's narration / reference;
 *   2. else by amount — the only settlement of the same whole rupees in the line's window (4 days
 *      before to 1 day after, as R-2099's settlementWindow) that no other line claimed by UTR.
 *
 * Fail closed: two settlements for one line, or one settlement wanted by two lines, pairs NOTHING —
 * both lines say why and are reconciled one by one (where the owner picks). A settlement already
 * reconciled to another line is never offered again. Each paired line then gets R-2099's own plan
 * (buildSettlementPlan) — the batch adds no booking rule of its own.
 */
import { rupee } from "@/lib/utils";
import { paiseToRupees, sameRupees, type BankLine, type RzpSettlement } from "./settlement-match";

export interface BatchPairing {
  line: BankLine;
  settlement: RzpSettlement | null;
  by: "utr" | "amount" | null;
  /** why it is not paired (plain English with the next step) — null when paired */
  problem: string | null;
}

const DAY = 86_400;
const rs = (n: number) => rupee(n, { decimals: Number.isInteger(n) ? 0 : 2 });

/** IST midnight (unix seconds) of a YYYY-MM-DD day. */
const istMidnight = (day: string): number => Date.parse(`${day}T00:00:00+05:30`) / 1000;

/** Could this settlement be the money of a line dated `day`? Created 4 days before to 1 day after. */
export function inLineWindow(day: string, s: RzpSettlement): boolean {
  const m = istMidnight(day);
  return s.created_at >= m - 4 * DAY && s.created_at <= m + 2 * DAY - 1;
}

const haystack = (l: BankLine): string => `${l.reference ?? ""} ${l.description ?? ""}`.toUpperCase().replace(/\s+/g, "");
const utrIn = (l: BankLine, s: RzpSettlement): boolean =>
  Boolean(s.utr && s.utr.trim().length >= 6 && haystack(l).includes(s.utr.trim().toUpperCase().replace(/\s+/g, "")));

const lineText = (l: BankLine) => `${l.txn_date} (${rs(Number(l.credit) || 0)})`;

/**
 * Pair the month's open Razorpay lines with the month's settlements.
 * `alreadyReconciled` = settlement ids the company already reconciled to some line.
 */
export function pairMonth(lines: BankLine[], settlements: RzpSettlement[], alreadyReconciled: ReadonlySet<string> = new Set()): BatchPairing[] {
  /* 1. UTR — a settlement whose UTR is in a line belongs to that line (and is not offered to others by amount). */
  const utrOf = new Map<string, RzpSettlement[]>();
  const utrClaimed = new Set<string>();
  for (const l of lines) {
    const hits = settlements.filter((s) => utrIn(l, s));
    utrOf.set(l.id, hits);
    for (const s of hits) utrClaimed.add(s.id);
  }

  const tentative = new Map<string, { s: RzpSettlement; by: "utr" | "amount" } | { problem: string }>();
  for (const l of lines) {
    const hits = utrOf.get(l.id) ?? [];
    if (hits.length > 1) {
      tentative.set(l.id, { problem: `This line's narration matches ${hits.length} Razorpay settlements (${hits.map((s) => s.id).join(", ")}). Open the line and reconcile it from Reconcile → Razorpay settlement.` });
      continue;
    }
    if (hits.length === 1) {
      tentative.set(l.id, { s: hits[0], by: "utr" });
      continue;
    }
    const byAmount = settlements.filter((s) => !utrClaimed.has(s.id) && !alreadyReconciled.has(s.id) && inLineWindow(l.txn_date, s) && sameRupees(s.amount, l.credit));
    if (byAmount.length === 1) tentative.set(l.id, { s: byAmount[0], by: "amount" });
    else if (byAmount.length > 1) {
      tentative.set(l.id, { problem: `${byAmount.length} Razorpay settlements of ${rs(Number(l.credit) || 0)} came around ${l.txn_date} (${byAmount.map((s) => s.id).join(", ")}) and this line has no UTR to tell them apart. Open the line and pick the settlement.` });
    } else {
      tentative.set(l.id, { problem: `No Razorpay settlement of ${rs(Number(l.credit) || 0)} between 4 days before and 1 day after ${l.txn_date}. Check that Settings → Integrations has the key of the Razorpay account that paid this line.` });
    }
  }

  /* 2. One settlement wanted by two lines → neither (fail closed). */
  const wanted = new Map<string, BankLine[]>();
  for (const l of lines) {
    const t = tentative.get(l.id);
    if (t && "s" in t) wanted.set(t.s.id, [...(wanted.get(t.s.id) ?? []), l]);
  }

  return lines.map((line) => {
    const t = tentative.get(line.id);
    if (!t || "problem" in t) return { line, settlement: null, by: null, problem: t && "problem" in t ? t.problem : "Not checked." };
    const rivals = (wanted.get(t.s.id) ?? []).filter((x) => x.id !== line.id);
    if (rivals.length) {
      return {
        line, settlement: null, by: null,
        problem: `Razorpay settlement ${t.s.id} (${rs(paiseToRupees(t.s.amount))}) could be this line or ${rivals.map(lineText).join(", ")}. Open the line and reconcile it one by one.`,
      };
    }
    if (alreadyReconciled.has(t.s.id)) {
      return { line, settlement: null, by: null, problem: `Razorpay settlement ${t.s.id} is already reconciled to another bank line. Un-reconcile that line first if it was matched wrongly.` };
    }
    return { line, settlement: t.s, by: t.by, problem: null };
  });
}

/** The unix-second window to list settlements for a month's lines (YYYY-MM): 4 days before its first day to 1 day after its last. */
export function monthWindow(month: string): { from: number; to: number; first: string; last: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${month}-01`;
  const lastDay = `${month}-${String(last).padStart(2, "0")}`;
  return { from: istMidnight(first) - 4 * DAY, to: istMidnight(lastDay) + 2 * DAY - 1, first, last: lastDay };
}

export const MONTH_RE = /^(20\d\d)-(0[1-9]|1[0-2])$/;

/** One row of the ready / blocked table. Rupees. */
export interface BatchRow {
  txnId: string;
  txnDate: string;
  amount: number;
  narration: string;
  settlementId: string | null;
  utr: string | null;
  pairedBy: "utr" | "amount" | null;
  ready: boolean;
  /** why not ready — R-2099's own blockers, or the pairing problem */
  blockers: string[];
  payments: number;
  gross: number;
  fee: number;
  feeGst: number;
}

export interface MonthBatch {
  month: string;
  rows: BatchRow[];
  ready: number;
  blocked: number;
  readyAmount: number;
}

export type MonthBatchLookup =
  | { state: "no_keys"; message: string }
  | { state: "error"; message: string }
  | { state: "batch"; batch: MonthBatch };

export function summarise(month: string, rows: BatchRow[]): MonthBatch {
  const ready = rows.filter((r) => r.ready);
  return { month, rows, ready: ready.length, blocked: rows.length - ready.length, readyAmount: ready.reduce((s, r) => s + r.amount, 0) };
}
