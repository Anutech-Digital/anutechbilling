/**
 * R-1739 — read a Zoho Books invoice export (CSV) into the open invoices to bring over.
 *
 * Zoho Books → Sales → Invoices → Export writes ONE ROW PER LINE ITEM: an invoice with three
 * items is three rows that repeat its number, dates, customer, Total and Balance. So rows are
 * grouped by Invoice Number, and the invoice-level figures must agree across its rows.
 *
 * Columns are found by NAME (case and punctuation ignored — lib/csv normHeader), never by
 * position; the usual variants are listed most-specific first.
 *
 * Pure: the dialog passes the file text, the company's customers and the Zoho numbers
 * already imported; it gets back every row with a verdict. Nothing is dropped silently
 * (label-and-logic-check §2e): a row is "import", "already imported", "customer not found",
 * "problem" or counted as "nothing due".
 */
import { findColumn } from "@/lib/csv";
import { GST_STATE_BY_CODE, isValidGstin } from "@/lib/utils";

export const ZOHO_COLUMNS = {
  number: ["Invoice Number", "Invoice#", "Invoice No", "Invoice No.", "Invoice"],
  invoiceDate: ["Invoice Date", "Date"],
  dueDate: ["Due Date"],
  customerName: ["Customer Name", "Display Name", "Customer", "Company Name"],
  gstin: ["GST Identification Number (GSTIN)", "GST Identification Number", "GSTIN", "GSTIN/UIN", "Customer GSTIN"],
  placeOfSupply: ["Place of Supply", "Place Of Supply(With State Code)", "Place of Supply (With State Code)", "POS"],
  total: ["Total", "Invoice Total", "Total (BCY)", "Total (FCY)"],
  balance: ["Balance", "Balance Due", "Balance (BCY)", "Amount Due"],
  status: ["Invoice Status", "Status"],
  currency: ["Currency Code", "Currency"],
} as const;

type ColumnKey = keyof typeof ZOHO_COLUMNS;
const REQUIRED: readonly ColumnKey[] = ["number", "invoiceDate", "customerName", "total", "balance"];
const COLUMN_LABEL: Record<ColumnKey, string> = {
  number: "Invoice Number", invoiceDate: "Invoice Date", dueDate: "Due Date", customerName: "Customer Name",
  gstin: "GST Identification Number (GSTIN)", placeOfSupply: "Place of Supply", total: "Total",
  balance: "Balance", status: "Invoice Status", currency: "Currency Code",
};

/** One invoice from the file (its rows merged). Money in rupees as written (may have paise). */
export interface ZohoInvoice {
  number: string;
  /** YYYY-MM-DD, null when the cell could not be read. */
  invoiceDate: string | null;
  dueDate: string | null;
  customerName: string;
  gstin: string | null;
  /** GST state code "07", null when absent / unreadable. */
  placeOfSupply: string | null;
  total: number | null;
  balance: number | null;
  status: string;
  currency: string;
  /** 1-based line numbers of the file this invoice came from (header = line 1). */
  lines: number[];
  /** The invoice's rows disagree on an invoice-level field. */
  conflict: string | null;
}

export interface ZohoReadResult {
  invoices: ZohoInvoice[];
  /** Required columns not found — the file cannot be read until they are there. */
  missingColumns: string[];
  /** Data rows read (line items). */
  rowCount: number;
}

/** RFC 4180 CSV — quoted fields may hold commas, quotes ("") and line breaks (Zoho notes do). */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      rows.push(row); row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length > 0) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ""));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function monthOf(name: string): number | undefined {
  const n = name.toLowerCase();
  return MONTHS[n.slice(0, 4)] ?? MONTHS[n.slice(0, 3)];
}

function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Zoho's date formats: 2026-08-16, 16/08/2026, 16-08-2026, 16.08.2026, 16 Aug 2026, Aug 16, 2026.
 *  A slash / dash date is read day-first (Indian organisations). */
export function parseZohoDate(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s,-]+(\d{2,4})$/.exec(t);
  if (m && monthOf(m[2])) return ymd(+m[3], monthOf(m[2])!, +m[1]);
  m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(t);
  if (m && monthOf(m[1])) return ymd(+m[3], monthOf(m[1])!, +m[2]);
  return null;
}

