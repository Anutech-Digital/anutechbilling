/**
 * GSTR-2B reconciliation — the portal's list of what suppliers reported against what
 * the books claim as input tax credit.
 *
 * Since 1 Jan 2022 (s.16(2)(aa)) credit can be taken ONLY for invoices that appear in
 * GSTR-2B. So the month's ITC is not "what we paid" but "what we paid AND the supplier
 * filed". This takes the 2B JSON downloaded from the portal (Returns → GSTR-2B →
 * Download JSON) and the period's books rows, and sorts every invoice into:
 *
 *   matched         — same supplier GSTIN, same invoice number (loosely), tax agrees
 *   amount differs  — found, but the tax differs (typo, rounding, partial bill)
 *   only in 2B      — supplier filed it, the books never recorded it (missing bill!)
 *   only in books   — we claimed it, the supplier has not filed — NOT claimable this month
 *
 * Nothing is written back; the page shows the lists and the claimable total, and the
 * 3B worksheet is what the owner types. Matching is deliberately simple — GSTIN +
 * normalised invoice number, then GSTIN + tax amount as a fallback — because a
 * cleverer matcher that is wrong once costs more than a list the owner reads.
 */

export interface Gstr2bInvoice {
  gstin: string;            // supplier
  supplierName?: string;
  invoiceNo: string;
  date: string | null;      // YYYY-MM-DD
  value: number;
  taxable: number;
  igst: number; cgst: number; sgst: number;
  itcAvailable: boolean;    // 2B "itcavl" = Y
}

export interface BooksItcRow {
  id: string;
  source: "bill" | "expense";
  vendor: string;
  vendorGstin: string | null;
  billNo: string | null;
  date: string;
  taxable: number;
  igst: number; cgst: number; sgst: number;
}

const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const tax = (r: { igst: number; cgst: number; sgst: number }) => (r.igst || 0) + (r.cgst || 0) + (r.sgst || 0);

/** Parse the portal's GSTR-2B JSON (both the download envelope and a bare `data`). */
export function parseGstr2b(json: unknown): { period: string | null; invoices: Gstr2bInvoice[]; errors: string[] } {
  const errors: string[] = [];
  const root = (json as { data?: unknown })?.data ?? json;
  const d = root as { rtnprd?: string; docdata?: { b2b?: unknown[] }; b2b?: unknown[] };
  const b2b = (d?.docdata?.b2b ?? d?.b2b ?? []) as { ctin?: string; trdnm?: string; inv?: unknown[] }[];
  if (!Array.isArray(b2b)) return { period: null, invoices: [], errors: ["docdata.b2b was not found in the JSON — this does not look like a GSTR-2B JSON."] };
  const invoices: Gstr2bInvoice[] = [];
  for (const sup of b2b) {
    const gstin = String(sup.ctin ?? "").toUpperCase();
    for (const raw of (sup.inv ?? []) as Record<string, unknown>[]) {
      const items = (raw.items ?? raw.itms ?? []) as { det?: Record<string, number>; itm_det?: Record<string, number> }[];
      let taxable = 0, igst = 0, cgst = 0, sgst = 0;
      for (const it of items) {
        const det = it.det ?? it.itm_det ?? {};
        taxable += Number(det.txval ?? 0); igst += Number(det.igst ?? det.iamt ?? 0); cgst += Number(det.cgst ?? det.camt ?? 0); sgst += Number(det.sgst ?? det.samt ?? 0);
      }
      const dt = String(raw.dt ?? raw.idt ?? "");
      const m = dt.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      invoices.push({
        gstin, supplierName: sup.trdnm, invoiceNo: String(raw.inum ?? ""), date: m ? `${m[3]}-${m[2]}-${m[1]}` : null,
        value: Number(raw.val ?? 0), taxable: Math.round(taxable), igst: Math.round(igst), cgst: Math.round(cgst), sgst: Math.round(sgst),
        itcAvailable: String(raw.itcavl ?? "Y").toUpperCase() !== "N",
      });
    }
  }
  return { period: d?.rtnprd ?? null, invoices, errors };
}

export interface Reconciliation {
  matched: { b2b: Gstr2bInvoice; book: BooksItcRow }[];
  amountDiffers: { b2b: Gstr2bInvoice; book: BooksItcRow; diff: number }[];
  onlyIn2b: Gstr2bInvoice[];
  onlyInBooks: BooksItcRow[];
  /** ITC the books may claim this month: matched + differing (at the 2B figure), where 2B says available. */
  claimable: { igst: number; cgst: number; sgst: number; total: number };
  /** ITC the books have that 2B does not support — hold it. */
  held: number;
  /** Tax in 2B nobody booked — go find the bill. */
  unbooked: number;
}

export function reconcile2b(b2b: Gstr2bInvoice[], books: BooksItcRow[]): Reconciliation {
  const left = [...b2b];
  const matched: Reconciliation["matched"] = [];
  const amountDiffers: Reconciliation["amountDiffers"] = [];
  const onlyInBooks: BooksItcRow[] = [];
  const take = (pred: (x: Gstr2bInvoice) => boolean) => { const i = left.findIndex(pred); return i < 0 ? null : left.splice(i, 1)[0]; };

  for (const row of books) {
    const g = norm(row.vendorGstin);
    if (!g) { onlyInBooks.push(row); continue; }
    const byNo = row.billNo ? take((x) => norm(x.gstin) === g && norm(x.invoiceNo) === norm(row.billNo)) : null;
    const hit = byNo ?? take((x) => norm(x.gstin) === g && tax(x) === tax(row));
    if (!hit) { onlyInBooks.push(row); continue; }
    const diff = tax(hit) - tax(row);
    if (diff === 0) matched.push({ b2b: hit, book: row }); else amountDiffers.push({ b2b: hit, book: row, diff });
  }
  const claimRows = [...matched.map((m) => m.b2b), ...amountDiffers.map((m) => m.b2b)].filter((x) => x.itcAvailable);
  const claimable = claimRows.reduce((s, x) => ({ igst: s.igst + x.igst, cgst: s.cgst + x.cgst, sgst: s.sgst + x.sgst, total: s.total + tax(x) }), { igst: 0, cgst: 0, sgst: 0, total: 0 });
  return {
    matched, amountDiffers, onlyIn2b: left, onlyInBooks, claimable,
    held: onlyInBooks.reduce((s, r) => s + tax(r), 0),
    unbooked: left.reduce((s, x) => s + tax(x), 0),
  };
}
