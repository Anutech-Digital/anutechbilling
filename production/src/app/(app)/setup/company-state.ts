/**
 * R-250 — the company's GST state, shared by the setup wizard and Settings → Company.
 *
 * Why this exists: the wizard used to start on "Maharashtra (27)" and save it when the
 * owner left GSTIN blank and pressed Continue, so a Delhi or Haryana reseller got the
 * wrong IGST/CGST split on every invoice. Settings took the state as free text, so a
 * typo like "Hariyana" saved state_code = null and invoices were refused.
 *
 * Both screens now use ONE select over GST_STATE_BY_CODE, the value is always a
 * 2-digit code, and there is no default: nothing is chosen until the owner picks a
 * state or a checksum-valid GSTIN proves one.
 */
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { stateCodeFromGstin, stateCodeFromName } from "@/lib/gst/gstin-state";

/** Select options, sorted by state name. */
export const GST_STATE_OPTIONS: ReadonlyArray<{ code: string; name: string }> =
  Object.entries(GST_STATE_BY_CODE)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** A known 2-digit GST state code ("7" → "07"), else null. */
export function normalizeStateCode(code: string | null | undefined): string | null {
  const raw = (code ?? "").trim();
  if (!/^\d{1,2}$/.test(raw)) return null;
  const padded = raw.padStart(2, "0");
  return padded in GST_STATE_BY_CODE ? padded : null;
}

/**
 * The select's starting value for an existing tenant: the saved code if it is a real
 * state, else the saved name if it matches one, else "" (nothing chosen). Never a default.
 */
export function initialStateCode(
  name: string | null | undefined,
  code: string | null | undefined,
): string {
  return normalizeStateCode(code) ?? stateCodeFromName(name) ?? "";
}

/**
 * The state that will be saved: the chosen code, else what a checksum-valid GSTIN
 * proves, else null — and null means Continue / Save stays blocked.
 */
export function resolveCompanyState(
  chosenCode: string | null | undefined,
  gstin: string | null | undefined,
): { code: string; name: string } | null {
  const code = normalizeStateCode(chosenCode) ?? stateCodeFromGstin(gstin);
  return code ? { code, name: GST_STATE_BY_CODE[code] } : null;
}
