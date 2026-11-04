import { describe, it, expect } from "vitest";
import { canReviseQuote, nextRevision, revisionDraft, type RevisionSource } from "./revise";

describe("canReviseQuote (R-448)", () => {
  const sent = { id: "Q-X-0005", status: "sent", payment_status: "none", invoice_id: null };

  it("allows a sent or viewed quote with no money", () => {
    expect(canReviseQuote(sent, 0)).toEqual({ ok: true });
    expect(canReviseQuote({ ...sent, status: "viewed" }, 0)).toEqual({ ok: true });
  });

  it("refuses a quote that already has money or an invoice", () => {
    expect(canReviseQuote(sent, 1000).ok).toBe(false);
    expect(canReviseQuote({ ...sent, payment_status: "partial" }, 0).ok).toBe(false);
    expect(canReviseQuote({ ...sent, invoice_id: "INV-1" }, 0).ok).toBe(false);
  });

  it("refuses drafts, closed and already-replaced quotes", () => {
    expect(canReviseQuote({ ...sent, status: "draft" }, 0).ok).toBe(false);
    expect(canReviseQuote({ ...sent, status: "accepted" }, 0).ok).toBe(false);
    expect(canReviseQuote({ ...sent, status: "rejected" }, 0).ok).toBe(false);
    const r = canReviseQuote({ ...sent, superseded_by: "Q-X-0005-R2" }, 0);
    expect(r).toEqual({ ok: false, reason: "Already replaced by Q-X-0005-R2." });
  });

  it("R-2368: refuses a part payment request (one quote per part)", () => {
    const r = canReviseQuote({ ...sent, subscription_billing_id: "b1" }, 0);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/one part of a subscription billed in parts/);
  });
});

describe("nextRevision", () => {
  it("keeps the family number and counts up", () => {
    expect(nextRevision({ id: "Q-X-0005" })).toEqual({ id: "Q-X-0005-R2", revisionOf: "Q-X-0005", revisionNo: 2 });
    expect(nextRevision({ id: "Q-X-0005-R2", revision_of: "Q-X-0005", revision_no: 2 }))
      .toEqual({ id: "Q-X-0005-R3", revisionOf: "Q-X-0005", revisionNo: 3 });
  });

});

describe("revisionDraft", () => {
  const src = {
    id: "Q-X-0005", status: "sent", payment_status: "none", invoice_id: null, revision_of: null, revision_no: 1,
    tenant_id: "t1", customer_id: null, customer_name: "Mehta Consultants", lead_id: "L-1", owner_id: "u1",
    plan: "GW Standard", seats: 15, amount: 57348, line_items: [{ id: "a", name: "GW Standard", qty: 15, rate: 3240, cost: 0 }],
    subtotal: 48600, total_cost: 0, discount_pct: 0, tax_rate: 18, notes: null, is_renewal: false, domain: "mehta.in",
    extension_months: 12, is_extension: false, is_add_seats: false, currency: "INR", exchange_rate: 1, is_one_off: false,
    billing_cycle: "yearly", payment_terms_days: null, terms_conditions: null, prospect_state_code: "27",
    prospect_state: "Maharashtra", prospect_country: "India", fx_source: null, fx_date: null,
    created_date: "2026-10-01", expires_date: "2026-10-31",
  } as unknown as RevisionSource;

  it("copies terms into a draft under the family id, never money or status", () => {
    const d = revisionDraft(src, nextRevision(src), "2026-10-09");
    expect(d).toMatchObject({
      id: "Q-X-0005-R2", status: "draft", revision_of: "Q-X-0005", revision_no: 2,
      lead_id: "L-1", seats: 15, amount: 57348, created_date: "2026-10-09", expires_date: "2026-11-08",
    });
    expect(d).not.toHaveProperty("payment_status");
    expect(d).not.toHaveProperty("invoice_id");
    expect(d).not.toHaveProperty("public_token");
  });

  it("R-2368: an add-seats quote's revision keeps its subscription link (staging Q-A378-27-0565-R2)", () => {
    const seats = { ...src, is_add_seats: true, add_seats_subscription_id: "sub-1", add_seats_mrr_added: 300 } as RevisionSource;
    const d = revisionDraft(seats, nextRevision(seats), "2026-11-02");
    expect(d).toMatchObject({ is_add_seats: true, add_seats_subscription_id: "sub-1", add_seats_mrr_added: 300 });
  });

  it("R-2368: never copies the one-quote-per-term renewal link (it moves when the revision is sent)", () => {
    const ren = { ...src, is_renewal: true, renewal_subscription_id: "sub-2", renewal_term_date: "2026-11-20" } as unknown as RevisionSource;
    const d = revisionDraft(ren, nextRevision(ren), "2026-11-02");
    expect(d).not.toHaveProperty("renewal_subscription_id");
    expect(d).not.toHaveProperty("renewal_term_date");
    expect(d.add_seats_subscription_id).toBeNull();
  });
});
