/**
 * R-2621 (9 Nov 2026, p0 money, G-FY2526 D2 + D7) — Reconcile from Zoho never books a NEW GST sale for
 * a bank line of a GST-filed month. 9 Nov staging lookup (nothing booked): ~69 of 81 ticked rows on Excel
 * HDFC 4523 would have made new 18% sales on FY 2025-26 lines whose returns are filed — the revenue counted
 * twice. The plan (bulk-reconcile-plan.ts) asks two things before a new sale, both pure:
 *
 *   (a) zohoSaleInApp — Zoho's invoice is already in the app (an imported FY sale carries Zoho's number in
 *       invoices.external_number): the line PAYS that invoice, in any month; never a second sale.
 *   (b) gstFiledProblem — the bank line's day, or its Zoho invoice's day, is GST-filed (SQL gst_month_filed:
 *       "GST returns filed up to", books lock, GSTR-1 marked filed): no new sale — import Zoho's invoice first.
 *
 * The server refuses the same new sale (bank_credit_new_sale_quote, migration 20261109052458).
 */
import { formatDate, rupee } from "@/lib/utils";
import type { ZohoMatchInvoice, ZohoPaymentMatch } from "./payment-match";

/** What the bulk-match route adds to each row (customer-facts.ts gstFacts). */
export interface R2621RowFacts {
  /** Which of the row's days (bank date, Zoho invoice dates) are GST-filed — SQL gst_filed_days. Absent = not read. */
  gstFiled?: string[] | null;
  /** The row's Zoho invoices already in the app (imported FY sales, by Zoho number). */
  zohoSales?: ZohoAppSale[];
}

/** The same, as the plan's options (planAll builds them from the row). */
export interface R2621PlanFacts {
  /** GST-filed days among the row's dates (null/undefined = not read; the server still refuses). */
  gstFiled?: ReadonlySet<string> | null;
  zohoSales?: readonly ZohoAppSale[];
}

/** The open item the plan pays (its OpenItemFact shape — an imported Zoho sale is kind "opening"). */
export interface R2621PayItem {
  kind: "opening"; quoteId: null; invoiceId: string; docDate: string | null; due: number; taxable: number;
  makesSubscription: false; approvalBlock: null;
}

/** The plan's question before booking: a NEW sale → pay the imported invoice, refuse with a reason, or carry
 *  on; paying an open QUOTE (no invoice yet) on a filed day → refused too: generate_invoice dates its tax
 *  invoice on the bank date (invoice_date_for_receipt), inside the filed return (review 9 Nov). */
export function r2621Check(args: {
  kind: string;
  item: { quoteId: string | null; invoiceId: string | null } | null;
  match: Pick<ZohoPaymentMatch, "invoices" | "moreInvoices">;
  opts: R2621PlanFacts;
  customer: { kind: "existing"; id: string; name: string } | { kind: "new"; name: string };
  money: number;
  tds: number;
  lineDate: string;
  invoiceNumbers: readonly string[];
  slack: number;
}): { pay: { item: R2621PayItem; summary: string; note: string | null } | null; problem: string | null } {
  const { match, opts, customer } = args;
  if (args.kind === "pay_item") {
    const q = args.item && !args.item.invoiceId ? args.item.quoteId : null;
    return {
      pay: null,
      problem: q && opts.gstFiled?.has(args.lineDate)
        ? `GST for ${monthLabel(args.lineDate)} is already filed — paying quote ${q} now makes its tax invoice dated ${day(args.lineDate)}, inside a filed return. Reconcile this line by hand.`
        : null,
    };
  }
  if (args.kind !== "new_sale") return { pay: null, problem: null };
  const inApp = zohoSaleInApp({
    invoices: match.invoices, moreInvoices: match.moreInvoices, zohoSales: opts.zohoSales ?? [],
    customer: { id: customer.kind === "existing" ? customer.id : null, name: customer.name },
    money: args.money, hasTds: args.tds > 0, slack: args.slack,
  });
  if (inApp.kind === "pay") {
    const { app } = inApp;
    return {
      pay: {
        item: { kind: "opening", quoteId: null, invoiceId: app.invoiceId, docDate: app.date, due: app.due, taxable: app.taxable, makesSubscription: false, approvalBlock: null },
        summary: inApp.summary, note: inApp.note,
      },
      problem: null,
    };
  }
  if (inApp.kind === "problem") return { pay: null, problem: inApp.text };
  const problem = opts.gstFiled
    ? gstFiledProblem({ filed: opts.gstFiled, lineDate: args.lineDate, invoices: match.invoices, invoiceNumbers: args.invoiceNumbers })
    : null;
  return { pay: null, problem };
}

