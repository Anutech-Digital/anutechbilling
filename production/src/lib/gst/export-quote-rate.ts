/**
 * R-2648 — the GST rate a NEW quote starts at for a buyer abroad (or an SEZ unit supplied without
 * payment of tax), money-rules G16.
 *
 * The rule, in one place (no second country list, no second FY rule):
 *   - zero-rated buyer = isZeroRatedSupply (G4; empty country = India, G5)
 *   - the LUT that covers the quote's date = lutFor (G6 — the LUT of THAT date's financial year)
 *   - zero-rated buyer + LUT → 0% (export / SEZ supply WITHOUT payment of tax)
 *   - zero-rated buyer, no LUT → the path keeps the rate it used before (renewals, seat adds, plan
 *     change and the builder were already 0%; projects, Extend term and Upgrade support were 18%),
 *     and the screen says so with the next step — add the LUT in Settings → Company → LUT. Never a
 *     refusal here: the invoice step (R-2444 / R-2636) decides what an issued invoice may carry.
 *
 * Only for a quote being MADE. A sent / accepted quote and an issued invoice are never re-priced.
 */

import { isExportSupply, isZeroRatedSupply } from "@/lib/gst/place-of-supply";
import { lutFor, lutFyLabel, LUT_SETTINGS_HREF, type TenantLut } from "@/lib/gst/export-lut";

export type ExportQuoteDefault =
  /** Not a zero-rated buyer (or a Bill of Supply business) — the usual rate. */
  | { kind: "domestic" }
  /** Zero-rated buyer and an LUT covers the date — the quote starts at 0%. */
  | { kind: "zero_rated"; lut: TenantLut; fy: string; supply: "export" | "sez" }
  /** Zero-rated buyer but no LUT for the date's FY (or the LUTs could not be read). */
  | { kind: "no_lut"; fy: string; supply: "export" | "sez" };

export interface ExportQuoteDefaultInput {
  country:       string | null | undefined;
  treatment:     string | null | undefined;
  /** The quote's date (YYYY-MM-DD, IST). */
  date:          string;
  /** The company's LUTs. `null` = not known (read failed / still loading) → no LUT. */
  luts:          readonly TenantLut[] | null | undefined;
  /** A Bill of Supply business charges no GST at all — the LUT never matters. */
  billOfSupply?: boolean;
}

/** Which of the three cases a new quote for this buyer on this date is. */
export function exportQuoteDefault(a: ExportQuoteDefaultInput): ExportQuoteDefault {
  if (a.billOfSupply) return { kind: "domestic" };
  if (!isZeroRatedSupply({ country: a.country, treatment: a.treatment })) return { kind: "domestic" };
  const supply = isExportSupply(a.country) ? "export" : "sez";
  const fy = lutFyLabel(a.date);
  const lut = lutFor(a.luts ?? null, a.date);
  return lut ? { kind: "zero_rated", lut, fy, supply } : { kind: "no_lut", fy, supply };
}

/**
 * The rate the new quote starts at: 0 when an LUT covers it, else `usualRate` — the rate this path
 * used before R-2648 (so a path that already zero-rated keeps doing so; one that charged 18% keeps
 * charging it without an LUT).
 */
export function exportQuoteStartRate(def: ExportQuoteDefault, usualRate: number): number {
  return def.kind === "zero_rated" ? 0 : usualRate;
}

/**
 * The plain warning for a zero-rated buyer with no LUT for the quote's FY, saying what the quote
 * does and the next step. Null when there is nothing to warn about.
 *   - rate > 0: the quote charges IGST (export WITH payment of tax) — legal, but the buyer abroad
 *     usually cannot claim it back.
 *   - rate 0: the 0% invoice will be refused (R-2444) until the LUT is added.
 */
export function exportQuoteLutWarning(def: ExportQuoteDefault, rate: number): string | null {
  if (def.kind !== "no_lut") return null;
  const what = def.supply === "export" ? "an export" : "an SEZ supply";
  if (rate > 0) {
    return `No LUT for FY ${def.fy} on file, so this quote charges ${rate}% IGST (${what} with payment of tax) — `
      + "a customer abroad usually cannot claim it back. Add your LUT in Settings → Company → LUT to quote at 0%.";
  }
  return `No LUT for FY ${def.fy} on file: ${what} at 0% GST needs it, so the invoice for this quote will be `
    + "refused until you add your LUT in Settings → Company → LUT.";
}

/** Where the warning's next step goes (Settings → Company, LUT card). */
export const EXPORT_QUOTE_LUT_HREF = LUT_SETTINGS_HREF;

/** The minimal query shape readTenantLuts needs (a Supabase client, typed or not). */
interface LutListReader {
  from(table: "tenant_luts"): {
    select(cols: string): {
      eq(col: string, v: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
}

/**
 * Server side: the company's LUT rows, or `null` when they could not be read — a caller then treats
 * the buyer as having NO LUT (keeps the old rate), never zero-rates on an unknown.
 */
export async function readTenantLuts(client: LutListReader, tenantId: string): Promise<TenantLut[] | null> {
  const { data, error } = await client.from("tenant_luts").select("fy_start, arn, valid_from, valid_upto").eq("tenant_id", tenantId);
  if (error) return null;
  return ((data ?? []) as { fy_start: string; arn: string; valid_from: string; valid_upto: string }[])
    .map((r) => ({ fyStart: r.fy_start, arn: r.arn, validFrom: r.valid_from, validUpto: r.valid_upto }));
}

/**
 * Server side, for a quote maker that has the customer id: the start rate + warning in one call.
 * A failed customer or LUT read keeps `usualRate` (no zero-rating on an unknown).
 */
export async function exportQuoteRateFor(args: {
  client:     unknown;
  tenantId:   string;
  customerId: string | null | undefined;
  date:       string;
  usualRate:  number;
  billOfSupply?: boolean;
}): Promise<{ rate: number; def: ExportQuoteDefault; warning: string | null }> {
  const domestic = { rate: args.usualRate, def: { kind: "domestic" } as ExportQuoteDefault, warning: null };
  if (!args.customerId || args.billOfSupply) return domestic;
  const c = args.client as {
    from(t: "customers"): { select(c: string): { eq(c: string, v: string): { eq(c: string, v: string): { maybeSingle(): PromiseLike<{ data: { country: string | null; gst_treatment: string | null } | null; error: unknown }> } } } };
  };
  const { data: cust, error } = await c.from("customers").select("country, gst_treatment")
    .eq("id", args.customerId).eq("tenant_id", args.tenantId).maybeSingle();
  if (error || !cust) return domestic;
  if (!isZeroRatedSupply({ country: cust.country, treatment: cust.gst_treatment })) return domestic;
  const luts = await readTenantLuts(args.client as LutListReader, args.tenantId);
  const def = exportQuoteDefault({ country: cust.country, treatment: cust.gst_treatment, date: args.date, luts });
  const rate = exportQuoteStartRate(def, args.usualRate);
  return { rate, def, warning: exportQuoteLutWarning(def, rate) };
}
