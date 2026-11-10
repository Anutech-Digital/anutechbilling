/**
 * R-2535 — the bank-credit booking calls, server-safe (no "use client"): the Reconcile sheet's
 * hooks (lib/queries/bank-credit-pay-for.ts) and the server's Reconcile-from-Zoho run
 * (app/api/integrations/zoho-books/bulk-book) send the SAME arguments to the SAME RPCs.
 * Moved unchanged from bank-credit-pay-for.ts (R-1838 … R-2518); `call` is the caller's
 * Supabase rpc (browser or server session) and `post` its fetch.
 */
import type { PayForResult, SaleLine } from "@/lib/banking/credit-pay-for";
import { saleLinesPayload } from "@/lib/banking/credit-pay-for";
import { isSplitBilled } from "@/lib/billing/instalments";
import { splitArgs, type SplitInput } from "@/lib/banking/credit-pay-for-multi";
import type { BillingCycle } from "@/lib/supabase/database.types";
import type { ItemFx } from "@/lib/banking/item-fx-pay";

export type RpcCall = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

export interface PayItemInput {
  transactionId: string;
  quoteId: string | null;
  invoiceId: string | null;
  tdsAmount: number;
  tdsRatePct: number | null;
  /** R-2095: the Income-tax section the customer deducted under (lib/banking/tds-section); default 194J. */
  tdsSection?: string | null;
  /** null = not a new subscription sale (the server ignores it). */
  createSubscription: boolean | null;
  subStart: string | null;
  /** Sent only when the operator changed it; else the term decides. */
  subRenewal: string | null;
  /** R-2466: an invoice in a foreign currency paid by its inward remittance (lib/banking/item-fx-pay)
   *  → reconcile_bank_credit_fx_invoice (R-2427). null / absent = ₹, reconcile_bank_credit_to_item. */
  fx?: ItemFx | null;
}

export interface NewSaleInput {
  transactionId: string;
  customerId: string;
  lines: readonly SaleLine[];
  createSubscription: boolean;
  subStart: string | null;
  subRenewal: string | null;
  tdsAmount: number;
  tdsRatePct: number | null;
  /** R-2095: the Income-tax section the customer deducted under; default 194J. */
  tdsSection?: string | null;
  /** R-2026: how often it is billed (the quote's billing_cycle). Null/absent = the server's
   *  default (yearly; Monthly flex is always monthly). */
  billingCycle?: BillingCycle | null;
  /** R-2360: the Zoho invoice number from "Find in Zoho" — kept on the sale's invoice
   *  (invoices.external_number); a number already in the app is refused. Absent = none. */
  externalNumber?: string | null;
  /** R-2427 (3): book it in this currency at the bank's rate (reconcile_bank_credit_new_sale_fx). Absent = ₹. */
  fx?: SaleFxInput | null;
}

/** The RPC arguments — exported so the tests pin exactly what reaches the server. */
export function payItemArgs(i: PayItemInput) {
  return {
    p_txn_id: i.transactionId,
    p_quote_id: i.invoiceId ? null : i.quoteId,
    p_invoice_id: i.invoiceId,
    p_tds_amount: Math.max(0, Math.round(i.tdsAmount)),
    p_tds_rate_pct: i.tdsAmount > 0 ? i.tdsRatePct : null,
    p_tds_section: i.tdsAmount > 0 ? (i.tdsSection || "194J") : null,
    p_create_subscription: i.createSubscription,
    p_sub_start: i.createSubscription ? i.subStart : null,
    p_sub_renewal: i.createSubscription ? i.subRenewal : null,
  };
}

export function newSaleArgs(i: NewSaleInput) {
  return {
    p_txn_id: i.transactionId,
    p_customer_id: i.customerId,
    p_lines: saleLinesPayload(i.lines),
    p_create_subscription: i.createSubscription,
    p_sub_start: i.createSubscription ? i.subStart : null,
    p_sub_renewal: i.createSubscription ? i.subRenewal : null,
    p_tds_amount: Math.max(0, Math.round(i.tdsAmount)),
    p_tds_rate_pct: i.tdsAmount > 0 ? i.tdsRatePct : null,
    p_tds_section: i.tdsAmount > 0 ? (i.tdsSection || "194J") : null,
    p_billing_cycle: i.billingCycle ?? null,
    /* R-2360: sent only when there is one — without it the call resolves to the old 10-argument function. */
    ...(i.externalNumber?.trim() ? { p_external_number: i.externalNumber.trim() } : {}),
  };
}

