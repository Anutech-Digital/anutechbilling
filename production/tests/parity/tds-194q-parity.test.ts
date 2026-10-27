/**
 * R-1891: the 194Q numbers live in two places — the database works out a COGS bill's TDS
 * (vendor_bill_194q_calc, migration 20261024230000) and the app's TDS config shows / applies 194Q
 * on expense bills (lib/accounting/tds-rates.ts, tds-deductor.ts). They must be the same law:
 * ₹50 lakh, 0.1%, 5% without PAN (incometaxindia.gov.in "TDS on Purchase of Goods").
 * DB-free: reads the migration text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TDS_SECTION_RATES } from "@/lib/accounting/tds-rates";
import { TDS_THRESHOLDS, tdsDecision } from "@/lib/accounting/tds-deductor";

const sql = readFileSync(join(__dirname, "..", "..", "supabase/migrations/20261024230000_r1891_cogs_bill_194q.sql"), "utf8");
const constant = (name: string) => {
  const m = sql.match(new RegExp(`${name}\\s+constant\\s+\\w+\\s*:=\\s*([0-9.]+)`));
  if (!m) throw new Error(`${name} not in the migration`);
  return Number(m[1]);
};

describe("194Q: database = app TDS config", () => {
  it("₹50 lakh limit", () => expect(constant("c_limit")).toBe(TDS_THRESHOLDS["194Q"].aggregate));
  it("0.1% rate", () => expect(constant("c_rate")).toBe(TDS_SECTION_RATES["194Q"].ratePct));
  it("5% without PAN", () => {
    expect(constant("c_no_pan")).toBe(tdsDecision({ section: "194Q", base: 1, fyBaseSoFar: 5_000_000, fyBaseWithoutTds: 0, pan: null }).ratePct);
  });
  it("only the part above the limit", () => expect(TDS_THRESHOLDS["194Q"].onlyAbove).toBe(true));
});
