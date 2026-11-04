/**
 * R-2402 — "Book selected" of the bulk "Reconcile from Zoho": the ticked plan rows booked ONE AT A
 * TIME through the Reconcile sheet's own steps — no new money RPC:
 *
 *   1. a customer Zoho has and the app does not → created (useCreateCustomer: name, GSTIN, state,
 *      treatment, and Zoho's contact email / phone when it has them); the same company on two lines
 *      of one run is created once;
 *   2. a payer who is not the customer, matched by the bank UTR → recorded on the line as paying on
 *      the customer's behalf (set_bank_line_payer — the sheet's R-2025 answer);
 *   3. the sale → reconcile_bank_credit_new_sale (newSaleArgs, + the first instalment and the Zoho
 *      invoice number, exactly as useNewSaleFromBankCredit);
 *   4. each further new subscription gets its OWN start / renewal from its Zoho line.
 *
 * R-2419: a row whose plan PAYS an open quote / invoice goes through reconcile_bank_credit_to_item
 * (the sheet's "This money is for" step — a below-cost quote is still refused there until it is
 * approved); a row that settles last year's OPENING invoice is recorded on it with
 * record_multi_invoice_payment (Record payment's own call — a retry with the same reference is a
 * replay, never a second receipt) and the bank line is then matched to that payment with
 * reconcile_bank_txn (as "Match & record payment" does).
 *
 * Never twice: a row already booked in this run, or a line the database already shows as reconciled,
 * is skipped (the RPC refuses a reconciled line too). The first error STOPS the run and is reported;
 * rows after it stay unbooked for the next press.
 */
import { newSaleFxRpcArgs, type NewSaleInput, type PayItemInput } from "@/lib/queries/bank-credit-pay-for";
import type { PayForResult } from "@/lib/banking/credit-pay-for";
import type { LinePayerAnswer } from "@/lib/queries/customer-payers";
import { mapGstTreatment } from "@/lib/integrations/zoho-books/import-plan";
import { suggestGstTreatment, panFromGstin } from "@/lib/gst/customer-gst-treatment";
import { describeError } from "@/lib/errors/toast-error";
import { rupee } from "@/lib/utils";
import { defaultContactName } from "@/components/features/customers/new-customer-contact";
import { bankLinePaymentReference } from "@/lib/payments/bank-line-reference";
import type { SplitInput } from "@/lib/banking/credit-pay-for-multi";
import {
  newCustomerKey, rowsToBook, type DateFix, type FxInvoicePay, type OpeningCreate, type PlanCustomer, type PlanRow, type SaleFx,
} from "@/lib/integrations/zoho-books/bulk-reconcile-plan";

type NewCustomer = Extract<PlanCustomer, { kind: "new" }>;

/** The customers row a Zoho customer is created with (useCreateCustomer adds the tenant + contact). */
export function newCustomerPayload(c: NewCustomer) {
  const foreign = !["", "in", "ind", "india", "bharat"].includes(c.country.trim().toLowerCase());
  const gstin = foreign ? null : c.gstin;
  return {
    customer_type: c.customerType,
    name: c.name,
    gstin,
    state: c.state,
    state_code: foreign ? null : c.stateCode,
    country: c.country || "India",
    gst_treatment: mapGstTreatment(c.gstTreatment) ?? suggestGstTreatment({ country: c.country, gstin, customerType: c.customerType }),
    pan: foreign ? null : panFromGstin(gstin),
    contact_name: defaultContactName({ personName: c.contactName, customerName: c.name }),
    contact_email: c.email,
    contact_phone: c.phone,
  };
}
export type NewCustomerPayload = ReturnType<typeof newCustomerPayload>;

export interface SubForFix { id: string; plan: string; seats: number; domain: string | null; start_date: string | null; renewal_date: string | null }

/** Which subscription of the sale each date fix is for: same domain and seats (the product breaks a tie). */
export function matchDateFixes(subs: readonly SubForFix[], fixes: readonly DateFix[]): Array<{ fix: DateFix; subId: string | null }> {
  const used = new Set<string>();
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return fixes.map((fix) => {
    const cands = subs.filter((s) => !used.has(s.id) && (s.domain ?? "").toLowerCase() === (fix.domain ?? "").toLowerCase() && s.seats === fix.qty);
    const pick = cands.find((s) => norm(s.plan) === norm(fix.name)) ?? (cands.length === 1 ? cands[0] : null);
    if (pick) used.add(pick.id);
    return { fix, subId: pick?.id ?? null };
  });
}

