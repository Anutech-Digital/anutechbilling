/**
 * R-2442 — POST /api/quotes/[id]/send refuses a customer with no state (place of supply).
 *
 * Owner's path (R-2363 review, 3 Nov 2026): a customer saved with state "Not known yet" (no
 * state_code, no GSTIN) has a saved draft quote; Send on the quote page goes straight to this
 * route. The quote builder's Send (supplyStateMissing) and the GST invoice (generate_invoice)
 * already refuse that customer — this route emailed the quote with no place of supply.
 *
 * Pinned: no state → 409, the §24 message names the next step "Set the customer's state" and
 * links to the customer; nothing is emailed, logged or flipped to sent. With a state (or a GSTIN
 * that proves one, or an overseas customer) → it sends as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "33333333-3333-4333-8333-333333333333";

const db = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  writes: [] as string[],
}));
const msg = vi.hoisted(() => ({ email: vi.fn() }));

vi.mock("@/lib/supabase/server", () => {
  const WRITES = new Set(["insert", "update", "upsert", "delete"]);
  const chain = (table: string): unknown => {
    const result = () => ({ data: db.rows[table] ?? null, error: null });
    const self: unknown = new Proxy({}, {
      get(_t, prop: string | symbol) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
        }
        if (prop === "single" || prop === "maybeSingle") return async () => result();
        return (..._args: unknown[]) => {
          if (typeof prop === "string" && WRITES.has(prop)) db.writes.push(`${table}.${prop}`);
          return self;
        };
      },
    });
    return self;
  };
  const client = () => new Proxy({}, {
    get(_t, prop: string | symbol) {
      if (prop === "auth") return { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) };
      if (prop === "from") return (t: string) => chain(t);
      if (prop === "rpc") return (n: string) => chain(`rpc:${n}`);
      if (prop === "then") return undefined;
      return () => chain(String(prop));
    },
  });
  return { createClient: client, createAdminClient: client, createAdminClientFor: client };
});

vi.mock("@/lib/messaging", async (orig) => ({
  ...(await orig<typeof import("@/lib/messaging")>()),
  sendCustomerEmail: msg.email,
}));
vi.mock("@/lib/pdf", () => ({ renderQuotePDF: async () => new Blob(["%PDF"]) }));
vi.mock("@/lib/pdf/logo", () => ({ logoDataUri: async () => null }));
vi.mock("@/lib/pdf/upi-qr", () => ({ buildQuoteUpiQr: async () => null }));
vi.mock("@/lib/contacts/primary", () => ({
  primaryContactEmail: async () => ({ email: "ravi@acme.example", name: "Ravi", fromLegacy: false }),
}));
vi.mock("@/lib/checkout/quote-order", () => ({ readQuoteDueNow: async () => null }));
vi.mock("@/lib/payments/quote-due-now", () => ({ quoteDueNowUpiAmount: () => null }));
vi.mock("@/lib/quotes/line-period-context", () => ({ loadQuotePeriodContext: async () => undefined }));
vi.mock("@/lib/compliance/gst-registration-server", () => ({ readTenantGstRegistration: async () => null }));
vi.mock("@/lib/ai/sales-loops.server", () => ({ scheduleSalesLoop: async () => true }));

import { POST } from "./route";

function setRows(customer: Record<string, unknown>) {
  db.rows = {
    users: { tenant_id: TENANT, full_name: "Test Owner", role: "owner" },
    quotes: {
      id: "Q-1", tenant_id: TENANT, customer_id: CUSTOMER, customer_name: "Pathak Fabrication",
      status: "draft", line_items: [{ name: "Workspace", qty: 1, rate: 1000, list: 1000, cost: 800 }], subtotal: 1000,
      amount: 1180, tax_rate: 18, discount_pct: 0, public_token: "tok", lead_id: null,
      approval_status: null,
    },
    tenants: { name: "Seller Co", email: "seller@example.test", state_code: "07", gstin: null },
    user_google_tokens: [],
    customers: { name: "Pathak Fabrication", contact_name: "Ravi", gstin: null, gst_treatment: null, ...customer },
    quote_send_log: null,
  };
}

const call = () =>
  POST(
    new Request("http://localhost:3001/api/quotes/Q-1/send", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3001" },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ id: "Q-1" }) },
  );

beforeEach(() => {
  db.writes = [];
  msg.email.mockReset();
  msg.email.mockResolvedValue({ status: "sent", providerId: "p-1", errorMessage: null });
});

describe("R-2442: quote send refuses a customer with no state", () => {
  it("no state, no GSTIN (state 'Not known yet') → 409 with the next step and a link to the customer; nothing sent", async () => {
    setRows({ state_code: null, country: "India" });
    const res = await call();
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/Pathak Fabrication has no state on record/);
    expect(json.error).toMatch(/CGST \+ SGST or IGST/);
    expect(json.nextStep).toEqual({ label: "Set the customer's state", href: `/customers/${CUSTOMER}` });
    expect(msg.email).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it("with a state → sends and flips the draft to sent", async () => {
    setRows({ state_code: "06", country: "India" });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("sent");
    expect(msg.email).toHaveBeenCalledTimes(1);
    expect(db.writes).toContain("quotes.update");
  });

  it("no state_code but a valid GSTIN proves the state → sends (same rule as the builder)", async () => {
    setRows({ state_code: null, country: "India", gstin: "06AABCF1234A1ZI" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(msg.email).toHaveBeenCalledTimes(1);
  });

  it("an overseas customer has no Indian place of supply → sends", async () => {
    setRows({ state_code: null, country: "United States" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(msg.email).toHaveBeenCalledTimes(1);
  });
});

describe("R-2442 review: the other halves of the builder's rule", () => {
  const withQuote = (over: Record<string, unknown>) => {
    db.rows.quotes = { ...(db.rows.quotes as Record<string, unknown>), ...over };
  };
  const callTo = () =>
    POST(
      new Request("http://localhost:3001/api/quotes/Q-1/send", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3001" },
        body: JSON.stringify({ to: "ravi@acme.example" }),
      }),
      { params: Promise.resolve({ id: "Q-1" }) },
    );

  it("a quote raised on a lead with no state → 409, next step opens the lead", async () => {
    setRows({});
    const LEAD = "44444444-4444-4444-8444-444444444444";
    withQuote({ customer_id: null, lead_id: LEAD, customer_name: "Ravi Traders" });
    db.rows.leads = { state_code: null, gstin: null, country: "India", contact_name: "Ravi" };
    const res = await callTo();
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/Ravi Traders has no state on record/);
    expect(json.nextStep).toEqual({ label: "Set the lead's state", href: `/leads?lead=${LEAD}` });
    expect(msg.email).not.toHaveBeenCalled();
  });

  it("a quote raised on a lead WITH a state → sends", async () => {
    setRows({});
    withQuote({ customer_id: null, lead_id: "44444444-4444-4444-8444-444444444444" });
    db.rows.leads = { state_code: "27", gstin: null, country: "India", contact_name: "Ravi" };
    const res = await callTo();
    expect(res.status).toBe(200);
    expect(msg.email).toHaveBeenCalledTimes(1);
  });

  it("a typed prospect with no state → 409, next step opens the quote's edit page", async () => {
    setRows({});
    withQuote({ customer_id: null, lead_id: null, prospect_state_code: null, prospect_country: null });
    const res = await callTo();
    expect(res.status).toBe(409);
    expect((await res.json()).nextStep).toEqual({ label: "Pick the customer's state", href: "/quotes/Q-1/edit" });
    expect(msg.email).not.toHaveBeenCalled();
  });

  it("the customer row did not load → still refused (judged on the place of supply, not on the row)", async () => {
    setRows({});
    db.rows.customers = null;
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).nextStep).toEqual({ label: "Set the customer's state", href: `/customers/${CUSTOMER}` });
    expect(msg.email).not.toHaveBeenCalled();
  });

  it("the company's own state is not set → 409 with the company-state fix (owner: Set company state)", async () => {
    setRows({ state_code: "06", country: "India" });
    db.rows.tenants = { name: "Seller Co", email: "seller@example.test", state_code: null, gstin: null };
    const res = await call();
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/^Your company's state is not set\./);
    expect(json.error).not.toMatch(/\.$/);
    expect(json.nextStep.label).toBe("Set company state");
    expect(msg.email).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });
});
