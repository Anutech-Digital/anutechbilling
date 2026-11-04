/**
 * R-2434 (G-NETWORK N2) — documents between connected businesses: the typed edge the screens use,
 * and the migration's promises that the owner's flow depends on (rolled-back SQL proof:
 * supabase/tests/r2434_network_documents.test.sql).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  toInboxDoc, toSentDoc, sentStatusLabel, sentNextStep, canAccept, canReject, canUndoAccept, cleanRejectReason,
} from "./documents";

const inboxRow = {
  id: "d1", kind: "invoice", status: "pending", seller_name: "Seller Pvt Ltd", seller_gstin: "07AAACE1234F1Z5",
  doc_number: "INV-2026-001", doc_date: "2026-11-04", fy: "2026-27", document_type: "tax_invoice",
  taxable_value: 10000, cgst: 900, sgst: 900, igst: 0, total: 11800, currency: "INR",
  seller_invoice_id: "INV-2026-001", parent_document_id: null, reject_reason: null, vendor_bill_id: null,
  linked_existing: false, apply_note: null, created_at: "2026-11-04T05:00:00Z", responded_at: null,
  payload: {
    due_date: "2026-11-19", pdf_url: "https://x/inv.pdf",
    lines: [{ description: "Workspace Starter", detail: null, hsn_sac: "998315", quantity: 10, rate: 1000, amount: 10000 }],
  },
};

describe("R-2434 toInboxDoc — the buyer's copy", () => {
  it("maps the frozen copy: amounts, GST heads, lines with HSN/SAC, due date from the payload", () => {
    const d = toInboxDoc(inboxRow);
    expect(d).toMatchObject({
      kind: "invoice", status: "pending", sellerName: "Seller Pvt Ltd", docNumber: "INV-2026-001",
      taxableValue: 10000, cgst: 900, sgst: 900, igst: 0, total: 11800, dueDate: "2026-11-19", fy: "2026-27",
    });
    expect(d.lines).toEqual([{ description: "Workspace Starter", detail: null, hsnSac: "998315", quantity: 10, rate: 1000, amount: 10000 }]);
  });
  it("an unknown status / kind / type never turns into an accepted tax document", () => {
    const d = toInboxDoc({ ...inboxRow, status: "weird", kind: "x", document_type: "y", payload: null });
    expect(d.status).toBe("pending");
    expect(d.kind).toBe("invoice");
    expect(d.documentType).toBe("tax_invoice");
    expect(d.lines).toEqual([]);
  });
  it("Accept and Reject only on pending; Undo on an accepted invoice / debit note, never a credit note", () => {
    expect(canAccept({ status: "pending" })).toBe(true);
    expect(canAccept({ status: "rejected" })).toBe(false);   // reject is final
    expect(canAccept({ status: "accepted" })).toBe(false);
    expect(canAccept({ status: "cancelled" })).toBe(false);
    expect(canReject({ status: "pending" })).toBe(true);
    expect(canReject({ status: "accepted" })).toBe(false);
    expect(canUndoAccept({ status: "accepted", kind: "invoice" })).toBe(true);
    expect(canUndoAccept({ status: "accepted", kind: "debit_note" })).toBe(true);
    expect(canUndoAccept({ status: "accepted", kind: "credit_note" })).toBe(false);
    expect(canUndoAccept({ status: "pending", kind: "invoice" })).toBe(false);
    expect(toInboxDoc({ ...inboxRow, kind: "debit_note" }).kind).toBe("debit_note");
  });
  it("a reject needs a reason the seller can read", () => {
    expect(() => cleanRejectReason("   ")).toThrow(/reason/);
    expect(cleanRejectReason("  We never ordered this ")).toBe("We never ordered this");
    expect(cleanRejectReason("x".repeat(600))).toHaveLength(500);
  });
});

describe("R-2434 sentStatusLabel — what the seller sees on its invoice", () => {
  const sent = toSentDoc({
    id: "d1", kind: "invoice", seller_invoice_id: "INV-1", seller_note_id: null, doc_number: "INV-1",
    buyer_name: "Buyer Pvt Ltd", buyer_gstin: "07AAACA1234F1Z5", status: "pending", reject_reason: null,
    responded_at: null, created_at: "2026-11-04T05:00:00Z",
  });
  it("pending / accepted / rejected / cancelled", () => {
    expect(sentStatusLabel(sent)).toBe("Sent to Buyer Pvt Ltd — waiting for them to accept");
    expect(sentStatusLabel({ ...sent, status: "accepted", respondedAt: "2026-11-04T05:00:00Z" })).toBe("Accepted by customer on 04 Nov 2026");
    expect(sentStatusLabel({ ...sent, status: "rejected", rejectReason: "Wrong quantity" })).toBe("Rejected by customer: Wrong quantity");
    expect(sentStatusLabel({ ...sent, status: "cancelled" })).toMatch(/^Cancelled — you voided this invoice/);
    expect(sentStatusLabel({ ...sent, kind: "credit_note", status: "cancelled" })).toMatch(/^Cancelled — the note was changed/);
  });
  it("next step: rejected → credit note + fresh invoice; accepted → locked", () => {
    expect(sentNextStep({ ...sent, status: "rejected" })).toMatch(/credit note/);
    expect(sentNextStep({ ...sent, status: "accepted" })).toMatch(/Locked on both sides/);
    expect(sentNextStep(sent)).toBeNull();
  });
});

describe("R-2434 migration — the promises the flow relies on", () => {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const file = fs.readdirSync(dir).find((f) => /_r2434_network_documents\.sql$/.test(f));
  const sql = file ? fs.readFileSync(path.join(dir, file), "utf8") : "";

  it("exists, with a deploy-peek first line", () => {
    expect(file).toBeTruthy();
    expect(sql.split("\n")[0]).toMatch(/^-- deploy-peek: /);
  });
  it("the table is closed to request roles; reads/writes only through SECURITY DEFINER functions", () => {
    expect(sql).toMatch(/revoke all on public\.network_documents from public, anon, authenticated/);
    for (const fn of ["network_accept_document", "network_reject_document", "network_undo_accept", "network_inbox", "network_seller_documents"]) {
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated;`));
    }
    // the gate and the internals are never granted to the browser
    expect(sql).toMatch(/revoke all on function public\.network_invoice_buyer\(uuid, text, text\) from public, anon, authenticated/);
    expect(sql).not.toMatch(/grant execute on function public\.network_invoice_buyer/);
  });
  it("delivery needs the 'invoices' scope AND owner-proved GSTINs on both sides", () => {
    expect(sql).toMatch(/network_has_scope\(p_seller, v_buyer, 'invoices'\)/);
    expect(sql).toMatch(/network_gstin_owned\(p_seller\)/);
    expect(sql).toMatch(/network_gstin_owned\(v_buyer\)/);
  });
  it("dedupe by seller GSTIN + kind + number + FY", () => {
    expect(sql).toMatch(/unique index if not exists network_documents_dedupe_uq\s+on public\.network_documents \(seller_gstin, kind, upper\(btrim\(doc_number\)\), fy\)/);
  });
  it("never copies the seller's cost or list price", () => {
    const lines = sql.slice(sql.indexOf("function public.network_copy_lines"), sql.indexOf("-- ── deliver: issued invoice"));
    expect(lines).not.toMatch(/'cost'|list_rate/);
  });
  it("the R-2432 mirror stands aside for a connected pair", () => {
    expect(sql).toMatch(/if public\.network_invoice_buyer_of\(NEW\) is not null then return NEW; end if;/);
  });
});
