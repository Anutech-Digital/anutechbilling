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
 * Never twice: a row already booked in this run, or a line the database already shows as reconciled,
 * is skipped (the RPC refuses a reconciled line too). The first error STOPS the run and is reported;
 * rows after it stay unbooked for the next press.
 */
import type { NewSaleInput } from "@/lib/queries/bank-credit-pay-for";
import type { PayForResult } from "@/lib/banking/credit-pay-for";
import type { LinePayerAnswer } from "@/lib/queries/customer-payers";
import { mapGstTreatment } from "@/lib/integrations/zoho-books/import-plan";
import { suggestGstTreatment, panFromGstin } from "@/lib/gst/customer-gst-treatment";
import { describeError } from "@/lib/errors/toast-error";
import { defaultContactName } from "@/components/features/customers/new-customer-contact";
import {
  newCustomerKey, rowsToBook, type DateFix, type PlanCustomer, type PlanRow,
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
      const res = await deps.newSale({
        transactionId: row.txnId, customerId, lines: book.lines, createSubscription: book.createSubscription,
        subStart: book.subStart, subRenewal: book.subRenewal, tdsAmount: book.tdsAmount, tdsRatePct: book.tdsRatePct,
        tdsSection: book.tdsSection, billingCycle: book.billingCycle, externalNumber: book.externalNumber,
      });
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
        todo, text: res.already_recorded ? "Already recorded before — nothing booked again." : "Booked and reconciled.",
      };
      done.push(r); onEach?.(r, i, queue.length);
    } catch (e) {
      return { done, error: { txnId: row.txnId, txnDate: row.txnDate, credit: row.credit, reason: msg(e) } };
    }
  }
  return { done, error: null };
}