export interface BookDeps {
  /** Is this bank line reconciled already (read fresh, own company)? */
  isReconciled: (txnId: string) => Promise<boolean>;
  createCustomer: (p: NewCustomerPayload) => Promise<string>;
  setPayer: (a: LinePayerAnswer) => Promise<void>;
  newSale: (i: NewSaleInput) => Promise<PayForResult>;
  /** The sale's subscriptions (quote_id), for the per-line dates. */
  saleSubscriptions: (quoteId: string) => Promise<SubForFix[]>;
  setSubDates: (subId: string, start: string, renewal: string) => Promise<void>;
  /** R-2419 (e): pay an open quote / invoice — reconcile_bank_credit_to_item. */
  payItem: (i: PayItemInput) => Promise<PayForResult>;
  /** R-2419 (a): settle an opening invoice and match the line to that receipt (payOpeningInvoice). */
  payOpening: (i: OpeningPayInput) => Promise<OpeningPaid>;
  /** R-2425: an export receipt — the sale in its currency at the bank's rate (reconcile_bank_credit_new_sale_fx). */
  newSaleFx?: (i: NewSaleInput, fx: SaleFx) => Promise<PayForResult>;
  /** R-2427: an export receipt paying an invoice in its currency (reconcile_bank_credit_fx_invoice). */
  payFxInvoice?: (args: ReturnType<typeof fxInvoiceArgs>) => Promise<PayForResult>;
  /** R-2474: make last year's opening invoices from Zoho (ensureOpeningInvoices) → app invoice id by
   *  upper-cased Zoho number. */
  ensureOpenings?: (customerId: string, creates: OpeningCreate[]) => Promise<Map<string, string>>;
  /** R-2474: one bank line → several opening invoices (reconcile_bank_credit_split, R-2466 path). */
  paySplit?: (i: SplitInput) => Promise<PayForResult>;
}

/** R-2474: import_opening_invoices' rows (R-1739's shape — the CSV import's toImportRpcRows). */
export function openingImportRows(customerId: string, creates: readonly OpeningCreate[]) {
  return creates.map((c) => ({
    number: c.number, invoice_date: c.invoiceDate, due_date: c.dueDate, customer_id: customerId,
    total: c.total, balance: c.balance, currency: "INR", gstin: c.gstin, pos_state_code: c.posStateCode,
  }));
}

export interface OpeningInvoiceRow { id: string; external_number: string | null; customer_id: string | null; document_kind: string | null }

/**
 * R-2474: last year's invoices made as opening invoices from Zoho's data — import_opening_invoices
 * (R-1739: GST / revenue stay in Zoho, never counted again; one atomic batch). The Zoho number is the
 * key: a number already in the company is SKIPPED by the import, so a re-run (or two lines paying one
 * invoice) uses the same invoice. Then each number is read back to its app invoice id; a number that is
 * a sale invoice here, or another customer's, is refused before any money is recorded.
 */
export async function ensureOpeningInvoices(
  customerId: string, creates: readonly OpeningCreate[], rpc: Rpc,
  read: (numbers: string[]) => Promise<OpeningInvoiceRow[]>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (creates.length === 0) return out;
  const { error } = await rpc("import_opening_invoices", { p_rows: openingImportRows(customerId, creates), p_file_name: "Reconcile from Zoho (bank line)" });
  if (error) throw new Error(error.message);
  const rows = await read(creates.map((c) => c.number));
  for (const c of creates) {
    const key = c.number.toUpperCase();
    const hit = rows.find((r) => (r.external_number ?? "").toUpperCase() === key) ?? null;
    if (!hit) throw new Error(`The opening invoice for Zoho's ${c.number} was not made — nothing was recorded on this line. Press Book selected again.`);
    if (hit.document_kind !== "opening_invoice") throw new Error(`Zoho's ${c.number} is already in the app as a sale invoice (${hit.id}) — reconcile this line by hand.`);
    if (hit.customer_id !== customerId) throw new Error(`Zoho's ${c.number} is already in the app as an opening invoice of another customer — reconcile this line by hand.`);
    out.set(key, hit.id);
  }
  return out;
}

