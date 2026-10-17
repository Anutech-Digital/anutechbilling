/**
 * R-1526 — server half of the "Pending dues" statement: read one customer's open bills and
 * render the PDF.
 *
 * TENANT SCOPE: every read names `tenant_id` explicitly, so the SAME loader is safe on
 *   • the caller's session client (the app routes — RLS also applies), and
 *   • the service-role client of the public signed-link route (no RLS there: the token binds
 *     (statement, customer, tenant) and these filters are the boundary).
 * NO READ STOPS AT 1000 ROWS: lists page through fetchAllRows / fetchAllRowsIn with a total
 * order ending on `id` (R-1509 / R-1519 lesson).
 */
import { createElement } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { logoDataUri } from "@/lib/pdf/logo";
import { buildStatementUpiQr } from "@/lib/pdf/upi-qr";
import { proformaBank } from "@/lib/pdf/quote-template";
import {
  buildPendingDuesStatement,
  type DuesCustomer, type DuesInvoiceRow, type DuesSubscriptionRow, type DuesTenant,
  type PendingDuesRaw, type PendingDuesStatement,
} from "./pending-dues";

type Db = Pick<SupabaseClient, "from">;

const INVOICE_COLS = "id, amount, net_payable, paid_amount, status, invoice_date, due_date, quote_id, currency";
const SUB_COLS = "id, plan, domain, quote_id, outstanding_amount, payment_due_date, created_at";
const TENANT_COLS =
  "name, gstin, email, phone, address, upi_vpa, upi_payee_name, logo_url, remit_bank_name, remit_account_name, remit_account_number, remit_ifsc, remit_branch";

/** Everything the statement needs for one customer of one company, or null when not found there. */
export async function loadPendingDuesRaw(db: Db, opts: { customerId: string; tenantId: string }): Promise<PendingDuesRaw | null> {
  const { customerId, tenantId } = opts;
  const { data: cust, error: custErr } = await db
    .from("customers")
    .select("id, name, display_name, gstin, address, city, state")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (custErr) throw custErr;
  if (!cust) return null;

  const [invoices, subscriptions, tenant] = await Promise.all([
    fetchAllRows<DuesInvoiceRow>((from, to) => db
      .from("invoices")
      .select(INVOICE_COLS)
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .in("status", ["pending", "overdue"])
      .order("id", { ascending: true })
      .range(from, to)),
    fetchAllRows<DuesSubscriptionRow>((from, to) => db
      .from("subscriptions")
      .select(SUB_COLS)
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .gt("outstanding_amount", 0)
      .is("written_off_at", null)
      .order("id", { ascending: true })
      .range(from, to)),
    db.from("tenants").select(TENANT_COLS).eq("id", tenantId).maybeSingle(),
  ]);
  if (tenant.error) throw tenant.error;

  const subQuoteIds = [...new Set(subscriptions.map((s) => s.quote_id).filter((x): x is string => !!x))];
  const invoicedQuotes = await fetchAllRowsIn<{ id: string; quote_id: string | null }, string>(subQuoteIds, (ids, from, to) => db
    .from("invoices")
    .select("id, quote_id")
    .eq("tenant_id", tenantId)
    .in("quote_id", ids)
    .order("id", { ascending: true })
    .range(from, to));

  return {
    customer: cust as DuesCustomer,
    tenant: (tenant.data as DuesTenant | null) ?? null,
    invoices,
    subscriptions,
    invoicedQuoteIds: new Set(invoicedQuotes.map((i) => i.quote_id).filter((x): x is string => !!x)),
  };
}

function customerAddress(c: DuesCustomer): string | null {
  const parts = [c.address, c.city, c.state].map((x) => x?.trim()).filter((x): x is string => !!x);
  return parts.length ? parts.join(", ") : null;
}

/** Render the statement PDF. The QR is drawn only when statementUpiUri allows it. */
export async function renderPendingDuesPdf(raw: PendingDuesRaw, st: PendingDuesStatement): Promise<Buffer> {
  const t = raw.tenant;
  const [logo, upi] = await Promise.all([
    logoDataUri(t?.logo_url),
    buildStatementUpiQr({
      vpa: t?.upi_vpa,
      payeeName: t?.upi_payee_name ?? t?.name,
      customerName: st.customerName,
      total: st.total,
      allInr: st.allInr,
    }),
  ]);

  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { PendingDuesPDF } = await import("@/lib/pdf/PendingDuesPDF");
  const buffer = await renderToBuffer(
    createElement(PendingDuesPDF, {
      tenantName: t?.name?.trim() || "Statement",
      tenantGstin: t?.gstin ?? null,
      tenantEmail: t?.email ?? null,
      tenantPhone: t?.phone ?? null,
      tenantAddress: t?.address ?? null,
      tenantLogo: logo,
      customerName: st.customerName,
      customerGstin: raw.customer.gstin,
      customerAddress: customerAddress(raw.customer),
      asOn: st.asOn,
      lines: st.lines,
      total: st.total,
      bank: proformaBank(t),
      upiQrDataUrl: upi?.dataUrl ?? null,
      upiVpa: upi?.vpa ?? null,
      /* No customer-level online pay page exists yet (Razorpay links are minted per quote and
         send their own message — payment-link.server.ts), so none is printed. */
      payLinkUrl: null,
    }) as unknown as Parameters<typeof renderToBuffer>[0],
  );
  return Buffer.from(buffer);
}

/** Load + build + render, for the two PDF routes. Null → customer not in this company. */
export async function pendingDuesPdfFor(db: Db, opts: { customerId: string; tenantId: string; today: string }):
  Promise<{ pdf: Buffer; statement: PendingDuesStatement; raw: PendingDuesRaw } | null> {
  const raw = await loadPendingDuesRaw(db, opts);
  if (!raw) return null;
  const statement = buildPendingDuesStatement(raw, opts.today);
  return { pdf: await renderPendingDuesPdf(raw, statement), statement, raw };
}
