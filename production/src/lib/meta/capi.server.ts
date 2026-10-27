/**
 * R-1979 (26 Oct 2026, G-ADS): Meta Conversions API — the server Purchase event.
 *
 * Sent after a buy-page order is PAID (simulated checkout, or the Razorpay webhook), with the
 * same event_id as the browser pixel's Purchase ("purchase-<quote id>"), so Meta counts it once.
 *
 * NEVER lets an order fail: every path returns a result and logs; nothing throws; the request
 * has a 4 s timeout. Sent only when:
 *   - the tenant has a pixel id AND a CAPI token (Settings → Integrations → Meta), and
 *   - the buyer accepted analytics cookies on the site (consent travels with the order).
 * user_data is hashed (pixel.ts); value is the order's pre-GST subtotal in INR.
 */
import { openSecret } from "./capi-secret";
import { buildCapiBody, contentIdForPlan, fbcFromFbclid, purchaseEventId, cleanPixelId, type CapiEventInput } from "./pixel";

/** Graph API version for the Conversions API endpoint. */
export const META_GRAPH_VERSION = "v21.0";

type AnyClient = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- columns newer than the generated types

export interface MetaSettings { pixelId: string; token: string; testCode: string | null }

/** The tenant's Meta settings, or null when the pixel or the token is missing (then nothing is sent). */
export async function loadMetaSettings(admin: AnyClient, tenantId: string): Promise<MetaSettings | null> {
  try {
    const { data } = await admin
      .from("tenant_secrets")
      .select("meta_pixel_id, meta_capi_token, meta_test_event_code")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const row = (data ?? null) as { meta_pixel_id?: string | null; meta_capi_token?: string | null; meta_test_event_code?: string | null } | null;
    const pixelId = cleanPixelId(row?.meta_pixel_id);
    const token = openSecret(row?.meta_capi_token);
    if (!pixelId || !token) return null;
    return { pixelId, token, testCode: (row?.meta_test_event_code ?? "").trim() || null };
  } catch (e) {
    console.error("[meta/capi] settings unreadable:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** POST one event. Returns what happened; never throws. */
export async function sendMetaEvent(
  settings: MetaSettings,
  event: CapiEventInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${settings.pixelId}/events?access_token=${encodeURIComponent(settings.token)}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildCapiBody(event, settings.testCode)),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      console.error(`[meta/capi] ${event.eventName} ${event.eventId} refused: HTTP ${res.status} ${text}`);
      return { sent: false, reason: `http_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error(`[meta/capi] ${event.eventName} ${event.eventId} not sent:`, e instanceof Error ? e.message : e);
    return { sent: false, reason: "network" };
  }
}

/**
 * The server Purchase for a paid buy-page order. Reads the quote (pre-GST subtotal, plan, the
 * click id saved by R-1978) and its lead (email, phone — hashed). Best-effort: logs, never throws.
 */
export async function reportPurchaseToMeta(
  admin: AnyClient,
  input: { quoteId: string; tenantId: string; consent: boolean; fbp?: string | null; sourceUrl?: string | null; clientIp?: string | null; userAgent?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    if (!input.consent) return { sent: false, reason: "no_consent" };
    const settings = await loadMetaSettings(admin, input.tenantId);
    if (!settings) return { sent: false, reason: "not_configured" };
    const { data: q } = await admin
      .from("quotes")
      .select("id, plan, subtotal, lead_id, fbclid, created_at")
      .eq("id", input.quoteId)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    if (!q) return { sent: false, reason: "no_quote" };
    const quote = q as { id: string; plan: string | null; subtotal: number | null; lead_id: string | null; fbclid?: string | null; created_at?: string | null };
    let email: string | null = null, phone: string | null = null;
    if (quote.lead_id) {
      const { data: lead } = await admin
        .from("leads").select("contact_email, contact_phone").eq("id", quote.lead_id).eq("tenant_id", input.tenantId).maybeSingle();
      email = (lead as { contact_email?: string | null } | null)?.contact_email ?? null;
      phone = (lead as { contact_phone?: string | null } | null)?.contact_phone ?? null;
    }
    const clickTime = quote.created_at ? Date.parse(quote.created_at) : Date.now();
    return await sendMetaEvent(settings, {
      eventName: "Purchase",
      eventId: purchaseEventId(quote.id),
      eventTimeMs: Date.now(),
      sourceUrl: input.sourceUrl ?? null,
      value: Number(quote.subtotal ?? 0),
      contentIds: contentIdForPlan(quote.plan),
      email, phone,
      fbp: input.fbp ?? null,
      fbc: fbcFromFbclid(quote.fbclid ?? null, Number.isFinite(clickTime) ? clickTime : Date.now()),
      clientIp: input.clientIp ?? null,
      userAgent: input.userAgent ?? null,
    }, fetchImpl);
  } catch (e) {
    console.error(`[meta/capi] Purchase for ${input.quoteId} not sent:`, e instanceof Error ? e.message : e);
    return { sent: false, reason: "error" };
  }
}