/** R-2427: the reconcile_bank_credit_fx_invoice arguments — the narration's currency, rate and amount. */
export function fxInvoiceArgs(txnId: string, invoiceId: string, fx: FxInvoicePay, sub: { createSubscription: boolean | null; subStart: string | null } = { createSubscription: null, subStart: null }) {
  return {
    p_txn_id: txnId,
    p_invoice_id: invoiceId,
    p_currency: fx.currency,
    p_fx_rate: fx.rate,
    p_foreign_amount: fx.foreignAmount,
    /* the plan's subscription choice (e.g. Zoho's term already ended → none), as payItem sends it */
    p_create_subscription: sub.createSubscription,
    p_sub_start: sub.createSubscription ? sub.subStart : null,
  };
}

/** R-2425: the reconcile_bank_credit_new_sale_fx arguments — exported so the test pins what reaches
 *  the server. No TDS (a foreign customer deducts none); the Zoho number always sent (null = none). */
export function newSaleFxArgs(i: NewSaleInput, fx: SaleFx) {
  return {
    /* R-2427: one builder for the 11 arguments (lib/queries — the Reconcile sheet uses it too). */
    ...newSaleFxRpcArgs(i, fx),
    /* R-2427: Zoho billed more (charges kept abroad) → the 12-argument function books them as Bank Charges. */
    ...(fx.billed && fx.billed > fx.foreignAmount ? { p_foreign_billed: fx.billed } : {}),
  };
}

/** R-2427: what the server booked (its bank_charges / forex_difference; the plan's figures only if it gave none). */
export function fxPaidText(invoiceId: string, currency: string, res: { bank_charges?: number; forex_difference?: number }, plan: FxInvoicePay): string {
  const charges = Number(res.bank_charges ?? plan.bankCharges) || 0;
  const forex = Number(res.forex_difference ?? plan.forex) || 0;
  return `Paid invoice ${invoiceId} in full in ${currency}${charges ? ` — Bank Charges ${rupee(charges)}` : ""}${forex ? ` — forex ${forex < 0 ? "gain" : "loss"} ${rupee(Math.abs(forex))}` : ""} — line reconciled.`;
}

/** R-2425: an export receipt goes through the foreign-currency sale; everything else as before. */
function saleFor(book: NonNullable<PlanRow["book"]>, input: NewSaleInput, deps: BookDeps): Promise<PayForResult> {
  if (!book.fx) return deps.newSale(input);
  if (!deps.newSaleFx) throw new Error(`This line is an export receipt in ${book.fx.currency}, and this screen cannot book it in that currency. Reload the page and try again.`);
  return deps.newSaleFx(input, book.fx);
}

/** R-2419 (a): one bank line settling one opening invoice imported from Zoho. */
export interface OpeningPayInput {
  transactionId: string;
  customerId: string;
  invoiceId: string;
  /** The bank money, whole rupees. */
  received: number;
  receivedOn: string;
  reference: string;
  tdsAmount: number;
  tdsRatePct: number | null;
  tdsSection: string | null;
}
export interface OpeningPaid { paymentId: string; alreadyRecorded: boolean }

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** The record_multi_invoice_payment arguments — exported so the test pins what reaches the server. */
export function openingPaymentArgs(i: OpeningPayInput, bankAccountId: string) {
  const tds = Math.max(0, Math.round(i.tdsAmount));
  return {
    p_customer_id: i.customerId,
    p_received_on: i.receivedOn,
    p_method: "bank_transfer",
    p_bank_account_id: bankAccountId,
    p_reference: bankLinePaymentReference(i.reference, i.transactionId),   // R-2430: a placeholder ref is not this line's UTR
    p_received: Math.round(i.received),
    p_allocations: [{
      invoice_id: i.invoiceId, amount: Math.round(i.received), tds_amount: tds,
      ...(tds > 0 ? { tds_section: i.tdsSection || "194J", tds_rate_pct: i.tdsRatePct } : {}),
    }],
    p_excess_to_credit: false,
    p_notes: "Reconcile from Zoho: last year's invoice, settled from the bank line",
  };
}

