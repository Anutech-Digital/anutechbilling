/**
 * R-2535 — the booking steps of "Reconcile from Zoho" on the SERVER, as bookRows (zoho-bulk-book.ts)
 * needs them. Every step is the call the Reconcile sheet makes, with the signed-in person's own
 * Supabase session (RLS + each RPC's role / company checks apply exactly as in the browser):
 *   set_bank_line_payer, reconcile_bank_credit_new_sale(_fx), reconcile_bank_credit_to_item,
 *   reconcile_bank_credit_fx_invoice, reconcile_bank_credit_split, record_multi_invoice_payment +
 *   reconcile_bank_txn, import_opening_invoices — through lib/banking/credit-pay-calls.ts, the
 *   module the sheet's hooks use too. No new money write path.
 * A Zoho customer the app does not have is created by the browser BEFORE the run (the customer form's
 * own path with its contact person); here createCustomer refuses.
 * raise-instalments (a sale billed in parts) is the app's own route, called with the person's cookie.
 */
import type { BookDeps, OpeningInvoiceRow, SubForFix } from "@/components/features/banking/zoho-bulk-book";
import { ensureOpeningInvoices, fxInvoiceArgs, newSaleFxArgs, payOpeningInvoice } from "@/components/features/banking/zoho-bulk-book";
import { newSaleCall, payItemCall, splitCall, type RpcCall } from "@/lib/banking/credit-pay-calls";
import type { PayForResult } from "@/lib/banking/credit-pay-for";

type Res<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;
/** The slice of a Supabase client the run uses (server session in the route, a fake in tests). */
export interface RunDb {
  rpc: RpcCall;
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, v: string) => { maybeSingle: () => Res<unknown> } & Res<unknown[]>;
      or: (filter: string) => Res<unknown[]>;
    };
    update: (v: Record<string, unknown>) => { eq: (col: string, v: string) => Res<unknown> };
  };
}

/** A fetch to the app's own route (raise-instalments) as the signed-in person. */
export function sameOriginPost(origin: string, cookie: string | null): typeof fetch {
  return (input, init) => {
    const url = new URL(String(input), origin);
    if (url.origin !== new URL(origin).origin) throw new Error("Only the app's own routes are called from a run.");
    return fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...(cookie ? { cookie } : {}) } });
  };
}

async function one<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  if (!data) throw new Error(`${what} was not confirmed — refresh the page to see whether it was saved.`);
  return data as T;
}

export function serverBookDeps(db: RunDb, accountId: string, post: typeof fetch): BookDeps {
  const rpc: RpcCall = (fn, args) => db.rpc(fn, args);
  return {
    isReconciled: async (txnId) => {
      const { data, error } = await db.from("bank_transactions").select("matched_to_type").eq("id", txnId).maybeSingle();
      if (error) throw new Error(`Could not check the bank line before booking: ${error.message}`);
      if (!data) throw new Error("This bank line is no longer in the account (a statement re-import may have replaced it). Reload the page.");
      return (data as { matched_to_type: string | null }).matched_to_type !== null;
    },
    createCustomer: async (p) => {
      throw new Error(`${p.name} is not in the app yet — press Book again (the page adds Zoho's new customers first).`);
    },
    setPayer: async (a) => {
      const { error } = await rpc("set_bank_line_payer", {
        p_txn_id: a.transactionId, p_customer_id: a.customerId, p_payer_name: a.payer.name, p_relation: a.relation,
        p_note: a.note, p_ifsc: a.payer.ifsc, p_upi: a.payer.upi, p_account_tail: a.payer.accountTail,
      });
      if (error) throw error;
    },
    newSale: (i) => newSaleCall(i, rpc, post),
    payItem: (i) => payItemCall(i, rpc),
    paySplit: (i) => splitCall(i, rpc, post),
    newSaleFx: (i, fx) => one<PayForResult>(rpc("reconcile_bank_credit_new_sale_fx", newSaleFxArgs(i, fx)), "The sale"),
    payFxInvoice: (args) => one<PayForResult>(rpc("reconcile_bank_credit_fx_invoice", args as ReturnType<typeof fxInvoiceArgs>), "The payment"),
    payOpening: (i) => payOpeningInvoice(i, accountId, rpc),
    saleSubscriptions: async (quoteId) => {
      const { data, error } = await db.from("subscriptions").select("id, plan, seats, domain, start_date, renewal_date").eq("quote_id", quoteId);
      if (error) throw new Error(error.message);
      return (data ?? []) as SubForFix[];
    },
    setSubDates: async (subId, start, renewal) => {
      const { error } = await db.from("subscriptions").update({ start_date: start, renewal_date: renewal }).eq("id", subId);
      if (error) throw new Error(error.message);
    },
    ensureOpenings: (customerId, creates) => ensureOpeningInvoices(customerId, creates, rpc, async (numbers) => {
      const { data, error } = await db.from("invoices").select("id, external_number, customer_id, document_kind")
        .or(numbers.map((n) => `external_number.ilike."${n.replace(/["\\]/g, "_")}"`).join(","));
      if (error) throw new Error(`Could not read the opening invoices back: ${error.message}`);
      return (data ?? []) as OpeningInvoiceRow[];
    }),
  };
}
