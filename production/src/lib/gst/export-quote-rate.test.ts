/**
 * R-2648 — a NEW quote for a buyer abroad (or an SEZ unit without payment) starts at 0% when an LUT
 * covers the quote's date (its FY), money-rules G16. No LUT → the path's old rate + a plain warning.
 */
import { describe, it, expect } from "vitest";
import {
  exportQuoteDefault, exportQuoteStartRate, exportQuoteLutWarning, exportQuoteRateFor, readTenantLuts,
} from "./export-quote-rate";
import type { TenantLut } from "./export-lut";

const LUT_2627: TenantLut = { fyStart: "2026-04-01", arn: "AD0704260001234", validFrom: "2026-04-01", validUpto: "2027-03-31" };
const LUT_2526: TenantLut = { fyStart: "2025-04-01", arn: "AD0704250009999", validFrom: "2025-04-01", validUpto: "2026-03-31" };
const DATE = "2026-11-10";

describe("exportQuoteDefault — one rule: isZeroRatedSupply (G4/G5) + lutFor (G6)", () => {
  it("export with an LUT for the date's FY → zero_rated, rate 0, no warning", () => {
    const d = exportQuoteDefault({ country: "United States", treatment: "overseas", date: DATE, luts: [LUT_2627] });
    expect(d).toMatchObject({ kind: "zero_rated", fy: "2026-27", supply: "export" });
    expect(exportQuoteStartRate(d, 18)).toBe(0);
    expect(exportQuoteLutWarning(d, 0)).toBeNull();
  });

  it("other FY: only the FY 2025-26 LUT, quote dated Nov 2026 → no_lut, rate kept, warning names FY 2026-27", () => {
    const d = exportQuoteDefault({ country: "UAE", treatment: "overseas", date: DATE, luts: [LUT_2526] });
    expect(d).toMatchObject({ kind: "no_lut", fy: "2026-27" });
    expect(exportQuoteStartRate(d, 18)).toBe(18);
    expect(exportQuoteLutWarning(d, 18)).toBe(
      "No LUT for FY 2026-27 on file, so this quote charges 18% IGST (an export with payment of tax) — "
      + "a customer abroad usually cannot claim it back. Add your LUT in Settings → Company → LUT to quote at 0%.",
    );
  });

  it("an LUT that starts after the quote date does not cover it", () => {
    const late = { ...LUT_2627, validFrom: "2026-12-01" };
    expect(exportQuoteDefault({ country: "UK", treatment: null, date: DATE, luts: [late] }).kind).toBe("no_lut");
  });

  it("read error (luts null) → no_lut: never zero-rate on an unknown", () => {
    const d = exportQuoteDefault({ country: "Germany", treatment: "overseas", date: DATE, luts: null });
    expect(d.kind).toBe("no_lut");
    expect(exportQuoteStartRate(d, 18)).toBe(18);
  });

  it("zero-rate warning: a path that already quotes 0% without an LUT says the invoice will be refused", () => {
    const d = exportQuoteDefault({ country: "Singapore", treatment: "overseas", date: DATE, luts: [] });
    expect(exportQuoteLutWarning(d, 0)).toBe(
      "No LUT for FY 2026-27 on file: an export at 0% GST needs it, so the invoice for this quote will be "
      + "refused until you add your LUT in Settings → Company → LUT.",
    );
  });

  it("SEZ wop: SEZ without payment (India) with an LUT → zero_rated, supply sez", () => {
    const d = exportQuoteDefault({ country: "India", treatment: "sez_without_payment", date: DATE, luts: [LUT_2627] });
    expect(d).toMatchObject({ kind: "zero_rated", supply: "sez" });
    const n = exportQuoteDefault({ country: "India", treatment: "sez_without_payment", date: DATE, luts: [] });
    expect(exportQuoteLutWarning(n, 18)).toContain("an SEZ supply with payment of tax");
  });

  it("domestic: India / empty country (G5) / SEZ WITH payment → domestic, usual rate, no warning", () => {
    for (const c of [
      { country: "India", treatment: "registered_regular" },
      { country: "", treatment: null },
      { country: null, treatment: "overseas" },          // R-2620 case: not guessed as export here
      { country: "Bharat", treatment: null },
      { country: "India", treatment: "sez_with_payment" },
    ]) {
      const d = exportQuoteDefault({ ...c, date: DATE, luts: [LUT_2627] });
      expect(d.kind).toBe("domestic");
      expect(exportQuoteStartRate(d, 18)).toBe(18);
      expect(exportQuoteLutWarning(d, 18)).toBeNull();
    }
  });

  it("bill of supply: a Bill of Supply business is never told about an LUT", () => {
    const d = exportQuoteDefault({ country: "USA", treatment: "overseas", date: DATE, luts: [], billOfSupply: true });
    expect(d.kind).toBe("domestic");
    expect(exportQuoteLutWarning(d, 0)).toBeNull();
  });
});

