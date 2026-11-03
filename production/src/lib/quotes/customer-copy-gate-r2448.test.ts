/**
 * R-2448 — the place-of-supply rule lives in the ONE customer-copy gate (customerCopyBlock), so
 * Send, Mark as sent, the PDF / WhatsApp link and "Copy link instead" all refuse a quote whose
 * customer has no state (R-2363 "Not known yet") with the same message and the same fix link.
 *
 * Owner's path (R-2442 follow-up, 3 Nov 2026): Send was refused with 409, but Mark as sent and
 * Copy customer link still handed the customer a quote with CGST + SGST vs IGST undecided —
 * generate_invoice then refuses its GST invoice after the customer has paid.
 */
import { describe, it, expect } from "vitest";
import { customerCopyBlock, type CustomerCopyQuote, type CustomerCopyParties } from "./customer-copy-gate";
import { loadCustomerCopyParties } from "./customer-copy-supply";

const atList = [{ id: "l1", name: "GW Standard", qty: 10, rate: 12960, list_rate: 12960, cost: 8640, commitment: "annual_yearly" }];
const discounted = [{ id: "l1", name: "GW Standard", qty: 10, rate: 10627, list_rate: 12960, cost: 8640, commitment: "annual_yearly" }];
const CUSTOMER = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";

function q(over: Partial<CustomerCopyQuote> = {}): CustomerCopyQuote {
  return {
    id: "Q-1", status: "draft", line_items: atList as CustomerCopyQuote["line_items"],
    customer_id: CUSTOMER, lead_id: null, customer_name: "Pathak Fabrication",
    prospect_state_code: null, prospect_country: null, invoice_id: null,
    approval_status: "not_required", approval_tier: null, approval_requested_by: null, approved_by: null,
    approved_discount_bps: null, approved_margin_bps: null, approval_rejection_reason: null,
    ...over,
  };
}
const seller = { state_code: "07", gstin: null };
const noState: CustomerCopyParties = {
  customer: { name: "Pathak Fabrication", state_code: null, gstin: null, country: "India" }, lead: null, seller, role: "owner",
};

describe("customerCopyBlock — place of supply (R-2448)", () => {
  it("customer with no state ('Not known yet') → blocked with the R-2442 message and 'Set the customer's state'", () => {
    const b = customerCopyBlock(q(), noState);
    expect(b?.kind).toBe("customer_state");
    expect(b?.message).toBe(
      "Pathak Fabrication has no state on record — the state decides CGST + SGST or IGST. Set the customer's state on the customer page first",
    );
    expect(b?.action).toEqual({ label: "Set the customer's state", href: `/customers/${CUSTOMER}` });
  });

  it("a sent quote is still blocked (resend / copy link / PDF) — the invoice would still be refused", () => {
    expect(customerCopyBlock(q({ status: "sent" }), noState)?.kind).toBe("customer_state");
    expect(customerCopyBlock(q({ status: "viewed" }), noState)?.kind).toBe("customer_state");
    // Send allows a resend of an expired quote — it was refused for no state before (R-2442) and still is.
    expect(customerCopyBlock(q({ status: "expired" }), noState)?.kind).toBe("customer_state");
  });

  it("accepted / invoiced quotes are not pulled back (the invoice keeps its frozen head)", () => {
    expect(customerCopyBlock(q({ status: "accepted" }), noState)).toBeNull();
    expect(customerCopyBlock(q({ invoice_id: "INV-1" }), noState)).toBeNull();
  });

  it("a state, a GSTIN that proves one, or an overseas customer → allowed", () => {
    expect(customerCopyBlock(q(), { ...noState, customer: { state_code: "06", country: "India" } })).toBeNull();
    expect(customerCopyBlock(q(), { ...noState, customer: { state_code: null, gstin: "06AABCF1234A1ZI" } })).toBeNull();
    expect(customerCopyBlock(q(), { ...noState, customer: { state_code: null, country: "United States" } })).toBeNull();
  });

  it("a lead quote with no state → 'Set the lead's state', opens the lead", () => {
    const b = customerCopyBlock(q({ customer_id: null, lead_id: LEAD, customer_name: "Ravi Traders" }), {
      customer: null, lead: { state_code: null, gstin: null, country: "India" }, seller,
    });
    expect(b?.message).toMatch(/^Ravi Traders has no state on record/);
    expect(b?.action).toEqual({ label: "Set the lead's state", href: `/leads?lead=${LEAD}` });
  });

  it("a typed prospect with no state → 'Pick the customer's state' on the quote", () => {
    const b = customerCopyBlock(q({ customer_id: null }), { customer: null, lead: null, seller });
    expect(b?.action).toEqual({ label: "Pick the customer's state", href: "/quotes/Q-1/edit" });
    expect(customerCopyBlock(q({ customer_id: null, prospect_state_code: "27" }), { customer: null, lead: null, seller })).toBeNull();
  });

  it("the company's own state missing → the company-state fix, by role", () => {
    const owner = customerCopyBlock(q(), { ...noState, customer: { state_code: "06" }, seller: { state_code: null } });
    expect(owner?.kind).toBe("company_state");
    expect(owner?.message).toMatch(/^Your company's state is not set\./);
    expect(owner?.message).not.toMatch(/\.$/);
    expect(owner?.action?.label).toBe("Set company state");
    const sales = customerCopyBlock(q(), { ...noState, customer: { state_code: "06" }, seller: { state_code: null }, role: "sales" });
    expect(sales?.action?.label).toBe("View company settings");
  });

  it("approval comes first — a discounted draft names approval, not the state", () => {
    const b = customerCopyBlock(q({ line_items: discounted as CustomerCopyQuote["line_items"] }), noState);
    expect(b?.kind).toBe("approval");
    expect(b?.message).toMatch(/^Needs approval first — /);
  });

  it("without parties the gate is the approval rule alone (callers that do not load the buyer)", () => {
    expect(customerCopyBlock(q())).toBeNull();
  });
});

describe("loadCustomerCopyParties (R-2448 review)", () => {
  /* A client whose every read answers with `res` — enough to see the loader's error handling. */
  const fakeDb = (res: { data: unknown; error: unknown }) => {
    const chain: Record<string, unknown> = {};
    for (const k of ["select", "eq"]) chain[k] = () => chain;
    chain.maybeSingle = async () => res;
    return { from: () => chain } as unknown as Parameters<typeof loadCustomerCopyParties>[0];
  };

  it("a failed read throws — never reported as 'no state'", async () => {
    await expect(loadCustomerCopyParties(fakeDb({ data: null, error: { message: "boom" } }), { tenant_id: "t1", customer_id: "c1" }, "owner"))
      .rejects.toThrow(/Could not read the customer/);
  });

  it("reads the rows it is given", async () => {
    const p = await loadCustomerCopyParties(fakeDb({ data: { state_code: "07", gstin: null }, error: null }), { tenant_id: "t1" }, "sales");
    expect(p).toEqual({ customer: null, lead: null, seller: { state_code: "07", gstin: null }, role: "sales" });
  });
});
