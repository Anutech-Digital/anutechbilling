/**
 * R-1767 (Pardeep, 22 Oct 2026) — is this bill addressed to US?
 *
 * A Net2secure PROFORMA "Bill To" Beta Technologies was read and saved in Acme Digital's
 * Expenses with no warning. The reader only read the SELLER, so the app could not know the bill
 * belonged to another company — and another company's bill in our books means a wrong P&L and
 * a wrong GST input credit.
 *
 * Rule:
 *   - nothing read about the buyer → no warning (a false alarm is worse than silence);
 *   - buyer GSTIN valid AND ours valid → mismatch only when they differ;
 *   - otherwise compare names after normalising (case, punctuation, "M/s", Pvt Ltd / Private
 *     Limited / LLP …) against our name, legal name and trade name; one containing the other
 *     counts as the same company. Only a CLEARLY different name warns.
 *
 * Pure and dependency-free: the extract-bill route computes it once (server has the tenant), and
 * both dialogs (Add expense, Add COGS Bill) read the route's answer — one rule, one place.
 */
import { isGstin } from "@/lib/gst/itc";

export interface BuyerRead {
  buyer_name?: string | null;
  buyer_gstin?: string | null;
}

export interface OwnCompany {
  name: string | null | undefined;
  gstin: string | null | undefined;
  legal_name?: string | null;
  trade_name?: string | null;
}

export interface BuyerMismatch {
  buyer_name: string;
  buyer_gstin: string | null;
  own_name: string;
}

const SUFFIXES = [
  "PRIVATE LIMITED", "PVT LIMITED", "PRIVATE LTD", "PVT LTD", "LIMITED", "LTD", "LLP",
  "OPC", "INCORPORATED", "INC", "CORPORATION", "CORP", "COMPANY", "CO",
];

/** "M/s. Acme Digital Pvt. Ltd." → "ACME DIGITAL". */
export function normaliseCompanyName(v: string | null | undefined): string {
  let t = (v ?? "").toUpperCase().replace(/\bM\s*\/\s*S\b\.?/g, " ").replace(/[^A-Z0-9 ]+/g, " ");
  t = t.replace(/\s+/g, " ").trim().replace(/^THE /, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of SUFFIXES) {
      if (t === s) continue;
      if (t.endsWith(" " + s)) { t = t.slice(0, -(s.length + 1)).trim(); changed = true; }
    }
  }
  return t;
}

const sameName = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

export function billBuyerMismatch(read: BuyerRead, own: OwnCompany): BuyerMismatch | null {
  const buyerName = (read.buyer_name ?? "").toString().trim();
  const rawGstin = (read.buyer_gstin ?? "").toString().trim().toUpperCase();
  const buyerGstin = isGstin(rawGstin) ? rawGstin : null;
  if (!buyerName && !buyerGstin) return null;

  const ownGstin = (own.gstin ?? "").trim().toUpperCase();
  const ownName = (own.name ?? "").trim() || (own.legal_name ?? "").trim() || (own.trade_name ?? "").trim();
  if (!ownName) return null;
  const mismatch = (): BuyerMismatch => ({ buyer_name: buyerName || buyerGstin!, buyer_gstin: buyerGstin, own_name: ownName });

  if (buyerGstin && isGstin(ownGstin)) return buyerGstin === ownGstin ? null : mismatch();

  if (!buyerName) return null;
  const b = normaliseCompanyName(buyerName);
  if (!b) return null;
  const ours = [own.name, own.legal_name, own.trade_name].map(normaliseCompanyName).filter(Boolean);
  if (ours.length === 0) return null;
  return ours.some((o) => sameName(b, o)) ? null : mismatch();
}

/** The route's `buyer_mismatch` as the dialogs receive it (JSON) — anything else is "no warning". */
export function isBuyerMismatch(v: unknown): v is BuyerMismatch {
  const o = v as Partial<BuyerMismatch> | null;
  return !!o && typeof o === "object" && typeof o.buyer_name === "string" && !!o.buyer_name
    && typeof o.own_name === "string" && !!o.own_name;
}

/** The red line both dialogs show on the AI preview. */
export function buyerWarningText(m: BuyerMismatch): string {
  const g = m.buyer_gstin ? ` (GSTIN ${m.buyer_gstin})` : "";
  return `This bill is addressed to ${m.buyer_name}${g}, not ${m.own_name}. Add it here only if ${m.own_name} really paid it.`;
}

/** Written into the saved record's notes after the operator confirms — the audit trail. */
export function buyerConfirmedNote(m: BuyerMismatch): string {
  const g = m.buyer_gstin ? ` (GSTIN ${m.buyer_gstin})` : "";
  return `Bill addressed to ${m.buyer_name}${g}, not ${m.own_name} — saved after the user confirmed ${m.own_name} paid it.`;
}

/**
 * R-1767 addition (Pardeep, 22 Oct localhost): a bill for a product WE RESELL uploaded in Add
 * expense belongs in COGS bills. Decided from the reader's own category (category_guess), not
 * keywords. COGS-Other is NOT enough — the reader gives it to any non-resale bill too.
 */
const RESALE: Readonly<Record<string, string>> = {
  "COGS-Workspace": "Google Workspace",
  "COGS-M365":      "Microsoft 365",
  "COGS-Zoho":      "Zoho",
};
export function resaleProduct(f: { category_guess?: string | null }): string | null {
  return RESALE[(f.category_guess ?? "").toString().trim()] ?? null;
}
