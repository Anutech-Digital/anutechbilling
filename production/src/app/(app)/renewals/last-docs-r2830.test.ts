/**
 * R-2830 (localhost check 15 Nov): "Bill together" makes ONE proforma for two subscriptions. The quote row
 * stores only the LEAD part (subscription_billing_id); every part is named on a line (line_items[].billing_id).
 * Before: only the lead's row read "Quote sent"; the other row still said "Part not billed" + "Bill next part".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lastDocsBySubscription, type DocBilling, type DocQuote, type LastDocsInput } from "./last-docs";

const A = "c2830000-0000-4000-8000-0000000000a1";
const B = "c2830000-0000-4000-8000-0000000000b1";
const BA = "bill-a";
const BB = "bill-b";
const BC = "bill-c-other-company";

const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "sent", payment_status: "awaiting", created_at: "2026-11-14T05:00:00Z", created_date: "2026-11-14",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, ...over,
});
const billing = (id: string, subscription_id: string): DocBilling => ({
  id, subscription_id, invoice_id: null, term_start: "2026-11-01", period_index: 1, due_on: "2026-11-01",
  period_start: "2026-11-01", period_end: "2026-12-01",
} as DocBilling);
const subs = (...ids: string[]): LastDocsInput["subs"] => ids.map((id) => ({ id, quote_id: null, renewal_quote_id: null, start_date: "2025-11-01" }));
const together = (over: Partial<DocQuote> = {}) => q({
  id: "PI-TOGETHER", subscription_billing_id: BA,
  line_items: [{ billing_id: BA, description: "Standard" }, { billing_id: BB, description: "Starter" }], ...over,
});

describe("R-2830 a together proforma shows on EVERY member row", () => {
  it("lead AND member rows both get the quote (not only the lead)", () => {
    const out = lastDocsBySubscription({ subs: subs(A, B), quotes: [together()], billings: [billing(BA, A), billing(BB, B)], invoices: [] });
    expect(out.get(A)!.quote?.id).toBe("PI-TOGETHER");
    expect(out.get(B)!.quote?.id).toBe("PI-TOGETHER");
    expect(out.get(B)!.sent?.quoteId).toBe("PI-TOGETHER");
    expect(out.get(B)!.sent?.kind).toBe("part");
  });

  it("the member row's part is ITS OWN billed part, not the lead's", () => {
    const out = lastDocsBySubscription({ subs: subs(A, B), quotes: [together()], billings: [billing(BA, A), billing(BB, B)], invoices: [] });
    expect(out.get(B)!.quote?.part).toEqual({ start: "2026-11-01", endExclusive: "2026-12-01" });
  });

  it("a line naming a part of a subscription that is not listed links nothing (other company / other page)", () => {
    const out = lastDocsBySubscription({
      subs: subs(A, B),
      quotes: [together({ line_items: [{ billing_id: BA }, { billing_id: BC }, { billing_id: "unknown" }] })],
      billings: [billing(BA, A), billing(BB, B)], invoices: [],
    });
    expect(out.get(A)!.quote?.id).toBe("PI-TOGETHER");
    expect(out.get(B)!.quote).toBeNull();
  });

  it("a cancelled together proforma shows on no row (both back to 'Bill next part')", () => {
    const out = lastDocsBySubscription({ subs: subs(A, B), quotes: [together({ status: "cancelled" })], billings: [billing(BA, A), billing(BB, B)], invoices: [] });
    expect(out.get(A)!.quote).toBeNull();
    expect(out.get(B)!.quote).toBeNull();
  });

  it("odd line_items (null, a string, lines without billing_id) never throw", () => {
    for (const li of [null, undefined, "x", [null, 3, {}, { billing_id: 5 }]]) {
      const out = lastDocsBySubscription({ subs: subs(A, B), quotes: [together({ line_items: li as never })], billings: [billing(BA, A), billing(BB, B)], invoices: [] });
      expect(out.get(B)!.quote).toBeNull();
    }
  });

  it("the invoice raised from the together proforma shows on both rows", () => {
    const out = lastDocsBySubscription({
      subs: subs(A, B), quotes: [together({ invoice_id: "INV-1", payment_status: "paid", status: "accepted" })],
      billings: [billing(BA, A), billing(BB, B)],
      invoices: [{ id: "INV-1", quote_id: "PI-TOGETHER", invoice_date: "2026-11-14", status: "paid", amount: 100, paid_amount: 100, currency: "INR", created_at: "2026-11-14T06:00:00Z", due_date: null } as never],
    });
    expect(out.get(A)!.invoice?.id).toBe("INV-1");
    expect(out.get(B)!.invoice?.id).toBe("INV-1");
  });
});

describe("R-2830 the batched read carries the lines (no read per row)", () => {
  const src = readFileSync(new URL("./last-docs-data.ts", import.meta.url), "utf8");
  it("the part proformas read selects line_items in the same batched query", () => {
    expect(src).toMatch(/PART_COLS\s*=\s*`\$\{QUOTE_COLS\}, line_items`/);
    expect(src).toMatch(/\.select\(PART_COLS\)\s*\n\s*\.in\("subscription_billing_id"/);
  });
});
