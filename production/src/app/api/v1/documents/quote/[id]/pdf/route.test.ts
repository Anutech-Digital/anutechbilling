/* R-1523 — public quote PDF route: ?template=proforma, bank block, pay link, and the UPI QR
   only when the tenant has a UPI ID (QR encoder mocked). */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let tenantRow: Record<string, unknown> = {};
let quoteOver: Record<string, unknown> = {};
const rendered: Array<Record<string, unknown>> = [];

const quoteRow = {
  id: "Q-DEMO-2026-27-0042", tenant_id: "t1", customer_id: null, lead_id: null,
  customer_name: "Acme Ltd", amount: 2360, subtotal: 2000, discount_pct: 0, tax_rate: 18,
  line_items: [{ id: "l1", name: "Workspace", qty: 2, rate: 1000, cost: 900, commitment: "annual_yearly" }],
  currency: "INR", payment_status: "none", status: "sent", created_date: "2026-10-17", expires_date: "2026-10-31",
  public_token: "pubtok", terms_conditions: "50% advance", is_renewal: false,
};

function builder(table: string) {
  const data = table === "quotes" ? { ...quoteRow, ...quoteOver } : table === "tenants" ? tenantRow : null;
  const b: Record<string, unknown> = {};
  for (const k of ["select", "eq"]) b[k] = () => b;
  b.maybeSingle = async () => ({ data, error: null });
  return b;
}

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({ from: builder }) }));
vi.mock("@/lib/pdf/pdf-token", () => ({ verifyPdfToken: () => true }));
vi.mock("@/lib/pdf/logo", () => ({ logoDataUri: async () => null }));
vi.mock("@/lib/compliance/udyam", () => ({ readTenantUdyam: async () => null }));
vi.mock("@/lib/pdf/upi-qr", () => ({
  buildQuoteUpiQr: async (a: { vpa?: string | null; amountDue?: number | null }) =>
    a.vpa && a.amountDue ? { dataUrl: "data:image/png;base64,QR", vpa: a.vpa } : null,
}));
vi.mock("@react-pdf/renderer", () => ({
  renderToBuffer: async (el: { props: Record<string, unknown> }) => { rendered.push(el.props); return Buffer.from("pdf"); },
}));
vi.mock("@/lib/pdf/QuotePDF", () => ({ QuotePDF: () => null }));

import { GET } from "./route";

const call = (qs: string) =>
  GET(new NextRequest(`https://app.example.in/api/v1/documents/quote/${quoteRow.id}/pdf?token=x${qs}`), {
    params: Promise.resolve({ id: quoteRow.id }),
  });

const baseTenant = {
  name: "Demo Co", gstin: null, email: null, phone: null, address: null, state: null, state_code: "07",
  upi_payee_name: null, logo_url: null,
  remit_bank_name: "HDFC Bank", remit_account_name: null, remit_account_number: "50200012345678",
  remit_ifsc: "HDFC0001234", remit_branch: null,
};

beforeEach(() => { rendered.length = 0; quoteOver = {}; });

describe("GET /api/v1/documents/quote/[id]/pdf — R-1523", () => {
  it("?template=proforma → proforma template, same quote number, bank details, pay link", async () => {
    tenantRow = { ...baseTenant, upi_vpa: "demo@okhdfcbank" };
    const res = await call("&template=proforma");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("Proforma-Q-DEMO-2026-27-0042.pdf");
    const p = rendered[0];
    expect(p.template).toBe("proforma");
    expect(p.quoteId).toBe("Q-DEMO-2026-27-0042");
    expect((p.bank as { accountNumber: string }).accountNumber).toBe("50200012345678");
    expect(p.payLinkUrl).toContain("/quote/Q-DEMO-2026-27-0042/accept");
    expect(p.termsConditions).toBe("50% advance");
  });

  it("no template → default quotation (unchanged)", async () => {
    tenantRow = { ...baseTenant, upi_vpa: "demo@okhdfcbank" };
    await call("");
    expect(rendered[0].template).toBe("quotation");
  });

  it("UPI ID set → QR on the PDF", async () => {
    tenantRow = { ...baseTenant, upi_vpa: "demo@okhdfcbank" };
    await call("&template=proforma");
    expect(rendered[0].upiQrDataUrl).toBe("data:image/png;base64,QR");
    expect(rendered[0].upiVpa).toBe("demo@okhdfcbank");
  });

  it("no UPI ID → no QR", async () => {
    tenantRow = { ...baseTenant, upi_vpa: null };
    await call("&template=proforma");
    expect(rendered[0].upiQrDataUrl).toBeNull();
  });
});

/* R-1669: the public PDF link is a customer copy — an 18%-off draft waiting for approval
   must not render, whoever holds the link. */
describe("GET /api/v1/documents/quote/[id]/pdf — R-1669 approval gate", () => {
  const discounted = [{ id: "l1", name: "GW Standard", qty: 10, rate: 10627, list_rate: 12960, cost: 8640, commitment: "annual_yearly" }];

  it("approval pending → 409 with the reason, nothing rendered", async () => {
    tenantRow = { ...baseTenant, upi_vpa: null };
    quoteOver = { status: "draft", line_items: discounted, approval_status: "pending", approval_tier: "manager", approval_requested_by: "u1" };
    const res = await call("");
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/approv/i);
    expect(rendered).toHaveLength(0);
  });

  it("approval rejected → 409", async () => {
    tenantRow = { ...baseTenant, upi_vpa: null };
    quoteOver = { status: "draft", line_items: discounted, approval_status: "rejected", approval_tier: "manager" };
    expect((await call("&template=proforma")).status).toBe(409);
  });

  it("approved → renders", async () => {
    tenantRow = { ...baseTenant, upi_vpa: null };
    quoteOver = { status: "draft", line_items: discounted, approval_status: "approved", approval_tier: "manager", approved_by: "u2", approved_discount_bps: 1800 };
    expect((await call("")).status).toBe(200);
    expect(rendered).toHaveLength(1);
  });
});
