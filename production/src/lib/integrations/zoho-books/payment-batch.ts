/**
 * R-2360 — Banking "Zoho has a match": which UNMATCHED money-in lines of a bank account have a
 * customer payment in Zoho Books. READ-ONLY to Zoho, server-side only.
 *
 * One batch read, never one Zoho call per line: the Zoho customer payments dated inside the lines'
 * window (earliest line − 3 days … latest line + 3 days) are read page by page (200 each, at most
 * MAX_PAYMENT_PAGES), then every line is matched IN MEMORY with R-2359's own rules — its UTR in the
 * payment reference, else amount ±₹2 and date ±3 days (R-2658: an inward remittance — its foreign
 * amount ±1 unit and date ±10 days, payment-match.ts pickByAmount). The read is kept per company + window for
 * BATCH_CACHE_MS, so opening Banking again (or another account with the same window) does not ask
 * Zoho again (Zoho allows about 100 calls a minute per organization).
 *
 * A line counts when it has at least one candidate; which payment it is (one, or the owner picks
 * among several) is still settled by "Find in Zoho" on that line.
 */
import { listCustomerPaymentsPage } from "./api";
import { parseInwardRemittance } from "@/lib/banking/inward-remittance";
import {
  isLineMoney, lineWindowDays, paymentFromZoho, pickByAmount, referenceHasUtr, utrCandidates,
  type BankCreditLine, type MatchBy, type RivalLine, type WindowLine, type ZohoPaymentRow, type ZohoReadDeps,
} from "./payment-match";

/** Pages of 200 read at most per batch (2,000 payments). */
export const MAX_PAYMENT_PAGES = 10;
/** How long one batch read is reused. */
export const BATCH_CACHE_MS = 30 * 60_000;
/** Batch reads kept in memory at most (oldest dropped first). */
export const BATCH_CACHE_MAX = 50;

export interface BatchLine extends BankCreditLine { id: string }

export interface ZohoPaymentsRead {
  payments: ZohoPaymentRow[];
  /** false = there were more than MAX_PAYMENT_PAGES pages; the newest were read. */
  complete: boolean;
}

export interface ZohoMatchCount {
  txnIds: string[];
  /** Unmatched money-in lines looked at. */
  lines: number;
  /** Zoho payments read for the window. */
  payments: number;
  complete: boolean;
  from: string | null;
  to: string | null;
  /** When Zoho was read (ISO) — a cached read keeps its own time. */
  readAt: string | null;
}

