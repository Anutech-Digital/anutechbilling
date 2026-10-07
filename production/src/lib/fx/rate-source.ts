/**
 * R-045 slice 3 (7 Oct 2026) — where the ₹-per-foreign-unit rate comes from.
 *
 * GST (CGST Rule 34) wants a foreign-currency value converted at the RBI reference rate
 * (for imports, the rate CBIC notifies for Customs). Since 2018 the RBI reference rate is
 * computed and published by FBIL (Financial Benchmarks India Ltd). So the order is:
 *
 *   1. FBIL reference rate   — `kind: "reference"` — USD, GBP, EUR, AED (what FBIL publishes)
 *   2. open.er-api.com       — `kind: "indicative"` — any billed currency, NOT a GST rate
 *   3. frankfurter.app (ECB) — `kind: "indicative"` — majors only
 *
 * Nothing here is ever hard-coded: every number comes from a source response, carries its
 * own date (`asOf`) and source, and the owner can always overwrite it on the document
 * (then `source` = "manual"). An unreachable source is skipped, never guessed.
 *
 * Cache: a reference rate is kept for the rest of the IST day (FBIL publishes once a day);
 * an indicative one for an hour, so a morning FBIL outage does not pin an indicative rate
 * on every document for the whole day.
 */
import { istToday } from "@/lib/dates/ist";

export const FX_TO = "INR";

export type FxSourceId = "fbil" | "er-api" | "frankfurter" | "identity" | "manual";
export type FxKind = "reference" | "indicative" | "manual" | "identity";

