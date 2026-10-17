/**
 * R-1518 — POST /api/collections/reminder/draft returns text and where it can go; it sends
 * nothing. With no Gemini key it is the plain template; with no phone WhatsApp is off, with why.
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
  const raw: ReminderRaw = {
    customerName: "Sharma Traders", contactName: "Rahul", sellerName: "Anutech",
    invoices: [{ id: "INV-101", amount: 68000, net_payable: 68000, paid_amount: 0, status: "overdue", invoice_date: "2026-09-20", due_date: "2026-10-05", quote_id: "Q-1" }],
    subscriptions: [], invoicedQuoteIds: new Set(), quoteTokens: new Map(), lastPromise: null,
    upiVpa: null, upiPayeeName: null, origin: null,
  };
  return {
    ...real,
    loadReminderRaw: async () => (st.found ? { raw, customer: { customerName: "Sharma Traders", phone: st.phone, email: st.email } } : null),
  };
});
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { POST } from "./route";
import { NO_PHONE } from "@/lib/collections/reminder-draft";
import { NOTE_NO_KEY } from "@/lib/collections/reminder-draft.server";

const call = (body: unknown) =>
  POST(new NextRequest("https://example.invalid/api/collections/reminder/draft", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

beforeEach(() => {
  st.role = "sales"; st.phone = null; st.email = "accounts@sharma.in"; st.apiKey = null; st.found = true; st.ai.mockReset();
});

describe("reminder draft route", () => {
  it("no key → the template, WhatsApp off with the reason, email on", async () => {
    const res = await call({ customerId: CUST });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.mode).toBe("template");
    expect(j.note).toBe(NOTE_NO_KEY);
    expect(j.message.split("\n")[0]).toMatch(/^Hi Rahul, .*₹68,000 is pending/);
    expect(j.whatsapp).toBeNull();
    expect(j.whatsappBlocked).toBe(NO_PHONE);
    expect(j.email).toBe("accounts@sharma.in");
    expect(j.about).toEqual({ invoiceId: "INV-101", subscriptionId: null, quoteId: "Q-1" });
    expect(st.ai).not.toHaveBeenCalled();
  });

  it("with a phone → the wa.me number", async () => {
    st.phone = "98765 43210";
    const j = await (await call({ customerId: CUST })).json();
    expect(j.whatsapp).toBe("919876543210");
    expect(j.whatsappBlocked).toBeNull();
  });

  it("with a key → the AI draft (money-checked)", async () => {
    st.apiKey = "k";
    st.ai.mockResolvedValue({ subject: "Due", message: "Hi Rahul, ₹68,000 pending." });
    const j = await (await call({ customerId: CUST })).json();
    expect(j.mode).toBe("gemini");
    expect(j.message).toBe("Hi Rahul, ₹68,000 pending.");
  });

  it("customer not visible → 404 with what to do", async () => {
    st.found = false;
    const res = await call({ customerId: CUST });
    expect(res.status).toBe(404);
  });

  it("roles that cannot open Payment Follow-up → 403", async () => {
    st.role = "support";
    expect((await call({ customerId: CUST })).status).toBe(403);
  });

  // R-1528: a senior seller opens Payment Follow-up like a seller, so it can draft a reminder too.
  it("sales_senior can draft a reminder (200)", async () => {
    st.role = "sales_senior";
    expect((await call({ customerId: CUST })).status).toBe(200);
  });
});
