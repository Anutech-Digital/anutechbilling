import { resolveStateCode } from "./gstin-state";
import { GST_STATE_BY_CODE } from "@/lib/utils";

/**
 * Place-of-supply → GST head (CGST+SGST vs IGST)
 *
 * Single source of truth for deciding whether a supply is intra-state
 * (CGST + SGST split) or inter-state (IGST). Previously this was computed
 * inconsistently across the codebase — correctly in the quote detail page,
 * but hardcoded (`false`, or seller="27") in the quote builder, the quote-send
 * PDF route, and the tax-invoice dialog. That produced the WRONG GST head on
 * tax invoices for inter-state customers (a compliance defect: the total 18%
 * was right, but the head was wrong, which breaks the buyer's ITC). Fixes
 * audit bugs #18/#19/#20.
 *
 * GST rule (IGST Act §7, CGST Act §8): the head is determined by comparing the
 * **place of supply** (the buyer's state) with the **location of the supplier**
 * (the seller's state). Same state → intra-state → CGST + SGST. Different state
 * → inter-state → IGST. The first two digits of a GSTIN are the state code
 * (e.g. 07 = Delhi, 27 = Maharashtra), which is why we compare `state_code`.
 *
 * Conservative default: if EITHER state code is missing we return `false`
 * (intra-state, CGST + SGST). This is the safe default for a same-state sale,
 * but it can be wrong for an inter-state customer when the seller's own
 * `state_code` hasn't been set up yet. Callers should ensure the tenant's GST
 * profile (state_code) is configured — see /setup — so the comparison is real.
 *
 * GSTIN FALLBACK (third argument). A party who gave you their GSTIN already told
 * you their state — it is the first two characters. In production 36 of 41
 * customers holding a GSTIN have no state_code, and every one of them was being
 * taxed as intra-state on that basis alone. Pass the GSTINs and a missing state
 * code is filled in from them.
 *
 * Only a checksum-valid GSTIN is used (see stateCodeFromGstin), so a typo or a
 * seeded dummy cannot start deciding tax heads, and an explicitly entered state
 * code always wins over a derived one. When neither source knows, the
 * conservative default above stands unchanged.
 */
export function isInterStateSupply(
  customerStateCode: string | null | undefined,
  sellerStateCode: string | null | undefined,
  gstins?: { customerGstin?: string | null; sellerGstin?: string | null },
): boolean {
  const buyer  = resolveStateCode({ stateCode: customerStateCode, gstin: gstins?.customerGstin });
  const seller = resolveStateCode({ stateCode: sellerStateCode,   gstin: gstins?.sellerGstin });
  // Compare numerically so "7" and "07" are one state — an entered code is
  // hand-typed and often unpadded, while a GSTIN-derived one always is padded.
  return Boolean(buyer && seller && Number(buyer) !== Number(seller));
}

/**
 * GST treatment of a supply, incl. exports (international customers).
 *
 * A supply to a recipient OUTSIDE India is an EXPORT — zero-rated (no
 * CGST/SGST/IGST) when the supplier has filed an LUT. A domestic supply is
 * intra-state (CGST + SGST) or inter-state (IGST) per the state comparison.
 */
export type GstTreatment = "export" | "inter_state" | "intra_state";

// Values that mean "India" (domestic). Anything else is treated as export.
const DOMESTIC_COUNTRIES = new Set(["india", "in", "ind", "bharat"]);

/**
 * True when the recipient is outside India → the supply is an export
 * (zero-rated under LUT). Conservative: an UNKNOWN/empty country is treated as
 * domestic (returns false), so we never accidentally zero-rate — and thus
 * under-charge GST on — a customer whose country simply wasn't captured.
 */
export function isExportSupply(customerCountry: string | null | undefined): boolean {
  const c = (customerCountry ?? "").trim().toLowerCase();
  if (c === "") return false;
  return !DOMESTIC_COUNTRIES.has(c);
}

/** Resolve the GST treatment. Export (outside India) wins over the state comparison. */
export function gstTreatment(
  customerCountry: string | null | undefined,
  customerStateCode: string | null | undefined,
  sellerStateCode: string | null | undefined,
): GstTreatment {
  if (isExportSupply(customerCountry)) return "export";
  return isInterStateSupply(customerStateCode, sellerStateCode) ? "inter_state" : "intra_state";
}

/**
 * The place-of-supply line printed on an invoice — CGST Rule 46(n) wants the STATE NAME
 * AND CODE for an inter-state supply. R-043 (1 Oct 2026): it used to print only
 * "Inter-state (IGST)". `posCode` is the code frozen on the invoice at issue; with none
 * (a legacy row whose state never agreed with its tax head) the old wording stays rather
 * than a guessed state.
 *
 * @example placeOfSupplyLabel({ posCode: "29", interState: true }) // "Karnataka (29) · IGST"
 */
