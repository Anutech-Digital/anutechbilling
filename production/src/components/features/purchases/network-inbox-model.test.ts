/**
 * R-2449 (G-NETWORK N2b) — the pure rules behind Purchases → Inbox "From network": which rows sit
 * together, what each row says, what Accept defaults to and whether the buyer's GST becomes credit.
 */
import { describe, it, expect } from "vitest";
import type { NetworkInboxDoc } from "@/lib/network/documents";
import {
  groupInbox, filterGroups, statusCounts, rowStatusText, acceptBlockedReason, defaultAcceptCategory,
  acceptItcLine, billsHref, canActOnNetwork, kindLabel, undoBlockedReason, money,
} from "./network-inbox-model";

const base: NetworkInboxDoc = {
  id: "d1", kind: "invoice", status: "pending", sellerName: "Excel Pvt Ltd", sellerGstin: "07AAACE1234F1Z5",
  docNumber: "INV-001", docDate: "2026-11-04", fy: "2026-27", documentType: "tax_invoice",
  taxableValue: 10000, cgst: 900, sgst: 900, igst: 0, total: 11800, currency: "INR", dueDate: null,
  pdfUrl: null, irn: null, lines: [], sellerInvoiceId: "INV-001", parentDocumentId: null, rejectReason: null,
  vendorBillId: null, linkedExisting: false, applyNote: null, createdAt: "2026-11-04T05:00:00Z", respondedAt: null,
};
const doc = (p: Partial<NetworkInboxDoc>): NetworkInboxDoc => ({ ...base, ...p });

describe("R-2449 who acts", () => {
  it("only owner / manager / accountant — the same roles network_inbox and accept/reject allow", () => {
    for (const r of ["owner", "manager", "accountant"]) expect(canActOnNetwork(r)).toBe(true);
    for (const r of ["billing", "sales", "support", "delivery", "marketing", null, undefined]) expect(canActOnNetwork(r)).toBe(false);
  });
});

describe("R-2449 credit / debit notes list under their invoice", () => {
  it("a note sits under its invoice; a note whose invoice is not in the list stands alone", () => {
    const inv = doc({ id: "i1" });
    const cn = doc({ id: "c1", kind: "credit_note", docNumber: "CN-1", parentDocumentId: "i1" });
    const orphan = doc({ id: "c2", kind: "debit_note", docNumber: "DN-9", parentDocumentId: "gone" });
    const g = groupInbox([cn, inv, orphan]);
    expect(g.map((x) => x.doc.id)).toEqual(["i1", "c2"]);
    expect(g[0].notes.map((n) => n.id)).toEqual(["c1"]);
  });
  it("a status filter shows exactly the documents its count counts (a matching note alone when its invoice does not match)", () => {
    const inv = doc({ id: "i1", status: "accepted", vendorBillId: "VB-1" });
    const cn = doc({ id: "c1", kind: "credit_note", parentDocumentId: "i1", status: "pending" });
    const other = doc({ id: "i2", status: "rejected", rejectReason: "Not ordered" });
    const g = groupInbox([inv, cn, other]);
    const pending = filterGroups(g, "pending");
    expect(pending.map((x) => x.doc.id)).toEqual(["c1"]);
    expect(pending[0].notes).toEqual([]);
    const accepted = filterGroups(g, "accepted");
    expect(accepted.map((x) => x.doc.id)).toEqual(["i1"]);
    expect(accepted[0].notes).toEqual([]);
    expect(filterGroups(g, "rejected").map((x) => x.doc.id)).toEqual(["i2"]);
    expect(filterGroups(g, "all")).toHaveLength(2);
    expect(filterGroups(g, "all")[0].notes.map((n) => n.id)).toEqual(["c1"]);
    expect(statusCounts([inv, cn, other])).toEqual({ all: 3, pending: 1, accepted: 1, rejected: 1, cancelled: 0 });
  });
  it("a note can be accepted only after its invoice", () => {
    const inv = doc({ id: "i1", status: "pending" });
    const cn = doc({ id: "c1", kind: "credit_note", parentDocumentId: "i1", sellerInvoiceId: "INV-001" });
    expect(acceptBlockedReason(cn, inv)).toBe("Accept invoice INV-001 first.");
    expect(acceptBlockedReason(cn, { ...inv, status: "accepted" })).toBeNull();
    expect(acceptBlockedReason(inv, null)).toBeNull();
  });
  it("a note on a rejected / cancelled invoice never says 'accept the invoice first' (it cannot be)", () => {
    const cn = doc({ id: "c1", kind: "debit_note", parentDocumentId: "i1", sellerInvoiceId: "INV-001" });
    expect(acceptBlockedReason(cn, doc({ id: "i1", status: "rejected" }))).toBe("You rejected invoice INV-001 — reject this note too, or ask the seller for a fresh invoice.");
    expect(acceptBlockedReason(cn, doc({ id: "i1", status: "cancelled" }))).toBe("The seller cancelled invoice INV-001 — reject this note, or ask the seller.");
  });
  it("Undo accept is not offered on an invoice whose note is already accepted (the database refuses it)", () => {
    const inv = doc({ id: "i1", status: "accepted", vendorBillId: "VB-1" });
    expect(undoBlockedReason(inv, [doc({ kind: "credit_note", status: "accepted" })])).toBe("A note on it is accepted, so it stays accepted.");
    expect(undoBlockedReason(inv, [doc({ kind: "credit_note", status: "pending" })])).toBeNull();
    expect(undoBlockedReason(inv, [])).toBeNull();
  });
});

