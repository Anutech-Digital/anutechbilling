/**
 * R-2450 (G-NETWORK N2c) — what the SELLER reads about its customer's answer on a network copy.
 * The owner's path: Excel issues an invoice to Anutech (connected) → "Sent to Anutech on network —
 * Pending"; Anutech accepts → "Accepted by customer on <date>"; rejects with a reason → Excel reads
 * the reason and the next step "Issue a credit note and a fresh invoice". A customer who is not on
 * the network has no copy → no badge at all.
 */
import { describe, expect, it } from "vitest";
import type { NetworkSentDoc } from "@/lib/network/documents";
import {
  networkStatusView,
  invoiceNetworkDoc,
  noteNetworkDoc,
  networkChipByInvoice,
} from "./network-status-model";

const doc = (over: Partial<NetworkSentDoc> = {}): NetworkSentDoc => ({
  id: "d1",
  kind: "invoice",
  sellerInvoiceId: "INV-1",
  sellerNoteId: null,
  docNumber: "INV-1",
  buyerName: "Anutech Digital",
  buyerGstin: "07ABDCA0298H1ZP",
  status: "pending",
  rejectReason: null,
  respondedAt: null,
  createdAt: "2026-11-04T01:00:00Z",
  ...over,
});

describe("networkStatusView — the one status line on the seller's invoice", () => {
  it("pending: sent to the buyer on network, no next step", () => {
    const v = networkStatusView(doc());
    expect(v.line).toBe("Sent to Anutech Digital on network — Pending");
    expect(v.chip).toBe("Pending");
    expect(v.tone).toBe("info");
    expect(v.nextStep).toBeNull();
  });

  it("accepted: says when (IST date) and that a change goes as a credit note", () => {
    const v = networkStatusView(doc({ status: "accepted", respondedAt: "2026-11-03T20:00:00Z" }));
    // 20:00 UTC on 3 Nov is 4 Nov in India
    expect(v.line).toBe("Sent to Anutech Digital on network — Accepted by customer on 04 Nov 2026");
    expect(v.chip).toBe("Accepted");
    expect(v.tone).toBe("success");
    expect(v.nextStep).toBe("Your customer accepted this invoice — it is locked. Correct it with a credit note.");
  });

  it("rejected: the buyer's reason and the next step", () => {
    const v = networkStatusView(doc({ status: "rejected", rejectReason: "Wrong quantity — we ordered 8" }));
    expect(v.line).toBe("Sent to Anutech Digital on network — Rejected by customer: Wrong quantity — we ordered 8");
    expect(v.chip).toBe("Rejected");
    expect(v.tone).toBe("danger");
    expect(v.nextStep).toBe("Issue a credit note and a fresh invoice.");
  });

  it("rejected without a stored reason still reads as a sentence", () => {
    expect(networkStatusView(doc({ status: "rejected", rejectReason: null })).line).toBe(
      "Sent to Anutech Digital on network — Rejected by customer: no reason given",
    );
  });

  it("cancelled: says why (voided / note changed) so the seller knows the customer did not get it", () => {
    const v = networkStatusView(doc({ status: "cancelled" }));
    expect(v.line).toBe("Sent to Anutech Digital on network — Cancelled");
    expect(v.chip).toBe("Cancelled");
    expect(v.tone).toBe("muted");
    expect(v.nextStep).toBe("You voided this invoice before your customer answered.");
    expect(networkStatusView(doc({ status: "cancelled", kind: "credit_note", sellerNoteId: "CN-1" })).nextStep).toBe(
      "This note was changed or deleted, or its invoice voided, before your customer answered — issue a fresh note if they still need it.",
    );
  });

  it("rejected invoice already credited in full: no more 'issue a credit note'", () => {
    expect(networkStatusView(doc({ status: "rejected", rejectReason: "x" }), { creditedInFull: true }).nextStep).toBe(
      "Done — a credit note covers this invoice. Issue a fresh invoice if it is still owed.",
    );
    // only a rejected copy changes; an accepted one keeps its lock sentence
    expect(networkStatusView(doc({ status: "accepted" }), { creditedInFull: true }).nextStep).toMatch(/locked/);
  });

  it("notes: a credit / debit note gets its own words, never 'credit note and a fresh invoice'", () => {
    const cn = doc({ kind: "credit_note", sellerNoteId: "CN-1", docNumber: "CN-1" });
    expect(networkStatusView({ ...cn, status: "rejected", rejectReason: "Not agreed" }).nextStep).toBe(
      "Talk to your customer — if this note is wrong, issue a fresh note.",
    );
    expect(networkStatusView({ ...cn, status: "accepted" }).nextStep).toBe(
      "Your customer accepted this note — it is locked. Any further change goes as another note.",
    );
    expect(networkStatusView({ ...cn, status: "accepted" }).line).toBe("Sent to Anutech Digital on network — Accepted by customer");
  });

  it("a buyer name that is blank still names someone", () => {
    expect(networkStatusView(doc({ buyerName: "  " })).line).toBe("Sent to your customer on network — Pending");
  });
});

describe("picking the row", () => {
  const rows = [
    doc({ id: "cn", kind: "credit_note", sellerNoteId: "CN-1", docNumber: "CN-1", createdAt: "2026-11-04T02:00:00Z" }),
    doc({ id: "inv", kind: "invoice", createdAt: "2026-11-04T01:00:00Z", status: "accepted" }),
    doc({ id: "dn", kind: "debit_note", sellerNoteId: "DN-1", docNumber: "DN-1", createdAt: "2026-11-04T03:00:00Z" }),
    doc({ id: "other", sellerInvoiceId: "INV-2", docNumber: "INV-2", status: "rejected", rejectReason: "x" }),
  ];

  it("the invoice's own copy, never its note's", () => {
    expect(invoiceNetworkDoc(rows, "INV-1")?.id).toBe("inv");
    expect(invoiceNetworkDoc(rows, "INV-2")?.id).toBe("other");
  });

  it("no copy → null (customer not on the network → no badge)", () => {
    expect(invoiceNetworkDoc(rows, "INV-9")).toBeNull();
    expect(invoiceNetworkDoc(undefined, "INV-1")).toBeNull();
    expect(noteNetworkDoc(rows, "CN-9")).toBeNull();
  });

  it("a note's own copy by its note id", () => {
    expect(noteNetworkDoc(rows, "CN-1")?.id).toBe("cn");
    expect(noteNetworkDoc(rows, "DN-1")?.id).toBe("dn");
  });

  it("the list chip per invoice — the invoice copy only", () => {
    const m = networkChipByInvoice(rows);
    expect(m.get("INV-1")?.chip).toBe("Accepted");
    expect(m.get("INV-2")?.chip).toBe("Rejected");
    expect(m.has("INV-9")).toBe(false);
    expect(m.size).toBe(2);
  });

  it("two invoice copies of one invoice (re-issued after a cancel) → the newest wins", () => {
    const m = networkChipByInvoice([
      doc({ id: "old", status: "cancelled", createdAt: "2026-11-01T00:00:00Z" }),
      doc({ id: "new", status: "pending", createdAt: "2026-11-02T00:00:00Z" }),
    ]);
    expect(m.get("INV-1")?.chip).toBe("Pending");
  });
});
