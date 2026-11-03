/**
 * R-2415 — the reminder draft carries the bill's ONE Razorpay link (made / reused by
 * lib/payments/payment-link.server, mocked here) next to the UPI link.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ReminderRaw } from "@/lib/collections/reminder-draft";

const CUST = "33333333-3333-4333-8333-333333333333";

const st = vi.hoisted(() => ({
  role: "sales" as string,
  phone: null as string | null,
  email: "accounts@sharma.in" as string | null,
  apiKey: null as string | null,
  found: true,
  twoBills: false,
  upi: null as string | null,
  ai: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: null } } }) },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: { tenant_id: "T1", role: st.role }, error: null });
      return q;
    },
  }),
}));
vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: st.apiKey, model: "m" }),
  geminiJson: (...a: unknown[]) => st.ai(...a),
}));
vi.mock("@/lib/collections/reminder-draft.server", async (orig) => {
  const real = await orig<typeof import("@/lib/collections/reminder-draft.server")>();
  const raw = (): ReminderRaw => ({
    customerName: "Sharma Traders", contactName: "Rahul", sellerName: "Anutech",
    invoices: [
      { id: "INV-101", amount: 68000, net_payable: 68000, paid_amount: 0, status: "overdue", invoice_date: "2026-09-20", due_date: "2026-10-05", quote_id: "Q-1" },
      ...(st.twoBills ? [{ id: "INV-105", amount: 5900, net_payable: 5900, paid_amount: 0, status: "pending", invoice_date: "2026-10-10", due_date: "2026-10-25", quote_id: null }] : []),
    ],
    subscriptions: [], invoicedQuoteIds: new Set(), quoteTokens: new Map(), lastPromise: null,
    upiVpa: st.upi, upiPayeeName: null, origin: null,
  });
  return {
    ...real,
    loadReminderRaw: async () => (st.found ? { raw: raw(), customer: { customerName: "Sharma Traders", phone: st.phone, email: st.email } } : null),
  };
});
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { POST } from "./route";
import { NO_PHONE } from "@/lib/collections/reminder-draft";
import { NOTE_NO_KEY } from "@/lib/collections/reminder-draft.server";

const card = vi.hoisted(() => ({
  fn: vi.fn(),
}));
vi.mock("@/lib/payments/payment-link.server", () => ({ getOrCreateInvoicePayLink: (...a: unknown[]) => card.fn(...a) }));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new NextRequest("https://example.invalid/api/collections/reminder/draft", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

beforeEach(() => {
  st.role = "sales"; st.phone = null; st.email = "accounts@sharma.in"; st.apiKey = null; st.found = true; st.twoBills = false;
  st.upi = "anutech@icici"; st.ai.mockReset(); card.fn.mockReset();
});

describe("R-2415 — Send reminder carries the bill's Razorpay link next to the UPI link", () => {
  it("asks for the link of exactly the bill the reminder is about, and puts it after the UPI line", async () => {
    card.fn.mockResolvedValue({ link: { url: "https://rzp.io/i/abc123", amount: 68_000, billAmount: 68_000, mode: "test" }, notice: null });
    const j = await (await call({ customerId: CUST })).json();
    expect(card.fn).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "T1", customerId: CUST, scope: "invoice",
      lines: [{ kind: "invoice", id: "INV-101", amountDue: 68_000 }],
      customerName: "Sharma Traders", customerEmail: "accounts@sharma.in",
    }));
    const lines = (j.message as string).split("\n");
    const upi = lines.findIndex((l) => l.includes("upi://"));
    expect(upi).toBeGreaterThan(0);
    expect(lines[upi + 1]).toBe("Pay by card / UPI / net banking: https://rzp.io/i/abc123");
    expect(j.cardLink).toEqual({ url: "https://rzp.io/i/abc123", amount: 68_000, billAmount: 68_000, mode: "test" });
    expect(j.cardLinkNotice).toBeNull();
  });

  it("no Razorpay link → the message is unchanged and the notice says why", async () => {
    card.fn.mockResolvedValue({ link: null, notice: { reason: "not_configured", text: "No card / net-banking link — Razorpay is not connected." } });
    const j = await (await call({ customerId: CUST })).json();
    expect(j.message).not.toContain("card / UPI / net banking");
    expect(j.cardLink).toBeNull();
    expect(j.cardLinkNotice.reason).toBe("not_configured");
  });

  it("the picked bill gets its own link", async () => {
    st.twoBills = true;
    card.fn.mockResolvedValue({ link: null, notice: null });
    await call({ customerId: CUST, line: { kind: "invoice", id: "INV-105" } });
    expect(card.fn.mock.calls[0][0].lines).toEqual([{ kind: "invoice", id: "INV-105", amountDue: 5_900 }]);
  });
});
