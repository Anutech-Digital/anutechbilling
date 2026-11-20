/**
 * Compact, honest output for tool results.
 *
 * Money is whole rupees (AGENTS.md §1) and printed with the app's own rupee() (Indian grouping).
 * GST is always shown as its own figure: from the stored tax when the row has one, otherwise at
 * the row's rate (18% default for SaaS, CLAUDE.md §13), split CGST/SGST or IGST with
 * lib/gst/tax-split. A missing amount stays "unknown" — never a guessed 0 (AGENTS.md §2).
 * Dates are IST calendar dates (lib/dates/ist).
 */
import { can, maskContact, type UserRole } from "@/lib/auth/roles";
import { formatIstDate, formatIstTime, toIstDate } from "@/lib/dates/ist";
import { splitTaxHeads } from "@/lib/gst/tax-split";
import { rupee } from "@/lib/utils";
import { PAGE_DEFAULT, PAGE_MAX } from "@/lib/mcp/config";

export const DEFAULT_GST_RATE = 18;

export interface MoneyOut {
  ex_gst: string;
  gst: string;
  gst_rate: string;
  total: string;
  /** CGST + SGST, or IGST, when known. */
  gst_split?: string;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** ₹ text, or "unknown". */
export function inr(v: unknown): string {
  const n = num(v);
  return n === null ? "unknown" : rupee(n);
}

function splitText(tax: number, interState: boolean | null | undefined): string | undefined {
  if (interState === null || interState === undefined) return undefined;
  const h = splitTaxHeads(tax, interState);
  return interState ? `IGST ${rupee(h.igst, { decimals: 2 })}` : `CGST ${rupee(h.cgst, { decimals: 2 })} + SGST ${rupee(h.sgst, { decimals: 2 })}`;
}

/** An amount BEFORE GST: GST is added at `rate`. */
export function fromExGst(exGst: unknown, rate: unknown = DEFAULT_GST_RATE, interState?: boolean | null): MoneyOut {
  const base = num(exGst);
  const r = num(rate) ?? DEFAULT_GST_RATE;
  if (base === null) return { ex_gst: "unknown", gst: "unknown", gst_rate: `${r}%`, total: "unknown" };
  const tax = Math.round(base * r) / 100;
  return { ex_gst: rupee(base), gst: rupee(tax, { decimals: 2 }), gst_rate: `${r}%`, total: rupee(base + tax, { decimals: 2 }), gst_split: splitText(tax, interState) };
}

/** A document that stores its own taxable value, tax and total (an invoice). */
export function fromStored(taxable: unknown, tax: unknown, total: unknown, rate: unknown, interState?: boolean | null): MoneyOut {
  const t = num(taxable);
  const g = num(tax);
  const a = num(total);
  const r = num(rate);
  return {
    ex_gst: t === null ? "unknown" : rupee(t, { decimals: 2 }),
    gst: g === null ? "unknown" : rupee(g, { decimals: 2 }),
    gst_rate: r === null ? "unknown" : `${r}%`,
    total: a === null ? "unknown" : rupee(a, { decimals: 2 }),
    gst_split: g === null ? undefined : splitText(g, interState),
  };
}

/** "15 Nov 2026" in IST, or null. */
export function istDate(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  /* A bare YYYY-MM-DD is already a calendar date; do not shift it. */
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return formatIstDate(`${v}T12:00:00+05:30`);
  return Number.isNaN(Date.parse(v)) ? null : formatIstDate(v);
}

/** "15 Nov 2026, 10:30 IST", or null. */
export function istDateTime(v: unknown): string | null {
  if (typeof v !== "string" || !v || Number.isNaN(Date.parse(v))) return null;
  return `${formatIstDate(v)}, ${formatIstTime(v)} IST`;
}

export function istDay(v: unknown): string | null {
  if (typeof v !== "string" || !v || Number.isNaN(Date.parse(v))) return null;
  return toIstDate(v);
}

/** A phone / email the role may see, or the app's masked form (R-1009 rule). */
export function contact(role: UserRole, v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return can(role, "can_view_contact_details") ? v : maskContact(v);
}

export interface Paging { limit: number; offset: number }

export function paging(limit: number | undefined, offset: number | undefined): Paging {
  return {
    limit: Math.min(Math.max(1, Math.floor(limit ?? PAGE_DEFAULT)), PAGE_MAX),
    offset: Math.max(0, Math.floor(offset ?? 0)),
  };
}

export interface PageOut<T> {
  items: T[];
  count: number;
  offset: number;
  total: number | null;
  /** Pass as `offset` to get the next page; null when this is the last page. */
  next_offset: number | null;
}

export function pageOf<T>(items: T[], p: Paging, total: number | null | undefined): PageOut<T> {
  const t = total ?? null;
  const more = t !== null ? p.offset + items.length < t : items.length === p.limit;
  return { items, count: items.length, offset: p.offset, total: t, next_offset: more ? p.offset + items.length : null };
}

/** Text from the database is data, not instructions: trim and cap it. */
export function text(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function numOrNull(v: unknown): number | null {
  return num(v);
}