/** An app invoice carrying a Zoho invoice's number (an imported FY sale). */
export interface ZohoAppSale {
  /** Zoho's invoice number (invoices.external_number). */
  number: string;
  invoiceId: string;
  customerId: string | null;
  date: string | null;
  /** Whole rupees still owed. */
  due: number;
  taxable: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Dec 2025" for a YYYY-MM-DD day (the SQL message's FMMon YYYY). */
export function monthLabel(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}
const day = (iso: string) => formatDate(iso.slice(0, 10));
const rupees = (n: number) => rupee(Math.round(n));
/** A Zoho invoice number as compared everywhere in R-2621 (case and spaces ignored). */
export const normNo = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");

export type ZohoInAppDecision =
  | { kind: "none" }
  | { kind: "problem"; text: string }
  | { kind: "pay"; app: ZohoAppSale; summary: string; note: string | null };

/** (a) Is the payment's Zoho invoice already in the app — and can this line pay it? */
export function zohoSaleInApp(args: {
  invoices: readonly ZohoMatchInvoice[];
  moreInvoices: readonly string[];
  zohoSales: readonly ZohoAppSale[];
  /** The app customer Zoho's customer maps to; null = a customer new from Zoho. */
  customer: { id: string | null; name: string };
  /** Bank credit + TDS. */
  money: number;
  hasTds: boolean;
  slack: number;
}): ZohoInAppDecision {
  const { invoices, moreInvoices, zohoSales, customer, money, slack } = args;
  const has = (no: string) => zohoSales.find((s) => normNo(s.number) === normNo(no)) ?? null;
  const inApp = invoices.map((inv) => ({ inv, app: has(inv.number) }))
    .filter((x): x is { inv: ZohoMatchInvoice; app: ZohoAppSale } => !!x.app);
  /* review: an invoice Zoho lists only by number (moreInvoices) counts too */
  const inAppNos = [...inApp.map((x) => x.inv.number), ...moreInvoices.filter((n) => !!has(n))];
  if (inAppNos.length === 0) return { kind: "none" };
  if (invoices.length > 1 || moreInvoices.length > 0) {
    const nos = [...invoices.map((i) => i.number), ...moreInvoices].join(", ");
    return { kind: "problem", text: `The Zoho payment settles several invoices (${nos}) and ${inAppNos.join(", ")} ${inAppNos.length > 1 ? "are" : "is"} already in the app — record it in Record payment across those invoices, then match the line by hand.` };
  }
  const { inv, app } = inApp[0];
  const where = `Zoho's invoice ${inv.number} is in the app as ${app.invoiceId}`;
  if (customer.id === null || (app.customerId !== null && app.customerId !== customer.id)) {
    return { kind: "problem", text: `${where}, but it is in the app under another customer than ${customer.name} — check the customer, then reconcile this line by hand.` };
  }
  if (app.due <= 0) return { kind: "problem", text: `${where} and ${app.invoiceId} is already paid in the app — match this line to its receipt by hand.` };
  if (money > app.due + slack) {
    return { kind: "problem", text: `${where}, which has only ${rupees(app.due)} due, but the bank line${args.hasTds ? " + TDS" : ""} is ${rupees(money)}. Reconcile this line by hand.` };
  }
  return {
    kind: "pay", app,
    summary: `Pays Zoho's invoice ${inv.number} (in the app as ${app.invoiceId}, ${rupees(app.due)} due) — no new sale`,
    note: money < app.due - slack ? `Part payment: ${rupees(app.due - money)} stays due on ${app.invoiceId}.` : null,
  };
}

/** The slice of a plan row r2621OnePayPerItem reads and changes. */
interface PayRow {
  credit: number;
  tds: number;
  ticked: boolean;
  problems: string[];
  book: { kind: string; item: { quoteId: string | null; invoiceId: string | null; due: number; fx?: unknown } | null } | null;
}

/** Review 9 Nov: rows of ONE run that pay the same open invoice / quote — once their money passes its due,
 *  the later rows are not booked (each row alone fits the due, together they would overpay it). */
export function r2621OnePayPerItem<T extends PayRow>(rows: T[]): T[] {
  const used = new Map<string, number>();
  for (const r of rows) {
    const it = r.book?.kind === "pay_item" ? r.book.item : null;
    const key = it ? it.invoiceId ?? it.quoteId : null;
    if (!it || !key || it.fx) continue;
    const total = (used.get(key) ?? 0) + r.credit + r.tds;
    if (total > it.due + 2) {
      r.problems.push(`Another line in this run already pays ${key} (${rupees(it.due)} due) — book that line first, then run this again for this one.`);
      r.ticked = false;
      r.book = null;
      continue;
    }
    used.set(key, total);
  }
  return rows;
}

/** (b) The refusal when a new sale would land on a GST-filed day; null = the months are open. */
export function gstFiledProblem(args: {
  filed: ReadonlySet<string>;
  lineDate: string;
  invoices: readonly ZohoMatchInvoice[];
  invoiceNumbers: readonly string[];
}): string | null {
  const { filed, lineDate, invoices, invoiceNumbers } = args;
  const nos = invoiceNumbers.join(", ");
  const next = nos
    ? ` Import Zoho's invoice${invoiceNumbers.length > 1 ? "s" : ""} ${nos} first (Invoices → FY sales from Zoho), then run this again — the line then pays ${invoiceNumbers.length > 1 ? "them" : "it"}.`
    : " Reconcile this line by hand.";
  if (filed.has(lineDate)) {
    return `GST for ${monthLabel(lineDate)} is already filed — a new sale on ${day(lineDate)} would change a filed return${nos ? ` and count ${nos} twice` : ""}.${next}`;
  }
  const invFiled = invoices.find((i) => !!i.date && filed.has(i.date.slice(0, 10)));
  if (!invFiled) return null;
  const d = invFiled.date!.slice(0, 10);
  return `Zoho's invoice ${invFiled.number} is dated ${day(d)} — GST for ${monthLabel(d)} is already filed, so it is in a filed return; a new sale on ${day(lineDate)} would count it twice.${next}`;
}
