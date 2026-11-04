/**
 * R-2459 — the customer-copy gate for a LIST of quotes (the Quotes list's WhatsApp follow-up).
 *
 * Chrome check, 4 Nov 2026: the list row's "WhatsApp" stayed live for Q-F588-27-0008 (no state)
 * and opened web.whatsapp.com naming the quote and its amount, while the quote page locked every
 * customer copy. The row asks customerCopyBlock — the same rule, nothing re-written here — with
 * the buyer read in one batch (useQuoteCopyParties) instead of per row.
 *
 * Like the quote page: until the states have loaded (`ctx` null) only the approval half runs, and
 * a customer / lead row this user cannot read is never judged "no state" (left to the server).
 */
import { customerCopyBlock, type CustomerCopyBlock, type CustomerCopyParties, type CustomerCopyQuote } from "./customer-copy-gate";

export interface CustomerCopyRowsContext {
  /** Customers by id — as loadCustomerCopyParties reads them. */
  customers: ReadonlyMap<string, NonNullable<CustomerCopyParties["customer"]>>;
  /** Leads by id — used only for a quote with no customer. */
  leads: ReadonlyMap<string, NonNullable<CustomerCopyParties["lead"]>>;
  seller: CustomerCopyParties["seller"];
  role?: string | null;
}

export function customerCopyBlockForRow(quote: CustomerCopyQuote, ctx: CustomerCopyRowsContext | null): CustomerCopyBlock | null {
  if (!ctx) return customerCopyBlock(quote, null);
  const customer = quote.customer_id ? ctx.customers.get(quote.customer_id) ?? null : null;
  const lead = !quote.customer_id && quote.lead_id ? ctx.leads.get(quote.lead_id) ?? null : null;
  const unreadable = (!!quote.customer_id && !customer) || (!quote.customer_id && !!quote.lead_id && !lead);
  if (unreadable) return customerCopyBlock(quote, null);
  return customerCopyBlock(quote, { customer, lead, seller: ctx.seller, role: ctx.role ?? null });
}
