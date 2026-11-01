/**
 * R-2324 — "Import bills" on the Bills page: read a CSV of vendor (COGS) bills, preview every
 * row with a verdict, and turn the good ones into the SAME vendor_bills rows Add Bill writes.
 *
 * Why: one distributor payment can cover 40–54 COGS bills (R-2319, staging 31 Oct); typing each
 * bill by hand before reconciling the bank line is not practical.
 *
 * Two file shapes, columns found by NAME (lib/csv findColumn — case / punctuation ignored):
 *   - Zoho Books → Purchases → Bills → Export: ONE ROW PER LINE ITEM (an item column such as
 *     "Item Name" is present). A bill's rows are merged: SubTotal / Total are bill-level (must
 *     agree across its rows), CGST / SGST / IGST / Tax Amount are per line (summed).
 *   - A simple template, one row per bill: Vendor Name, Vendor GSTIN, Bill Number, Bill Date,
 *     Due Date, Taxable Value, CGST, SGST, IGST (or one GST column), Category. The same bill
 *     twice in such a file is a problem (which row is right?), never added twice.
 *
 * GST: the heads as written; else a GST total split by state (Source/Destination of Supply, else
 * vendor GSTIN state vs our state: same → CGST + SGST, different → IGST; unknown → the row asks
 * for the heads); else Total − taxable. The bill's total = taxable + GST (what the vendor bills;
 * TDS is worked out when it is paid, as for a bill added by hand).
 *
 * Vendor: GSTIN first, then the exact name. An unknown vendor is a row error — import never
 * creates vendors (a typo in a 54-row file would make a second vendor).
 * Duplicate: same vendor + bill number already in the books → "already", listed, skipped.
 *
 * Pure: the dialog passes the file text, vendors, existing bill keys and our state code.
 */
import { findColumn } from "@/lib/csv";
import { parseCsvText, parsePlaceOfSupply, parseZohoAmount, parseZohoDate } from "@/lib/import/zoho-opening-invoices";
import { isValidGstin } from "@/lib/utils";
import { normalizeGstin } from "@/lib/gst/itc";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";

export const BILL_COLUMNS = {
  vendorName: ["Vendor Name", "Vendor", "Supplier Name", "Supplier", "Party Name", "Display Name"],
  gstin: ["GST Identification Number (GSTIN)", "Vendor GSTIN", "Supplier GSTIN", "GSTIN", "GSTIN/UIN", "GST Identification Number"],
  billNo: ["Bill Number", "Bill#", "Bill No", "Bill No.", "Vendor Invoice Number", "Invoice Number", "Invoice No", "Invoice No."],
  billDate: ["Bill Date", "Invoice Date", "Date"],
  dueDate: ["Due Date"],
  /** Bill-level (Zoho repeats it on every line row). */
  subTotal: ["SubTotal", "Sub Total", "Sub-Total"],
  /** Per row (summed over a bill's rows). */
  taxable: ["Taxable Value", "Taxable Amount", "Taxable", "Assessable Value"],
  cgst: ["CGST", "CGST Amount"],
  sgst: ["SGST", "SGST Amount", "UTGST", "UTGST Amount", "SGST/UTGST"],
  igst: ["IGST", "IGST Amount"],
  gst: ["GST", "GST Amount", "Total GST", "Tax Amount", "Total Tax", "Tax"],
  total: ["Total", "Bill Total", "Invoice Total", "Total (BCY)"],
  status: ["Bill Status", "Status"],
  currency: ["Currency Code", "Currency"],
  category: ["Category", "Expense Category"],
  source: ["Source of Supply", "Source Of Supply"],
  destination: ["Destination of Supply", "Destination Of Supply", "Place of Supply", "Place Of Supply"],
} as const;

/** Any of these means one row per LINE ITEM (Zoho export): a bill's rows are merged. */
const ITEM_COLUMNS = ["Item Name", "Item Total", "Product ID", "Item Description", "Description", "Quantity", "Account"];

type ColumnKey = keyof typeof BILL_COLUMNS;
const MAX_BILLS = 500;