function fakeClient(opts: { customer?: { country: string | null; gst_treatment: string | null } | null; luts?: unknown[] | null; custErr?: boolean }) {
  const reads: string[] = [];
  const client = {
    from(table: string) {
      reads.push(table);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => (table === "tenant_luts"
        ? Promise.resolve(opts.luts === null ? { data: null, error: { message: "boom" } } : { data: opts.luts ?? [], error: null })
        : q);
      q.maybeSingle = async () => (opts.custErr ? { data: null, error: { message: "boom" } } : { data: opts.customer ?? null, error: null });
      return q;
    },
  };
  return { client, reads };
}
const LUT_ROW = { fy_start: "2026-04-01", arn: "AD0704260001234", valid_from: "2026-04-01", valid_upto: "2027-03-31" };

describe("exportQuoteRateFor (server quote makers)", () => {
  it("export customer + LUT row → 0", async () => {
    const f = fakeClient({ customer: { country: "United States", gst_treatment: "overseas" }, luts: [LUT_ROW] });
    const r = await exportQuoteRateFor({ client: f.client, tenantId: "T1", customerId: "C1", date: DATE, usualRate: 18 });
    expect(r.rate).toBe(0);
    expect(r.warning).toBeNull();
  });

  it("export customer + LUT read error → keeps 18 with the warning", async () => {
    const f = fakeClient({ customer: { country: "United States", gst_treatment: "overseas" }, luts: null });
    const r = await exportQuoteRateFor({ client: f.client, tenantId: "T1", customerId: "C1", date: DATE, usualRate: 18 });
    expect(r.rate).toBe(18);
    expect(r.warning).toContain("No LUT for FY 2026-27");
  });

  it("customer read error / no customer / domestic → usual rate, LUTs not even read", async () => {
    for (const o of [{ custErr: true }, { customer: null }, { customer: { country: "India", gst_treatment: "registered_regular" } }]) {
      const f = fakeClient(o);
      const r = await exportQuoteRateFor({ client: f.client, tenantId: "T1", customerId: "C1", date: DATE, usualRate: 18 });
      expect(r.rate).toBe(18);
      expect(f.reads).not.toContain("tenant_luts");
    }
    const none = fakeClient({});
    expect((await exportQuoteRateFor({ client: none.client, tenantId: "T1", customerId: null, date: DATE, usualRate: 18 })).rate).toBe(18);
  });

  it("Bill of Supply business → usual rate (0), nothing read", async () => {
    const f = fakeClient({ customer: { country: "USA", gst_treatment: "overseas" }, luts: [LUT_ROW] });
    const r = await exportQuoteRateFor({ client: f.client, tenantId: "T1", customerId: "C1", date: DATE, usualRate: 0, billOfSupply: true });
    expect(r.rate).toBe(0);
    expect(f.reads).toHaveLength(0);
  });

  it("readTenantLuts maps rows; error → null", async () => {
    expect(await readTenantLuts(fakeClient({ luts: [LUT_ROW] }).client as never, "T1")).toEqual([
      { fyStart: "2026-04-01", arn: "AD0704260001234", validFrom: "2026-04-01", validUpto: "2027-03-31" },
    ]);
    expect(await readTenantLuts(fakeClient({ luts: null }).client as never, "T1")).toBeNull();
  });
});
