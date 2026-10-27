/**
 * R-1979: the server Purchase event — sent only with a pixel + token + the buyer's consent,
 * deduped with the browser by event_id, hashed user data, and an order NEVER fails because Meta did.
 */
import { describe, it, expect, vi } from "vitest";
import { reportPurchaseToMeta, META_GRAPH_VERSION } from "./capi.server";
import { sha256 } from "./pixel";

function admin(rows: { secrets?: Record<string, unknown> | null; quote?: Record<string, unknown> | null; lead?: Record<string, unknown> | null }) {
  return {
    from(table: string) {
      const data = table === "tenant_secrets" ? rows.secrets ?? null : table === "quotes" ? rows.quote ?? null : table === "leads" ? rows.lead ?? null : null;
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data, error: null });
      return c;
    },
  };
}
const SECRETS = { meta_pixel_id: "1234567890123456", meta_capi_token: "EAAtoken", meta_test_event_code: "TEST42" };
const QUOTE = { id: "Q-T-27-0001", plan: "google-workspace-starter", subtotal: 3240, lead_id: "L-1", fbclid: "FB.123", created_at: "2026-10-26T10:00:00Z" };
const LEAD = { contact_email: "Ravi@Example.in", contact_phone: "98111 22233" };

describe("R-1979 reportPurchaseToMeta", () => {
  it("sends Purchase once: event_id purchase-<quote>, value pre-GST INR, hashed email/phone, fbc from the saved click id", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await reportPurchaseToMeta(admin({ secrets: SECRETS, quote: QUOTE, lead: LEAD }), { quoteId: QUOTE.id, tenantId: "t", consent: true, fbp: "fb.1.1.2" }, f as unknown as typeof fetch);
    expect(r).toEqual({ sent: true });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}/1234567890123456/events?access_token=EAAtoken`);
    const body = JSON.parse(String(init.body));
    expect(body.test_event_code).toBe("TEST42");
    const e = body.data[0];
    expect(e).toMatchObject({ event_name: "Purchase", event_id: "purchase-Q-T-27-0001", action_source: "website", custom_data: { value: 3240, currency: "INR", content_ids: ["google-workspace-starter"] } });
    expect(e.user_data.em).toEqual([sha256("ravi@example.in")]);
    expect(e.user_data.ph).toEqual([sha256("919811122233")]);
    expect(e.user_data.fbp).toBe("fb.1.1.2");
    expect(e.user_data.fbc).toBe(`fb.1.${Date.parse(QUOTE.created_at)}.FB.123`);
    expect(String(init.body)).not.toMatch(/ravi|98111/i);
  });

  it("no consent → nothing sent", async () => {
    const f = vi.fn();
    expect(await reportPurchaseToMeta(admin({ secrets: SECRETS, quote: QUOTE }), { quoteId: QUOTE.id, tenantId: "t", consent: false }, f as unknown as typeof fetch)).toEqual({ sent: false, reason: "no_consent" });
    expect(f).not.toHaveBeenCalled();
  });

  it("no pixel id or no token → nothing sent", async () => {
    const f = vi.fn();
    for (const s of [null, { ...SECRETS, meta_pixel_id: null }, { ...SECRETS, meta_capi_token: null }]) {
      expect((await reportPurchaseToMeta(admin({ secrets: s, quote: QUOTE }), { quoteId: QUOTE.id, tenantId: "t", consent: true }, f as unknown as typeof fetch)).reason).toBe("not_configured");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("Meta down or refusing → returns, never throws (the order is not affected)", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNRESET"); });
    await expect(reportPurchaseToMeta(admin({ secrets: SECRETS, quote: QUOTE, lead: LEAD }), { quoteId: QUOTE.id, tenantId: "t", consent: true }, down as unknown as typeof fetch)).resolves.toEqual({ sent: false, reason: "network" });
    const refused = vi.fn(async () => new Response("bad token", { status: 400 }));
    await expect(reportPurchaseToMeta(admin({ secrets: SECRETS, quote: QUOTE, lead: LEAD }), { quoteId: QUOTE.id, tenantId: "t", consent: true }, refused as unknown as typeof fetch)).resolves.toEqual({ sent: false, reason: "http_400" });
    const broken = { from() { throw new Error("db down"); } };
    await expect(reportPurchaseToMeta(broken, { quoteId: QUOTE.id, tenantId: "t", consent: true }, refused as unknown as typeof fetch)).resolves.toMatchObject({ sent: false });
  });
});
