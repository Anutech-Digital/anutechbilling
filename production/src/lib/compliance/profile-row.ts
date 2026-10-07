/**
 * R-262 / R-325 — turning a tenants row into a compliance profile, with no client imports.
 *
 * profile.ts is a "use client" module (React Query hooks + toast), so a server route such
 * as the compliance-reminders cron cannot call into it. These helpers are shared by both:
 * the Settings card / Today page read through profile.ts (which re-exports them), the cron
 * reads them from here.
 *
 * A "column does not exist" answer is not an error: before migration
 * 20261007030000_tenant_compliance_profile.sql is applied it reads as an unknown profile,
 * which gives the original Pvt Ltd / monthly-GST calendar.
 */
import {
  toBusinessType, toGstFiling, UNKNOWN_PROFILE,
  type ComplianceProfile,
} from "./obligations";

export interface ComplianceProfileState extends ComplianceProfile {
  /** True when the database has no columns for this yet (migration not applied). */
  columnsMissing: boolean;
}

export interface PgErrorLike { code?: string | null; message?: string | null }

/**
 * Postgres says 42703 for an unknown column in a SELECT; PostgREST says PGRST204 when an
 * UPDATE names a column its schema cache does not have. Either one means "not migrated".
 */
export function isMissingColumnError(err: PgErrorLike | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const m = err.message ?? "";
  return /(business_type|gst_filing)/.test(m) && /(does not exist|could not find)/i.test(m);
}

/** Turn a tenants row read (data + error) into a profile. Any other error is thrown. */
export function profileFromRow(
  row: { business_type?: unknown; gst_filing?: unknown } | null,
  err: PgErrorLike | null,
): ComplianceProfileState {
  if (isMissingColumnError(err)) return { ...UNKNOWN_PROFILE, columnsMissing: true };
  if (err) throw Object.assign(new Error(err.message ?? "Could not read the compliance profile"), { code: err.code });
  return {
    businessType: toBusinessType(row?.business_type),
    gstFiling: toGstFiling(row?.gst_filing),
    columnsMissing: false,
  };
}
