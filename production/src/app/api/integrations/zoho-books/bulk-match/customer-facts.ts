/**
 * R-2419 — what the app ALREADY has for the app customers of one bulk-match page, so the plan can
 * stop double bookings before "Book selected" (lib/integrations/zoho-books/bulk-reconcile-plan.ts):
 *
 *   openItems — the customer's open quotes / unpaid invoices: bank_credit_open_items, called with
 *               the SIGNED-IN user's session (the Reconcile sheet's own list; the function checks the
 *               company and the money role itself), + whether each quote is priced below cost and
 *               not approved (paymentApprovalBlock — the trigger's rule);
 *   openings  — opening invoices imported from Zoho that still have money due;
 *   receipts  — receipts booked for the customer within 35 days of the page's lines;
 *   billed    — billed periods (with an invoice) of the customer's subscriptions;
 *   booksStart — the day after the company's opening balances date.
 *
 * Every table read is filtered by the caller's own tenant (the admin client bypasses RLS — §17c).
 * READ-ONLY. A failed read throws FactsReadError: the page is refused rather than planned blind.
 */
import type { ZohoCaller } from "@/lib/integrations/zoho-books/store";
import { mapZohoCustomer } from "@/lib/integrations/zoho-books/payment-prefill";
import { paymentApprovalBlock } from "@/lib/quotes/payment-approval";
import {
  DOUBLE_DAYS, nextDay, type BulkMatchRow, type CustomerFacts, type OpenItemFact,
} from "@/lib/integrations/zoho-books/bulk-reconcile-plan";

export class FactsReadError extends Error {}

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const num = (v: unknown) => Number(v ?? 0) || 0;
/** Days back the billed periods are read (a yearly term + a month). */
const BILLED_DAYS = 400;

interface OpenItemRow {
  kind: string; quote_id: string | null; invoice_id: string | null; doc_date: string | null;
  amount_due: number | string | null; taxable_value: number | string | null; makes_subscription: boolean | null;
}

