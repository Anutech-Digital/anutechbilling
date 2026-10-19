import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { TDS_SECTION_RATES } from "./tds-rates";
import { TDS_194H_RATE_PCT } from "./commission-tds";

/**
 * R-1583 (P1) — partner commission TDS (s.194H) is 2% since 1 Oct 2024, not 5%.
 *
 * The commission is accrued in SQL (trg_accrue_referral_commission on payments,
 * trg_accrue_referral_commission_project on project payments), so the rate the app's
 * TDS_SECTION_RATES says cannot be imported there. This guard reads the LATEST definition
 * of each piece from the migrations (falling back to baseline.sql) and checks:
 *   - public.tds_194h_default_rate() returns TDS_SECTION_RATES["194H"].ratePct;
 *   - both accrue functions fall back to that helper, never to a literal 5;
 *   - referral_partners / referral_agreements.tds_rate default to the helper.
 * An explicit rate on the agreement still wins (the functions read v_agr.tds_rate first);
 * supabase/tests/r1583_194h_tds_default.test.sql proves that against a real database.
 */

const ROOT = path.resolve(__dirname, "../../..");
const MIG_DIR = path.join(ROOT, "supabase/migrations");
const sources: Array<[string, string]> = [
  ["baseline.sql", fs.readFileSync(path.join(ROOT, "supabase/baseline.sql"), "utf8")],
  ...fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()
    .map((f): [string, string] => [f, fs.readFileSync(path.join(MIG_DIR, f), "utf8")]),
];

/** Body of the last `create or replace function public.<name>(` across baseline + migrations. */
function latestFunction(name: string): { file: string; body: string } | null {
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+"?public"?\\."?${name}"?\\s*\\(`, "i");
  let found: { file: string; body: string } | null = null;
  for (const [file, src] of sources) {
    const m = re.exec(src);
    if (!m) continue;
    const start = m.index;
    const open = src.indexOf("$$", start);
    const close = src.indexOf("$$", open + 2);
    if (open < 0 || close < 0) continue;
    found = { file, body: src.slice(start, close + 2) };
  }
  return found;
}

/** The last `alter column tds_rate set default <expr>` for a table (or the CREATE TABLE default). */
function latestDefault(table: string): string | null {
  const re = new RegExp(`alter\\s+table\\s+(?:only\\s+)?"?public"?\\."?${table}"?\\s+alter\\s+column\\s+"?tds_rate"?\\s+set\\s+default\\s+([^;]+);`, "gi");
  let last: string | null = null;
  for (const [, src] of sources) {
    for (const m of src.matchAll(re)) last = m[1].trim();
  }
  return last;
}

describe("R-1583 — new partner commissions default to the 194H rate (2%), not 5%", () => {
  it("the app's own 194H rate is 2%", () => {
    expect(TDS_SECTION_RATES["194H"].ratePct).toBe(2);
    expect(TDS_194H_RATE_PCT).toBe(TDS_SECTION_RATES["194H"].ratePct);
  });

  it("public.tds_194h_default_rate() returns TDS_SECTION_RATES['194H']", () => {
    const fn = latestFunction("tds_194h_default_rate");
    expect(fn, "no migration defines public.tds_194h_default_rate()").not.toBeNull();
    const m = /select\s+([\d.]+)::numeric/i.exec(fn!.body);
    expect(m && Number(m[1])).toBe(TDS_SECTION_RATES["194H"].ratePct);
  });

  for (const name of ["fn_accrue_referral_commission", "fn_accrue_referral_commission_project"]) {
    it(`${name} falls back to the helper, never to a literal rate`, () => {
      const fn = latestFunction(name);
      expect(fn).not.toBeNull();
      expect(fn!.body, `${fn!.file}: literal 5% fallback`).not.toMatch(/coalesce\(\s*v_agr\.tds_rate\s*,\s*\d/i);
      expect(fn!.body).toMatch(/coalesce\(\s*v_agr\.tds_rate\s*,\s*public\.tds_194h_default_rate\(\)\s*\)/i);
    });
  }

  it("the R-1583 migration never rewrites existing partners, agreements or commissions", () => {
    const own = sources.filter(([f]) => /_r1583_/.test(f));
    expect(own.length).toBe(1);
    expect(own[0][1]).not.toMatch(/\bupdate\s+(?:public\.)?referral_(?:partners|agreements|commissions)\b/i);
    expect(own[0][1]).not.toMatch(/\bdelete\s+from\s+(?:public\.)?referral_/i);
  });

  for (const table of ["referral_partners", "referral_agreements"]) {
    it(`${table}.tds_rate defaults to the helper`, () => {
      expect(latestDefault(table)).toMatch(/^public\.tds_194h_default_rate\(\)$/i);
    });
  }
});
