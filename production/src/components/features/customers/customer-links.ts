/**
 * R-1521 / R-1522 (17 Oct 2026, Pardeep) — two small pure rules behind the customer page.
 *
 * 1. `txnHref` — where a Transactions / Statement row goes. Pardeep clicked
 *    INV-A378-27-0001 on a customer's Transactions tab and nothing happened: only quotes
 *    and projects had a click. Every row now opens its own document.
 *    · invoice          → /invoices/<id>
 *    · quote            → /quotes/<id>            (only for roles that can open quotes, R-237)
 *    · payment          → /quotes/<quote_id>      (there is no payment detail page; the quote
 *                                                  page shows the payment history), else the
 *                                                  customer's receipts on /payments
 *    · project payment  → its invoice, else its project
 *    · project          → /projects/<id>
 *
 * 2. `primaryContactOf` — who to ring. The Overview card used to fall back to the COMPANY
 *    name ("GL · GREENTIN SOLUTIONS PRIVATE LIMITED") when there was no contact person, so
 *    the owner read a company as a person. A contact_name that only repeats the company
 *    name (an import mistake) counts as no contact.
 */
import type { Route } from "next";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";

export type TxnLink =
  | { kind: "invoice"; invoiceId: string }
  | { kind: "quote"; quoteId: string }
  | { kind: "payment"; quoteId: string | null; customerId: string }
  | { kind: "projectPayment"; invoiceId: string | null; projectId: string }
  | { kind: "project"; projectId: string };

export function txnHref(t: TxnLink, opts: { canQuotes: boolean }): Route | null {
  switch (t.kind) {
    case "invoice":
      return invoiceHref(t.invoiceId) as Route;
    case "quote":
      return opts.canQuotes ? (`/quotes/${encodeURIComponent(t.quoteId)}` as Route) : null;
    case "payment":
      return opts.canQuotes && t.quoteId
        ? (`/quotes/${encodeURIComponent(t.quoteId)}` as Route)
        : (`/payments?customer=${encodeURIComponent(t.customerId)}` as Route);
    case "projectPayment":
      return t.invoiceId
        ? (invoiceHref(t.invoiceId) as Route)
        : (`/projects/${encodeURIComponent(t.projectId)}` as Route);
    case "project":
      return `/projects/${encodeURIComponent(t.projectId)}` as Route;
  }
}

export interface PrimaryContact {
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
}

interface ContactLike {
  full_name: string | null;
  title?: string | null;
  phone?: string | null;
  email?: string | null;
  is_primary?: boolean | null;
}

interface CustomerLike {
  name: string;
  display_name?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  contact_phone?: string | null;
  contact_mobile?: string | null;
  contact_email?: string | null;
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** True when a "person" name is really just the company name again (import mistake). */
export function isCompanyName(person: string | null | undefined, c: CustomerLike): boolean {
  const p = norm(person);
  if (!p) return false;
  return p === norm(c.name) || (!!c.display_name && p === norm(c.display_name));
}

/**
 * The customer's primary contact person, or null when there is none.
 * Order: the PRIMARY linked contact → the first linked contact → the legacy flat
 * `contact_*` columns. A name that equals the company name is never returned.
 */
export function primaryContactOf(c: CustomerLike, contacts: readonly ContactLike[] | null | undefined): PrimaryContact | null {
  const linked = (contacts ?? []).filter((x) => (x.full_name ?? "").trim() && !isCompanyName(x.full_name, c));
  const pick = linked.find((x) => x.is_primary) ?? linked[0];
  if (pick) {
    return {
      name: (pick.full_name ?? "").trim(),
      title: pick.title?.trim() || null,
      phone: pick.phone?.trim() || null,
      email: pick.email?.trim() || null,
    };
  }
  const flat = c.contact_name?.trim();
  if (flat && !isCompanyName(flat, c)) {
    return {
      name: flat,
      title: c.contact_title?.trim() || null,
      phone: c.contact_phone?.trim() || c.contact_mobile?.trim() || null,
      email: c.contact_email?.trim() || null,
    };
  }
  return null;
}
