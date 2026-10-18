/**
 * R-1529 — Settings → Company → "GST registration": which document this business issues.
 *
 *   Registered     → Tax Invoice with GST (today's behaviour; the default when a GSTIN is set).
 *   Not registered → Bill of Supply, no GST, BOS- number series (owner decision q1, q2).
 *   Composition    → Bill of Supply with "composition taxable person, not eligible to collect
 *                    tax on supplies"; the business pays `compositionRate`% of its turnover
 *                    itself each quarter (CMP-08 — R-1530), never collected from customers.
 *
 * Stored on tenants (migration 20261018022629_r1529_bill_of_supply). The DATABASE decides the
 * document at issue (supplier_gst_status / trg_invoice_document_kind) — this module only reads
 * and validates the setting, so the screen and the database cannot disagree about the rule.
 * Pure: no React, no client.
 */

export type GstRegistration = "registered" | "unregistered" | "composition";

export const GST_REGISTRATIONS: GstRegistration[] = ["registered", "unregistered", "composition"];

export const GST_REGISTRATION_LABEL: Record<GstRegistration, string> = {
  registered:   "Registered",
  unregistered: "Not registered",
  composition:  "Composition scheme",
};

export const GST_REGISTRATION_HINT: Record<GstRegistration, string> = {
  registered:
    "You charge GST and issue Tax Invoices (INV- numbers).",
  unregistered:
    "No GSTIN. You issue a Bill of Supply with no GST on it (BOS- numbers). Sales still count in your P&L; nothing goes into GST returns.",
  composition:
    "You issue a Bill of Supply with no GST, marked \"composition taxable person\". You pay the composition rate on your turnover yourself every quarter (CMP-08).",
};

/** Services under composition pay 6% (CGST 3% + SGST 3%) — the owner can change it. */
export const DEFAULT_COMPOSITION_RATE = 6;

export interface GstRegistrationState {
  /** What is saved. null = never chosen (behaves as registered). */
  saved: GstRegistration | null;
  compositionRate: number;
  /** Registration effective date (YYYY-MM-DD) or null. */
  registeredFrom: string | null;
  /** The columns are not in this database yet — the card shows "coming soon". */
  columnMissing: boolean;
}

export function toGstRegistration(v: unknown): GstRegistration | null {
  return v === "registered" || v === "unregistered" || v === "composition" ? v : null;
}

/**
 * What the business IS for the screen: the saved choice, else Registered when a GSTIN is on
 * file (the prompt's default), else null — "not chosen yet", which the card asks about.
 */
export function effectiveGstRegistration(
  saved: GstRegistration | null,
  gstin: string | null | undefined,
): GstRegistration | null {
  if (saved) return saved;
  return gstin && gstin.trim() ? "registered" : null;
}

/** Does this setting make the business issue Bills of Supply? */
export function issuesBillOfSupply(status: GstRegistration | null): boolean {
  return status === "unregistered" || status === "composition";
}

export interface GstRegistrationInput {
  status: GstRegistration;
  gstin: string | null | undefined;
  compositionRate: number | string | null | undefined;
  registeredFrom: string | null | undefined;
}

/**
 * The reason this choice cannot be saved, in the owner's words with the fix (§24), or null.
 * Mirrors the database: tenants_unregistered_no_gstin_check and
 * tenants_gst_composition_rate_check (0 < rate ≤ 10).
 */
export function gstRegistrationProblem(i: GstRegistrationInput): string | null {
  const hasGstin = Boolean(i.gstin && i.gstin.trim());
  if (i.status === "unregistered" && hasGstin) {
    return "A business that is not registered has no GSTIN. Clear the GSTIN in Company information above and save it, then choose Not registered.";
  }
  if (i.status === "composition" && !hasGstin) {
    return "A composition dealer is registered and has a GSTIN. Add it in Company information above and save it first.";
  }
  if (i.status === "composition") {
    const rate = typeof i.compositionRate === "string" ? Number(i.compositionRate) : i.compositionRate;
    if (rate == null || !Number.isFinite(rate) || rate <= 0 || rate > 10) {
      return "Composition rate must be more than 0% and at most 10% (services: 6%).";
    }
  }
  if (i.registeredFrom && !/^\d{4}-\d{2}-\d{2}$/.test(i.registeredFrom)) {
    return "Registration date must be a date (DD/MM/YYYY).";
  }
  return null;
}

/** The tenants patch for a valid input. */
export function gstRegistrationPatch(i: GstRegistrationInput): {
  gst_registration: GstRegistration;
  gst_composition_rate?: number;
  gst_registered_from: string | null;
} {
  const rate = typeof i.compositionRate === "string" ? Number(i.compositionRate) : i.compositionRate;
  return {
    gst_registration: i.status,
    ...(i.status === "composition" && rate != null ? { gst_composition_rate: Math.round(rate * 100) / 100 } : {}),
    gst_registered_from: i.status === "unregistered" ? null : (i.registeredFrom || null),
  };
}

interface PgErrorLike { code?: string | null; message?: string | null }

/** "column does not exist" before the migration is applied — read as not-chosen, not as a failure. */
export function isMissingGstRegistrationColumn(err: PgErrorLike | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const m = err.message ?? "";
  return /gst_(registration|composition_rate|registered_from)/.test(m) && /(does not exist|could not find)/i.test(m);
}

export function gstRegistrationFromRow(
  row: { gst_registration?: unknown; gst_composition_rate?: unknown; gst_registered_from?: unknown } | null,
  err: PgErrorLike | null,
): GstRegistrationState {
  if (isMissingGstRegistrationColumn(err)) {
    return { saved: null, compositionRate: DEFAULT_COMPOSITION_RATE, registeredFrom: null, columnMissing: true };
  }
  if (err) throw Object.assign(new Error(err.message ?? "Could not read the GST registration"), { code: err.code });
  const rate = Number(row?.gst_composition_rate);
  return {
    saved: toGstRegistration(row?.gst_registration),
    compositionRate: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_COMPOSITION_RATE,
    registeredFrom: typeof row?.gst_registered_from === "string" ? row.gst_registered_from : null,
    columnMissing: false,
  };
}