export interface ParsedBill {
  vendorName: string;
  gstin: string | null;
  billNo: string;
  billDate: string | null;
  dueDate: string | null;
  /** Rupees as written; null = empty / not a number. */
  taxable: number | null;
  cgst: number;
  sgst: number;
  igst: number;
  /** A GST total column (when the heads are not given). */
  gstTotal: number;
  total: number | null;
  status: string;
  currency: string;
  category: string;
  sourceCode: string | null;
  destCode: string | null;
  /** 1-based file lines (header = 1). */
  lines: number[];
  conflict: string | null;
  /** A cell that could not be read (number / date), said plainly. */
  bad: string | null;
}

export interface BillReadResult {
  bills: ParsedBill[];
  missingColumns: string[];
  rowCount: number;
  /** One row per line item (Zoho export). */
  lineItems: boolean;
  /** Which GST columns the file has. */
  has: { heads: boolean; gst: boolean; total: boolean };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const billKey = (s: string) => s.trim().toUpperCase();

export function readBillCsv(text: string): BillReadResult {
  const table = parseCsvText(text);
  const none = { heads: false, gst: false, total: false };
  if (table.length === 0) return { bills: [], missingColumns: ["Vendor Name", "Bill Number", "Bill Date", "Taxable Value (or SubTotal)"], rowCount: 0, lineItems: false, has: none };
  const headers = table[0];
  const col = {} as Record<ColumnKey, number>;
  for (const k of Object.keys(BILL_COLUMNS) as ColumnKey[]) col[k] = findColumn(headers, BILL_COLUMNS[k]);
  const missingColumns: string[] = [];
  if (col.vendorName < 0) missingColumns.push("Vendor Name");
  if (col.billNo < 0) missingColumns.push("Bill Number");
  if (col.billDate < 0) missingColumns.push("Bill Date");
  if (col.subTotal < 0 && col.taxable < 0) missingColumns.push("Taxable Value (or SubTotal)");
  const lineItems = ITEM_COLUMNS.some((c) => findColumn(headers, [c]) >= 0);
  const has = { heads: col.cgst >= 0 || col.sgst >= 0 || col.igst >= 0, gst: col.gst >= 0, total: col.total >= 0 };
  if (missingColumns.length) return { bills: [], missingColumns, rowCount: table.length - 1, lineItems, has };

  /* Zoho writes "-No Value-" in an empty cell — blank. */
  const cell = (r: string[], k: ColumnKey) => {
    const v = col[k] >= 0 ? (r[col[k]] ?? "").trim() : "";
    return v.toLowerCase() === "-no value-" ? "" : v;
  };
  /** An amount cell: empty → 0 (or null when `required`), unreadable → a problem. */
  const amount = (r: string[], k: ColumnKey, label: string, problems: string[]): number | null => {
    const raw = cell(r, k);
    if (!raw) return null;
    const n = parseZohoAmount(raw);
    if (n === null) problems.push(`${label} "${raw}" is not a number`);
    return n;
  };

  const byKey = new Map<string, ParsedBill>();
  const order: string[] = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const problems: string[] = [];
    const vendorName = cell(r, "vendorName");
    const billNo = cell(r, "billNo");
    const rawDate = cell(r, "billDate");
    const billDate = parseZohoDate(rawDate);
    if (rawDate && !billDate) problems.push(`Bill Date "${rawDate}" could not be read`);
    const rawDue = cell(r, "dueDate");
    const dueDate = parseZohoDate(rawDue);
    if (rawDue && !dueDate) problems.push(`Due Date "${rawDue}" could not be read`);
    const sub = col.subTotal >= 0 ? amount(r, "subTotal", "SubTotal", problems) : amount(r, "taxable", "Taxable Value", problems);
    const row: ParsedBill = {
      vendorName,
      gstin: normalizeGstin(cell(r, "gstin")) || null,
      billNo,
      billDate,
      dueDate,
      taxable: sub,
      cgst: amount(r, "cgst", "CGST", problems) ?? 0,
      sgst: amount(r, "sgst", "SGST", problems) ?? 0,
      igst: amount(r, "igst", "IGST", problems) ?? 0,
      gstTotal: amount(r, "gst", "GST", problems) ?? 0,
      total: amount(r, "total", "Total", problems),
      status: cell(r, "status"),
      currency: (cell(r, "currency") || "INR").toUpperCase(),
      category: cell(r, "category"),
      sourceCode: parsePlaceOfSupply(cell(r, "source")),
      destCode: parsePlaceOfSupply(cell(r, "destination")),
      lines: [i + 1],
      conflict: null,
      bad: problems.length ? problems.join("; ") : null,
    };
    /* A row without a vendor or bill number cannot be grouped — it stands alone (and is a problem). */
    const key = vendorName && billNo ? `${norm(vendorName)}|${billKey(billNo)}` : `#${i}`;
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, row); order.push(key); continue; }
    seen.lines.push(i + 1);
    if (!seen.bad && row.bad) seen.bad = row.bad;
    if (!lineItems) {
      seen.conflict ??= `bill ${billNo} of ${vendorName} appears twice in this file (lines ${seen.lines.join(", ")}) — keep one row per bill`;
      continue;
    }
    // Line rows of one bill: line-level figures add up; bill-level ones must agree.
    seen.cgst += row.cgst; seen.sgst += row.sgst; seen.igst += row.igst; seen.gstTotal += row.gstTotal;
    if (col.subTotal < 0) seen.taxable = row.taxable === null || seen.taxable === null ? null : seen.taxable + row.taxable;
    else if (!seen.conflict && seen.taxable !== row.taxable) seen.conflict = "its rows show different SubTotal";
    if (!seen.conflict && seen.total !== row.total) seen.conflict = "its rows show different Total";
    if (!seen.conflict && seen.billDate !== row.billDate) seen.conflict = "its rows show different bill dates";
  }
  return { bills: order.map((k) => byKey.get(k)!), missingColumns: [], rowCount: table.length - 1, lineItems, has };
}

