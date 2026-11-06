/**
 * R-2502 — what the FY purchase preview needs from the app, for ONE company, through the server's
 * admin client. The admin client bypasses RLS, so EVERY read below is filtered by `tenantId`
 * (CLAUDE.md §17c); the tenant comes from the signed-in user's own row (resolveZohoCaller), never
 * from the request. The scan itself is R-2499's generic fy-import/store.ts.
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { readBooksStart, type BooksStartDb } from "@/lib/accounting/books-start";
import { must, type FyImportDb } from "../fy-import/store";
import type { MonthTotals, PaymentPlanContext, PurchasePlanContext } from "./plan";
import type { AppBankAccount } from "../receipts-import/plan";
import type { PurchaseFacts } from "./normalise";

type Res<T = unknown> = PromiseLike<{ data: T | null; error: { message?: string } | null }>;
type Range = { dateStart: string; dateEnd: string };

async function booksAndLock(db: FyImportDb, tenantId: string) {
  const [bs, tenant] = await Promise.all([
    readBooksStart(db as unknown as BooksStartDb, tenantId),
    db.from("tenants").select("books_locked_until").eq("id", tenantId).limit(1) as Res<Array<{ books_locked_until: string | null }>>,
  ]);
  return { booksStart: bs.start, lockedUntil: must(tenant, "the company")[0]?.books_locked_until ?? null };
}

export async function readCategoryMap(db: FyImportDb, tenantId: string): Promise<Record<string, string>> {
  const rows = await fetchAllRows<{ zoho_account_id: string; category: string }>((from, to) => db.from("zoho_account_category_map")
    .select("zoho_account_id, category").eq("tenant_id", tenantId).order("zoho_account_id", { ascending: true }).range(from, to));
  return Object.fromEntries(rows.map((r) => [r.zoho_account_id, r.category]));
}

/** Zoho doc keys ("bills:<id>" / "expenses:<id>") already in the app. */
async function importedKeys(db: FyImportDb, tenantId: string): Promise<Array<{ key: string; type: "vendor_bill" | "expense" }>> {
  const [exp, bills] = await Promise.all([
    fetchAllRows<{ zoho_doc_id: string }>((from, to) => db.from("expenses").select("zoho_doc_id").eq("tenant_id", tenantId)
      .not("zoho_doc_id", "is", null).order("id", { ascending: true }).range(from, to)),
    fetchAllRows<{ zoho_doc_id: string }>((from, to) => db.from("vendor_bills").select("zoho_doc_id").eq("tenant_id", tenantId)
      .not("zoho_doc_id", "is", null).order("id", { ascending: true }).range(from, to)),
  ]);
  return [...exp.map((r) => ({ key: r.zoho_doc_id, type: "expense" as const })), ...bills.map((r) => ({ key: r.zoho_doc_id, type: "vendor_bill" as const }))];
}

/** This company's bank / cash / card accounts (what a Zoho paid-through account maps to). */
export async function readBankAccounts(db: FyImportDb, tenantId: string): Promise<AppBankAccount[]> {
  const r = await (db.from("bank_accounts").select("id, name, bank_name, account_number_last4, account_type, is_active, is_default_petty_cash")
    .eq("tenant_id", tenantId).is("closed_on", null).order("name", { ascending: true }).limit(500) as Res<AppBankAccount[]>);
  return must(r, "the bank accounts");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The browser's choice: Zoho paid-through account name → app account id (checked against the company's own later). */
export function parseAccountMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, id] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
    if (k.length <= 200 && typeof id === "string" && UUID.test(id)) out[k] = id;
  }
  return out;
}

export async function readPurchaseContext(db: FyImportDb, tenantId: string, range: Range, accountMap: Record<string, string> = {}): Promise<PurchasePlanContext> {
  const [lock, vendors, categoryMap, keys, bankAccounts] = await Promise.all([
    booksAndLock(db, tenantId),
    fetchAllRows<{ id: string; name: string; gstin: string | null; zoho_contact_id: string | null }>((from, to) => db.from("vendors")
      .select("id, name, gstin, zoho_contact_id").eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, to)),
    readCategoryMap(db, tenantId),
    importedKeys(db, tenantId),
    readBankAccounts(db, tenantId),
  ]);
  return {
    fyStart: range.dateStart, fyEnd: range.dateEnd, ...lock, bankAccounts, accountMap,
    vendors: vendors.map((v) => ({ id: v.id, name: v.name, gstin: v.gstin, zohoContactId: v.zoho_contact_id })),
    categoryMap,
    imported: new Set(keys.map((k) => k.key)),
  };
}

