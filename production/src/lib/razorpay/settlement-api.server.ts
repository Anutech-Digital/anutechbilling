/**
 * R-2099 — the two Razorpay reads a settlement reconcile needs. Read-only GETs; nothing here
 * writes to Razorpay.
 *
 *   GET /v1/settlements?from&to&count&skip            the settlements in a date window
 *   GET /v1/settlements/recon/combined?year&month&day  what each settlement of that day carried
 *                                                      (payments, refunds, adjustments, fee, tax)
 *
 * The recon report is by settlement DAY, so we read the settlement's IST day (and the days
 * either side when that day is empty — the report's day and created_at can straddle midnight)
 * and keep only the rows of this settlement.
 *
 * Errors come back as RazorpayApiError with an English message that says what to do next;
 * the key secret never appears in a message or a log line.
 */
import type { RzpReconItem, RzpSettlement } from "./settlement-match";

const BASE = "https://api.razorpay.com";

export class RazorpayApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RazorpayApiError";
  }
}

export interface RazorpayCreds {
  keyId: string;
  keySecret: string;
}

export type RazorpayGet = (path: string, params: Record<string, string | number>) => Promise<unknown>;

export function razorpayGetter(creds: RazorpayCreds, fetchImpl: typeof fetch = fetch): RazorpayGet {
  const auth = "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
  return async (path, params) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    let res: Response;
    try {
      res = await fetchImpl(`${BASE}${path}?${qs.toString()}`, {
        method: "GET",
        headers: { Authorization: auth, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new RazorpayApiError("Could not reach Razorpay — check the internet connection and try again.", 502);
    }
    if (res.status === 401) {
      throw new RazorpayApiError("Razorpay refused the API key. Check the key in Settings → Integrations → Razorpay (live key for live payments).", 401);
    }
    if (res.status === 429) {
      throw new RazorpayApiError("Razorpay is rate-limiting requests — wait a minute and try again.", 429);
    }
    if (!res.ok) {
      throw new RazorpayApiError(`Razorpay answered ${res.status} — try again in a little while.`, 502);
    }
    try {
      return await res.json();
    } catch {
      throw new RazorpayApiError("Razorpay sent a reply the app could not read — try again.", 502);
    }
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function itemsOf(body: unknown): Record<string, unknown>[] {
  const items = (body as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
}

export function toSettlement(o: Record<string, unknown>): RzpSettlement | null {
  const id = str(o.id);
  if (!id) return null;
  return { id, amount: num(o.amount), fees: num(o.fees), tax: num(o.tax), utr: str(o.utr), status: str(o.status) ?? undefined, created_at: num(o.created_at) };
}

export function toReconItem(o: Record<string, unknown>): RzpReconItem | null {
  const id = str(o.entity_id);
  const type = str(o.type);
  if (!id || !type) return null;
  return {
    entity_id: id,
    type,
    amount: num(o.amount),
    credit: num(o.credit),
    debit: num(o.debit),
    fee: num(o.fee),
    tax: num(o.tax),
    settlement_id: str(o.settlement_id),
    payment_id: str(o.payment_id),
    order_id: str(o.order_id),
    method: str(o.method),
    created_at: o.created_at == null ? null : num(o.created_at),
    description: str(o.description),
  };
}

const PAGE = 100;
const RECON_PAGE = 1000;
const MAX_PAGES = 20;

/** Every settlement created between `from` and `to` (unix seconds). */
export async function listSettlements(get: RazorpayGet, from: number, to: number): Promise<RzpSettlement[]> {
  const out: RzpSettlement[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await get("/v1/settlements", { from, to, count: PAGE, skip: page * PAGE });
    const rows = itemsOf(body);
    for (const r of rows) {
      const s = toSettlement(r);
      if (s) out.push(s);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** The recon rows of one day (IST calendar date parts). */
export async function reconForDay(get: RazorpayGet, y: number, m: number, d: number): Promise<RzpReconItem[]> {
  const out: RzpReconItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await get("/v1/settlements/recon/combined", { year: y, month: m, day: d, count: RECON_PAGE, skip: page * RECON_PAGE });
    const rows = itemsOf(body);
    for (const r of rows) {
      const it = toReconItem(r);
      if (it) out.push(it);
    }
    if (rows.length < RECON_PAGE) break;
  }
  return out;
}

/** IST {y, m, d} of a unix time. */
export function istDayParts(unix: number): { y: number; m: number; d: number } {
  const ist = new Date((unix + 5.5 * 3600) * 1000);
  return { y: ist.getUTCFullYear(), m: ist.getUTCMonth() + 1, d: ist.getUTCDate() };
}

/** What one settlement carried: its IST day first, then the day after and the day before. */
export async function settlementItems(get: RazorpayGet, s: RzpSettlement): Promise<RzpReconItem[]> {
  for (const shift of [0, 1, -1]) {
    const { y, m, d } = istDayParts(s.created_at + shift * 86_400);
    const rows = (await reconForDay(get, y, m, d)).filter((r) => r.settlement_id === s.id);
    if (rows.length) return rows;
  }
  return [];
}

/** Unix-second window to look for the settlement of a bank line dated `txnDate` (YYYY-MM-DD, IST). */
export function settlementWindow(txnDate: string): { from: number; to: number } {
  const midnightIst = Date.parse(`${txnDate}T00:00:00+05:30`) / 1000;
  return { from: midnightIst - 4 * 86_400, to: midnightIst + 2 * 86_400 - 1 };
}
