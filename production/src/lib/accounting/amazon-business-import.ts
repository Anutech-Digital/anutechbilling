/**
 * R-2602 — "Import Amazon Business report" on the Expenses page: read the Amazon Business
 * "Reconciliation by shipment level" CSV (Business Analytics → Reconciliation), preview every
 * order with a verdict, and turn the good ones into DRAFT expense rows — unpaid, ITC off — that
 * the owner completes when the seller's GST invoice is attached.
 *
 * Why: Pardeep (8 Nov 2026) — every Amazon debit on HDFC is reconciled by hand; one NetBanking
 * payment (one Payment Reference ID) covers several orders, so the bank shows one debit for
 * 3–4 orders and nothing in the books says which.
 *
 * The file: one row per SHIPMENT LINE (37 columns, found by NAME — lib/csv findColumn, so the
 * trailing space in "Regulatory fees excl. tax " and the BOM do not matter). A row's money:
 *   Net total = Item subtotal incl. tax + Shipping − Promotions (what Amazon charged for that line);
 *   Total tax amount at Tax rate ("18%") is inside it. Empty cells are "" or "N/A".
 *   Shipment Quantity 0 = cancelled before shipping — no amounts, no payment reference.
 *
 * What is made, per Order ID: ONE expense row (the same `expenses` insert Add Expense writes):
 *   - DRAFT = `paid false`, no due date — Reconcile "Pay for → Expense bill" settles it later;
 *   - ITC OFF: `bill_type 'none'`, `gst_paid 0`, no GST head (the report has no seller GSTIN or
 *     invoice number; many items are s.17(5) goods). The tax amount and rate go into the notes
 *     so the credit can be claimed when the GST invoice is attached (later card). No GST head is
 *     guessed (money-rules G2 spirit: unknown place of supply → never CGST+SGST by default);
 *   - amount = sum of the order's rows' Net total, whole rupees (D1 style, paise noted);
 *   - vendor "Amazon seller (unknown)" (no vendor row is created — the seller is on the invoice);
 *   - `bill_no` = Order ID → a second upload finds it "already"; dedupe inside the file on
 *     Order ID + ASIN (an identical row twice counts once);
 *   - line items: Title (ASIN) / qty / unit price excl. tax / that row's Net total;
 *   - a Prime membership row (Title has "Prime" + "membership") → its own expense, category
 *     Software, said to be a subscription.
 *
 * Bank: rows grouped by Payment Reference ID + Payment Date → one EXPECTED DEBIT (sum of Net total)
 * shown in the preview and written on each order's notes, so the HDFC line is found by amount and
 * reference. Auto-suggesting that line in Reconcile is a follow-up card.
 *
 * Pure: the dialog passes the file text and the existing (vendor_name, bill_no) keys.
 */
import { findColumn } from "@/lib/csv";
import { parseCsvText, parseZohoAmount, parseZohoDate } from "@/lib/import/zoho-opening-invoices";
import { suggestCategory } from "@/lib/queries/expenses";

export const AMAZON_VENDOR_NAME = "Amazon seller (unknown)";
export const PRIME_CATEGORY = "Software";
const DEFAULT_CATEGORY = "Other";
const MAX_ORDERS = 500;

export const AMAZON_COLUMNS = {
  orderDate: ["Order Date"],
  orderId: ["Order ID", "Order Id", "Order Number"],
  poNumber: ["PO Number"],
  paymentRef: ["Payment Reference ID", "Payment Reference Id", "Payment Reference"],
  paymentDate: ["Payment Date"],
  txnType: ["Transaction Type"],
  currency: ["Currency"],
  qty: ["Shipment Quantity", "Quantity"],
  subtotalIncl: ["Item subtotal incl. tax", "Item subtotal"],
  shipping: ["Shipping and handling excl. tax", "Shipping excl. tax"],
  promotions: ["Promotions and discounts excl. tax", "Promotions excl. tax"],
  taxRate: ["Tax rate"],
  taxAmount: ["Total tax amount", "Tax amount"],
  netTotal: ["Net total"],
  asin: ["ASIN"],
  title: ["Title", "Item", "Product"],
  unitPrice: ["Unit price excl. tax", "Unit price"],
} as const;
type ColumnKey = keyof typeof AMAZON_COLUMNS;

