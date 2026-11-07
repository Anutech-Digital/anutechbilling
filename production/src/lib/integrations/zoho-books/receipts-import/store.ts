/**
 * R-2501 — what the FY receipts import needs from the app for ONE company: the invoices that came
 * from Zoho (imported FY sales + opening invoices, with what is still due), the bank / cash accounts,
 * the Zoho payments already booked (zoho_fy_receipts), books start and lock. The admin client
 * bypasses RLS, so every read is filtered by `tenantId` (CLAUDE.md §17c). The generic scan / batch
 * store is ../fy-import/store.ts.
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { readBooksStart, type BooksStartDb } from "@/lib/accounting/books-start";
import { must, type FyImportDb } from "../fy-import/store";
import { LEAVE_OUT, type AppBankAccount, type ReceiptsPlanContext } from "./plan";

type Res<T = unknown> = PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>;

interface InvRow {
  id: string; zoho_invoice_id: string | null; external_number: string | null; document_kind: string;
  customer_id: string | null; amount: number; net_payable: number | null; paid_amount: number | null; status: string;
}

export async function readReceiptsContext(
  db: FyImportDb, tenantId: string, range: { dateStart: string; dateEnd: string }, accountMap: Record<string, string>,
): Promise<ReceiptsPlanContext> {
  const [bs, tenant, invoices, accounts, booked] = await Promise.all([
    readBooksStart(db as unknown as BooksStartDb, tenantId),
    db.from("tenants").select("books_locked_until").eq("id", tenantId).limit(1) as Res<Array<{ books_locked_until: string | null }>>,
    /* Only invoices that came from Zoho: an imported FY sale, or an opening invoice (to say why it is skipped). */
    fetchAllRows<InvRow>((from, to) => db.from("invoices")
      .select("id, zoho_invoice_id, external_number, document_kind, customer_id, amount, net_payable, paid_amount, status")
      .eq("tenant_id", tenantId).or("zoho_invoice_id.not.is.null,document_kind.eq.opening_invoice")
      .order("id", { ascending: true }).range(from, to)),
    db.from("bank_accounts").select("id, name, bank_name, account_number_last4, account_type, is_active, is_default_petty_cash")
      .eq("tenant_id", tenantId).order("name", { ascending: true }).limit(500) as Res<AppBankAccount[]>,
    fetchAllRows<{ zoho_payment_id: string; bank_txn_id: string | null; fee: number | null }>((from, to) => db.from("zoho_fy_receipts")
      .select("zoho_payment_id, bank_txn_id, fee").eq("tenant_id", tenantId).order("zoho_payment_id", { ascending: true }).range(from, to)),
  ]);
  const t = must(tenant, "the company")[0];
  return {
    fyStart: range.dateStart,
    fyEnd: range.dateEnd,
    booksStart: bs.start,
    lockedUntil: t?.books_locked_until ?? null,
    invoices: invoices.map((i) => ({
      id: i.id, zohoInvoiceId: i.zoho_invoice_id, externalNumber: i.external_number, documentKind: i.document_kind, customerId: i.customer_id,
      due: i.status === "paid" || i.status === "void" ? 0 : Math.max(0, Number(i.net_payable ?? i.amount) - Number(i.paid_amount ?? 0)),
    })),
    bankAccounts: must(accounts, "the bank accounts"),
    booked: new Map(booked.map((b) => [b.zoho_payment_id, { banked: b.bank_txn_id !== null, fee: Number(b.fee ?? 0) }])),
    accountMap,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The browser's "Zoho account → app account" choices, shape-checked (the SQL checks the company):
 *  an app account id, LEAVE_OUT ("Leave out"), or "" (chosen: none — no suggestion fills it). */
export function parseAccountMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, id] of Object.entries(v as Record<string, unknown>).slice(0, 500)) {
    if (k.length <= 40 && typeof id === "string" && (UUID.test(id) || id === LEAVE_OUT || id === "")) out[k] = id;
  }
  return out;
}