/**
 * R-2419 (a): two existing calls, in order — (1) record_multi_invoice_payment records the receipt on
 * the opening invoice (a retry with the same reference returns the SAME payment: idempotent_replay),
 * (2) reconcile_bank_txn matches the bank line to it. If (2) fails, pressing Book again replays (1)
 * and retries (2) — the money is never recorded twice.
 */
export async function payOpeningInvoice(i: OpeningPayInput, bankAccountId: string, rpc: Rpc): Promise<OpeningPaid> {
  const { data, error } = await rpc("record_multi_invoice_payment", openingPaymentArgs(i, bankAccountId));
  if (error) throw new Error(error.message);
  const out = (data ?? {}) as { idempotent_replay?: boolean; lines?: Array<{ payment_id?: string | null }> };
  const paymentId = out.lines?.find((l) => l?.payment_id)?.payment_id ?? null;
  if (!paymentId) throw new Error("The receipt on the opening invoice was not confirmed — refresh the page and check the invoice before trying again.");
  const { error: e2 } = await rpc("reconcile_bank_txn", {
    p_txn_id: i.transactionId, p_matched_to_type: "payment", p_matched_to_id: paymentId, p_match_confidence: "manual",
  });
  if (e2) throw new Error(`The receipt was recorded on the opening invoice, but the bank line was not matched to it: ${e2.message} Press Book selected again — it matches the same receipt, never a second one.`);
  return { paymentId, alreadyRecorded: Boolean(out.idempotent_replay) };
}

export interface BookedRow {
  txnId: string;
  txnDate: string;
  credit: number;
  outcome: "booked" | "skipped" | "needs_approval";
  customerName: string;
  customerCreated: boolean;
  quoteId: string | null;
  invoiceId: string | null;
  subscriptions: Array<{ id: string; plan: string | null }>;
  /** Things a person should still do (seat differences, renewal dates, prices …). */
  todo: string[];
  text: string;
}

export interface BookRun { done: BookedRow[]; error: { txnId: string; txnDate: string; credit: number; reason: string } | null }

/** §24: plumbing errors in plain words (describeError); an RPC guard's own sentence as written. */
const msg = (e: unknown) => { const d = describeError(e); return d.description ? `${d.message} ${d.description}` : d.message; };