export function placeOfSupplyLabel(a: {
  posCode?: string | null;
  interState: boolean;
  isExport?: boolean;
  country?: string | null;
}): string {
  if (a.isExport || a.posCode === "96") return `Export · ${a.country?.trim() || "outside India"} (96)`;
  const code = (a.posCode ?? "").trim();
  const name = code ? GST_STATE_BY_CODE[code] : undefined;
  const head = a.interState ? "IGST" : "CGST + SGST";
  if (name) return `${name} (${code}) · ${head}`;
  return a.interState ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)";
}

/** A buyer's GST facts as the GST return needs them. */
export interface PartyFacts { gstin: string | null; stateCode: string | null; state: string | null; country: string | null }

/**
 * The buyer as on the day of issue (R-043), falling back to today's customer only for a
 * row that carries no snapshot at all. Once an invoice has its snapshot, a NULL GSTIN
 * there means "unregistered at issue" — today's GSTIN is NOT borrowed, or a later edit
 * would move a filed invoice from B2CS into B2B. Place of supply "96" is an export: no
 * Indian state. A snapshot with no place of supply (backfill left it unknown because
 * today's state contradicts the frozen tax head) keeps today's state, as before.
 */
export function frozenParty(
  inv: {
    customer_gstin?: string | null; pos_state_code?: string | null; customer_country?: string | null;
    billing_address?: string | null; seller_state_code?: string | null;
  } | null | undefined,
  live: PartyFacts | null | undefined,
): PartyFacts {
  const l: PartyFacts = live ?? { gstin: null, stateCode: null, state: null, country: null };
  if (!inv) return l;
  const has = inv.seller_state_code != null || inv.pos_state_code != null || inv.billing_address != null;
  if (!has) return l;
  const pos = inv.pos_state_code ?? null;
  const country = inv.customer_country ?? l.country;
  if (pos === "96") return { gstin: inv.customer_gstin ?? null, stateCode: null, state: null, country };
  return {
    gstin: inv.customer_gstin ?? null,
    stateCode: pos ?? l.stateCode,
    state: pos ? (GST_STATE_BY_CODE[pos] ?? l.state) : l.state,
    country,
  };
}

/**
 * R-431 (board R-406, 7 Oct 2026) — can this supply's GST head be decided at all?
 *
 * isInterStateSupply() answers `false` (intra-state) when either state is missing — a safe
 * DEFAULT for arithmetic, but printed as "✓ Intra-state → CGST + SGST" it became a fact the
 * customer paid against. Abhishek (local test): a workspace with no company state quoted a
 * Haryana customer as CGST+SGST, took ₹38,232, then generate_invoice refused; once Delhi
 * was set the invoice came out IGST — quote and invoice disagreed.
 *
 * The SELLER side reads only the company's saved `state_code`, never its GSTIN prefix —
 * exactly what generate_invoice reads (tenants.state_code). Accepting the GSTIN here would
 * clear the quote while the invoice is still refused, the same split this fixes.
 * The BUYER side is the place of supply the caller already resolved (state code, else the
 * GSTIN prefix — generate_invoice does the same since R-373).
 *
 * Order: export (no Indian place of supply) → company state → customer state → compare.
 * The company check comes first because it is one click to fix and blocks every quote.
 *
 * @example supplyHead({ isExport: false, buyerStateCode: "06", sellerStateCode: null }).kind  // "seller_state_missing"
 * @example supplyHead({ isExport: false, buyerStateCode: "06", sellerStateCode: "07" }).kind  // "inter_state"
 */
export type SupplyHeadKind = "export" | "seller_state_missing" | "buyer_state_missing" | "intra_state" | "inter_state";

export interface SupplyHead {
  kind: SupplyHeadKind;
  /** True only when the head is KNOWN to be CGST+SGST or IGST (or the supply is an export). */
  known: boolean;
  /** True only when the head is known AND it is IGST. Never true off a guess. */
  interState: boolean;
}

export function supplyHead(a: {
  isExport: boolean;
  buyerStateCode: string | null | undefined;
  sellerStateCode: string | null | undefined;
}): SupplyHead {
  if (a.isExport) return { kind: "export", known: true, interState: false };
  const seller = (a.sellerStateCode ?? "").trim();
  if (!seller) return { kind: "seller_state_missing", known: false, interState: false };
  const buyer = (a.buyerStateCode ?? "").trim();
  if (!buyer) return { kind: "buyer_state_missing", known: false, interState: false };
  const inter = Number(buyer) !== Number(seller);
  return { kind: inter ? "inter_state" : "intra_state", known: true, interState: inter };
}
