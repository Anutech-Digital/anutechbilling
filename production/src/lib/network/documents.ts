/**
 * R-2434 (G-NETWORK N2) — documents between two connected businesses: my issued invoice (and its
 * credit notes) lands as a PENDING copy with my customer; they Accept (→ one bill in their books),
 * Reject (with a reason I see) or leave it Pending — like GST IMS. Our Accept files nothing on the
 * GST portal. Spec: docs/specs/g-network.md.
 *
 * The database does the work (migration *_r2434_network_documents.sql): the copy is frozen at
 * issue, deduped by seller GSTIN + number + FY, and an accepted document is locked on both sides.
 * This file is the typed edge the screens use — buyer: Purchases → Inbox "From network" (R-2449);
 * seller: the status on the invoice (R-2450). Mappers + labels are pure so the screens and the
 * test agree; the calls are SECURITY DEFINER RPCs newer than the generated Database types, so
 * they go through the same narrow untyped rpc as ./client.ts.
 */
import { createClient } from "@/lib/supabase/client";

export type NetworkDocKind = "invoice" | "credit_note" | "debit_note";
export type NetworkDocStatus = "pending" | "accepted" | "rejected" | "cancelled";

export interface NetworkDocLine {
  description: string;
  detail: string | null;
  hsnSac: string;
  quantity: number;
  rate: number;
  amount: number;
}

/** One document in the BUYER's inbox (a copy frozen at the seller's issue). */
export interface NetworkInboxDoc {
  id: string;
  kind: NetworkDocKind;
  status: NetworkDocStatus;
  sellerName: string;
  sellerGstin: string;
  docNumber: string;
  docDate: string;
  fy: string;
  documentType: "tax_invoice" | "bill_of_supply" | "other";
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  currency: string;
  dueDate: string | null;
  pdfUrl: string | null;
  irn: string | null;
  lines: NetworkDocLine[];
  /** Credit / debit note: the invoice it corrects (the seller's number). */
  sellerInvoiceId: string;
  parentDocumentId: string | null;
  rejectReason: string | null;
  vendorBillId: string | null;
  linkedExisting: boolean;
  applyNote: string | null;
  createdAt: string;
  respondedAt: string | null;
}

/** What the SELLER sees about a document it sent. */
export interface NetworkSentDoc {
  id: string;
  kind: NetworkDocKind;
  sellerInvoiceId: string;
  sellerNoteId: string | null;
  docNumber: string;
  buyerName: string;
  buyerGstin: string;
  status: NetworkDocStatus;
  rejectReason: string | null;
  respondedAt: string | null;
  createdAt: string;
}

export interface AcceptResult {
  documentId: string;
  vendorBillId: string;
  /** true = a bill the buyer had already typed (same seller GSTIN + number + FY) was linked. */
  linkedExisting: boolean;
  note: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const STATUSES: readonly NetworkDocStatus[] = ["pending", "accepted", "rejected", "cancelled"];
const status = (v: unknown): NetworkDocStatus => (STATUSES.includes(v as NetworkDocStatus) ? (v as NetworkDocStatus) : "pending");
const kind = (v: unknown): NetworkDocKind => (v === "credit_note" || v === "debit_note" ? v : "invoice");

function toLines(v: unknown): NetworkDocLine[] {
  if (!Array.isArray(v)) return [];
  return v.map((l: Row) => ({
    description: String(l?.description ?? ""),
    detail: str(l?.detail),
    hsnSac: String(l?.hsn_sac ?? ""),
    quantity: num(l?.quantity),
    rate: num(l?.rate),
    amount: int(l?.amount),
  }));
}

export function toInboxDoc(r: Row): NetworkInboxDoc {
  const p = (r.payload && typeof r.payload === "object" ? r.payload : {}) as Row;
  const dt = r.document_type;
  return {
    id: String(r.id),
    kind: kind(r.kind),
    status: status(r.status),
    sellerName: String(r.seller_name ?? ""),
    sellerGstin: String(r.seller_gstin ?? ""),
    docNumber: String(r.doc_number ?? ""),
    docDate: String(r.doc_date ?? ""),
    fy: String(r.fy ?? ""),
    documentType: dt === "bill_of_supply" || dt === "other" ? dt : "tax_invoice",
    taxableValue: int(r.taxable_value),
    cgst: int(r.cgst),
    sgst: int(r.sgst),
    igst: int(r.igst),
    total: int(r.total),
    currency: String(r.currency ?? "INR"),
    dueDate: str(p.due_date),
    pdfUrl: str(p.pdf_url),
    irn: str(p.irn),
    lines: toLines(p.lines),
    sellerInvoiceId: String(r.seller_invoice_id ?? ""),
    parentDocumentId: str(r.parent_document_id),
    rejectReason: str(r.reject_reason),
    vendorBillId: str(r.vendor_bill_id),
    linkedExisting: Boolean(r.linked_existing),
    applyNote: str(r.apply_note),
    createdAt: String(r.created_at ?? ""),
    respondedAt: str(r.responded_at),
  };
}

export function toSentDoc(r: Row): NetworkSentDoc {
  return {
    id: String(r.id),
    kind: kind(r.kind),
    sellerInvoiceId: String(r.seller_invoice_id ?? ""),
    sellerNoteId: str(r.seller_note_id),
    docNumber: String(r.doc_number ?? ""),
    buyerName: String(r.buyer_name ?? ""),
    buyerGstin: String(r.buyer_gstin ?? ""),
    status: status(r.status),
    rejectReason: str(r.reject_reason),
    respondedAt: str(r.responded_at),
    createdAt: String(r.created_at ?? ""),
  };
}

const fmtDate = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};