// ── Preview ──────────────────────────────────────────────────────────────────────────

export interface VendorLite { id: string; name: string; gstin: string | null; default_category: string | null }
/** A bill already in the books (vendor_bills), for the duplicate check. */
export interface ExistingBillKey { vendor_id: string | null; vendor_name: string; bill_no: string | null }

export type BillVerdict = "import" | "already" | "no_vendor" | "problem" | "skipped";

export interface BillPreviewRow {
  billNo: string;
  /** As written in the file. */
  fileVendor: string;
  vendorId: string | null;
  /** Our vendor's name (when matched), else the file's. */
  vendorName: string;
  vendorGstin: string | null;
  matchedBy: "gstin" | "name" | null;
  billDate: string | null;
  dueDate: string | null;
  category: string;
  /** Whole rupees. */
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  lines: number[];
  verdict: BillVerdict;
  message: string | null;
  /** Shown, does not block. */
  notes: string[];
}

export interface BillPreview {
  rows: BillPreviewRow[];
  toImport: BillPreviewRow[];
  totalAmount: number;
  counts: { import: number; already: number; noVendor: number; problem: number; skipped: number };
}

const R = (n: number) => Math.round(n);
const hasPaise = (n: number | null) => n !== null && R(n * 100) % 100 !== 0;

