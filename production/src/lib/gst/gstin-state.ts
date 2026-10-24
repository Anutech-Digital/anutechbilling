/**
 * Derive the place of supply from a GSTIN.
 *
 * The first two characters of a GSTIN are the GST state code — 07 is Delhi, 27
 * Maharashtra, 29 Karnataka. So a customer who has given you their GSTIN has
 * already told you their state, whether or not anyone typed it into the state
 * field.
 *
 * WHY THIS MATTERS. `isInterStateSupply()` compares two state codes and, when
 * the customer's is missing, conservatively answers "intra-state" — CGST + SGST.
 * That default is right when nothing is known. It is wrong when the GSTIN on the
 * same record says the customer is in another state, because then the invoice
 * carries the wrong tax head: CGST+SGST where IGST was due. The total is the
 * same 18%, so nothing looks off on the invoice — it surfaces at GSTR-1 filing,
 * as a mismatch between what was charged and what the customer's return expects,
 * and it is the customer who cannot claim the credit.
 *
 * In production 36 of 41 customers carrying a GSTIN have no state code at all, so
 * this fallback is not hypothetical plumbing.
 *
 * THE SAFETY RULE: only a GSTIN that passes the full checksum is trusted. Reading
 * the first two characters of an unvalidated string is how a typo or seeded dummy
 * data ("8P…", "GU…") starts deciding tax heads.
 *
 * MEASURED BLAST RADIUS, which is why this was safe to wire in: of 49 production
 * customers exactly ONE holds a checksum-valid GSTIN, and enabling the fallback
 * changes ZERO tax heads. Nearly every GSTIN on file today is seeded junk and is
 * ignored. The behaviour starts mattering when real GSTINs arrive — which is the
 * right time for it to start mattering, and not before.
 *
 * Issued invoices are untouched regardless: `invoices.inter_state` freezes the
 * head at issue time (all 53 production invoices have it set) and a reprint must
 * say what the original said, whatever is learned about the customer later.
 */
import { isValidGstin, GST_STATE_BY_CODE } from "@/lib/utils";

/**
 * The GST state code encoded in a GSTIN, or null.
 *
 * Returns null unless the GSTIN is structurally valid AND its checksum passes
 * AND the prefix is a state code the GSTN actually issues. Anything less and the
 * caller keeps its existing conservative default, which is the correct outcome:
 * a guess about tax is worse than an admission of not knowing.
 */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  const g = gstin?.trim().toUpperCase();
  if (!g || !isValidGstin(g)) return null;
  const code = g.slice(0, 2);
  return code in GST_STATE_BY_CODE ? code : null;
}

/** The state name behind a GSTIN, for display. Null on the same rules as above. */
export function stateNameFromGstin(gstin: string | null | undefined): string | null {
  const code = stateCodeFromGstin(gstin);
  return code ? GST_STATE_BY_CODE[code] : null;
}

/**
 * Best available state code for a party: what was entered, else what their GSTIN
 * proves.
 *
 * An explicitly entered code ALWAYS wins, even when the GSTIN disagrees. Two
 * reasons, and the second is the important one:
 *
 *   1. Someone typed it deliberately, and a business can be registered in one
 *      state while the branch being billed sits in another.
 *   2. Silently overriding a human's entry with a derived value is how a system
 *      becomes impossible to correct. If the entered code is wrong, the operator
 *      needs to see it and fix it — not have the app quietly paper over it and
 *      leave the record saying one thing while the invoice says another.
 *
 * Use `gstinContradictsState()` to surface a disagreement instead of hiding it.
 */
export function resolveStateCode(party: {
  stateCode?: string | null;
  gstin?: string | null;
}): string | null {
  const explicit = party.stateCode?.trim();
  if (explicit) return explicit;
  return stateCodeFromGstin(party.gstin);
}

/**
 * True when a party's entered state code and their (valid) GSTIN point at
 * different states — a data-entry error worth showing someone, because whichever
 * is wrong, one of them is producing the wrong tax head on real invoices.
 * False whenever either side is unknown: silence, not a guess.
 */
export function gstinContradictsState(party: {
  stateCode?: string | null;
  gstin?: string | null;
}): boolean {
  const explicit = party.stateCode?.trim();
  const derived = stateCodeFromGstin(party.gstin);
  if (!explicit || !derived) return false;
  // Compare numerically so "7" and "07" are the same state, not a contradiction.
  return Number(explicit) !== Number(derived);
}

/**
 * A GST state code from what a buyer typed in a state box (R-079): a two-digit code, or the
 * state's name as `GST_STATE_BY_CODE` spells it, ignoring case, spacing and "&" vs "and".
 * Null for anything else — an unrecognised spelling is not guessed at, because the code
 * decides CGST+SGST vs IGST on the invoice.
 */
export function stateCodeFromName(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  if (/^\d{1,2}$/.test(raw)) {
    const code = raw.padStart(2, "0");
    return code in GST_STATE_BY_CODE ? code : null;
  }
  const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z]/g, "");
  const want = norm(raw);
  for (const [code, name] of Object.entries(GST_STATE_BY_CODE)) {
    if (norm(name) === want) return code;
  }
  return null;
}