/** "₹59,000.00", "59000", "INR 1,18,000.50" → number; "" / garbage → null. */
export function parseZohoAmount(v: string | null | undefined): number | null {
  const t = (v ?? "").replace(/[₹,\s]|INR|Rs\.?/gi, "").trim();
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Zoho's two-letter state abbreviations (Place of Supply) → GST state code. */
const ZOHO_STATE_ABBR: Record<string, string> = {
  JK: "01", HP: "02", PB: "03", CH: "04", UK: "05", UT: "05", HR: "06", DL: "07", RJ: "08", UP: "09",
  BR: "10", SK: "11", AR: "12", NL: "13", MN: "14", MZ: "15", TR: "16", ML: "17", AS: "18", WB: "19",
  JH: "20", OD: "21", OR: "21", CG: "22", CT: "22", MP: "23", GJ: "24", DD: "25", DN: "26", MH: "27",
  KA: "29", GA: "30", LD: "31", KL: "32", TN: "33", PY: "34", AN: "35", TS: "36", TG: "36", AP: "37", LA: "38",
};

/** "DL", "07", "07-Delhi", "Delhi (07)", "Delhi" → "07"; anything else → null. */
export function parsePlaceOfSupply(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  const code = /\b(\d{2})\b/.exec(t)?.[1];
  if (code && GST_STATE_BY_CODE[code]) return code;
  const abbr = ZOHO_STATE_ABBR[t.toUpperCase()];
  if (abbr) return abbr;
  const name = t.replace(/\s*\(.*\)\s*$/, "").toLowerCase();
  for (const [c, n] of Object.entries(GST_STATE_BY_CODE)) if (n.toLowerCase() === name) return c;
  return null;
}

/** Read the file. Line items of one invoice are merged into one ZohoInvoice. */
export function readZohoInvoiceCsv(text: string): ZohoReadResult {
  const table = parseCsvText(text);
  if (table.length === 0) return { invoices: [], missingColumns: REQUIRED.map((k) => COLUMN_LABEL[k]), rowCount: 0 };
  const headers = table[0];
  const col = {} as Record<ColumnKey, number>;
  for (const k of Object.keys(ZOHO_COLUMNS) as ColumnKey[]) col[k] = findColumn(headers, ZOHO_COLUMNS[k]);
  const missingColumns = REQUIRED.filter((k) => col[k] < 0).map((k) => COLUMN_LABEL[k]);
  if (missingColumns.length) return { invoices: [], missingColumns, rowCount: table.length - 1 };

  /* Zoho writes "-No Value-" in an empty cell — blank. */
  const cell = (r: string[], k: ColumnKey) => {
    const v = col[k] >= 0 ? (r[col[k]] ?? "").trim() : "";
    return v.toLowerCase() === "-no value-" ? "" : v;
  };
  const byNumber = new Map<string, ZohoInvoice>();
  const order: string[] = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const number = cell(r, "number");
    if (!number) continue;
    const key = number.toUpperCase();
    const inv: ZohoInvoice = {
      number,
      invoiceDate: parseZohoDate(cell(r, "invoiceDate")),
      dueDate: parseZohoDate(cell(r, "dueDate")),
      customerName: cell(r, "customerName"),
      gstin: cell(r, "gstin").toUpperCase() || null,
      placeOfSupply: parsePlaceOfSupply(cell(r, "placeOfSupply")),
      total: parseZohoAmount(cell(r, "total")),
      balance: parseZohoAmount(cell(r, "balance")),
      status: cell(r, "status"),
      currency: (cell(r, "currency") || "INR").toUpperCase(),
      lines: [i + 1],
      conflict: null,
    };
    const seen = byNumber.get(key);
    if (!seen) { byNumber.set(key, inv); order.push(key); continue; }
    seen.lines.push(i + 1);
    if (!seen.conflict) {
      if (seen.customerName.toLowerCase() !== inv.customerName.toLowerCase()) seen.conflict = "its rows name two different customers";
      else if (seen.total !== inv.total || seen.balance !== inv.balance) seen.conflict = "its rows show different Total or Balance";
      else if (seen.invoiceDate !== inv.invoiceDate) seen.conflict = "its rows show different invoice dates";
    }
  }
  return { invoices: order.map((k) => byNumber.get(k)!), missingColumns: [], rowCount: table.length - 1 };
}

