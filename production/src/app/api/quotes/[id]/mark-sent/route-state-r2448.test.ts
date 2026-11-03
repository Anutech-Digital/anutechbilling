/**
 * R-2448 — Mark as sent (and Copy customer link / Send on WhatsApp on a draft, which go through
 * this route) refuse a quote whose customer has no state, the same way Send does (R-2442):
 * 409, the same message, `nextStep` "Set the customer's state" → the customer page; nothing
 * written, the accept link stays closed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { newFakeDb, fakeServerModule, signInAs, TENANT_A, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
}));

import { POST } from "./route";

const CUSTOMER = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const okLines = [{ qty: 1, rate: 1000, list_rate: 1000, cost: 500, discount_pct: 0, description: "Workspace" }];
const call = () => POST(new Request("http://x/api/quotes/Q-1/mark-sent", { method: "POST" }), { params: Promise.resolve({ id: "Q-1" }) });

function quoteRow(over: Record<string, unknown> = {}) {
  return {
    id: "Q-1", tenant_id: TENANT_A, status: "draft", public_token: "tok", lead_id: null,
    customer_id: CUSTOMER, customer_name: "Pathak Fabrication", prospect_state_code: null, prospect_country: null, invoice_id: null,
    line_items: okLines, approval_status: null, approval_tier: null, approval_requested_by: null,
    approved_by: null, approved_discount_bps: null, approved_margin_bps: null, approval_rejection_reason: null,
    ...over,
  };
}

beforeEach(() => {
  h.db = newFakeDb();
  signInAs(h.db, "owner");
  h.db.tables.tenants = [{ id: TENANT_A, state_code: "07", gstin: null }];
});

describe("R-2448: Mark as sent refuses a customer with no state", () => {
  it("customer state 'Not known yet' → 409 with Send's message and the 'Set the customer's state' link; nothing written", async () => {
    h.db.tables.quotes = [quoteRow()];
    h.db.tables.customers = [{ id: CUSTOMER, tenant_id: TENANT_A, name: "Pathak Fabrication", state_code: null, gstin: null, country: "India" }];
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/^Pathak Fabrication has no state on record — the state decides CGST \+ SGST or IGST\./);
    expect(body.nextStep).toEqual({ label: "Set the customer's state", href: `/customers/${CUSTOMER}` });
    expect(h.db.tables.quotes[0].status).toBe("draft");
    expect(h.db.writes).toHaveLength(0);
  });

  it("the customer has a state → marked sent", async () => {
    h.db.tables.quotes = [quoteRow()];
    h.db.tables.customers = [{ id: CUSTOMER, tenant_id: TENANT_A, name: "Pathak Fabrication", state_code: "06", gstin: null, country: "India" }];
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.db.tables.quotes[0].status).toBe("sent");
  });

  it("a lead with no state → 409, next step opens the lead", async () => {
    h.db.tables.quotes = [quoteRow({ customer_id: null, lead_id: LEAD, customer_name: "Ravi Traders" })];
    h.db.tables.leads = [{ id: LEAD, tenant_id: TENANT_A, stage: "contact", state_code: null, gstin: null, country: "India" }];
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).nextStep).toEqual({ label: "Set the lead's state", href: `/leads?lead=${LEAD}` });
    expect(h.db.writes).toHaveLength(0);
  });

  it("the company's own state is not set → 409 with the company-state fix", async () => {
    h.db.tables.tenants = [{ id: TENANT_A, state_code: null, gstin: null }];
    h.db.tables.quotes = [quoteRow({ customer_id: null, prospect_state_code: "27" })];
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/^Your company's state is not set\./);
    expect(body.nextStep.label).toBe("Set company state");
  });
});