/**
 * Fill a customer row's `state_code` from what the form holds, before it is saved (6 Oct 2026).
 *
 * WHY: the customer form only set `state_code` from a VERIFIED GSTIN. A customer with no GSTIN
 * (unregistered business, individual) whose state was picked or typed by hand saved
 * `state = "Delhi"` and `state_code = NULL` — and `generate_invoice` reads only `state_code`,
 * so that customer could never be invoiced: "has no state on record", while the customer page
 * plainly showed Delhi. Found on staging creating the first test invoice.
 *
 * Order, same as `resolveStateCode`: a code already on the row wins (it came from a GSTIN or a
 * human), then a valid GSTIN, then the state NAME — only when it matches a GST state exactly.
 * Foreign customers get nothing (no Indian place of supply). Rows that do not touch state or
 * GSTIN pass through untouched, so a partial update never clears a code.
 */
export function withStateCode<T extends {
  state?: string | null;
  state_code?: string | null;
  gstin?: string | null;
  country?: string | null;
}>(row: T): T {
  if (row.state_code?.trim()) return row;
  if (row.state === undefined && row.gstin === undefined) return row;
  const country = (row.country ?? "").trim().toLowerCase();
  if (country && !["in", "ind", "india"].includes(country)) return row;
  const code = stateCodeFromGstin(row.gstin) ?? stateCodeFromName(row.state);
  return code ? { ...row, state_code: code } : row;
}

/**
 * True when a customer's tax invoice will be REFUSED for want of a state (R-166, 6 Oct 2026).
 *
 * Mirrors generate_invoice exactly: it reads `customers.state_code` only, and refuses an Indian
 * customer whose code is empty ("has no state on record"). Foreign customers have no Indian
 * place of supply and are never refused for it. A typed state name or a GSTIN does not count
 * here — until it reaches state_code (withStateCode does that on the next save), the invoice
 * still stops, and that is what this filter is for. Live, 6 Oct: 17 such customers.
 */
export function missingInvoiceState(c: { state_code?: string | null; country?: string | null }): boolean {
  const country = (c.country ?? "").trim().toLowerCase();
  if (country && !["in", "ind", "india"].includes(country)) return false;
  return !(c.state_code ?? "").trim();
}

/** The GST states a person can pick, A–Z (R-173). 97/99 are tax-system codes, not places. */
export const GST_STATE_OPTIONS: { code: string; name: string }[] = Object.entries(GST_STATE_BY_CODE)
  .filter(([code]) => Number(code) < 97)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Why this customer cannot be saved yet, or null (R-173, 6 Oct 2026).
 *
 * Every Indian customer needs a place of supply: a tax invoice is refused without it
 * (generate_invoice — "no state on record"), GSTIN or not. Live had 17 customers in that state.
 * It is satisfied by a state code already on the row, a valid GSTIN, or a state NAME that maps to
 * a GST state — the same order withStateCode() uses to fill state_code on save. Foreign customers
 * have no Indian place of supply and are never asked.
 */
export function stateRequiredMessage(row: {
  state?: string | null; state_code?: string | null; gstin?: string | null; country?: string | null;
}): string | null {
  const country = (row.country ?? "").trim().toLowerCase();
  if (country && !["in", "ind", "india"].includes(country)) return null;
  if ((row.state_code ?? "").trim() || stateCodeFromGstin(row.gstin) || stateCodeFromName(row.state)) return null;
  return (row.state ?? "").trim()
    ? `"${String(row.state).trim()}" is not a GST state name — pick the state from the list. The GST invoice needs it.`
    : "Choose the state — the GST invoice cannot be made without it (it decides CGST + SGST or IGST).";
}

/**
 * R-1128 (19 Oct 2026) — the chosen state must be the state the GSTIN was issued in.
 *
 * The first two digits of a GSTIN ARE the GST state code (07 Delhi, 27 Maharashtra). The tenant's
 * `state_code` is the seller's place of business on every invoice: it decides CGST+SGST vs IGST.
 * Both screens used to let a chosen state win over the GSTIN, so "GSTIN 07… + Maharashtra" saved
 * and every Delhi sale was split as if the seller sat in Mumbai — wrong tax head on each invoice,
 * found only at GSTR-1 filing.
 *
 * Only a checksum-valid GSTIN is trusted (stateCodeFromGstin), so a half-typed one never blocks.
 * Returns null when they agree or either side is unknown; otherwise the GSTIN's state (for the
 * "Set state from GSTIN" button) and a §24 message: what is wrong, why it matters, what to do.
 */
export function companyGstinStateConflict(
  chosenCode: string | null | undefined,
  gstin: string | null | undefined,
): { gstinCode: string; gstinState: string; message: string } | null {
  const chosen = stateCodeFromName(chosenCode);
  const gstinCode = stateCodeFromGstin(gstin);
  if (!chosen || !gstinCode || chosen === gstinCode) return null;
  const gstinState = GST_STATE_BY_CODE[gstinCode];
  return {
    gstinCode,
    gstinState,
    message:
      `Your GSTIN starts with ${gstinCode}, which is ${gstinState}, but the state chosen is ` +
      `${GST_STATE_BY_CODE[chosen]} (${chosen}). Every invoice would split CGST/SGST vs IGST wrongly. ` +
      `Press "Set state from GSTIN" to use ${gstinState}, or correct the GSTIN.`,
  };
}
