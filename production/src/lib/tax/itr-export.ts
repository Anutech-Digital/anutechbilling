/**
 * ITR pack ka CSV — CA ko dene wali ek file.
 *
 * Excel nahi, CSV: is repo ka tay kiya hua raasta (lib/accounting/
 * ledger-export.ts:4 — xlsx dependency jaan-boojhkar nahi hai; CSV Excel me
 * waise hi khulta hai). Amounts KACCHE integer rupaye hain, formatted string
 * nahi — taki Excel unhe jod sake (lib/csv.ts:1 ka niyam).
 *
 * GAPS bhi file me hain, aankdo ke barabar. CA ko sirf jod nahi, ye bhi
 * chahiye ki kya IS FILE ME NAHI hai — warna wo ise poora maan kar sign
 * karne ki taraf badhta hai.
 */
import type { ItrPack } from "./itr";

export const ITR_CSV_HEADERS = ["Section", "Item", "Amount (₹)", "Rows", "Detail"] as const;

type Cell = string | number;

export function itrCsvRows(p: ItrPack): Cell[][] {
  const rows: Cell[][] = [];
  const add = (section: string, item: string, amount: Cell, count: Cell, detail: string) =>
    rows.push([section, item, amount, count, detail]);

  add("Period", p.fy.label, "", "", `${p.fy.start} to ${p.fy.end} · ${p.fy.assessmentYear} · ITR due ${p.fy.itrDue}`);

  for (const l of p.pnl) {
    add(l.kind === "income" ? "Income" : "Expense", l.label, l.amount, l.count, l.source);
  }
  add("Total", "Total income", p.totalIncome, "", "");
  add("Total", "Total expenses", p.totalExpense, "", "");
  add("Total", "Book profit", p.bookProfit, "", p.bookProfit < 0 ? "LOSS — the return must be filed on time to carry it forward" : "");
  add("Computation", "Taxable income (288A round)", p.taxableIncome, "", "Estimate — the CA will finalise it after adding depreciation/disallowances");

  for (const e of p.estimates) {
    add("Tax estimate", `${e.regimeLabel} — base`, e.baseTax, "", `${e.ratePct}%`);
    add("Tax estimate", `${e.regimeLabel} — surcharge`, e.surcharge, "", "");
    add("Tax estimate", `${e.regimeLabel} — cess 4%`, e.cess, "", "");
    add("Tax estimate", `${e.regimeLabel} — TOTAL`, e.total, "", p.cheaperEstimate?.regime === e.regime ? "lower one — schedule is based on this" : "");
  }

  add("Credits", "TDS receivable (this FY)", -p.sources.tdsCredit, "", "tds_receivable — the CA will match it with 26AS/AIS");
  add("Computation", "Net payable (after TDS)", p.netPayableAfterTds, "", "");

  if (p.advanceTaxRequired) {
    for (const i of p.advanceTaxSchedule) {
      add("Advance tax", `By ${i.label} (cumulative ${i.cumulativePct}%)`, i.cumulativeDue, "", i.dueDate);
    }
  } else {
    add("Advance tax", "Not required", "", "", "Section 208 — net payable is below ₹10,000");
  }

  p.gaps.forEach((g, idx) => add("GAP", `#${idx + 1}`, "", "", g));

  return rows;
}