export function buildBillImportPreview(
  bills: readonly ParsedBill[],
  vendors: readonly VendorLite[],
  existing: readonly ExistingBillKey[],
  ownStateCode: string | null,
): BillPreview {
  const byGstin = new Map<string, VendorLite>();
  const byName = new Map<string, VendorLite[]>();
  for (const v of vendors) {
    const g = normalizeGstin(v.gstin);
    if (g) byGstin.set(g, v);
    const n = norm(v.name);
    byName.set(n, [...(byName.get(n) ?? []), v]);
  }
  const have = new Set<string>();
  for (const e of existing) {
    if (!e.bill_no) continue;
    if (e.vendor_id) have.add(`id:${e.vendor_id}|${billKey(e.bill_no)}`);
    have.add(`name:${norm(e.vendor_name)}|${billKey(e.bill_no)}`);
  }
  const counts = { import: 0, already: 0, noVendor: 0, problem: 0, skipped: 0 };
  const rows: BillPreviewRow[] = [];

  for (const b of bills) {
    const notes: string[] = [];
    // Vendor: GSTIN first, then the exact name.
    let vendor: VendorLite | null = null;
    let matchedBy: BillPreviewRow["matchedBy"] = null;
    let vendorProblem: string | null = null;
    if (b.gstin && byGstin.has(b.gstin)) { vendor = byGstin.get(b.gstin)!; matchedBy = "gstin"; }
    if (!vendor && b.vendorName) {
      const same = byName.get(norm(b.vendorName)) ?? [];
      if (same.length === 1) { vendor = same[0]; matchedBy = "name"; }
      else if (same.length > 1) vendorProblem = `${same.length} vendors are named "${b.vendorName}". Add the vendor's GSTIN to the file (or to the right vendor in Vendors), then upload again.`;
    }
    if (vendor && matchedBy === "name" && b.gstin && isValidGstin(b.gstin) && vendor.gstin && normalizeGstin(vendor.gstin) !== b.gstin) {
      vendorProblem = `The file's GSTIN ${b.gstin} is not the GSTIN saved on ${vendor.name} (${normalizeGstin(vendor.gstin)}). Check which vendor this bill is from.`;
      vendor = null; matchedBy = null;
    }
    const vendorGstin = (vendor ? normalizeGstin(vendor.gstin) : "") || (b.gstin && isValidGstin(b.gstin) ? b.gstin : "") || null;

    // Amounts and GST.
    let problem: string | null = null;
    const st = b.status.toLowerCase().replace(/[\s_-]/g, "");
    let taxable = 0, cgst = 0, sgst = 0, igst = 0;
    if (!b.vendorName) problem = "The vendor name is empty.";
    else if (!b.billNo) problem = "The bill number is empty — it is how a second upload knows the bill is already in.";
    else if (b.conflict) problem = `${b.conflict[0].toUpperCase()}${b.conflict.slice(1)}.`;
    else if (b.bad) problem = `${b.bad}.`;
    else if (!b.billDate) problem = "The Bill Date is empty.";
    else if (b.currency !== "INR") problem = `This bill is in ${b.currency}. Only rupee (INR) bills can be imported — add it with Add Bill (it asks the exchange rate).`;
    else if (b.taxable === null) problem = "The taxable value is empty.";
    else if (b.taxable <= 0) problem = "The taxable value must be more than ₹0.";
    else if ([b.cgst, b.sgst, b.igst, b.gstTotal, b.total ?? 0].some((n) => n < 0)) problem = "A GST or Total amount is negative.";
    else if (b.billNo.length > 60) problem = "The bill number is longer than 60 characters.";
    if (!problem) {
      taxable = R(b.taxable!);
      const heads = b.cgst + b.sgst + b.igst;
      let gstToSplit: number | null = null;
      if (heads > 0) { cgst = R(b.cgst); sgst = R(b.sgst); igst = R(b.igst); }
      else if (b.gstTotal > 0) gstToSplit = b.gstTotal;
      else if (b.total !== null && b.total > b.taxable!) gstToSplit = b.total - b.taxable!;
      else if (b.total !== null && b.total < b.taxable!) problem = `Total ${b.total} is less than the taxable value ${b.taxable}.`;
      if (gstToSplit !== null) {
        const vendorState = stateCodeFromGstin(vendorGstin);
        const inter = b.sourceCode && b.destCode ? b.sourceCode !== b.destCode
          : vendorState && ownStateCode ? vendorState !== ownStateCode : null;
        if (inter === null) problem = "Cannot tell CGST + SGST from IGST for this bill — add CGST, SGST and IGST columns, or the vendor's GSTIN.";
        else if (inter) igst = R(gstToSplit);
        else { const g = R(gstToSplit); cgst = R(g / 2); sgst = g - cgst; }
      }
      if (!problem && [b.taxable, b.cgst, b.sgst, b.igst, b.gstTotal].some(hasPaise)) notes.push("Amounts rounded to whole rupees, as on a bill added by hand.");
    }
    const total = taxable + cgst + sgst + igst;
    if (!problem && b.total !== null && Math.abs(R(b.total) - total) > 1) {
      notes.push(`The file's Total ${R(b.total)} differs from taxable + GST ${total} (TDS or an adjustment in the source?) — the bill is booked at ${total}; TDS is worked out when it is paid.`);
    }
    if (!problem && /^(paid|closed)$/.test(st)) notes.push("Marked paid in the file — it comes in unpaid; reconcile its bank payment to settle it.");
    if (!problem && cgst > 0 && igst > 0) notes.push("Has both CGST/SGST and IGST — check the heads.");

    const category = b.category.trim().length >= 2 ? b.category.trim()
      : vendor?.default_category?.startsWith("COGS-") ? vendor.default_category : "COGS-Other";
    const already = b.billNo && (
      (vendor && have.has(`id:${vendor.id}|${billKey(b.billNo)}`))
      || have.has(`name:${norm(vendor?.name ?? b.vendorName)}|${billKey(b.billNo)}`)
      || have.has(`name:${norm(b.vendorName)}|${billKey(b.billNo)}`));

    let verdict: BillVerdict;
    let message: string | null = null;
    if (st === "void" || st === "draft") { verdict = "skipped"; message = `${b.status} in the file — not imported.`; counts.skipped++; }
    else if (already) { verdict = "already"; message = `Bill ${b.billNo} of ${vendor?.name ?? b.vendorName} is already in the books — skipped.`; counts.already++; }
    else if (problem) { verdict = "problem"; message = problem; counts.problem++; }
    else if (vendorProblem) { verdict = "problem"; message = vendorProblem; counts.problem++; }
    else if (!vendor) {
      verdict = "no_vendor";
      message = `Vendor "${b.vendorName}"${b.gstin ? ` (GSTIN ${b.gstin})` : ""} not found. Add it on the Vendors page (or fix the name in the file), then upload again.`;
      counts.noVendor++;
    } else { verdict = "import"; counts.import++; }

    rows.push({
      billNo: b.billNo, fileVendor: b.vendorName, vendorId: vendor?.id ?? null, vendorName: vendor?.name ?? b.vendorName,
      vendorGstin, matchedBy, billDate: b.billDate, dueDate: b.dueDate, category,
      taxable, cgst, sgst, igst, total, lines: b.lines, verdict, message, notes,
    });
  }
  if (counts.import > MAX_BILLS) {
    for (const r of rows) if (r.verdict === "import") { r.verdict = "problem"; r.message = `More than ${MAX_BILLS} bills in one file — split it into smaller files.`; }
    counts.problem += counts.import; counts.import = 0;
  }
  const toImport = rows.filter((r) => r.verdict === "import");
  return { rows, toImport, totalAmount: toImport.reduce((s, r) => s + r.total, 0), counts };
}