const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
function addDays(iso: string, days: number): string {
  const d = new Date(day(iso));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Zoho date window that covers every line — ± 3 days round a ₹ line, R-2658: ± 10 round an
 *  inward remittance (lineWindowDays); null when there are none. */
export function paymentWindow(lines: readonly WindowLine[]): { from: string; to: string } | null {
  let from: string | null = null, to: string | null = null;
  for (const l of lines) {
    const d = String(l.txnDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const days = lineWindowDays(l);
    const a = addDays(d, -days), b = addDays(d, days);
    if (from === null || a < from) from = a;
    if (to === null || b > to) to = b;
  }
  return from && to ? { from, to } : null;
}

/** Does this line have at least one Zoho payment candidate (R-2359's rules)? */
export function lineHasZohoMatch(line: BankCreditLine, payments: readonly ZohoPaymentRow[]): boolean {
  for (const utr of utrCandidates(line)) {
    if (payments.some((p) => referenceHasUtr(p.reference, utr))) return true;
  }
  return pickByAmount(line, payments).kind !== "none";
}

/** The ids of the lines that have a Zoho match — pure, no I/O. */
export function linesWithZohoMatch(lines: readonly BatchLine[], payments: readonly ZohoPaymentRow[]): string[] {
  return lines.filter((l) => l.credit > 0 && lineHasZohoMatch(l, payments)).map((l) => l.id);
}

/**
 * R-2402: WHICH Zoho payment a line is, from an already-read list — R-2359's order (its UTR in the
 * reference, the same amount winning among several; else amount ±₹2 within ±3 days, nearest first).
 * R-2658: an inward remittance is also paired by its foreign amount within ±10 days (pickByAmount);
 * `rivals` = the company's other remittance lines and `complete` = the list was not cut short — a
 * pair with a rival or from a short list carries `notSure`.
 * Pure; the bulk reconcile reads the window once instead of searching Zoho line by line.
 */
export function findInPaymentList(line: RivalLine, payments: readonly ZohoPaymentRow[], rivals: readonly RivalLine[] = [], complete = true):
  | { kind: "one"; by: MatchBy; payment: ZohoPaymentRow; notSure?: string }
  | { kind: "several"; by: MatchBy; candidates: ZohoPaymentRow[] }
  | { kind: "none" } {
  /* R-2425: an inward remittance is matched by its foreign amount (isLineMoney). */
  const rem = parseInwardRemittance(line.description);
  for (const utr of utrCandidates(line)) {
    const hits = payments.filter((p) => referenceHasUtr(p.reference, utr));
    if (hits.length === 0) continue;
    if (hits.length === 1) return { kind: "one", by: "utr", payment: hits[0] };
    const same = hits.filter((p) => isLineMoney(p, line, rem));
    if (same.length === 1) return { kind: "one", by: "utr", payment: same[0] };
    return { kind: "several", by: "utr", candidates: (same.length ? same : hits).slice(0, 10) };
  }
  return pickByAmount(line, payments, rivals, complete);
}

/** Every Zoho customer payment dated inside the window, page by page (stops at MAX_PAYMENT_PAGES). */
export async function readZohoPaymentsInWindow(from: string, to: string, deps: ZohoReadDeps): Promise<ZohoPaymentsRead> {
  const f = deps.fetch ?? fetch;
  const payments: ZohoPaymentRow[] = [];
  for (let page = 1; page <= MAX_PAYMENT_PAGES; page++) {
    const res = await listCustomerPaymentsPage(deps.orgId, deps.token, { dateStart: from, dateEnd: to, page }, f);
    for (const row of res.rows) {
      const p = paymentFromZoho(row);
      if (p) payments.push(p);
    }
    if (!res.more) return { payments, complete: true };
  }
  return { payments, complete: false };
}

// ── The cache (per server instance) ────────────────────────────────────────────────────────

type Entry = ZohoPaymentsRead & { at: number };
const cache = new Map<string, Entry>();

export const batchCacheKey = (tenantId: string, orgId: string, from: string, to: string) => `${tenantId}|${orgId}|${from}|${to}`;

/** Test hook. */
export function clearZohoBatchCache(): void { cache.clear(); }

/**
 * The payments of the window — from the cache when a read of the SAME company, organization and
 * window is younger than BATCH_CACHE_MS, else from Zoho (and kept).
 */
export async function cachedZohoPayments(
  tenantId: string, from: string, to: string, deps: ZohoReadDeps, now: () => number = Date.now,
): Promise<ZohoPaymentsRead & { readAt: string }> {
  const key = batchCacheKey(tenantId, deps.orgId, from, to);
  const hit = cache.get(key);
  if (hit && now() - hit.at < BATCH_CACHE_MS) {
    return { payments: hit.payments, complete: hit.complete, readAt: new Date(hit.at).toISOString() };
  }
  const read = await readZohoPaymentsInWindow(from, to, deps);
  const at = now();
  cache.delete(key);
  cache.set(key, { ...read, at });
  while (cache.size > BATCH_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return { ...read, readAt: new Date(at).toISOString() };
}

/** The whole batch: window → (cached) Zoho payments → the lines that match. */
export async function countZohoMatches(
  tenantId: string, lines: readonly BatchLine[], deps: ZohoReadDeps, now: () => number = Date.now,
): Promise<ZohoMatchCount> {
  const credits = lines.filter((l) => l.credit > 0);
  const win = paymentWindow(credits);
  if (!win) return { txnIds: [], lines: 0, payments: 0, complete: true, from: null, to: null, readAt: null };
  const read = await cachedZohoPayments(tenantId, win.from, win.to, deps, now);
  return {
    txnIds: linesWithZohoMatch(credits, read.payments),
    lines: credits.length,
    payments: read.payments.length,
    complete: read.complete,
    from: win.from,
    to: win.to,
    readAt: read.readAt,
  };
}