describe("R-2449 what the row says", () => {
  it("Accepted names the bill it made — or the buyer's own bill it linked", () => {
    expect(rowStatusText(doc({ status: "accepted", vendorBillId: "VB-NET-ABC" }))).toBe("Accepted — bill VB-NET-ABC");
    expect(rowStatusText(doc({ status: "accepted", vendorBillId: "VB-7", linkedExisting: true }))).toBe("Accepted — linked to your bill VB-7");
    expect(rowStatusText(doc({ kind: "credit_note", status: "accepted", vendorBillId: "VB-7" }))).toBe("Accepted — lowered bill VB-7");
  });
  it("Rejected carries the reason, Cancelled says the seller voided it, Pending says so", () => {
    expect(rowStatusText(doc({ status: "rejected", rejectReason: "Wrong rate" }))).toBe("Rejected: Wrong rate");
    expect(rowStatusText(doc({ status: "cancelled" }))).toBe("Cancelled by the seller");
    expect(rowStatusText(doc({}))).toBe("Pending");
    expect(kindLabel("credit_note")).toBe("Credit note");
    expect(kindLabel("debit_note")).toBe("Debit note");
    expect(kindLabel("invoice")).toBe("Invoice");
  });
  it("Open bill goes to the Bills list searched by the number, from the start of its financial year", () => {
    expect(billsHref(doc({ docNumber: "INV/26-27/001", docDate: "2026-11-04" }))).toBe("/accounting/bills?q=INV%2F26-27%2F001&from=2026-04-01");
    expect(billsHref(doc({ docDate: "2027-02-10" }))).toBe("/accounting/bills?q=INV-001&from=2026-04-01");
    // a credit note lowered its INVOICE's bill — the link finds that bill
    const cn = doc({ kind: "credit_note", docNumber: "CN-7", docDate: "2027-05-02", parentDocumentId: "i1" });
    expect(billsHref(cn, doc({ id: "i1", docNumber: "INV-42", docDate: "2027-01-15" }))).toBe("/accounting/bills?q=INV-42&from=2026-04-01");
  });
});

describe("R-2449 Accept dialog defaults + ITC by the buyer's own rules", () => {
  it("category defaults to the vendor's default category when it is one of ours, else COGS-Other", () => {
    expect(defaultAcceptCategory("COGS-M365")).toBe("COGS-M365");
    expect(defaultAcceptCategory("cloud_subscriptions")).toBe("COGS-Other");
    expect(defaultAcceptCategory(null)).toBe("COGS-Other");
  });
  it("GST becomes credit for a tax invoice with the right head; a wrong head says why and stays a cost", () => {
    const ok = acceptItcLine(doc({}), "COGS-Other", "07");
    expect(ok).toEqual({ credit: true, text: "GST ₹1,800 will be your input credit (ITC)." });
    const wrong = acceptItcLine(doc({ cgst: 900, sgst: 900 }), "COGS-Other", "27");
    expect(wrong.credit).toBe(false);
    expect(wrong.text).toMatch(/^GST ₹1,800 stays a cost — Vendor is in another state/);
    expect(acceptItcLine(doc({ cgst: 0, sgst: 0, igst: 0 }), "COGS-Other", "07")).toEqual({ credit: false, text: "No GST on this document." });
    expect(acceptItcLine(doc({ documentType: "bill_of_supply", cgst: 0, sgst: 0 }), "COGS-Other", "07").credit).toBe(false);
    // another currency is never shown as rupees
    expect(acceptItcLine(doc({ currency: "USD", cgst: 0, sgst: 0, igst: 180, sellerGstin: "27AAACE1234F1Z5" }), "COGS-Other", "07").text)
      .toBe("GST USD 180 will be your input credit (ITC).");
    expect(money(1800, "INR")).toBe("₹1,800");
    expect(money(180, "USD")).toBe("USD 180");
  });
});