/** R-2360: what the server said about the Zoho invoice number (migration 20261102061607). */
export type ZohoKept = { external_number?: string | null; external_number_saved?: boolean; external_number_error?: string | null };

/**
 * R-2360: a sale billed in parts has no invoice when the RPC returns (external_number_saved =
 * false); once raiseFirstInstalment has raised the first part's invoice, the Zoho number is kept
 * on it (set_invoice_external_number — owner/manager/accountant/billing, own company, a number
 * already in the app refused). The sale is already booked: a failure here only says so.
 */
export async function keepZohoNumberOnFirstPart<T extends PayForResult & ZohoKept>(
  r: T, call: RpcCall,
): Promise<T> {
  if (!r.external_number || r.external_number_saved !== false || !r.invoice_issued) return r;
  const { error } = await call("set_invoice_external_number", { p_invoice_id: r.invoice_issued, p_external_number: r.external_number });
  if (error) return { ...r, external_number_error: error.message };
  return { ...r, external_number_saved: true };
}

/**
 * R-2026: a sale paid in parts (annual commitment billed quarterly …) gets its FIRST bill's tax
 * invoice now — the Record payment sheet's own call (R-527: POST /api/quotes/:id/raise-instalments,
 * the billing cron's code; idempotent per period). The payment is already booked; a failure here
 * only says the daily run will raise it.
 */
export async function raiseFirstInstalment(r: PayForResult, cycle: BillingCycle | null | undefined, post: typeof fetch = fetch): Promise<PayForResult> {
  if (!isSplitBilled(cycle) || !r.quote_id || r.already_recorded || r.invoice_issued) return r;
  try {
    /* R-2095 (Sept): afterSale — the paid part's invoice only, no next-period request at sale time. */
    const resp = await post(`/api/quotes/${encodeURIComponent(r.quote_id)}/raise-instalments`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ afterSale: true }),
    });
    const body = (await resp.json().catch(() => null)) as
      { raised?: Array<{ invoice_id?: string | null }>; errors?: Array<{ message?: string }>; error?: string } | null;
    if (!resp.ok || !body) return { ...r, instalment_error: body?.error ?? `HTTP ${resp.status}` };
    const first = body.raised?.find((x) => x?.invoice_id)?.invoice_id ?? null;
    if (first) return { ...r, invoice_issued: first };
    const err = body.errors?.[0]?.message ?? null;
    return err ? { ...r, instalment_error: err } : r;
  } catch (e) {
    return { ...r, instalment_error: e instanceof Error ? e.message : String(e) };
  }
}

/** R-2466: the RPC arguments of an export receipt on one invoice (reconcile_bank_credit_fx_invoice). */
export function payItemFxArgs(i: PayItemInput, fx: ItemFx) {
  return {
    p_txn_id: i.transactionId,
    p_invoice_id: i.invoiceId,
    p_currency: fx.currency,
    p_fx_rate: fx.rate,
    p_foreign_amount: fx.foreignAmount,
    p_create_subscription: i.createSubscription,
    p_sub_start: i.createSubscription ? i.subStart : null,
  };
}

/** One item paid from the line — ONE server call. R-2466: a foreign invoice goes the R-2427 way. */
export async function payItemCall(input: PayItemInput, call: RpcCall): Promise<PayForResult> {
  if (input.fx) {
    if (!input.invoiceId) throw new Error(`Only an invoice can take an export receipt in ${input.fx.currency}.`);
    if (input.tdsAmount > 0) throw new Error(`A customer abroad deducts no Indian TDS — clear the TDS to book this receipt in ${input.fx.currency}.`);
    /* reconcile_bank_credit_fx_invoice files the subscription on its term's own renewal date. */
    if (input.createSubscription && input.subRenewal) throw new Error(`An export receipt in ${input.fx.currency} takes the term's own renewal date — clear the changed "Renews on" date, or change it on the subscription afterwards.`);
  }
  const { data, error } = input.fx
    ? await call("reconcile_bank_credit_fx_invoice", payItemFxArgs(input, input.fx))
    : await call("reconcile_bank_credit_to_item", payItemArgs(input));
  if (error) throw error;
  if (!data) throw new Error("The payment was not confirmed — refresh the page to see whether it was saved.");
  return data as PayForResult;
}

/** R-2427 (3): a new sale in the remittance's currency at the bank's rate (one atomic call: sale,
 *  receipt, reconcile, quote + invoice stamped with the currency and rate). Never billed in parts, no TDS. */