export async function readPaymentContext(db: FyImportDb, tenantId: string, range: Range, accountMap: Record<string, string> = {}, bills: readonly PurchaseFacts[] = []): Promise<PaymentPlanContext> {
  const [lock, keys, links, bankAccounts] = await Promise.all([
    booksAndLock(db, tenantId),
    importedKeys(db, tenantId),
    fetchAllRows<{ zoho_payment_id: string }>((from, to) => db.from("zoho_vendor_payment_links").select("zoho_payment_id")
      .eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, to)),
    readBankAccounts(db, tenantId),
  ]);
  const targets = new Map<string, { type: "vendor_bill" | "expense" }>();
  for (const k of keys) if (k.key.startsWith("bills:")) targets.set(k.key.slice(6), { type: k.type });
  return {
    fyStart: range.dateStart, fyEnd: range.dateEnd, ...lock, targets, importedPayments: new Set(links.map((l) => l.zoho_payment_id)),
    bills: new Map(bills.map((b) => [b.zohoId, { total: b.total, tds: b.tdsAmount, tdsSection: b.tdsSection }])),
    bankAccounts, accountMap,
  };
}

/** What the app holds from Zoho for the FY, per month — read back from the rows (the server-side recount). */
export async function readAppPurchasesByMonth(db: FyImportDb, tenantId: string, range: Range): Promise<MonthTotals[]> {
  const [exp, bills] = await Promise.all([
    fetchAllRows<{ expense_date: string; zoho_doc_id: string; zoho_leg: number; amount: number; gst_paid: number; igst: number | null; cgst: number | null; sgst: number | null; rcm_tax: number; tds_amount: number }>((from, to) => db.from("expenses")
      .select("expense_date, zoho_doc_id, zoho_leg, amount, gst_paid, igst, cgst, sgst, rcm_tax, tds_amount").eq("tenant_id", tenantId)
      .not("zoho_doc_id", "is", null).gte("expense_date", range.dateStart).lte("expense_date", range.dateEnd).order("id", { ascending: true }).range(from, to)),
    fetchAllRows<{ bill_date: string; subtotal: number; igst: number; cgst: number; sgst: number }>((from, to) => db.from("vendor_bills")
      .select("bill_date, subtotal, igst, cgst, sgst").eq("tenant_id", tenantId)
      .not("zoho_doc_id", "is", null).gte("bill_date", range.dateStart).lte("bill_date", range.dateEnd).order("id", { ascending: true }).range(from, to)),
  ]);
  const m = new Map<string, MonthTotals>();
  const get = (d: string) => {
    const month = d.slice(0, 7);
    const t = m.get(month) ?? { month, count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, itc: 0, rcmTax: 0, tds: 0 };
    m.set(month, t);
    return t;
  };
  for (const e of exp) {
    const t = get(e.expense_date);
    if (e.zoho_leg === 1) t.count += 1;
    /* Taxable = the cost less the claimable GST (ineligible GST is part of the cost here, as in Zoho's taxable it is not — shown apart by the ITC column). */
    t.taxable += Number(e.amount) - Number(e.gst_paid);
    t.igst += Number(e.igst ?? 0); t.cgst += Number(e.cgst ?? 0); t.sgst += Number(e.sgst ?? 0);
    t.itc += Number(e.gst_paid); t.rcmTax += Number(e.rcm_tax); t.tds += Number(e.tds_amount);
  }
  for (const b of bills) {
    const t = get(b.bill_date);
    t.count += 1; t.taxable += Number(b.subtotal); t.igst += Number(b.igst); t.cgst += Number(b.cgst); t.sgst += Number(b.sgst);
    t.itc += Number(b.igst) + Number(b.cgst) + Number(b.sgst);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * R-2502c: purchases already in the books for the FY that did NOT come from Zoho (typed, booked from
 * a bank line, Purchase Inbox …), per month — next to the import in the preview, so an overlap shows
 * before anything is imported. Salaries left out (Payroll, never in Zoho bills).
 */
export async function readOtherPurchasesByMonth(db: FyImportDb, tenantId: string, range: Range): Promise<Array<{ month: string; count: number; amount: number }>> {
  const [exp, bills] = await Promise.all([
    fetchAllRows<{ expense_date: string; amount: number }>((from, to) => db.from("expenses").select("expense_date, amount").eq("tenant_id", tenantId)
      .is("zoho_doc_id", null).neq("category", "Salaries").gte("expense_date", range.dateStart).lte("expense_date", range.dateEnd)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows<{ bill_date: string; total: number }>((from, to) => db.from("vendor_bills").select("bill_date, total").eq("tenant_id", tenantId)
      .is("zoho_doc_id", null).gte("bill_date", range.dateStart).lte("bill_date", range.dateEnd).order("id", { ascending: true }).range(from, to)),
  ]);
  const m = new Map<string, { month: string; count: number; amount: number }>();
  const add = (d: string, a: number) => {
    const t = m.get(d.slice(0, 7)) ?? { month: d.slice(0, 7), count: 0, amount: 0 };
    t.count += 1; t.amount += Number(a);
    m.set(t.month, t);
  };
  for (const e of exp) add(e.expense_date, e.amount);
  for (const b of bills) add(b.bill_date, b.total);
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}