// ── Preview ──────────────────────────────────────────────────────────────────────────

export interface CustomerLite { id: string; name: string; gstin: string | null }

export type PreviewVerdict = "import" | "already" | "no_customer" | "problem";

export interface PreviewRow {
  number: string;
  customerName: string;
  customerId: string | null;
  /** The customer it will be filed under (our name), when matched. */
  matchedCustomer: string | null;
  matchedBy: "gstin" | "name" | null;
  invoiceDate: string | null;
  dueDate: string | null;
  /** Whole rupees (rounded half up). */
  total: number;
  balance: number;
  gstin: string | null;
  placeOfSupply: string | null;
  currency: string;
  verdict: PreviewVerdict;
  /** Why it is not imported (verdict ≠ import), in plain English. */
  message: string | null;
  /** Shown but does not block, e.g. rounding to whole rupees. */
  notes: string[];
}

export interface Preview {
  rows: PreviewRow[];
  toImport: PreviewRow[];
  /** Sum of Balance over the rows that will be imported. */
  totalBalance: number;
  counts: { import: number; already: number; noCustomer: number; problem: number; nothingDue: number; draftOrVoid: number };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const rupees = (n: number) => Math.round(n);

/**
 * Every invoice with a Balance above ₹0 gets a row and a verdict. Paid invoices (Balance 0)
 * and Draft / Void ones are counted, not listed — they owe nothing.
 * `existingNumbers` = Zoho numbers already in the company (upper-cased).
 */
export function buildPreview(
  invoices: readonly ZohoInvoice[],
  customers: readonly CustomerLite[],
  existingNumbers: ReadonlySet<string>,
): Preview {
  const byGstin = new Map<string, CustomerLite>();
  const byName = new Map<string, CustomerLite[]>();
  for (const c of customers) {
    const g = (c.gstin ?? "").trim().toUpperCase();
    if (g) byGstin.set(g, c);
    const n = norm(c.name);
    byName.set(n, [...(byName.get(n) ?? []), c]);
  }
  const counts = { import: 0, already: 0, noCustomer: 0, problem: 0, nothingDue: 0, draftOrVoid: 0 };
  const rows: PreviewRow[] = [];

  for (const inv of invoices) {
    const st = inv.status.toLowerCase().replace(/[\s_-]/g, "");
    if (st === "draft" || st === "void") { counts.draftOrVoid++; continue; }
    if (inv.balance !== null && inv.balance <= 0 && inv.total !== null) { counts.nothingDue++; continue; }

    const notes: string[] = [];
    let problem: string | null = null;
    if (inv.conflict) problem = `Invoice ${inv.number}: ${inv.conflict} (lines ${inv.lines.join(", ")}).`;
    else if (inv.total === null || inv.balance === null) problem = "Total or Balance is empty or not a number.";
    else if (!inv.invoiceDate) problem = "The Invoice Date could not be read.";
    else if (inv.currency !== "INR") problem = `This invoice is in ${inv.currency}. Only rupee (INR) invoices can be imported — record it by hand.`;
    else if (inv.balance > inv.total) problem = `Balance ${inv.balance} is more than the Total ${inv.total}.`;
    else if (inv.total <= 0) problem = "Total is ₹0.";
    if (!problem && inv.total !== null && inv.balance !== null
        && (inv.total !== Math.trunc(inv.total) || inv.balance !== Math.trunc(inv.balance))) {
      notes.push(`Rounded to whole rupees (Total ${inv.total} → ${rupees(inv.total)}, Balance ${inv.balance} → ${rupees(inv.balance)}).`);
    }
    if (!problem && inv.number.length > 40) problem = "The invoice number is longer than 40 characters.";
    if (!problem && rupees(inv.balance ?? 0) <= 0) problem = "Balance rounds to ₹0.";

    // Customer: GSTIN first, then the exact name.
    let cust: CustomerLite | null = null;
    let matchedBy: PreviewRow["matchedBy"] = null;
    let custProblem: string | null = null;
    const g = (inv.gstin ?? "").trim().toUpperCase();
    if (g && isValidGstin(g) && byGstin.has(g)) { cust = byGstin.get(g)!; matchedBy = "gstin"; }
    if (!cust) {
      const same = byName.get(norm(inv.customerName)) ?? [];
      if (same.length === 1) { cust = same[0]; matchedBy = "name"; }
      else if (same.length > 1) custProblem = `${same.length} customers are named "${inv.customerName}". Add the GSTIN to the right one in Customers, then upload again.`;
    }

    const already = existingNumbers.has(inv.number.toUpperCase());
    let verdict: PreviewVerdict;
    let message: string | null = null;
    if (already) { verdict = "already"; message = `${inv.number} already imported`; counts.already++; }
    else if (problem) { verdict = "problem"; message = problem; counts.problem++; }
    else if (custProblem) { verdict = "problem"; message = custProblem; counts.problem++; }
    else if (!cust) {
      verdict = "no_customer";
      message = `Customer "${inv.customerName}" not found${g ? ` (GSTIN ${g})` : ""}. Create the customer in Customers, then upload the file again.`;
      counts.noCustomer++;
    } else { verdict = "import"; counts.import++; }

    rows.push({
      number: inv.number,
      customerName: inv.customerName,
      customerId: cust?.id ?? null,
      matchedCustomer: cust?.name ?? null,
      matchedBy,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate ?? inv.invoiceDate,
      total: rupees(inv.total ?? 0),
      balance: rupees(inv.balance ?? 0),
      gstin: g || null,
      placeOfSupply: inv.placeOfSupply,
      currency: inv.currency,
      verdict,
      message,
      notes,
    });
  }

  const toImport = rows.filter((r) => r.verdict === "import");
  return { rows, toImport, totalBalance: toImport.reduce((s, r) => s + r.balance, 0), counts };
}

/** The rows the import RPC takes (import_opening_invoices p_rows). */
export function toImportRpcRows(rows: readonly PreviewRow[]) {
  return rows.filter((r) => r.verdict === "import" && r.customerId).map((r) => ({
    number: r.number,
    invoice_date: r.invoiceDate,
    due_date: r.dueDate,
    customer_id: r.customerId,
    total: r.total,
    balance: r.balance,
    currency: r.currency,
    gstin: r.gstin,
    pos_state_code: r.placeOfSupply,
  }));
}

/** A small made-up Zoho export (T- names) — the "Download a sample" file and the test fixture. */
export const SAMPLE_ZOHO_INVOICE_CSV = [
  "Invoice Date,Invoice ID,Invoice Number,Invoice Status,Customer Name,GST Identification Number (GSTIN),Place of Supply,Due Date,Currency Code,Item Name,Item Total,Total,Balance",
  "2026-08-16,1001,INV-000245,Overdue,T-ABC Pvt Ltd,07AAACT1234A1Z3,DL,2026-09-15,INR,Google Workspace Business Starter,30000.00,59000.00,20000.00",
  "2026-08-16,1001,INV-000245,Overdue,T-ABC Pvt Ltd,07AAACT1234A1Z3,DL,2026-09-15,INR,Microsoft 365 Business Basic,20000.00,59000.00,20000.00",
  "2026-09-01,1002,INV-000246,Unpaid,T-Bharat Traders,,MH,2026-10-01,INR,\"Domain renewal, 1 year\",10000.00,11800.00,11800.00",
  "2026-07-10,1003,INV-000240,Paid,T-ABC Pvt Ltd,07AAACT1234A1Z3,DL,2026-08-09,INR,Google Workspace Business Starter,5000.00,5900.00,0.00",
  "2026-09-20,1004,INV-000250,Partially Paid,T-New Customer LLP,,KA,2026-10-20,INR,Zoho Mail,4000.00,4720.00,2000.00",
].join("\n") + "\n";
