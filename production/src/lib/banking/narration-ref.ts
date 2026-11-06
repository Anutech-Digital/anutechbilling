/**
 * R-2534 — the bank's own reference of a line: the UTR (NEFT / RTGS), the RRN (IMPS / UPI) or the
 * cheque number, read out of the narration (else the statement's Ref column). Stored on
 * bank_transactions.ref_key so a receipt or a Zoho payment that carries the same reference pairs
 * with the line exactly — two same-day, same-amount lines are no longer "ambiguous".
 *
 * The SQL twin is public.normalize_bank_ref(description, reference) (migration
 * 2026110613..._r2534_bank_ref_key.sql). Both follow the SAME steps; narration-ref-cases.ts is the
 * one table both are tested on (vitest here, supabase/tests/r2534_bank_ref_key.test.sql there):
 *   1. The rail, by keyword: UPI / IMPS / MMT → rrn; else NEFT / RTGS → utr; else CHQ / CHEQUE /
 *      CLG / CLEARING / MICR → cheque; else no rail → null (an FD, TPT account or interest line has
 *      numbers that are not references).
 *   2. rrn: the first run of exactly 12 digits not glued to other digits and not followed by "@"
 *      (a 12-digit phone UPI id "919876543210@paytm" is not the RRN).
 *      utr: the first narration token (split on anything not A-Z/0-9) of 12–22 characters with at
 *      least 6 digits and at least one letter (an all-digit 14-digit account is not a UTR); else
 *      the first all-digit token of exactly 16 or 22.
 *      cheque: the first run of exactly 6 digits.
 *   3. Nothing in the narration → the Ref column, if it has the rail's shape: rrn = 12 digits,
 *      utr = 12–22 characters with at least 6 digits, cheque = 1–6 digits.
 *   4. The key: upper case, letters and digits only, leading zeros dropped ("0000621856395591" →
 *      "621856395591", Tally's rule). Empty → null.
 * Read-only metadata: it never changes an amount.
 */

export type NarrationRefKind = "utr" | "rrn" | "cheque";

export interface NarrationRef {
  kind: NarrationRefKind;
  key: string;
}

/** Upper-case letters and digits only, leading zeros dropped. Same as SQL public.bank_ref_norm. */
export function bankRefNorm(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+/, "");
}

const RRN_RAIL = /(^|[^A-Z])(UPI|IMPS|MMT)([^A-Z]|$)/;
const UTR_RAIL = /(^|[^A-Z])(NEFT|RTGS)([^A-Z]|$)/;
const CHQ_RAIL = /(^|[^A-Z])(CHQ|CHEQUE|CLG|CLEARING|MICR)([^A-Z]|$)/;
const RRN_RUN = /(^|[^0-9])([0-9]{12})([^0-9@]|$)/;
const CHQ_RUN = /(^|[^0-9])([0-9]{6})([^0-9]|$)/;

const digitCount = (t: string) => t.replace(/[^0-9]/g, "").length;

function utrFromTokens(text: string): string | null {
  const toks = text.split(/[^A-Z0-9]+/).filter(Boolean);
  const lettered = toks.find((t) => t.length >= 12 && t.length <= 22 && digitCount(t) >= 6 && /[A-Z]/.test(t));
  if (lettered) return lettered;
  return toks.find((t) => /^[0-9]+$/.test(t) && (t.length === 16 || t.length === 22)) ?? null;
}

function refColumnFits(kind: NarrationRefKind, reference: string | null | undefined): string | null {
  const raw = (reference ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const n = bankRefNorm(raw);
  if (!n) return null;
  if (kind === "rrn") return /^[0-9]{12}$/.test(n) ? n : null;
  if (kind === "utr") return n.length >= 12 && n.length <= 22 && digitCount(n) >= 6 ? n : null;
  return /^[0-9]{1,6}$/.test(n) ? n : null;
}

export function parseNarrationRef(description: string | null | undefined, reference?: string | null): NarrationRef | null {
  const d = (description ?? "").toUpperCase();
  const kind: NarrationRefKind | null = RRN_RAIL.test(d) ? "rrn" : UTR_RAIL.test(d) ? "utr" : CHQ_RAIL.test(d) ? "cheque" : null;
  if (!kind) return null;
  let found: string | null = null;
  if (kind === "rrn") found = RRN_RUN.exec(d)?.[2] ?? null;
  else if (kind === "utr") found = utrFromTokens(d);
  else found = CHQ_RUN.exec(d)?.[2] ?? null;
  const key = (found ? bankRefNorm(found) : "") || refColumnFits(kind, reference);
  return key ? { kind, key } : null;
}

/** The value of bank_transactions.ref_key for a line (null = no reference to trust). */
export function bankRefKey(description: string | null | undefined, reference?: string | null): string | null {
  return parseNarrationRef(description, reference)?.key ?? null;
}

/**
 * Does a receipt / Zoho payment reference carry this line's key? Equal after normalising, or —
 * for a key of 10+ characters — contained in it ("UTR: HDFCN5202…" typed with a prefix). A short
 * cheque number must be equal: "781" is inside too many strings.
 */
export function referenceMatchesKey(reference: string | null | undefined, key: string | null | undefined): boolean {
  const k = bankRefNorm(key);
  if (!k) return false;
  const r = bankRefNorm(reference);
  if (!r) return false;
  return r === k || (k.length >= 10 && r.includes(k));
}
