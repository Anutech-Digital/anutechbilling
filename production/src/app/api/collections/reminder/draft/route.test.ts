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

const call = (body: unknown) =>
  POST(new NextRequest("https://example.invalid/api/collections/reminder/draft", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

beforeEach(() => {
  st.role = "sales"; st.phone = null; st.email = "accounts@sharma.in"; st.apiKey = null; st.found = true; st.twoBills = false; st.upi = null; st.ai.mockReset();
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

  /* R-2412 — Send reminder → This invoice: ONE bill, its amount, its pay link. */
  it("no line → the most overdue bill only; the picker lists every open bill", async () => {
    st.twoBills = true; st.upi = "anutech@hdfcbank";
    const j = await (await call({ customerId: CUST })).json();
    expect(j.line).toEqual({ kind: "invoice", id: "INV-101" });
    expect(j.amountDue).toBe(68000);
    expect(j.payLink).toContain("am=68000");
    expect(j.payLinkNotice).toBeNull();
    expect(j.message).toContain(j.payLink);
    expect(j.message).not.toContain("₹5,900");
    expect(j.lines.map((l: { id: string }) => l.id)).toEqual(["INV-101", "INV-105"]);
  });

  it("line picked → that bill's amount and pay link; the follow-up is about it", async () => {
    st.twoBills = true; st.upi = "anutech@hdfcbank";
    const j = await (await call({ customerId: CUST, line: { kind: "invoice", id: "INV-105" } })).json();
    expect(j.amountDue).toBe(5900);
    expect(j.payLink).toContain("am=5900");
    expect(j.about.invoiceId).toBe("INV-105");
    expect(j.message.split("\n")[0]).toContain("₹5,900");
  });

  it("a bill that is no longer open → 409 with the next step, nothing drafted", async () => {
    const res = await call({ customerId: CUST, line: { kind: "invoice", id: "INV-999" } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/pick another bill/);
  });

  it("no UPI ID → no pay link, and the notice says what to do (§24)", async () => {
    const j = await (await call({ customerId: CUST })).json();
    expect(j.payLink).toBeNull();
    expect(j.payLinkNotice.text).toMatch(/UPI ID in Settings/);
  });
});