/** The columns an import cannot do without (missing → the file is refused with their names). */
const REQUIRED: [ColumnKey, string][] = [
  ["orderDate", "Order Date"], ["orderId", "Order ID"], ["asin", "ASIN"], ["title", "Title"],
  ["qty", "Shipment Quantity"], ["netTotal", "Net total"],
];

export interface AmazonLine {
  /** 1-based file line (header = 1). */
  line: number;
  orderDate: string | null;
  orderId: string;
  poNumber: string;
  paymentRef: string | null;
  paymentDate: string | null;
  txnType: string;
  currency: string;
  qty: number | null;
  subtotalIncl: number | null;
  shipping: number | null;
  promotions: number | null;
  taxRatePct: number | null;
  taxAmount: number | null;
  netTotal: number | null;
  asin: string;
  title: string;
  unitPrice: number | null;
  /** Shipment Quantity 0 — cancelled before shipping. */
  cancelled: boolean;
  /** A cell that could not be read (number / date), said plainly. */
  bad: string | null;
}

export interface AmazonReadResult {
  lines: AmazonLine[];
  missingColumns: string[];
  rowCount: number;
}

/** "N/A", "-", "" → blank. */
const blank = (v: string) => { const t = v.trim(); return !t || /^(n\/?a|-|—)$/i.test(t) ? "" : t; };

export function readAmazonReportCsv(text: string): AmazonReadResult {
  const table = parseCsvText(text);
  if (table.length === 0) return { lines: [], missingColumns: REQUIRED.map(([, l]) => l), rowCount: 0 };
  const headers = table[0];
  const col = {} as Record<ColumnKey, number>;
  for (const k of Object.keys(AMAZON_COLUMNS) as ColumnKey[]) col[k] = findColumn(headers, AMAZON_COLUMNS[k]);
  const missingColumns = REQUIRED.filter(([k]) => col[k] < 0).map(([, l]) => l);
  if (missingColumns.length) return { lines: [], missingColumns, rowCount: table.length - 1 };

  const cell = (r: string[], k: ColumnKey) => (col[k] >= 0 ? blank(r[col[k]] ?? "") : "");
  const amount = (r: string[], k: ColumnKey, label: string, problems: string[]): number | null => {
    const raw = cell(r, k);
    if (!raw) return null;
    const n = parseZohoAmount(raw);
    if (n === null) problems.push(`${label} "${raw}" is not a number`);
    return n;
  };
  const date = (r: string[], k: ColumnKey, label: string, problems: string[]): string | null => {
    const raw = cell(r, k);
    if (!raw) return null;
    const d = parseZohoDate(raw);
    if (!d) problems.push(`${label} "${raw}" could not be read`);
    return d;
  };

  const lines: AmazonLine[] = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const problems: string[] = [];
    const qtyRaw = cell(r, "qty");
    const qty = qtyRaw ? parseZohoAmount(qtyRaw) : null;
    if (qtyRaw && qty === null) problems.push(`Shipment Quantity "${qtyRaw}" is not a number`);
    const rateRaw = cell(r, "taxRate").replace(/%/g, "").trim();
    const taxRatePct = rateRaw ? parseZohoAmount(rateRaw) : null;
    if (rateRaw && taxRatePct === null) problems.push(`Tax rate "${cell(r, "taxRate")}" could not be read`);
    lines.push({
      line: i + 1,
      orderDate: date(r, "orderDate", "Order Date", problems),
      orderId: cell(r, "orderId"),
      poNumber: cell(r, "poNumber"),
      paymentRef: cell(r, "paymentRef") || null,
      paymentDate: date(r, "paymentDate", "Payment Date", problems),
      txnType: cell(r, "txnType"),
      currency: (cell(r, "currency") || "INR").toUpperCase(),
      qty,
      subtotalIncl: amount(r, "subtotalIncl", "Item subtotal incl. tax", problems),
      shipping: amount(r, "shipping", "Shipping and handling excl. tax", problems),
      promotions: amount(r, "promotions", "Promotions and discounts excl. tax", problems),
      taxRatePct,
      taxAmount: amount(r, "taxAmount", "Total tax amount", problems),
      netTotal: amount(r, "netTotal", "Net total", problems),
      asin: cell(r, "asin"),
      title: cell(r, "title"),
      unitPrice: amount(r, "unitPrice", "Unit price excl. tax", problems),
      cancelled: qty === 0,
      bad: problems.length ? problems.join("; ") : null,
    });
  }
  return { lines, missingColumns: [], rowCount: table.length - 1 };
}

