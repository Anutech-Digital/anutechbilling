/**
 * R-2459 — the no-state fix link must lead somewhere the state can actually be set, and every
 * way a quote reaches the customer asks the one gate (customerCopyBlock) — the Quotes LIST's
 * WhatsApp follow-up too.
 *
 * Owner's path (Chrome check on localhost, 4 Nov 2026): Q-F588-27-0008, a SENT quote typed for
 * "R802 Renewed Co" (no customer picked, no state) — the amber line's "Pick the customer's state"
 * opened /quotes/<id>/edit, which says "can't be edited — this quote is sent". And the Quotes
 * list row's WhatsApp button stayed live and opened web.whatsapp.com naming the quote and ₹2,029.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { customerCopyBlock, customerCopyBlockTitle, CUSTOMER_COPY_BLOCKED_TITLE, type CustomerCopyQuote } from "./customer-copy-gate";
import { customerCopyBlockForRow } from "./customer-copy-rows";

const atList = [{ id: "l1", name: "GW Standard", qty: 1, rate: 2029, list_rate: 2029, cost: 1500, commitment: "annual_yearly" }];
const discounted = [{ id: "l1", name: "GW Standard", qty: 10, rate: 10627, list_rate: 12960, cost: 8640, commitment: "annual_yearly" }];
const CUSTOMER = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const seller = { state_code: "07", gstin: null };

function q(over: Partial<CustomerCopyQuote> = {}): CustomerCopyQuote {
  return {
    id: "Q-F588-27-0008", status: "sent", line_items: atList as CustomerCopyQuote["line_items"],
    customer_id: null, lead_id: null, customer_name: "R802 Renewed Co",
    prospect_state_code: null, prospect_country: null, invoice_id: null,
    approval_status: "not_required", approval_tier: null, approval_requested_by: null, approved_by: null,
    approved_discount_bps: null, approved_margin_bps: null, approval_rejection_reason: null,
    ...over,
  };
}
const prospectOnly = { customer: null, lead: null, seller };

describe("R-2459: the no-state fix link is never a dead end", () => {
  it("a SENT typed-prospect quote → Revise (a draft copy where the state is picked), not /edit", () => {
    const b = customerCopyBlock(q(), prospectOnly);
    expect(b?.kind).toBe("customer_state");
    expect(b?.action?.href).not.toMatch(/\/edit$/);
    expect(b?.action).toEqual({ label: "Revise the quote", href: "/quotes/Q-F588-27-0008?revise=1" });
    expect(b?.message).toBe(
      "R802 Renewed Co has no state on record — the state decides CGST + SGST or IGST. Revise the quote and pick the customer's state on the new draft first",
    );
  });

  it("viewed / expired typed-prospect quotes also go to Revise — only a draft opens in the editor", () => {
    expect(customerCopyBlock(q({ status: "viewed" }), prospectOnly)?.action?.href).toBe("/quotes/Q-F588-27-0008?revise=1");
    expect(customerCopyBlock(q({ status: "expired" }), prospectOnly)?.action?.href).toBe("/quotes/Q-F588-27-0008?revise=1");
    expect(customerCopyBlock(q({ status: "draft" }), prospectOnly)?.action).toEqual({
      label: "Pick the customer's state", href: "/quotes/Q-F588-27-0008/edit",
    });
  });

  it("a picked customer / a lead keep their own pages, sent or draft", () => {
    const noStateCustomer = { customer: { name: "R802 Renewed Co", state_code: null, country: "India" }, lead: null, seller };
    expect(customerCopyBlock(q({ customer_id: CUSTOMER }), noStateCustomer)?.action?.href).toBe(`/customers/${CUSTOMER}`);
    expect(customerCopyBlock(q({ customer_id: CUSTOMER, status: "draft" }), noStateCustomer)?.action?.href).toBe(`/customers/${CUSTOMER}`);
    expect(customerCopyBlock(q({ lead_id: LEAD }), { customer: null, lead: { state_code: null }, seller })?.action?.href)
      .toBe(`/leads?lead=${LEAD}`);
  });
});

describe("R-2459: customerCopyBlockForRow — the Quotes list asks the same gate", () => {
  const customers = new Map([[CUSTOMER, { name: "R802 Renewed Co", state_code: null, gstin: null, country: "India" }]]);
  const leads = new Map([[LEAD, { state_code: "06", gstin: null, country: "India" }]]);
  const ctx = { customers, leads, seller, role: "owner" };

  it("blocks the owner's row (typed prospect, no state) with the gate's own message", () => {
    const b = customerCopyBlockForRow(q(), ctx);
    expect(b).toEqual(customerCopyBlock(q(), prospectOnly));
  });

  it("blocks a picked customer with no state, allows a lead with a state", () => {
    expect(customerCopyBlockForRow(q({ customer_id: CUSTOMER }), ctx)?.action?.href).toBe(`/customers/${CUSTOMER}`);
    expect(customerCopyBlockForRow(q({ lead_id: LEAD }), ctx)).toBeNull();
    expect(customerCopyBlockForRow(q({ prospect_state_code: "27" }), ctx)).toBeNull();
  });

  it("a customer / lead row this user cannot read is never judged 'no state' (approval rule only)", () => {
    expect(customerCopyBlockForRow(q({ customer_id: "55555555-5555-4555-8555-555555555555" }), ctx)).toBeNull();
    expect(customerCopyBlockForRow(q({ lead_id: "66666666-6666-4666-8666-666666666666" }), ctx)).toBeNull();
  });

  it("before the states load (ctx null) only the approval rule runs", () => {
    expect(customerCopyBlockForRow(q(), null)).toBeNull();
    const d = q({ status: "draft", line_items: discounted as CustomerCopyQuote["line_items"] });
    expect(customerCopyBlockForRow(d, null)?.kind).toBe("approval");
  });

  it("customerCopyBlockTitle: approval → the short locked line, place of supply → the whole message", () => {
    expect(customerCopyBlockTitle(null)).toBeUndefined();
    const d = q({ status: "draft", line_items: discounted as CustomerCopyQuote["line_items"] });
    expect(customerCopyBlockTitle(customerCopyBlock(d, null))).toBe(CUSTOMER_COPY_BLOCKED_TITLE);
    expect(customerCopyBlockTitle(customerCopyBlock(q(), prospectOnly))).toBe(customerCopyBlock(q(), prospectOnly)?.message);
  });
});

describe("R-2459 wiring", () => {
  const LIST = readFileSync(join(process.cwd(), "src/app/(app)/quotes/page.tsx"), "utf8");
  const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/quotes/[id]/page.tsx"), "utf8");

  it("every web.whatsapp follow-up on the Quotes list sits behind the row's gate", () => {
    const opens = LIST.split("web.whatsapp.com/send").length - 1;
    expect(opens).toBeGreaterThan(0);
    expect(LIST).toContain("customerCopyBlockForRow(");
    expect(LIST).toContain("useQuoteCopyParties(");
    // each opener is in a handler that first returns on a block
    const chunks = LIST.split("web.whatsapp.com/send").slice(0, -1);
    for (const before of chunks) expect(before.slice(-700)).toMatch(/if \(copyBlock\) return;/);
  });

  it("the list's WhatsApp button and menu item are disabled with the reason", () => {
    expect(LIST).toMatch(/disabled=\{!!copyBlock\}/);
    expect(LIST).toContain("customerCopyBlockTitle(copyBlock)");
  });

  it("the quote page acts on ?revise=1 — asks first, never revises on load", () => {
    expect(PAGE).toContain('searchParams.get("revise")');
    const effect = PAGE.slice(PAGE.indexOf('searchParams.get("revise")'));
    expect(effect.slice(0, 2500)).toContain("setConfirm(");
  });
});
