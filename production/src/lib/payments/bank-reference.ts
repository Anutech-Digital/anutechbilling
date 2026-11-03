/**
 * R-2424 (p0 money) — is this bank reference a real UTR / UPI ref, or a placeholder?
 *
 * The one-credit-once rule (R-1676, trigger trg_payments_ref_once) refuses a second received
 * payment whose UPI / bank-transfer reference is already on another one. Some bank statements
 * (HDFC) print an all-zero reference ("000000000000000") on credits that have no UTR, so two
 * DIFFERENT payments collided and the second could never be booked (staging, 3 Nov 2026: a
 * ₹2,88,982 credit refused because another customer's ₹68,676 receipt also had zeros).
 *
 * A reference is real when, after keeping only letters and digits, it is at least 6 characters
 * long, is not one character repeated ("000000000000000", "111111", "XXXXXXXX", "NA", "-") and is
 * not a placeholder word ("NOT AVAILABLE", "NOT APPLICABLE", "NO REFERENCE", "NOT PROVIDED").
 * R-2441: leading rail words (NEFT/RTGS/IMPS/UPI/UTR/REF/TXN/NO) are set aside before the
 * "one character repeated" test, so "NEFT-000000000000" / "UPI/000000000000" are placeholders too;
 * a real UTR with such a prefix stays real and keeps its key.
 * The database applies the SAME rule in public.bank_reference_is_real(text) (migrations
 * 20261103144041_r2424_placeholder_bank_ref, 20261103191637_r2441_approval_role_and_prefixed_refs), which public.payment_ref_key uses — a placeholder
 * gets no key, so it never blocks and is never blocked. Keep the two in step:
 * bank-reference.test.ts and supabase/tests/r2424_placeholder_bank_ref.test.sql check the same cases.
 */

/** ASCII letters and digits only, upper-case — what the placeholder test looks at (as SQL). */
function alnum(ref: string | null | undefined): string {
  return (ref ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Words banks and people type when there is no UTR (letters/digits only, upper-case). */
const PLACEHOLDER_WORDS = new Set(["NOTAVAILABLE", "NOTAPPLICABLE", "NOREFERENCE", "NOTPROVIDED"]);

/** R-2441: payment-rail words a bank puts in front of a reference ("NEFT-000000000000",
 *  "UPI/000000000000", "UTR NO 000000") — set aside before the "one character repeated" test. */
const RAIL_PREFIX = /^(NEFT|RTGS|IMPS|UPI|UTR|REF|TXN|NO)+/;

/** False for empty, under 6 letters/digits, a placeholder word, or — after leading rail words
 *  (R-2441) — nothing left or one character repeated (all zeros etc.). */
export function isRealBankReference(ref: string | null | undefined): boolean {
  const v = alnum(ref);
  if (v.length < 6 || PLACEHOLDER_WORDS.has(v)) return false;
  const rest = v.replace(RAIL_PREFIX, "");
  return rest.split("").some((ch) => ch !== rest[0]);
}

/**
 * The key a payment is held to "one credit once" by — the TypeScript twin of
 * public.payment_ref_key(method, reference): UPI / bank transfer only, spaces and hyphens
 * dropped, upper-case, prefixed "BANK:"; null when the rule does not apply (other methods,
 * or a placeholder reference).
 */
export function bankReferenceKey(method: string | null | undefined, ref: string | null | undefined): string | null {
  if (method !== "upi" && method !== "bank_transfer") return null;
  if (!isRealBankReference(ref)) return null;
  /* ASCII whitespace + hyphen, as Postgres [[:space:]-]; a real reference keeps 6+ characters. */
  return `BANK:${(ref ?? "").replace(/[ \t\n\r\f\v-]/g, "").toUpperCase()}`;
}
