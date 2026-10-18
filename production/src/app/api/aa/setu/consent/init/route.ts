/**
 * POST /api/aa/setu/consent/init
 *
 * Kicks off the Account Aggregator consent flow. Inserts a
 * bank_aa_connections row with status='pending_approval' and returns the
 * redirect URL the operator should open (Setu's consent page in production,
 * a local simulate-approval page in mock mode).
 *
 * Body: { bank_account_id, vua, fetch_window_days }
 * Returns: { redirectUrl, connectionId }
 */
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/with-route";
import { MONEY_RECORD_ROLES } from "@/lib/auth/roles";
import { randomUUID } from "crypto";
import { createConsent, isSetuConfigured } from "@/lib/aa/setu";
import { signConsentState } from "@/lib/aa/consent-state";
import { refuseWithoutMfa } from "@/lib/aa/require-mfa";

export const runtime = "nodejs";

interface ReqBody {
  bank_account_id:   string;
  vua:               string;
  fetch_window_days: number;
}

/* R-732: a bank-statement pull is a money action — the roles that may record money
   (owner, manager, accountant, billing; R-718), not every signed-in member. */
export const POST = withRoute({
  route: "api/aa/setu/consent/init",
  roles: MONEY_RECORD_ROLES,
  roleHint: "Bank connect sirf owner / manager / accountant / billing kar sakte hain.",
}, async ({ req, supabase, tenantId }) => {
  /* R-879: connecting a bank needs the second sign-in step too (lib/aa/require-mfa.ts). */
  const mfa = await refuseWithoutMfa(supabase);
  if (mfa) return mfa;

  const body = (await req.json().catch(() => ({}))) as Partial<ReqBody>;
  if (!body.bank_account_id || !body.vua || !body.fetch_window_days) {
    return NextResponse.json({ error: "Missing bank_account_id / vua / fetch_window_days" }, { status: 400 });
  }

  // Fetch the bank account (RLS confines to caller's tenant)
  const { data: account, error: accErr } = await supabase
    .from("bank_accounts")
    .select("id, tenant_id, ifsc, bank_name")
    .eq("id", body.bank_account_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (accErr || !account) {
    return NextResponse.json({ error: "Bank account not found" }, { status: 404 });
  }

  // Compute fetch window
  const today    = new Date();
  const fromDate = new Date(today.getTime() - body.fetch_window_days * 24 * 60 * 60 * 1000);
  const fromIso  = fromDate.toISOString().slice(0, 10);
  const toIso    = today.toISOString().slice(0, 10);

  /* R-879: the row id is chosen BEFORE the provider call so the redirect URL can carry a
     state signed for exactly this tenant + connection (lib/aa/consent-state.ts). */
  const connectionId = randomUUID();
  const state = signConsentState(account.tenant_id, connectionId);

  // Provider call (mock when env keys missing)
  const consent = await createConsent({
    state,
    vua:               body.vua,
    bank_ifsc:         account.ifsc ?? "",   // real bank accounts always have IFSC; cash accounts don't use AA
    fetch_window_from: fromIso,
    fetch_window_to:   toIso,
    purpose:           "Reseller bookkeeping — auto-reconcile bank statements",
  });

  // Persist the connection row
  const { data: conn, error: connErr } = await supabase
    .from("bank_aa_connections")
    .insert({
      id:                 connectionId,
      tenant_id:          account.tenant_id,
      bank_account_id:    account.id,
      provider:           "setu",
      vua:                body.vua,
      consent_handle_id:  consent.id,
      status:             "pending_approval",
      consent_expires_at: consent.consent_expires_at ?? null,
      fetch_window_from:  fromIso,
      fetch_window_to:    toIso,
      consent_payload:    consent as unknown as object,
    })
    .select("id")
    .single();
  if (connErr || !conn) {
    console.error("[api/aa/setu/consent/init] connection insert failed:", connErr?.message);
    return NextResponse.json(
      { ok: false, error: "Bank connection save nahi hua — kuch nahi bana. Thodi der baad 'Connect' dobara dabaiye." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    redirectUrl:  consent.url,
    connectionId: conn.id,
    mode:         isSetuConfigured() ? "live" : "mock",
  });
});
