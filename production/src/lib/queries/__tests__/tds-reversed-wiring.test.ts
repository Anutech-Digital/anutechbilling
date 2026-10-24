/**
 * R-1567 / R-1568 (18 Oct 2026): refund_payment and delete_payment now set the TDS receivable
 * of a refunded / deleted payment to status 'reversed' (migration
 * 20261018164416_r1567_refund_delete_payment_credit.sql). The SQL reports already count only
 * pending_cert / cert_received / verified_26as. The app's own readers must leave reversed rows
 * out too — otherwise the TDS page, its KPI strip, 26AS matching and the ITR estimate would
 * still show a credit for money that was given back or never came in.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

/** Each `.from("tds_receivable")` read chain (up to the next statement end) in a file. */
function tdsReads(src: string): string[] {
  const out: string[] = [];
  let i = src.indexOf('.from("tds_receivable")');
  while (i !== -1) {
    const chain = src.slice(i, src.indexOf(";", i) === -1 ? undefined : src.indexOf(";", i));
    if (/\.select\(/.test(chain) && !/\.(update|insert|delete|upsert)\(/.test(chain)) out.push(chain);
    i = src.indexOf('.from("tds_receivable")', i + 1);
  }
  return out;
}

describe("R-1567: reversed TDS receivable rows are not counted", () => {
  it("the TDS list and KPI summary skip reversed rows", () => {
    const src = read("src/lib/queries/tds-receivable.ts");
    expect(src).toMatch(/export const TDS_REVERSED_STATUS = "reversed";/);
    // The list (select *) and the KPI strip; useTdsForPayment keeps reversed rows on purpose —
    // a receipt shows the TDS deducted on that payment at the time.
    const reads = tdsReads(src).filter((r) => /\.select\("(\*|status, tds_amount, fiscal_year)"\)/.test(r));
    expect(reads.length).toBe(2);
    for (const r of reads) expect(r).toMatch(/\.filter\("status", "neq", TDS_REVERSED_STATUS\)/);
  });

  it("the ITR estimate does not claim reversed TDS", () => {
    const reads = tdsReads(read("src/lib/queries/itr.ts"));
    expect(reads.length).toBe(1);
    expect(reads[0]).toMatch(/\.filter\("status", "neq", "reversed"\)/);
  });

  it("the migration reverses TDS on refund and on delete", () => {
    const mig = read("supabase/migrations/20261018164416_r1567_refund_delete_payment_credit.sql");
    const reversals = mig.match(/update public\.tds_receivable\s+set status = 'reversed'/g) ?? [];
    expect(reversals.length).toBe(2);
  });
});
