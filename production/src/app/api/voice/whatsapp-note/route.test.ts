/**
 * R-1452 — POST /api/voice/whatsapp-note for a customer with no phone answers with a clear
 * §24 message (422 + code "no_phone" + where to add it), never a bare 400, and never reaches
 * TTS or WhatsApp. A customer with a phone still goes through to the send.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  customer: null as null | Record<string, unknown>,
}));
const tts = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => {
          if (table === "subscriptions") {
            return Promise.resolve({
              data: [{ plan: "google-workspace-business", status: "active", outstanding_amount: 0, renewal_date: "2026-11-01" }],
            });
          }
          return q;
        },
        maybeSingle: () => Promise.resolve({
          data: table === "users" ? { tenant_id: "t1", role: "billing" } : table === "tenants" ? { name: "Acme" } : db.customer,
        }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/voice/tts", () => ({ synthesizeSpeech: tts }));
vi.mock("@/lib/messaging", () => ({ sendCustomerWhatsApp: send }));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("https://example.invalid/api/voice/whatsapp-note", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest);

beforeEach(() => {
  tts.mockReset();
  send.mockReset();
  tts.mockResolvedValue({ base64: "AAAA", mime: "audio/wav" });
  send.mockResolvedValue({ status: "sent" });
});

describe("POST /api/voice/whatsapp-note — R-1452 no phone", () => {
  it.each([null, "", "   "])("customer phone %j → 422 no_phone with a next step, nothing sent", async (phone) => {
    db.customer = { id: "c1", name: "Ravi Traders", contact_name: "Ravi", contact_phone: phone };
    const res = await call({ customerId: "c1", purpose: "renewal" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("no_phone");
    expect(body.error).toBe("No phone number for this customer — add one");
    expect(body.description).toMatch(/Nothing was sent/);
    expect(body.href).toBe("/customers/c1");
    expect(tts).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("customer with a phone goes through to the send as before", async () => {
    db.customer = { id: "c1", name: "Ravi Traders", contact_name: "Ravi", contact_phone: "+91 98765 43210" };
    const res = await call({ customerId: "c1", purpose: "renewal" });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("+91 98765 43210");
  });
});