export async function newSaleInCurrency(input: NewSaleInput, fx: SaleFxInput, call: RpcCall): Promise<PayForResult> {
  if (input.billingCycle && isSplitBilled(input.billingCycle)) {
    throw new Error(`A sale in ${fx.currency} billed in parts cannot be booked here — choose a yearly term, or book it in ₹.`);
  }
  if (input.tdsAmount > 0) throw new Error(`A customer abroad deducts no Indian TDS — clear the TDS to book this sale in ${fx.currency}.`);
  const { data, error } = await call("reconcile_bank_credit_new_sale_fx", newSaleFxRpcArgs(input, fx));
  if (error) throw error;
  if (!data) throw new Error("The sale was not confirmed — refresh the page to see whether it was saved.");
  return data as PayForResult;
}

/** R-2427 (3): the reconcile_bank_credit_new_sale_fx arguments for the sheet's Save of a Find-in-Zoho
 *  prefill in a foreign currency — no TDS (a foreign customer deducts none); the Zoho number always sent. */
export type SaleFxInput = { currency: string; rate: number; foreignAmount: number };
export function newSaleFxRpcArgs(i: NewSaleInput, fx: SaleFxInput) {
  const a = newSaleArgs(i);
  return {
    p_txn_id: a.p_txn_id, p_customer_id: a.p_customer_id, p_lines: a.p_lines,
    p_create_subscription: a.p_create_subscription, p_sub_start: a.p_sub_start, p_sub_renewal: a.p_sub_renewal,
    p_billing_cycle: a.p_billing_cycle, p_external_number: i.externalNumber?.trim() || null,
    p_currency: fx.currency, p_fx_rate: fx.rate, p_foreign_amount: fx.foreignAmount,
  };
}

/** useNewSaleFromBankCredit's call: a ₹ sale (raise the first instalment, keep the Zoho number) or
 *  the R-2427 sale in its currency. */
export async function newSaleCall(input: NewSaleInput, call: RpcCall, post: typeof fetch = fetch): Promise<PayForResult> {
  if (input.fx) return newSaleInCurrency(input, input.fx, call);
  const { data, error } = await call("reconcile_bank_credit_new_sale", newSaleArgs(input));
  if (error) throw error;
  if (!data) throw new Error("The sale was not confirmed — refresh the page to see whether it was saved.");
  /* R-2397: below cost — the quote waits for approval, nothing was booked (no instalment). */
  if ((data as PayForResult).needs_approval) return data as PayForResult;
  return keepZohoNumberOnFirstPart(await raiseFirstInstalment(data as PayForResult & ZohoKept, input.billingCycle, post), call);
}

/** useSplitFromBankCredit's call (R-2098 / R-2518): ONE reconcile_bank_credit_split transaction,
 *  then each new sale's first instalment and Zoho number. */
export async function splitCall(input: SplitInput & { customerName?: string | null }, call: RpcCall, post: typeof fetch = fetch): Promise<PayForResult> {
  const { data, error } = await call("reconcile_bank_credit_split", splitArgs(input));
  if (error) throw error;
  if (!data) throw new Error("The payments were not confirmed — refresh the page to see whether they were saved.");
  const r = data as PayForResult & ZohoKept;
  /* R-2397: the new sale is below cost — nothing on the line was paid; its quote waits. */
  if (r.needs_approval) return { ...r, customer_id: input.customerId, customer_name: input.customerName ?? null };
  /* R-2518: several new sales (one per Zoho invoice) — the n-th new-quote part is the n-th sale. */
  const sales = input.sale ? (Array.isArray(input.sale) ? input.sale : [input.sale]) : [];
  let n = 0;
  const parts = await Promise.all((r.parts ?? []).map(async (p) => {
    if (!p.new_quote) return p;
    const s = sales[n++];
    const raised = await raiseFirstInstalment(p, (s?.billingCycle ?? null) as BillingCycle | null, post);
    /* R-2518: a per-Zoho sale billed in parts — its own number on its first part's invoice. */
    return sales.length > 1 ? keepZohoNumberOnFirstPart<PayForResult & ZohoKept>(raised as PayForResult & ZohoKept, call) : raised;
  }));
  /* R-2360: the new sale billed in parts — its first part's invoice gets the Zoho number now. */
  const sale = parts.find((p) => p.new_quote);
  const kept = sale && r.external_number
    ? await keepZohoNumberOnFirstPart<PayForResult & ZohoKept>({ ...sale, external_number: r.external_number, external_number_saved: r.external_number_saved }, call)
    : null;
  return {
    ...r, parts, customer_id: input.customerId, customer_name: input.customerName ?? null,
    ...(kept ? { external_number_saved: kept.external_number_saved, external_number_error: kept.external_number_error ?? null } : {}),
  };
}