export interface FxRate {
  /** ₹ per 1 unit of `from`, 4 dp. */
  rate:   number;
  from:   string;
  to:     typeof FX_TO;
  /** The date the source says the rate is for — YYYY-MM-DD, or null when it gave none. */
  asOf:   string | null;
  source: FxSourceId;
  kind:   FxKind;
  /** Human label, e.g. "FBIL reference rate (RBI)". */
  label:  string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const FBIL_URL = "https://www.fbil.org.in/wasdm/refrates/fetch?authenticated=false";
/** A published FBIL rate older than this is not used (falls through to the next source). */
const FBIL_MAX_AGE_DAYS = 14;
const TIMEOUT_MS = 6000;
const INDICATIVE_TTL_MS = 60 * 60 * 1000;

/** Long label — the builder's hint line and the API response. */
export function fxSourceLabel(source: string | null | undefined): string | null {
  switch (source) {
    case "fbil":        return "FBIL reference rate (RBI)";
    case "er-api":      return "Indicative market rate (open.er-api.com) — not the RBI reference rate";
    case "frankfurter": return "Indicative market rate (ECB, frankfurter.app) — not the RBI reference rate";
    case "manual":      return "Rate entered by you";
    case "identity":    return "Same currency";
    default:            return null;
  }
}

/** Short label printed on the PDF beside the rate: "(FBIL reference rate, 30 Sep 2026)". */
export function fxSourcePdfLabel(source: string | null | undefined): string | null {
  switch (source) {
    case "fbil":        return "FBIL/RBI reference rate";
    case "er-api":      return "indicative market rate";
    case "frankfurter": return "indicative market rate (ECB)";
    case "manual":      return "rate set by supplier";
    default:            return null;
  }
}

export function fxKindOf(source: string | null | undefined): FxKind | null {
  switch (source) {
    case "fbil":        return "reference";
    case "er-api":
    case "frankfurter": return "indicative";
    case "manual":      return "manual";
    case "identity":    return "identity";
    default:            return null;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** "2026-09-30 00:00:00" / "2026-09-30" / "Tue, 30 Sep 2026 00:02:31 +0000" → "2026-09-30". */
export function toIsoDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  if (m) return m[1];
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function make(rate: number, from: string, asOf: string | null, source: FxSourceId): FxRate {
  return { rate: round4(rate), from, to: FX_TO, asOf, source, kind: fxKindOf(source) ?? "indicative", label: fxSourceLabel(source) ?? source };
}

/**
 * FBIL `refrates/fetch` → the latest rate for `from`.
 * Rows look like {processRunDate:"2026-09-30 00:00:00", subProdName:"INR / 1 USD", rate:95.98}
 * — and "INR / 100 JPY", so the per-unit rate is rate ÷ the quoted units.
 */
export function parseFbilReferenceRates(json: unknown, from: string): { rate: number; asOf: string } | null {
  if (!Array.isArray(json)) return null;
  const cur = from.toUpperCase();
  let best: { rate: number; asOf: string } | null = null;
  for (const row of json as Array<Record<string, unknown>>) {
    const name = typeof row?.subProdName === "string" ? row.subProdName : "";
    const m = /^\s*INR\s*\/\s*(\d+)\s+([A-Z]{3})\s*$/i.exec(name);
    if (!m || m[2].toUpperCase() !== cur) continue;
    const units = Number(m[1]);
    const raw = typeof row.rate === "number" ? row.rate : Number(row.rate);
    const asOf = toIsoDate(row.processRunDate);
    if (!(units > 0) || !Number.isFinite(raw) || !(raw > 0) || !asOf) continue;
    if (!best || asOf > best.asOf) best = { rate: Math.round((raw / units) * 1e6) / 1e6, asOf };
  }
  return best;
}

export function parseErApi(json: unknown): { rate: number; asOf: string | null } | null {
  const d = json as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string } | null;
  const rate = d?.result === "success" ? d.rates?.[FX_TO] : undefined;
  if (typeof rate !== "number" || !(rate > 0)) return null;
  return { rate, asOf: toIsoDate(d?.time_last_update_utc) };
}

export function parseFrankfurter(json: unknown): { rate: number; asOf: string | null } | null {
  const d = json as { rates?: Record<string, number>; date?: string } | null;
  const rate = d?.rates?.[FX_TO];
  if (typeof rate !== "number" || !(rate > 0)) return null;
  return { rate, asOf: toIsoDate(d?.date) };
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown | null> {
  try {
    const res = await fetchImpl(url, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    } as RequestInit);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const cache = new Map<string, { value: FxRate; day: string; at: number }>();

/** Test hook. */
export function __resetFxCache(): void {
  cache.clear();
}

/**
 * The best available ₹ rate for 1 `from`, or null when every source failed.
 * Never throws; never invents a number.
 */
export async function fetchInrRate(
  fromRaw: string,
  opts: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<FxRate | null> {
  const from = fromRaw.toUpperCase().trim();
  const now = opts.now ?? new Date();
  const today = istToday(now);
  if (from === FX_TO) return make(1, from, today, "identity");

  const hit = cache.get(from);
  if (hit && hit.day === today && (hit.value.kind === "reference" || now.getTime() - hit.at < INDICATIVE_TTL_MS)) {
    return hit.value;
  }

  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  let value: FxRate | null = null;

  const fbil = parseFbilReferenceRates(await getJson(fetchImpl, FBIL_URL), from);
  if (fbil && daysBetween(fbil.asOf, today) <= FBIL_MAX_AGE_DAYS) {
    value = make(fbil.rate, from, fbil.asOf, "fbil");
  }
  if (!value) {
    const er = parseErApi(await getJson(fetchImpl, `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`));
    if (er) value = make(er.rate, from, er.asOf, "er-api");
  }
  if (!value) {
    const fr = parseFrankfurter(
      await getJson(fetchImpl, `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${FX_TO}`),
    );
    if (fr) value = make(fr.rate, from, fr.asOf, "frankfurter");
  }

  if (value) cache.set(from, { value, day: today, at: now.getTime() });
  return value;
}

/**
 * The line the invoice / quote PDF prints under the totals for a foreign-currency document:
 *   "₹ equivalent at 1 USD = ₹95.9832 (FBIL/RBI reference rate, 30 Sep 2026)"
 * GST is always computed and reported in ₹; this says which rate turned the foreign
 * figure into the ₹ one. Source/date missing (old documents) → just the rate.
 */
export function fxEquivalentLine(args: {
  currency: string;
  rate: number;
  source?: string | null;
  date?: string | null;
  rupeeSign?: string;
}): string {
  const sign = args.rupeeSign ?? "₹";
  const bits = [fxSourcePdfLabel(args.source), formatFxDate(args.date)].filter(Boolean);
  return `${sign} equivalent at 1 ${args.currency} = ${sign}${args.rate}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-30" → "30 Sep 2026"; anything else → null. */
export function formatFxDate(d: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? "");
  if (!m) return null;
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return null;
  return `${Number(m[3])} ${MONTHS[mi]} ${m[1]}`;
}

/** Provenance of the rate currently in a builder — what is saved as fx_source / fx_date. */
export interface FxStamp {
  source: string | null;
  asOf:   string | null;
  kind:   string | null;
  label:  string | null;
}

/** The owner typed the rate: source "manual", dated the day it was typed (IST). */
export function manualFxStamp(today: string): FxStamp {
  return { source: "manual", asOf: today, kind: "manual", label: fxSourceLabel("manual") };
}

/** A saved quote's stamp; an older quote (no fx_source) keeps source/date NULL — not invented. */
export function fxStampFromQuote(q: { fx_source?: string | null; fx_date?: string | null }): FxStamp {
  const source = q.fx_source ?? null;
  return { source, asOf: q.fx_date ?? null, kind: fxKindOf(source), label: fxSourceLabel(source) };
}