// ── Preview ──────────────────────────────────────────────────────────────────────────

/** An expense already in the books, for the duplicate check (bill_no = Order ID). */
export interface ExistingExpenseKey { vendor_name: string | null; bill_no: string | null }

export type AmazonVerdict = "import" | "already" | "cancelled" | "problem";

export interface AmazonOrderLine {
  asin: string;
  title: string;
  qty: number;
  /** Rupees excl. tax, as written. */
  unitPrice: number | null;
  /** This row's Net total, whole rupees. */
  amount: number;
  taxAmount: number;
  fileLine: number;
}

export interface AmazonOrderRow {
  orderId: string;
  orderDate: string | null;
  paymentRef: string | null;
  paymentDate: string | null;
  poNumber: string;
  lines: AmazonOrderLine[];
  /** Whole rupees — sum of the rows' Net total (GST inside, ITC off). */
  total: number;
  /** Whole rupees — sum of Total tax amount (noted, not claimed). */
  taxTotal: number;
  /** The one tax rate of the order's rows, else null (mixed rates are noted). */
  taxRatePct: number | null;
  category: string;
  isPrime: boolean;
  fileLines: number[];
  verdict: AmazonVerdict;
  message: string | null;
  /** Shown, does not block. */
  notes: string[];
}

/** One bank debit the owner should find: all orders paid under one Payment Reference ID on one day. */
export interface ExpectedDebit { paymentRef: string; paymentDate: string | null; amount: number; orderIds: string[] }

export interface AmazonPreview {
  rows: AmazonOrderRow[];
  toImport: AmazonOrderRow[];
  expectedDebits: ExpectedDebit[];
  /** Orders to import that have no Payment Reference ID (paid another way / not yet charged). */
  noPaymentRef: string[];
  totalAmount: number;
  counts: { import: number; already: number; cancelled: number; problem: number };
}

const R = (n: number) => Math.round(n);
const hasPaise = (n: number | null) => n !== null && R(n * 100) % 100 !== 0;
const normId = (s: string) => s.trim().toUpperCase();
const isPrimeTitle = (t: string) => /\bprime\b/i.test(t) && /\bmembership\b/i.test(t);

