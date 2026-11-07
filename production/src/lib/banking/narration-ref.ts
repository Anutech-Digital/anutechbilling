/**
 * R-2534 — the bank's own reference of a line: the UTR (NEFT / RTGS), the RRN (IMPS / UPI) or the
 * cheque number, read out of the narration (or the statement's Ref column). Stored on
 * bank_transactions.ref_key so a receipt or a Zoho payment that carries the same reference pairs
 * with the line exactly — two same-day, same-amount lines are no longer "ambiguous".
 *
 * The SQL twin is public.normalize_bank_ref(description, reference) (migration
 * 20261107033008_r2534_bank_ref_key.sql). Both follow the SAME steps; narration-ref-cases.ts is the
 * one table both are tested on (vitest here, supabase/tests/r2534_bank_ref_key.test.sql there):
 *   1. The rail = the FIRST rail word in the narration (by position, so "ABC UPI SOLUTIONS" in a
 *      remitter name after "NEFT CR" does not make an NEFT line an UPI one): UPI / IMPS / MMT → rrn;
 *      NEFT / RTGS → utr; CHQ / CHEQUE / CLG / CLEARING / MICR → cheque. No rail word → null (an FD,
 *      TPT account or interest line has numbers that are not references).
 *   2. rrn: the first run of exactly 12 digits not glued to other digits and not followed by "@"
 *      (a 12-digit phone UPI id "919876543210@paytm" is not the RRN); else the Ref column if it is
 *      12 digits.
 *      utr: the first narration token (split on anything not A-Z/0-9) of 12–22 characters with at
 *      least 6 digits and a letter; else the Ref column if it is 12–22 characters with 6+ digits.
 *      An all-digit narration token is never taken (a 14–16 digit account number is not a UTR).
 *      cheque: the Ref column if it is 3–6 digits (HDFC keeps the cheque no. there); else the first
 *      run of exactly 6 digits in the narration.
 *   3. The key: upper case, letters and digits only, leading zeros dropped ("0000621856395591" →
 *      "621856395591", Tally's rule). Empty → null.
 * Read-only metadata: it never changes an amount. Only a UTR / RRN (10+ characters) is trusted to
 * rank a receipt 'exact' (suggest_bank_transaction_matches) — cheque numbers repeat across
 * chequebooks.
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

/** The shortest key trusted as a bank reference for matching (a UTR / RRN, never a cheque no.). */
export const MATCH_KEY_MIN = 10;

const RAIL = /(^|[^A-Z])(UPI|IMPS|MMT|NEFT|RTGS|CHQ|CHEQUE|CLG|CLEARING|MICR)([^A-Z]|$)/;
const RRN_RUN = /(^|[^0-9])([0-9]{12})([^0-9@]|$)/;
const CHQ_RUN = /(^|[^0-9])([0-9]{6})([^0-9]|$)/;

const digitCount = (t: string) => t.replace(/[^0-9]/g, "").length;

function railKind(word: string): NarrationRefKind {
  if (word === "UPI" || word === "IMPS" || word === "MMT") return "rrn";
  if (word === "NEFT" || word === "RTGS") return "utr";
  return "cheque";
}

export function parseNarrationRef(description: string | null | undefined, reference?: string | null): NarrationRef | null {
  const d = (description ?? "").toUpperCase();
  const rail = RAIL.exec(d);
  if (!rail) return null;
  const kind = railKind(rail[2]);
  const ref = bankRefNorm(reference);
  const toks = d.split(/[^A-Z0-9]+/).filter(Boolean);
  const pick = (...c: Array<string | null | undefined>) => c.map((x) => bankRefNorm(x)).find(Boolean) ?? null;
  let key: string | null;
  if (kind === "rrn") {
    key = pick(RRN_RUN.exec(d)?.[2], /^[0-9]{12}$/.test(ref) ? ref : null);
  } else if (kind === "utr") {
    key = pick(
      toks.find((t) => t.length >= 12 && t.length <= 22 && digitCount(t) >= 6 && /[A-Z]/.test(t)),
      ref.length >= 12 && ref.length <= 22 && digitCount(ref) >= 6 ? ref : null,
    );
  } else {
    key = pick(/^[0-9]{3,6}$/.test(ref) ? ref : null, CHQ_RUN.exec(d)?.[2]);
  }
  return key ? { kind, key } : null;
}

/** The value of bank_transactions.ref_key for a line (null = no reference to trust). */
export function bankRefKey(description: string | null | undefined, reference?: string | null): string | null {
  return parseNarrationRef(description, reference)?.key ?? null;
}

/**
 * Does a receipt / Zoho payment reference carry this line's key? Equal after normalising, or —
 * for a key of 10+ characters — contained in it ("UTR: HDFCN5202…" typed with a prefix). A short
 * cheque number must be equal: "781" is inside too many strings. SQL twin: public.bank_ref_matches.
 */
export function referenceMatchesKey(reference: string | null | undefined, key: string | null | undefined): boolean {
  const k = bankRefNorm(key);
  if (!k) return false;
  const r = bankRefNorm(reference);
  if (!r) return false;
  return r === k || (k.length >= MATCH_KEY_MIN && r.includes(k));
}
