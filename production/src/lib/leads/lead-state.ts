import { GST_STATE_BY_CODE } from "@/lib/utils";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";

/**
 * The lead's GST state — the "State" select on Add lead's Contact step (R-376 a, 7 Oct 2026).
 *
 * GST depends on it: the quote builder's Place of supply is prefilled from `leads.state_code`,
 * and record_payment copies it to the customer it creates, where generate_invoice needs it.
 * The Add lead wizard never asked for it, so a lead quote started on "Select state" and an
 * operator who forgot it sent an out-of-state buyer CGST + SGST.
 */

/** The state a typed GSTIN proves (first two digits), or null until it is a valid GSTIN. */
export function stateFromLeadGstin(gstin: string | null | undefined): string | null {
  return stateCodeFromGstin(gstin);
}

/**
 * The `state_code` + `state` columns to write for this save, or {} to leave them alone.
 *
 * A NEW lead always writes them (null when blank). An EDIT writes them only when the select
 * moved: some screens hand the form a slim lead row without `state_code`, and writing the
 * blank select back there would wipe a state the lead already has.
 */
export function leadStatePatch(
  formCode: string | null | undefined,
  editing: { state_code?: string | null } | null | undefined,
): { state_code?: string | null; state?: string | null } {
  const code = (formCode ?? "").trim();
  if (editing && code === (editing.state_code ?? "").trim()) return {};
  return { state_code: code || null, state: code ? (GST_STATE_BY_CODE[code] ?? null) : null };
}

/** "Haryana (06)" for the Review step, or "" when no state is picked. */
export function stateLabel(code: string | null | undefined): string {
  const c = (code ?? "").trim();
  const name = c ? GST_STATE_BY_CODE[c] : undefined;
  return name ? `${name} (${c})` : "";
}