export function buildAmazonImportPreview(lines: readonly AmazonLine[], existing: readonly ExistingExpenseKey[]): AmazonPreview {
  const have = new Set<string>();
  for (const e of existing) if (e.bill_no) have.add(normId(e.bill_no));

  /* Group by Order ID, in first-seen order; a row without an Order ID stands alone (a problem). */
  const groups = new Map<string, AmazonLine[]>();
  const order: string[] = [];
  for (const l of lines) {
    const key = l.orderId ? normId(l.orderId) : `#${l.line}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(l);
  }

  const counts = { import: 0, already: 0, cancelled: 0, problem: 0 };
  const rows: AmazonOrderRow[] = [];
  for (const key of order) {
    const all = groups.get(key)!;
    const notes: string[] = [];
    const first = all[0];
    const orderId = first.orderId;
    /* Inside the file: the same Order ID + ASIN twice. Identical rows (same Net total) count once;
       rows that differ (a split shipment) both count. */
    const seen = new Map<string, AmazonLine>();
    const live: AmazonLine[] = [];
    let dupNote = false;
    for (const l of all) {
      if (l.cancelled) continue;
      const k = normId(l.asin || `line${l.line}`);
      const prev = seen.get(k);
      if (prev && prev.netTotal === l.netTotal && prev.qty === l.qty) { dupNote = true; continue; }
      seen.set(k, l);
      live.push(l);
    }
    if (dupNote) notes.push("The same item appears twice in the file with the same amount — counted once.");
    const cancelledRows = all.filter((l) => l.cancelled);

    let problem: string | null = null;
    const bad = all.find((l) => l.bad);
    if (!orderId) problem = "The Order ID is empty.";
    else if (bad) problem = `${bad.bad}.`;
    else if (live.length === 0 && cancelledRows.length > 0) problem = null; // whole order cancelled
    else if (!first.orderDate) problem = "The Order Date is empty.";
    else if (live.some((l) => l.currency !== "INR")) problem = `This order is in ${live.find((l) => l.currency !== "INR")!.currency}. Only rupee (INR) orders can be imported — add it with Add Expense (it asks the exchange rate).`;
    else if (live.some((l) => l.netTotal === null)) problem = "A row's Net total is empty.";
    else if (live.some((l) => (l.netTotal ?? 0) < 0)) problem = "A row's Net total is negative (a refund?) — record it by hand.";
    else if (live.reduce((s, l) => s + (l.netTotal ?? 0), 0) <= 0) problem = "The order's Net total is ₹0.";

    const orderLines: AmazonOrderLine[] = live.map((l) => ({
      asin: l.asin, title: l.title, qty: l.qty ?? 1, unitPrice: l.unitPrice,
      amount: R(l.netTotal ?? 0), taxAmount: R(l.taxAmount ?? 0), fileLine: l.line,
    }));
    const total = orderLines.reduce((s, l) => s + l.amount, 0);
    const taxTotal = orderLines.reduce((s, l) => s + l.taxAmount, 0);
    const rates = [...new Set(live.map((l) => l.taxRatePct).filter((r): r is number => r !== null))];
    const taxRatePct = rates.length === 1 ? rates[0] : null;
    if (rates.length > 1) notes.push(`Rows at different tax rates (${rates.map((r) => `${r}%`).join(", ")}) — check the invoice.`);
    if (!problem && live.some((l) => hasPaise(l.netTotal) || hasPaise(l.taxAmount))) notes.push("Amounts rounded to whole rupees, as on an expense added by hand.");
    const isPrime = live.length > 0 && live.every((l) => isPrimeTitle(l.title));
    if (isPrime) notes.push("Prime membership — booked as a subscription expense (Software).");
    else if (live.some((l) => isPrimeTitle(l.title))) notes.push("Has a Prime membership row beside goods — check the category.");
    const refs = [...new Set(live.map((l) => l.paymentRef).filter(Boolean))];
    if (refs.length > 1) notes.push("Rows paid under different payment references — the expected debits list each.");
    const paymentRef = refs[0] ?? null;
    const paymentDate = live.find((l) => l.paymentRef === paymentRef)?.paymentDate ?? null;
    const category = isPrime ? PRIME_CATEGORY
      : (suggestCategory(live.map((l) => l.title).join(" · "), { source: "product" }) ?? DEFAULT_CATEGORY);
    if (!isPrime && !problem && live.length > 0) notes.push("Vendor is \"Amazon seller (unknown)\" until the GST invoice is attached; GST stays in the cost (ITC off).");

    let verdict: AmazonVerdict;
    let message: string | null = null;
    if (live.length === 0 && cancelledRows.length > 0 && !bad) {
      verdict = "cancelled"; counts.cancelled++;
      message = `Cancelled before shipping (quantity 0) — nothing was charged, left out.`;
    } else if (orderId && have.has(normId(orderId))) {
      verdict = "already"; counts.already++;
      message = `Order ${orderId} is already in Expenses — skipped.`;
    } else if (problem) {
      verdict = "problem"; counts.problem++; message = problem;
    } else {
      verdict = "import"; counts.import++;
      if (cancelledRows.length) notes.push(`${cancelledRows.length} cancelled row${cancelledRows.length === 1 ? "" : "s"} of this order left out.`);
    }

    rows.push({
      orderId, orderDate: first.orderDate, paymentRef, paymentDate, poNumber: first.poNumber,
      lines: orderLines, total, taxTotal, taxRatePct, category, isPrime,
      fileLines: all.map((l) => l.line), verdict, message, notes,
    });
  }

  if (counts.import > MAX_ORDERS) {
    for (const r of rows) if (r.verdict === "import") { r.verdict = "problem"; r.message = `More than ${MAX_ORDERS} orders in one file — split it into smaller files (a shorter date range).`; }
    counts.problem += counts.import; counts.import = 0;
  }

  const toImport = rows.filter((r) => r.verdict === "import");
  /* One expected bank debit per Payment Reference ID + Payment Date, over the orders that will import. */
  const debits = new Map<string, ExpectedDebit>();
  const noPaymentRef: string[] = [];
  for (const r of toImport) {
    if (!r.paymentRef) { noPaymentRef.push(r.orderId); continue; }
    const k = `${r.paymentRef}|${r.paymentDate ?? ""}`;
    const d = debits.get(k) ?? { paymentRef: r.paymentRef, paymentDate: r.paymentDate, amount: 0, orderIds: [] };
    d.amount += r.total; d.orderIds.push(r.orderId);
    debits.set(k, d);
  }
  return {
    rows, toImport, expectedDebits: [...debits.values()], noPaymentRef,
    totalAmount: toImport.reduce((s, r) => s + r.total, 0), counts,
  };
}

/**
 * The `expenses` rows to insert — the fields Add Expense writes for an unpaid, no-GST-credit bill
 * (bill_type 'none', GST inside the cost). `stamp` makes the ids (`AMZ-<stamp>-A001…`), unique
 * within the batch and new per import.
 */
export function toAmazonExpenseInserts(rows: readonly AmazonOrderRow[], opts: { fileName: string; stamp: string }) {
  const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return rows.filter((r) => r.verdict === "import" && r.orderDate).map((r, i) => {
    const items = r.lines.map((l) => trunc(l.title, 60)).join("; ");
    const description = r.isPrime
      ? `Amazon Prime membership (subscription) · order ${r.orderId} — draft, invoice pending`
      : `Amazon order ${r.orderId} (draft, invoice pending): ${trunc(items, 160)}`;
    const gstNote = r.taxTotal > 0
      ? `GST ₹${r.taxTotal}${r.taxRatePct !== null ? ` at ${r.taxRatePct}%` : ""} is inside the amount — ITC off until the seller's GSTIN / tax invoice is seen.`
      : "No GST shown on the report — ITC off until the seller's GSTIN / tax invoice is seen.";
    const payNote = r.paymentRef ? ` Payment Ref ${r.paymentRef}${r.paymentDate ? ` dated ${r.paymentDate}` : ""} (one bank debit may cover several orders).` : " No payment reference in the report.";
    const poNote = r.poNumber ? ` PO ${r.poNumber}.` : "";
    return {
      id: `AMZ-${opts.stamp}-A${String(i + 1).padStart(3, "0")}`,
      expense_date: r.orderDate!,
      category: r.category,
      description,
      amount: r.total,
      gst_paid: 0,
      igst: null as number | null,
      cgst: null as number | null,
      sgst: null as number | null,
      bill_type: "none",
      bill_no: r.orderId,
      vendor_name: AMAZON_VENDOR_NAME,
      vendor_id: null as string | null,
      currency: "INR",
      fx_rate: 1,
      paid: false,
      paid_date: null as string | null,
      due_date: null as string | null,
      payment_method: "bank_transfer",
      bank_account_id: null as string | null,
      line_items: r.lines.map((l) => ({ name: `${l.title} (ASIN ${l.asin})`, qty: l.qty, rate: l.unitPrice ?? 0, amount: l.amount })),
      rcm: false,
      rcm_tax: 0,
      tds_amount: 0,
      tds_section: null as string | null,
      notes: `Amazon Business import (${opts.fileName.slice(0, 120)}) — DRAFT: seller GSTIN / invoice not yet seen. ${gstNote}${payNote}${poNote}`,
    };
  });
}