/** The one line the seller sees on its invoice / credit note (R-2450 shows it). */
export function sentStatusLabel(d: NetworkSentDoc): string {
  switch (d.status) {
    case "pending":
      return `Sent to ${d.buyerName} — waiting for them to accept`;
    case "accepted":
      return `Accepted by customer${d.respondedAt ? ` on ${fmtDate(d.respondedAt)}` : ""}`;
    case "rejected":
      return `Rejected by customer: ${d.rejectReason ?? "no reason given"}`;
    case "cancelled":
      return d.kind === "invoice"
        ? `Cancelled — you voided this invoice before ${d.buyerName} answered`
        : `Cancelled — the note was changed / deleted or its invoice voided before ${d.buyerName} answered`;
  }
}

/** The next step for the seller after the buyer's answer, or null when there is none. */
export function sentNextStep(d: NetworkSentDoc): string | null {
  if (d.status === "rejected") return "Talk to the customer; if the invoice is wrong, issue a credit note and a fresh invoice.";
  if (d.status === "accepted") return "Locked on both sides — any change goes as a credit note.";
  return null;
}

/** Buyer-side: may this copy still be answered? Reject is final (the seller corrects with a
 *  credit note + a fresh invoice). */
export function canAccept(d: Pick<NetworkInboxDoc, "status">): boolean {
  return d.status === "pending";
}
export function canReject(d: Pick<NetworkInboxDoc, "status">): boolean {
  return d.status === "pending";
}
/** Undo an Accept (a wrong click): invoices and debit notes, not credit notes (they changed the
 *  bill in place). The database also needs the bill untouched and outside locked books. */
export function canUndoAccept(d: Pick<NetworkInboxDoc, "status" | "kind">): boolean {
  return d.status === "accepted" && d.kind !== "credit_note";
}

/** A reject reason the seller will read — required, trimmed, at most 500 characters. */
export function cleanRejectReason(reason: string): string {
  const r = (reason ?? "").trim();
  if (!r) throw new Error("Write the reason — the seller sees it on their invoice.");
  return r.slice(0, 500);
}

// ── calls ───────────────────────────────────────────────────────────────────────────
type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function call(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  const c = createClient() as unknown as { rpc: Rpc };
  const { data, error } = await c.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

/** Buyer: documents my connected sellers sent me (owner / manager / accountant; others get none). */
export async function listNetworkInbox(onlyStatus?: NetworkDocStatus): Promise<NetworkInboxDoc[]> {
  const rows = (await call("network_inbox", { p_status: onlyStatus ?? null })) as Row[] | null;
  return (rows ?? []).map(toInboxDoc);
}

/** Buyer: accept → one bill (or my matching bill linked); a credit note lowers that bill. */
export async function acceptNetworkDocument(id: string, category?: string | null): Promise<AcceptResult> {
  const rows = (await call("network_accept_document", { p_id: id, p_category: category ?? null })) as Row[] | null;
  const r = rows?.[0] ?? {};
  return {
    documentId: String(r.document_id ?? id),
    vendorBillId: String(r.vendor_bill_id ?? ""),
    linkedExisting: Boolean(r.linked_existing),
    note: str(r.note),
  };
}

/** Buyer: reject with the reason the seller will see. */
export async function rejectNetworkDocument(id: string, reason: string): Promise<void> {
  await call("network_reject_document", { p_id: id, p_reason: cleanRejectReason(reason) });
}

/** Seller: what my customers answered — all sent documents, or those of one invoice. */
export async function listSentNetworkDocuments(invoiceId?: string): Promise<NetworkSentDoc[]> {
  const rows = (await call("network_seller_documents", { p_invoice_id: invoiceId ?? null })) as Row[] | null;
  return (rows ?? []).map(toSentDoc);
}

/** Buyer: take back an Accept — the bill it made goes (untouched, open books) or the linked bill is
 *  unlinked; the copy is pending again. */
export async function undoNetworkAccept(id: string): Promise<void> {
  await call("network_undo_accept", { p_id: id });
}
