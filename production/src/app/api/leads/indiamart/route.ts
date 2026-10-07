/**
 * IndiaMART Lead Manager key (S34) — read status + save / clear the per-company CRM key.
 *
 *   GET    → { configured, encrypted, key_last4, last_run_at, last_ok, last_error,
 *              last_imported, total_imported }
 *   POST   → { crm_key }  (sealed before it is stored, like every integration credential)
 *   DELETE → clear the key — the pull cron then skips this company.
 *
 * Owner-only, same as /api/integrations/gemini. The raw key never goes back to the browser —
 * at most its last 4 characters (`keyLast4`, lib/leads/indiamart-key.ts). This used to send
 * `maskSecret()`, which for a key stored in the clear shows the FIRST four and last two.
 * The screen is /marketing/indiamart.
 * Key milti hai IndiaMART seller panel → Lead Manager → "CRM API / Import leads" se.
 *
 * S21: `indiamart_crm_key` / `indiamart_sync_state` ab generated types me hain — typed
 * admin client, tenant filter phir bhi har query par likha hai (admin RLS bypass karta hai).
 */
import { createAdminClientFor } from "@/lib/supabase/server";
import { trySealTenantSecrets, decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { isEncrypted } from "@/lib/crypto/vault";
import { withRoute, dbFail, RouteError } from "@/lib/api/with-route";
import { crmKeySchema, keyLast4, type IndiamartKeyStatus } from "@/lib/leads/indiamart-key";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "api/leads/indiamart";
const OWNER_ONLY = { roles: ["owner"] as const, roleHint: "Sirf workspace owner IndiaMART key save kar sakta hai — owner se kahiye." };

export const GET = withRoute({ route: ROUTE, ...OWNER_ONLY }, async ({ tenantId, user }) => {
  const db = createAdminClientFor(user.id);
  const [sec, st, imports] = await Promise.all([
    db.from("tenant_secrets").select("indiamart_crm_key").eq("tenant_id", tenantId).maybeSingle(),
    db.from("indiamart_sync_state").select("last_run_at, last_ok, last_error, last_imported").eq("tenant_id", tenantId).maybeSingle(),
    db.from("indiamart_lead_imports").select("query_id", { count: "exact", head: true }).eq("tenant_id", tenantId),
  ]);
  dbFail(sec.error, "IndiaMART setting padhi nahi gayi — page refresh karke dobara try kariye.");

  const stored = sec.data?.indiamart_crm_key ?? null;
  let last4: string | null = null;
  if (stored) {
    /* A sealed key this process cannot open (master key missing / rotated) is still "saved" —
       the cron reports that failure. Only the hint is dropped, never replaced by the raw value. */
    try {
      last4 = keyLast4(decryptTenantSecrets({ indiamart_crm_key: stored })?.indiamart_crm_key);
    } catch {
      last4 = null;
    }
  }
  const status: IndiamartKeyStatus = {
    configured: Boolean(stored),
    encrypted: stored ? isEncrypted(stored) : false,
    key_last4: last4,
    last_run_at: st.data?.last_run_at ?? null,
    last_ok: st.data?.last_ok ?? null,
    last_error: st.data?.last_error ?? null,
    last_imported: st.data?.last_imported ?? null,
    // The total is a nicety: if the count fails, show "—", do not fail the whole screen.
    total_imported: imports.error ? null : (imports.count ?? 0),
  };
  return { ...status };
});

export const POST = withRoute({ route: ROUTE, input: crmKeySchema, ...OWNER_ONLY }, async ({ input, tenantId, user }) => {
  // No master key = refuse with the next step, never store the key in the clear (R-051).
  const sealed = trySealTenantSecrets({ tenant_id: tenantId, indiamart_crm_key: input.crm_key });
  if (!sealed.ok) throw new RouteError(sealed.status, sealed.error);
  const { error } = await createAdminClientFor(user.id).from("tenant_secrets").upsert(sealed.row, { onConflict: "tenant_id" });
  dbFail(error, "IndiaMART key save nahi hui — dobara try kariye.");
  return { encrypted: true };
});

export const DELETE = withRoute({ route: ROUTE, ...OWNER_ONLY }, async ({ tenantId, user }) => {
  const { error } = await createAdminClientFor(user.id).from("tenant_secrets").update({ indiamart_crm_key: null }).eq("tenant_id", tenantId);
  dbFail(error, "IndiaMART key hati nahi — dobara try kariye.");
  return {};
});