/** Made-up sample (also docs/samples/amazon-business-import-sample.csv) — "Download a sample" in the dialog. */
export const SAMPLE_AMAZON_CSV = [
  "Order Date,Order ID,Account Group,PO Number,Account User,Account User Email,Document issue date,Statement number,Original Invoice Number,Invoice due date,Document status,Transaction Type,Order payment method,Payment Reference ID,Payment Date,Charge Identifier,Payment Identifier,Shipment/refund date,Shipment Status,Ship From Country,Currency,Shipment Quantity,Item subtotal incl. tax,Shipping and handling excl. tax,Promotions and discounts excl. tax,Gift wrap fees excl. tax,Regulatory fees excl. tax ,Other fees excl. tax,Tax rate,Total tax amount,Net total,Delivery status,ASIN,Title,Unit price excl. tax,PO Line Item Id,Cost center",
  "23/08/2026,260-2602001-0000001,T-Sample Group,,T Buyer,t.buyer@example.test,N/A,,,N/A,,Charge,NetBanking,TSamplePayRefAAAAAAAAAAAAAAAAAAA01,23/08/2026,,,25/08/2026,Shipped,IN,INR,1,1179.99,0.00,,,,,18%,179.99,1179.99,Delivered,T0AAAA01A1,\"T-Laptop Stand, Aluminium, Foldable\",1000.00,,",
  "23/08/2026,260-2602001-0000001,T-Sample Group,,T Buyer,t.buyer@example.test,N/A,,,N/A,,Charge,NetBanking,TSamplePayRefAAAAAAAAAAAAAAAAAAA01,23/08/2026,,,25/08/2026,Shipped,IN,INR,2,472.00,0.00,,,,,18%,72.00,472.00,Delivered,T0AAAA02B2,T-USB-C Cable 1m (pack of 2),200.00,,",
  "23/08/2026,260-2602002-0000002,T-Sample Group,,T Buyer,t.buyer@example.test,N/A,,,N/A,,Charge,NetBanking,TSamplePayRefAAAAAAAAAAAAAAAAAAA01,23/08/2026,,,24/08/2026,Shipped,IN,INR,1,2360.00,40.00,-40.00,,,,18%,360.00,2360.00,Delivered,T0AAAA03C3,T-Office Chair Cushion,2000.00,,",
  "11/08/2026,260-2602003-0000003,T-Sample Group,,T Buyer,t.buyer@example.test,N/A,,,N/A,,Charge,,,N/A,,,N/A,,,INR,0,,,,,,,,,,N/A,T0AAAA04D4,T-Desk Lamp (cancelled),9.99,,",
  "09/08/2026,T60-2602004-0000004,T-Sample Group,,T Buyer,t.buyer@example.test,N/A,,,N/A,,Charge,NetBanking,TSamplePayRefBBBBBBBBBBBBBBBBBBB02,09/08/2026,,,09/08/2026,Shipped,IN,INR,1,1499.00,,,,,,18%,228.66,1499.00,Delivered,T0PRIME001,Amazon Prime Membership — Business Prime Annual,1270.34,,",
].join("\n") + "\n";
