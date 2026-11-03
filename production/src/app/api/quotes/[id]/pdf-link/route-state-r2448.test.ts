/**
 * R-2448 — the PDF link (Proforma / WhatsApp PDF) is a customer copy: a quote whose customer has
 * no state gets no signed link — 409 with Send's message and the "Set the customer's state" link.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { newFakeDb, fakeServerModule, signInAs, TENANT_A, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
}));
vi.mock("@/lib/pdf/pdf-token", () => ({ pdfDownloadUrl: () => "http://localhost:3001/api/v1/documents/quote/Q-1/pdf?token=t" }));

import { GET } from "./route";

const CUSTOMER = "33333333-3333-4333-8333-333333333333";
const okLines = [{ qty: 1, rate: 1000, list_rate: 1000, cost: 500, discount_pct: 0, description: "Workspace" }];
const call = () => GET(new NextRequest("http://localhost:3001/api/quotes/Q-1/pdf-link"), { params: Promise.resolve({ id: "Q-1" }) });

beforeEach(() => {
  h.db = newFakeDb();
  signInAs(h.db, "sales");
  h.db.tables.tenants = [{ id: TENANT_A, state_code: "07", gstin: null }];
  h.db.tables.quotes = [{
    id: "Q-1", tenant_id: TENANT_A, status: "sent", customer_id: CUSTOMER, lead_id: null, customer_name: "Pathak Fabrication",
    prospect_state_code: null, prospect_country: null, invoice_id: null, line_items: okLines,
    approval_status: null, approval_tier: null, approval_requested_by: null, approved_by: null,
    approved_discount_bps: null, approved_margin_bps: null, approval_rejection_reason: null,
  }];
});

describe("R-2448: PDF link refused for a customer with no state", () => {
  it("no state → 409 + next step, no link", async () => {
    h.db.tables.customers = [{ id: CUSTOMER, tenant_id: TENANT_A, name: "Pathak Fabrication", state_code: null, gstin: null, country: "India" }];
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/has no state on record/);
    expect(body.nextStep).toEqual({ label: "Set the customer's state", href: `/customers/${CUSTOMER}` });
    expect(body.url).toBeUndefined();
  });

  it("with a state → the signed link", async () => {
    h.db.tables.customers = [{ id: CUSTOMER, tenant_id: TENANT_A, name: "Pathak Fabrication", state_code: "06", gstin: null, country: "India" }];
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).url).toMatch(/token=t/);
  });
});
