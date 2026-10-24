/**
 * R-879: bank-statement actions (connect, callback, fetch) need the second sign-in step.
 *
 * R-731 already empties the workspace for an MFA-ENROLLED user whose session is aal1, and
 * middleware answers such API calls with 401. This goes one step further for bank data only:
 * the session must BE aal2 — a password alone (no authenticator set up) is not enough to pull
 * a company's bank statements. It never weakens R-731; it only adds a refusal.
 *
 * Fail closed: an auth error or an unknown level counts as "not aal2".
 */
import { NextResponse } from "next/server";

/** §24: what happened + what to do. */
export const AA_MFA_REFUSAL =
  "Two-step sign-in is required for bank data. Add an authenticator app in Settings → Security (/settings?tab=security), then sign out, sign in again, enter the code and repeat this action.";

type MfaAuth = {
  auth: {
    mfa: {
      getAuthenticatorAssuranceLevel(): Promise<{ data: { currentLevel: string | null } | null; error: unknown }>;
    };
  };
};

/** null when the session is aal2; otherwise the 403 to return. */
export async function refuseWithoutMfa(supabase: MfaAuth): Promise<Response | null> {
  let level: string | null = null;
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    level = error ? null : (data?.currentLevel ?? null);
  } catch {
    level = null;
  }
  if (level === "aal2") return null;
  return NextResponse.json({ ok: false, error: AA_MFA_REFUSAL, mfaRequired: true }, { status: 403 });
}
