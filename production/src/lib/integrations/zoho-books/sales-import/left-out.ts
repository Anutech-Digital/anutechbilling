/**
 * R-2949 (G-RECON) — "Left out by you": the owner keeps some Zoho invoices out of the FY sales
 * import — one invoice (by its Zoho id) or every invoice whose number starts with a prefix (a closed
 * business line's series). The rules are kept per company on the server (left-out-store.ts) and the
 * plan (plan.ts) applies them, so preview, Check first and Import all skip the same invoices.
 *
 * A rule only stops an invoice that WOULD be imported: one that is already in the app stays there
 * (Remove import is the way to take a booked sale out), and one left out for another reason keeps
 * that reason. Pure: no I/O.
 */
import type { ZohoSaleFacts } from "./normalise";
import type { PlannedSale } from "./plan";

/** ids = Zoho invoice ids; prefixes = cleanPrefix() values (upper case, trimmed). */
export interface LeftOutRules { ids: readonly string[]; prefixes: readonly string[] }
export type LeftOutBy = { by: "invoice" } | { by: "prefix"; prefix: string };

export const PREFIX_MIN = 2;
export const PREFIX_MAX = 20;
export const PREFIX_MESSAGE = `Type ${PREFIX_MIN} to ${PREFIX_MAX} characters that the invoice numbers start with.`;

/** What the owner typed → the stored prefix (trimmed, upper case); null when it cannot be a rule.
 *  One character is refused: a slip of the finger would sweep most of the year out. */
export function cleanPrefix(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().toUpperCase();
  return p.length >= PREFIX_MIN && p.length <= PREFIX_MAX ? p : null;
}

/** Which rule keeps this invoice out (its own rule first), or null. */
export function leftOutBy(rules: LeftOutRules | undefined, f: Pick<ZohoSaleFacts, "zohoId" | "number">): LeftOutBy | null {
  if (!rules) return null;
  if (rules.ids.includes(f.zohoId)) return { by: "invoice" };
  const n = f.number.trim().toUpperCase();
  const prefix = rules.prefixes.find((p) => p.length >= PREFIX_MIN && n.startsWith(p));
  return prefix ? { by: "prefix", prefix } : null;
}

export function leftOutReason(by: LeftOutBy): string {
  return by.by === "invoice" ? "Left out by you." : `Left out by you — its number starts with "${by.prefix}".`;
}

/** One line of the dialog's "To import" list — only what the owner reads before importing. */
export interface ToImportRow {
  zohoId: string; number: string; date: string; customer: string;
  /** The sale's total, whole rupees. */
  amount: number;
  /** R-2702: TDS shown on the invoice (0 = none) and its section; Zoho's adjustment (0 = none). */
  tds: number; tdsSection: string | null; adjustment: number;
}

/** The most rows the preview sends: the dialog draws tens of lines, never a whole year. */
export const TO_IMPORT_LIST_MAX = 200;

export function toImportRows(rows: readonly PlannedSale[]): { rows: ToImportRow[]; more: number } {
  const all = rows.filter((r) => r.verdict === "import");
  return {
    rows: all.slice(0, TO_IMPORT_LIST_MAX).map(({ facts: f }) => ({
      zohoId: f.zohoId, number: f.number, date: f.date, customer: f.customerName, amount: f.amount,
      tds: f.tds ?? 0, tdsSection: f.tdsSection ?? null, adjustment: f.adjustment ?? 0,
    })),
    more: Math.max(0, all.length - TO_IMPORT_LIST_MAX),
  };
}

/** One invoice under "Left out by you" (date / customer / amount are null when it is no longer in the Zoho read). */
export interface LeftOutInvoice {
  zohoId: string; number: string; date: string | null; customer: string | null; amount: number | null;
  by: "invoice" | "prefix"; prefix?: string;
}
export interface LeftOutView {
  /** Every saved prefix, with what it keeps out right now. */
  prefixes: { prefix: string; count: number; amount: number }[];
  invoices: LeftOutInvoice[];
}

/** What the dialog shows under "Left out by you": every saved rule (so each can be taken back) and
 *  the invoices they keep out right now. */
export function leftOutView(rows: readonly PlannedSale[], saved: { docs: readonly { zohoId: string; number: string }[]; prefixes: readonly string[] }): LeftOutView {
  const prefixes = saved.prefixes.map((prefix) => ({ prefix, count: 0, amount: 0 }));
  const invoices: LeftOutInvoice[] = [];
  const shown = new Set<string>();
  for (const { facts: f, leftOut } of rows) {
    if (!leftOut) continue;
    if (leftOut.by === "prefix") {
      const p = prefixes.find((x) => x.prefix === leftOut.prefix);
      if (p) { p.count += 1; p.amount += f.amount; }
    } else shown.add(f.zohoId);
    if (invoices.length < TO_IMPORT_LIST_MAX) {
      invoices.push({ zohoId: f.zohoId, number: f.number, date: f.date, customer: f.customerName, amount: f.amount,
        by: leftOut.by, ...(leftOut.by === "prefix" ? { prefix: leftOut.prefix } : {}) });
    }
  }
  /* A saved invoice rule that stops nothing now (already in the app, void, gone from Zoho) is still
     listed, so it can be taken back. */
  for (const d of saved.docs) {
    if (!shown.has(d.zohoId) && invoices.length < TO_IMPORT_LIST_MAX * 2) {
      invoices.push({ zohoId: d.zohoId, number: d.number, date: null, customer: null, amount: null, by: "invoice" });
    }
  }
  return { prefixes, invoices };
}