export async function bookRows(
  rows: readonly PlanRow[], ticked: ReadonlySet<string>, alreadyBooked: ReadonlySet<string>, deps: BookDeps,
  onEach?: (r: BookedRow, index: number, total: number) => void,
): Promise<BookRun> {
  const queue = rowsToBook(rows, ticked, alreadyBooked);
  const done: BookedRow[] = [];
  const created = new Map<string, string>();
  for (let i = 0; i < queue.length; i++) {
    const row = queue[i];
    const book = row.book!;
    const cust = row.customer!;
    try {
      /* R-2425: an export receipt needs the foreign-currency sale — said BEFORE any customer or payer is saved. */
      if (book.kind === "new_sale" && book.fx && !deps.newSaleFx) {
        throw new Error(`This line is an export receipt in ${book.fx.currency}, and this screen cannot book it in that currency. Reload the page and try again.`);
      }
      const fxPay = book.kind === "pay_item" ? book.item?.fx ?? null : null;
      if (fxPay && (!deps.payFxInvoice || !book.item?.invoiceId)) {
        throw new Error(`This line is an export receipt in ${fxPay.currency}, and this screen cannot pay an invoice in that currency. Reload the page and try again.`);
      }
      /* R-2474: last year's invoice made from Zoho needs this screen's opening-invoice steps — said
         BEFORE any customer or payer is saved. */
      const opParts = book.kind === "opening" && !book.opening?.invoiceId ? book.opening?.parts ?? [] : [];
      if ((opParts.some((p) => p.create) && !deps.ensureOpenings) || (opParts.length > 1 && !deps.paySplit)) {
        throw new Error("This line settles last year's invoice from Zoho, and this screen cannot make its opening invoice. Reload the page and try again.");
      }
      if (await deps.isReconciled(row.txnId)) {
        const r: BookedRow = {
          txnId: row.txnId, txnDate: row.txnDate, credit: row.credit, outcome: "skipped", customerName: cust.name, customerCreated: false,
          quoteId: null, invoiceId: null, subscriptions: [], todo: [], text: "Already reconciled — skipped, nothing booked again.",
        };
        done.push(r); onEach?.(r, i, queue.length);
        continue;
      }
      let customerId: string;
      let customerCreated = false;
      if (cust.kind === "existing") customerId = cust.id;
      else {
        const key = newCustomerKey(cust);
        const have = created.get(key);
        if (have) customerId = have;
        else {
          customerId = await deps.createCustomer(newCustomerPayload(cust));
          created.set(key, customerId);
          customerCreated = true;
        }
      }
      if (row.payer?.record) {
        await deps.setPayer({ transactionId: row.txnId, customerId, payer: row.payer.payer, relation: row.payer.record.relation, note: row.payer.record.note });
      }
      if (book.kind === "opening" && book.opening && !book.opening.invoiceId && book.opening.parts?.length) {
        /* R-2474: last year's invoice(s) — opening invoices made from Zoho where the app has none,
           then paid with this line through R-2466's opening path (never a new sale). */
        const parts = book.opening.parts;
        const creates = parts.flatMap((p) => (p.create ? [p.create] : []));
        const made = creates.length ? await deps.ensureOpenings!(customerId, creates) : new Map<string, string>();
        const ids = parts.map((p) => {
          const id = p.invoiceId ?? made.get(p.number.toUpperCase());
          if (!id) throw new Error(`The opening invoice for Zoho's ${p.number} was not found — nothing was recorded on this line. Press Book selected again.`);
          return id;
        });
        const res = parts.length === 1
          ? await deps.payItem({
            transactionId: row.txnId, quoteId: null, invoiceId: ids[0],
            tdsAmount: book.tdsAmount, tdsRatePct: book.tdsRatePct, tdsSection: book.tdsSection,
            createSubscription: null, subStart: null, subRenewal: null,
          })
          : await deps.paySplit!({
            transactionId: row.txnId, customerId, sale: null, rest: null,
            items: parts.map((p, k) => ({ quote_id: null, invoice_id: ids[k], amount: p.amount })),
          });
        const nos = parts.map((p) => p.number).join(", ");
        const madeNos = parts.filter((p) => p.create).map((p) => p.number);
        const r: BookedRow = {
          txnId: row.txnId, txnDate: row.txnDate, credit: row.credit, outcome: "booked", customerName: cust.name, customerCreated,
          quoteId: null, invoiceId: ids[0], subscriptions: [], todo: [...row.notes],
          text: res.already_recorded ? `Receipt was already on opening invoice ${nos} — nothing booked again.`
            : parts.length === 1
              ? (madeNos.length ? `Opening invoice ${nos} made from Zoho and paid — line reconciled.` : `Opening balance settled — receipt on ${nos}, line reconciled.`)
              : `Opening invoices ${nos} settled${madeNos.length ? ` (made from Zoho: ${madeNos.join(", ")})` : ""} — line reconciled.`,
        };
        done.push(r); onEach?.(r, i, queue.length);
        continue;
      }
      if (book.kind === "opening" && book.opening?.invoiceId) {
        /* R-2419 (a): last year's invoice — a receipt on its opening invoice, never a new sale. */
        const paid = await deps.payOpening({
          transactionId: row.txnId, customerId, invoiceId: book.opening.invoiceId, received: book.opening.received,
          receivedOn: row.txnDate, reference: book.opening.reference,
          tdsAmount: book.tdsAmount, tdsRatePct: book.tdsRatePct, tdsSection: book.tdsSection,
        });
        const r: BookedRow = {
          txnId: row.txnId, txnDate: row.txnDate, credit: row.credit, outcome: "booked", customerName: cust.name, customerCreated,
          quoteId: null, invoiceId: book.opening.invoiceId, subscriptions: [], todo: [...row.notes],
          text: paid.alreadyRecorded
            ? `Receipt was already on opening invoice ${book.opening.number ?? book.opening.invoiceId} — line matched to it.`
            : `Opening balance settled — receipt on ${book.opening.number ?? book.opening.invoiceId}, line reconciled.`,
        };
        done.push(r); onEach?.(r, i, queue.length);
        continue;
      }
      const res = fxPay && book.item?.invoiceId && deps.payFxInvoice
        /* R-2427: settled in full in its currency; Bank Charges / forex lines in the same call. */
        ? await deps.payFxInvoice(fxInvoiceArgs(row.txnId, book.item.invoiceId, fxPay, book.item))
        : book.kind === "pay_item" && book.item
        ? await deps.payItem({
          /* R-2419 (e): the open quote / invoice of this money — the sheet's own "This money is for". */
          transactionId: row.txnId, quoteId: book.item.quoteId, invoiceId: book.item.invoiceId,
          tdsAmount: book.tdsAmount, tdsRatePct: book.tdsRatePct, tdsSection: book.tdsSection,
          createSubscription: book.item.createSubscription, subStart: book.item.subStart, subRenewal: null,
        })
        : await saleFor(book, {
        transactionId: row.txnId, customerId, lines: book.lines, createSubscription: book.createSubscription,
        subStart: book.subStart, subRenewal: book.subRenewal, tdsAmount: book.tdsAmount, tdsRatePct: book.tdsRatePct,
        tdsSection: book.tdsSection, billingCycle: book.billingCycle, externalNumber: book.externalNumber,
      }, deps);
      const todo = [
        ...row.seatDiffs.map((d) => `Seats: ${d.plan}${d.domain ? ` (${d.domain})` : ""} has ${d.appSeats} in the app, Zoho billed ${d.zohoSeats}.`),
        ...row.notes,
      ];
      if (res.needs_approval) {
        const r: BookedRow = {
          txnId: row.txnId, txnDate: row.txnDate, credit: row.credit, outcome: "needs_approval", customerName: cust.name, customerCreated,
          quoteId: res.quote_id, invoiceId: null, subscriptions: [], todo: [...todo, `Priced below cost — quote ${res.quote_id} waits for approval; the line stays unmatched.`],
          text: `Sent for approval (below cost) — quote ${res.quote_id}.`,
        };
        done.push(r); onEach?.(r, i, queue.length);
        continue;
      }
      if (book.dateFixes.length && res.quote_id) {
        try {
          const subs = await deps.saleSubscriptions(res.quote_id);
          for (const m of matchDateFixes(subs, book.dateFixes)) {
            if (!m.subId) { todo.push(`Renewal: set ${m.fix.name}${m.fix.domain ? ` (${m.fix.domain})` : ""} to start ${m.fix.start}, renew ${m.fix.renewal} — its subscription was not found.`); continue; }
            await deps.setSubDates(m.subId, m.fix.start, m.fix.renewal);
          }
        } catch (e) {
          todo.push(`Renewal dates were not set (${msg(e)}) — set them on the new subscriptions by hand.`);
        }
      }
      const r: BookedRow = {
        txnId: row.txnId, txnDate: row.txnDate, credit: row.credit, outcome: "booked", customerName: cust.name, customerCreated,
        quoteId: res.quote_id, invoiceId: res.invoice_issued ?? res.invoice_id ?? null,
        subscriptions: (res.subscriptions ?? []).map((s) => ({ id: s.id, plan: s.plan })),
        todo,
        text: res.already_recorded ? "Already recorded before — nothing booked again."
          : fxPay ? fxPaidText(book.item?.invoiceId ?? "", fxPay.currency, res as PayForResult & { bank_charges?: number; forex_difference?: number }, fxPay)
          : book.kind === "pay_item" ? `Paid open ${book.item?.invoiceId ? `invoice ${book.item.invoiceId}` : `quote ${book.item?.quoteId ?? res.quote_id}`} — line reconciled.`
          : book.fx ? `Booked in ${book.fx.currency} at the bank's rate (₹${book.fx.rate}) and reconciled.${book.fx.billed && book.fx.billed > book.fx.foreignAmount ? " The short part is booked as Bank Charges." : ""}`
          : "Booked and reconciled.",
      };
      done.push(r); onEach?.(r, i, queue.length);
    } catch (e) {
      return { done, error: { txnId: row.txnId, txnDate: row.txnDate, credit: row.credit, reason: msg(e) } };
    }
  }
  return { done, error: null };
}
