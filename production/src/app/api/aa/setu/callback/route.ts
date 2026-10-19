/**
 * GET /api/aa/setu/callback?handle=<consent_handle_id>&approved=<bool>&state=<signed state>
 *
 * Setu redirects the user here after they approve/reject consent on their
 * phone. (In mock mode, the local /aa/simulate-approval page calls this.)
 * We update the connection row and redirect back to the bank account page.
 *
 * R-879 (fail closed, in this order):
 *   1. Signed in, money role (MONEY_RECORD_ROLES, the shared withRoute guard), aal2 session.
 *   2. `state` was signed by consent/init for THIS tenant + THIS connection, and has not expired
 *      (lib/aa/consent-state.ts). Before this, knowing a handle was enough to flip a connection.
 *   3. The handle in the URL is the one stored on that connection, and the connection is still
 *      waiting for approval — a used state cannot flip it again.
 * Any refusal changes nothing.
 */
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/with-route";
import { MONEY_RECORD_ROLES } from "@/lib/auth/roles";
import { getConsentStatus } from "@/lib/aa/setu";
import { consentStateConnectionId, verifyConsentState } from "@/lib/aa/consent-state";
import { refuseWithoutMfa } from "@/lib/aa/require-mfa";

export const runtime = "nodejs";

/** §24: what happened + what to do. */
const AA_STATE_REFUSAL =
  "Ye bank-approval link sahi nahi hai ya purana ho gaya — connection nahi badla. Banking page par jaakar 'Connect bank' dobara dabaiye aur naya link kholiye.";

const refuse = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

export const GET = withRoute({
  route: "api/aa/setu/callback",
  roles: MONEY_RECORD_ROLES,
  roleHint: "Bank connect sirf owner / manager / accountant / billing kar sakte hain — unse approve karwaiye.",
}, async ({ req, supabase, tenantId }) => {
  const mfa = await refuseWithoutMfa(supabase);
  if (mfa) return mfa;

  const url      = new URL(req.url);
  const handle   = url.searchParams.get("handle");
  const state    = url.searchParams.get("state");
  const approved = url.searchParams.get("approved") !== "false";

  const connectionId = consentStateConnectionId(state);
  if (!handle || !connectionId) return refuse(403, AA_STATE_REFUSAL);

  const { data: conn, error: connErr } = await supabase
    .from("bank_aa_connections")
    .select("id, bank_account_id, tenant_id, consent_handle_id, status")
    .eq("id", connectionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (connErr || !conn) return refuse(403, AA_STATE_REFUSAL);

  const verdict = verifyConsentState(state, conn.tenant_id, conn.id);
  if (!verdict.ok) {
    console.warn(`[api/aa/setu/callback] refused for connection ${conn.id}: state ${verdict.reason}`);
    return refuse(403, AA_STATE_REFUSAL);
  }
  if (conn.consent_handle_id !== handle) return refuse(403, AA_STATE_REFUSAL);
  if (conn.status !== "pending_approval") {
    return refuse(
      409,
      `Ye bank connection pehle hi '${conn.status}' hai — dobara approve karne ki zaroorat nahi. Banking page kholiye.`,
    );
  }

  if (!approved) {
    const { error } = await supabase
      .from("bank_aa_connections")
      .update({ status: "rejected", status_reason: "User declined consent" })
      .eq("id", conn.id)
      .eq("tenant_id", tenantId);
    if (error) return refuse(500, "Connection update nahi hua — kuch nahi badla. Banking page se dobara try kariye.");
    return NextResponse.redirect(new URL(`/accounting/banking/${conn.bank_account_id}?aa=rejected`, req.url));
  }

  // Pull final status from provider (returns mock-active in mock mode)
  const status = await getConsentStatus(handle);
  const linked = status.linked_accounts?.[0];
  /* The URL's approved=true is not the provider's word — only Setu's own ACTIVE is. */
  if (status.status !== "ACTIVE") {
    return refuse(
      409,
      `Bank ne abhi consent '${status.status}' bataya hai — connection nahi badla. Phone par approval poora kariye, phir Banking page se 'Connect bank' dobara dabaiye.`,
    );
  }

  const { error: updErr } = await supabase
    .from("bank_aa_connections")
    .update({
      status:             "active",
      consent_id:         status.consent_id ?? null,
      linked_account_ref: linked?.accountRef ?? null,
      status_reason:      null,
    })
    .eq("id", conn.id)
    .eq("tenant_id", tenantId);
  if (updErr) return refuse(500, "Connection update nahi hua — kuch nahi badla. Banking page se dobara try kariye.");

  return NextResponse.redirect(new URL(`/accounting/banking/${conn.bank_account_id}?aa=connected`, req.url));
});
