/**
 * R-2449 (G-NETWORK N2b) — pure rules behind Purchases → Inbox "From network".
 *
 * The documents, their states and every Accept / Reject / Undo check live in the database
 * (R-2434, lib/network/documents.ts). This file only decides how the buyer's screen groups and
 * words them, so the screen and its test agree:
 *   - credit / debit notes list under the invoice they correct;
 *   - each row says one thing about its state (Accepted names the bill, Rejected the reason);
 *   - Accept defaults the category to the vendor's own default, and says BEFORE accepting whether
 *     the GST becomes input credit — by the buyer's own rules (lib/gst/bill-itc, the same check
 *     the Add Bill dialog and the GST page use).
 */
import type { NetworkDocKind, NetworkDocStatus, NetworkInboxDoc } from "@/lib/network/documents";
import { billItcEligibility } from "@/lib/gst/bill-itc";
import { VENDOR_BILL_CATEGORIES } from "@/lib/queries/vendor-bills";
import { MONEY_WRITE_ROLES } from "@/lib/nav";
import { fyStartISO } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";

/** network_inbox / network_accept_document / network_reject_document allow exactly these roles
 *  (current_user_has_role('owner','manager','accountant')); anyone else sees no tab at all. */
export function canActOnNetwork(role: string | null | undefined): boolean {
  return !!role && (MONEY_WRITE_ROLES as readonly string[]).includes(role);
}

export type InboxFilter = NetworkDocStatus | "all";

export interface InboxGroup {
  /** An invoice, or a note whose invoice is not in the list. */
  doc: NetworkInboxDoc;
  /** Credit / debit notes on that invoice, oldest first. */
  notes: NetworkInboxDoc[];
}

export function groupInbox(docs: readonly NetworkInboxDoc[]): InboxGroup[] {
  const invoices = new Map<string, InboxGroup>();
  for (const d of docs) if (d.kind === "invoice") invoices.set(d.id, { doc: d, notes: [] });
  const out: InboxGroup[] = [];
  for (const d of docs) {
    if (d.kind === "invoice") { out.push(invoices.get(d.id)!); continue; }
    const parent = d.parentDocumentId ? invoices.get(d.parentDocumentId) : undefined;
    if (parent) parent.notes.push(d);
    else out.push({ doc: d, notes: [] });
  }
  for (const g of out) g.notes.sort((a, b) => a.docDate.localeCompare(b.docDate) || a.createdAt.localeCompare(b.createdAt));
  return out;
}

/** "All" keeps notes under their invoice. A status filter shows exactly the documents its count
 *  counts: an invoice that matches (with only its matching notes), and a matching note on its own
 *  when its invoice does not match — never a row of another status with that status's buttons. */
export function filterGroups(groups: readonly InboxGroup[], f: InboxFilter): InboxGroup[] {
  if (f === "all") return [...groups];
  const out: InboxGroup[] = [];
  for (const g of groups) {
    const notes = g.notes.filter((n) => n.status === f);
    if (g.doc.status === f) out.push({ doc: g.doc, notes });
    else for (const n of notes) out.push({ doc: n, notes: [] });
  }
  return out;
}

export function statusCounts(docs: readonly NetworkInboxDoc[]): Record<InboxFilter, number> {
  const c: Record<InboxFilter, number> = { all: docs.length, pending: 0, accepted: 0, rejected: 0, cancelled: 0 };
  for (const d of docs) c[d.status] += 1;
  return c;
}

const KIND_LABEL: Readonly<Record<NetworkDocKind, string>> = {
  invoice: "Invoice",
  credit_note: "Credit note",
  debit_note: "Debit note",
};
export const kindLabel = (k: NetworkDocKind): string => KIND_LABEL[k];

/** The one line a row says about its state. */
export function rowStatusText(d: NetworkInboxDoc): string {
  switch (d.status) {
    case "pending":
      return "Pending";
    case "accepted": {
      const bill = d.vendorBillId ?? "—";
      if (d.kind === "credit_note") return `Accepted — lowered bill ${bill}`;
      return d.linkedExisting ? `Accepted — linked to your bill ${bill}` : `Accepted — bill ${bill}`;
    }
    case "rejected":
      return `Rejected: ${d.rejectReason ?? "no reason given"}`;
    case "cancelled":
      return "Cancelled by the seller";
  }
}

/** A note waits for its invoice (the database refuses otherwise — say it before the click). When
 *  that invoice can never be accepted (rejected — final — or voided), say the way that IS open. */
export function acceptBlockedReason(d: NetworkInboxDoc, parent: NetworkInboxDoc | null | undefined): string | null {
  if (d.kind === "invoice" || !parent) return null;
  switch (parent.status) {
    case "accepted": return null;
    case "rejected": return `You rejected invoice ${d.sellerInvoiceId} — reject this note too, or ask the seller for a fresh invoice.`;
    case "cancelled": return `The seller cancelled invoice ${d.sellerInvoiceId} — reject this note, or ask the seller.`;
    default: return `Accept invoice ${d.sellerInvoiceId} first.`;
  }
}

/** network_undo_accept refuses an invoice once a note on it is accepted — hide Undo and say why. */
export function undoBlockedReason(d: NetworkInboxDoc, notes: readonly NetworkInboxDoc[]): string | null {
  return d.kind === "invoice" && notes.some((n) => n.status === "accepted") ? "A note on it is accepted, so it stays accepted." : null;
}

/** Amounts in the document's own currency — never a foreign amount shown as rupees. */
export const money = (n: number, currency: string): string =>
  currency === "INR" ? rupee(n) : `${currency} ${n.toLocaleString("en-IN")}`;

/** The vendor's own default category when it is one the Bills screen knows, else COGS-Other. */
export function defaultAcceptCategory(vendorDefault: string | null | undefined): string {
  return vendorDefault && (VENDOR_BILL_CATEGORIES as readonly string[]).includes(vendorDefault) ? vendorDefault : "COGS-Other";
}

/** Before Accept: will this document's GST be input credit for ME — and if not, why. */
export function acceptItcLine(
  d: Pick<NetworkInboxDoc, "documentType" | "sellerGstin" | "cgst" | "sgst" | "igst" | "currency">,
  category: string,
  ownStateCode: string | null | undefined,
): { credit: boolean; text: string } {
  const gst = d.cgst + d.sgst + d.igst;
  if (gst <= 0) return { credit: false, text: "No GST on this document." };
  const v = billItcEligibility({
    document_type: d.documentType, vendor_gstin: d.sellerGstin, category,
    cgst: d.cgst, sgst: d.sgst, igst: d.igst, ownStateCode: ownStateCode ?? null,
  });
  return v.eligible
    ? { credit: true, text: `GST ${money(gst, d.currency)} will be your input credit (ITC).` }
    : { credit: false, text: `GST ${money(gst, d.currency)} stays a cost — ${v.reason ?? "not creditable"}.` };
}

/** "Open bill": the Bills list searched by the document number (= the bill's number), from the
 *  start of its financial year (the bill can be dated later when the books were locked). A credit
 *  note lowered its INVOICE's bill, so it points at that invoice's number and year. */
export function billsHref(
  d: Pick<NetworkInboxDoc, "kind" | "docNumber" | "docDate">,
  parent?: Pick<NetworkInboxDoc, "docNumber" | "docDate"> | null,
): string {
  const b = d.kind === "credit_note" && parent ? parent : d;
  return `/accounting/bills?q=${encodeURIComponent(b.docNumber)}&from=${fyStartISO(b.docDate)}`;
}