/** Adds `facts` (app customers; null for one new from Zoho) and `booksStart` to each row. */
export async function attachCustomerFacts(
  rows: readonly BulkMatchRow[],
  caller: Pick<ZohoCaller, "admin" | "tenantId">,
  userDb: RpcClient,
  appCustomers: ReadonlyArray<{ id: string; name: string; gstin: string | null }>,
): Promise<BulkMatchRow[]> {
  const { admin, tenantId } = caller;
  const custOf = (r: BulkMatchRow) => (r.result.kind === "match" ? mapZohoCustomer(r.result.match.customer, appCustomers)?.id ?? null : null);

  const ob = await admin.from("opening_balances").select("as_of").eq("tenant_id", tenantId).order("as_of", { ascending: false }).limit(1);
  if (ob.error) throw new FactsReadError("the opening balances date");
  const asOf = ((ob.data ?? [])[0] as { as_of?: string | null } | undefined)?.as_of ?? null;
  const booksStart = asOf ? nextDay(String(asOf).slice(0, 10)) : null;

  const ids = [...new Set(rows.map(custOf).filter((x): x is string => !!x))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, facts: null, booksStart }));

  const dates = rows.map((r) => r.line.txnDate).sort();
  const from = shiftDays(dates[0], -DOUBLE_DAYS);
  const to = shiftDays(dates[dates.length - 1], DOUBLE_DAYS);

  const [opn, pay, sub] = await Promise.all([
    admin.from("invoices").select("id, customer_id, external_number, invoice_date, amount, net_payable, paid_amount")
      .eq("tenant_id", tenantId).in("customer_id", ids).eq("document_kind", "opening_invoice")
      .in("status", ["pending", "overdue"]).is("written_off_at", null),
    admin.from("payments").select("id, customer_id, amount, received_at, reference")
      .eq("tenant_id", tenantId).in("customer_id", ids).eq("status", "received")
      .gte("received_at", `${from}T00:00:00Z`).lte("received_at", `${to}T23:59:59Z`),
    admin.from("subscriptions").select("id, customer_id").eq("tenant_id", tenantId).in("customer_id", ids),
  ]);
  if (opn.error) throw new FactsReadError("the opening invoices");
  if (pay.error) throw new FactsReadError("the receipts");
  if (sub.error) throw new FactsReadError("the subscriptions");

  const subOwner = new Map(((sub.data ?? []) as Array<{ id: string; customer_id: string | null }>).map((s) => [s.id, s.customer_id]));
  const billedRows: Array<{ subscription_id: string; period_start: string; period_end: string; invoice_id: string | null }> = [];
  if (subOwner.size > 0) {
    const b = await admin.from("subscription_billings").select("subscription_id, period_start, period_end, invoice_id")
      .eq("tenant_id", tenantId).in("subscription_id", [...subOwner.keys()]).not("invoice_id", "is", null)
      .gte("period_end", shiftDays(dates[0], -BILLED_DAYS));
    if (b.error) throw new FactsReadError("the billed periods");
    billedRows.push(...((b.data ?? []) as typeof billedRows));
  }

  /* Open quotes / invoices — the sheet's own list, per customer, with the user's session. */
  const items = new Map<string, OpenItemRow[]>();
  for (const id of ids) {
    const { data, error } = await userDb.rpc("bank_credit_open_items", { p_customer_id: id });
    if (error) throw new FactsReadError("the open quotes and invoices");
    /* R-2466: the list now carries Zoho opening invoices too (kind "opening"); the plan matches those
       through `openings` (last year's invoice by number), never by amount as a this-year item. */
    items.set(id, ((data ?? []) as OpenItemRow[]).filter((r) => r.kind !== "opening"));
  }
  const quoteIds = [...new Set([...items.values()].flat().map((r) => r.quote_id).filter((x): x is string => !!x))];
  const blocks = new Map<string, string>();
  /* R-2427: the quote's currency / rate — an invoice with none of its own falls back to it (as reconcile_bank_credit_fx_invoice does). */
  const quoteFx = new Map<string, { currency: string; fxRate: number }>();
  if (quoteIds.length > 0) {
    const q = await admin.from("quotes").select("id, below_cost, approval_status, currency, exchange_rate").eq("tenant_id", tenantId).in("id", quoteIds);
    if (q.error) throw new FactsReadError("the quotes' approvals");
    for (const row of (q.data ?? []) as Array<{ id: string; currency?: string | null; exchange_rate?: number | string | null }>) {
      const cur = (row.currency ?? "").trim().toUpperCase();
      const rate = Number(row.exchange_rate ?? 0);
      if (cur && cur !== "INR" && rate > 0) quoteFx.set(row.id, { currency: cur, fxRate: rate });
    }
    for (const row of q.data ?? []) {
      const b = paymentApprovalBlock(row as { id: string; below_cost: boolean | null; approval_status: string | null });
      if (b) blocks.set((row as { id: string }).id, b.reason);
    }
  }

  /* R-2427: an open invoice in a foreign currency (its rate at issue) — an export receipt pays it in that currency. */
  const invoiceIds = [...new Set([...items.values()].flat().map((r) => r.invoice_id).filter((x): x is string => !!x))];
  const invFx = new Map<string, { currency: string; fxRate: number }>();
  if (invoiceIds.length > 0) {
    const iv = await admin.from("invoices").select("id, currency, fx_rate, quote_id").eq("tenant_id", tenantId).in("id", invoiceIds);
    if (iv.error) throw new FactsReadError("the open invoices' currency");
    for (const row of (iv.data ?? []) as Array<{ id: string; currency: string | null; fx_rate: number | string | null; quote_id: string | null }>) {
      const q = row.quote_id ? quoteFx.get(row.quote_id) ?? null : null;
      const cur = ((row.currency ?? "").trim() || q?.currency || "").toUpperCase();
      const rate = Number(row.fx_rate ?? 0) || (q && q.currency === cur ? q.fxRate : 0);
      if (cur && cur !== "INR" && rate > 0) invFx.set(row.id, { currency: cur, fxRate: rate });
    }
  }

  const facts = new Map<string, CustomerFacts>(ids.map((id) => [id, {
    customerId: id,
    openItems: (items.get(id) ?? []).map((r): OpenItemFact => ({
      kind: r.kind, quoteId: r.quote_id, invoiceId: r.invoice_id, docDate: r.doc_date ? String(r.doc_date).slice(0, 10) : null,
      due: num(r.amount_due), taxable: num(r.taxable_value), makesSubscription: Boolean(r.makes_subscription),
      approvalBlock: r.quote_id ? blocks.get(r.quote_id) ?? null : null,
      currency: r.invoice_id ? invFx.get(r.invoice_id)?.currency ?? null : null,
      fxRate: r.invoice_id ? invFx.get(r.invoice_id)?.fxRate ?? null : null,
    })),
    openings: [], receipts: [], billed: [],
  }]));
  for (const r of (opn.data ?? []) as Array<{ id: string; customer_id: string | null; external_number: string | null; invoice_date: string | null; amount: number | null; net_payable: number | null; paid_amount: number | null }>) {
    const f = r.customer_id ? facts.get(r.customer_id) : null;
    const due = Math.max(0, num(r.net_payable ?? r.amount) - num(r.paid_amount));
    if (f && due > 0) f.openings.push({ id: r.id, number: r.external_number, date: r.invoice_date ? String(r.invoice_date).slice(0, 10) : null, due });
  }
  for (const r of (pay.data ?? []) as Array<{ id: string; customer_id: string | null; amount: number | null; received_at: string; reference: string | null }>) {
    const f = r.customer_id ? facts.get(r.customer_id) : null;
    if (f) f.receipts.push({ id: r.id, date: String(r.received_at).slice(0, 10), amount: num(r.amount), reference: r.reference });
  }
  for (const r of billedRows) {
    const owner = subOwner.get(r.subscription_id);
    const f = owner ? facts.get(owner) : null;
    if (f && r.invoice_id) f.billed.push({ subId: r.subscription_id, start: String(r.period_start).slice(0, 10), end: String(r.period_end).slice(0, 10), invoiceId: r.invoice_id });
  }
  return rows.map((r) => {
    const id = custOf(r);
    return { ...r, facts: id ? facts.get(id) ?? null : null, booksStart };
  });
}