/**
 * The vendor_bills rows to insert — the same fields Add Bill (add-vendor-bill-dialog) writes for
 * an INR tax invoice: unpaid, fx 1, document_type tax_invoice, vendor linked. `stamp` makes the
 * ids (`BILL-<stamp>-I001…`): unique within the batch, and a new stamp per import.
 */
export function toVendorBillInserts(rows: readonly BillPreviewRow[], opts: { fileName: string; stamp: string }) {
  return rows.filter((r) => r.verdict === "import" && r.vendorId && r.billDate).map((r, i) => ({
    id: `BILL-${opts.stamp}-I${String(i + 1).padStart(3, "0")}`,
    vendor_id: r.vendorId,
    vendor_name: r.vendorName,
    vendor_gstin: r.vendorGstin,
    bill_no: r.billNo,
    bill_date: r.billDate!,
    due_date: r.dueDate,
    category: r.category,
    currency: "INR",
    fx_rate: 1,
    subtotal: r.taxable,
    cgst: r.cgst,
    sgst: r.sgst,
    igst: r.igst,
    total: r.total,
    notes: `Imported from ${opts.fileName.slice(0, 120)}.`,
    status: "unpaid",
    document_type: "tax_invoice",
    line_items: [] as never[],
    attachment_url: null,
  }));
}

/** Made-up sample (also docs/samples/bill-import-sample.csv) — "Download a sample" in the dialog. */
export const SAMPLE_BILL_CSV = [
  "Vendor Name,Vendor GSTIN,Bill Number,Bill Date,Due Date,Taxable Value,CGST,SGST,IGST,Category",
  "Mehta Cloud Distributors,,MCD-24001,2026-09-02,2026-10-02,40000,3600,3600,0,COGS-Workspace",
  "Mehta Cloud Distributors,,MCD-24002,2026-09-05,2026-10-05,25000,2250,2250,0,COGS-Workspace",
  "Mehta Cloud Distributors,,MCD-24003,2026-09-09,2026-10-09,10000,900,900,0,COGS-Workspace",
  "T-Unknown Supplier,,UNK-1,2026-09-10,,5000,0,0,900,",
].join("\n") + "\n";
