/**
 * R-334 — export under a Letter of Undertaking (LUT), the paperwork half.
 *
 * The app already zero-rates an export (recipient outside India → tax_rate 0, no IGST).
 * What it did not do is SAY so the way CGST Rule 46 asks: an export invoice issued
 * without payment of integrated tax must carry the endorsement below, and the LUT it
 * relies on is identified by its ARN (stored in Settings → Company → LUT number).
 *
 * This module decides WORDS only. It never changes a tax amount — the 0% decision stays
 * where it was (quote builder / place-of-supply).
 */

/** The Rule 46 endorsement for an export without payment of IGST, verbatim. */
export const EXPORT_LUT_ENDORSEMENT =
  "SUPPLY MEANT FOR EXPORT UNDER LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX";

/** A zero-rated export: recipient outside India and no tax charged on the document. */
export function isZeroRatedExport(args: { isExport: boolean; tax: number }): boolean {
  return args.isExport && args.tax === 0;
}

function clean(lut: string | null | undefined): string | null {
  const v = (lut ?? "").trim();
  return v ? v : null;
}

/**
 * What the invoice prints under the totals. `null` = nothing (not a zero-rated export).
 * The ARN line is present only when the seller actually has one on file — the PDF must
 * not invent an LUT that does not exist.
 */
export function exportEndorsement(args: {
  isExport: boolean;
  tax: number;
  lutNumber?: string | null;
}): { text: string; lutArn: string | null } | null {
  if (!isZeroRatedExport(args)) return null;
  return { text: EXPORT_LUT_ENDORSEMENT, lutArn: clean(args.lutNumber) };
}

/**
 * The warning shown when a zero-rated export invoice is issued and the seller has no LUT
 * number saved. A warning, never a block: the invoice is already issued and the owner may
 * hold an LUT they have simply not typed in yet.
 *
 * `taxRate === 0` is how an export is recorded on a quote/invoice in this app (the
 * invoices page and credit-note dialog read it the same way).
 */
export function lutMissingWarning(args: {
  taxRate: number | null | undefined;
  lutNumber: string | null | undefined;
}): string | null {
  if (args.taxRate !== 0) return null;
  if (clean(args.lutNumber)) return null;
  return "Export invoice issued at 0% GST, but no LUT number is saved. "
    + "Without a valid LUT, IGST is payable on this export. "
    + "Add your LUT ARN in Settings → Company (file Form GST RFD-11 on gst.gov.in if you have none).";
}

/* ── R-2444: the LUT per financial year ────────────────────────────────────────────────────────
 * An LUT (Form RFD-11) is filed for ONE financial year, and a 0% export needs the LUT of its own
 * date's FY (tax memo 3 Nov §1). Twin of the SQL helpers lut_for / export_lut_refusal (migration
 * 20261104014038_r2444_lut_per_fy) — same rule and same words; the server refuses on its own. */

/** One row of tenant_luts (Settings → Company → LUT). Dates are YYYY-MM-DD. */
export interface TenantLut {
  fyStart: string;     // 1 April of the FY
  arn: string;
  validFrom: string;
  validUpto: string;
}

/** The first day (1 April) of the Indian financial year a YYYY-MM-DD date falls in. */
export function lutFyStart(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
}

/** "2025-26" for any date from 1 Apr 2025 to 31 Mar 2026. */
export function lutFyLabel(date: string): string {
  const y = Number(lutFyStart(date).slice(0, 4));
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/** The last day (31 March) of the FY that starts on fyStart. */
export function lutFyEnd(fyStart: string): string {
  return `${Number(fyStart.slice(0, 4)) + 1}-03-31`;
}

/** The LUT row covering the date (its FY's row, validFrom ≤ date ≤ validUpto), else null. */
export function lutFor(luts: readonly TenantLut[] | null | undefined, date: string): TenantLut | null {
  const d = date.slice(0, 10);
  const fy = lutFyStart(d);
  return (luts ?? []).find((l) => l.fyStart.slice(0, 10) === fy && l.validFrom.slice(0, 10) <= d && d <= l.validUpto.slice(0, 10)
    && l.arn.trim() !== "") ?? null;
}

function longDate(d: string): string {
  const [y, m, day] = d.slice(0, 10).split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return `${day} ${mon} ${y}`;
}

/**
 * Null = a 0% export on this date is covered. Else why not, with the next step (§24): add the LUT
 * for that FY in Settings → Company → LUT, or bill the sale with IGST. Same words as
 * export_lut_refusal in SQL.
 */
export function exportLutRefusal(luts: readonly TenantLut[] | null | undefined, date: string): string | null {
  const d = date.slice(0, 10);
  if (lutFor(luts, d)) return null;
  const fy = lutFyLabel(d);
  const row = (luts ?? []).find((l) => l.fyStart.slice(0, 10) === lutFyStart(d));
  if (row) {
    return `No LUT for FY ${fy} covers ${longDate(d)}: the LUT saved for that year runs ${longDate(row.validFrom)} – ${longDate(row.validUpto)}. `
      + "An export at 0% GST needs a Letter of Undertaking on its date: correct the LUT dates in Settings → Company → LUT, or bill this sale with IGST.";
  }
  return `No LUT for FY ${fy} on file. An export sale at 0% GST needs your Letter of Undertaking for that year: `
    + "add its ARN in Settings → Company → LUT, then try again — or bill this sale with IGST.";
}

/** The old single LUT (tenants.lut_number + lut_valid_upto) as a one-row list — its FY is the FY of
 *  "valid up to", from 1 April (what the R-2444 migration moved into tenant_luts). */
export function legacyLutRows(number: string | null | undefined, validUpto: string | null | undefined): TenantLut[] {
  const arn = (number ?? "").trim();
  const upto = (validUpto ?? "").slice(0, 10);
  if (!arn || !/^\d{4}-\d{2}-\d{2}$/.test(upto)) return [];
  const fyStart = lutFyStart(upto);
  return [{ fyStart, arn, validFrom: fyStart, validUpto: upto }];
}

/** The minimal query shape readLutArnFor needs (a Supabase client, typed or not). */
interface LutReader {
  from(table: "tenant_luts"): {
    select(cols: string): {
      eq(col: string, v: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
}

/**
 * R-2444: the ARN an invoice dated `date` prints — the LUT of ITS financial year (CGST rule 46),
 * not whatever LUT was saved last. Before the migration (no tenant_luts table) the old single LUT
 * (`legacy`, tenants.lut_number) is used; any other read error prints no ARN rather than a wrong one.
 */
export async function readLutArnFor(
  client: LutReader, tenantId: string, date: string | null | undefined, legacy: string | null | undefined,
): Promise<string | null> {
  if (!date) return null;
  const { data, error } = await client.from("tenant_luts").select("fy_start, arn, valid_from, valid_upto").eq("tenant_id", tenantId);
  if (error) {
    return /tenant_luts/.test(error.message) && /(does not exist|could not find|schema cache)/i.test(error.message)
      ? ((legacy ?? "").trim() || null) : null;
  }
  const rows = ((data ?? []) as { fy_start: string; arn: string; valid_from: string; valid_upto: string }[])
    .map((r) => ({ fyStart: r.fy_start, arn: r.arn, validFrom: r.valid_from, validUpto: r.valid_upto }));
  return lutFor(rows, date)?.arn.trim() ?? null;
}
