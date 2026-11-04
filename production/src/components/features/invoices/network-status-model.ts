/**
 * R-2450 (G-NETWORK N2c) — what the SELLER reads about its customer's answer on a network copy
 * (R-2434: an issued invoice / credit note / debit note to a connected customer lands in their
 * Purchase Inbox as Pending; they Accept or Reject with a reason).
 *
 * One status line on the invoice page (and on each note under it), one short chip in the
 * invoices list — both from networkStatusView, so the page and the list never use different words.
 * Pure: the rows come from network_seller_document_status (./network-status.tsx).
 *
 * Note: lib/network/documents.ts also has sentStatusLabel / sentNextStep (R-2434, no screen used
 * them). These screens use the words here ("… on network — Pending"); that file is left as it is
 * while R-2449 builds the buyer tab on it — fold the two together afterwards.
 */
import type { NetworkSentDoc } from "@/lib/network/documents";

export type NetworkTone = "info" | "success" | "danger" | "muted";

export interface NetworkStatusView {
  /** Short word for the list chip. */
  chip: string;
  /** The whole sentence on the invoice / note. */
  line: string;
  tone: NetworkTone;
  /** What the seller does next, or null when nothing is needed. */
  nextStep: string | null;
}

const fmtIstDate = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};

export function networkStatusView(d: NetworkSentDoc): NetworkStatusView {
  const buyer = d.buyerName.trim() || "your customer";
  const head = `Sent to ${buyer} on network`;
  const isInvoice = d.kind === "invoice";
  switch (d.status) {
    case "accepted": {
      const on = fmtIstDate(d.respondedAt);
      return {
        chip: "Accepted",
        line: `${head} — Accepted by customer${on ? ` on ${on}` : ""}`,
        tone: "success",
        nextStep: isInvoice
          ? "Your customer accepted this invoice — it is locked. Correct it with a credit note."
          : "Your customer accepted this note — it is locked. Any further change goes as another note.",
      };
    }
    case "rejected":
      return {
        chip: "Rejected",
        line: `${head} — Rejected by customer: ${d.rejectReason?.trim() || "no reason given"}`,
        tone: "danger",
        nextStep: isInvoice
          ? "Issue a credit note and a fresh invoice."
          : "Talk to your customer — if this note is wrong, issue a fresh note.",
      };
    case "cancelled":
      return { chip: "Cancelled", line: `${head} — Cancelled`, tone: "muted", nextStep: null };
    case "pending":
    default:
      return { chip: "Pending", line: `${head} — Pending`, tone: "info", nextStep: null };
  }
}

const newestFirst = (a: NetworkSentDoc, b: NetworkSentDoc) => b.createdAt.localeCompare(a.createdAt);

/** The invoice's own copy (newest, if it was ever sent twice) — never a note's. null = no badge. */
export function invoiceNetworkDoc(rows: readonly NetworkSentDoc[] | undefined, invoiceId: string): NetworkSentDoc | null {
  if (!rows) return null;
  return [...rows].filter((r) => r.kind === "invoice" && r.sellerInvoiceId === invoiceId).sort(newestFirst)[0] ?? null;
}

/** A credit / debit note's own copy, by the note's id. */
export function noteNetworkDoc(rows: readonly NetworkSentDoc[] | undefined, noteId: string): NetworkSentDoc | null {
  if (!rows) return null;
  return [...rows].filter((r) => r.kind !== "invoice" && r.sellerNoteId === noteId).sort(newestFirst)[0] ?? null;
}

/** The invoices list: invoice id → its chip (invoice copies only, newest wins). */
export function networkChipByInvoice(rows: readonly NetworkSentDoc[] | undefined): Map<string, NetworkStatusView> {
  const out = new Map<string, NetworkStatusView>();
  const picked = new Map<string, NetworkSentDoc>();
  for (const r of rows ?? []) {
    if (r.kind !== "invoice") continue;
    const cur = picked.get(r.sellerInvoiceId);
    if (!cur || r.createdAt > cur.createdAt) picked.set(r.sellerInvoiceId, r);
  }
  for (const [id, d] of picked) out.set(id, networkStatusView(d));
  return out;
}
